"""Local, standard-library-only tests of the actual Fabric notebook transformations.

Run: python docs\\scripts\\test_fabric_ingestion.py
No Spark session, Fabric calls, files, or notebook outputs are created.
"""
import ast
import copy
import datetime
import importlib.util
import itertools
import json
import re
import subprocess
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch


ROOT = Path(__file__).resolve().parents[2]
NOTEBOOKS = ROOT / "2. Fabric" / "notebooks"
_FIX_SPEC = importlib.util.spec_from_file_location(
    "fix_viva_query_org", ROOT / "docs" / "scripts" / "fix_viva_query_org.py"
)
VIVA_FIX = importlib.util.module_from_spec(_FIX_SPEC)
sys.modules.setdefault("fix_viva_query_org", VIVA_FIX)
_FIX_SPEC.loader.exec_module(VIVA_FIX)


def notebook(name):
    return json.loads((NOTEBOOKS / (name + ".ipynb")).read_text(encoding="utf-8"))


def source(book, index):
    return "".join(book["cells"][index]["source"])


def helpers(book):
    """Execute notebook definitions, not a reimplementation of their logic."""
    nodes = []
    names = {"PERSON_ALIASES", "ORG_COLUMNS"}
    for cell in book["cells"]:
        if cell["cell_type"] != "code":
            continue
        for node in ast.parse("".join(cell["source"])).body:
            if isinstance(node, ast.FunctionDef):
                nodes.append(node)
            elif isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id in names for t in node.targets
            ):
                nodes.append(node)
    scope = {"re": re}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "<notebook helpers>", "exec"), scope)
    return scope


def pbit_replacements(path, in_memory_patched=False):
    package = VIVA_FIX.Package(path.read_bytes())
    schema, _ = VIVA_FIX.decode_part(package.contents["DataModelSchema"], "DataModelSchema")
    unapplied, _ = VIVA_FIX.decode_part(package.contents["UnappliedChanges"], "UnappliedChanges")
    profile = VIVA_FIX.detect_profile(schema)
    VIVA_FIX.activate_profile(profile)
    holders, queries, tables = VIVA_FIX.query_index(schema, unapplied)
    replacements = VIVA_FIX.load_replacements(tables)
    if in_memory_patched:
        before = copy.deepcopy((schema, unapplied))
        VIVA_FIX.patch_documents(schema, unapplied, replacements)
        updates = {
            name: VIVA_FIX.encode_part(after, package.contents[name].startswith(b"\xff\xfe"))
            for name, old, after in zip(VIVA_FIX.PARTS, before, (schema, unapplied))
            if old != after
        }
        VIVA_FIX.validate_candidate(package, package.rebuild(updates), updates, replacements, (schema, unapplied))
        holders, queries, tables = VIVA_FIX.query_index(schema, unapplied)
    return (
        profile,
        {name: VIVA_FIX.source_text(holder["expression"], name) for name, holder in holders.items()},
        {name: VIVA_FIX.source_text(query["text"], name) for name, query in queries.items()},
        replacements,
    )


class Expression:
    def __init__(self, evaluate, name=None):
        self.evaluate = evaluate
        self.name = name

    def alias(self, name):
        return Expression(self.evaluate, name)

    def cast(self, kind):
        def convert(row):
            value = self.evaluate(row)
            if value is None:
                return None
            return {"string": str, "int": int, "long": int, "double": float}[kind](value)
        return Expression(convert, self.name)

    def isNull(self):
        return Expression(lambda row: self.evaluate(row) is None)

    def __gt__(self, value):
        return Expression(lambda row: self.evaluate(row) > value)


class Row(dict):
    def asDict(self):
        return dict(self)


class Functions:
    """Small expression interpreter: executes the unchanged metrics projection."""
    @staticmethod
    def col(name):
        if name.startswith("`"):
            name = name[1:-1].replace("``", "`")
            return Expression(lambda row: row.get(name), name)
        def evaluate(row):
            value = row
            for part in name.split("."):
                value = value.get(part)
            return value
        return Expression(evaluate, name)

    @staticmethod
    def lit(value):
        return Expression(lambda row: value)

    @staticmethod
    def struct(*columns):
        return Expression(lambda row: Row({c.name: c.evaluate(row) for c in columns}))

    @staticmethod
    def udf(function, schema):
        assert all(field.endswith(" string") for field in schema.split(", "))
        return lambda column: Expression(lambda row: function(column.evaluate(row)))

    @staticmethod
    def to_date(column):
        return Expression(lambda row: datetime.date.fromisoformat(column.evaluate(row)))

    @staticmethod
    def current_timestamp():
        return Functions.lit(datetime.datetime(2026, 9, 10))


class Frame:
    def __init__(self, rows, columns=None):
        self.rows = rows
        self.columns = columns or list(dict.fromkeys(k for row in rows for k in row))

    def withColumn(self, name, expression):
        return Frame([{**row, name: expression.evaluate(row)} for row in self.rows])

    def select(self, *expressions):
        return Frame([{e.name: e.evaluate(row) for e in expressions} for row in self.rows])

    def filter(self, expression):
        return Frame([row for row in self.rows if expression.evaluate(row)], self.columns)

    def limit(self, count):
        return Frame(self.rows[:count], self.columns)

    def count(self):
        return len(self.rows)

    @property
    def rdd(self):
        return LocalRDD([Row(row) for row in self.rows])

    def alias(self, _name):
        return self


class LocalRDD:
    def __init__(self, rows):
        self.rows = list(rows)

    def map(self, function):
        return LocalRDD(map(function, self.rows))

    def filter(self, function):
        return LocalRDD(filter(function, self.rows))

    def reduceByKey(self, function):
        values = {}
        for key, value in self.rows:
            values[key] = function(values[key], value) if key in values else value
        return LocalRDD(values.items())


VIVA = notebook("Ingest_Viva_Consumption")
ORG = notebook("Ingest_Org")


class FabricIngestionTests(unittest.TestCase):
    def setUp(self):
        self.viva = helpers(VIVA)
        self.org = helpers(ORG)

    def metrics(self, people):
        base = {
            "ServiceId": "cowork", "ServiceName": "Cowork", "SpendingPolicyId": "policy",
            "MetricDate": "2026-09-07", "Session count": "2", "Spending policy limit": "100",
            "Total Copilot Credits used": "7.5", "User limit": "10",
        }
        raw = Frame([{**base, **person} for person in people])
        scope = {**self.viva, "F": Functions, "raw": raw}
        # Functions close over the namespace returned by helpers().
        self.viva["F"] = Functions
        for variable, aliases in {
            "c_upn": self.viva["PERSON_ALIASES"]["user_principal_name"],
            "c_pid": ["PersonId"], "c_entra": ["EntraId", "ObjectId", "AadObjectId"],
            "c_phid": ["PeopleHistoricalId"],
        }.items():
            scope[variable] = self.viva["pick"](raw, *aliases)
        # Run the actual metrics assignment and blank-identity guard, without report display I/O.
        tree = ast.parse(source(VIVA, 5))
        self.assertIsInstance(tree.body[0], ast.If)
        nodes = tree.body[0].body[:2]
        self.assertIsInstance(nodes[0], ast.Assign)
        self.assertIsInstance(nodes[1], ast.If)
        exec(compile(ast.Module(body=nodes, type_ignores=[]), "<metrics projection>", "exec"), scope)
        return scope["metrics"].rows

    def enrich(self, consumption, manual=()):
        groups = {}
        for records, priority in ((consumption, 0), (manual, 1)):
            for record in records:
                key, values = self.org["org_candidate"](record, priority)
                if key is not None:
                    groups[key] = self.org["merge_attributes"](groups[key], values) if key in groups else values
        columns = ["person_id", "user_principal_name"] + self.org["ORG_COLUMNS"]
        return {key: dict(zip(columns, self.org["org_record"]((key, values))))
                for key, values in groups.items()}

    def test_shared_identity_and_attribute_contract(self):
        self.assertEqual(self.viva["PERSON_ALIASES"], self.org["PERSON_ALIASES"])
        for row in [
            {"UPN": " Alice@Example.Com\t", "PersonId": "HASH-A"},
            {"Email Address": " BOB@EXAMPLE.COM ", "Department": "Sales", "Organisation": "Contoso"},
            {"Person Id": " HASH-C ", "UserPrincipalName": " \t"},
            {"UserPrincipalName": "", "Email": "fallback@example.com"},
            {"person_id": "id-only", "organisation": "A", "department": "B"},
        ]:
            self.assertEqual(self.viva["normalise_person"](row), self.org["normalise_person"](row))

    def test_every_upn_alias_and_blank_fallback(self):
        for alias in self.viva["PERSON_ALIASES"]["user_principal_name"]:
            with self.subTest(alias=alias):
                row = self.viva["normalise_person"]({alias: "\tAlice@EXAMPLE.COM \n", "PersonId": "different"})
                self.assertEqual(row["person_id"], "alice@example.com")
        self.assertEqual(self.org["normalise_person"](
            {"UserPrincipalName": "  ", "Email": " A@B.COM ", "PersonId": "pid"}
        )["person_id"], "a@b.com")

    def test_metrics_actual_projection_retains_org_and_amounts(self):
        facts = self.metrics([
            {"UPN": " Alice@Example.Com ", "PersonId": "other", "Organisation": "Custom Org",
             "Department": "Sales", "Cost Centre": " CC-10 "},
            {"PersonId": " HASH-B ", "Organisation": "Group B", "Department": "Engineering"},
            {"UserPrincipalName": " ", "EmailAddress": " Carol@Example.Com "},
        ])
        self.assertEqual([row["person_id"] for row in facts],
                         ["alice@example.com", "hash-b", "carol@example.com"])
        self.assertEqual(facts[0]["organisation"], "Custom Org")
        self.assertEqual(facts[0]["department"], "Sales")
        self.assertEqual(facts[0]["cost_center"], "CC-10")
        self.assertIsNone(facts[1]["user_principal_name"])
        self.assertEqual(sum(row["credits_used"] for row in facts), 22.5)
        self.assertEqual(facts[0]["metric_date"], datetime.date(2026, 9, 7))
        org = self.enrich(facts)
        self.assertEqual(set(org), {row["person_id"] for row in facts})
        self.assertEqual(org["hash-b"]["user_principal_name"], "hash-b")
        self.assertEqual(org["hash-b"]["organisation"], "Group B")

    def test_invalid_fact_identity_fails_before_merge(self):
        with self.assertRaisesRegex(ValueError, "no populated UPN"):
            self.metrics([{"PersonId": " ", "UserPrincipalName": None}])

    def test_org_never_conflates_organisation_and_department(self):
        row = self.enrich([{"PersonId": "id", "Organisation": "Custom"}])["id"]
        self.assertIsNone(row["department"])
        self.assertEqual(row["organisation"], "Custom")

    def test_sparse_manual_override_preserves_consumption_population(self):
        consumption = [
            {"UPN": "a@b.com", "Department": "Sales", "Organisation": "Custom", "City": "Dublin"},
            {"PersonId": "HASH", "Department": "Engineering"},
        ]
        manual = [
            {"Email": " A@B.COM ", "Department": "Finance", "Organisation": "  ", "City": None},
            {"PersonId": "new", "Organisation": "Manual-only"},
            {"PersonId": "", "Department": "Ignore"},
        ]
        rows = self.enrich(consumption, manual)
        self.assertEqual(set(rows), {"a@b.com", "hash", "new"})
        self.assertEqual(rows["a@b.com"]["department"], "Finance")
        self.assertEqual(rows["a@b.com"]["organisation"], "Custom")
        self.assertEqual(rows["a@b.com"]["city"], "Dublin")

    def test_latest_populated_attribute_not_latest_blank_row(self):
        rows = [
            {"PersonId": "id", "MetricDate": "2026-09-01", "Department": "New", "Organisation": ""},
            {"PersonId": "id", "MetricDate": "2026-08-01", "Department": "Old", "Organisation": "Retain",
             "_loaded_at": "2026-09-10"},
            {"PersonId": "id", "MetricDate": "2026-09-08", "Department": None},
        ]
        result = self.enrich(rows)["id"]
        self.assertEqual(result["department"], "New")
        self.assertEqual(result["organisation"], "Retain")

    def test_duplicate_reduction_is_order_independent_and_idempotent(self):
        rows = [
            {"PersonId": "id", "Department": "A"},
            {"PersonId": "ID", "Department": "B", "Organisation": "C"},
            {"PersonId": " id ", "City": "Dublin"},
        ]
        expected = self.enrich(rows)
        for ordering in itertools.permutations(rows):
            self.assertEqual(self.enrich(ordering), expected)
        self.assertEqual(self.enrich(rows + rows), expected)
        candidates = [self.org["org_candidate"](r, 0)[1] for r in rows]
        reduce = self.org["merge_attributes"]
        self.assertEqual(reduce(reduce(*candidates[:2]), candidates[2]),
                         reduce(candidates[0], reduce(*candidates[1:])))

    def test_manual_priority_is_per_attribute_not_whole_row(self):
        auto = [{"PersonId": "id", "MetricDate": "2026-09-10", "Department": "Latest", "City": "Dublin"}]
        manual = [{"PersonId": "id", "MetricDate": "2020-01-01", "Department": "Override"},
                  {"PersonId": "id", "Department": " ", "Organisation": "Custom"}]
        row = self.enrich(auto, manual)["id"]
        self.assertEqual((row["department"], row["city"], row["organisation"]),
                         ("Override", "Dublin", "Custom"))

    def test_optional_org_folder_does_not_read_or_require_files(self):
        scope = dict(self.org)
        spark = MagicMock()
        spark.catalog.tableExists.return_value = True
        fs = MagicMock()
        fs.exists.return_value = False
        scope.update(spark=spark, notebookutils=SimpleNamespace(fs=fs),
                     LANDING="Files/landing/org", TBL_METRICS="viva_credits_weekly")
        tree = ast.parse(source(ORG, 2))
        start = next(i for i, n in enumerate(tree.body) if isinstance(n, ast.Assign)
                     and any(isinstance(t, ast.Name) and t.id == "sources" for t in n.targets))
        exec(compile(ast.Module(body=tree.body[start:], type_ignores=[]), "<org sources>", "exec"), scope)
        self.assertEqual(scope["sources"], [(spark.table.return_value, 0)])
        fs.ls.assert_not_called()
        spark.read.option.assert_not_called()

    def test_org_read_errors_are_not_silently_swallowed(self):
        scope = dict(self.org)
        fs = MagicMock()
        fs.exists.side_effect = PermissionError("denied")
        spark = MagicMock()
        spark.catalog.tableExists.return_value = False
        scope.update(spark=spark, notebookutils=SimpleNamespace(fs=fs),
                     LANDING="Files/landing/org", TBL_METRICS="viva_credits_weekly")
        code = source(ORG, 2).split("sources = []", 1)[1]
        with self.assertRaises(PermissionError):
            exec("sources = []" + code, scope)

    def test_actual_org_materialisation_with_optional_overrides(self):
        spark = MagicMock()
        spark.catalog.tableExists.return_value = False
        spark.sparkContext.union.side_effect = lambda rdds: LocalRDD(
            row for rdd in rdds for row in rdd.rows)

        def create_frame(data, schema):
            columns = [part.split()[0] for part in schema.split(", ")]
            return Frame([dict(zip(columns, row)) for row in
                          (data.rows if isinstance(data, LocalRDD) else data)], columns)

        spark.createDataFrame.side_effect = create_frame
        writer = MagicMock()
        writer.format.return_value = writer
        saved = []
        def write_frame(frame):
            saved.append(frame.rows)
            return writer

        for sources in (
            [],
            [(Frame([{"PersonId": "id", "Department": "Sales", "Organisation": "Custom"},
                     {"PersonId": "second", "City": "Dublin"}]), 0)],
            [(Frame([{"PersonId": "id", "Department": "Sales", "Organisation": "Custom"},
                     {"PersonId": "second", "City": "Dublin"}]), 0),
             (Frame([{"PersonId": " ID ", "Department": "Finance", "Organisation": ""}]), 1)],
        ):
            scope = {**self.org, "spark": spark, "F": Functions, "sources": sources,
                     "TBL": "org_attributes"}
            with patch.object(Frame, "write", new=property(write_frame), create=True):
                exec(source(ORG, 3), scope)
            expected = self.enrich(
                [r for frame, p in sources if p == 0 for r in frame.rows],
                [r for frame, p in sources if p == 1 for r in frame.rows],
            )
            actual = {r["person_id"]: {k: v for k, v in r.items() if k != "_loaded_at"}
                      for r in saved[-1]}
            self.assertEqual(actual, expected)
        self.assertEqual(writer.saveAsTable.call_count, 3)
        writer.mode.assert_not_called()

    def test_actual_existing_org_merge_preserves_unmatched_people(self):
        spark = MagicMock()
        spark.catalog.tableExists.return_value = True
        columns = ["person_id", "user_principal_name"] + self.org["ORG_COLUMNS"] + ["_loaded_at"]
        target = spark.table.return_value
        target.columns = columns
        target.alias.return_value.groupBy.return_value.count.return_value.filter.return_value.limit.return_value.count.return_value = 0
        spark.createDataFrame.return_value = Frame([], columns)
        delta = MagicMock()
        merge = delta.forName.return_value.alias.return_value.merge.return_value
        scope = {**self.org, "spark": spark, "F": MagicMock(wraps=Functions),
                 "sources": [], "TBL": "org_attributes", "DeltaTable": delta}
        scope["F"].expr = lambda text: text
        exec(source(ORG, 3), scope)
        updates = merge.whenMatchedUpdate.call_args.kwargs["set"]
        self.assertEqual(updates["organisation"], "COALESCE(s.organisation, t.organisation)")
        self.assertEqual(updates["department"], "COALESCE(s.department, t.department)")
        # s is already rebuilt from BOTH current inputs, not just manual rows.
        auto = [{"PersonId": "id", "Department": "Current Viva"}]
        previous = self.enrich(auto, [{"PersonId": "id", "Department": "Manual"}])["id"]
        self.assertEqual(previous["department"], "Manual")
        for manual in ([], [{"PersonId": "id", "Department": " "}]):
            current = self.enrich(auto, manual)["id"]
            merged = current["department"] if current["department"] is not None else previous["department"]
            self.assertEqual(merged, "Current Viva")
        merge.whenMatchedUpdate.return_value.whenNotMatchedInsertAll.return_value.execute.assert_called_once()
        merge.whenNotMatchedBySourceDelete.assert_not_called()
        spark.sql.assert_not_called()

    def test_merge_contracts_are_non_destructive_and_guard_duplicates(self):
        fact_merge = source(VIVA, 6)
        org_merge = source(ORG, 3)
        self.assertIn('["person_id", "service_id", "spending_policy_id", "metric_date"]', fact_merge)
        self.assertIn("colliding normalised keys", fact_merge)
        self.assertIn("colliding normalised keys", org_merge)
        self.assertIn("COALESCE(NULLIF(TRIM(s.", fact_merge)
        self.assertIn("COALESCE(s.", org_merge)
        self.assertIn("ADD COLUMNS", fact_merge)
        self.assertIn("ADD COLUMNS", org_merge)
        for text in (fact_merge, org_merge):
            self.assertNotIn("whenNotMatchedBySourceDelete", text)
            self.assertNotIn("overwrite", text)

    def test_fabric_pbit_queries_match_replacements(self):
        profile, schema_sources, unapplied_sources, replacements = pbit_replacements(
            ROOT / "2. Fabric" / "Consumption Central - Fabric.pbit",
            in_memory_patched=True,
        )
        self.assertEqual(profile, "fabric")
        for name, replacement in replacements.items():
            with self.subTest(query=name):
                self.assertEqual(schema_sources[name], replacement)
                self.assertEqual(unapplied_sources[name], replacement)

    def test_sql_identity_normalisation_covers_python_whitespace(self):
        sql = self.viva["identity_sql"]("t.person_id")
        self.assertEqual(sql, self.org["identity_sql"]("t.person_id"))
        regex = re.search(r"r'(.*?)'", sql).group(1).replace("(?U)", "")
        for space in (" ", "\t", "\n", "\r", "\u00a0", "\u2003", "\x1c"):
            value = space + "ALICE@EXAMPLE.COM" + space
            self.assertEqual(re.sub(regex, "", value).lower(), value.strip().lower())

    def test_notebook_metadata_outputs_and_untargeted_cells_unchanged(self):
        targets = {
            "Ingest_Viva_Consumption": {0, 2, 4, 5, 6, 8, 10, 11},
            "Ingest_Org": {0, 1, 2, 3, 5},
        }
        for name, allowed in targets.items():
            current = notebook(name)
            git_path = "2. Fabric/notebooks/" + name + ".ipynb"
            baseline = json.loads(subprocess.check_output(
                ["git", "show", "HEAD:" + git_path], cwd=ROOT
            ).decode("utf-8"))
            self.assertEqual({k: v for k, v in baseline.items() if k != "cells"},
                             {k: v for k, v in current.items() if k != "cells"})
            self.assertEqual(len(baseline["cells"]), len(current["cells"]))
            for i, (before, after) in enumerate(zip(baseline["cells"], current["cells"])):
                self.assertEqual({k: v for k, v in before.items() if k != "source"},
                                 {k: v for k, v in after.items() if k != "source"})
                if i not in allowed:
                    self.assertEqual(before, after)
                if after["cell_type"] == "code":
                    self.assertEqual(after["outputs"], [])
                    self.assertIsNone(after["execution_count"])
                    compile("".join(after["source"]), name + ":" + str(i), "exec")


if __name__ == "__main__":
    unittest.main(verbosity=2)
