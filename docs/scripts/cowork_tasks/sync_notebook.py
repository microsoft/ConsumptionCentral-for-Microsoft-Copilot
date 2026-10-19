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


def wrap(cell, condition):
    body = source(cell)
    if not body.startswith(f"if {condition}:\n"):
        set_source(cell, f"if {condition}:\n" + textwrap.indent(body, "    "))


def sync(path=NOTEBOOK):
    book = json.loads(path.read_text(encoding="utf-8"))
    cells = book["cells"]
    helpers = source(cells[2]).split(MARKER)[0].rstrip()
    set_source(cells[2], helpers + "\n\n" + MARKER + "\n" +
               (HERE / "fabric.py").read_text(encoding="utf-8"))
    set_source(cells[4], """# Both export families are optional individually, but an empty landing path is an input error.
landing_files = viva_landing_files(notebookutils.fs, LANDING)
files = [p for p in landing_files if p.rsplit("/", 1)[-1].lower().startswith("personservicecreditsmetrics")]
task_files = [p for p in landing_files if task_key(p.rsplit("/", 1)[-1]).startswith("coworkweeklymetrics")]
policy_files = [p for p in landing_files if p.rsplit("/", 1)[-1].lower().startswith("spendingpolicymetadata")]
if not files and not task_files:
    raise ValueError("No supported consumption or task CSV files found in the configured landing folder.")
raw = None
for path in files:
    frame = spark.read.option("header", True).option("inferSchema", False).csv(path)
    raw = frame if raw is None else raw.unionByName(frame, allowMissingColumns=True)

if raw is not None:
    print(f"read {raw.count():,} consumption rows")
    c_upn = pick(raw, *PERSON_ALIASES["user_principal_name"])
    c_pid = pick(raw, "PersonId")
    c_phid = pick(raw, "PeopleHistoricalId")
    c_entra = pick(raw, "EntraId", "ObjectId", "AadObjectId")
    if not (c_upn or c_pid):
        raise ValueError("Consumption requires UserPrincipalName or PersonId.")
else:
    print("No legacy consumption file supplied; legacy tables are unchanged.")
""")
    wrap(cells[5], "files")
    wrap(cells[6], "files")
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
under `Files/landing/viva/`. The notebook reads the landing tree but skips `_processed`.
Task rows upsert separately into `cowork_tasks_weekly` at person/week/category/type grain.
Historical metadata is joined within each export; conflicting duplicate keys fail.
No task file means existing task history is left unchanged. Empty task exports do not erase history.
Missing optional credits remain null; malformed numbers, dates or populated duplicate keys fail.
Task counts are reported activity, not successful completions. No value assumptions are applied during ingestion.
""")
    path.write_text(json.dumps(book, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


if __name__ == "__main__":
    sync()
