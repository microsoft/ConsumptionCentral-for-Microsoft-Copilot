"""Offline tests that the Azure AI notebook keeps the rows older than its collection window.

They exec the notebook's own definitions and write statements against a small in-memory stand-in for
Spark and Delta, so they need only the standard library.
"""
import ast
from datetime import date, datetime, timedelta
import json
import math
import operator
from pathlib import Path
import re
from types import SimpleNamespace
import unittest
from uuid import UUID


NOTEBOOK = Path(__file__).resolve().parents[2] / "2. Fabric" / "notebooks" / "Ingest_Azure_AI.ipynb"
CODE = ["".join(cell["source"])
        for cell in json.loads(NOTEBOOK.read_text(encoding="utf-8"))["cells"]
        if cell["cell_type"] == "code"]
TREES = [ast.parse(text) for text in CODE]
WRITE_ORDER = ["LAKEHOUSE_SPEND", "LAKEHOUSE_TOKENS", "LAKEHOUSE_PAYG", "LAKEHOUSE_HEALTH",
               "LAKEHOUSE_SOLUTION", "LAKEHOUSE_RECON"]
# The column each table's window is matched on. Monthly tables also name the column that says how
# far into its month a row was read.
DAILY = {"LAKEHOUSE_SPEND": "UsageDate", "LAKEHOUSE_TOKENS": "Date", "LAKEHOUSE_PAYG": "UsageDate",
         "LAKEHOUSE_SOLUTION": "UsageDate"}
MONTHLY = {"LAKEHOUSE_HEALTH": ("MetricDate", "SnapshotDate"),
           "LAKEHOUSE_RECON": ("Period", "PeriodEnd")}
TYPES = {"date": date, "string": str, "double": float}


def top_level(names):
    """The top-level function or assignment defining each name, which must be defined once."""
    found = {}
    for tree in TREES:
        for node in tree.body:
            if isinstance(node, ast.FunctionDef):
                defined = {node.name}
            elif isinstance(node, ast.Assign):
                defined = {target.id for target in node.targets if isinstance(target, ast.Name)}
            else:
                continue
            for name in defined & names:
                found.setdefault(name, []).append(node)
    wrong = sorted(name for name in names if len(found.get(name, [])) != 1)
    if wrong:
        raise AssertionError(f"Notebook definitions changed; update the tests: {wrong}")
    return {name: nodes[0] for name, nodes in found.items()}


DEFINED = top_level({
    "month_end", "history_months", "keep_partial_month", "write_window", "month_cutoff",
    "as_number", "as_day", "is_provisioned", "health_rows", "recon_rows", "HEALTH_HEADERS",
    "RECON_HEADERS", "PAYG_POOL", "PROVISIONED_POOL", "RECON_TOLERANCES", "RETAIL_BATCH",
    "SPEND_SCHEMA", "TOKENS_SCHEMA", "PAYG_SCHEMA", "HEALTH_SCHEMA", "SOLUTION_SCHEMA",
    "RECON_SCHEMA", *WRITE_ORDER})
# Top-level statements that a simulated run executes as written in the notebook.
STEPS = top_level({"start", "spend_frame", "tokens_frame", "payg_frame", "health"})
TABLE = {name: ast.literal_eval(DEFINED[name].value) for name in WRITE_ORDER}
SPEND, HEALTH, SOLUTION, RECON = (TABLE[name] for name in (
    "LAKEHOUSE_SPEND", "LAKEHOUSE_HEALTH", "LAKEHOUSE_SOLUTION", "LAKEHOUSE_RECON"))
DAILY_COLUMNS = [(TABLE[name], column) for name, column in DAILY.items()]


def write_sites():
    """Every table written by a write_window call outside its definition, in notebook order."""
    sites = []
    for tree in TREES:
        for statement in tree.body:
            if isinstance(statement, ast.FunctionDef):
                continue
            for call in ast.walk(statement):
                if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Name)
                        and call.func.id == "write_window"):
                    continue
                frame, table, column, cutoff = call.args
                if isinstance(table, ast.Name) and table.id in TABLE:
                    entries = [(frame, table, column)]
                elif (isinstance(statement, ast.For) and [name.id for name in statement.target.elts]
                      == [frame.id, table.id, column.id]):
                    # Section 3 writes its three tables in a loop over (frame, table, column).
                    entries = [entry.elts for entry in statement.iter.elts]
                else:
                    raise AssertionError(f"Unrecognised write: {ast.unparse(call)}")
                sites.extend(SimpleNamespace(table=written.id, column=ast.literal_eval(matched),
                                             frame=source, cutoff=cutoff, statement=statement)
                             for source, written, matched in entries)
    return sites


def run(statements, namespace):
    exec(compile(ast.Module(body=list(statements), type_ignores=[]), str(NOTEBOOK), "exec"),
         namespace)


def evaluate(node, namespace):
    return eval(compile(ast.Expression(body=node), str(NOTEBOOK), "eval"), namespace)


def parse_schema(schema):
    return [tuple(field.split()) for field in schema.split(",")]


def schema_of(frame):
    """{column: type} for the schema a frame passed to write_window was created with."""
    if isinstance(frame, ast.Name):
        frame = STEPS[frame.id].value
    name = next(keyword.value.id for keyword in frame.keywords if keyword.arg == "schema")
    return dict(parse_schema(ast.literal_eval(DEFINED[name].value)))


def value(row, column):
    """A row's value for a column, matched case-insensitively as Spark does by default."""
    for key, item in row.items():
        if key.lower() == column.lower():
            return item
    raise KeyError(f"no column {column}")


def conform(row, dtypes):
    lowered = {key.lower(): item for key, item in row.items()}
    return {column: lowered.get(column.lower()) for column, _ in dtypes}


class Col:
    """A Spark column: a function of a row, with SQL's three-valued logic for nulls."""

    def __init__(self, compute):
        self.compute = compute

    def __call__(self, row):
        return self.compute(row)

    def isNull(self):
        return Col(lambda row: self(row) is None)

    def compare(self, other, test):
        other = other if isinstance(other, Col) else FUNCTIONS.lit(other)

        def result(row):
            left, right = self(row), other(row)
            if left is None or right is None:
                return None
            if type(left) is not type(right):
                raise TypeError(f"compares {type(left).__name__} with {type(right).__name__}")
            return test(left, right)
        return Col(result)

    def __ge__(self, other):
        return self.compare(other, operator.ge)

    def __eq__(self, other):
        return self.compare(other, operator.eq)

    def __or__(self, other):
        def result(row):
            left, right = self(row), other(row)
            if left is True or right is True:
                return True
            return None if left is None or right is None else False
        return Col(result)

    def __invert__(self):
        return Col(lambda row: None if self(row) is None else not self(row))


FUNCTIONS = SimpleNamespace(col=lambda column: Col(lambda row: value(row, column)),
                            lit=lambda constant: Col(lambda row: constant))


class Frame:
    """A DataFrame of dict rows."""

    def __init__(self, spark, dtypes, rows):
        self.spark, self.dtypes = spark, list(dtypes)
        self.rows = [conform(row, self.dtypes) for row in rows]

    def filter(self, condition):
        return Frame(self.spark, self.dtypes, [row for row in self.rows if condition(row) is True])

    def select(self, *columns):
        kinds = {column.lower(): kind for column, kind in self.dtypes}
        return Frame(self.spark, [(column, kinds[column.lower()]) for column in columns], self.rows)

    def distinct(self):
        unique = []
        for row in self.rows:
            if row not in unique:
                unique.append(row)
        return Frame(self.spark, self.dtypes, unique)

    def collect(self):
        return [tuple(row.values()) for row in self.rows]

    def count(self):
        return len(self.rows)

    @property
    def write(self):
        return Writer(self)


class Writer:
    def __init__(self, frame):
        self.frame, self.settings = frame, {"source": None, "mode": None, "options": {}}

    def format(self, source):
        self.settings["source"] = source
        return self

    def mode(self, mode):
        self.settings["mode"] = mode
        return self

    def option(self, key, setting):
        self.settings["options"][key] = setting
        return self

    def saveAsTable(self, name):
        self.frame.spark.save(name, self.frame, **self.settings)


class FakeSpark:
    """Just enough of a Spark session and Lakehouse catalog for the notebook's writes."""

    def __init__(self):
        self.tables, self.log, self.fail_append = {}, [], set()
        self.catalog = SimpleNamespace(tableExists=lambda name: name in self.tables)

    def createDataFrame(self, rows, schema):
        dtypes = parse_schema(schema)
        for row in rows:
            for column, kind in dtypes:
                item = row.get(column)
                if item is not None and not isinstance(item, TYPES[kind]):
                    raise TypeError(f"field {column}: {kind} can not accept {item!r}")
        return Frame(self, dtypes, rows)

    def table(self, name):
        stored = self.tables[name]
        return Frame(self, stored.dtypes, stored.rows)

    def save(self, name, frame, source, mode, options):
        if source != "delta":
            raise AssertionError(f"{name} written as {source}, not delta")
        if mode is None and not options and name not in self.tables:
            self.tables[name] = Frame(self, frame.dtypes, frame.rows)
            self.log.append(("create", name, frame.count()))
        elif mode == "append" and options == {"mergeSchema": "true"} and name in self.tables:
            if name in self.fail_append:
                raise OSError("simulated append failure")
            stored = self.tables[name]
            kinds = {column.lower(): kind for column, kind in stored.dtypes}
            for column, kind in frame.dtypes:
                if column.lower() not in kinds:
                    kinds[column.lower()] = kind
                    stored.dtypes.append((column, kind))
                elif kinds[column.lower()] != kind:
                    raise AssertionError(f"{name}.{column} appended as {kind}")
            stored.rows = [conform(row, stored.dtypes) for row in stored.rows + frame.rows]
            self.log.append(("append", name, frame.count()))
        else:
            raise AssertionError(f"{name}: unexpected write (mode {mode!r}, options {options})")


class FakeDeltaTable:
    def __init__(self, spark, name):
        self.spark, self.name = spark, name

    @classmethod
    def forName(cls, spark, name):
        if name not in spark.tables:
            raise AssertionError(f"{name} is not a Delta table")
        return cls(spark, name)

    def delete(self, condition):
        stored = self.spark.tables[self.name]
        kept = [row for row in stored.rows if condition(row) is not True]
        self.spark.log.append(("delete", self.name, len(stored.rows) - len(kept)))
        stored.rows = kept


def notebook(spark, **values):
    """A namespace holding the notebook's definitions, with the fakes standing in for Spark."""
    printed = []
    namespace = {"math": math, "re": re, "date": date, "datetime": datetime,
                 "timedelta": timedelta, "UUID": UUID, "spark": spark, "F": FUNCTIONS,
                 "DeltaTable": FakeDeltaTable, "printed": printed,
                 "print": lambda *args: printed.append(" ".join(map(str, args)))}
    run(DEFINED.values(), namespace)
    namespace.update(values)
    return namespace


def unexpected(*args):
    raise AssertionError("not called when no meter has a valid ID")


class WritePaths(unittest.TestCase):
    def test_nothing_overwrites_a_table_or_writes_outside_write_window(self):
        for text in CODE:
            self.assertNotIn("overwrite", text.lower())
            self.assertNotIn("replacewhere", text.lower())
        for tree in TREES:
            for statement in tree.body:
                for node in ast.walk(statement):
                    if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
                        continue
                    if node.func.attr in {"saveAsTable", "save", "insertInto", "forName"}:
                        self.assertIs(statement, DEFINED["write_window"], ast.unparse(node))
                    if node.func.attr == "mode":
                        self.assertEqual([ast.literal_eval(arg) for arg in node.args], ["append"])

    def test_each_table_is_written_once_through_write_window_in_the_same_order(self):
        sites = write_sites()
        self.assertEqual([site.table for site in sites], WRITE_ORDER)
        for site in sites:
            with self.subTest(table=site.table):
                schema = schema_of(site.frame)
                if site.table in DAILY:
                    self.assertEqual(site.column, DAILY[site.table])
                    self.assertEqual(schema[site.column], "date")
                    self.assertIsInstance(site.cutoff, ast.Name)
                    self.assertEqual(site.cutoff.id, "start")
                    continue
                column, end_column = MONTHLY[site.table]
                self.assertEqual(site.column, column)
                self.assertEqual(schema[column], "string" if column == "Period" else "date")
                self.assertEqual(schema[end_column], "date")
                self.assertEqual(site.cutoff.func.id, "month_cutoff")
                self.assertEqual(site.cutoff.args[0].id, site.table)
                self.assertEqual([ast.literal_eval(arg) for arg in site.cutoff.args[1:3]],
                                 [column, end_column])


class Months(unittest.TestCase):
    def setUp(self):
        self.ns = notebook(FakeSpark())
        self.history = self.ns["history_months"]
        self.keep = self.ns["keep_partial_month"]

    def test_window_starting_on_the_first_has_no_partial_month(self):
        self.assertEqual(self.history(date(2026, 3, 1)), (date(2026, 3, 1), None))

    def test_window_starting_mid_month(self):
        self.assertEqual(self.history(date(2026, 5, 17)), (date(2026, 6, 1), date(2026, 5, 31)))
        self.assertEqual(self.history(date(2026, 1, 31)), (date(2026, 2, 1), date(2026, 1, 31)))

    def test_year_boundary(self):
        self.assertEqual(self.history(date(2025, 12, 15)), (date(2026, 1, 1), date(2025, 12, 31)))

    def test_one_day_window(self):
        for end, expected in [(date(2026, 3, 1), (date(2026, 3, 1), date(2026, 2, 28))),
                              (date(2026, 3, 2), (date(2026, 3, 1), None)),
                              (date(2024, 3, 1), (date(2024, 3, 1), date(2024, 2, 29)))]:
            self.assertEqual(self.history(end - timedelta(days=1)), expected)

    def test_default_ninety_days(self):
        start = date(2026, 5, 10) - timedelta(days=90)
        self.assertEqual(start, date(2026, 2, 9))
        self.assertEqual(self.history(start), (date(2026, 3, 1), date(2026, 2, 28)))

    def test_partial_month_read_after_it_ended_stays(self):
        month_end = date(2026, 2, 28)
        self.assertTrue(self.keep(month_end, [month_end]))
        self.assertTrue(self.keep(month_end, (day for day in [month_end, month_end])))

    def test_partial_month_is_replaced_otherwise(self):
        month_end = date(2026, 2, 28)
        for stored in ([], iter(()), [month_end, date(2026, 2, 20)], [None], [month_end, None]):
            self.assertFalse(self.keep(month_end, stored))

    def test_running_month_is_never_kept(self):
        # DAYS=5 on 20 March: the window starts on the 15th, and the stored March rows were read
        # the day before, up to the 18th.
        first_full, m0_end = self.history(date(2026, 3, 20) - timedelta(days=5))
        self.assertEqual((first_full, m0_end), (date(2026, 4, 1), date(2026, 3, 31)))
        self.assertFalse(self.keep(m0_end, [date(2026, 3, 18)]))


class MonthCutoff(unittest.TestCase):
    """The first month each monthly write replaces, from the notebook's own cutoff expressions."""

    def cutoffs(self, start, health=None, recon=None):
        """(health cutoff, reconciliation cutoff); None means the table does not exist yet."""
        spark = FakeSpark()
        ns = notebook(spark, start=start)
        if health is not None:
            spark.tables[HEALTH] = spark.createDataFrame(
                [{"MetricDate": month, "SnapshotDate": read} for month, read in health],
                schema=ns["HEALTH_SCHEMA"])
        if recon is not None:
            spark.tables[RECON] = spark.createDataFrame(
                [{"Period": period, "PeriodEnd": read} for period, read in recon],
                schema=ns["RECON_SCHEMA"])
        sites = {site.table: site for site in write_sites()}
        return tuple(evaluate(sites[name].cutoff, ns)
                     for name in ("LAKEHOUSE_HEALTH", "LAKEHOUSE_RECON"))

    def test_window_starting_on_the_first_replaces_from_that_month(self):
        feb = date(2026, 2, 28)
        self.assertEqual(self.cutoffs(date(2026, 3, 1), [(feb, feb)], [("2026-02", feb)]),
                         (date(2026, 3, 1), "2026-03"))

    def test_first_run_replaces_the_partial_month(self):
        self.assertEqual(self.cutoffs(date(2026, 2, 9)), (date(2026, 2, 1), "2026-02"))

    def test_partial_month_read_after_it_ended_is_kept(self):
        jan, feb = date(2026, 1, 31), date(2026, 2, 28)
        self.assertEqual(self.cutoffs(date(2026, 2, 9), [(jan, jan), (feb, feb)],
                                      [("2026-01", jan), ("2026-02", feb)]),
                         (date(2026, 3, 1), "2026-03"))

    def test_partial_month_read_while_it_ran_is_replaced(self):
        feb, early = date(2026, 2, 28), date(2026, 2, 20)
        self.assertEqual(self.cutoffs(date(2026, 2, 9), [(feb, early)], [("2026-02", early)]),
                         (date(2026, 2, 1), "2026-02"))
        self.assertEqual(self.cutoffs(date(2026, 2, 9), [(feb, feb), (feb, early)],
                                      [("2026-02", feb), ("2026-02", early)]),
                         (date(2026, 2, 1), "2026-02"))

    def test_table_without_partial_month_rows_replaces_it(self):
        jan = date(2026, 1, 31)
        self.assertEqual(self.cutoffs(date(2026, 2, 9), [(jan, jan)], [("2026-01", jan)]),
                         (date(2026, 2, 1), "2026-02"))
        self.assertEqual(self.cutoffs(date(2026, 2, 9), [], []), (date(2026, 2, 1), "2026-02"))

    def test_running_month_is_replaced_every_run(self):
        mar, read = date(2026, 3, 31), date(2026, 3, 18)
        self.assertEqual(self.cutoffs(date(2026, 3, 15), [(mar, read)], [("2026-03", read)]),
                         (date(2026, 3, 1), "2026-03"))

    def test_year_boundary(self):
        dec, early = date(2025, 12, 31), date(2025, 12, 20)
        self.assertEqual(self.cutoffs(date(2025, 12, 15), [(dec, dec)], [("2025-12", dec)]),
                         (date(2026, 1, 1), "2026-01"))
        self.assertEqual(self.cutoffs(date(2025, 12, 15), [(dec, early)], [("2025-12", early)]),
                         (date(2025, 12, 1), "2025-12"))


class WriteWindow(unittest.TestCase):
    start = date(2026, 2, 9)

    def setUp(self):
        self.spark = FakeSpark()
        self.ns = notebook(self.spark)

    def day(self, offset):
        return self.start + timedelta(days=offset)

    def frame(self, offsets, cost=1.0):
        return self.spark.createDataFrame(
            [{"UsageDate": None if offset is None else self.day(offset), "Cost": cost,
              "Currency": "USD"} for offset in offsets], schema=self.ns["SPEND_SCHEMA"])

    def write(self, frame, cutoff=None):
        self.ns["write_window"](frame, SPEND, "UsageDate", cutoff or self.start)

    def stored(self):
        rows = [(value(row, "UsageDate"), value(row, "Cost"))
                for row in self.spark.tables[SPEND].rows]
        return sorted(rows, key=lambda pair: (pair[0] is not None, pair[0] or date.min))

    def test_first_run_creates_the_table_from_the_whole_frame(self):
        self.write(self.frame([-3, 0, 2, None]))
        self.assertEqual(self.spark.log, [("create", SPEND, 4)])
        self.assertEqual(self.stored(), [(None, 1.0), (self.day(-3), 1.0), (self.day(0), 1.0),
                                         (self.day(2), 1.0)])
        self.assertEqual(self.ns["printed"], [f"wrote {SPEND}: 4 rows (new table)"])

    def test_later_run_replaces_the_window_and_null_dates_and_keeps_older_rows(self):
        self.write(self.frame([-3, -1, 0, 2, None]))
        self.spark.log.clear()
        self.ns["printed"].clear()
        self.write(self.frame([0, 1, 2, None], cost=2.0))
        self.assertEqual(self.stored(), [(None, 2.0), (self.day(-3), 1.0), (self.day(-1), 1.0),
                                         (self.day(0), 2.0), (self.day(1), 2.0),
                                         (self.day(2), 2.0)])
        self.assertEqual(self.spark.log, [("delete", SPEND, 3), ("append", SPEND, 4)])
        self.assertEqual(self.ns["printed"],
                         [f"wrote {SPEND}: 4 rows from 2026-02-09 on; kept 2 older rows"])

    def test_empty_result_clears_only_the_window(self):
        self.write(self.frame([-2, -1, 0, 1]))
        self.write(self.frame([]))
        self.assertEqual(self.stored(), [(self.day(-2), 1.0), (self.day(-1), 1.0)])
        self.assertEqual(self.ns["printed"][-1],
                         f"wrote {SPEND}: 0 rows from 2026-02-09 on; kept 2 older rows")

    def test_frame_rows_before_the_cutoff_are_not_written(self):
        self.write(self.frame([0, 1]))
        self.write(self.frame([0, 1, 2], cost=2.0), cutoff=self.day(1))
        self.assertEqual(self.stored(),
                         [(self.day(0), 1.0), (self.day(1), 2.0), (self.day(2), 2.0)])

    def test_type_mismatch_fails_before_anything_is_deleted(self):
        self.write(self.spark.createDataFrame([{"usagedate": self.day(-1), "cost": "1.0"}],
                                              schema="usagedate date, cost string"))
        self.spark.log.clear()
        with self.assertRaises(RuntimeError) as raised:
            self.write(self.frame([0]))
        for text in (f"{SPEND}.Cost is string in the Lakehouse but double here",
                     "nothing was deleted", f"drop {SPEND}"):
            self.assertIn(text, str(raised.exception))
        self.assertEqual(self.spark.log, [])
        self.assertEqual(self.stored(), [(self.day(-1), "1.0")])

    def test_columns_match_case_insensitively_and_new_columns_are_added(self):
        self.write(self.spark.createDataFrame(
            [{"usagedate": self.day(-1), "cost": 1.0}, {"usagedate": self.day(0), "cost": 1.0}],
            schema="usagedate date, cost double"))
        self.write(self.frame([0, 1], cost=2.0))
        dtypes = self.spark.tables[SPEND].dtypes
        self.assertEqual(dtypes[:2], [("usagedate", "date"), ("cost", "double")])
        self.assertIn(("Currency", "string"), dtypes)
        self.assertEqual(self.stored(),
                         [(self.day(-1), 1.0), (self.day(0), 2.0), (self.day(1), 2.0)])

    def test_failed_append_leaves_the_window_empty_and_older_rows_untouched(self):
        self.write(self.frame([-1, 0, 1]))
        self.spark.fail_append.add(SPEND)
        with self.assertRaises(RuntimeError) as raised:
            self.write(self.frame([0, 1, 2], cost=2.0))
        message = str(raised.exception)
        self.assertIn("rows from 2026-02-09 on were deleted but the append failed", message)
        self.assertIn("older rows are untouched", message)
        self.assertIsInstance(raised.exception.__cause__, OSError)
        self.assertEqual(self.stored(), [(self.day(-1), 1.0)])


INVENTORY = [{"ResourceId": "rid", "DeploymentName": "chat", "Application": "",
              "ModelName": "model", "ModelVersion": "1", "SkuName": "GlobalStandard",
              "Region": "region", "PtuCapacity": None}]


class Reloads(unittest.TestCase):
    """Runs the notebook's own write statements once per simulated run, reading one unit a day."""

    def setUp(self):
        self.spark, self.notes = FakeSpark(), []
        self.ns = notebook(
            self.spark, note=self.notes.append, flush=lambda found: found.clear(), found=[],
            accounts=[{"id": "/subscriptions/sub/accounts/acct", "name": "acct"}],
            inventory=INVENTORY, SUBSCRIPTION_ID="sub", subscription_name="Subscription", res=[],
            tags={}, service_filter={}, solution_filter={},
            monitor_usage=lambda points, accounts: {}, retail_prices=unexpected,
            retail_price_map=unexpected)
        sites = {site.table: site for site in write_sites()}
        self.steps = [STEPS["spend_frame"], STEPS["tokens_frame"], STEPS["payg_frame"],
                      sites["LAKEHOUSE_SPEND"].statement, STEPS["health"],
                      sites["LAKEHOUSE_HEALTH"].statement, sites["LAKEHOUSE_SOLUTION"].statement,
                      sites["LAKEHOUSE_RECON"].statement]

    def run_on(self, end, days, sources_fail=False):
        self.ns.update(end=end, DAYS=days)
        run([STEPS["start"]], self.ns)
        start = self.ns["start"]
        window = [start + timedelta(days=offset) for offset in range((end - start).days)]
        costs = [{"UsageDate": int(f"{day:%Y%m%d}"), "Cost": 1.0, "Currency": "USD",
                  "ServiceName": "Foundry Models", "ResourceGuid": "meter", "UsageQuantity": 1.0}
                 for day in window]

        def cost_detail(cost_type, grouping, cost_filter):
            if sources_fail:
                raise OSError("simulated Cost Management failure")
            return costs

        self.ns.update(
            recs=[{"UsageDate": day, "ServiceName": "Foundry Models", "Cost": 1.0,
                   "Currency": "USD"} for day in window],
            payg_recs=[{"UsageDate": day, "Cost": 1.0, "Currency": "USD"} for day in window],
            points=[{"Date": day, "Deployment": "chat", "Metric": "TotalTokens", "Value": 1.0}
                    for day in window],
            health_acc={("rid", "chat", day): {"requests": 1.0, "name": "chat"} for day in window},
            inventory_failures=len(self.ns["accounts"]) if sources_fail else 0,
            cost_detail=cost_detail,
            solution_rows=lambda *args: [{"UsageDate": day, "ActualCost": 1.0, "Currency": "USD"}
                                         for day in window])
        run(self.steps, self.ns)

    def rows(self, table):
        return [dict(row) for row in self.spark.tables[table].rows]

    def days(self, table, column):
        found = [row[column] for row in self.rows(table)]
        self.assertEqual(len(found), len(set(found)), f"{table} has a day twice")
        return sorted(found)

    def health(self):
        """{MetricDate: (SnapshotDate, Requests)}, with one row per month."""
        rows = self.rows(HEALTH)
        self.assertEqual(len(rows), len({row["MetricDate"] for row in rows}))
        return {row["MetricDate"]: (row["SnapshotDate"], row["Requests"]) for row in rows}

    def recon(self):
        """{Period: (PeriodStart, PeriodEnd, AzureActual)}, with one estimate and actual each."""
        rows = self.rows(RECON)
        periods = sorted({row["Period"] for row in rows})
        self.assertEqual(sorted((row["Period"], row["Representation"]) for row in rows),
                         [(period, kind) for period in periods
                          for kind in ("AzureActual", "UsageEstimate")])
        return {row["Period"]: (row["PeriodStart"], row["PeriodEnd"], row["Amount"])
                for row in rows if row["Representation"] == "AzureActual"}

    def test_daily_runs_keep_every_day_and_count_each_month_once(self):
        end = date(2026, 4, 10)  # The first run reads from 10 January.
        while end <= date(2026, 7, 1):
            self.run_on(end, 90)
            end += timedelta(days=1)
        self.assertEqual(self.notes, [])
        first = date(2026, 1, 10)
        every_day = [first + timedelta(days=offset) for offset in range(172)]
        self.assertEqual(every_day[-1], date(2026, 6, 30))
        for table, column in DAILY_COLUMNS:
            self.assertEqual(self.days(table, column), every_day)
        # January keeps the 22 days the first run read. Every later month was read in full once
        # and then kept, so no month gains rows twice or shrinks to a part of itself.
        months = {date(2026, 1, 31): 22.0, date(2026, 2, 28): 28.0, date(2026, 3, 31): 31.0,
                  date(2026, 4, 30): 30.0, date(2026, 5, 31): 31.0, date(2026, 6, 30): 30.0}
        self.assertEqual(self.health(), {month: (month, total) for month, total in months.items()})
        self.assertEqual(self.recon(),
                         {f"{month:%Y-%m}": (max(month.replace(day=1), first), month, total)
                          for month, total in months.items()})

    def test_lowering_days_keeps_the_rows_beyond_the_new_window(self):
        self.run_on(date(2026, 6, 30), 90)
        self.run_on(date(2026, 7, 1), 90)
        before = {table: self.rows(table) for table in self.spark.tables}
        self.run_on(date(2026, 7, 2), 5)  # Reads from 27 June.
        self.assertEqual(self.notes, [])
        start = date(2026, 6, 27)
        for table, column in DAILY_COLUMNS:
            kept = [row for row in before[table] if row[column] < start]
            self.assertEqual(len(kept), (start - date(2026, 4, 1)).days)
            self.assertEqual([row for row in self.rows(table) if row[column] < start], kept)
            self.assertEqual(self.days(table, column)[-5:],
                             [start + timedelta(days=offset) for offset in range(5)])
        # June was read in full before, so its rows stay rather than shrinking to the days read now.
        self.assertEqual([row for row in self.rows(HEALTH) if row["MetricDate"] < date(2026, 7, 1)],
                         [row for row in before[HEALTH] if row["MetricDate"] < date(2026, 7, 1)])
        self.assertEqual([row for row in self.rows(RECON) if row["Period"] < "2026-07"],
                         [row for row in before[RECON] if row["Period"] < "2026-07"])
        self.assertEqual(self.health()[date(2026, 6, 30)], (date(2026, 6, 30), 30.0))
        self.assertEqual(self.health()[date(2026, 7, 31)], (date(2026, 7, 1), 1.0))
        self.assertEqual(self.recon()["2026-07"], (date(2026, 7, 1), date(2026, 7, 1), 1.0))

    def test_short_window_replaces_the_running_month_rather_than_freezing_it(self):
        self.run_on(date(2026, 7, 1), 90)
        self.run_on(date(2026, 7, 2), 5)
        self.run_on(date(2026, 7, 3), 5)
        self.assertEqual(self.health()[date(2026, 7, 31)], (date(2026, 7, 2), 2.0))
        self.assertEqual(self.recon()["2026-07"], (date(2026, 7, 1), date(2026, 7, 2), 2.0))
        # The window now starts in July, whose stored rows were read while it ran, so this run's
        # read replaces them. A DAYS this short cannot read a whole month.
        self.run_on(date(2026, 7, 8), 5)
        self.assertEqual(self.notes, [])
        self.assertEqual(self.health()[date(2026, 7, 31)], (date(2026, 7, 7), 5.0))
        self.assertEqual(self.recon()["2026-07"], (date(2026, 7, 3), date(2026, 7, 7), 5.0))
        self.assertEqual(self.recon()["2026-06"], (date(2026, 6, 1), date(2026, 6, 30), 30.0))

    def test_failed_sources_leave_their_tables_unchanged(self):
        self.run_on(date(2026, 7, 1), 90)
        before = {table: self.rows(table) for table in (HEALTH, SOLUTION, RECON)}
        self.run_on(date(2026, 7, 2), 90, sources_fail=True)
        for table, rows in before.items():
            self.assertEqual(self.rows(table), rows)
        self.assertEqual(len(self.notes), 3)
        for note in self.notes:
            self.assertIn("left unchanged", note)

    def test_failed_append_empties_only_the_window_until_the_next_run(self):
        self.run_on(date(2026, 6, 30), 90)  # Reads all of April.
        self.spark.fail_append.add(RECON)
        self.run_on(date(2026, 7, 1), 90)  # April stays; May on is deleted, then the append fails.
        self.assertEqual(sorted(self.recon()), ["2026-04"])
        self.assertEqual(len(self.notes), 1)
        self.assertIn("deleted but the append failed", self.notes[0])
        self.spark.fail_append.clear()
        self.run_on(date(2026, 7, 2), 90)
        self.assertEqual(self.recon(), {
            "2026-04": (date(2026, 4, 1), date(2026, 4, 30), 30.0),
            "2026-05": (date(2026, 5, 1), date(2026, 5, 31), 31.0),
            "2026-06": (date(2026, 6, 1), date(2026, 6, 30), 30.0),
            "2026-07": (date(2026, 7, 1), date(2026, 7, 1), 1.0)})


if __name__ == "__main__":
    unittest.main()
