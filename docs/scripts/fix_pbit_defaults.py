#!/usr/bin/env python3
"""Restore the shipping parameter defaults in a .pbit.

Exporting a template from Power BI Desktop writes whatever the parameters
currently hold, and a project opened without a data cache holds nothing, so
every parameter comes back null. That is the exact failure in issue #6: a null
BillingPeriodWeeks makes VivaPeriodStart throw, and every other table then
reports only "Load was cancelled by an error in loading a previous table".

Values are taken from a reference template - by default the committed version
of the same file - so every parameter is restored, not just the nine
check_pbit_defaults.py documents. Those nine are still cross-checked against
the reference, so a drifted reference cannot be copied in silently.

This is a model-only repair. It touches DataModelSchema and UnappliedChanges -
the two parts that hold the parameter values - and leaves the report layer,
which Desktop signs, untouched.

    python docs/scripts/fix_pbit_defaults.py --dry-run
    python docs/scripts/fix_pbit_defaults.py
"""

import argparse
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from check_pbit_defaults import EXPECTED  # noqa: E402
from fix_viva_query_org import Package, require  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
TEMPLATES = (
    ROOT / "1. Local CSV" / "Consumption Central - Local CSV.pbit",
    ROOT / "2. Fabric" / "Consumption Central - Fabric.pbit",
    ROOT / "3. Viva Direct" / "Consumption Central - Viva Direct.pbit",
)

SCHEMA = "DataModelSchema"
UNAPPLIED = "UnappliedChanges"
PARTS = (SCHEMA, UNAPPLIED)
MARKER = "IsParameterQuery=true"
SEPARATOR = " meta "
NULL = "null"

# Desktop writes DataModelSchema indented with CRLF and UnappliedChanges
# compact; the layout is confirmed against the original bytes before use.
LAYOUTS = (
    {"indent": 2, "newline": "\r\n"},
    {"indent": 2, "newline": "\n"},
    {"separators": (",", ":"), "newline": ""},
)


def serialise(value, layout):
    options = {k: v for k, v in layout.items() if k != "newline"}
    text = json.dumps(value, ensure_ascii=False, allow_nan=False, **options)
    if layout["newline"] == "\r\n":
        text = text.replace("\n", "\r\n")
    return text


def decode(raw, label):
    if raw[:2] == b"\xff\xfe":
        return raw[2:].decode("utf-16-le"), True
    require(len(raw) > 1 and raw[1] == 0, f"{label}: expected UTF-16LE")
    return raw.decode("utf-16-le"), False


def layout_for(raw, label):
    """Pick the layout that reproduces this part byte for byte, or fail."""
    text, bom = decode(raw, label)
    value = json.loads(text)
    matches = [l for l in LAYOUTS if serialise(value, l) == text]
    require(len(matches) == 1, f"{label}: cannot reproduce the original layout")

    def encode(updated):
        return (b"\xff\xfe" if bom else b"") + serialise(updated, matches[0]).encode("utf-16-le")

    require(encode(value) == raw, f"{label}: layout check failed")
    return value, encode


def parameter_lines(value):
    """Every single-line parameter expression in a decoded part, by name."""
    found = {}
    entries = value["model"]["expressions"] if "model" in value else value["queries"]
    for entry in entries:
        text = entry.get("expression", entry.get("text"))
        if isinstance(text, list):
            if len(text) == 1 and MARKER in text[0]:
                found[entry["name"]] = text[0]
            else:
                require(not any(MARKER in line for line in text),
                        f"{entry['name']}: parameter stored as multiple lines")
        elif isinstance(text, str) and MARKER in text:
            found[entry["name"]] = text
    return found


def value_of(text, name, label):
    require(SEPARATOR in text, f"{label}: {name} has no meta section")
    return text.split(SEPARATOR, 1)[0].strip()


def reference_schema(path, reference):
    """The decoded DataModelSchema to restore from."""
    if reference is None:
        relative = path.relative_to(ROOT).as_posix()
        result = subprocess.run(["git", "-C", str(ROOT), "show", f"HEAD:{relative}"],
                                capture_output=True)
        require(result.returncode == 0 and result.stdout,
                f"{path.name}: cannot read the committed template; pass --reference")
        raw = result.stdout
    else:
        raw = Path(reference).read_bytes()

    schema, _ = layout_for(Package(raw, parts=PARTS).contents[SCHEMA], SCHEMA)
    return schema


def reference_defaults(schema):
    """The parameter values to restore, cross-checked against EXPECTED."""
    defaults = {}
    for name, text in parameter_lines(schema).items():
        value = value_of(text, name, "reference")
        expected = EXPECTED.get(name)
        require(expected is None or value == expected,
                f"reference: {name} is {value[:40]}, expected the documented "
                f"{expected}; refusing to restore a drifted value")
        defaults[name] = value
    return defaults


def restore(text, name, label, defaults):
    """Return the expression with its shipping default, or None if unchanged."""
    value = value_of(text, name, label)
    require(name in defaults, f"{label}: {name} is not in the reference template")
    wanted = defaults[name]
    if value == wanted:
        return None
    require(value == NULL,
            f"{label}: {name} holds {value[:40]}, not null; refusing to overwrite it")
    return f"{wanted}{SEPARATOR}{text.split(SEPARATOR, 1)[1]}"


def patch_schema(schema, defaults):
    changed = []
    lines = parameter_lines(schema)
    for expression in schema["model"].get("expressions", []):
        if expression["name"] not in lines:
            continue
        restored = restore(expression["expression"], expression["name"], SCHEMA, defaults)
        if restored is None:
            continue
        expression["expression"] = restored
        changed.append(expression["name"])
    return changed


def patch_bodies(schema, source):
    """Restore query bodies and descriptions Desktop dropped on export.

    Re-exporting a template rewrites every M query, and Desktop silently drops
    the comment blocks stored as a query description and trims trailing blank
    lines. None of that is a modelling change, so the reference wins. Parameter
    expressions are excluded - patch_schema owns those.
    """
    changed = []
    reference = {e["name"]: e for e in source["model"].get("expressions", [])}
    parameters = parameter_lines(schema)
    for expression in schema["model"].get("expressions", []):
        name = expression["name"]
        if name in parameters or name not in reference:
            continue
        wanted = reference[name]
        if expression.get("expression") == wanted.get("expression") \
                and expression.get("description") == wanted.get("description"):
            continue
        expression["expression"] = wanted["expression"]
        if "description" in wanted:
            expression["description"] = wanted["description"]
        else:
            expression.pop("description", None)
        changed.append(name)
    return changed


def patch_unapplied(unapplied, defaults):
    changed = []
    lines = parameter_lines(unapplied)
    for query in unapplied.get("queries", []):
        if query["name"] not in lines:
            continue
        restored = restore(lines[query["name"]], query["name"], UNAPPLIED, defaults)
        if restored is None:
            continue
        query["text"] = [restored]
        changed.append(query["name"])
    return changed


def patch_query_bodies(unapplied, source):
    """Keep staged expressions synchronized with the restored model sources."""
    reference = {e["name"]: e for e in source["model"].get("expressions", [])}
    parameters = parameter_lines(source)
    changed = []
    for query in unapplied.get("queries", []):
        name = query["name"]
        if name in parameters or name not in reference:
            continue
        expression = reference[name]["expression"]
        body = "\n".join(expression) if isinstance(expression, list) else expression
        wanted = body.split("\n")
        if query.get("text") != wanted:
            query["text"] = wanted
            changed.append(name)
    return changed


def patch(path, reference=None, dry_run=False):
    path = Path(path).resolve()
    require(path.is_file(), f"Source does not exist: {path}")
    raw = path.read_bytes()
    original = Package(raw, parts=PARTS)
    source = reference_schema(path, reference)
    defaults = reference_defaults(source)

    schema, encode_schema = layout_for(original.contents[SCHEMA], SCHEMA)
    unapplied, encode_unapplied = layout_for(original.contents[UNAPPLIED], UNAPPLIED)

    in_schema = patch_schema(schema, defaults)
    bodies = patch_bodies(schema, source)
    in_unapplied = patch_unapplied(unapplied, defaults)
    query_bodies = patch_query_bodies(unapplied, source)

    print(f"\n{path.name}")
    print(f"  {SCHEMA}: {len(in_schema)} parameters restored")
    print(f"  {UNAPPLIED}: {len(in_unapplied)} parameters restored")
    for name in bodies:
        print(f"  {SCHEMA}: {name} body/description restored")
    for name in query_bodies:
        print(f"  {UNAPPLIED}: {name} body synchronized")

    if not in_schema and not in_unapplied and not bodies and not query_bodies:
        print("  already at shipping defaults; left byte-for-byte unchanged")
        return 0
    require(sorted(in_schema) == sorted(in_unapplied),
            f"{path.name}: the two parts disagree about which parameters were null: "
            f"{sorted(set(in_schema) ^ set(in_unapplied))}")

    updates = {SCHEMA: encode_schema(schema), UNAPPLIED: encode_unapplied(unapplied)}
    candidate_bytes = original.rebuild(updates)
    validate(original, candidate_bytes, updates, schema, unapplied)

    if dry_run:
        print("  dry run; nothing written")
        return len(in_schema)

    scratch = path.with_name(f".fix-pbit-defaults-{uuid.uuid4().hex}.pbit")
    owned = False
    try:
        with scratch.open("xb") as stream:
            owned = True
            stream.write(candidate_bytes)
            stream.flush()
            os.fsync(stream.fileno())
        written = scratch.read_bytes()
        require(written == candidate_bytes, "Scratch write verification failed")
        validate(original, written, updates, schema, unapplied)
        require(path.read_bytes() == raw, "Source changed during patch; refusing to publish")
        os.replace(scratch, path)
        owned = False
    finally:
        if owned:
            scratch.unlink()
    print(f"  validated patch written: {path}")
    return len(in_schema)


def validate(original, candidate_bytes, updates, schema, unapplied):
    """Nothing but the two model parts may move, and only as reviewed."""
    candidate = Package(candidate_bytes, parts=PARTS)
    require(list(original.infos) == list(candidate.infos), "Candidate changed ZIP parts/order")
    require(original.local_order == candidate.local_order, "Candidate changed local order")
    require(original.prefix == candidate.prefix and original.comment == candidate.comment,
            "Candidate changed archive prefix/comment")
    for name in original.infos:
        if name in updates:
            require(candidate.contents[name] == updates[name], f"{name}: unexpected content")
        else:
            require(candidate.contents[name] == original.contents[name],
                    f"{name}: changed but should not have")
    # The bytes are only trusted once they reparse into the reviewed documents.
    require(json.loads(decode(candidate.contents[SCHEMA], SCHEMA)[0]) == schema,
            f"{SCHEMA}: candidate does not match the intended document")
    require(json.loads(decode(candidate.contents[UNAPPLIED], UNAPPLIED)[0]) == unapplied,
            f"{UNAPPLIED}: candidate does not match the intended document")


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--path", type=Path, action="append",
                        help="Template to patch; defaults to all three")
    parser.add_argument("--reference", type=Path,
                        help="Template to take values from; defaults to the committed file")
    parser.add_argument("--dry-run", action="store_true",
                        help="Validate without writing files")
    args = parser.parse_args(argv)
    for template in (args.path or TEMPLATES):
        patch(template, reference=args.reference, dry_run=args.dry_run)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
