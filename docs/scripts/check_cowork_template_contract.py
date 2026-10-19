"""Check the task feature is in all shipped artifacts, not only editable source files."""
import json
from pathlib import Path
import sys
import zipfile

from pbit_to_pbip import decode

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent / "cowork_tasks"))
import model
import report

TEMPLATES = [
    ROOT / directory / f"Consumption Central - {name}.pbit"
    for directory, name in (
        ("1. Local CSV", "Local CSV"), ("2. Fabric", "Fabric"), ("3. Viva Direct", "Viva Direct"),
        ("4. Power Automate + Dataverse", "Power Automate + Dataverse"))
]


def check(path):
    errors = []
    with zipfile.ZipFile(path) as archive:
        document = json.loads(decode(archive.read("DataModelSchema")))["model"]
        tables = {t["name"]: t for t in document["tables"]}
        queries = {q["name"]: q for q in json.loads(decode(archive.read("UnappliedChanges")))["queries"]}
        expressions = {e["name"]: e for e in document["expressions"]}
        for name, query in queries.items():
            lines = query.get("text")
            if not isinstance(lines, list) or not lines or any(
                    not isinstance(line, str) or "\n" in line or "\r" in line for line in lines):
                errors.append(f"Staged query must contain individual source lines: {name}")
        if "CC_OFFLINE_EXPORT_ONLY" in json.dumps((document, queries)):
            errors.append("Offline export sources must be restored before shipping.")
        for name, connector in (("FabricSource", "Sql.Database("), ("DataverseSource", "Sql.Database("),
                                ("VivaConnectorSource", "VivaInsights.Data("), ("VivaOrgSource", "VivaInsights.Data(")):
            if name not in expressions:
                continue
            body = model.text(expressions[name]["expression"]).strip()
            if connector not in body:
                errors.append(f"Real connector source is missing: {name}")
            if name not in queries or body != model.text(queries[name]["text"]).strip():
                errors.append(f"Connector model/unapplied query differs: {name}")
        for expected in model.additions():
            name = expected["name"]
            if name not in tables or name not in queries:
                errors.append(f"Missing loaded task table/query: {name}")
                continue
            expression = model.text(tables[name]["partitions"][0]["source"]["expression"]).strip()
            if expression != model.text(queries[name]["text"]).strip():
                errors.append(f"Task table/unapplied query differs: {name}")
            if queries[name].get("isHidden"):
                errors.append(f"Task query must not be marked as a managed multi-table source: {name}")
        for name, filename in (("CoworkTaskNormalize", "NormalizeTasks.m"),):
            if name not in expressions or model.text(expressions[name]["expression"]).strip() != model.source(filename):
                errors.append(f"Task source does not match editable definition: {name}")
        actual_measures = {m["name"]: m for m in tables.get(model.FACT, {}).get("measures", [])}
        for expected in model.measures():
            actual = actual_measures.get(expected["name"])
            if actual is None or model.text(actual["expression"]).strip() != expected["expression"].strip():
                errors.append(f"Task measure differs/missing: {expected['name']}")
        if any("Cowork Task Regression" in name for name in set(tables) | set(queries)):
            errors.append("Synthetic validation tables and their auto-generated error queries must not ship.")
        relationships = [r for r in document["relationships"] if r["fromTable"] == model.FACT]
        if len(relationships) != 3 or any(r["toTable"] not in (model.CATEGORY, model.DATES, model.PEOPLE) for r in relationships):
            errors.append("Task fact relationships are missing or escape the task-scoped dimensions.")
        page_root = f"Report/definition/pages/{report.PAGE}/"
        page_name = page_root + "page.json"
        if page_name not in archive.namelist():
            errors.append("Missing Cowork task report page.")
        else:
            page = json.loads(archive.read(page_name))
            if (page["width"], page["height"]) != (1280, 720):
                errors.append("Task page canvas differs from the report shell.")
            order = json.loads(archive.read("Report/definition/pages/pages.json"))["pageOrder"]
            if order.index(report.PAGE) != order.index(report.AFTER_PAGE) + 1:
                errors.append("Task page must follow Cowork Cost.")
            if page["displayName"] != report.DISPLAY_NAME:
                errors.append("Task page numbering must match its position after Cowork Cost.")
            for name in archive.namelist():
                if name.startswith(page_root) and name.endswith("/visual.json"):
                    visual = json.loads(archive.read(name))["visual"]
                    if visual.get("syncGroup"):
                        errors.append("Task page must not reuse legacy slicer sync groups.")
                    for entry in visual.get("objects", {}).get("value", []):
                        blank = entry.get("properties", {}).get("showBlankAs", {}).get("expr", {}).get("Literal", {}).get("Value")
                        if blank in ("'0'", "0D", "0L"):
                            errors.append("Task cards must not render missing data as zero.")
            hourly = json.loads(archive.read(page_root + "visuals/task_hourly/visual.json"))["visual"]
            if "filter" in json.dumps(hourly.get("objects", {}).get("general", [])):
                errors.append("Hourly value must have no initial selection.")
            scenario = json.loads(archive.read(page_root + "visuals/task_scenario/visual.json"))["visual"]
            if "'Typical'" not in json.dumps(scenario.get("objects", {}).get("general", [])):
                errors.append("Effort scenario must initially select Typical.")
        if any(name == "DataModel" or name.startswith("DataModel/") for name in archive.namelist()):
            errors.append("Template contains cached model data.")
    return errors


if __name__ == "__main__":
    failed = False
    for template in TEMPLATES:
        problems = check(template)
        print(f"{template.name}: {'FAIL' if problems else 'OK'}")
        for problem in problems:
            print("  " + problem)
        failed |= bool(problems)
    sys.exit(1 if failed else 0)
