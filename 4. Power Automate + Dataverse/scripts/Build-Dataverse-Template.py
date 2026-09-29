"""Build the Dataverse template from the Fabric one by rewriting its source.

`docs/BUILD.md` is blunt about the constraint: Power BI Desktop has no
command-line template export, and a .pbit signs its report layer, so a
hand-edited report cannot be shipped. This script stays on the right side of
that line. It is a model-layer repair in the same family as
`docs/scripts/fix_pbit_defaults.py` - it touches DataModelSchema and
UnappliedChanges and nothing else. Every byte of the Report folder, and the
SecurityBindings part that signs it, is copied through untouched.

That is possible because of how the Fabric template is put together. Every
table it loads goes through one shared expression:

    FabricSource = Sql.Database(FabricSQLEndpoint, LakehouseName)
    GetTable = (name) => ... pick [Item] = name from FabricSource ...

Nothing else in the model names a data source, and the report layer never
references either one. So the whole path swings on two expressions and two
parameters. Dataverse's TDS endpoint speaks the SQL Server protocol, so
`Sql.Database` reaches it unchanged; the only real difference is that Dataverse
puts a publisher prefix on table and column names. The rewritten `GetTable`
strips that prefix, which puts the column names back to what the template's
`Normalize` function already expects.

Usage:
    python Build-Dataverse-Template.py            # report what would change
    python Build-Dataverse-Template.py --write    # write the template
"""

from __future__ import annotations

import argparse
import io
import json
import shutil
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve()
PATH4 = HERE.parents[1]
ROOT = HERE.parents[2]

SOURCE = ROOT / "2. Fabric" / "Consumption Central - Fabric.pbit"
TARGET = PATH4 / "Consumption Central - Power Automate + Dataverse.pbit"
SCHEMA_FILE = PATH4 / "dataverse-schema.json"

MODEL_PARTS = ("DataModelSchema", "UnappliedChanges")

# Old identifier -> new one. Applied to every string in the model parts, which
# is what keeps the cached copies of the query text that Desktop keeps in
# `lastLoadedAsTableFormulaText` in step with the expressions themselves.
RENAMES = {
    "FabricSQLEndpoint": "DataverseServer",
    "LakehouseName": "DataverseDatabase",
    "FabricSource": "DataverseSource",
}

DEFAULTS = {
    "DataverseServer": '"your-org.crm.dynamics.com,5558"',
    "DataverseDatabase": '"your-org"',
    "DataversePrefix": '"cc_"',
}

PARAMETER_META = 'meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]'

NEW_SOURCE = ["Sql.Database(DataverseServer, DataverseDatabase)"]

NEW_GET_TABLE = [
    "(name as text) as nullable table =>",
    "\tlet",
    "\t\t// Dataverse stores these tables under the publisher prefix, with the",
    "\t\t// prefix on the column names too. Strip it on the way in and the",
    "\t\t// canonical names bind exactly as they do on the Fabric path, so no",
    "\t\t// query downstream of here needs to change.",
    "\t\tClean = (s as text) as text => Text.Lower(Text.Select(s, {\"a\"..\"z\", \"A\"..\"Z\", \"0\"..\"9\"})),",
    "\t\tLogical = DataversePrefix & Clean(name),",
    "\t\tMatch = Table.SelectRows(DataverseSource,",
    "\t\t\teach [Schema] = \"dbo\" and [Item] = Logical and [Kind] = \"Table\"),",
    "\t\t// Keep only the table's own prefixed columns. Dataverse adds system",
    "\t\t// columns (createdon, statecode, ...) and every table carries a row id,",
    "\t\t// a primary name and the flow's bookkeeping. None of that is source",
    "\t\t// data, and a query that reads whatever columns arrive - the Cowork",
    "\t\t// org attributes do - would surface it as slicers. Dropping the",
    "\t\t// payload column also keeps a large memo field off every refresh.",
    "\t\tBookkeeping = List.Transform({\"name\", \"rowkey\", \"loadedon\", \"payloadjson\"},",
    "\t\t\teach DataversePrefix & _) & {Logical & \"id\"},",
    "\t\tResult =",
    "\t\t\tif Table.IsEmpty(Match) then null",
    "\t\t\telse",
    "\t\t\t\tlet",
    "\t\t\t\t\tData = Match{0}[Data],",
    "\t\t\t\t\tKept = List.Select(Table.ColumnNames(Data), each",
    "\t\t\t\t\t\tText.StartsWith(_, DataversePrefix)",
    "\t\t\t\t\t\tand Text.Length(_) > Text.Length(DataversePrefix)",
    "\t\t\t\t\t\tand not List.Contains(Bookkeeping, _)),",
    "\t\t\t\t\tPairs = List.Transform(Kept, (c) =>",
    "\t\t\t\t\t\t{c, Text.Range(c, Text.Length(DataversePrefix))})",
    "\t\t\t\tin",
    "\t\t\t\t\tTable.RenameColumns(Table.SelectColumns(Data, Kept), Pairs)",
    "\tin",
    "\t\tResult",
]

LAYOUTS = (
    {"indent": 2, "newline": "\r\n"},
    {"indent": 2, "newline": "\n"},
    {"separators": (",", ":"), "newline": ""},
)


def fail(message: str) -> None:
    sys.exit(f"error: {message}")


def serialise(value, layout) -> str:
    options = {k: v for k, v in layout.items() if k != "newline"}
    text = json.dumps(value, ensure_ascii=False, allow_nan=False, **options)
    if layout["newline"] == "\r\n":
        text = text.replace("\n", "\r\n")
    return text


def decode(raw: bytes, label: str):
    bom = raw[:2] == b"\xff\xfe"
    body = raw[2:] if bom else raw
    if not (len(body) > 1 and body[1] == 0):
        fail(f"{label}: expected UTF-16LE")
    return body.decode("utf-16-le"), bom


def open_part(raw: bytes, label: str):
    """Decode a part and return an encoder that reproduces its exact layout."""
    text, bom = decode(raw, label)
    value = json.loads(text)
    matches = [l for l in LAYOUTS if serialise(value, l) == text]
    if len(matches) != 1:
        fail(f"{label}: cannot reproduce the original layout, so it is not safe to rewrite")
    layout = matches[0]

    def encode(updated) -> bytes:
        return (b"\xff\xfe" if bom else b"") + serialise(updated, layout).encode("utf-16-le")

    if encode(value) != raw:
        fail(f"{label}: layout check failed")
    return value, encode


def rename_strings(value, changes: dict[str, str]):
    """Apply the identifier renames to every string in the part."""
    if isinstance(value, str):
        for old, new in changes.items():
            value = value.replace(old, new)
        return value
    if isinstance(value, list):
        return [rename_strings(v, changes) for v in value]
    if isinstance(value, dict):
        return {rename_strings(k, changes): rename_strings(v, changes)
                for k, v in value.items()}
    return value


def entries(value: dict) -> list:
    """The expression list in a part, whichever shape that part uses."""
    if "model" in value:
        return value["model"]["expressions"]
    if "queries" in value:
        return value["queries"]
    fail("unrecognised model part")
    return []


def body_field(entry: dict) -> str:
    return "expression" if "expression" in entry else "text"


def set_body(entry: dict, lines: list[str]) -> None:
    field = body_field(entry)
    entry[field] = list(lines) if isinstance(entry[field], list) else "\n".join(lines)


def get_body(entry: dict) -> str:
    field = body_field(entry)
    value = entry[field]
    return "\n".join(value) if isinstance(value, list) else value


def patch(value: dict, label: str, report: list[str]) -> dict:
    found = {e["name"] for e in entries(value)}
    for name in ("FabricSQLEndpoint", "LakehouseName", "FabricSource", "GetTable"):
        if name not in found:
            fail(f"{label}: expected expression '{name}' is missing - "
                 f"the upstream template has changed shape")

    value = rename_strings(value, RENAMES)
    items = entries(value)

    for entry in items:
        name = entry["name"]
        if name == "DataverseSource":
            set_body(entry, NEW_SOURCE)
            report.append(f"{label}: rewrote DataverseSource")
        elif name == "GetTable":
            set_body(entry, NEW_GET_TABLE)
            report.append(f"{label}: rewrote GetTable to strip the publisher prefix")
        elif name in DEFAULTS:
            set_body(entry, [f"{DEFAULTS[name]} {PARAMETER_META}"])
            report.append(f"{label}: set {name} = {DEFAULTS[name]}")

    if not any(e["name"] == "DataversePrefix" for e in items):
        template = next(e for e in items if e["name"] == "DataverseDatabase")
        added = {k: v for k, v in template.items()}
        added["name"] = "DataversePrefix"
        set_body(added, [f"{DEFAULTS['DataversePrefix']} {PARAMETER_META}"])
        items.insert(items.index(template) + 1, added)
        report.append(f"{label}: added the DataversePrefix parameter")

    return value


def verify(value: dict, label: str) -> None:
    bodies = {e["name"]: get_body(e) for e in entries(value)}
    for stale in RENAMES:
        for name, body in bodies.items():
            if stale in body:
                fail(f"{label}: '{stale}' still appears in {name}")
    if "Sql.Database(DataverseServer, DataverseDatabase)" not in bodies["DataverseSource"]:
        fail(f"{label}: DataverseSource was not rewritten")
    if "DataversePrefix" not in bodies["GetTable"]:
        fail(f"{label}: GetTable does not use the prefix")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true",
                        help="write the template; without it nothing is written")
    arguments = parser.parse_args()

    if not SOURCE.exists():
        fail(f"{SOURCE} not found")
    if SCHEMA_FILE.exists():
        schema = json.loads(SCHEMA_FILE.read_text(encoding="utf-8"))
        prefix = schema["publisherPrefix"] + "_"
        if DEFAULTS["DataversePrefix"].strip('"') != prefix:
            fail(f"DataversePrefix default does not match {SCHEMA_FILE.name} ({prefix})")

    raw = SOURCE.read_bytes()
    report: list[str] = []
    rebuilt: dict[str, bytes] = {}

    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        names = archive.namelist()
        for part in MODEL_PARTS:
            if part not in names:
                fail(f"{SOURCE.name}: missing part {part}")
        if any(n.startswith("DataMashup") for n in names):
            fail(f"{SOURCE.name}: this template carries a DataMashup part, which this "
                 f"script does not know how to rewrite")

        for part in MODEL_PARTS:
            value, encode = open_part(archive.read(part), part)
            value = patch(value, part, report)
            verify(value, part)
            rebuilt[part] = encode(value)

    for line in report:
        print(f"  {line}")

    if not arguments.write:
        untouched = sum(1 for n in zipfile.ZipFile(io.BytesIO(raw)).namelist()
                        if n not in MODEL_PARTS)
        print(f"\ndry run - nothing written. {len(MODEL_PARTS)} parts would change, "
              f"{untouched} copied through untouched (report layer and its signature included).")
        print(f"re-run with --write to produce {TARGET.name}")
        return

    scratch = TARGET.with_suffix(".pbit.tmp")
    with zipfile.ZipFile(io.BytesIO(raw)) as source:
        with zipfile.ZipFile(scratch, "w") as out:
            for info in source.infolist():
                data = rebuilt.get(info.filename, source.read(info.filename))
                copy = zipfile.ZipInfo(info.filename, date_time=info.date_time)
                copy.compress_type = info.compress_type
                copy.external_attr = info.external_attr
                copy.internal_attr = info.internal_attr
                copy.create_system = info.create_system
                out.writestr(copy, data)

    # Read it back before replacing anything, so a bad write cannot land.
    with zipfile.ZipFile(scratch) as check:
        if check.testzip() is not None:
            fail("the rebuilt template is corrupt")
        for part in MODEL_PARTS:
            value, _ = open_part(check.read(part), part)
            verify(value, part)
        with zipfile.ZipFile(io.BytesIO(raw)) as source:
            for info in source.infolist():
                if info.filename in MODEL_PARTS:
                    continue
                if check.read(info.filename) != source.read(info.filename):
                    fail(f"{info.filename} changed, but only the model parts may change")

    shutil.move(str(scratch), str(TARGET))
    print(f"\nwrote {TARGET.name}")


if __name__ == "__main__":
    main()
