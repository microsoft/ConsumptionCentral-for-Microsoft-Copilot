"""Cut the refresh-time cost of the model, in every template.

Ported from Analytics Hub's scripts/Update-Model-Refresh-Fixes.py at commit
1af87db (microsoft/AnalyticsHub-Dashboard#175 and #176; the buffering first
came in with #30). Only the Consumption Central parts are carried over.

Two things made a large tenant's refresh slow, or fail outright:

* Fabric and Power Automate + Dataverse read seven tables through GetTable
  and then read each one column by column: four through Normalize, the three
  newer Azure tables through Table.Column. GetTable hands back a table on a
  SQL endpoint - the Lakehouse's, or Dataverse's TDS endpoint - so every
  column read is its own query, and on a large tenant that exhausts the
  connection pool. Each table is now buffered once (BUFFERED_TABLES). The
  other GetTable reads, AzureAiTokens and CoworkTaskInput, take their table
  whole and stay as they are, as AzureAiTokens does in Analytics Hub. Local
  CSV and Viva Direct do not read through GetTable, so TEMPLATES skips this
  part for them.

* Calculated DAX ranked every user against every other user, so refresh
  grew with the square of the user count. In every template:
    - CoworkBilling[UsageCohortRank] re-ranked the whole table for each row
      with RANKX. CoworkBilling's query now loads it instead: it sorts the
      credits once, reads the five cut values and compares each row to them.
    - CoworkBilling[UsageCohort] ran the same ranking again for its label. It
      now reads the bucket from UsageCohortRank.
    - CreditsWeekly[Weeks Ago] drops a CALCULATE that cost a context
      transition per row and changed nothing.
    - Group By's Usage Intensity rows (Studio and GitHub) find each
      percentile cut once with TOPN, instead of RANKX over every user for
      every user.
  The buckets do not change. test_refresh_time_cuts.py replays the old and
  new forms side by side over generated data with ties, blanks, zeros and
  negatives.

Each change lands in DataModelSchema and in the UnappliedChanges copy of the
query, with Desktop's last-loaded copy kept in step so the template opens with
nothing pending. Anything else that moves in either part fails the run, and
every other ZIP member keeps its raw bytes - the report layer is signed by
SecurityBindings. Running it twice changes nothing.

    python docs/scripts/fix_refresh_time_cuts.py --dry-run
    python docs/scripts/fix_refresh_time_cuts.py
    python docs/scripts/fix_refresh_time_cuts.py --check   # exit 1 if a template is stale

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
from fix_viva_query_org import Package, PatchError, require  # noqa: E402,F401 - PatchError is re-exported

REPO = Path(__file__).resolve().parents[2]
SCHEMA = "DataModelSchema"
UNAPPLIED = "UnappliedChanges"
OWNED = "<owned>"

# (template, whether it reads BUFFERED_TABLES through GetTable)
TEMPLATES = (
    (REPO / "1. Local CSV" / "Consumption Central - Local CSV.pbit", False),
    (REPO / "2. Fabric" / "Consumption Central - Fabric.pbit", True),
    (REPO / "3. Viva Direct" / "Consumption Central - Viva Direct.pbit", False),
    (REPO / "archive" / "4. Power Automate + Dataverse"
     / "Consumption Central - Power Automate + Dataverse.pbit", True),
)

# ---------------------------------------------------------------------------
# Buffer the tables read column by column
# ---------------------------------------------------------------------------

BUFFERED_TABLES = {
    "Credit Consumption (Tenant)": "studio_tenant_daily",
    "Credit Consumption (Agent)": "studio_agent",
    "Credit Consumption (User)": "studio_user",
    "AzureAiSpend": "azure_ai_spend",
    "AzureSolutionSpend": "azure_solution_spend",
    "AzureDeploymentHealth": "azure_deployment_health",
    "AzureBillingReconciliation": "azure_billing_reconciliation",
}


def buffered_raw(table):
    return (
        f'    Raw = GetTable("{table}"),',
        f'    Raw = let r = GetTable("{table}") in if r = null then null else Table.Buffer(r),',
    )


# ---------------------------------------------------------------------------
# Calculated columns and tables that ranked every user per user
# ---------------------------------------------------------------------------

COHORT_CUTS = (
    ("50", "0.50"),
    ("75", "0.75"),
    ("90", "0.90"),
    ("95", "0.95"),
    ("99", "0.99"),
)


def cohort_rank(results):
    """The calculated column as it shipped: rank every row against the whole table, then bucket."""
    return "\n".join((
        "VAR Rk = RANKX(ALL('CoworkBilling'), 'CoworkBilling'[MonthlyCreditsUsed],, ASC)",
        "VAR Tot = COUNTROWS(ALL('CoworkBilling'))",
        "VAR P = DIVIDE(Rk, Tot)",
        "RETURN SWITCH(TRUE(),",
    ) + tuple(f"    P <= {cut}, {result}," for (_, cut), result in zip(COHORT_CUTS, results)) + (
        f"    {results[-1]})",
    ))


COHORT_LABELS = ('"1. Light"', '"2. Regular"', '"3. Engaged"', '"4. Native"', '"5. Power"', '"6. Frontier"')
USAGE_COHORT_RANK_OLD = cohort_rank(("1", "2", "3", "4", "5", "6"))
USAGE_COHORT_OLD = cohort_rank(COHORT_LABELS)

COWORK_BILLING = "CoworkBilling"
USAGE_COHORT_RANK = "UsageCohortRank"
COHORT_QUERY_END = "\n".join((
    '\tAddedRecency = Table.AddColumn(AddedDays, "RecencyBucket", each if [DaysSinceActivity] <= 7 then "0-7 days" '
    'else if [DaysSinceActivity] <= 30 then "8-30 days" else if [DaysSinceActivity] <= 60 then "31-60 days" '
    'else "60+ days", type text)',
    "in",
    "\tAddedRecency",
))
COHORT_QUERY_STEPS = "\n".join((
    COHORT_QUERY_END.split("\n")[0] + ",",
    "\t// UsageCohortRank: the cohort (1-6) of each user's ascending credit rank, ties skipped, as a",
    "\t// share of all users, cut at 50/75/90/95/99%. That rank is at most m exactly when the credits",
    "\t// are at most the m-th smallest value, so each cut is read once from the sorted credits",
    "\t// instead of ranking every user against every other user. m is the largest whole number",
    "\t// with m / N <= k, and a blank counts as 0, as it did in RANKX.",
    "\tLoaded = Table.Buffer(AddedRecency),",
    "\tSortedUsed = List.Sort(List.Transform(Loaded[MonthlyCreditsUsed], each if _ = null then 0 else _)),",
    "\tUserCount = List.Count(SortedUsed),",
    "\tCutValue = (k as number) =>",
    "\t\tlet",
    "\t\t\tNear = Number.RoundDown(k * UserCount),",
    "\t\t\tRank = List.Max(List.Select({Near - 2 .. Near + 2}, each _ >= 1 and _ <= UserCount and _ / UserCount <= k))",
    "\t\tin",
    "\t\t\tif Rank = null then null else SortedUsed{Rank - 1},",
    "\tCohortCuts = List.Buffer(List.Transform({"
    + ", ".join(cut for _, cut in COHORT_CUTS) + "}, CutValue)),",
    "\tAddedCohortRank = Table.AddColumn(Loaded, \"UsageCohortRank\", (row) =>",
    "\t\tlet",
    "\t\t\tUsed = if row[MonthlyCreditsUsed] = null then 0 else row[MonthlyCreditsUsed],",
    "\t\t\tCohort = List.PositionOf(List.Transform(CohortCuts, each _ <> null and Used <= _), true)",
    "\t\tin",
    "\t\t\tif Cohort < 0 then 6 else Cohort + 1, Int64.Type)",
    "in",
    "\tAddedCohortRank",
))
COHORT_RANK_QUERY = (COHORT_QUERY_END, COHORT_QUERY_STEPS)

# Same percentile as UsageCohortRank, so read the bucket from it instead of ranking again.
USAGE_COHORT = "\n".join(
    ("SWITCH('CoworkBilling'[UsageCohortRank],",)
    + tuple(f"    {rank}, {label}," for rank, label in enumerate(COHORT_LABELS[:-1], start=1))
    + (f"    {COHORT_LABELS[-1]})",)
)
WEEKS_AGO_OLD = "\n".join((
    "",
    "VAR MaxWk = CALCULATE( MAX('CreditsWeekly'[MetricDate]), ALL('CreditsWeekly') )",
    "RETURN DATEDIFF( 'CreditsWeekly'[MetricDate], MaxWk, DAY ) / 7",
    "",
))
# A calculated column has no filter context, so MAX already sees every row; the CALCULATE
# only added a context transition over the whole row for each of the table's rows.
WEEKS_AGO = "\n".join((
    "",
    "VAR MaxWk = MAX('CreditsWeekly'[MetricDate])",
    "RETURN DATEDIFF( 'CreditsWeekly'[MetricDate], MaxWk, DAY ) / 7",
    "",
))
CONSUMPTION_COLUMNS = {
    ("CoworkBilling", "UsageCohort"): (USAGE_COHORT_OLD, USAGE_COHORT),
    ("CreditsWeekly", "Weeks Ago"): (WEEKS_AGO_OLD, WEEKS_AGO),
}

GROUP_BY = "Group By"
INTENSITY_LABELS = (
    '"1. Light (Bottom 50%)"',
    '"2. Regular (Top 25\u201350%)"',
    '"3. Engaged (Top 10\u201325%)"',
    '"4. Native (Top 5\u201310%)"',
    '"5. Power (Top 1\u20135%)"',
    '"6. Frontier (Top 1%)"',
)


def intensity_rows(product):
    """Replace RANKX inside ADDCOLUMNS over the same table, which re-ranks every user per user."""
    by_user = f"{product}ByUser"
    tail = (
        f'        "Attribute", "Usage Intensity ({product})",',
        '        "Group", SWITCH( TRUE(),',
        '            [@Used] <= 0, "0. Not used",',
    )
    old = (
        f"VAR {product}Rows =",
        "    SELECTCOLUMNS(",
        "        ADDCOLUMNS(",
        f"            {by_user},",
        '            "@P", DIVIDE(',
        f"                RANKX( {by_user}, [@Used], , ASC ),",
        f"                COUNTROWS( {by_user} )",
        "            )",
        "        ),",
    ) + tail + tuple(
        f"            [@P] <= {cut}, {label}," for (_, cut), label in zip(COHORT_CUTS, INTENSITY_LABELS)
    )
    new = (
        "// A user's ascending rank (ties skipped) is at most m exactly when their credits are",
        "// at most the m-th smallest value. So for each cut k, find once the largest m with",
        "// DIVIDE( m, N ) <= k and the m-th smallest value with TOPN, then compare each user",
        "// to it. Same buckets as DIVIDE( RANKX( ... ), N ) <= k, without ranking per user.",
        f"VAR {product}N = COUNTROWS( {by_user} )",
        f"VAR {product}Steps = GENERATESERIES( 1, MAX( {product}N, 1 ) )",
    ) + tuple(
        f"VAR {product}M{name} = MAXX( FILTER( {product}Steps, DIVIDE( [Value], {product}N ) <= {cut} ), [Value] ) + 0"
        for name, cut in COHORT_CUTS
    ) + (
        "// No m fits only when N = 1; the blank cut then fails every user past the <= 0 branch.",
    ) + tuple(
        f"VAR {product}T{name} = IF( {product}M{name} >= 1, "
        f"MAXX( TOPN( {product}M{name}, {by_user}, [@Used], ASC ), [@Used] ) )"
        for name, _ in COHORT_CUTS
    ) + (
        f"VAR {product}Rows =",
        "    SELECTCOLUMNS(",
        f"        {by_user},",
    ) + tail + tuple(
        f"            [@Used] <= {product}T{name}, {label}," for (name, _), label in zip(COHORT_CUTS, INTENSITY_LABELS)
    )
    return "\n".join(old), "\n".join(new)


GROUP_BY_EDITS = (intensity_rows("Studio"), intensity_rows("GitHub"))


def query_edits(buffered):
    """The M edits one template takes, by query: its GetTable reads, if any, then CoworkBilling."""
    edits = {name: (buffered_raw(table),) for name, table in BUFFERED_TABLES.items()} if buffered else {}
    edits[COWORK_BILLING] = (COHORT_RANK_QUERY,)
    return edits


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def joined(value):
    return "\n".join(value) if isinstance(value, list) else value


def lines(text):
    """PBIT JSON keeps single-line text as a string and multi-line text as a line array."""
    parts = text.split("\n")
    return parts if len(parts) > 1 else text


def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def replace_snippets(label, text, edits):
    for old, new in edits:
        if new in text:
            continue
        require(text.count(old) == 1,
                f"{label}: expected the original text once, found it {text.count(old)} times")
        text = text.replace(old, new)
    return text


def one(records, name, label):
    hits = [r for r in records if r.get("name") == name]
    require(len(hits) == 1, f"{label}: expected one {name!r}, found {len(hits)}")
    return hits[0]


def partition_source(model, table_name):
    table = one(model["tables"], table_name, f"{SCHEMA} tables")
    partitions = table.get("partitions", [])
    require(len(partitions) == 1 and partitions[0]["source"].get("type") == "m",
            f"{table_name} is not a single-partition M table")
    return partitions[0]["source"]


def calculated_partition_source(model, table_name):
    table = one(model["tables"], table_name, f"{SCHEMA} tables")
    partitions = table.get("partitions", [])
    require(len(partitions) == 1 and partitions[0]["source"].get("type") == "calculated",
            f"{table_name} is not a single-partition calculated table")
    return partitions[0]["source"]


def sync_last_loaded(query, rewritten):
    """Move Desktop's last-loaded copy of a rewritten query from its old text to its new one.

    Desktop compares it with the query text to decide whether anything is
    pending, so leaving it behind would open the template asking to apply
    changes. A copy that held something else was already stale and is left.
    """
    raw = query.get("lastLoadedAsTableFormulaText")
    if not raw:
        return
    cache = json.loads(raw)
    require(isinstance(cache, dict) and dumps(cache) == raw,
            f"{query['name']}: lastLoadedAsTableFormulaText does not round-trip")
    refs = cache.get("ReferencedQueriesFormulaText", {})
    require(isinstance(refs, dict), f"{query['name']}: unexpected ReferencedQueriesFormulaText")
    touched = False
    if query["name"] in rewritten:
        old, new = rewritten[query["name"]]
        if cache.get("RootFormulaText") == old:
            cache["RootFormulaText"] = new
            touched = True
    for ref, (old, new) in rewritten.items():
        if refs.get(ref) == old:
            refs[ref] = new
            touched = True
    if touched:
        query["lastLoadedAsTableFormulaText"] = dumps(cache)


def check_unbuffered(model, pending):
    """A template TEMPLATES leaves unbuffered must not read BUFFERED_TABLES through GetTable."""
    texts = [(t["name"], joined(p["source"].get("expression", "")))
             for t in model["model"]["tables"] if t["name"] in BUFFERED_TABLES
             for p in t.get("partitions", [])]
    texts += [(q["name"], joined(q["text"])) for q in pending["queries"] if q["name"] in BUFFERED_TABLES]
    for name, text in texts:
        require(f'GetTable("{BUFFERED_TABLES[name]}")' not in text,
                f"{name} reads through GetTable, but TEMPLATES says this template has nothing to buffer")


# ---------------------------------------------------------------------------
# Part edits: each returns the labels it changed
# ---------------------------------------------------------------------------


def edit_queries_model(document, queries):
    changed = []
    for name, edits in queries.items():
        source = partition_source(document["model"], name)
        old = joined(source["expression"])
        new = replace_snippets(name, old, edits)
        if new != old:
            source["expression"] = lines(new)
            changed.append(name)
    return changed


def edit_queries_pending(document, queries):
    changed, rewritten = [], {}
    for name, edits in queries.items():
        query = one(document["queries"], name, f"{UNAPPLIED} queries")
        old = joined(query["text"])
        new = replace_snippets(name, old, edits)
        if new != old:
            query["text"] = new.split("\n") if isinstance(query["text"], list) else new
            rewritten[name] = (old, new)
            changed.append(name)
    if rewritten:
        for query in document["queries"]:
            sync_last_loaded(query, rewritten)
    return changed


def imported_cohort_rank(column):
    """UsageCohortRank as a column CoworkBilling's query loads, keeping its name, tag and format."""
    record = {}
    for key, value in column.items():
        if key in ("type", "expression", "isDataTypeInferred"):
            continue
        if key == "lineageTag":
            record["sourceColumn"] = USAGE_COHORT_RANK
        record[key] = value
    record.setdefault("sourceColumn", USAGE_COHORT_RANK)
    return record


def edit_cohort_rank_column(model):
    table = one(model["tables"], COWORK_BILLING, f"{SCHEMA} tables")
    columns = table.get("columns", [])
    column = one(columns, USAGE_COHORT_RANK, COWORK_BILLING)
    if column.get("type", "data") == "data":
        require(column.get("sourceColumn") == USAGE_COHORT_RANK and "expression" not in column,
                f"{COWORK_BILLING}[{USAGE_COHORT_RANK}] has changed; review it before patching")
        return []
    require(column.get("type") == "calculated" and joined(column["expression"]) == USAGE_COHORT_RANK_OLD,
            f"{COWORK_BILLING}[{USAGE_COHORT_RANK}] has changed; review it before patching")
    require(column.get("dataType") == "int64",
            f"{COWORK_BILLING}[{USAGE_COHORT_RANK}] is not a whole number")
    columns[columns.index(column)] = imported_cohort_rank(column)
    return [f"{COWORK_BILLING}[{USAGE_COHORT_RANK}] loaded by the query"]


def edit_consumption_dax(document):
    changed = []
    model = document["model"]
    changed += edit_cohort_rank_column(model)
    for (table_name, column_name), (old, new) in CONSUMPTION_COLUMNS.items():
        table = one(model["tables"], table_name, f"{SCHEMA} tables")
        column = one(table.get("columns", []), column_name, table_name)
        require(column.get("type") == "calculated", f"{table_name}[{column_name}] is not a calculated column")
        current = joined(column["expression"])
        if current == new:
            continue
        require(current == old, f"{table_name}[{column_name}] has changed; review it before patching")
        column["expression"] = lines(new)
        changed.append(f"{table_name}[{column_name}]")
    source = calculated_partition_source(model, GROUP_BY)
    old = joined(source["expression"])
    new = replace_snippets(GROUP_BY, old, GROUP_BY_EDITS)
    if new != old:
        source["expression"] = lines(new)
        changed.append(GROUP_BY)
    return changed


# ---------------------------------------------------------------------------
# Owned fields: everything outside them must come through untouched
# ---------------------------------------------------------------------------


def owned_mask_model(document, queries):
    result = copy.deepcopy(document)
    model = result["model"]
    for name in queries:
        partition_source(model, name)["expression"] = OWNED
    cowork = one(model["tables"], COWORK_BILLING, "tables")
    cowork["columns"] = [c if c["name"] != USAGE_COHORT_RANK else {"name": c["name"], "owned": True}
                         for c in cowork["columns"]]
    for table_name, column_name in CONSUMPTION_COLUMNS:
        one(one(model["tables"], table_name, "tables")["columns"], column_name, table_name)["expression"] = OWNED
    calculated_partition_source(model, GROUP_BY)["expression"] = OWNED
    return result


def owned_mask_pending(document, queries):
    result = copy.deepcopy(document)
    for query in result["queries"]:
        if query["name"] in queries:
            query["text"] = OWNED
            query.pop("lastLoadedAsTableFormulaText", None)
            continue
        raw = query.get("lastLoadedAsTableFormulaText")
        if not raw:
            continue
        # Another query's cached copy of a rewritten one moves with it, and nothing else may.
        cache = json.loads(raw)
        refs = cache.get("ReferencedQueriesFormulaText") if isinstance(cache, dict) else None
        if isinstance(refs, dict) and set(refs) & set(queries):
            for ref in set(refs) & set(queries):
                refs[ref] = OWNED
            query["lastLoadedAsTableFormulaText"] = dumps(cache)
    return result


# ---------------------------------------------------------------------------
# Archive
# ---------------------------------------------------------------------------


def validate(original, candidate_bytes, updates, model, pending):
    """Only the two model parts may move, they must reparse to the intended documents, and
    every other member keeps its raw ZIP record byte for byte."""
    candidate = Package(candidate_bytes)
    require(list(original.infos) == list(candidate.infos), "candidate changed the ZIP parts or their order")
    require(original.local_order == candidate.local_order, "candidate changed the local order")
    require(original.prefix == candidate.prefix and original.comment == candidate.comment,
            "candidate changed the archive prefix or comment")
    before_end, after_end = bytearray(original.end_record), bytearray(candidate.end_record)
    before_end[12:20] = after_end[12:20]
    require(before_end == after_end, "candidate changed the end-record metadata")
    for name in original.infos:
        before, after = bytearray(original.central[name]), candidate.central[name]
        before[42:46] = after[42:46]
        if name in updates:
            before[16:28] = after[16:28]
            old_header_end, old_payload_end = original.payloads[name]
            new_header_end, new_payload_end = candidate.payloads[name]
            old_header = bytearray(original.locals[name][:old_header_end])
            new_header = candidate.locals[name][:new_header_end]
            old_header[14:26] = new_header[14:26]
            require(old_header == new_header, f"{name}: local header metadata changed")
            require(original.locals[name][old_payload_end:] == candidate.locals[name][new_payload_end:],
                    f"{name}: local trailer changed")
        else:
            require(candidate.locals[name] == original.locals[name], f"{name}: raw ZIP record changed")
        require(before == after, f"{name}: central-directory metadata changed")
        require(candidate.contents[name] == updates.get(name, original.contents[name]),
                f"{name}: candidate content mismatch")
    require(layout_for(candidate.contents[SCHEMA], SCHEMA)[0] == model,
            f"{SCHEMA}: candidate does not match the intended document")
    require(layout_for(candidate.contents[UNAPPLIED], UNAPPLIED)[0] == pending,
            f"{UNAPPLIED}: candidate does not match the intended document")


def build(raw, buffered):
    """Return (bytes, changes) for one template. One with nothing to change comes back as raw."""
    package = Package(raw)
    # layout_for re-encodes each part byte for byte before handing it over, so an edit
    # cannot quietly change the BOM, the indentation or the line endings.
    model, encode_model = layout_for(package.contents[SCHEMA], SCHEMA)
    pending, encode_pending = layout_for(package.contents[UNAPPLIED], UNAPPLIED)
    queries = query_edits(buffered)
    if not buffered:
        check_unbuffered(model, pending)
    for name in queries:
        # Both copies take the same edit, so they only end in step if they start in step.
        require(joined(one(pending["queries"], name, f"{UNAPPLIED} queries")["text"])
                == joined(partition_source(model["model"], name)["expression"]),
                f"{name}: the {UNAPPLIED} copy differs from the model; run fix_query_body_drift.py first")

    changes, updates = [], {}
    before = copy.deepcopy(model)
    edits = edit_queries_model(model, queries) + edit_consumption_dax(model)
    if edits:
        require(owned_mask_model(before, queries) == owned_mask_model(model, queries),
                f"{SCHEMA}: a field outside the refresh-time cuts changed")
        updates[SCHEMA] = encode_model(model)
        changes += [f"{SCHEMA} {edit}" for edit in edits]

    before = copy.deepcopy(pending)
    edits = edit_queries_pending(pending, queries)
    if edits:
        require(owned_mask_pending(before, queries) == owned_mask_pending(pending, queries),
                f"{UNAPPLIED}: a field outside the refresh-time cuts changed")
        updates[UNAPPLIED] = encode_pending(pending)
        changes += [f"{UNAPPLIED} {edit}" for edit in edits]

    if not updates:
        return raw, changes
    candidate = package.rebuild(updates)
    validate(package, candidate, updates, model, pending)
    return candidate, changes


def publish(path, raw, candidate):
    """Write through a scratch file, and only over the bytes the patch was built from."""
    scratch = path.with_name(f".fix-refresh-time-cuts-{uuid.uuid4().hex}.pbit")
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
    mode.add_argument("--check", action="store_true", help="exit 1 if any template still needs a change")
    args = parser.parse_args(argv)

    stale = failed = 0
    for path, buffered in TEMPLATES:
        print(path.parent.name)
        try:
            require(path.is_file(), f"missing template: {path}")
            raw = path.read_bytes()
            candidate, changes = build(raw, buffered)
            if not changes:
                print("  already cut; left byte for byte unchanged")
                continue
            stale += 1
            for change in changes:
                print(f"  {change}")
            if not (args.dry_run or args.check):
                publish(path, raw, candidate)
                print("  validated patch written")
        except (ValueError, KeyError, TypeError, zipfile.BadZipFile) as error:
            print(f"  FAILED: {error}", file=sys.stderr)
            failed += 1
    would = "would be " if args.dry_run or args.check else ""
    print(f"\n{stale} template(s) {would}patched" + (f", {failed} failed" if failed else ""))
    return 1 if failed or (args.check and stale) else 0


if __name__ == "__main__":
    sys.exit(main())
