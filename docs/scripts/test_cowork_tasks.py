"""Offline task regression coverage. PowerQueryTests.m additionally requires Desktop refresh."""
import copy
import ast
import csv
import datetime
import importlib.util
import json
from pathlib import Path
import re
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ROOT / "docs" / "scripts" / "cowork_tasks"
sys.path.insert(0, str(SOURCES))
import fabric
import model
import make_reference
import prepare_validation
import prepare_offline_export
import report
import sync_notebook
from fix_pbit_defaults import layout_for, reference_schema, reference_defaults, patch_bodies, patch_query_bodies
from pbit_to_pbip import Failure as ConversionFailure

SPEC = importlib.util.spec_from_file_location("pbit_to_pbip", ROOT / "docs" / "scripts" / "pbit_to_pbip.py")
converter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(converter)
SPEC = importlib.util.spec_from_file_location("dataverse_schema", ROOT / "archive" / "4. Power Automate + Dataverse" / "scripts" / "generate_dataverse_schema.py")
dataverse = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dataverse)


def export_row(**changes):
    return {"PersonId": " EXAMPLE-A ", "MetricDate": "2026-09-06", "TaskCategory": "Analysis & research",
            "TaskType": "Scheduled", "Total credits used": "12.5", "Total Cowork tasks": "2",
            "PeopleHistoricalId": "HISTORY-A", **changes}


def documents(path):
    with zipfile.ZipFile(path) as archive:
        return tuple(json.loads(converter.decode(archive.read(part)))
                     for part in ("DataModelSchema", "UnappliedChanges"))


class TaskIngestionTests(unittest.TestCase):
    def test_native_file_fixtures_are_synthetic_and_do_not_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = prepare_validation.file_fixtures(Path(directory) / "cases")
            self.assertEqual({p.name for p in root.iterdir()}, set(prepare_validation.CASES))
            self.assertFalse(list((root / "legacy-only").rglob("CoworkWeeklyMetrics.csv")))
            self.assertTrue((root / "legacy-only" / "PersonServiceCreditsMetrics.csv").is_file())
            self.assertFalse((root / "task-only" / "PersonServiceCreditsMetrics.csv").exists())
            self.assertEqual((root / "zero-byte" / "tasks" / "CoworkWeeklyMetrics.csv").stat().st_size, 0)
            with (root / "partial" / "tasks" / "CoworkWeeklyMetrics.csv").open(encoding="utf-8") as stream:
                row = fabric.normalise_task(next(csv.DictReader(stream)))
            self.assertEqual(row["task_count"], 2)
            self.assertIsNone(row["credits_used"])
            self.assertFalse((root / "unavailable").exists())
            self.assertIn(model.source("FileInput.m"), prepare_validation.file_assertions(root))
            with self.assertRaises(FileExistsError):
                prepare_validation.file_fixtures(root)

    def test_actual_embedded_helpers_are_synchronized(self):
        book = json.loads(sync_notebook.NOTEBOOK.read_text(encoding="utf-8"))
        embedded = "".join(book["cells"][2]["source"]).split(sync_notebook.MARKER + "\n")[1]
        self.assertEqual(embedded, (SOURCES / "fabric.py").read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "copy.ipynb"
            path.write_bytes(sync_notebook.NOTEBOOK.read_bytes())
            sync_notebook.sync(path)
            self.assertEqual(path.read_bytes(), sync_notebook.NOTEBOOK.read_bytes())

    def test_synthetic_observed_totals_and_bands(self):
        path = ROOT / "1. Local CSV" / "sample-data" / "cowork-tasks" / "CoworkWeeklyMetrics.csv"
        with path.open(encoding="utf-8") as stream:
            rows = [fabric.normalise_task(row) for row in csv.DictReader(stream)]
        self.assertEqual(sum(row["task_count"] for row in rows), 10)
        self.assertAlmostEqual(sum(row["credits_used"] for row in rows), 38)
        self.assertEqual({row["metric_date"].weekday() for row in rows}, {6})
        self.assertEqual(sum(row["task_count"] for row in rows if row["task_category"] not in ("Unknown", "Unclassified")), 7)
        bands = {
            name.lower(): tuple(map(int, values))
            for name, *values in re.findall(r'\{"([^"]+)",\s*(\d+),\s*(\d+),\s*(\d+)\}', model.source("Categories.m"))
        }
        self.assertEqual(len(bands), 8)
        self.assertEqual(bands["analysis & research"], (30, 67, 92))
        for scenario, expected in enumerate((111, 235, 358)):
            minutes = sum(row["task_count"] * bands[row["task_category"].lower()][scenario]
                          for row in rows if row["task_category"].lower() in bands)
            self.assertEqual(minutes, expected)

    def test_required_and_optional_fields(self):
        parsed = fabric.normalise_task(export_row())
        self.assertEqual(parsed["person_id"], "example-a")
        self.assertEqual(parsed["people_historical_id"], "history-a")
        self.assertEqual(parsed["metric_date"], datetime.date(2026, 9, 6))
        partial = fabric.normalise_task({"person_id": "example", "metric_date": "2026-09-06", "task_count": "0"})
        self.assertEqual(partial["task_count"], 0)
        self.assertIsNone(partial["credits_used"])
        self.assertEqual(partial["task_category"], "Not supplied")
        self.assertEqual(partial["task_type"], "Not supplied")
        self.assertEqual(fabric.normalise_task(export_row(PersonId="", UserPrincipalName="A@EXAMPLE.COM"))["person_id"],
                         "a@example.com")

    def test_supplied_malformed_values_fail_without_echoing_rows(self):
        cases = [
            ("PersonId", ""), ("MetricDate", "2026-02-30"), ("MetricDate", "09/06/2026"),
            ("Total Cowork tasks", "-1"), ("Total Cowork tasks", "1.2"), ("Total Cowork tasks", ""),
            ("Total Cowork tasks", "9007199254740992"), ("Total credits used", "-2"),
            ("Total credits used", "NaN"), ("Total credits used", "Infinity"),
            ("Total credits used", "1e999"), ("Total credits used", "invalid-example-value"),
            ("IsCopilotLicensed", "invalid-example-value"),
        ]
        for name, value in cases:
            with self.subTest(name=name, value=value), self.assertRaisesRegex(ValueError, "Cowork tasks:") as raised:
                fabric.normalise_task(export_row(**{name: value}))
            self.assertNotIn("invalid-example-value", str(raised.exception))

    def test_alias_ambiguity_and_canonical_precedence(self):
        row = export_row()
        row.pop("Total Cowork tasks")
        with self.assertRaisesRegex(ValueError, "ambiguous aliases"):
            fabric.normalise_task({**row, "task_count": "2", "task-count": "3"})
        self.assertEqual(fabric.normalise_task({**row, "TaskCount": "2", "task_count": "3"})["task_count"], 2)

    def test_licence_and_historical_metadata(self):
        for value, expected in (("true", True), ("0", False), ("", None)):
            parsed = fabric.normalise_task_metadata({"PeopleHistoricalId": " History-A ", "IsCopilotLicensed": value})
            self.assertEqual(parsed["people_historical_id"], "history-a")
            self.assertIs(parsed["is_copilot_licensed"], expected)

    def test_landing_discovery_skips_archives_and_propagates_access_errors(self):
        fs = Mock()
        def entry(name, folder=False):
            return SimpleNamespace(name=name, path="root/" + name, isDir=folder)
        fs.ls.side_effect = [
            [entry("_processed", True), entry("new", True), entry("old.csv"), entry("notes.txt")],
            [entry("CoworkWeeklyMetrics.csv")],
        ]
        self.assertEqual(fabric.viva_landing_files(fs, "root"), ["root/CoworkWeeklyMetrics.csv", "root/old.csv"])
        fs.ls.side_effect = PermissionError("synthetic access failure")
        with self.assertRaises(PermissionError):
            fabric.viva_landing_files(fs, "root")

    def test_notebook_discovers_only_tasks_recursively(self):
        root = "abfss://synthetic/Files/landing/viva"
        def entry(folder, name, is_dir=False):
            return SimpleNamespace(name=name, path=f"{folder}/{name}", isDir=is_dir)
        listing = {
            "Files/landing/viva": [
                entry(root, "PersonServiceCreditsMetrics.csv"), entry(root, "SpendingPolicyMetadata.csv"),
                entry(root, "old", True), entry(root, "2025-01", True), entry(root, "tasks", True),
                entry(root, "_processed", True), entry(root, ".hidden", True),
            ],
            root + "/old": [entry(root + "/old", "PersonServiceCreditsMetrics.csv"),
                           entry(root + "/old", "SpendingPolicyMetadata.csv")],
            root + "/2025-01": [entry(root + "/2025-01", "SpendingPolicyMetadata.csv")],
            root + "/tasks": [entry(root + "/tasks", "CoworkWeeklyMetrics.csv"),
                             entry(root + "/tasks", "PeopleMetaData.csv")],
        }
        fs = Mock()
        fs.ls.side_effect = listing.__getitem__
        book = json.loads(sync_notebook.NOTEBOOK.read_text(encoding="utf-8"))
        body = ast.parse("".join(book["cells"][4]["source"])).body
        assignments = []
        for node in body:
            if not isinstance(node, ast.Assign):
                break
            assignments.append(node)
        scope = {"notebookutils": SimpleNamespace(fs=fs), "LANDING": "Files/landing/viva",
                 "viva_landing_files": fabric.viva_landing_files, "task_key": fabric.task_key}
        exec(compile(ast.Module(body=assignments, type_ignores=[]), "<notebook discovery>", "exec"), scope)
        self.assertEqual(scope["files"], [root + "/PersonServiceCreditsMetrics.csv"])
        self.assertEqual(scope["policy_files"], [root + "/SpendingPolicyMetadata.csv"])
        self.assertEqual(scope["task_files"], [root + "/tasks/CoworkWeeklyMetrics.csv"])
        self.assertFalse(any("_processed" in str(c) or ".hidden" in str(c) for c in fs.ls.call_args_list))

    def test_non_sunday_dates_remain_supported(self):
        for value in ("2026-09-12", "2026-09-13", "2026-09-14"):
            self.assertEqual(fabric.normalise_task(export_row(MetricDate=value))["metric_date"].isoformat(), value)

    def test_absent_tasks_do_not_touch_spark_or_history(self):
        spark = Mock()
        self.assertEqual(fabric.ingest_tasks(spark, [], [], "cowork_tasks_weekly", Mock(), Mock()), [])
        self.assertEqual(spark.mock_calls, [])

    def test_zero_byte_task_file_has_an_explicit_schema(self):
        spark = Mock()
        spark.read.text.return_value.limit.return_value.count.return_value = 0
        result = fabric.task_read_project(spark, "synthetic-empty.csv", fabric.normalise_task,
                                         fabric.TASK_SCHEMA, Mock())
        spark.createDataFrame.assert_called_once_with([], fabric.TASK_SCHEMA)
        spark.read.option.assert_not_called()
        self.assertIs(result, spark.createDataFrame.return_value)


class ModelContractTests(unittest.TestCase):
    def test_staged_expression_lines_preserve_trailing_newlines(self):
        body = "// synthetic source\nlet\n    Source = 1\nin Source\n"
        for expression in (body, body.split("\n")):
            with self.subTest(expression=expression):
                reference = {"model": {"expressions": [{"name": "Synthetic", "expression": expression}]}}
                queries = {"queries": [{"name": "Synthetic", "text": ["old"]}]}
                self.assertEqual(patch_query_bodies(queries, reference), ["Synthetic"])
                lines = queries["queries"][0]["text"]
                self.assertEqual(lines, body.split("\n"))
                self.assertEqual("\n".join(lines), body)
                self.assertEqual(patch_query_bodies(queries, reference), [])

    def test_offline_sources_are_restored_in_both_model_parts(self):
        for profile, directory, name in (("csv", "1. Local CSV", "Local CSV"),
                                         ("fabric", "2. Fabric", "Fabric"),
                                         ("viva", "3. Viva Direct", "Viva Direct"),
                                         ("dataverse", "archive/4. Power Automate + Dataverse", "Power Automate + Dataverse")):
            with self.subTest(profile=profile), tempfile.TemporaryDirectory() as folder:
                source = ROOT / directory / f"Consumption Central - {name}.pbit"
                project = prepare_offline_export.prepare(source, Path(folder), profile, "x")
                root = project.parent / "x.SemanticModel"
                document = json.loads((root / "model.bim").read_text(encoding="utf-8"))
                queries = json.loads((root / ".pbi" / "unappliedChanges.json").read_text(encoding="utf-8"))
                reference, original_queries = documents(source)
                model.apply(reference["model"], original_queries, profile)
                roots = set(prepare_offline_export.OVERRIDES[profile])
                for expression in document["model"]["expressions"]:
                    if expression["name"] in roots:
                        self.assertIn(prepare_offline_export.MARKER, expression["expression"])
                self.assertTrue(roots <= set(patch_bodies(document, reference)))
                self.assertTrue(roots <= set(patch_query_bodies(queries, reference)))
                self.assertEqual(document, reference)
                self.assertNotIn(prepare_offline_export.MARKER, json.dumps(queries))
                self.assertTrue(all("\n" not in line and "\r" not in line
                                    for q in queries["queries"] for line in q["text"]))
                actual = {q["name"]: model.text(q["text"]) for q in queries["queries"]}
                for expression in reference["model"]["expressions"]:
                    self.assertEqual(actual[expression["name"]], model.text(expression["expression"]))
                self.assertEqual(patch_query_bodies(queries, reference), [])
                with self.assertRaises(ConversionFailure):
                    prepare_offline_export.prepare(source, Path(folder), profile, "x")

    def test_defaults_reference_is_accepted_by_the_actual_export_repair(self):
        source = ROOT / "1. Local CSV" / "Consumption Central - Local CSV.pbit"
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "reference.pbit"
            make_reference.make_reference(source, output, "csv")
            schema = reference_schema(source, output)
            self.assertEqual(reference_defaults(schema)["DataFolder"], r'"C:\Consumption Central\Data"')
            self.assertIn(model.FACT, {t["name"] for t in schema["model"]["tables"]})
            with zipfile.ZipFile(source) as original, zipfile.ZipFile(output) as updated:
                self.assertEqual(original.namelist(), updated.namelist())
                for name in updated.namelist():
                    if name in ("DataModelSchema", "UnappliedChanges"):
                        raw = updated.read(name)
                        value, encode = layout_for(raw, name)
                        self.assertEqual(encode(value), raw)
                    else:
                        self.assertEqual(updated.read(name), original.read(name), name)
            before = output.read_bytes()
            with self.assertRaises(FileExistsError):
                make_reference.make_reference(source, output, "csv")
            self.assertEqual(output.read_bytes(), before)

    def test_folder_enumeration_errors_are_inside_the_try_boundary(self):
        body = model.source("FileInput.m")
        self.assertIn('Listing = if Root = "" then null else Folder.Files(Root)', body)
        self.assertIn("Attempt = try (if Listing = null then null else Table.RowCount(Listing))", body)
        self.assertIn("Files = if Attempt[HasError] then null else Listing", body)
        self.assertIn("SourceUnavailable=Attempt[HasError]", body)
        self.assertNotIn('Root = "C:', body)
        self.assertNotIn("else try Folder.Files(Root)", body)

    def test_native_assertions_are_forced_before_returning_the_table(self):
        result = prepare_validation.checked_assertions('#table({"Case","Passed"}, {{"synthetic",false}})')
        self.assertIn("List.AllTrue(List.Transform(Results[Passed], each _ = true))", result)
        self.assertIn("in if AllPassed then Results else error Error.Record(", result)

    def test_native_unavailable_folder_probe_checks_status_and_empty_data(self):
        body = model.source("FileInputTests.m")
        self.assertIn('Unavailable = Read("unavailable")', body)
        self.assertIn('{name, if passed then true', body)
        self.assertIn('Unavailable[SourceUnavailable] and not Unavailable[Supplied] and Unavailable[Data] = null', body)

    def test_native_compatibility_assertions_use_actual_lookup_and_model_queries(self):
        document, _ = documents(ROOT / "1. Local CSV" / "Consumption Central - Local CSV.pbit")
        body = prepare_validation.compatibility_assertions(document)
        self.assertIn(model.source("LegacyCompanion.m"), body)
        self.assertIn(model.source("FileInput.m"), body)
        for table in model.additions():
            if table["name"] in (model.DATES, model.PERIOD, model.PEOPLE):
                self.assertIn(table["partitions"][0]["source"]["expression"], body)
        self.assertIn('if not HasTasks then GetDataFile(patterns) else Result', model.source("LegacyCompanion.m"))

    def test_preview_types_are_repaired_without_changing_parameter_values(self):
        document, queries = documents(ROOT / "1. Local CSV" / "Consumption Central - Local CSV.pbit")
        expressions = {e["name"]: e for e in document["model"]["expressions"]}
        before = expressions["BillingPeriodWeeks"]["expression"]
        expressions["BillingPeriodWeeks"]["annotations"] = [{"name": "PBI_ResultType", "value": "Exception"}]
        next(q for q in queries["queries"] if q["name"] == "DataFiles")["resultType"] = "Exception"
        model.apply(document["model"], queries, "csv")
        self.assertEqual(expressions["BillingPeriodWeeks"]["expression"], before)
        self.assertEqual(expressions["BillingPeriodWeeks"]["annotations"][0]["value"], "Number")
        self.assertEqual(next(q for q in queries["queries"] if q["name"] == "DataFiles")["resultType"], "Table")

    def test_normalizer_does_not_use_reserved_optional_as_an_identifier(self):
        body = model.source("NormalizeTasks.m")
        self.assertIn("allowMissing as logical", body)
        self.assertNotIn("optional as logical", body)
        self.assertNotIn("if optional then", body)

    def test_variants_preserve_existing_tables_and_filters(self):
        paths = {
            "csv": ROOT / "1. Local CSV" / "Consumption Central - Local CSV.pbit",
            "fabric": ROOT / "2. Fabric" / "Consumption Central - Fabric.pbit",
            "viva": ROOT / "3. Viva Direct" / "Consumption Central - Viva Direct.pbit",
            "dataverse": ROOT / "archive" / "4. Power Automate + Dataverse" / "Consumption Central - Power Automate + Dataverse.pbit",
        }
        for profile, path in paths.items():
            with self.subTest(profile=profile):
                document, unapplied = documents(path)
                baseline = copy.deepcopy(document["model"])
                model.apply(document["model"], unapplied, profile)
                changed = document["model"]
                added = {t["name"] for t in model.additions()}
                self.assertEqual([t for t in changed["tables"] if t["name"] not in added],
                                 [t for t in baseline["tables"] if t["name"] not in added])
                task_relationships = [r for r in changed["relationships"] if r["fromTable"] == model.FACT]
                self.assertEqual(len(task_relationships), 3)
                self.assertTrue(all(r["toTable"].startswith("Cowork Task ") for r in task_relationships))
                self.assertEqual([r for r in changed["relationships"] if r["fromTable"] != model.FACT],
                                 [r for r in baseline["relationships"] if r["fromTable"] != model.FACT])
                queries = {q["name"]: q for q in unapplied["queries"]}
                for name in added:
                    self.assertNotIn("isHidden", queries[name])
                for expr in changed["expressions"]:
                    self.assertEqual(model.text(expr["expression"]), model.text(queries[expr["name"]]["text"]))
                second = copy.deepcopy((document, unapplied))
                model.apply(document["model"], unapplied, profile)
                self.assertEqual(second, (document, unapplied))
                tags, existing_tags = [], []
                for table in changed["tables"]:
                    target = tags if table["name"] in added else existing_tags
                    target.append(table.get("lineageTag"))
                    target.extend(c.get("lineageTag") for c in table.get("columns", []))
                    target.extend(m.get("lineageTag") for m in table.get("measures", []))
                for expr in changed["expressions"]:
                    target = tags if expr["name"].startswith("CoworkTask") or expr["name"] == "GetVivaMetadataFile" else existing_tags
                    target.append(expr.get("lineageTag"))
                tags = [t for t in tags if t]
                self.assertEqual(len(tags), len(set(tags)))
                self.assertFalse(set(tags) & set(existing_tags))

    def test_dataverse_extracts_optional_task_contract_and_natural_key(self):
        document, unapplied = documents(ROOT / "2. Fabric" / "Consumption Central - Fabric.pbit")
        model.apply(document["model"], unapplied, "fabric")
        tables = dataverse.build(dataverse.contract(document))["tables"]
        task = next(t for t in tables if t["sourceTable"] == "cowork_tasks_weekly")
        self.assertEqual(task["keyColumns"], ["PersonId", "MetricDate", "TaskCategory", "TaskType"])
        self.assertEqual({c["canonical"] for c in task["columns"]},
                         {"PersonId", "UserPrincipalName", "MetricDate", "TaskCategory", "TaskType", "CreditsUsed",
                          "TaskCount", "PeopleHistoricalId", "Organization", "FunctionType", "IsCopilotLicensed"})

    def test_hidden_model_table_is_not_a_hidden_multitable_query(self):
        item = model.table("Synthetic hidden table", "#table(type table [Value=number], {{1}})",
                           [("Value", "double")], "Synthetic fixture", True)
        self.assertTrue(item["isHidden"])
        query = model.load_query(item)
        self.assertNotIn("isHidden", query)
        self.assertFalse(query["loadAsTableDisabled"])
        self.assertEqual(query["text"], [item["partitions"][0]["source"]["expression"]])

    def test_blank_cost_and_valuation_contracts(self):
        measures = {m["name"]: m["expression"] for m in model.measures()}
        self.assertIn("COUNT('Cowork Tasks'[CreditsUsed]) = COUNTROWS", measures["Cowork Task Credits"])
        self.assertIn("ISBLANK(_rate)", measures["Cowork Task Monetary Equivalent"])
        self.assertNotIn("COALESCE", measures["Cowork Expert-equivalent Hours"])
        self.assertIn('SELECTEDVALUE(\'Cowork Task Scenario\'[Scenario], "Typical")', measures["Cowork Task Effort Minutes"])
        for message in ("Task categories not supplied", "Task export contains no rows", "No tasks match these filters",
                        "Task folder unavailable; check DataFolder and folder access."):
            self.assertIn(message, measures["Cowork Task Status Message"])


class ConverterTests(unittest.TestCase):
    def test_short_name_and_default_are_supported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pbit = root / "Example.pbit"
            with zipfile.ZipFile(pbit, "w") as archive:
                archive.writestr("DataModelSchema", json.dumps({"model": {}}).encode("utf-16-le"))
                archive.writestr("Report/definition/report.json", "{}")
            short = converter.convert(pbit, root / "short", "x")
            default = converter.convert(pbit, root / "default")
            self.assertTrue((short / "x.pbip").exists())
            self.assertTrue((default / "Example.pbip").exists())
            for bad in (".", "..", r"nested\path", "bad:name"):
                with self.subTest(name=bad), self.assertRaises(converter.Failure):
                    converter.convert(pbit, root / "bad", bad)


class TaskReportTests(unittest.TestCase):
    def test_task_page_moves_after_cost_without_reordering_existing_pages(self):
        template = ROOT / "1. Local CSV" / "Consumption Central - Local CSV.pbit"
        with tempfile.TemporaryDirectory() as directory, zipfile.ZipFile(template) as archive:
            root = Path(directory)
            paths = [
                "pages.json", "exec-overview/page.json",
                "exec-overview/visuals/e1f908be0732c0914e41/visual.json",
                "exec-overview/visuals/shell_header_accent/visual.json",
                "exec-overview/visuals/gd_execoverview_btn/visual.json",
                "dept-chargeback/visuals/bba771b1b975d56897fb/visual.json",
                "guide-cowork/visuals/guidecowor_foot/visual.json",
            ]
            pages = root / "definition" / "pages"
            for relative in paths:
                destination = pages / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(archive.read("Report/definition/pages/" + relative))
            order_path = pages / "pages.json"
            order = json.loads(order_path.read_text(encoding="utf-8"))
            baseline = [name for name in order["pageOrder"] if name != report.PAGE]
            order["pageOrder"] = baseline + [report.PAGE]
            report.write(order_path, order)
            report.apply(root)
            first = {str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*.json")}
            report.apply(root)
            self.assertEqual(first, {str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*.json")})
            actual = json.loads(order_path.read_text(encoding="utf-8"))["pageOrder"]
            self.assertEqual([name for name in actual if name != report.PAGE], baseline)
            self.assertEqual(actual.index(report.PAGE), actual.index("dept-chargeback") + 1)
            page = json.loads((pages / report.PAGE / "page.json").read_text(encoding="utf-8"))
            self.assertEqual(page["displayName"], "2.1. Cowork: Tasks")
            self.assertNotIn("visualInteractions", page)
            visuals = [json.loads(p.read_text(encoding="utf-8"))
                       for p in (pages / report.PAGE / "visuals").glob("*/visual.json")]
            self.assertEqual(len({v["name"] for v in visuals}), len(visuals))
            controls = [v for v in visuals if v["visual"]["visualType"] == "slicer"]
            self.assertEqual(len(controls), 6)
            for control in controls:
                self.assertNotIn("syncGroup", control["visual"])
                self.assertGreaterEqual(control["position"]["height"], 80)
                header = control["visual"]["objects"]["header"][0]["properties"]
                self.assertEqual(header["textSize"], report.literal(9))
                text = header["text"]["expr"]["Literal"]["Value"]
                self.assertEqual(text, text.upper())
            kpis = next(v for v in visuals if v["name"] == "task_kpis")["visual"]["objects"]
            self.assertEqual(kpis["value"][0]["properties"]["fontSize"], report.literal(11))
            self.assertEqual(kpis["label"][0]["properties"]["position"], report.literal("belowValue"))
            self.assertEqual(kpis["accentBar"][0]["properties"]["show"], report.literal(False))
            hourly = next(v for v in visuals if v["name"] == "task_hourly")["visual"]
            self.assertEqual(hourly["objects"]["selection"][0]["properties"]["strictSingleSelect"], report.literal(True))
            self.assertNotIn("general", hourly["objects"])
            self.assertEqual(hourly["query"]["sortDefinition"]["sort"][0]["direction"], "Ascending")
            hourly_table = next(t for t in model.additions() if t["name"] == model.HOURLY)
            self.assertIn("{null} & List.Numbers(0,1001)", hourly_table["partitions"][0]["source"]["expression"])
            footer = json.loads((pages / "guide-cowork" / "visuals" / "guidecowor_foot" / "visual.json").read_text(encoding="utf-8"))
            self.assertIn("Viva Feature Access Management", json.dumps(footer))
            self.assertIn("on the CSV path", json.dumps(footer))

    def test_short_labels_use_display_names_and_missing_values_are_not_zero(self):
        value = report.metric("Reported Cowork Tasks", "Tasks")
        self.assertEqual(value["displayName"], "Tasks")
        self.assertEqual(value["field"]["Measure"]["Property"], "Reported Cowork Tasks")
        card = report.card("example", (0, 0, 300, 80), [value])
        blank = card["visual"]["objects"]["value"][0]["properties"]["showBlankAs"]
        self.assertEqual(blank, report.literal("-"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
