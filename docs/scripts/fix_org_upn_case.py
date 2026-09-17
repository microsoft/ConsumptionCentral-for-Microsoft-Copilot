"""Make the Org table's key case-insensitive, in every template.

Org sits on the one side of every relationship in the model, so its
UserPrincipalName has to be unique. It was not.

OrgNormalised merges two or three separate exports - the seat roster, an
Entra/CSV directory dump and whatever org columns Viva carried - and it
merges them with Table.Distinct, Table.NestedJoin and Record.FromList.
All three are case-SENSITIVE. The DAX relationship that consumes the
result is not. So a tenant whose directory spells someone AlexW@contoso.com
while Viva spells them alexw@contoso.com produced two Org rows that DAX read
as one key, and the whole refresh died with

    Column 'UserPrincipalName' in Table 'Org' contains a duplicate value
    'AlexW@contoso.com' and this is not allowed for columns on the one side of
    a many-to-one relationship

with every other table reporting "Load was cancelled by an error in
loading a previous table" behind it. It only bites when two sources are
present at once, which is why it survived every single-source test; the
customer's own workaround was to delete the org columns from the Viva
query, which drops the model back to one source.

Folding the key at the merge is necessary but not sufficient on its own.
The per-attribute lookups are keyed on the same strings, so leaving them
case-sensitive would turn a hard failure into a silent one: the load
would succeed and that person would simply have no department. Both are
folded here.

This is a model-layer change. DataModelSchema and UnappliedChanges are
not covered by the .pbit SecurityBindings signature, so they can be
patched in place - no PBIP round-trip needed. See docs/BUILD.md.

    python docs/scripts/fix_org_upn_case.py --dry-run
    python docs/scripts/fix_org_upn_case.py
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fix_pbit_defaults import layout_for  # noqa: E402
from fix_viva_query_org import Package, PatchError, require  # noqa: E402

REPO = Path(__file__).resolve().parents[2]

TEMPLATES = (
    REPO / "1. Local CSV" / "Consumption Central - Local CSV.pbit",
    REPO / "2. Fabric" / "Consumption Central - Fabric.pbit",
    REPO / "3. Viva Direct" / "Consumption Central - Viva Direct.pbit",
)

SCHEMA = "DataModelSchema"
UNAPPLIED = "UnappliedChanges"
QUERY = "OrgNormalised"

# Present once the fix is in; used to keep the script idempotent.
MARKER = "_upnKey"

# --- Fabric and Viva Direct -------------------------------------------------
# Both spell the merge identically, so one anchor serves both. Spine differs
# (Roster[userPrincipalName] vs Roster[ResolvedKey]) but that is above the cut.

BUFFERED_OLD = '''    Upns = Table.Buffer(Table.Distinct(Table.Combine({
        Spine, Table.SelectColumns(E, {"UserPrincipalName"}), Table.SelectColumns(V, {"UserPrincipalName"})
    }))),
    // V and E have one buffered row per key; index once instead of re-reading nested joins per attribute.
    VIndex = Record.FromList(List.Buffer(Table.ToRecords(V)), List.Buffer(V[UserPrincipalName])),
    EIndex = Record.FromList(List.Buffer(Table.ToRecords(E)), List.Buffer(E[UserPrincipalName])),
    Merged = Table.FromRecords(List.Transform(Table.ToRecords(Upns), (row) =>
        let
            VivaRow = Record.FieldOrDefault(VIndex, row[UserPrincipalName], []),
            EntraRow = Record.FieldOrDefault(EIndex, row[UserPrincipalName], [])
        in'''

BUFFERED_NEW = '''    // Three independent exports, three independent opinions on how to spell
    // an address, and Table.Distinct compares them case-SENSITIVELY while
    // the DAX relationship downstream does not. A directory saying AlexW@x
    // beside a Viva export saying alexw@x therefore reached the model as two
    // Org rows for one person, and Org is the one side of every
    // relationship, so the refresh failed outright on the duplicate key.
    //
    // The same fold is applied to the two indexes below. Deduplicating the
    // spine alone would fix the crash and replace it with a quieter bug:
    // the surviving spelling would no longer match the other source, and
    // that person would load fine with no department at all.
    Fold = (u as nullable text) as nullable text =>
        if u = null then null else Text.Lower(Text.Trim(u)),
    // Record.FromList raises on a repeated field name, so each side is
    // reduced to one row per folded key before it is indexed.
    ByFoldedKey = (t as table) as table =>
        Table.RemoveColumns(
            Table.Distinct(
                Table.AddColumn(
                    Table.SelectRows(t, each [UserPrincipalName] <> null
                        and Text.Trim([UserPrincipalName]) <> ""),
                    MARKERCOL, each Fold([UserPrincipalName]), type text),
                {MARKERCOL}),
            {MARKERCOL}),
    Upns = Table.Buffer(ByFoldedKey(Table.Combine({
        Spine, Table.SelectColumns(E, {"UserPrincipalName"}), Table.SelectColumns(V, {"UserPrincipalName"})
    }))),
    // V and E have one buffered row per key; index once instead of re-reading nested joins per attribute.
    VK = Table.Buffer(ByFoldedKey(V)),
    EK = Table.Buffer(ByFoldedKey(E)),
    VIndex = Record.FromList(List.Buffer(Table.ToRecords(VK)), List.Buffer(List.Transform(VK[UserPrincipalName], Fold))),
    EIndex = Record.FromList(List.Buffer(Table.ToRecords(EK)), List.Buffer(List.Transform(EK[UserPrincipalName], Fold))),
    Merged = Table.FromRecords(List.Transform(Table.ToRecords(Upns), (row) =>
        let
            VivaRow = Record.FieldOrDefault(VIndex, Fold(row[UserPrincipalName]), []),
            EntraRow = Record.FieldOrDefault(EIndex, Fold(row[UserPrincipalName]), [])
        in'''.replace("MARKERCOL", f'"{MARKER}"')

# --- Local CSV --------------------------------------------------------------
# Tab-indented, and joins rather than indexes. Same disease, same cure.

T = "\t"

JOINED_OLD = (
    f'{T*4}Upns = Table.Distinct(Table.Combine({{\n'
    f'{T*7}Table.SelectColumns(EntraN, {{"UserPrincipalName"}}),\n'
    f'{T*7}Table.SelectColumns(VivaN,  {{"UserPrincipalName"}})}})),\n'
    f'{T*4}JV = Table.NestedJoin(Upns, {{"UserPrincipalName"}}, VivaN, {{"UserPrincipalName"}}, "v", JoinKind.LeftOuter),\n'
    f'{T*4}EV = Table.ExpandTableColumn(JV, "v", Attrs, List.Transform(Attrs, each "v." & _)),\n'
    f'{T*4}JE = Table.NestedJoin(EV, {{"UserPrincipalName"}}, EntraN, {{"UserPrincipalName"}}, "e", JoinKind.LeftOuter),\n'
    f'{T*4}EE = Table.ExpandTableColumn(JE, "e", Attrs, List.Transform(Attrs, each "e." & _)),'
)

JOINED_NEW = (
    f'{T*4}// Normalise folds case within each source, but nothing folds it\n'
    f'{T*4}// ACROSS them, and both Table.Distinct and Table.NestedJoin compare\n'
    f'{T*4}// case-sensitively while the DAX relationship downstream does not.\n'
    f'{T*4}// A directory spelling someone AlexW@x beside a Viva export spelling\n'
    f'{T*4}// them alexw@x therefore produced two Org rows for one person, and\n'
    f'{T*4}// Org is the one side of every relationship, so the refresh failed\n'
    f'{T*4}// outright on the duplicate key.\n'
    f'{T*4}//\n'
    f'{T*4}// The joins fold too. Deduplicating the key alone would trade the\n'
    f'{T*4}// crash for a silent miss: the surviving spelling would stop\n'
    f'{T*4}// matching the other source and that person would load with no\n'
    f'{T*4}// department rather than no row.\n'
    f'{T*4}Keyed = (t as table) as table =>\n'
    f'{T*5}Table.AddColumn(t, "{MARKER}",\n'
    f'{T*6}each Text.Lower(Text.Trim([UserPrincipalName])), type text),\n'
    f'{T*4}VivaK  = Keyed(VivaN),\n'
    f'{T*4}EntraK = Keyed(EntraN),\n'
    f'{T*4}Upns = Table.Distinct(Table.Combine({{\n'
    f'{T*7}Table.SelectColumns(EntraK, {{"UserPrincipalName", "{MARKER}"}}),\n'
    f'{T*7}Table.SelectColumns(VivaK,  {{"UserPrincipalName", "{MARKER}"}})}}), {{"{MARKER}"}}),\n'
    f'{T*4}JV = Table.NestedJoin(Upns, {{"{MARKER}"}}, VivaK, {{"{MARKER}"}}, "v", JoinKind.LeftOuter),\n'
    f'{T*4}EV = Table.ExpandTableColumn(JV, "v", Attrs, List.Transform(Attrs, each "v." & _)),\n'
    f'{T*4}JE = Table.NestedJoin(EV, {{"{MARKER}"}}, EntraK, {{"{MARKER}"}}, "e", JoinKind.LeftOuter),\n'
    f'{T*4}EE = Table.ExpandTableColumn(JE, "e", Attrs, List.Transform(Attrs, each "e." & _)),'
)

EDITS = (
    (BUFFERED_OLD, BUFFERED_NEW),
    (JOINED_OLD, JOINED_NEW),
)


class LocalPatchError(PatchError):
    pass


def as_text(expression):
    return "\n".join(expression) if isinstance(expression, list) else expression


def reshape(original, text):
    """Put a body back in whichever shape the part stored it in."""
    return text.split("\n") if isinstance(original, list) else text


def patch_m(text):
    """Return (new_text, applied) for one OrgNormalised body."""
    hits = [(old, new) for old, new in EDITS if old in text]
    if not hits:
        # Already folded, or the query moved underneath us. Tell those apart.
        require("Fold = (u as nullable text)" in text or "Keyed = (t as table)" in text,
                "no merge anchor matched and no fold is present - has OrgNormalised changed?")
        return text, False
    require(len(hits) == 1,
            f"expected exactly one merge shape to match, found {len(hits)}")
    old, new = hits[0]
    require(text.count(old) == 1, "merge anchor is not unique")
    return text.replace(old, new), True


def patch_template(path, dry_run):
    print(f"{path.parent.name}")
    package = Package(path.read_bytes())

    # layout_for reproduces each part byte for byte before it hands anything
    # back, so a re-encode cannot quietly add a BOM or change the indentation
    # and invalidate the file. Package rebuilds the ZIP around the untouched
    # records, leaving the signed report parts exactly where they were.
    schema, encode_schema = layout_for(package.contents[SCHEMA], SCHEMA)
    unapplied, encode_unapplied = layout_for(package.contents[UNAPPLIED], UNAPPLIED)

    matches = [e for e in schema["model"].get("expressions", [])
               if e["name"] == QUERY]
    require(len(matches) == 1, f"{QUERY}: expected one expression, found {len(matches)}")
    expression = matches[0]

    before = as_text(expression["expression"])
    after, applied = patch_m(before)
    if not applied:
        print("  OrgNormalised - already folded")
        return False
    expression["expression"] = reshape(expression["expression"], after)
    print(f"  OrgNormalised - folded ({len(before)} -> {len(after)} chars)")

    # UnappliedChanges carries its own copy of every query body and
    # check_unapplied_sync.py fails the build when the two disagree.
    hit = [q for q in unapplied.get("queries", []) if q.get("name") == QUERY]
    require(len(hit) <= 1, f"{QUERY}: duplicate entry in UnappliedChanges")
    require(hit, f"{QUERY}: missing from UnappliedChanges")
    stored = hit[0]["text"]
    require(isinstance(stored, (list, str)),
            f"{QUERY}: unexpected UnappliedChanges text shape")
    current = as_text(stored)
    # A Desktop re-export trims trailing blank lines from this copy but not
    # from the schema copy, so the two drift by a newline that means nothing
    # to M. Viva Direct ships that way today. Compare without it and write
    # both sides identical, which settles the drift rather than carrying it.
    require(current.rstrip("\n") == before.rstrip("\n"),
            f"{QUERY}: UnappliedChanges body differs from the schema body")
    if current != before:
        print("  UnappliedChanges - trailing-newline drift repaired")
    hit[0]["text"] = reshape(stored, after)
    print("  UnappliedChanges - synced")

    if dry_run:
        return True

    updates = {SCHEMA: encode_schema(schema), UNAPPLIED: encode_unapplied(unapplied)}
    rebuilt = package.rebuild(updates)

    # Nothing outside the two model parts may move. The report layer is
    # covered by SecurityBindings and Desktop rejects the whole file if a
    # single byte of it changes.
    check = Package(rebuilt)
    moved = sorted(n for n in package.contents
                   if check.contents[n] != package.contents[n])
    require(moved == sorted(updates), f"unexpected parts changed: {moved}")

    path.write_bytes(rebuilt)
    return True


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("templates", nargs="*", type=Path,
                        help="defaults to all three shipped templates")
    args = parser.parse_args(argv)

    paths = args.templates or list(TEMPLATES)
    changed = 0
    for path in paths:
        require(path.exists(), f"missing template: {path}")
        try:
            changed += bool(patch_template(path, args.dry_run))
        except PatchError as exc:
            print(f"  FAILED: {exc}", file=sys.stderr)
            return 1
    print(f"\n{changed} template(s) {'would be ' if args.dry_run else ''}patched")
    return 0


if __name__ == "__main__":
    sys.exit(main())
