"""Offline tests that the Azure AI notebook's reloads keep the rows older than their window.

They exec the notebook's own definitions and write statements against a small in-memory stand-in
for Spark and Delta that applies replaceWhere's rules, so they need only the standard library.
The writes follow microsoft/ValueLens-for-Microsoft-Copilot#221 at 6b183d1. OLD_HELPERS is #58's
write path (cdcecad), kept as the oracle that a successful run still writes what #58 wrote.
"""
import ast
from datetime import date, datetime, timedelta
import functools
import json
import math
import operator
from pathlib import Path
import random
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
# The column each table's window is matched on and, for a monthly table, the column that says how
# far into its month a row was read.
RELOAD = {"LAKEHOUSE_SPEND": ("UsageDate", None), "LAKEHOUSE_TOKENS": ("Date", None),
          "LAKEHOUSE_PAYG": ("UsageDate", None), "LAKEHOUSE_HEALTH": ("MetricDate", "SnapshotDate"),
          "LAKEHOUSE_SOLUTION": ("UsageDate", None),
          "LAKEHOUSE_RECON": ("PeriodStart", "PeriodEnd")}
# Spend, tokens and PAYG must be written; the other tables are best effort.
STRICT = WRITE_ORDER[:3]
TYPES = {"date": date, "string": str, "double": float}
MISSING = object()


def top_level(names):
    """The top-level definition or assignment of each name, which must be defined once."""
    found = {}
    for tree in TREES:
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
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
    "month_end", "monthly_replace_from", "window_predicate", "monthly_cut", "write_windows",
    "note", "flush", "as_number", "as_day", "is_provisioned", "health_rows", "recon_rows",
    "HEALTH_HEADERS", "RECON_HEADERS", "PAYG_POOL", "PROVISIONED_POOL", "RECON_TOLERANCES",
    "RETAIL_BATCH", "SPEND_SCHEMA", "TOKENS_SCHEMA", "PAYG_SCHEMA", "HEALTH_SCHEMA",
    "SOLUTION_SCHEMA", "RECON_SCHEMA", *WRITE_ORDER})
DEFINITIONS = compile(ast.Module(body=list(DEFINED.values()), type_ignores=[]), str(NOTEBOOK),
                      "exec")
# Top-level statements that a simulated run executes as written in the notebook.
STEPS = top_level({"start", "spend_frame", "tokens_frame", "payg_frame", "health",
                   "detail_warnings"})
TABLE = {name: ast.literal_eval(DEFINED[name].value) for name in WRITE_ORDER}
SPEND, TOKENS, PAYG, HEALTH, SOLUTION, RECON = (TABLE[name] for name in WRITE_ORDER)
NAME = {table: name for name, table in TABLE.items()}
HELPER_CELL = next(index for index, tree in enumerate(TREES)
                   if DEFINED["write_windows"] in tree.body)


def write_sites():
    """Every write_windows entry outside the helper definitions, in notebook order."""
    sites = []
    for index, tree in enumerate(TREES):
        for statement in tree.body:
            if isinstance(statement, ast.FunctionDef):
                continue
            for call in ast.walk(statement):
                if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Name)
                        and call.func.id == "write_windows"):
                    continue
                if (len(call.args) != 1 or call.keywords or not isinstance(call.args[0], ast.List)
                        or not all(isinstance(entry, ast.Tuple) and len(entry.elts) == 4
                                   and isinstance(entry.elts[1], ast.Name)
                                   and entry.elts[1].id in TABLE
                                   for entry in call.args[0].elts)):
                    raise AssertionError(f"Unrecognised write: {ast.unparse(call)}")
                for entry in call.args[0].elts:
                    frame, table, column, cut = entry.elts
                    sites.append(SimpleNamespace(
                        table=table.id, column=ast.literal_eval(column), frame=frame, cut=cut,
                        statement=statement, call=call, cell=index))
    return sites


def covered_column(site):
    """None for a write cut at start, else the covered column its monthly_cut reads."""
    cut = site.cut
    if isinstance(cut, ast.Name) and cut.id == "start":
        return None
    if (isinstance(cut, ast.Call) and isinstance(cut.func, ast.Name)
            and cut.func.id == "monthly_cut" and len(cut.args) == 4 and not cut.keywords):
        table, column, covered, start = cut.args
        if (isinstance(table, ast.Name) and table.id == site.table
                and isinstance(column, ast.Constant) and column.value == site.column
                and isinstance(covered, ast.Constant) and isinstance(covered.value, str)
                and isinstance(start, ast.Name) and start.id == "start"):
            return covered.value
    raise AssertionError(f"Unrecognised cut for {site.table}: {ast.unparse(cut)}")


SITES = write_sites()
SITE = {site.table: site for site in SITES}
DAILY_COLUMNS = [(TABLE[name], column) for name, (column, covered) in RELOAD.items()
                 if covered is None]
MONTHLY = [name for name, (column, covered) in RELOAD.items() if covered]


def evaluate(node, namespace):
    return eval(compile(ast.Expression(body=node), str(NOTEBOOK), "eval"), namespace)


def parse_schema(schema):
    return [tuple(field.split()) for field in schema.split(",")]


def schema_of(frame):
    """{column: type} for the schema a written frame was created with."""
    if isinstance(frame, ast.Name):
        frame = STEPS[frame.id].value
    if ast.unparse(frame.func) != "spark.createDataFrame":
        raise AssertionError(f"Unrecognised frame: {ast.unparse(frame)}")
    name = next(keyword.value.id for keyword in frame.keywords if keyword.arg == "schema")
    return dict(parse_schema(ast.literal_eval(DEFINED[name].value)))


def lookup(row, column, default=MISSING):
    """A row's value for a column, matched case-insensitively as Spark does by default."""
    for key, item in row.items():
        if key.lower() == column.lower():
            return item
    if default is MISSING:
        raise KeyError(f"no column {column}")
    return default


def conform(row, dtypes):
    return {name: lookup(row, name, None) for name, _ in dtypes}


def month_end(day):
    return date(day.year + day.month // 12, day.month % 12 + 1, 1) - timedelta(days=1)


def add_months(day, months):
    """The 1st of the month that is months after day's."""
    index = day.year * 12 + day.month - 1 + months
    return date(index // 12, index % 12 + 1, 1)


# A small reader for the SQL conditions the notebook writes. It accepts only what they need and
# fails on anything else rather than guessing, and it is stricter than Spark in one way: a
# comparison must be between values of one type, so a date column needs a DATE literal.
TOKEN = re.compile(r"`[^`]*`|'[^']*'|>=|<=|<>|!=|[=<>()]|\w+|\S")
COMPARE = {"=": operator.eq, "<>": operator.ne, "!=": operator.ne, "<": operator.lt,
           "<=": operator.le, ">": operator.gt, ">=": operator.ge}
KEYWORDS = {"AND", "OR", "NOT", "IS", "NULL", "DATE"}


@functools.lru_cache(maxsize=None)
def parse_predicate(text):
    """A SQL condition as a tree of tuples."""
    tokens = TOKEN.findall(text)
    position = 0

    def peek():
        return tokens[position].upper() if position < len(tokens) else None

    def take(expected=None):
        nonlocal position
        if position >= len(tokens):
            raise RuntimeError(f"incomplete predicate: {text}")
        token = tokens[position]
        if expected is not None and token.upper() != expected:
            raise RuntimeError(f"expected {expected} at {token!r} in: {text}")
        position += 1
        return token

    def either():
        node = both()
        while peek() == "OR":
            take()
            node = ("or", node, both())
        return node

    def both():
        node = unary()
        while peek() == "AND":
            take()
            node = ("and", node, unary())
        return node

    def unary():
        if peek() == "NOT":
            take()
            return ("not", unary())
        if peek() == "(":
            take()
            node = either()
            take(")")
            return node
        left = operand()
        if peek() == "IS":
            take()
            negated = peek() == "NOT"
            if negated:
                take()
            take("NULL")
            return ("not", ("null", left)) if negated else ("null", left)
        symbol = take()
        if symbol not in COMPARE:
            raise RuntimeError(f"expected a comparison at {symbol!r} in: {text}")
        return ("compare", symbol, left, operand())

    def operand():
        token = take()
        if token.startswith("`"):
            return ("column", token[1:-1])
        if token.upper() == "DATE":
            literal = take()
            if not re.fullmatch(r"'\d{4}-\d{2}-\d{2}'", literal):
                raise RuntimeError(f"expected a date literal at {literal!r} in: {text}")
            try:
                return ("value", "date", date.fromisoformat(literal[1:-1]))
            except ValueError as exc:
                raise RuntimeError(f"invalid date {literal} in: {text}") from exc
        if token.startswith("'"):
            return ("value", "string", token[1:-1])
        if re.fullmatch(r"[A-Za-z_]\w*", token) and token.upper() not in KEYWORDS:
            return ("column", token)
        raise RuntimeError(f"unexpected {token!r} in: {text}")

    tree = either()
    if position != len(tokens):
        raise RuntimeError(f"unexpected {tokens[position]!r} in: {text}")
    return tree


def row_test(text, dtypes):
    """A function giving a row's SQL value for a condition: True, False or None (unknown).

    Columns match case-insensitively. Columns and types are checked when the condition is read,
    before any row is, as Spark's analyser does.
    """
    kinds = {name.lower(): (name, kind) for name, kind in dtypes}

    def build(node):
        tag = node[0]
        if tag == "column":
            if node[1].lower() not in kinds:
                raise RuntimeError(f"cannot resolve column {node[1]} in: {text}")
            name, kind = kinds[node[1].lower()]
            return kind, lambda row: row.get(name)
        if tag == "value":
            constant = node[2]
            return node[1], lambda row: constant
        if tag == "null":
            inner = build(node[1])[1]
            return "boolean", lambda row: inner(row) is None
        if tag == "compare":
            test = COMPARE[node[1]]
            (left_kind, left), (right_kind, right) = build(node[2]), build(node[3])
            if left_kind != right_kind:
                raise RuntimeError(f"cannot compare {left_kind} with {right_kind} in: {text}")

            def compared(row):
                a, b = left(row), right(row)
                return None if a is None or b is None else test(a, b)
            return "boolean", compared
        if tag == "not":
            inner = condition(node[1])

            def negated(row):
                result = inner(row)
                return None if result is None else not result
            return "boolean", negated
        winner = tag == "or"
        parts = [condition(node[1]), condition(node[2])]

        def combined(row):
            results = [part(row) for part in parts]
            if winner in results:
                return winner
            return None if None in results else not winner
        return "boolean", combined

    def condition(node):
        kind, compute = build(node)
        if kind != "boolean":
            raise RuntimeError(f"not a condition in: {text}")
        return compute

    return condition(parse_predicate(text))


class Col:
    """A Spark column for #58's write path: a function of a row, with SQL's null logic."""

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


FUNCTIONS = SimpleNamespace(col=lambda column: Col(lambda row: lookup(row, column)),
                            lit=lambda constant: Col(lambda row: constant))


class Frame:
    """A DataFrame of dict rows. One read from a table that can't be read raises its error when
    its rows are needed, as Spark does when an action runs."""

    def __init__(self, spark, dtypes, rows, error=None):
        self.spark, self.dtypes, self.error = spark, list(dtypes), error
        self.rows = [conform(row, self.dtypes) for row in rows]

    def materialise(self):
        if self.error is not None:
            raise self.error
        return self.rows

    def derive(self, dtypes, rows):
        if self.error is not None:
            return Frame(self.spark, dtypes, [], self.error)
        return Frame(self.spark, dtypes, rows())

    def filter(self, condition):
        test = row_test(condition, self.dtypes) if isinstance(condition, str) else condition
        return self.derive(self.dtypes, lambda: [row for row in self.rows if test(row) is True])

    def select(self, *columns):
        kinds = {name.lower(): (name, kind) for name, kind in self.dtypes}
        missing = [column for column in columns if column.lower() not in kinds]
        if missing:
            raise RuntimeError(f"cannot resolve {missing}")
        return self.derive([kinds[column.lower()] for column in columns], lambda: self.rows)

    def distinct(self):
        def unique():
            seen, rows = set(), []
            for row in self.rows:
                if tuple(row.values()) not in seen:
                    seen.add(tuple(row.values()))
                    rows.append(row)
            return rows
        return self.derive(self.dtypes, unique)

    def collect(self):
        return [tuple(row.values()) for row in self.materialise()]

    def count(self):
        return len(self.materialise())

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


class Stored:
    """A Lakehouse table: its columns and rows."""

    def __init__(self, dtypes, rows):
        self.dtypes = list(dtypes)
        self.rows = [conform(row, self.dtypes) for row in rows]


class FakeDeltaTable:
    """DeltaTable.forName(...).delete(condition), which #58's write path used."""

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


class FakeSpark:
    """Just enough of a Spark session and Lakehouse catalog for the notebook's reads and writes.

    save() applies Delta's rules for the writes the notebook makes. An overwrite with replaceWhere
    fails unless every written row matches the predicate, and replaces only the stored rows that
    match it. A column whose type differs from the stored one fails, and a new column needs
    mergeSchema. A write that fails changes nothing. Tables named in unopenable, unreadable or
    fail_write fail as their names say.
    """

    def __init__(self):
        self.tables, self.log = {}, []
        self.unopenable, self.unreadable, self.fail_write = set(), set(), set()
        self.catalog = SimpleNamespace(tableExists=lambda name: name in self.tables)

    def createDataFrame(self, rows, schema):
        dtypes = parse_schema(schema)
        checked = []
        for row in rows:
            if not isinstance(row, dict):
                raise AssertionError(f"rows are dicts here, not {type(row).__name__}")
            for column, kind in dtypes:
                item = row.get(column)
                if item is not None and type(item) is not TYPES[kind]:
                    raise TypeError(f"field {column}: {kind} can not accept {item!r}")
            checked.append({column: row.get(column) for column, _ in dtypes})
        return Frame(self, dtypes, checked)

    def table(self, name):
        if name in self.unopenable:
            raise OSError(f"simulated failure opening {name}")
        if name not in self.tables:
            raise RuntimeError(f"[TABLE_OR_VIEW_NOT_FOUND] {name}")
        stored = self.tables[name]
        if name in self.unreadable:
            return Frame(self, stored.dtypes, [], OSError(f"simulated failure reading {name}"))
        return Frame(self, stored.dtypes, [dict(row) for row in stored.rows])

    def save(self, name, frame, source, mode, options):
        if (source != "delta" or mode not in (None, "append", "overwrite")
                or not set(options) <= {"replaceWhere", "mergeSchema"}):
            raise AssertionError(f"{name}: unexpected write (format {source!r}, mode {mode!r}, "
                                 f"options {options})")
        predicate = options.get("replaceWhere")
        if predicate is not None and mode != "overwrite":
            raise AssertionError(f"{name}: replaceWhere without overwrite")
        rows = [dict(row) for row in frame.materialise()]
        if predicate is not None:
            test = row_test(predicate, frame.dtypes)
            if not all(test(row) is True for row in rows):
                raise RuntimeError(
                    f"Written data does not conform to the replaceWhere predicate {predicate}")
        if name not in self.tables:
            if predicate is not None:
                raise AssertionError(f"{name}: replaceWhere on a table that doesn't exist")
            if name in self.fail_write:
                raise OSError(f"simulated failure writing {name}")
            self.tables[name] = Stored(frame.dtypes, rows)
            self.log.append(("create", name, len(rows)))
            return
        stored = self.tables[name]
        if mode is None:
            raise RuntimeError(f"[TABLE_OR_VIEW_ALREADY_EXISTS] {name} already exists")
        kinds = {column.lower(): kind for column, kind in stored.dtypes}
        added = []
        for column, kind in frame.dtypes:
            if column.lower() not in kinds:
                added.append((column, kind))
            elif kinds[column.lower()] != kind:
                raise RuntimeError(
                    f"Failed to merge fields '{column}': {kinds[column.lower()]} and {kind}")
        if added and options.get("mergeSchema") != "true":
            raise RuntimeError(f"A schema mismatch detected when writing to {name}: {added}")
        if name in self.fail_write:
            raise OSError(f"simulated failure writing {name}")
        if predicate is not None:
            test = row_test(predicate, stored.dtypes)
            kept = [row for row in stored.rows if test(row) is not True]
            self.log.append(("replace", name, predicate, len(rows)))
        elif mode == "overwrite":
            kept = []
            self.log.append(("overwrite", name, len(rows)))
        else:
            kept = stored.rows
            self.log.append(("append", name, len(rows)))
        stored.dtypes.extend(added)
        stored.rows = [conform(row, stored.dtypes) for row in kept + rows]


def notebook(spark, **values):
    """A namespace holding the notebook's definitions, with the fakes standing in for Spark."""
    printed = []
    namespace = {"math": math, "re": re, "date": date, "datetime": datetime,
                 "timedelta": timedelta, "UUID": UUID, "spark": spark, "printed": printed,
                 "print": lambda *args, **kwargs: printed.append(" ".join(map(str, args)))}
    exec(DEFINITIONS, namespace)
    namespace.update(values)
    return namespace


def snapshot(spark):
    """Every table's columns and rows, to compare before and after."""
    return {name: (list(stored.dtypes), sorted(map(repr, stored.rows)))
            for name, stored in spark.tables.items()}


# PR #58's helpers as merged (cdcecad), verbatim: the oracle for what a successful run writes.
OLD_HELPERS = '''\
def month_end(day):
    following = (day.replace(day=28) + timedelta(days=4)).replace(day=1)
    return following - timedelta(days=1)


def history_months(start):
    """(first_full, m0_end) for a window starting on start.

    first_full is the first month the window reads in full. m0_end is the last day of the month it
    starts part-way through (M0), or None when start is the 1st.
    """
    if start.day == 1:
        return start, None
    m0_end = month_end(start)
    return m0_end + timedelta(days=1), m0_end


def keep_partial_month(m0_end, stored_ends):
    """Whether M0's stored rows stay rather than being replaced by this run's partial read.

    stored_ends are the end dates (SnapshotDate or PeriodEnd) of the stored rows for M0. They stay
    only if there are some and all were written after M0 ended. Rows written while M0 was still
    running are replaced, so a short DAYS cannot freeze the current month.
    """
    stored_ends = list(stored_ends)
    return bool(stored_ends) and all(day == m0_end for day in stored_ends)


def month_cutoff(table, key, end_column, month_key=lambda day: day):
    """First month a monthly table's write replaces, as a value of its key column.

    That is the first month the window reads in full, or M0 as well unless its stored rows stay.
    """
    first_full, m0_end = history_months(start)
    if m0_end is None:
        return month_key(first_full)
    stored = []
    if spark.catalog.tableExists(table):
        stored = [row[0] for row in spark.table(table)
                  .filter(F.col(key) == F.lit(month_key(m0_end)))
                  .select(end_column).distinct().collect()]
    return month_key(first_full if keep_partial_month(m0_end, stored) else m0_end.replace(day=1))


class WindowEmptied(RuntimeError):
    """Raised when write_window deleted a table's window but could not append the new rows."""


def write_window(frame, table, column, cutoff):
    """Replace table's rows from cutoff on with frame's, keeping every older row.

    A row is from cutoff on when column is null or >= cutoff. The first run creates the table from
    the whole frame. Later runs delete those rows, then append frame's: two commits, so if the
    append fails (WindowEmptied) the window stays empty until the next successful run, but older
    rows are untouched.
    """
    if not spark.catalog.tableExists(table):
        frame.write.format("delta").saveAsTable(table)
        print(f"wrote {table}: {frame.count():,} rows (new table)")
        return
    stored = {name.lower(): kind for name, kind in spark.table(table).dtypes}
    for name, kind in frame.dtypes:
        if stored.get(name.lower(), kind) != kind:
            raise RuntimeError(f"{table}.{name} is {stored[name.lower()]} in the Lakehouse but {kind} "
                               f"here, so nothing was deleted. To start over, drop {table} and run "
                               "the notebook again; its older rows are lost.")
    replace = F.col(column).isNull() | (F.col(column) >= F.lit(cutoff))
    rows = frame.filter(replace)
    written = rows.count()
    kept = spark.table(table).filter(~replace).count()
    DeltaTable.forName(spark, table).delete(replace)
    try:
        rows.write.format("delta").mode("append").option("mergeSchema", "true").saveAsTable(table)
    except Exception as exc:
        raise WindowEmptied(f"{table}: rows from {cutoff} on were deleted but the append failed. "
                            "They stay empty until the next successful run, which restores only "
                            "the days still in its window, so run again soon. Older rows are "
                            f"untouched ({type(exc).__name__}: {exc})") from exc
    print(f"wrote {table}: {written:,} rows from {cutoff} on; kept {kept:,} older rows")
'''
OLD_CODE = compile(OLD_HELPERS, "PR #58 (cdcecad)", "exec")
# The column and cutoff #58 passed to write_window for each table.
OLD_WRITES = {
    "LAKEHOUSE_SPEND": ("UsageDate", "start"),
    "LAKEHOUSE_TOKENS": ("Date", "start"),
    "LAKEHOUSE_PAYG": ("UsageDate", "start"),
    "LAKEHOUSE_HEALTH": ("MetricDate", 'month_cutoff(LAKEHOUSE_HEALTH, "MetricDate", "SnapshotDate")'),
    "LAKEHOUSE_SOLUTION": ("UsageDate", "start"),
    "LAKEHOUSE_RECON": ("Period", 'month_cutoff(LAKEHOUSE_RECON, "Period", "PeriodEnd", '
                                  'lambda day: f"{day:%Y-%m}")'),
}
OLD_CUTS = {name: compile(cut, "PR #58 (cdcecad)", "eval") for name, (_, cut) in OLD_WRITES.items()}


class Old58:
    """#58's write path on a Lakehouse stand-in of its own."""

    def __init__(self):
        self.spark = FakeSpark()
        self.ns = {"date": date, "timedelta": timedelta, "spark": self.spark, "F": FUNCTIONS,
                   "DeltaTable": FakeDeltaTable, "print": lambda *args, **kwargs: None, **TABLE}
        exec(OLD_CODE, self.ns)

    def cut(self, name, start):
        self.ns["start"] = start
        return eval(OLD_CUTS[name], self.ns)

    def write(self, frame, table, start):
        name = NAME[table]
        rows = [dict(row) for row in frame.materialise()]
        self.ns["write_window"](Frame(self.spark, frame.dtypes, rows), table, OLD_WRITES[name][0],
                                self.cut(name, start))


INVENTORY = [{"ResourceId": "rid", "DeploymentName": "chat", "Application": "", "ModelName": "model",
              "ModelVersion": "1", "SkuName": "GlobalStandard", "Region": "region",
              "PtuCapacity": None}]


def unexpected(*args, **kwargs):
    raise AssertionError("not called when no meter has a valid ID")


def run_statements():
    """The notebook's statements that build and write the six tables, in notebook order."""
    body = [STEPS["detail_warnings"], STEPS["spend_frame"], STEPS["tokens_frame"],
            STEPS["payg_frame"]]
    for site in SITES:
        if site.table == "LAKEHOUSE_HEALTH":
            body.append(STEPS["health"])
        if not any(statement is site.statement for statement in body):
            body.append(site.statement)
    return compile(ast.Module(body=body, type_ignores=[]), str(NOTEBOOK), "exec")


RUN = run_statements()
START = compile(ast.Module(body=[STEPS["start"]], type_ignores=[]), str(NOTEBOOK), "exec")


class Simulation:
    """Runs of the notebook's write statements against one Lakehouse, each with one row of
    collected data per day of its window (amount for every value)."""

    def __init__(self):
        self.spark, self.notes = FakeSpark(), []
        self.ns = notebook(
            self.spark, accounts=[{"id": "/subscriptions/sub/accounts/acct", "name": "acct"}],
            inventory=INVENTORY, SUBSCRIPTION_ID="sub", subscription_name="Subscription", res=[],
            tags={}, service_filter={}, solution_filter={}, found=[],
            monitor_usage=lambda points, accounts: {}, retail_prices=unexpected,
            retail_price_map=unexpected)

    def run_on(self, end, days, sources_fail=False, amount=1.0):
        """Run with the window ending on end (exclusive). sources_fail makes Cost Management and
        the deployment inventory fail, so only the strict tables have data."""
        ns = self.ns
        ns.update(end=end, DAYS=days)
        exec(START, ns)
        start = ns["start"]
        window = [start + timedelta(days=offset) for offset in range((end - start).days)]
        costs = [{"UsageDate": int(f"{day:%Y%m%d}"), "Cost": amount, "Currency": "USD",
                  "ServiceName": "Foundry Models", "ResourceGuid": "meter", "UsageQuantity": 1.0}
                 for day in window]

        def cost_detail(*args):
            if sources_fail:
                raise OSError("simulated Cost Management failure")
            return [dict(row) for row in costs]

        ns.update(
            recs=[{"UsageDate": day, "ServiceName": "Foundry Models", "Cost": amount,
                   "Currency": "USD"} for day in window],
            payg_recs=[{"UsageDate": day, "Cost": amount, "Currency": "USD"} for day in window],
            points=[{"Date": day, "Deployment": "chat", "Metric": "TotalTokens", "Value": amount}
                    for day in window],
            health_acc={("rid", "chat", day): {"requests": amount, "name": "chat"}
                        for day in window},
            inventory_failures=len(ns["accounts"]) if sources_fail else 0,
            cost_detail=cost_detail,
            solution_rows=lambda *args: [{"UsageDate": day, "ActualCost": amount,
                                          "Currency": "USD"} for day in window])
        try:
            exec(RUN, ns)
        finally:
            self.notes.extend(ns["detail_warnings"])


class SimulatedDelta(unittest.TestCase):
    """The stand-in applies Delta's rules, so passing tests mean the writes would be accepted."""

    DTYPES = [("UsageDate", "date"), ("Cost", "double")]
    SCHEMA = "UsageDate date, Cost double"
    PREDICATE = "`UsageDate` >= DATE '2026-06-02' OR `UsageDate` IS NULL"

    def setUp(self):
        self.spark = FakeSpark()
        self.spark.tables["t"] = Stored(self.DTYPES, [
            {"UsageDate": date(2026, 6, 1), "Cost": 1.0},
            {"UsageDate": date(2026, 6, 2), "Cost": 1.0},
            {"UsageDate": None, "Cost": 1.0}])

    def values(self, condition):
        test = row_test(condition, self.DTYPES)
        return [test(row) for row in self.spark.tables["t"].rows]

    def write(self, rows, schema=SCHEMA, predicate=PREDICATE, merge=True, mode="overwrite"):
        writer = self.spark.createDataFrame(rows, schema).write.format("delta")
        if mode:
            writer = writer.mode(mode)
        if predicate:
            writer = writer.option("replaceWhere", predicate)
        if merge:
            writer = writer.option("mergeSchema", "true")
        writer.saveAsTable("t")

    def test_conditions_follow_sql_null_logic(self):
        after = "`UsageDate` >= DATE '2026-06-02'"
        self.assertEqual(self.values(after), [False, True, None])
        self.assertEqual(self.values(f"NOT ({after})"), [True, False, None])
        self.assertEqual(self.values(self.PREDICATE), [False, True, True])
        self.assertEqual(self.values(f"NOT ({self.PREDICATE})"), [True, False, False])
        self.assertEqual(
            self.values("usagedate IS NOT NULL AND `UsageDate` <= DATE '2026-06-01'"),
            [True, False, False])

    def test_malformed_conditions_fail_before_any_row_is_read(self):
        for text in ["`Missing` >= DATE '2026-06-02'", "`UsageDate` >= '2026-06-02'",
                     "`Cost` >= DATE '2026-06-02'", "`UsageDate` >= DATE",
                     "`UsageDate` IS NULL OR", "`UsageDate` >= DATE '2026-13-02'",
                     "`UsageDate` IS NULL `Cost`"]:
            with self.subTest(text=text), self.assertRaises(RuntimeError):
                row_test(text, self.DTYPES)

    def test_replace_where_keeps_rows_outside_it_and_merges_new_columns(self):
        self.write([{"UsageDate": date(2026, 6, 3), "Cost": 2.0, "Currency": "USD"}],
                   self.SCHEMA + ", Currency string")
        stored = self.spark.tables["t"]
        self.assertEqual(stored.dtypes, self.DTYPES + [("Currency", "string")])
        self.assertEqual(stored.rows, [
            {"UsageDate": date(2026, 6, 1), "Cost": 1.0, "Currency": None},
            {"UsageDate": date(2026, 6, 3), "Cost": 2.0, "Currency": "USD"}])
        self.assertEqual(self.spark.log, [("replace", "t", self.PREDICATE, 1)])

    def test_writes_that_break_the_rules_fail_and_change_nothing(self):
        cases = {
            "new column without mergeSchema": dict(
                rows=[{"UsageDate": date(2026, 6, 3), "Cost": 2.0, "Currency": "USD"}],
                schema=self.SCHEMA + ", Currency string", merge=False),
            "row outside the predicate": dict(rows=[{"UsageDate": date(2026, 6, 1), "Cost": 2.0}]),
            "null outside a predicate without IS NULL": dict(
                rows=[{"UsageDate": None, "Cost": 2.0}],
                predicate="`UsageDate` >= DATE '2026-06-02'"),
            "changed column type": dict(rows=[{"UsageDate": date(2026, 6, 3), "Cost": "2.0"}],
                                        schema="UsageDate date, Cost string"),
            "plain save to an existing table": dict(
                rows=[{"UsageDate": date(2026, 6, 3), "Cost": 2.0}], predicate=None, merge=False,
                mode=None),
        }
        for case, write in cases.items():
            with self.subTest(case=case):
                self.setUp()
                before = snapshot(self.spark)
                with self.assertRaises(RuntimeError):
                    self.write(**write)
                self.assertEqual(snapshot(self.spark), before)
                self.assertEqual(self.spark.log, [])

    def test_append_and_overwrite(self):
        self.write([{"UsageDate": date(2026, 6, 3), "Cost": 2.0}], predicate=None, merge=False,
                   mode="append")
        self.assertEqual(len(self.spark.tables["t"].rows), 4)
        self.write([{"UsageDate": date(2026, 6, 3), "Cost": 2.0}], predicate=None, merge=False)
        self.assertEqual(self.spark.tables["t"].rows, [{"UsageDate": date(2026, 6, 3), "Cost": 2.0}])
        self.assertEqual(self.spark.log, [("append", "t", 1), ("overwrite", "t", 1)])


class WriteWindows(unittest.TestCase):
    """The notebook's write_windows on its own."""

    DAY = date(2026, 6, 10)
    DAILY = "UsageDate date, Cost double"

    def setUp(self):
        self.spark = FakeSpark()
        self.ns = notebook(self.spark)
        self.printed = self.ns["printed"]

    def day(self, offset):
        return self.DAY + timedelta(days=offset)

    def frame(self, offsets, cost=1.0, schema=DAILY):
        return self.spark.createDataFrame(
            [{"UsageDate": None if offset is None else self.day(offset), "Cost": cost}
             for offset in offsets], schema)

    def write(self, *entries):
        """Write (table, frame, cut offset) entries in one call."""
        self.ns["write_windows"]([(frame, table, "UsageDate", self.day(cut))
                                  for table, frame, cut in entries])

    def rows(self, table):
        rows = [(lookup(row, "UsageDate"), lookup(row, "Cost"))
                for row in self.spark.tables[table].rows]
        return sorted(rows, key=lambda row: (row[0] is None, row[0] or date.min))

    def test_window_predicate(self):
        self.assertEqual(self.ns["window_predicate"]("UsageDate", date(2026, 7, 1)),
                         "`UsageDate` >= DATE '2026-07-01' OR `UsageDate` IS NULL")

    def test_new_table_gets_only_the_window(self):
        self.write(("t", self.frame([-1, 0, 1, None]), 0))
        self.assertEqual(self.rows("t"), [(self.day(0), 1.0), (self.day(1), 1.0), (None, 1.0)])
        self.assertEqual(self.spark.log, [("create", "t", 3)])
        self.assertEqual(self.printed, ["wrote t: 3 rows (new table)"])

    def test_reload_keeps_older_rows(self):
        self.write(("t", self.frame([-3, -2, -1, 0, None]), -3))
        self.printed.clear()
        self.write(("t", self.frame([-1, 0, 1], 2.0), 0))
        self.assertEqual(self.rows("t"), [(self.day(-3), 1.0), (self.day(-2), 1.0),
                                          (self.day(-1), 1.0), (self.day(0), 2.0),
                                          (self.day(1), 2.0)])
        self.assertEqual(self.spark.log[-1], (
            "replace", "t", "`UsageDate` >= DATE '2026-06-10' OR `UsageDate` IS NULL", 2))
        self.assertEqual(self.printed, ["wrote t: 2 rows from 2026-06-10 on; kept 3 older rows"])

    def test_empty_frame_still_replaces_its_window(self):
        self.write(("t", self.frame([-1, 0, 1]), -1))
        self.write(("t", self.frame([]), 0))
        self.assertEqual(self.rows("t"), [(self.day(-1), 1.0)])
        self.assertEqual(self.printed[-1], "wrote t: 0 rows from 2026-06-10 on; kept 1 older rows")

    def test_changed_type_stops_every_write(self):
        for stored_name in ("Cost", "cost"):
            with self.subTest(stored=stored_name):
                self.setUp()
                self.write(("a", self.frame([0]), 0))
                self.spark.tables["b"] = Stored([("UsageDate", "date"), (stored_name, "string")], [])
                self.spark.log.clear()
                with self.assertRaises(RuntimeError) as caught:
                    self.write(("a", self.frame([0], 2.0), 0), ("b", self.frame([0], 2.0), 0))
                self.assertEqual(str(caught.exception), (
                    "b.Cost is string in the Lakehouse but double here, so nothing was written. "
                    "To start over, drop b and run the notebook again; its older rows are lost."))
                self.assertEqual(self.spark.log, [])
                self.assertEqual(self.rows("a"), [(self.day(0), 1.0)])

    def test_columns_match_case_insensitively_and_new_ones_are_added(self):
        self.spark.tables["t"] = Stored([("usagedate", "date"), ("cost", "double")], [
            {"usagedate": self.day(-1), "cost": 1.0}, {"usagedate": self.day(0), "cost": 1.0}])
        self.write(("t", self.frame([0], 2.0, self.DAILY + ", Currency string"), 0))
        stored = self.spark.tables["t"]
        self.assertEqual(stored.dtypes, [("usagedate", "date"), ("cost", "double"),
                                         ("Currency", "string")])
        self.assertEqual(stored.rows, [
            {"usagedate": self.day(-1), "cost": 1.0, "Currency": None},
            {"usagedate": self.day(0), "cost": 2.0, "Currency": None}])

    def test_table_that_cannot_be_read_stops_every_write(self):
        for failure in ("unopenable", "unreadable"):
            with self.subTest(failure=failure):
                self.setUp()
                self.write(("a", self.frame([0]), 0), ("b", self.frame([0]), 0))
                self.spark.log.clear()
                getattr(self.spark, failure).add("b")
                with self.assertRaises(OSError):
                    self.write(("a", self.frame([0], 2.0), 0), ("b", self.frame([0], 2.0), 0))
                self.assertEqual(self.spark.log, [])
                self.assertEqual(self.rows("a"), [(self.day(0), 1.0)])

    def test_failed_write_leaves_its_table_as_it_was(self):
        self.write(("a", self.frame([0]), 0), ("b", self.frame([0]), 0), ("c", self.frame([0]), 0))
        self.spark.fail_write.add("b")
        with self.assertRaises(OSError):
            self.write(("a", self.frame([0, 1], 2.0), 0), ("b", self.frame([0, 1], 2.0), 0),
                       ("c", self.frame([0, 1], 2.0), 0))
        self.assertEqual(self.rows("a"), [(self.day(0), 2.0), (self.day(1), 2.0)])
        self.assertEqual(self.rows("b"), [(self.day(0), 1.0)])
        self.assertEqual(self.rows("c"), [(self.day(0), 1.0)])


class MonthlyReplaceFrom(unittest.TestCase):
    """The shared first-month rule. A window that starts after the 1st keeps that month's stored
    rows only when all of them were written after the month ended."""

    FEB = date(2026, 2, 28)

    def setUp(self):
        self.replace_from = notebook(FakeSpark())["monthly_replace_from"]

    def test_window_starting_on_the_first_replaces_its_month(self):
        self.assertEqual(self.replace_from(date(2026, 3, 1), [(date(2026, 3, 31),
                                                               date(2026, 3, 31))]),
                         date(2026, 3, 1))

    def test_month_read_after_it_ended_stays(self):
        self.assertEqual(self.replace_from(date(2026, 2, 9), [(self.FEB, self.FEB)]),
                         date(2026, 3, 1))

    def test_month_read_while_it_ran_is_replaced(self):
        for stored in ([(self.FEB, date(2026, 2, 20))],
                       [(self.FEB, self.FEB), (self.FEB, date(2026, 2, 20))],
                       [(self.FEB, None)], [(self.FEB, self.FEB), (self.FEB, None)], []):
            with self.subTest(stored=stored):
                self.assertEqual(self.replace_from(date(2026, 2, 9), stored), date(2026, 2, 1))

    def test_other_months_are_ignored(self):
        stored = [(date(2026, 1, 31), date(2026, 1, 20)), (self.FEB, self.FEB),
                  (date(2026, 3, 31), date(2026, 3, 5)), (None, None)]
        self.assertEqual(self.replace_from(date(2026, 2, 9), stored), date(2026, 3, 1))

    def test_year_boundary(self):
        december = date(2025, 12, 31)
        self.assertEqual(self.replace_from(date(2025, 12, 15), [(december, december)]),
                         date(2026, 1, 1))

    def test_one_day_windows(self):
        for start in (date(2026, 2, 28), date(2024, 2, 29)):
            with self.subTest(start=start):
                self.assertEqual(self.replace_from(start, [(start, start)]),
                                 start + timedelta(days=1))

    def test_default_ninety_days(self):
        start = date(2026, 5, 10) - timedelta(days=90)
        self.assertEqual(start, date(2026, 2, 9))
        self.assertEqual(self.replace_from(start, [(self.FEB, self.FEB)]), date(2026, 3, 1))

    def test_running_month_is_never_kept(self):
        # DAYS=5 on 20 March: the window starts on the 15th, and the stored March rows were read
        # the day before, up to the 18th.
        self.assertEqual(self.replace_from(date(2026, 3, 15),
                                           [(date(2026, 3, 31), date(2026, 3, 18))]),
                         date(2026, 3, 1))

    def test_month_forms(self):
        for month in (date(2026, 2, 1), date(2026, 2, 14), "2026-02-28",
                      datetime(2026, 2, 28, 12)):
            with self.subTest(month=month):
                self.assertEqual(self.replace_from(date(2026, 2, 9), [(month, self.FEB)]),
                                 date(2026, 3, 1))
        self.assertEqual(self.replace_from(date(2026, 2, 9), [("2026-02", self.FEB)]),
                         date(2026, 2, 1))


class MonthlyCut(unittest.TestCase):
    """The first day each monthly write replaces, from the notebook's own cut expressions."""

    JUNE = date(2026, 6, 30)

    def cut(self, name, start, stored):
        """stored is None for no table, else (month end, last day covered) pairs."""
        spark = FakeSpark()
        column, covered = RELOAD[name]
        if stored is not None:
            rows = []
            for month, read in stored:
                row = {column: month, covered: read}
                if name == "LAKEHOUSE_RECON":
                    row.update(Period=f"{month:%Y-%m}" if month else None,
                               PeriodStart=month.replace(day=1) if month else None)
                rows.append(row)
            spark.tables[TABLE[name]] = Stored(list(schema_of(SITE[name].frame).items()), rows)
        result = evaluate(SITE[name].cut, notebook(spark, start=start))
        self.assertEqual(spark.log, [])
        return result

    def check(self, start, stored, expected):
        for name in MONTHLY:
            with self.subTest(table=name, start=start, stored=stored):
                self.assertEqual(self.cut(name, start, stored), expected)

    def test_cases_from_valuelens(self):
        june_12 = date(2026, 6, 12)
        self.check(june_12, None, date(2026, 6, 1))
        self.check(june_12, [], date(2026, 6, 1))
        self.check(june_12, [(self.JUNE, self.JUNE)], date(2026, 7, 1))
        self.check(june_12, [(self.JUNE, date(2026, 6, 20))], date(2026, 6, 1))
        self.check(date(2026, 6, 1), [(self.JUNE, self.JUNE)], date(2026, 6, 1))
        self.check(june_12, [(self.JUNE, self.JUNE), (self.JUNE, date(2026, 6, 20))],
                   date(2026, 6, 1))
        self.check(june_12, [(self.JUNE, self.JUNE), (self.JUNE, None)], date(2026, 6, 1))
        self.check(june_12, [(date(2026, 5, 31), date(2026, 5, 20)),
                             (date(2026, 7, 31), date(2026, 7, 2))], date(2026, 6, 1))
        self.check(date(2026, 12, 5), [(date(2026, 12, 31), date(2026, 12, 31))],
                   date(2027, 1, 1))

    def test_cases_from_pr58(self):
        jan, feb = date(2026, 1, 31), date(2026, 2, 28)
        self.check(date(2026, 3, 1), [(feb, feb)], date(2026, 3, 1))
        self.check(date(2026, 2, 9), None, date(2026, 2, 1))
        self.check(date(2026, 2, 9), [(jan, jan), (feb, feb)], date(2026, 3, 1))
        self.check(date(2026, 2, 9), [(feb, date(2026, 2, 20))], date(2026, 2, 1))
        self.check(date(2026, 2, 9), [(jan, jan)], date(2026, 2, 1))
        self.check(date(2026, 3, 15), [(date(2026, 3, 31), date(2026, 3, 18))], date(2026, 3, 1))
        self.check(date(2025, 12, 15), [(date(2025, 12, 31), date(2025, 12, 20))],
                   date(2025, 12, 1))


class MatchesPR58(unittest.TestCase):
    """A successful run writes what #58 wrote: the same first month, and the same rows."""

    @staticmethod
    def states(start):
        """Stored rows as (MetricDate, last day covered, PeriodStart) triples."""
        first, last = start.replace(day=1), month_end(start)
        before, after = first - timedelta(days=1), last + timedelta(days=1)
        return [
            [],
            [(last, last, first)],
            [(last, last, first), (last, last, start)],
            [(last, last - timedelta(days=1), first)],
            [(last, last, first), (start, start, start)],
            [(last, None, first)],
            [(last, last, first), (last, None, first)],
            [(before, before, before.replace(day=1))],
            [(before, before, before.replace(day=1)), (last, last, first)],
            [(None, first, None), (last, last, first)],
            [(month_end(after), month_end(after), after), (last, last, first)],
            [(last, first, start)],
        ]

    def test_first_month_rule_agrees_with_pr58(self):
        old = {"timedelta": timedelta}
        exec(OLD_CODE, old)
        replace_from = notebook(FakeSpark())["monthly_replace_from"]
        start = date(2023, 1, 1)
        while start <= date(2028, 12, 31):
            first_full, m0_end = old["history_months"](start)
            for state in self.states(start):
                for pairs in ([(m, c) for m, c, r in state], [(r, c) for m, c, r in state]):
                    if m0_end is None:
                        expected = first_full
                    else:
                        ends = [c for x, c in pairs
                                if x is not None and old["month_end"](x) == m0_end]
                        expected = (first_full if old["keep_partial_month"](m0_end, ends)
                                    else m0_end.replace(day=1))
                    got = replace_from(start, pairs)
                    self.assertEqual(got, expected, (start, pairs))
                    self.assertEqual(got.day, 1, (start, pairs))
            start += timedelta(days=1)

    def test_monthly_cuts_agree_with_pr58_on_stored_tables(self):
        spark, old = FakeSpark(), Old58()
        ns = notebook(spark)
        cuts = {name: compile(ast.Expression(body=SITE[name].cut), str(NOTEBOOK), "eval")
                for name in MONTHLY}
        health = list(schema_of(SITE["LAKEHOUSE_HEALTH"].frame).items())
        recon = list(schema_of(SITE["LAKEHOUSE_RECON"].frame).items())
        starts = ([date(2025, 11, 1) + timedelta(days=n) for n in range(151)]
                  + [date(2024, 2, 1) + timedelta(days=n) for n in range(60)])
        for start in starts:
            ns["start"] = start
            for state in [None] + self.states(start):
                for fake in (spark, old.spark):
                    fake.tables.clear()
                    if state is None:
                        continue
                    fake.tables[HEALTH] = Stored(health, [
                        {"MetricDate": month_end(m) if m else None, "SnapshotDate": c}
                        for m, c, r in state])
                    fake.tables[RECON] = Stored(recon, [
                        {"Period": f"{r:%Y-%m}" if r else None, "PeriodStart": r, "PeriodEnd": c}
                        for m, c, r in state])
                context = (start, state)
                self.assertEqual(eval(cuts["LAKEHOUSE_HEALTH"], ns),
                                 old.cut("LAKEHOUSE_HEALTH", start), context)
                cut = eval(cuts["LAKEHOUSE_RECON"], ns)
                self.assertEqual((f"{cut:%Y-%m}", cut.day),
                                 (old.cut("LAKEHOUSE_RECON", start), 1), context)
        self.assertEqual((spark.log, old.spark.log), ([], []))

    def test_runs_write_what_pr58_wrote(self):
        rng = random.Random(58)
        for sequence in range(12):
            sim, old = Simulation(), Old58()
            write = sim.ns["write_windows"]

            def both(writes, write=write, sim=sim, old=old):
                for frame, table, column, cut in writes:
                    old.write(frame, table, sim.ns["start"])
                write(writes)
            sim.ns["write_windows"] = both
            end = date(2023, 12, 1) + timedelta(days=rng.randrange(1000))
            for run in range(10):
                days = rng.choice([1, 2, 5, 15, 29, 30, 31, 45, 89, 90])
                end += timedelta(days=rng.randrange(13))
                sim.run_on(end, days, amount=float(run + 1))
                context = f"sequence {sequence}, run {run}: {days} days to {end}"
                self.assertEqual(sim.notes, [], context)
                self.assertEqual(snapshot(sim.spark), snapshot(old.spark), context)

    def test_reconciliation_key_selects_the_rows_period_did(self):
        """PeriodStart always falls in its Period's month, and a monthly cut is a month's 1st, so
        keying the reload on PeriodStart replaces and keeps the rows that Period did."""
        rng = random.Random(221)
        ns = notebook(FakeSpark())
        dtypes = parse_schema(ast.literal_eval(DEFINED["RECON_SCHEMA"].value))
        for _ in range(200):
            end = date(2023, 1, 1) + timedelta(days=rng.randrange(2200))
            start = end - timedelta(days=rng.randrange(1, 91))
            costs = [{"UsageDate": int(f"{day:%Y%m%d}"), "Cost": 1.0, "Currency": "USD",
                      "ServiceName": "Foundry Models", "ResourceGuid": "meter",
                      "UsageQuantity": 1.0}
                     for day in (start + timedelta(days=n) for n in range((end - start).days))
                     if rng.random() < 0.3]
            rows = ns["recon_rows"](costs, {}, start, end)
            for row in rows:
                self.assertIsNotNone(row["PeriodStart"])
                self.assertEqual(row["Period"], f"{row['PeriodStart']:%Y-%m}")
                self.assertGreaterEqual(row["PeriodStart"], start)
            for months in range(-2, 4):
                cut = add_months(start, months)
                predicate = ns["window_predicate"]("PeriodStart", cut)
                new, kept = row_test(predicate, dtypes), row_test(f"NOT ({predicate})", dtypes)
                period = FUNCTIONS.col("Period")
                old = period.isNull() | (period >= FUNCTIONS.lit(f"{cut:%Y-%m}"))
                for row in rows:
                    self.assertEqual((new(row), kept(row)), (old(row), (~old)(row)),
                                     (start, end, cut, row))


class Reloads(unittest.TestCase):
    """Runs of the notebook's own write statements against one Lakehouse."""

    AMOUNT = {SPEND: "Cost", TOKENS: "Value", PAYG: "Cost", SOLUTION: "ActualCost"}

    def setUp(self):
        self.sim = Simulation()
        self.spark = self.sim.spark

    def daily(self, table, column):
        """{day: amount} for a daily table, whose days must be unique."""
        rows = self.spark.tables[table].rows
        days = {lookup(row, column): lookup(row, self.AMOUNT[table]) for row in rows}
        self.assertEqual(len(days), len(rows), f"{table} has a day twice")
        return days

    def health(self):
        """{MetricDate: (SnapshotDate, Requests)}, one row per month."""
        rows = self.spark.tables[HEALTH].rows
        months = {row["MetricDate"]: (row["SnapshotDate"], row["Requests"]) for row in rows}
        self.assertEqual(len(months), len(rows))
        return months

    def recon(self):
        """{Period: (PeriodStart, PeriodEnd, actual Amount)}, with one actual and one estimate
        row per month."""
        periods = {}
        for row in self.spark.tables[RECON].rows:
            periods.setdefault(row["Period"], []).append(row)
        result = {}
        for period, rows in periods.items():
            self.assertEqual(sorted(row["Representation"] for row in rows),
                             ["AzureActual", "UsageEstimate"], period)
            self.assertEqual(len({(row["PeriodStart"], row["PeriodEnd"]) for row in rows}), 1)
            actual = next(row for row in rows if row["Representation"] == "AzureActual")
            result[period] = (actual["PeriodStart"], actual["PeriodEnd"], actual["Amount"])
        return result

    def logged(self):
        return [entry[1] for entry in self.spark.log]

    def test_daily_runs_keep_every_day_and_finished_month(self):
        end = date(2026, 4, 10)
        while end <= date(2026, 7, 1):
            self.sim.run_on(end, 90)
            end += timedelta(days=1)
        self.assertEqual(self.sim.notes, [])
        first = date(2026, 1, 10)
        for table, column in DAILY_COLUMNS:
            with self.subTest(table=table):
                self.assertEqual(self.daily(table, column),
                                 {first + timedelta(days=n): 1.0 for n in range(172)})
        totals = {date(2026, 1, 31): 22, date(2026, 2, 28): 28, date(2026, 3, 31): 31,
                  date(2026, 4, 30): 30, date(2026, 5, 31): 31, date(2026, 6, 30): 30}
        self.assertEqual(self.health(), {month: (month, float(total))
                                         for month, total in totals.items()})
        self.assertEqual(self.recon(), {
            f"{month:%Y-%m}": (max(month.replace(day=1), first), month, float(total))
            for month, total in totals.items()})

    def test_second_run_on_the_same_day_changes_nothing(self):
        self.sim.run_on(date(2026, 6, 30), 90)
        self.sim.run_on(date(2026, 7, 1), 90)
        before = snapshot(self.spark)
        self.sim.run_on(date(2026, 7, 1), 90)
        self.assertEqual(snapshot(self.spark), before)
        self.assertEqual(self.sim.notes, [])

    def test_lower_days_keeps_older_rows(self):
        self.sim.run_on(date(2026, 6, 30), 90)
        self.sim.run_on(date(2026, 7, 1), 90)
        health, recon = self.health(), self.recon()
        self.sim.run_on(date(2026, 7, 2), 5, amount=2.0)
        self.assertEqual(self.sim.notes, [])
        cut = date(2026, 6, 27)
        for table, column in DAILY_COLUMNS:
            with self.subTest(table=table):
                days = self.daily(table, column)
                self.assertEqual(days, {
                    **{date(2026, 4, 1) + timedelta(days=n): 1.0
                       for n in range((cut - date(2026, 4, 1)).days)},
                    **{cut + timedelta(days=n): 2.0 for n in range(5)}})
        # June was read to its end on 1 July, so the 5-day window keeps it and adds July.
        self.assertEqual(self.health(), {**health, date(2026, 7, 31): (date(2026, 7, 1), 2.0)})
        self.assertEqual(health[date(2026, 6, 30)], (date(2026, 6, 30), 30.0))
        self.assertEqual(self.recon(), {
            **recon, "2026-07": (date(2026, 7, 1), date(2026, 7, 1), 2.0)})

    def test_short_window_replaces_the_month_it_is_still_reading(self):
        self.sim.run_on(date(2026, 7, 1), 90)
        self.sim.run_on(date(2026, 7, 2), 5)
        self.sim.run_on(date(2026, 7, 3), 5)
        self.assertEqual(self.health()[date(2026, 7, 31)], (date(2026, 7, 2), 2.0))
        self.assertEqual(self.recon()["2026-07"], (date(2026, 7, 1), date(2026, 7, 2), 2.0))
        # A window that starts on 3 July covers July only from then; July was still running when
        # it was stored, so it is replaced, as #58 did, and June stays.
        self.sim.run_on(date(2026, 7, 8), 5)
        self.assertEqual(self.health()[date(2026, 7, 31)], (date(2026, 7, 7), 5.0))
        self.assertEqual(self.recon()["2026-07"], (date(2026, 7, 3), date(2026, 7, 7), 5.0))
        self.assertEqual(self.recon()["2026-06"], (date(2026, 6, 1), date(2026, 6, 30), 30.0))
        self.assertEqual(self.sim.notes, [])

    def test_failed_sources_leave_their_tables_unchanged(self):
        self.sim.run_on(date(2026, 7, 1), 90)
        before = snapshot(self.spark)
        self.sim.run_on(date(2026, 7, 2), 90, sources_fail=True)
        after = snapshot(self.spark)
        for table in (HEALTH, SOLUTION, RECON):
            self.assertEqual(after[table], before[table], table)
        self.assertEqual(len(self.sim.notes), 3)
        for message in self.sim.notes:
            self.assertIn("left unchanged", message)

    def test_changed_type_in_a_best_effort_table_leaves_it_unchanged(self):
        self.sim.run_on(date(2026, 7, 1), 90)
        stored = self.spark.tables[RECON]
        stored.dtypes = [(name, "string" if name == "Amount" else kind)
                         for name, kind in stored.dtypes]
        for row in stored.rows:
            row["Amount"] = None if row["Amount"] is None else str(row["Amount"])
        before = snapshot(self.spark)[RECON]
        self.spark.log.clear()
        self.sim.run_on(date(2026, 7, 2), 90)
        self.assertEqual(snapshot(self.spark)[RECON], before)
        self.assertEqual(self.logged(), [SPEND, TOKENS, PAYG, HEALTH, SOLUTION])
        self.assertEqual(len(self.sim.notes), 1)
        self.assertTrue(self.sim.notes[0].startswith(
            f"billing reconciliation failed; {RECON} left unchanged (RuntimeError: "),
            self.sim.notes[0])
        self.assertIn(f"{RECON}.Amount is string in the Lakehouse but double here, so nothing "
                      "was written.", self.sim.notes[0])

    def test_changed_type_in_a_strict_table_writes_nothing(self):
        self.sim.run_on(date(2026, 7, 1), 90)
        stored = self.spark.tables[TOKENS]
        stored.dtypes = [(name, "string" if name == "Value" else kind)
                         for name, kind in stored.dtypes]
        for row in stored.rows:
            row["Value"] = None if row["Value"] is None else str(row["Value"])
        before = snapshot(self.spark)
        self.spark.log.clear()
        with self.assertRaisesRegex(RuntimeError, re.escape(
                f"{TOKENS}.Value is string in the Lakehouse but double here")):
            self.sim.run_on(date(2026, 7, 2), 90)
        self.assertEqual(self.spark.log, [])
        self.assertEqual(snapshot(self.spark), before)

    def test_strict_table_that_cannot_be_read_writes_nothing(self):
        self.sim.run_on(date(2026, 7, 1), 90)
        before = snapshot(self.spark)
        self.spark.log.clear()
        self.spark.unreadable.add(PAYG)
        with self.assertRaisesRegex(OSError, re.escape(f"simulated failure reading {PAYG}")):
            self.sim.run_on(date(2026, 7, 2), 90)
        self.assertEqual(self.spark.log, [])
        self.assertEqual(snapshot(self.spark), before)

    def test_best_effort_failures_leave_only_their_table_unchanged(self):
        prefixes = {
            HEALTH: f"deployment health failed; {HEALTH} left unchanged (OSError: ",
            SOLUTION: f"solution spend failed; {SOLUTION} left unchanged (OSError: ",
            RECON: f"billing reconciliation failed; {RECON} left unchanged (OSError: "}
        for failure, table in [("unreadable", HEALTH), ("fail_write", HEALTH),
                               ("fail_write", SOLUTION), ("unreadable", SOLUTION),
                               ("fail_write", RECON), ("unopenable", RECON)]:
            with self.subTest(failure=failure, table=table):
                self.setUp()
                self.sim.run_on(date(2026, 7, 1), 90)
                before = snapshot(self.spark)[table]
                self.spark.log.clear()
                getattr(self.spark, failure).add(table)
                self.sim.run_on(date(2026, 7, 2), 90)
                self.assertEqual(snapshot(self.spark)[table], before)
                self.assertEqual(self.logged(), [TABLE[name] for name in WRITE_ORDER
                                                 if TABLE[name] != table])
                self.assertEqual(len(self.sim.notes), 1, self.sim.notes)
                self.assertTrue(self.sim.notes[0].startswith(prefixes[table]), self.sim.notes[0])

    def test_failed_write_loses_no_day(self):
        # With #58's delete then append, a failed append emptied the window, and a run a day later
        # could no longer restore its first day.
        self.sim.run_on(date(2026, 6, 30), 90)
        before = snapshot(self.spark)
        self.spark.fail_write.update({SOLUTION, RECON})
        self.sim.run_on(date(2026, 7, 1), 90)
        for table in (SOLUTION, RECON):
            self.assertEqual(snapshot(self.spark)[table], before[table], table)
        self.assertEqual(len(self.sim.notes), 2)
        self.spark.fail_write.clear()
        self.sim.run_on(date(2026, 7, 2), 90)
        self.assertEqual(self.daily(SOLUTION, "UsageDate"),
                         {date(2026, 4, 1) + timedelta(days=n): 1.0 for n in range(92)})
        self.assertEqual(self.recon(), {
            "2026-04": (date(2026, 4, 1), date(2026, 4, 30), 30.0),
            "2026-05": (date(2026, 5, 1), date(2026, 5, 31), 31.0),
            "2026-06": (date(2026, 6, 1), date(2026, 6, 30), 30.0),
            "2026-07": (date(2026, 7, 1), date(2026, 7, 1), 1.0)})


class Structure(unittest.TestCase):
    """How the notebook writes, so the tests above cover every write it makes."""

    def test_only_write_windows_writes(self):
        writes = {"write", "writeTo", "saveAsTable", "save", "insertInto", "mode", "option",
                  "delete", "forName"}
        for index, tree in enumerate(TREES):
            for statement in tree.body:
                if statement is DEFINED["write_windows"]:
                    continue
                for node in ast.walk(statement):
                    if isinstance(node, ast.Attribute):
                        self.assertNotIn(node.attr, writes, f"code cell {index}: "
                                                            f"{ast.unparse(node)}")
            if index != HELPER_CELL:
                self.assertIsNone(re.search(r"overwrite|replacewhere|DeltaTable|\.delete\(",
                                            CODE[index], re.IGNORECASE), f"code cell {index}")

    def test_each_table_is_written_once_in_order_with_its_window(self):
        self.assertEqual([site.table for site in SITES], WRITE_ORDER)
        self.assertEqual({site.table: (site.column, covered_column(site)) for site in SITES},
                         RELOAD)
        for site in SITES:
            schema = schema_of(site.frame)
            for column in filter(None, RELOAD[site.table]):
                self.assertEqual(schema[column], "date", (site.table, column))

    def test_strict_tables_are_checked_together_and_the_rest_are_best_effort(self):
        strict = [SITE[name] for name in STRICT]
        self.assertEqual(len({id(site.call) for site in strict}), 1)
        call, statement = strict[0].call, strict[0].statement
        self.assertEqual(len(call.args[0].elts), 3)
        self.assertIsInstance(statement, ast.Expr)
        self.assertIs(statement.value, call)
        for site in SITES:
            if site.table in STRICT:
                continue
            with self.subTest(table=site.table):
                self.assertEqual(len(site.call.args[0].elts), 1)
                tries = [node for node in ast.walk(site.statement) if isinstance(node, ast.Try)
                         and any(inner is site.call for body in node.body
                                 for inner in ast.walk(body))]
                self.assertEqual(len(tries), 1)
                self.assertEqual(len(tries[0].handlers), 1)
                handler = tries[0].handlers[0]
                self.assertEqual(ast.unparse(handler.type), "Exception")
                notes = [node for node in ast.walk(handler) if isinstance(node, ast.Call)
                         and isinstance(node.func, ast.Name) and node.func.id == "note"]
                self.assertEqual(len(notes), 1)
                self.assertIn("left unchanged", ast.unparse(notes[0]))

    def test_helpers_are_defined_before_the_writes(self):
        self.assertEqual([(type(node).__name__, getattr(node, "name", None))
                          for node in TREES[HELPER_CELL].body],
                         [("FunctionDef", "window_predicate"), ("FunctionDef", "monthly_cut"),
                          ("FunctionDef", "write_windows")])
        self.assertLess(HELPER_CELL, min(site.cell for site in SITES))
        replace_cell = next(index for index, tree in enumerate(TREES)
                            if DEFINED["monthly_replace_from"] in tree.body)
        self.assertLess(replace_cell, min(SITE[name].cell for name in MONTHLY))


if __name__ == "__main__":
    unittest.main()
