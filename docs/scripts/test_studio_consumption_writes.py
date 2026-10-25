"""Offline tests that Ingest_Studio_Consumption replaces its restatement window in one Delta commit.

The write cell's consumption part runs against the in-memory Spark and Delta of test_studio_notebook_writes.py,
which applies replaceWhere's rules and fails loudly on anything it doesn't model, so the tests need only the
standard library. The cells before it call the licensing API, so a made-up source stands in for the rows they
collect. OLD is the cell at 99f68c3, rebuilt from the current one by swapping the window write back to its
delete, then append. OLD is the oracle: every successful run must leave the table exactly as OLD leaves it. The
failure tests check that a write that fails leaves the table as it was, and what the next runs restore.
"""
import ast
import builtins
from collections import Counter
from datetime import date, datetime, time, timedelta
import functools
import linecache
import subprocess
import traceback
from types import SimpleNamespace
import unittest

import test_studio_notebook_writes as fake

NOTEBOOK_PATH = "2. Fabric/notebooks/Ingest_Studio_Consumption.ipynb"
ORACLE_COMMIT = "99f68c3"
LOADED = fake.LOADED


# The fake Spark, with what this cell needs and Ingest_Studio's don't -----------------------------------

TYPES = fake.module("pyspark.sql.types", StructType=fake.StructType, StructField=fake.StructField,
                    StringType=lambda: fake.STRING, DoubleType=lambda: fake.DOUBLE, DateType=lambda: fake.DATE,
                    TimestampType=lambda: fake.TIMESTAMP)


def fake_import(name, globals=None, locals=None, fromlist=(), level=0):
    if level == 0 and name == "pyspark.sql.types" and fromlist:
        return TYPES
    return fake.fake_import(name, globals, locals, fromlist, level)


BUILTINS = dict(vars(builtins), __import__=fake_import)


def head(self, n=None):
    """PySpark's head(): the first row or None, or a list of the first n rows."""
    rows = self.limit(1 if n is None else n).collect()
    return (rows[0] if rows else None) if n is None else rows


if not hasattr(fake.Frame, "head"):
    fake.Frame.head = head


class Spark(fake.FakeSpark):
    """The fake Spark, also taking the StructType schema and dict rows the write cell gives createDataFrame."""

    def createDataFrame(self, data, schema=None):
        if not isinstance(schema, fake.StructType):
            return super().createDataFrame(data, schema)
        fields = [fake.Field(f.name, f.dataType) for f in schema]
        rows = []
        for record in data:
            if not isinstance(record, dict):
                raise fake.not_modelled("createDataFrame() of rows that aren't dicts")
            # PySpark reads a dict by the schema's names: a missing key is NULL and an extra one is ignored.
            row = tuple(record.get(f.name) for f in fields)
            if not all(fake.fits(v, f.dtype) for v, f in zip(row, fields)):
                raise TypeError(f"createDataFrame(): {record!r} doesn't fit the schema")
            rows.append(row)
        return fake.Frame(self, fields, rows)


# The notebook, and the oracle --------------------------------------------------------------------------

NOTEBOOK_TEXT = (fake.REPO / NOTEBOOK_PATH).read_text(encoding="utf-8")
NEW_CELLS = fake.notebook_cells(NOTEBOOK_TEXT)
SETTINGS_CELL = fake.find(NEW_CELLS, 'TBL_CONSUMPTION = "studio_consumption_daily"')
WINDOW_CELL = fake.find(NEW_CELLS, "START = END - timedelta(days=DAYS - 1)")
COLLECT_CELL = fake.find(NEW_CELLS, "def collect_day(day):")
WRITE_CELL = fake.find(NEW_CELLS, "CONSUMPTION_SCHEMA = StructType([")

# The window write as it was at 99f68c3, between these two lines: a delete, then an append.
AFTER = '    print(f"{TBL_CONSUMPTION}: created with {consumption.count():,} rows")\nelse:\n'
BEFORE = "\n    # Merge everything older"
OLD_WINDOW = ('    target = DeltaTable.forName(spark, TBL_CONSUMPTION)\n'
              '\n'
              '    # Replace the restatement window wholesale.\n'
              '    target.delete(F.col("usage_date") >= F.lit(restate_from))\n'
              '    (consumption.filter(F.col("usage_date") >= F.lit(restate_from))\n'
              '     .write.format("delta").mode("append").saveAsTable(TBL_CONSUMPTION))\n')
OLD_CELLS = list(NEW_CELLS)
OLD_CELLS[WRITE_CELL] = fake.swap(NEW_CELLS[WRITE_CELL], AFTER, BEFORE, OLD_WINDOW)


def assigned(source, name):
    """The expression a cell assigns to name at its top level."""
    hits = [node.value for node in ast.parse(source).body
            if isinstance(node, ast.Assign) and [getattr(t, "id", None) for t in node.targets] == [name]]
    if len(hits) != 1:
        raise AssertionError(f"{name} is assigned {len(hits)} times, not once")
    return hits[0]


def consumption_part(source):
    """The write cell up to the end of its write of the consumption table. The capacity snapshot and the
    environment list after it are unchanged, and written from collection steps the tests don't model."""
    hits = [node for node in ast.parse(source).body
            if isinstance(node, ast.If) and "TBL_CONSUMPTION" in ast.unparse(node.test)]
    if len(hits) != 1:
        raise AssertionError(f"{len(hits)} top-level ifs test TBL_CONSUMPTION, not one")
    return "".join(source.splitlines(True)[:hits[0].end_lineno])


def compiled(source, version):
    name = f"<{version} cell {WRITE_CELL}>"
    part = consumption_part(source)
    linecache.cache[name] = (len(part), None, part.splitlines(True), name)
    return compile(part, name, "exec")


CODE = {"new": compiled(NEW_CELLS[WRITE_CELL], "new"), "old": compiled(OLD_CELLS[WRITE_CELL], "old")}
SETTINGS = {}
exec(NEW_CELLS[SETTINGS_CELL], {"__builtins__": BUILTINS}, SETTINGS)
TBL = SETTINGS["TBL_CONSUMPTION"]
KEYS = ast.literal_eval(assigned(NEW_CELLS[WRITE_CELL], "KEYS"))
SCHEMA_NAMES = [f.args[0].value for f in assigned(NEW_CELLS[WRITE_CELL], "CONSUMPTION_SCHEMA").args[0].elts]


def oracle_text():
    """The notebook at ORACLE_COMMIT, or None where git can't show it, as in CI's shallow checkout."""
    try:
        out = subprocess.run(["git", "show", f"{ORACLE_COMMIT}:{NOTEBOOK_PATH}"], cwd=fake.REPO,
                             capture_output=True, check=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.decode("utf-8")


# The source --------------------------------------------------------------------------------------------
# Made-up IDs and names. Every credit is a multiple of 0.25, so every figure is exact.

FIRST = date(2026, 2, 2)
RETENTION = 30      # how many days back, from yesterday, the source still returns
ENV_A, ENV_B = "5b9e2c71-3d48-4f0a-9e16-7c2a8b4d0f53", "c0e7a9d2-6f15-4b83-a4c9-2d8f1e6b7a30"
ENV_NAMES = {ENV_A: "Production", ENV_B: "Sandbox"}


def day(n):
    return FIRST + timedelta(days=n)


def resource(id, name, env, features, channel, model):
    return SimpleNamespace(id=id, name=name, env=env, features=features, channel=channel, model=model)


RESOURCES = (resource("11111111-1111-4111-8111-111111111111", "Sales helper", ENV_A,
                      ("Generative answers", "Classic answers"), "Teams", "gpt-4.1"),
             # No environment, channel or model: the merge must match NULL keys to NULL keys.
             resource("22222222-2222-4222-8222-222222222222", "Unassigned agent", None, (None,), None, None),
             resource("33333333-3333-4333-8333-333333333333", "HR helper", ENV_B, ("Generative answers",),
                      "Web", None))
# The source returns this one only while its day is at most two days old, then withdraws it.
WITHDRAWN = resource("44444444-4444-4444-8444-444444444444", "Trial agent", ENV_B, ("Generative answers",),
                     "Teams", "gpt-4.1")
UNDATED = "55555555-5555-4555-8555-555555555555"


def source_row(r, feature, i, usage, today):
    lag = (today - timedelta(days=1) - usage).days
    n = usage.toordinal()
    return {"usage_date": usage, "resource_id": r.id, "resource_name": r.name, "environment_id": r.env,
            "environment_name": ENV_NAMES.get(r.env), "product_name": "Copilot Studio", "feature": feature,
            "channel": r.channel, "tool_used": None, "llm_model": r.model, "knowledge_sources": None,
            "harness_hint": "Standard (inferred)" if feature or r.model else None,
            # A day's credits restate until it's ten days old.
            "billed_credit": 0.25 * ((n * (i + 3)) % 40 + min(lag, 10)), "non_billed_credit": 0.25 * (n % 3),
            "reported_users": float(1 + (n + i) % 4), "unit": "Credits",
            "as_of_date": (today - timedelta(days=1)).isoformat(), "metadata_json": None}


def collect(usage, today):
    """What the source returns for one day, asked on the morning of today: nothing beyond its retention or on
    a quiet day, and no row for a resource on a day it's idle."""
    lag = (today - timedelta(days=1) - usage).days
    n = usage.toordinal()
    if lag >= RETENTION or n % 11 == 0:
        return []
    rows = [source_row(r, f, i, usage, today) for i, r in enumerate(RESOURCES) if (n + i) % 5
            for f in r.features]
    if lag <= 2:
        rows += [source_row(WITHDRAWN, f, len(RESOURCES), usage, today) for f in WITHDRAWN.features]
    return rows


# Runs --------------------------------------------------------------------------------------------------

def step(n, days, restate, silent=False, at=time(6)):
    """A run on the morning of day(n), with DAYS and RESTATE_DAYS set to days and restate. silent: the source
    returns nothing for any day."""
    return SimpleNamespace(today=day(n), days=days, restate=restate, silent=silent, at=at)


def later(s, at=time(7)):
    """The same run, later the same morning."""
    return SimpleNamespace(**{**vars(s), "at": at})


STEPS = ([step(0, 45, 7)] + [step(n, 10, 7) for n in range(1, 9)] + [step(8, 10, 7, at=time(7))]
         + [step(n, 10, 7) for n in range(9, 13)]
         + [step(16, 10, 7)]                                    # after three days with no run
         + [step(n, 7, 7) for n in range(17, 21)]               # DAYS equal to RESTATE_DAYS
         + [step(n, 10, 1) for n in (21, 22)]
         + [step(23, 10, 7, silent=True), step(24, 45, 7)])


def window(s):
    """The first and last days a run collects, as cell 3 works them out: DAYS days, ending yesterday."""
    end = s.today - timedelta(days=1)
    return end - timedelta(days=s.days - 1), end


def run(spark, version, s, fail_at=None):
    """Runs the write as version ("new" or "old") after the collection of step s. Like a notebook run, it
    stops at the first error, which it returns rather than raises. fail_at makes that write fail."""
    start, end = window(s)
    rows = [] if s.silent else [r for n in range(s.days) for r in collect(start + timedelta(days=n), s.today)]
    spark.now, spark.fail_at, spark.cell = datetime.combine(s.today, s.at), fail_at, WRITE_CELL
    spark.writes, spark.output, spark.history = [], [], []
    scope = {"__builtins__": BUILTINS, "__name__": "__main__", "spark": spark, "rows": rows, "START": start,
             "END": end, "DAYS": s.days, "RESTATE_DAYS": s.restate, "TBL_CONSUMPTION": TBL, "date": date,
             "datetime": datetime, "timedelta": timedelta,
             "print": lambda *args, **kwargs: spark.output.append(" ".join(map(str, args)))}
    error = tb = None
    try:
        exec(CODE[version], scope)
    except Exception as e:
        error, tb = e, traceback.format_exc()
    spark.cell = None
    return SimpleNamespace(step=s, error=error, tb=tb, rows=rows, start=start, end=end,
                           restate_from=end - timedelta(days=s.restate - 1),
                           writes=[(name, op) for _, name, op in spark.writes], history=list(spark.history))


def add_undated(spark):
    """Puts two rows with no usage_date in the table. No collection makes one, but a table can hold them."""
    t = spark.tables[TBL]
    loaded = datetime.combine(FIRST, time(5))
    rows = [{"resource_id": UNDATED, "resource_name": "Imported agent", "feature": feature,
             "billed_credit": credit, "unit": "Credits", "_loaded_at": loaded}
            for feature, credit in (("Generative answers", 1.5), ("Classic answers", 0.75))]
    spark.tables[TBL] = t.with_rows(t.rows + [tuple(r.get(n) for n in t.names) for r in rows])


@functools.lru_cache(maxsize=None)
def scenario(version):
    """Every step, run in turn as version from no table, each with the tables before and after it. The undated
    rows go in after the first step."""
    spark, results = Spark(), []
    for i, s in enumerate(STEPS):
        before = dict(spark.tables)
        result = run(spark, version, s)
        result.before, result.after = before, dict(spark.tables)
        results.append(result)
        if i == 0:
            add_undated(spark)
    return results


def at_step(today, at=time(6)):
    """The index of the step run on the morning of today, at at."""
    hits = [i for i, s in enumerate(STEPS) if s.today == today and s.at == at]
    if len(hits) != 1:
        raise AssertionError(f"{len(hits)} steps run on {today} at {at}")
    return hits[0]


def before_step(i):
    """A Spark holding the table as it was before step i, which is the same in both versions."""
    spark = Spark()
    spark.tables = dict(scenario("new")[i].before)
    return spark


def rows_of(tables, **match):
    """The consumption table's rows as dicts, keeping those that equal every value in match; none if there's
    no table. tables is a Spark or its tables."""
    if isinstance(tables, fake.FakeSpark):
        tables = tables.tables
    return fake.rows_of(tables, TBL, **match) if TBL in tables else []


def bag(rows, drop=LOADED):
    """Rows as a multiset, whatever order their columns are in, leaving out the columns in drop."""
    return Counter(tuple(sorted((k, v) for k, v in r.items() if k not in drop)) for r in rows)


def key(r):
    return tuple(r[k] for k in KEYS)


def in_window(r, restate_from):
    return r["usage_date"] is not None and r["usage_date"] >= restate_from


def days(tables):
    """The days the table has a row on."""
    return {r["usage_date"] for r in rows_of(tables) if r["usage_date"] is not None}


def expected_rows(result):
    """The rows a successful run leaves, by the notebook's own rule: the restatement window holds exactly the
    rows collected for it; an older collected row replaces the stored row with its key, or is added; every
    other stored row stays, an undated one included."""
    older = {key(r) for r in result.rows if r["usage_date"] < result.restate_from}
    kept = [r for r in rows_of(result.before) if not in_window(r, result.restate_from) and key(r) not in older]
    return bag(kept) + bag(result.rows)


def gaps(results):
    """How many runs pass through a state missing a day that the table has both before and after the run, and
    how many such (run, day) pairs there are."""
    runs, pairs = 0, set()
    for i, result in enumerate(results):
        kept = days(result.before) & days(result.after)
        missing = set().union(*(kept - days(state) for state in result.history))
        runs += bool(missing)
        pairs |= {(i, d) for d in missing}
    return runs, len(pairs)


def retype(spark, table, column, dtype, convert):
    """Changes a stored column's type, converting each of its values."""
    t = spark.tables[table]
    i = t.names.index(column)
    spark.tables[table] = fake.Table(t.names, t.types[:i] + [dtype] + t.types[i + 1:],
                                     [r[:i] + (None if r[i] is None else convert(r[i]),) + r[i + 1:]
                                      for r in t.rows])


VERSIONS = ("new", "old")


def label(result):
    return f"{result.step.today} at {result.step.at}"


# Tests -------------------------------------------------------------------------------------------------

class Structure(unittest.TestCase):
    def test_the_old_cells_are_the_notebook_at_the_oracle_commit(self):
        text = oracle_text()
        if text is None:
            self.skipTest(f"git can't show {ORACLE_COMMIT} here")
        self.assertEqual(OLD_CELLS, fake.notebook_cells(text))

    def test_the_tests_run_every_write_to_the_consumption_table(self):
        source = NEW_CELLS[WRITE_CELL]
        part = consumption_part(source)
        self.assertTrue(source.startswith(part))
        self.assertIn("saveAsTable(TBL_CONSUMPTION)", part)
        # The rest of the cell writes the capacity snapshot and the environment list, never this table.
        self.assertNotIn("TBL_CONSUMPTION", source[len(part):])
        self.assertIn("saveAsTable(TBL_CAPACITY)", source[len(part):])

    def test_the_window_and_rows_are_what_the_cells_before_give_the_write(self):
        self.assertIn("END = datetime.now(timezone.utc).date() - timedelta(days=1)\n"
                      "START = END - timedelta(days=DAYS - 1)\n", NEW_CELLS[WINDOW_CELL])
        self.assertIn("day = START\nwhile day <= END:\n    got = collect_day(day)\n    rows.extend(got)\n",
                      NEW_CELLS[COLLECT_CELL])

    def test_the_made_up_rows_have_the_keys_collect_day_gives(self):
        dicts = [node for node in ast.walk(ast.parse(NEW_CELLS[COLLECT_CELL])) if isinstance(node, ast.Dict)
                 and any(isinstance(k, ast.Constant) and k.value == "usage_date" for k in node.keys)]
        self.assertEqual(len(dicts), 1)
        self.assertEqual([k.value for k in dicts[0].keys], SCHEMA_NAMES)
        rows = [r for result in scenario("new") for r in result.rows]
        self.assertTrue(rows)
        self.assertEqual({tuple(r) for r in rows}, {tuple(SCHEMA_NAMES)})


class SameEndState(unittest.TestCase):
    """Every successful run leaves the table exactly as the code at the oracle commit does."""

    def test_every_run_succeeds(self):
        for version in VERSIONS:
            for result in scenario(version):
                with self.subTest(version=version, run=label(result)):
                    self.assertIsNone(result.error, result.tb)

    def test_every_run_ends_as_the_old_code_does(self):
        for new, old in zip(scenario("new"), scenario("old")):
            with self.subTest(run=label(new)):
                self.assertEqual(fake.differences(fake.snapshot(old.after), fake.snapshot(new.after)), [])

    def test_every_run_ends_as_the_notebook_says(self):
        for version in VERSIONS:
            for result in scenario(version):
                with self.subTest(version=version, run=label(result)):
                    self.assertEqual(bag(rows_of(result.after)), expected_rows(result))

    def test_each_run_replaces_the_window_in_one_commit_then_merges_older_days(self):
        window_writes = {"new": [(TBL, "replaceWhere")], "old": [(TBL, "delete"), (TBL, "append")]}
        for version in VERSIONS:
            for i, result in enumerate(scenario(version)):
                with self.subTest(version=version, run=label(result)):
                    if i == 0:
                        self.assertEqual(result.writes, [(TBL, "create")])
                        continue
                    merged = any(r["usage_date"] < result.restate_from for r in result.rows)
                    self.assertEqual(result.writes, window_writes[version] + [(TBL, "merge")] * merged)

    def test_the_runs_cover_each_case(self):
        results = scenario("new")[1:]

        def stored(result, test):
            collected = {key(r) for r in result.rows}
            return any(test(r) and key(r) not in collected for r in rows_of(result.before))

        cases = {
            "older days merged": [r for r in results if any(x["usage_date"] < r.restate_from for x in r.rows)],
            "no older days": [r for r in results
                              if r.rows and all(x["usage_date"] >= r.restate_from for x in r.rows)],
            "a stored window row isn't collected": [
                r for r in results if stored(r, lambda x: in_window(x, r.restate_from))],
            "nothing is collected": [r for r in results if not r.rows],
            "an older stored row in the run's days isn't collected": [
                r for r in results if stored(r, lambda x: x["usage_date"] is not None
                                             and r.start <= x["usage_date"] < r.restate_from)],
            "a day before the run's first is stored": [
                r for r in results if any(x["usage_date"] is not None and x["usage_date"] < r.start
                                          for x in rows_of(r.before))],
            "undated rows are stored": [r for r in results if rows_of(r.before, usage_date=None)],
            "a NULL environment": [r for r in results if any(x["environment_id"] is None for x in r.rows)],
            "a merge updates a stored row": [
                r for r in results if {key(x) for x in r.rows if x["usage_date"] < r.restate_from}
                & {key(x) for x in rows_of(r.before)}],
            "a merge inserts a row": [
                r for r in results if {key(x) for x in r.rows if x["usage_date"] < r.restate_from}
                - {key(x) for x in rows_of(r.before)}],
        }
        self.assertEqual([name for name, found in cases.items() if not found], [])


class Cases(unittest.TestCase):
    def test_a_first_run_creates_the_table_with_every_row(self):
        for version in VERSIONS:
            result = scenario(version)[0]
            with self.subTest(version=version):
                self.assertTrue(result.rows)
                self.assertEqual(result.after[TBL].names, SCHEMA_NAMES + list(LOADED))
                self.assertEqual(bag(rows_of(result.after)), bag(result.rows))

    def test_a_rerun_of_the_same_day_changes_nothing_but_the_load_time(self):
        stamp = datetime.combine(day(8), time(7))
        for version in VERSIONS:
            result = scenario(version)[at_step(day(8), time(7))]
            with self.subTest(version=version):
                self.assertTrue(result.rows)
                self.assertEqual(fake.differences(fake.snapshot(result.before, LOADED),
                                                  fake.snapshot(result.after, LOADED)), [])
                self.assertEqual(len(rows_of(result.after, _loaded_at=stamp)), len(result.rows))

    def test_undated_rows_stay(self):
        for version in VERSIONS:
            for result in scenario(version)[1:]:
                with self.subTest(version=version, run=label(result)):
                    undated = rows_of(result.after, usage_date=None)
                    self.assertEqual(len(undated), 2)
                    self.assertEqual(bag(undated, drop=()), bag(rows_of(result.before, usage_date=None), drop=()))

    def test_days_the_source_no_longer_returns_stay(self):
        for version in VERSIONS:
            result = scenario(version)[-1]
            last = result.end - timedelta(days=RETENTION)

            def beyond(tables):
                return bag([r for r in rows_of(tables)
                            if r["usage_date"] is not None and result.start <= r["usage_date"] <= last], drop=())

            with self.subTest(version=version):
                self.assertLess(result.start, last)
                self.assertTrue(beyond(result.before))
                self.assertEqual([r for r in result.rows if r["usage_date"] <= last], [])
                self.assertEqual(beyond(result.after), beyond(result.before))

    def test_a_run_that_collects_nothing_empties_only_its_window(self):
        for version in VERSIONS:
            result = scenario(version)[at_step(day(23))]
            before = rows_of(result.before)
            with self.subTest(version=version):
                self.assertEqual(result.rows, [])
                self.assertTrue([r for r in before if in_window(r, result.restate_from)])
                self.assertEqual(bag(rows_of(result.after), drop=()),
                                 bag([r for r in before if not in_window(r, result.restate_from)], drop=()))

    def test_a_withdrawn_row_leaves_the_window_but_stays_once_older(self):
        def withdrawn(rows, result, older_than):
            return [r for r in rows if r["resource_id"] == WITHDRAWN.id
                    and (result.end - r["usage_date"]).days > older_than]

        for version in VERSIONS:
            with self.subTest(version=version):
                # Inside the window it goes: the source returns it only while it's at most two days old.
                result = scenario(version)[at_step(day(10))]
                self.assertTrue([r for r in withdrawn(rows_of(result.before), result, 2)
                                 if in_window(r, result.restate_from)])
                self.assertEqual([r for r in withdrawn(rows_of(result.after), result, 2)
                                  if in_window(r, result.restate_from)], [])
                # With a one-day window it's older by the time the source stops returning it, so it stays.
                result = scenario(version)[at_step(day(22))]
                self.assertEqual(withdrawn(result.rows, result, 2), [])
                kept = withdrawn(rows_of(result.after), result, 2)
                self.assertTrue(kept)
                self.assertTrue(all(r["usage_date"] < result.restate_from for r in kept))


class Failures(unittest.TestCase):
    """A write that fails leaves the table as it was, and the next run restores what the failure left stale."""

    DAY, NEXT = day(10), day(11)
    # (version, which write fails): the window write, the merge, and for the old code the delete or append.
    FAILURES = (("new", 1), ("new", 2), ("old", 1), ("old", 2), ("old", 3))

    def failed(self, version, fail_at, today=None):
        """The run on today, DAY by default, with write fail_at failing, on the table as it was before it."""
        i = at_step(today or self.DAY)
        spark = before_step(i)
        result = run(spark, version, STEPS[i], fail_at)
        self.assertIsInstance(result.error, fake.SimulatedFailure, result.tb)
        return spark, result

    def test_a_failed_window_write_leaves_the_table_as_it_was(self):
        spark, result = self.failed("new", 1)
        self.assertEqual(result.writes, [(TBL, "replaceWhere")])
        self.assertEqual(fake.differences(fake.snapshot(scenario("new")[at_step(self.DAY)].before),
                                          fake.snapshot(spark)), [])

    def test_the_old_code_left_the_window_empty_when_its_append_failed(self):
        spark, result = self.failed("old", 2)
        self.assertEqual(result.writes, [(TBL, "delete"), (TBL, "append")])
        before = rows_of(scenario("old")[at_step(self.DAY)].before)
        self.assertTrue([r for r in before if in_window(r, result.restate_from)])
        self.assertEqual([r for r in rows_of(spark) if in_window(r, result.restate_from)], [])

    def test_a_failed_merge_leaves_the_window_restated_and_older_days_as_they_were(self):
        new_spark, new = self.failed("new", 2)
        old_spark, old = self.failed("old", 3)
        self.assertEqual(new.writes, [(TBL, "replaceWhere"), (TBL, "merge")])
        self.assertEqual(old.writes, [(TBL, "delete"), (TBL, "append"), (TBL, "merge")])
        self.assertEqual(fake.differences(fake.snapshot(old_spark), fake.snapshot(new_spark)), [])
        before = rows_of(scenario("new")[at_step(self.DAY)].before)
        self.assertEqual(bag(rows_of(new_spark)),
                         bag([r for r in before if not in_window(r, new.restate_from)])
                         + bag([r for r in new.rows if in_window(r, new.restate_from)]))
        clean = scenario("new")[at_step(self.DAY)].after
        self.assertNotEqual(fake.differences(fake.snapshot(clean), fake.snapshot(new_spark)), [])

    def test_a_rerun_after_a_failure_ends_as_a_clean_run(self):
        i = at_step(self.DAY)
        for version, fail_at in self.FAILURES:
            with self.subTest(version=version, fail_at=fail_at):
                spark, _ = self.failed(version, fail_at)
                result = run(spark, version, later(STEPS[i]))
                self.assertIsNone(result.error, result.tb)
                self.assertEqual(fake.differences(fake.snapshot(scenario(version)[i].after, LOADED),
                                                  fake.snapshot(spark, LOADED)), [])

    def test_the_next_days_run_restores_all_but_the_failed_runs_first_day(self):
        i, j = at_step(self.DAY), at_step(self.NEXT)
        first = window(STEPS[i])[0]
        self.assertEqual((j, window(STEPS[j])[0]), (i + 1, first + timedelta(days=1)))

        def other_days(tables):
            return bag([r for r in rows_of(tables) if r["usage_date"] != first], drop=())

        for version, fail_at in self.FAILURES:
            with self.subTest(version=version, fail_at=fail_at):
                spark, _ = self.failed(version, fail_at)
                result = run(spark, version, STEPS[j])
                self.assertIsNone(result.error, result.tb)
                clean = scenario(version)[j].after
                self.assertEqual(other_days(spark), other_days(clean))
                # The failed run's first day isn't lost: it keeps the rows it had, which the clean run had
                # restated, until a run whose days include it.
                stale = bag(rows_of(spark, usage_date=first), drop=())
                self.assertTrue(stale)
                self.assertEqual(stale, bag(rows_of(scenario(version)[i].before, usage_date=first), drop=()))
                self.assertNotEqual(stale, bag(rows_of(clean, usage_date=first), drop=()))

    def test_with_days_equal_to_restate_days_only_the_old_code_lost_a_failed_runs_first_day(self):
        i, j = at_step(day(19)), at_step(day(20))
        self.assertEqual((STEPS[i].days, STEPS[j].days, j), (STEPS[i].restate, STEPS[j].restate, i + 1))
        first = window(STEPS[i])[0]
        self.assertEqual(window(STEPS[j])[0], first + timedelta(days=1))
        before = bag(rows_of(scenario("new")[i].before, usage_date=first), drop=())
        self.assertTrue(before)
        for version, fail_at, kept in (("new", 1, before), ("old", 1, before), ("old", 2, Counter())):
            with self.subTest(version=version, fail_at=fail_at):
                spark, _ = self.failed(version, fail_at, day(19))
                result = run(spark, version, STEPS[j])
                self.assertIsNone(result.error, result.tb)
                self.assertEqual(bag(rows_of(spark, usage_date=first), drop=()), kept)

    def test_no_run_passes_through_a_state_missing_a_day_it_keeps(self):
        self.assertEqual(gaps(scenario("new")), (0, 0))
        self.assertGreater(gaps(scenario("old"))[0], 0)

    def test_a_failed_first_run_leaves_no_table_and_a_rerun_creates_it(self):
        spark = Spark()
        result = run(spark, "new", STEPS[0], fail_at=1)
        self.assertIsInstance(result.error, fake.SimulatedFailure, result.tb)
        self.assertEqual((result.writes, TBL in spark.tables), ([(TBL, "create")], False))
        result = run(spark, "new", STEPS[0])
        self.assertIsNone(result.error, result.tb)
        self.assertEqual(fake.differences(fake.snapshot(scenario("new")[0].after), fake.snapshot(spark)), [])


class Schema(unittest.TestCase):
    """The table and the rows written to it can differ by a column, for instance after someone changes one.
    Neither version evolves the schema. Both fail as before; where the old code had already deleted the
    window, the new code leaves the table as it was."""

    DAY = day(10)

    def runs(self, change):
        """Each version's run on DAY after change, on the table as it was before the run."""
        out = {}
        for version in VERSIONS:
            spark = before_step(at_step(self.DAY))
            change(spark)
            out[version] = spark, run(spark, version, STEPS[at_step(self.DAY)])
        return out

    def test_a_column_only_the_table_has(self):
        # Both write NULL in it, then fail at the merge, which needs every column of the table.
        out = self.runs(lambda spark: fake.with_column(spark, TBL, "notes", fake.STRING))
        for version, writes in (("new", [(TBL, "replaceWhere")]), ("old", [(TBL, "delete"), (TBL, "append")])):
            spark, result = out[version]
            with self.subTest(version=version):
                self.assertIsInstance(result.error, fake.AnalysisError, result.tb)
                self.assertIn("DELTA_MERGE_UNRESOLVED_EXPRESSION", str(result.error))
                self.assertEqual(result.writes, writes)
                restated = [r for r in rows_of(spark) if in_window(r, result.restate_from)]
                self.assertTrue(restated)
                self.assertEqual({r["notes"] for r in restated}, {None})
        self.assertEqual(fake.differences(fake.snapshot(out["old"][0]), fake.snapshot(out["new"][0])), [])

    def test_a_column_only_the_rows_have_or_a_changed_type(self):
        changes = {"a column only the rows have": lambda spark: fake.without(spark, TBL, "metadata_json"),
                   "a changed type": lambda spark: retype(spark, TBL, "as_of_date", fake.DATE, date.fromisoformat)}
        for name, change in changes.items():
            before = before_step(at_step(self.DAY))
            change(before)
            out = self.runs(change)
            for version, writes in (("new", []), ("old", [(TBL, "delete")])):
                spark, result = out[version]
                with self.subTest(change=name, version=version):
                    self.assertIsInstance(result.error, fake.AnalysisError, result.tb)
                    self.assertEqual(result.writes, writes)
            with self.subTest(change=name):
                self.assertEqual(fake.differences(fake.snapshot(before), fake.snapshot(out["new"][0])), [])
                old_spark, old = out["old"]
                self.assertTrue([r for r in rows_of(before) if in_window(r, old.restate_from)])
                self.assertEqual([r for r in rows_of(old_spark) if in_window(r, old.restate_from)], [])


if __name__ == "__main__":
    unittest.main()
