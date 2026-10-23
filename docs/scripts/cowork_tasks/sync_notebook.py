#!/usr/bin/env python3
"""Synchronize the shared task ingestion implementation into the shipped notebook."""
import json
from pathlib import Path
import textwrap

HERE = Path(__file__).resolve().parent
NOTEBOOK = HERE.parents[2] / "2. Fabric" / "notebooks" / "Ingest_Viva_Consumption.ipynb"
MARKER = "# BEGIN COWORK TASK HELPERS"


def source(cell):
    return "".join(cell["source"])


def set_source(cell, value):
    cell["source"] = value.splitlines(keepends=True)


# Earlier notebooks guarded the metrics cells on CSV files alone; the Dataflow table is now a source too.
PREVIOUS_WRAPPERS = ("if files:\n",)


def wrap(cell, condition):
    body = source(cell)
    header = f"if {condition}:\n"
    if body.startswith(header):
        return
    for previous in PREVIOUS_WRAPPERS:
        if body.startswith(previous):
            body = textwrap.dedent(body[len(previous):])
            break
    set_source(cell, header + textwrap.indent(body, "    "))


def sync(path=NOTEBOOK):
    book = json.loads(path.read_text(encoding="utf-8"))
    cells = book["cells"]
    helpers = source(cells[2]).split(MARKER)[0].rstrip()
    set_source(cells[2], helpers + "\n\n" + MARKER + "\n" +
               (HERE / "fabric.py").read_text(encoding="utf-8"))
    set_source(cells[4], """# Consumption comes from CSV exports in LANDING, the Dataflow's staging table, or both. Cowork task
# exports are optional alongside them. A missing landing folder is not an error.
landing_present = notebookutils.fs.exists(LANDING)
landing_files = viva_landing_files(notebookutils.fs, LANDING) if landing_present else []
top_level_files = viva_landing_files(notebookutils.fs, LANDING, recursive=False) if landing_present else []
files = [p for p in top_level_files if p.rsplit("/", 1)[-1].lower().startswith("personservicecreditsmetrics")]
task_files = [p for p in landing_files if task_key(p.rsplit("/", 1)[-1]).startswith("coworkweeklymetrics")]
policy_files = [p for p in top_level_files if p.rsplit("/", 1)[-1].lower().startswith("spendingpolicymetadata")]
csv = None

# Read headers per file: identified and PersonId-only exports can coexist.
for path in files:
    frame = harmonise(spark.read.option("header", True).option("inferSchema", False).csv(path))
    csv = frame if csv is None else csv.unionByName(frame, allowMissingColumns=True)

flow = harmonise(spark.table(DATAFLOW_TABLE)) if spark.catalog.tableExists(DATAFLOW_TABLE) else None
if flow is not None and not flow.limit(1).count():
    flow = None

# For the installer: rows from each source, so a run that loaded nothing isn't reported as loaded.
try:
    import json as _json, os as _os
    _summary = "/lakehouse/default/" + LOAD_SUMMARY
    _os.makedirs(_os.path.dirname(_summary), exist_ok=True)
    with open(_summary, "w") as _fh:
        _fh.write(_json.dumps({"dataflowRows": flow.count() if flow is not None else 0,
                               "csvRows": csv.count() if csv is not None else 0,
                               "taskFiles": len(task_files)}))
except Exception as _err:
    print(f"Could not write {LOAD_SUMMARY}: {_err}")

# The Dataflow re-reads the live query, so for the weeks it covers it is the better copy.
if flow is not None and csv is not None and pick(flow, "MetricDate") and pick(csv, "MetricDate"):
    covered = flow.select(F.to_date(F.col(pick(flow, "MetricDate"))).alias("_week")).distinct()
    csv = csv.join(covered, F.to_date(F.col(pick(csv, "MetricDate"))) == covered["_week"], "left_anti")

raw = None
for part in (flow, csv):
    if part is not None:
        raw = part if raw is None else raw.unionByName(part, allowMissingColumns=True)
if raw is not None and not raw.limit(1).count():
    raw = None

if raw is None and not task_files:
    message = f"No Viva consumption or Cowork task export in {LANDING} or {DATAFLOW_TABLE}, so nothing to load."
    if not ALLOW_EMPTY_LANDING:
        raise ValueError(message)
    notebookutils.notebook.exit(message)

if raw is not None:
    print(f"read {raw.count():,} consumption rows ({'Dataflow' if flow is not None else 'no Dataflow'}, "
          f"{'CSV' if csv is not None else 'no CSV'})")
    c_upn = pick(raw, *PERSON_ALIASES["user_principal_name"])
    c_pid = pick(raw, "PersonId")
    c_phid = pick(raw, "PeopleHistoricalId")
    c_entra = pick(raw, "EntraId", "ObjectId", "AadObjectId")
    if not (c_upn or c_pid):
        raise ValueError("Consumption requires UserPrincipalName or PersonId.")
else:
    print("No Viva consumption supplied; legacy tables are unchanged.")
""")
    wrap(cells[5], "raw is not None")
    wrap(cells[6], "raw is not None")
    policy = source(cells[8])
    if not policy.startswith("if policy_files:"):
        start = policy.index("policy = pol_raw.select(")
        policy = """pol_raw = None
for path in policy_files:
    frame = spark.read.option("header", True).csv(path)
    pol_raw = frame if pol_raw is None else pol_raw.unionByName(frame, allowMissingColumns=True)

""" + policy[start:]
        set_source(cells[8], "if policy_files:\n" + textwrap.indent(policy, "    "))
    check = source(cells[10]).split("\n# Optional task ingestion", 1)[0]
    if not check.startswith("if spark.catalog.tableExists(TBL_METRICS):"):
        check = "if spark.catalog.tableExists(TBL_METRICS):\n" + textwrap.indent(check, "    ")
    set_source(cells[10], check.rstrip() + """

# Optional task ingestion remains separate from legacy credit billing.
task_consumed = ingest_tasks(spark, task_files, landing_files, "cowork_tasks_weekly", F, DeltaTable)
""")
    set_source(cells[11], """if ARCHIVE_AFTER_LOAD:
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d_%H%M%S")
    dest = f"{LANDING}/_processed/{stamp}"
    for path in sorted(set(files + policy_files + task_consumed)):
        relative = path.split(LANDING.rstrip("/") + "/", 1)[-1]
        target = f"{dest}/{relative}"
        notebookutils.fs.mkdirs(target.rsplit("/", 1)[0])
        notebookutils.fs.mv(path, target)
    print("Archived successfully ingested files, retaining their export subfolders.")
else:
    print("ARCHIVE_AFTER_LOAD is False - files left in place.")
    print("Re-running upserts the same natural keys without adding task credits to billing.")
""")
    overview = source(cells[0])
    marker = "\n## Optional Cowork task categories\n"
    overview = overview.split(marker)[0]
    set_source(cells[0], overview.rstrip() + marker + """
`CoworkWeeklyMetrics.csv` can be supplied alone or alongside legacy consumption.
Place each export and its `PeopleMetaData.csv` companion in a separate subfolder
under `Files/landing/viva/`. Only task files and their companions are discovered recursively;
directories starting with `_` or `.` (including `_processed`) are skipped.
Legacy `PersonServiceCreditsMetrics` and `SpendingPolicyMetadata` CSVs are read only from
the landing folder's top level, as before. Retained legacy exports in subfolders are not ingested.
Task rows upsert separately into `cowork_tasks_weekly` at person/week/category/type grain.
Historical metadata is joined within each export; conflicting duplicate keys fail.
No task file means existing task history is left unchanged. Empty task exports do not erase history.
Missing optional credits remain null; malformed numbers, dates or populated duplicate keys fail.
Task counts are reported activity, not successful completions. No value assumptions are applied during ingestion.
""")
    path.write_text(json.dumps(book, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


if __name__ == "__main__":
    sync()
