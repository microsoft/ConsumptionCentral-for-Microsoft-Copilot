#!/usr/bin/env python3
"""Read Viva Direct's data files through one SourceFiles query, and read PAX's org file.

Viva Direct read its CSV files in two places, DataFiles and CoworkTaskInput,
and each called Folder.Files(DataFolder) itself. Now one unloaded query,
SourceFiles, lists the files and both read from it, so reading a SharePoint
folder instead of a local one means replacing that one query:

* SourceFiles (viva_direct_sources/SourceFiles.m) is the local form and the
  template's default, so Desktop users see no change. It lists DataFolder
  with Folder.Files and adds Depth, which counts folders separated by / as
  well as \\, so a stale copy in a subfolder never outranks the top-level
  file.
* "3. Viva Direct/SourceFiles.SharePoint.m" is the SharePoint form. The
  installer and manual users paste it over SourceFiles and set DataFolder
  and the new SharePointSiteUrl parameter. Nothing else then reads local
  files, so the published model should need no gateway.
* DataFiles (viva_direct_sources/DataFiles.m) and CoworkTaskInput
  (cowork_tasks/SourceFileInput.m) read SourceFiles.
* OrgNormalised (viva_query_org/OrgNormalised.m) reads PAX's Entra export:
  its spellings of cost center, division and manager, the five columns it
  repeats under AI-in-One's names, and the per-person columns, postal code
  and account flags that would otherwise each become a Group By attribute.

Each change lands in DataModelSchema and in the UnappliedChanges copy of the
query, with Desktop's last-loaded copies kept in step so the template opens
with nothing pending. Anything else that moves in either part fails the run,
and every other ZIP member keeps its raw bytes - the report layer is signed by
SecurityBindings. Running it twice changes nothing, and it can be rerun on a
template re-exported from Desktop.

    python docs/scripts/fix_viva_direct_sources.py --dry-run
    python docs/scripts/fix_viva_direct_sources.py
    python docs/scripts/fix_viva_direct_sources.py --check   # exit 1 if the template is stale

Desktop refresh and rendering still need checking after a change here.
"""

import argparse
import copy
import json
import os
import sys
import uuid
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fix_pbit_defaults import layout_for  # noqa: E402
from fix_refresh_time_cuts import (  # noqa: E402
    OWNED, SCHEMA, UNAPPLIED, dumps, joined, one, replace_snippets, sync_last_loaded, validate)
from fix_viva_query_org import Package, PatchError, query_index, require  # noqa: E402,F401 - PatchError is re-exported

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
TEMPLATE = REPO / "3. Viva Direct" / "Consumption Central - Viva Direct.pbit"
# What the installer and manual users paste over SourceFiles. The first is the
# supported form; the second opens the folder by name instead of listing the site.
SHAREPOINT_FORMS = (
    REPO / "3. Viva Direct" / "SourceFiles.SharePoint.m",
    REPO / "3. Viva Direct" / "SourceFiles.SharePoint.Contents.m",
)


def source(path):
    """A query's text as cowork_tasks/model.py reads one: UTF-8, trailing whitespace trimmed."""
    return path.read_text(encoding="utf-8").rstrip()


SOURCE_FILES_M = source(HERE / "viva_direct_sources" / "SourceFiles.m")
DATA_FILES_M = source(HERE / "viva_direct_sources" / "DataFiles.m")
FILE_INPUT_M = source(HERE / "cowork_tasks" / "FileInput.m")
SOURCE_FILE_INPUT_M = source(HERE / "cowork_tasks" / "SourceFileInput.m")
# fix_viva_query_org.py loads its replacements untrimmed, so this does too.
ORG_NORMALISED_M = (HERE / "viva_query_org" / "OrgNormalised.m").read_text(encoding="utf-8-sig")

DATA_FOLDER = "DataFolder"
SITE_URL = "SharePointSiteUrl"
SOURCE_FILES = "SourceFiles"
# Each goes in after the one before it, the first after DataFolder.
ADDED = (SITE_URL, SOURCE_FILES)
QUERY_ORDER = "PBI_QueryOrder"

SITE_URL_M = '"" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=false]'
SITE_URL_DESCRIPTION = (
    "Blank unless SourceFiles reads SharePoint. Then the address of the SharePoint site "
    "that holds DataFolder, such as https://contoso.sharepoint.com/sites/ConsumptionCentral. "
    "See the Viva Direct README.")

# DataFiles before it read SourceFiles.
DATA_FILES_BEFORE = "\n".join((
    'let',
    '\t// Optional on this path. Viva Direct reads Cowork through the',
    '\t// connector, so a tenant with only Cowork has no files at all -',
    '\t// that is a supported setup, not a misconfiguration.',
    '\tRoot =',
    '\t\tif DataFolder = null or Text.Trim(Text.From(DataFolder)) = ""',
    '\t\tthen null',
    '\t\telse Text.From(DataFolder),',
    '\tRaw = if Root = null then null else try Folder.Files(Root) otherwise null,',
    '\tCsvs = if Raw = null then null',
    '\t\telse Table.SelectRows(Raw, each Text.Lower([Extension]) = ".csv"),',
    '\tKeyed = if Csvs = null then null',
    '\t\telse Table.AddColumn(Csvs, "MatchKey",',
    '\t\t\teach Text.Lower(Text.Remove([Name], {" ", "_", "-"})), type text),',
    '\t// Depth is tracked because Folder.Files recurses: a stale copy left',
    '\t// in a subfolder should never quietly outrank the file the customer',
    '\t// put in the folder they nominated.',
    '\tDepth = if Keyed = null then null',
    '\t\telse Table.AddColumn(Keyed, "Depth",',
    '\t\t\teach List.Count(Text.Split(Text.Trim([#"Folder Path"], "\\"), "\\"))',
    '\t\t\t   - List.Count(Text.Split(Text.Trim(Root, "\\"), "\\")),',
    '\t\t\tInt64.Type)',
    'in',
    '\tDepth',
))

# Whole-text rewrites: (text before, text after).
REWRITES = {
    "DataFiles": (DATA_FILES_BEFORE, DATA_FILES_M),
    "CoworkTaskInput": (FILE_INPUT_M, SOURCE_FILE_INPUT_M),
}

# OrgNormalised before PAX -> viva_query_org/OrgNormalised.m. Each edit is
# anchored on the line before it, so an unrelated change elsewhere still applies.
ORG_EDITS = (
    ("\n".join((
        '        "spendingpolicylimit", "totalcopilotcreditsused", "creditsused", "userlimit", "planlimit",',
        '        "iscopilotlicensed", "standardtimezone", "timezone"',
    )), "\n".join((
        '        "spendingpolicylimit", "totalcopilotcreditsused", "creditsused", "userlimit", "planlimit",',
        '        "iscopilotlicensed", "standardtimezone", "timezone",',
        '        // Per-person ids, dates and lists from a PAX (Entra) export. None is a useful',
        '        // Group By, and each would still cost a column in Org and Org Attribute Source.',
        '        "id", "employeeid", "onpremisesimmutableid", "givenname", "surname",',
        '        "employeehiredate", "createddatetime", "managermail", "assignedlicenses",',
        '        "proxyaddressesprimary", "proxyaddressesall", "proxyaddressescount"',
    ))),
    ("\n".join((
        '        {"Country", {"country", "countryorregion", "region"}},',
        '        {"CostCenter", {"costcenter", "costcentre"}},',
        '        {"Manager", {"manager", "managername", "supervisor", "managerid", "managerupn", "manageruserprincipalname"}},',
        '        {"BusinessUnit", {"businessunit", "division", "segment", "companyname", "company"}}',
    )), "\n".join((
        '        {"Country", {"country", "countryorregion", "region"}},',
        '        // PAX spells these employeeOrgData_costCenter, manager_displayName and',
        "        // employeeOrgData_division. Earlier aliases win: a manager's name beats",
        '        // their id, and a division beats a company name.',
        '        {"CostCenter", {"costcenter", "costcentre", "employeeorgdatacostcenter"}},',
        '        {"Manager", {"manager", "managername", "managerdisplayname", "supervisor", "managerid", "managerupn", "manageruserprincipalname"}},',
        '        {"BusinessUnit", {"businessunit", "division", "employeeorgdatadivision", "segment", "companyname", "company"}}',
    ))),
    ("\n".join((
        '    Known = List.Combine(List.Transform(Aliases, each _{1})),',
    )), "\n".join((
        '    Known = List.Combine(List.Transform(Aliases, each _{1})),',
        "    // PAX repeats five columns under AI-in-One's names: {copy, original}.",
        '    // A copy is dropped only when its original is in the same file.',
        '    Copies = {',
        '        {"username", "displayname"}, {"businessarealabel", "employeeorgdatadivision"},',
        '        {"companycodelabel", "companyname"}, {"costcentrelabel", "employeeorgdatacostcenter"},',
        '        {"countryofemployment", "country"}',
        '    },',
    ))),
    ("\n".join((
        '                Present = List.Buffer(Table.ColumnNames(src)),',
    )), "\n".join((
        '                Present = List.Buffer(Table.ColumnNames(src)),',
        '                PresentKeys = List.Buffer(List.Transform(Present, Key)),',
        '                Surplus = List.Buffer(List.Transform(',
        '                    List.Select(Copies, (pair) => List.Contains(PresentKeys, pair{1})), each _{0})),',
    ))),
    ("\n".join((
        '                Extras = List.Buffer(List.Select(Present, each',
        '                    not List.Contains(NotOrg, Key(_)) and not List.Contains(Known, Key(_)))),',
    )), "\n".join((
        '                Extras = List.Buffer(List.Select(Present, each',
        '                    not List.Contains(NotOrg, Key(_)) and not List.Contains(Known, Key(_))',
        '                    and not List.Contains(Surplus, Key(_)))),',
    ))),
    # Added after the edits above shipped, so it also upgrades that text.
    ('        "proxyaddressesprimary", "proxyaddressesall", "proxyaddressescount"',
     "\n".join((
         '        "proxyaddressesprimary", "proxyaddressesall", "proxyaddressescount",',
         "        // Nor are its postal code and account flags: they describe the directory",
         "        // entry, not where someone sits in the organisation.",
         '        "postalcode", "accountenabled", "onpremisessyncenabled", "externaluserstate"',
     ))),
)
ORG_NORMALISED = "OrgNormalised"
REWRITTEN = (*REWRITES, ORG_NORMALISED)


def tag(name):
    """A fixed lineage tag per added query, so a rerun or a rebuild gives the same one."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL,
                          "https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/"
                          f"3. Viva Direct/{name}"))


def schema_entries():
    """The added model expressions, in the key order Desktop writes."""
    return {
        SITE_URL: {
            "name": SITE_URL, "description": SITE_URL_DESCRIPTION, "kind": "m",
            "expression": SITE_URL_M, "lineageTag": tag(SITE_URL),
            "annotations": [{"name": "PBI_ResultType", "value": "Text"},
                            {"name": "PBI_NavigationStepName", "value": "Navigation"}],
        },
        SOURCE_FILES: {
            "name": SOURCE_FILES, "kind": "m", "expression": SOURCE_FILES_M.split("\n"),
            "lineageTag": tag(SOURCE_FILES),
            "annotations": [{"name": "PBI_NavigationStepName", "value": "Navigation"},
                            {"name": "PBI_ResultType", "value": "Table"}],
        },
    }


def pending_entries():
    """The added UnappliedChanges queries, shaped like DataFolder's and DataFiles'."""
    return {
        SITE_URL: {
            "name": SITE_URL, "lineageTag": tag(SITE_URL), "description": SITE_URL_DESCRIPTION,
            "navigationStepName": "Navigation", "text": [SITE_URL_M],
            "loadAsTableDisabled": True, "resultType": "Text", "isHidden": False,
        },
        SOURCE_FILES: {
            "name": SOURCE_FILES, "lineageTag": tag(SOURCE_FILES),
            "navigationStepName": "Navigation", "text": SOURCE_FILES_M.split("\n"),
            "loadAsTableDisabled": True, "resultType": "Table", "isHidden": False,
        },
    }


ADDED_TEXT = {SITE_URL: SITE_URL_M, SOURCE_FILES: SOURCE_FILES_M}


# ---------------------------------------------------------------------------
# Edits
# ---------------------------------------------------------------------------


def new_text(name, text):
    """The text a rewritten query should hold, or a PatchError for one this does not know."""
    if name == ORG_NORMALISED:
        if text == ORG_NORMALISED_M:
            return text
        result = replace_snippets(name, text, ORG_EDITS)
        require(result == ORG_NORMALISED_M,
                f"{name}: neither the pre-PAX text nor viva_query_org/OrgNormalised.m; "
                "review it before patching")
        return result
    before, after = REWRITES[name]
    require(text in (before, after),
            f"{name}: neither the text before SourceFiles nor the shipped one; review it before patching")
    return after


def check_added(name, text, label):
    """An added query already there - after a Desktop re-export, say - must hold exactly our text."""
    if name == SITE_URL and text.split(" meta ", 1)[0].strip() == "null":
        raise PatchError(f"{label}: {name} is null; run fix_pbit_defaults.py first")
    require(text == ADDED_TEXT[name],
            f"{label}: {name} is already there with other text; review it before patching")


def insert(records, name, record, label):
    """Put record in after the query that comes before it in ADDED."""
    anchor = (DATA_FOLDER,) + ADDED
    names = [r["name"] for r in records]
    before = anchor[anchor.index(name) - 1]
    require(before in names, f"{label}: no {before} to put {name} after")
    records.insert(names.index(before) + 1, record)


def edit_model(model):
    """Add, rewrite and order the model's expressions. Returns what changed."""
    expressions = model["model"]["expressions"]
    changes = []
    for name, entry in schema_entries().items():
        if any(e["name"] == name for e in expressions):
            existing = one(expressions, name, f"{SCHEMA} expressions")
            require(existing.get("kind") == "m", f"{SCHEMA}: {name} is not an M expression")
            check_added(name, joined(existing["expression"]), SCHEMA)
            continue
        insert(expressions, name, entry, f"{SCHEMA} expressions")
        changes.append(f"{name} added")
    for name in REWRITTEN:
        expression = one(expressions, name, f"{SCHEMA} expressions")
        text = joined(expression["expression"])
        result = new_text(name, text)
        if result == text:
            continue
        # A list stays a list and a string a string, as Desktop wrote it.
        expression["expression"] = result.split("\n") if isinstance(expression["expression"], list) else result
        changes.append(name)
    order = one(model["model"]["annotations"], QUERY_ORDER, f"{SCHEMA} annotations")
    names = json.loads(order["value"])
    require(isinstance(names, list) and dumps(names) == order["value"],
            f"{SCHEMA}: {QUERY_ORDER} does not round-trip")
    moved = False
    for name in ADDED:
        if name not in names:
            anchor = (DATA_FOLDER,) + ADDED
            before = anchor[anchor.index(name) - 1]
            require(before in names, f"{SCHEMA}: {QUERY_ORDER} has no {before} to put {name} after")
            names.insert(names.index(before) + 1, name)
            moved = True
    if moved:
        order["value"] = dumps(names)
        changes.append(QUERY_ORDER)
    return changes


def edit_pending(pending):
    """Add and rewrite the UnappliedChanges queries. Returns what changed."""
    queries = pending["queries"]
    changes, rewritten = [], {}
    for name, entry in pending_entries().items():
        if any(q["name"] == name for q in queries):
            check_added(name, joined(one(queries, name, f"{UNAPPLIED} queries")["text"]), UNAPPLIED)
            continue
        insert(queries, name, entry, f"{UNAPPLIED} queries")
        changes.append(f"{name} added")
    for name in REWRITTEN:
        query = one(queries, name, f"{UNAPPLIED} queries")
        text = joined(query["text"])
        result = new_text(name, text)
        if result == text:
            continue
        query["text"] = result.split("\n")
        rewritten[name] = (text, result)
        changes.append(name)
    for query in queries:
        sync_last_loaded(query, rewritten)
    return changes


# ---------------------------------------------------------------------------
# Owned fields: everything outside them must come through untouched
# ---------------------------------------------------------------------------


def owned_mask_model(document):
    result = copy.deepcopy(document)
    model = result["model"]
    model["expressions"] = [e for e in model["expressions"] if e["name"] not in ADDED]
    for expression in model["expressions"]:
        if expression["name"] in REWRITTEN:
            expression["expression"] = OWNED
    for annotation in model.get("annotations", []):
        if annotation["name"] == QUERY_ORDER:
            annotation["value"] = [n for n in json.loads(annotation["value"]) if n not in ADDED]
    return result


def owned_mask_pending(document):
    result = copy.deepcopy(document)
    result["queries"] = [q for q in result["queries"] if q["name"] not in ADDED]
    for query in result["queries"]:
        if query["name"] in REWRITTEN:
            query["text"] = OWNED
            query.pop("lastLoadedAsTableFormulaText", None)
            continue
        raw = query.get("lastLoadedAsTableFormulaText")
        if not raw:
            continue
        # Another query's cached copy of a rewritten one moves with it, and nothing else may.
        cache = json.loads(raw)
        refs = cache.get("ReferencedQueriesFormulaText") if isinstance(cache, dict) else None
        if isinstance(refs, dict) and set(refs) & set(REWRITTEN):
            for ref in set(refs) & set(REWRITTEN):
                refs[ref] = OWNED
            query["lastLoadedAsTableFormulaText"] = dumps(cache)
    return result


# ---------------------------------------------------------------------------
# Archive
# ---------------------------------------------------------------------------


def build(raw):
    """Return (bytes, changes) for the template. One with nothing to change comes back as raw."""
    package = Package(raw)
    # layout_for re-encodes each part byte for byte before handing it over, so an edit
    # cannot quietly change the BOM, the indentation or the line endings.
    model, encode_model = layout_for(package.contents[SCHEMA], SCHEMA)
    pending, encode_pending = layout_for(package.contents[UNAPPLIED], UNAPPLIED)
    for name in REWRITTEN:
        # Both copies take the same edit, so they only end in step if they start in step.
        require(joined(one(pending["queries"], name, f"{UNAPPLIED} queries")["text"])
                == joined(one(model["model"]["expressions"], name, f"{SCHEMA} expressions")["expression"]),
                f"{name}: the {UNAPPLIED} copy differs from the model; run fix_query_body_drift.py first")

    changes, updates = [], {}
    before = copy.deepcopy(model)
    edits = edit_model(model)
    if edits:
        require(owned_mask_model(before) == owned_mask_model(model),
                f"{SCHEMA}: a field outside SourceFiles and the PAX aliases changed")
        updates[SCHEMA] = encode_model(model)
        changes += [f"{SCHEMA} {edit}" for edit in edits]

    before = copy.deepcopy(pending)
    edits = edit_pending(pending)
    if edits:
        require(owned_mask_pending(before) == owned_mask_pending(pending),
                f"{UNAPPLIED}: a field outside SourceFiles and the PAX aliases changed")
        updates[UNAPPLIED] = encode_pending(pending)
        changes += [f"{UNAPPLIED} {edit}" for edit in edits]

    if not updates:
        return raw, changes
    # Both parts name the same queries, with the same text.
    query_index(model, pending)
    candidate = package.rebuild(updates)
    validate(package, candidate, updates, model, pending)
    return candidate, changes


def publish(path, raw, candidate):
    """Write through a scratch file, and only over the bytes the patch was built from."""
    scratch = path.with_name(f".fix-viva-direct-sources-{uuid.uuid4().hex}.pbit")
    owned = False
    try:
        with scratch.open("xb") as stream:
            owned = True
            stream.write(candidate)
            stream.flush()
            os.fsync(stream.fileno())
        require(scratch.read_bytes() == candidate, "scratch write verification failed")
        require(path.read_bytes() == raw, f"{path.name} changed during the patch; refusing to publish")
        os.replace(scratch, path)
        owned = False
    finally:
        if owned:
            scratch.unlink()


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="validate and report without writing")
    mode.add_argument("--check", action="store_true", help="exit 1 if the template still needs a change")
    args = parser.parse_args(argv)

    path = TEMPLATE
    print(path.parent.name)
    try:
        require(path.is_file(), f"missing template: {path}")
        raw = path.read_bytes()
        candidate, changes = build(raw)
        if not changes:
            print("  already applied; left byte for byte unchanged")
            return 0
        for change in changes:
            print(f"  {change}")
        if args.check:
            print("\nthe template is stale; run python docs/scripts/fix_viva_direct_sources.py")
            return 1
        if not args.dry_run:
            publish(path, raw, candidate)
            print("  validated patch written")
    except (ValueError, KeyError, TypeError, zipfile.BadZipFile) as error:
        print(f"  FAILED: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
