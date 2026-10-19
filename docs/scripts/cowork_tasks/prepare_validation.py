#!/usr/bin/env python3
"""Prepare a closed Local CSV project for synthetic-only Desktop verification; never export it."""
import argparse
import json
from pathlib import Path
import shutil

import model
from apply import apply


CASES = ("combined", "legacy-only", "task-only", "zero-byte", "header-only", "partial", "malformed")


def file_fixtures(root):
    """Build new, wholly synthetic folders without changing or overwriting any input."""
    root.mkdir(parents=True, exist_ok=False)
    samples = model.HERE.parents[2] / "1. Local CSV" / "sample-data"
    for case in CASES:
        folder = root / case
        folder.mkdir()
        if case != "task-only":
            for source in samples.glob("*.csv"):
                shutil.copy2(source, folder / source.name)
        if case == "legacy-only":
            continue
        tasks = folder / "tasks"
        tasks.mkdir()
        if case in ("combined", "task-only"):
            for source in (samples / "cowork-tasks").glob("*.csv"):
                shutil.copy2(source, tasks / source.name)
        else:
            headers = "PersonId,MetricDate,TaskCount"
            contents = {
                "zero-byte": "",
                "header-only": headers + "\n",
                "partial": headers + "\nsynthetic-a,2026-09-06,2\n",
                "malformed": headers + ",CreditsUsed\nsynthetic-a,2026-09-06,2,invalid-example\n",
            }
            (tasks / "CoworkWeeklyMetrics.csv").write_text(contents[case], encoding="utf-8")
    return root


def file_assertions(root):
    literal = '"' + str(root.resolve()).replace('"', '""') + '"'
    return ("let\nReadFixture = (DataFolder as text) as record =>\n" + model.source("FileInput.m")
            + ",\nFixtureRoot = " + literal + ",\nResult =\n" + model.source("FileInputTests.m")
            + "\nin Result")


def checked_assertions(body):
    return ("let\nResults =\n" + body
            + ",\nAllPassed = List.AllTrue(List.Transform(Results[Passed], each _ = true))"
            + '\nin if AllPassed then Results else error Error.Record('
            + '"CoworkTasks.RegressionFailed", "Every native assertion must be true.", null)')


def compatibility_assertions(document):
    expressions = {e["name"]: model.text(e["expression"]) for e in document["model"]["expressions"]}
    tables = {t["name"]: t["partitions"][0]["source"]["expression"] for t in model.additions()}
    bindings = [
        "ReadLegacy = (DataFiles as table) => let\nGetDataFile = " + expressions["GetDataFile"]
        + ",\nGetVivaMetadataFile = " + model.source("LegacyCompanion.m") + "\nin GetVivaMetadataFile",
        *[name + " = (CoworkTaskData as table) =>\n" + tables[table]
          for name, table in (("ReadPeople", model.PEOPLE), ("ReadDates", model.DATES), ("ReadPeriod", model.PERIOD))],
        'Denied = let DataFolder = "synthetic-denied", Folder.Files = (path as text) => '
        'error Error.Record("DataSource.Error", "Synthetic permission denial", null) in\n'
        + model.source("FileInput.m"),
    ]
    return "let\n" + ",\n".join(bindings) + ",\nResult =\n" + model.source("CompatibilityTests.m") + "\nin Result"


def prepare(project, case="combined", with_file_cases=False):
    if case not in CASES:
        raise ValueError(f"Unknown synthetic validation case: {case}")
    root = project.resolve().parent
    fixtures = file_fixtures(root / "case-data") if with_file_cases or case != "combined" else None
    apply(project, "csv")
    definition = json.loads(project.read_text(encoding="utf-8"))
    report_dir = root / definition["artifacts"][0]["report"]["path"]
    binding = json.loads((report_dir / "definition.pbir").read_text(encoding="utf-8"))
    model_dir = (report_dir / binding["datasetReference"]["byPath"]["path"]).resolve()
    model_path = model_dir / "model.bim"
    query_path = model_dir / ".pbi" / "unappliedChanges.json"
    document = json.loads(model_path.read_text(encoding="utf-8"))
    unapplied = json.loads(query_path.read_text(encoding="utf-8"))
    samples = fixtures / case if fixtures else model.HERE.parents[2] / "1. Local CSV" / "sample-data"
    for expr in document["model"]["expressions"]:
        if expr["name"] == "DataFolder":
            metadata = model.text(expr["expression"]).split(" meta ", 1)[1]
            expr["expression"] = '"' + str(samples).replace('"', '""') + '" meta ' + metadata
            for query in unapplied["queries"]:
                if query["name"] == "DataFolder":
                    query["text"] = [expr["expression"]]
    assertions = "Table.Combine({\n" + model.source("PowerQueryTests.m") + ",\n" + compatibility_assertions(document) + "\n})"
    if fixtures:
        assertions = "Table.Combine({\n" + assertions + ",\n" + file_assertions(fixtures) + "\n})"
    test_table = model.table("Cowork Task Regression", checked_assertions(assertions),
                             [("Case",), ("Passed", "boolean")], "Synthetic regression assertions; do not ship.", True)
    document["model"]["tables"] = [t for t in document["model"]["tables"] if t["name"] != test_table["name"]] + [test_table]
    query = model.load_query(test_table)
    unapplied["queries"] = [q for q in unapplied["queries"] if q["name"] != query["name"]] + [query]
    model_path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    query_path.write_text(json.dumps(unapplied, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Synthetic-only validation project prepared. This project contains test queries and must not be shipped.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", type=Path)
    parser.add_argument("--case", choices=CASES, default="combined")
    parser.add_argument("--with-file-cases", action="store_true",
                        help="Generate synthetic file fixtures and execute adapter assertions on refresh.")
    args = parser.parse_args()
    prepare(args.project, args.case, args.with_file_cases)
