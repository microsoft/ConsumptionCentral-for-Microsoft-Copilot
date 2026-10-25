"""Offline tests that Ingest_Studio writes each table in one Delta commit and still ends every run as before.

The notebook's own cells run against a small in-memory stand-in for Spark and Delta. It evaluates eagerly,
applies replaceWhere's rules, and fails loudly on anything it doesn't model, so the tests need only the
standard library. OLD is the notebook at 99f68c3, rebuilt from the current cells by swapping each write
site back to its delete, then merge. OLD is the oracle: every successful run must leave the tables exactly
as OLD leaves them. The failure tests check that a write that fails leaves its table as it was, and that the
next day's run ends where it would have if nothing had failed.
"""
import builtins
import functools
from collections import Counter
import csv
from datetime import date, datetime, time, timedelta
import io
import itertools
import json
import linecache
import math
import operator
from pathlib import Path
import re
import subprocess
import traceback
from types import ModuleType, SimpleNamespace
import unittest


REPO = Path(__file__).resolve().parents[2]
NOTEBOOK_PATH = "2. Fabric/notebooks/Ingest_Studio.ipynb"
ORACLE_COMMIT = "99f68c3"


class AnalysisError(Exception):
    """What Spark raises for a query it can't plan: a missing table or column, say."""


class DeltaError(Exception):
    """What Delta raises for a write it refuses."""


class SimulatedFailure(Exception):
    """A write a test makes fail, before it changes anything."""


def not_modelled(what):
    return AssertionError(f"not modelled by the fake Spark: {what}")


# Types -------------------------------------------------------------------------------------------------

class DataType:
    def __init__(self, name, element=None):
        self.name, self.element = name, element

    def simpleString(self):
        return f"array<{self.element.simpleString()}>" if self.name == "array" else self.name

    def __eq__(self, other):
        return isinstance(other, DataType) and self.simpleString() == other.simpleString()

    def __hash__(self):
        return hash(self.simpleString())

    def __repr__(self):
        return self.simpleString()


STRING, DOUBLE, DATE, TIMESTAMP = DataType("string"), DataType("double"), DataType("date"), DataType("timestamp")
BOOLEAN, INT, BIGINT, VOID = DataType("boolean"), DataType("int"), DataType("bigint"), DataType("void")
NUMERIC = {INT, BIGINT, DOUBLE}
TYPE_NAMES = {"string": STRING, "double": DOUBLE, "date": DATE, "timestamp": TIMESTAMP, "boolean": BOOLEAN,
              "int": INT, "integer": INT, "bigint": BIGINT, "long": BIGINT}
# The Python type each Spark type's values have here. Exact: a bool isn't an int, a datetime isn't a date.
PYTHON_TYPES = {STRING: str, DOUBLE: float, DATE: date, TIMESTAMP: datetime, BOOLEAN: bool, INT: int, BIGINT: int}


def ArrayType(element):
    return DataType("array", element)


def to_type(t):
    if isinstance(t, DataType):
        return t
    if isinstance(t, str) and t.strip().lower() in TYPE_NAMES:
        return TYPE_NAMES[t.strip().lower()]
    raise not_modelled(f"type {t!r}")


def fits(value, dtype):
    if value is None:
        return True
    if dtype.name == "array":
        return isinstance(value, tuple) and all(fits(v, dtype.element) for v in value)
    return type(value) is PYTHON_TYPES.get(dtype)


class StructField:
    def __init__(self, name, dataType, nullable=True):
        self.name, self.dataType, self.nullable = name, dataType, nullable


class StructType(list):
    @property
    def names(self):
        return [f.name for f in self]


# Values ------------------------------------------------------------------------------------------------

DATE_TEXT = re.compile(r"(\d{4})(?:-(\d{1,2})(?:-(\d{1,2})(?:[ T].*)?)?)?")
US_DATE_TIME = re.compile(r"(\d{1,2})/(\d{1,2})/(\d{4}) (\d{1,2}):(\d{2})")
NUMBER = re.compile(r"[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?")


def parse_date(text, fmt=None):
    """Spark's to_date: None for text it can't parse."""
    if fmt is None:
        m = DATE_TEXT.fullmatch(text.strip())
        parts = (m.group(1), m.group(2) or 1, m.group(3) or 1) if m else None
    elif fmt == "M/d/yyyy H:mm":
        m = US_DATE_TIME.fullmatch(text)
        parts = (m.group(3), m.group(1), m.group(2)) if m and int(m.group(4)) < 24 and int(m.group(5)) < 60 else None
    else:
        raise not_modelled(f"date format {fmt!r}")
    if parts is None:
        return None
    try:
        return date(*map(int, parts))
    except ValueError:
        return None


def caster(source, target):
    """Spark's cast, for the casts the notebook makes."""
    if source == target:
        return lambda v: v
    if source == VOID:
        return lambda v: None
    if source == STRING and target == DOUBLE:
        return lambda v: float(v.strip()) if v is not None and NUMBER.fullmatch(v.strip()) else None
    if source in (INT, BIGINT) and target == DOUBLE:
        return lambda v: None if v is None else float(v)
    if source == STRING and target == DATE:
        return lambda v: None if v is None else parse_date(v)
    if source == TIMESTAMP and target == DATE:
        return lambda v: None if v is None else v.date()
    raise not_modelled(f"cast from {source} to {target}")


def store_caster(source, target, column):
    """What a write or a merge does with a value for an existing column: safe upcasts only."""
    if source == target:
        return lambda v: v
    if source == VOID:
        return lambda v: None
    if source in (INT, BIGINT) and target == DOUBLE:
        return lambda v: None if v is None else float(v)
    raise AnalysisError(f"[DELTA_FAILED_TO_MERGE_FIELDS] {column}: can't write {source} into {target}")


def lit_type(value):
    for python_type, dtype in ((type(None), VOID), (bool, BOOLEAN), (int, INT), (float, DOUBLE), (str, STRING),
                               (datetime, TIMESTAMP), (date, DATE)):
        if type(value) is python_type:
            return dtype
    raise not_modelled(f"literal {value!r}")


# Columns -----------------------------------------------------------------------------------------------

class Col:
    """A column expression: a small tree that compile_col() turns into a function of a row."""

    __hash__ = None

    def __init__(self, op, *args):
        self.op, self.args = op, args

    def __repr__(self):
        return f"Col<{describe(self)}>"

    def __bool__(self):
        raise not_modelled("a column used as a Python bool (use &, | and ~)")

    def __iter__(self):
        raise TypeError("Column is not iterable")

    def __eq__(self, other): return Col("eq", self, lit(other))
    def __ne__(self, other): return Col("ne", self, lit(other))
    def __lt__(self, other): return Col("lt", self, lit(other))
    def __le__(self, other): return Col("le", self, lit(other))
    def __gt__(self, other): return Col("gt", self, lit(other))
    def __ge__(self, other): return Col("ge", self, lit(other))
    def __and__(self, other): return Col("and", self, lit(other))
    def __rand__(self, other): return Col("and", lit(other), self)
    def __or__(self, other): return Col("or", self, lit(other))
    def __ror__(self, other): return Col("or", lit(other), self)
    def __invert__(self): return Col("not", self)
    def __add__(self, other): return Col("add", self, lit(other))
    def __radd__(self, other): return Col("add", lit(other), self)
    def __sub__(self, other): return Col("sub", self, lit(other))
    def __rsub__(self, other): return Col("sub", lit(other), self)
    def __mul__(self, other): return Col("mul", self, lit(other))
    def __rmul__(self, other): return Col("mul", lit(other), self)
    def __truediv__(self, other): return Col("div", self, lit(other))
    def __rtruediv__(self, other): return Col("div", lit(other), self)

    def isin(self, *values):
        if len(values) == 1 and isinstance(values[0], (list, tuple, set, frozenset)):
            values = tuple(values[0])
        if not values:
            raise not_modelled("isin() with no values")
        return Col("in", self, tuple(lit(v) for v in values))

    def isNull(self):
        return Col("isnull", self)

    def isNotNull(self):
        return Col("isnotnull", self)

    def eqNullSafe(self, other):
        return Col("eqns", self, lit(other))

    def alias(self, name):
        return Col("alias", self, name)

    def cast(self, dtype):
        return Col("cast", self, to_type(dtype))

    def otherwise(self, value):
        if self.op != "when" or self.args[1] is not None:
            raise not_modelled("otherwise() on a column that isn't an open when()")
        return Col("when", self.args[0], lit(value))


def lit(value):
    return value if isinstance(value, Col) else Col("lit", value, lit_type(value))


def col_of(c):
    """A column from a Col or a column name, as PySpark's functions take either."""
    if isinstance(c, Col):
        return c
    if isinstance(c, str):
        return ref(c)
    raise not_modelled(f"column argument {c!r}")


def ref(name, qualifier=None, frame_id=None):
    if "." in name or name == "*":
        raise not_modelled(f"column name {name!r}")
    return Col("ref", name, qualifier, frame_id)


def describe(c):
    op, a = c.op, c.args
    if op == "ref":
        return a[0] if a[1] is None else f"{a[1]}.{a[0]}"
    if op == "lit":
        return "NULL" if a[0] is None else str(a[0])
    if op == "alias":
        return a[1]
    if op == "cast":
        return describe(a[0])
    parts = []
    for x in a:
        if isinstance(x, Col):
            parts.append(describe(x))
        elif isinstance(x, tuple):
            parts.extend(describe(y) for y in x if isinstance(y, Col))
    return f"{op}({', '.join(parts)})"


def f_when(condition, value):
    if not isinstance(condition, Col):
        raise not_modelled("when() with a condition that isn't a column")
    return Col("when", ((condition, lit(value)),), None)


def f_trunc(c, fmt):
    if fmt.lower() not in ("month", "mon", "mm"):
        raise not_modelled(f"trunc to {fmt!r}")
    return Col("trunc", col_of(c))


def f_first(c, ignorenulls=False):
    if ignorenulls is not True:
        raise not_modelled("first() without ignorenulls")
    return Col("first", col_of(c))


def f_array_join(c, delimiter, null_replacement=None):
    if null_replacement is not None:
        raise not_modelled("array_join() with a null replacement")
    return Col("array_join", col_of(c), delimiter)


FUNCTIONS = dict(
    col=ref, column=ref, lit=lit, expr=lambda text: parse_sql(text), when=f_when,
    coalesce=lambda *cols: Col("coalesce", tuple(col_of(c) for c in cols)),
    lower=lambda c: Col("lower", col_of(c)), upper=lambda c: Col("upper", col_of(c)),
    trim=lambda c: Col("trim", col_of(c)), to_date=lambda c, format=None: Col("to_date", col_of(c), format),
    trunc=f_trunc, current_timestamp=lambda: Col("now"), first=f_first,
    sum=lambda c: Col("sum", col_of(c)), max=lambda c: Col("max", col_of(c)),
    collect_set=lambda c: Col("collect_set", col_of(c)), array_sort=lambda c: Col("array_sort", col_of(c)),
    array_join=f_array_join)


# Fields and compiled columns ---------------------------------------------------------------------------

class Field:
    """One column of a frame: its name and type, and the qualifiers and frame ids that resolve to it."""

    def __init__(self, name, dtype, aliases=(), ids=()):
        self.name, self.dtype = name, dtype
        self.aliases, self.ids = frozenset(a.lower() for a in aliases), frozenset(ids)

    def through(self, frame_id, aliases=None):
        """The same column, passed on to another frame."""
        return Field(self.name, self.dtype, self.aliases if aliases is None else aliases, self.ids | {frame_id})


def resolve(fields, name, qualifier=None, frame_id=None):
    hits = [i for i, f in enumerate(fields)
            if f.name.lower() == name.lower()
            and (qualifier is None or qualifier.lower() in f.aliases)
            and (frame_id is None or frame_id in f.ids)]
    shown = name if qualifier is None else f"{qualifier}.{name}"
    if not hits:
        raise AnalysisError(f"[UNRESOLVED_COLUMN] {shown} isn't one of {[f.name for f in fields]}")
    if len(hits) > 1:
        raise AnalysisError(f"[AMBIGUOUS_REFERENCE] {shown}")
    return hits[0]


def comparable(a, b, what):
    if not (a == b or VOID in (a, b) or (a in NUMERIC and b in NUMERIC)):
        raise not_modelled(f"{what} between {a} and {b}")


def common_type(types, what):
    known = {t for t in types if t != VOID}
    if not known:
        return VOID
    if len(known) == 1:
        return known.pop()
    if known <= NUMERIC:
        return DOUBLE if DOUBLE in known else BIGINT if BIGINT in known else INT
    raise not_modelled(f"{what} over {sorted(map(str, known))}")


def output_name(c, fields):
    """The name Spark gives a selected column: its alias, or the name of the column it reads."""
    if c.op == "alias":
        return c.args[1]
    target = c.args[0] if c.op == "cast" else c
    if target.op == "ref":
        return fields[resolve(fields, *target.args)].name
    return describe(c)


COMPARE = {"eq": operator.eq, "ne": operator.ne, "lt": operator.lt, "le": operator.le, "gt": operator.gt,
           "ge": operator.ge}
ARITHMETIC = {"add": operator.add, "sub": operator.sub, "mul": operator.mul}
AGGREGATES = {"first", "sum", "max", "collect_set"}
TEXT = {"lower": str.lower, "upper": str.upper, "trim": lambda s: s.strip(" ")}


def compile_col(c, fields, spark, group=None):
    """(function, type) for a column over a frame's fields. The function takes a row or, inside agg(), the
    list of a group's rows; group then holds the indexes of the grouping columns."""
    op, a = c.op, c.args

    def sub(x, mode=group):
        return compile_col(x, fields, spark, mode)

    if op == "ref":
        i = resolve(fields, *a)
        if group is None:
            return (lambda row: row[i]), fields[i].dtype
        if i not in group:
            raise AnalysisError(f"[MISSING_AGGREGATION] {describe(c)} is neither grouped nor aggregated")
        return (lambda rows: rows[0][i]), fields[i].dtype
    if op == "lit":
        value = a[0]
        return (lambda x: value), a[1]
    if op == "now":
        return (lambda x: spark.now), TIMESTAMP
    if op in AGGREGATES:
        if group is None:
            raise not_modelled(f"{op}() outside agg()")
        fn, dtype = sub(a[0], None)
        if op == "first":
            # Spark's first() takes whichever row comes first. The smallest value stands in for it here, so the
            # same rows give the same answer whatever order a write left them in.
            return (lambda rows: min((v for v in map(fn, rows) if v is not None), default=None)), dtype
        if op == "max":
            return (lambda rows: max((v for v in map(fn, rows) if v is not None), default=None)), dtype
        if op == "collect_set":
            return (lambda rows: tuple(sorted({v for v in map(fn, rows) if v is not None}))), ArrayType(dtype)
        if dtype not in (DOUBLE, VOID, INT, BIGINT):
            raise not_modelled(f"sum() of {dtype}")
        # fsum is exact, so the total doesn't depend on the order of the rows either.
        add_up = math.fsum if dtype in (DOUBLE, VOID) else sum

        def total(rows):
            values = [v for v in map(fn, rows) if v is not None]
            return add_up(values) if values else None
        return total, DOUBLE if dtype in (DOUBLE, VOID) else BIGINT
    if op == "alias":
        return sub(a[0])
    if op == "cast":
        fn, dtype = sub(a[0])
        convert = caster(dtype, a[1])
        return (lambda x: convert(fn(x))), a[1]
    if op in COMPARE or op == "eqns":
        (f1, t1), (f2, t2) = sub(a[0]), sub(a[1])
        comparable(t1, t2, op)
        if op == "eqns":
            def same(x):
                v1, v2 = f1(x), f2(x)
                if v1 is None or v2 is None:
                    return v1 is None and v2 is None
                return v1 == v2
            return same, BOOLEAN
        test = COMPARE[op]

        def compare(x):
            v1, v2 = f1(x), f2(x)
            return None if v1 is None or v2 is None else test(v1, v2)
        return compare, BOOLEAN
    if op in ("and", "or"):
        (f1, t1), (f2, t2) = sub(a[0]), sub(a[1])
        if not {t1, t2} <= {BOOLEAN, VOID}:
            raise not_modelled(f"{op} of {t1} and {t2}")
        stop = op == "or"      # the value that settles it: True for OR, False for AND

        def logic(x):
            v1 = f1(x)
            if v1 is stop:
                return stop
            v2 = f2(x)
            if v2 is stop:
                return stop
            return None if v1 is None or v2 is None else not stop
        return logic, BOOLEAN
    if op == "not":
        fn, dtype = sub(a[0])
        if dtype not in (BOOLEAN, VOID):
            raise not_modelled(f"not of {dtype}")
        return (lambda x: None if (v := fn(x)) is None else not v), BOOLEAN
    if op in ("isnull", "isnotnull"):
        fn, _ = sub(a[0])
        wanted = op == "isnull"
        return (lambda x: (fn(x) is None) is wanted), BOOLEAN
    if op == "in":
        fn, dtype = sub(a[0])
        for option in a[1]:
            if option.op != "lit":
                raise not_modelled("IN with a column in its list")
            comparable(dtype, option.args[1], "IN")
        values = {o.args[0] for o in a[1] if o.args[0] is not None}
        unknown = None if any(o.args[0] is None for o in a[1]) else False

        def member(x):
            v = fn(x)
            if v is None:
                return None
            return True if v in values else unknown
        return member, BOOLEAN
    if op in ARITHMETIC or op == "div":
        (f1, t1), (f2, t2) = sub(a[0]), sub(a[1])
        dtype = DOUBLE if op == "div" else common_type((t1, t2), op)
        if not {t1, t2} <= NUMERIC | {VOID} or dtype == VOID:
            raise not_modelled(f"{op} of {t1} and {t2}")
        if op == "div":
            def divide(x):
                v1, v2 = f1(x), f2(x)
                return None if v1 is None or v2 is None or v2 == 0 else float(v1) / v2
            return divide, DOUBLE
        apply, to_double = ARITHMETIC[op], dtype == DOUBLE

        def arithmetic(x):
            v1, v2 = f1(x), f2(x)
            if v1 is None or v2 is None:
                return None
            v = apply(v1, v2)
            return float(v) if to_double else v
        return arithmetic, dtype
    if op == "when":
        branches = [(sub(condition), sub(value)) for condition, value in a[0]]
        otherwise = sub(a[1]) if a[1] is not None else ((lambda x: None), VOID)
        dtype = common_type([vt for _, (_, vt) in branches] + [otherwise[1]], "when")
        if any(ct not in (BOOLEAN, VOID) for (_, ct), _ in branches):
            raise not_modelled("when() with a condition that isn't boolean")
        choices = [(cf, vf, caster(vt, dtype)) for (cf, _), (vf, vt) in branches]
        default, default_cast = otherwise[0], caster(otherwise[1], dtype)

        def choose(x):
            for cf, vf, convert in choices:
                if cf(x) is True:
                    return convert(vf(x))
            return default_cast(default(x))
        return choose, dtype
    if op == "coalesce":
        parts = [sub(p) for p in a[0]]
        dtype = common_type([t for _, t in parts], "coalesce")
        parts = [(fn, caster(t, dtype)) for fn, t in parts]

        def first_set(x):
            for fn, convert in parts:
                v = fn(x)
                if v is not None:
                    return convert(v)
            return None
        return first_set, dtype
    if op in TEXT:
        fn, dtype = sub(a[0])
        if dtype not in (STRING, VOID):
            raise not_modelled(f"{op}() of {dtype}")
        change = TEXT[op]
        return (lambda x: None if (v := fn(x)) is None else change(v)), STRING
    if op == "to_date":
        fn, dtype = sub(a[0])
        fmt = a[1]
        if dtype == STRING:
            return (lambda x: None if (v := fn(x)) is None else parse_date(v, fmt)), DATE
        if fmt is None and dtype in (DATE, TIMESTAMP, VOID):
            convert = caster(dtype, DATE)
            return (lambda x: convert(fn(x))), DATE
        raise not_modelled(f"to_date() of {dtype}")
    if op == "trunc":
        fn, dtype = sub(a[0])
        if dtype not in (DATE, VOID):
            raise not_modelled(f"trunc() of {dtype}")
        return (lambda x: None if (v := fn(x)) is None else v.replace(day=1)), DATE
    if op in ("array_sort", "array_join"):
        fn, dtype = sub(a[0])
        if dtype.name != "array" or dtype.element not in (STRING, VOID):
            raise not_modelled(f"{op}() of {dtype}")
        if op == "array_sort":
            return (lambda x: None if (v := fn(x)) is None else tuple(sorted(v))), dtype
        separator = a[1]
        return (lambda x: None if (v := fn(x)) is None else separator.join(e for e in v if e is not None)), STRING
    raise not_modelled(f"column operation {op}")


# SQL text, for where("...") and the merge and join conditions ------------------------------------------

SQL_TOKEN = re.compile(r"\s*(`[^`]*`|'[^'\\]*'|<=>|>=|<=|<>|!=|==|[=<>(),.]|\d+(?:\.\d+)?|[A-Za-z_]\w*)")
SQL_COMPARE = {"=": "eq", "==": "eq", "<>": "ne", "!=": "ne", "<": "lt", "<=": "le", ">": "gt", ">=": "ge",
               "<=>": "eqns"}
ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


def parse_sql(text):
    return SqlParser(text).parse()


class SqlParser:
    """Spark SQL's boolean expressions, as far as the notebook writes them."""

    def __init__(self, text):
        self.text, self.tokens, self.pos = text, [], 0
        while text[self.pos:].strip():
            m = SQL_TOKEN.match(text, self.pos)
            if not m:
                raise not_modelled(f"SQL {text[self.pos:]!r}")
            self.tokens.append(m.group(1))
            self.pos = m.end()
        self.pos = 0

    def peek(self, offset=0):
        i = self.pos + offset
        return self.tokens[i] if i < len(self.tokens) else None

    def keyword(self, *words):
        """Takes the next tokens if they're these keywords."""
        if all((self.peek(i) or "").upper() == w for i, w in enumerate(words)):
            self.pos += len(words)
            return True
        return False

    def fail(self):
        where = "the end" if self.peek() is None else repr(self.peek())
        return AnalysisError(f"[PARSE_SYNTAX_ERROR] at {where} in {self.text!r}")

    def expect(self, token):
        if self.peek() != token:
            raise self.fail()
        self.pos += 1

    def parse(self):
        node = self.disjunction()
        if self.peek() is not None:
            raise self.fail()
        return node

    def disjunction(self):
        node = self.conjunction()
        while self.keyword("OR"):
            node = Col("or", node, self.conjunction())
        return node

    def conjunction(self):
        node = self.negation()
        while self.keyword("AND"):
            node = Col("and", node, self.negation())
        return node

    def negation(self):
        return Col("not", self.negation()) if self.keyword("NOT") else self.predicate()

    def predicate(self):
        left = self.operand()
        if self.peek() in SQL_COMPARE:
            op = SQL_COMPARE[self.tokens[self.pos]]
            self.pos += 1
            return Col(op, left, self.operand())
        if self.keyword("IS", "NOT", "NULL"):
            return Col("isnotnull", left)
        if self.keyword("IS", "NULL"):
            return Col("isnull", left)
        negate = self.keyword("NOT", "IN")
        if negate or self.keyword("IN"):
            self.expect("(")
            values = [self.operand()]
            while self.peek() == ",":
                self.pos += 1
                values.append(self.operand())
            self.expect(")")
            node = Col("in", left, tuple(values))
            return Col("not", node) if negate else node
        return left

    def name(self):
        token = self.peek()
        if token is None or not (token.startswith("`") or re.fullmatch(r"[A-Za-z_]\w*", token)):
            raise self.fail()
        self.pos += 1
        return token.strip("`")

    def operand(self):
        token = self.peek()
        if token is None:
            raise self.fail()
        if token == "(":
            self.pos += 1
            node = self.disjunction()
            self.expect(")")
            return node
        if token.startswith("'"):
            self.pos += 1
            return lit(token[1:-1])
        if token[0].isdigit():
            if "." in token:
                raise not_modelled(f"decimal literal {token}")
            self.pos += 1
            return lit(int(token))
        upper = token.upper()
        if upper == "DATE" and (self.peek(1) or "").startswith("'"):
            text = self.tokens[self.pos + 1][1:-1]
            self.pos += 2
            if not ISO_DATE.fullmatch(text):
                raise not_modelled(f"DATE literal {text!r}")
            try:
                return lit(date.fromisoformat(text))
            except ValueError:
                raise AnalysisError(f"[INVALID_TYPED_LITERAL] DATE '{text}'") from None
        if upper in ("NULL", "TRUE", "FALSE"):
            self.pos += 1
            return lit(None if upper == "NULL" else upper == "TRUE")
        name = self.name()
        if self.peek() == ".":
            self.pos += 1
            return ref(self.name(), qualifier=name)
        return ref(name)


# Frames ------------------------------------------------------------------------------------------------

class Row(tuple):
    """A collected row: a tuple that also takes a column name, as PySpark's Row does."""

    def __new__(cls, values, names):
        row = super().__new__(cls, values)
        row._names = names
        return row

    def __getitem__(self, key):
        if isinstance(key, str):
            if key not in self._names:
                raise ValueError(key)
            key = self._names.index(key)
        return super().__getitem__(key)


FRAME_IDS = itertools.count(1)


class Frame:
    """An eager DataFrame: its fields and all its rows, worked out when the frame is made."""

    def __init__(self, spark, fields, rows):
        self._spark, self._id = spark, next(FRAME_IDS)
        self._fields = [f.through(self._id) for f in fields]
        self._rows = [tuple(r) for r in rows]

    def _derive(self, fields, rows):
        return Frame(self._spark, fields, rows)

    def _compile(self, c, group=None):
        return compile_col(c, self._fields, self._spark, group)

    def __getattr__(self, name):
        if name.startswith("_") or not any(f.name.lower() == name.lower() for f in self._fields):
            raise AttributeError(name)
        return ref(name, frame_id=self._id)

    @property
    def columns(self):
        return [f.name for f in self._fields]

    @property
    def schema(self):
        return StructType(StructField(f.name, f.dtype) for f in self._fields)

    @property
    def write(self):
        return Writer(self)

    def select(self, *cols):
        fields, fns = [], []
        for c in map(col_of, cols):
            fn, dtype = self._compile(c)
            if c.op == "ref":
                fields.append(self._fields[resolve(self._fields, *c.args)])
            else:
                fields.append(Field(output_name(c, self._fields), dtype))
            fns.append(fn)
        return self._derive(fields, [tuple(fn(r) for fn in fns) for r in self._rows])

    def withColumn(self, name, c):
        if not isinstance(c, Col):
            raise TypeError("col should be Column")
        fn, dtype = self._compile(c)
        hits = [i for i, f in enumerate(self._fields) if f.name.lower() == name.lower()]
        if len(hits) > 1:
            raise not_modelled(f"withColumn() over a repeated name {name!r}")
        fields = list(self._fields)
        if hits:
            i = hits[0]
            fields[i] = Field(name, dtype)
            rows = [r[:i] + (fn(r),) + r[i + 1:] for r in self._rows]
        else:
            fields.append(Field(name, dtype))
            rows = [r + (fn(r),) for r in self._rows]
        return self._derive(fields, rows)

    def drop(self, *names):
        if not all(isinstance(n, str) for n in names):
            raise not_modelled("drop() of a column object")
        gone = {n.lower() for n in names}
        keep = [i for i, f in enumerate(self._fields) if f.name.lower() not in gone]
        return self._derive([self._fields[i] for i in keep], [tuple(r[i] for i in keep) for r in self._rows])

    def where(self, condition):
        c = parse_sql(condition) if isinstance(condition, str) else condition
        if not isinstance(c, Col):
            raise not_modelled(f"filter on {condition!r}")
        fn, dtype = self._compile(c)
        if dtype not in (BOOLEAN, VOID):
            raise AnalysisError(f"[DATATYPE_MISMATCH] a filter of type {dtype}")
        return self._derive(self._fields, [r for r in self._rows if fn(r) is True])

    filter = where

    def distinct(self):
        return self._derive(self._fields, list(dict.fromkeys(self._rows)))

    def dropDuplicates(self, subset=None):
        if subset is None:
            return self.distinct()
        idx = [resolve(self._fields, n) for n in subset]
        kept = {}
        for r in self._rows:
            key = tuple(r[i] for i in idx)
            if key not in kept:
                kept[key] = r
            elif kept[key] != r:
                # Spark keeps whichever row it meets first. The tests mustn't depend on which.
                raise not_modelled("dropDuplicates() whose result depends on the order of the rows")
        return self._derive(self._fields, list(kept.values()))

    def count(self):
        return len(self._rows)

    def collect(self):
        names = self.columns
        return [Row(r, names) for r in self._rows]

    def first(self):
        rows = self.collect()
        return rows[0] if rows else None

    def limit(self, n):
        return self._derive(self._fields, self._rows[:n])

    def alias(self, name):
        return self._derive([Field(f.name, f.dtype, {name}, f.ids) for f in self._fields], self._rows)

    def groupBy(self, *cols):
        return Grouped(self, [col_of(c) for c in cols])

    def agg(self, *cols):
        return Grouped(self, []).agg(*cols)

    def unionByName(self, other, allowMissingColumns=False):
        mine = {f.name.lower(): i for i, f in enumerate(self._fields)}
        theirs = {f.name.lower(): i for i, f in enumerate(other._fields)}
        if len(mine) < len(self._fields) or len(theirs) < len(other._fields):
            raise not_modelled("unionByName() of a frame with a repeated column name")
        extra = [n for n in theirs if n not in mine]
        if not allowMissingColumns and (extra or set(mine) - set(theirs)):
            raise AnalysisError(f"[NUM_COLUMNS_MISMATCH] unionByName() of {self.columns} and {other.columns}")
        fields = [Field(f.name, f.dtype, f.aliases, f.ids) for f in self._fields]
        fields += [Field(other._fields[theirs[n]].name, VOID) for n in extra]
        from_other = [theirs.get(f.name.lower()) for f in fields]
        casts_mine, casts_theirs = [], []
        for i, (f, j) in enumerate(zip(fields, from_other)):
            mine_type = self._fields[i].dtype if i < len(self._fields) else VOID
            their_type = other._fields[j].dtype if j is not None else VOID
            f.dtype = common_type((mine_type, their_type), "unionByName()")
            casts_mine.append(caster(mine_type, f.dtype))
            casts_theirs.append(caster(their_type, f.dtype))
        width = len(self._fields)
        rows = [tuple(cast(r[i] if i < width else None) for i, cast in enumerate(casts_mine))
                for r in self._rows]
        rows += [tuple(cast(None if j is None else r[j]) for j, cast in zip(from_other, casts_theirs))
                 for r in other._rows]
        return self._derive(fields, rows)

    def join(self, other, on=None, how="inner"):
        kind = JOIN_TYPES.get(how.lower().replace("_", ""))
        if kind is None:
            raise not_modelled(f"a {how} join")
        if isinstance(on, str):
            on = [on]
        if isinstance(on, list) and on and all(isinstance(n, str) for n in on):
            return using_join(self, other, on, kind)
        if isinstance(on, Col):
            return condition_join(self, other, on, kind)
        raise not_modelled(f"a join on {on!r}")


JOIN_TYPES = {"inner": "inner", "left": "left", "leftouter": "left", "leftanti": "anti", "anti": "anti",
              "leftsemi": "semi", "semi": "semi"}


class Grouped:
    def __init__(self, frame, keys):
        if any(k.op != "ref" for k in keys):
            raise not_modelled("groupBy() on an expression")
        self.frame, self.keys = frame, keys

    def agg(self, *cols):
        frame, fields = self.frame, self.frame._fields
        idx = [resolve(fields, *k.args) for k in self.keys]
        outputs = []
        for c in cols:
            if not isinstance(c, Col):
                raise not_modelled(f"agg() of {c!r}")
            fn, dtype = compile_col(c, fields, frame._spark, set(idx))
            outputs.append((fn, Field(output_name(c, fields), dtype)))
        groups = {}
        for r in frame._rows:
            groups.setdefault(tuple(r[i] for i in idx), []).append(r)
        if not idx and not groups:
            groups[()] = []          # an aggregate with no grouping gives one row, even over no rows
        rows = [key + tuple(fn(members) for fn, _ in outputs) for key, members in groups.items()]
        return frame._derive([fields[i] for i in idx] + [f for _, f in outputs], rows)


def using_join(left, right, on, kind):
    """join(other, "col") or join(other, [cols]): equal keys match, a NULL key never does. As in Spark, the
    keys come first, then the left's other columns, then (for inner and left joins) the right's."""
    li = [resolve(left._fields, n) for n in on]
    ri = [resolve(right._fields, n) for n in on]
    for a, b in zip(li, ri):
        comparable(left._fields[a].dtype, right._fields[b].dtype, "a join key")
    index = {}
    for r in right._rows:
        key = tuple(r[i] for i in ri)
        if None not in key:
            index.setdefault(key, []).append(r)
    order = li + [i for i in range(len(left._fields)) if i not in li]
    others = [i for i in range(len(right._fields)) if i not in ri]
    fields = [left._fields[i] for i in order]
    if kind in ("inner", "left"):
        fields += [right._fields[i] for i in others]
    rows = []
    for r in left._rows:
        key = tuple(r[i] for i in li)
        matches = index.get(key, []) if None not in key else []
        head = tuple(r[i] for i in order)
        if kind == "anti" or kind == "semi":
            if bool(matches) == (kind == "semi"):
                rows.append(head)
            continue
        rows.extend(head + tuple(m[i] for i in others) for m in matches)
        if not matches and kind == "left":
            rows.append(head + (None,) * len(others))
    return left._derive(fields, rows)


def condition_join(left, right, condition, kind):
    if kind not in ("anti", "semi"):
        raise not_modelled(f"a {kind} join on a condition")
    matches = matcher(condition, left._fields + right._fields, len(left._fields), left._spark)
    found = matches(left._rows, right._rows)
    return left._derive(left._fields, [r for r, m in zip(left._rows, found) if bool(m) == (kind == "semi")])


def conjuncts(c):
    return conjuncts(c.args[0]) + conjuncts(c.args[1]) if c.op == "and" else [c]


def refs(node):
    if isinstance(node, Col):
        return [node] if node.op == "ref" else refs(node.args)
    if isinstance(node, tuple):
        return [r for x in node for r in refs(x)]
    return []


def side(c, fields, split):
    """0 if the expression reads only the left's columns, 1 if only the right's, else None."""
    sides = {resolve(fields, *r.args) >= split for r in refs(c)}
    return int(sides.pop()) if len(sides) == 1 else None


def matcher(condition, fields, split, spark):
    """A function giving, for each left row, the indexes of the right rows the condition is TRUE for.
    fields are the left's then the right's. Equalities between a left and a right column are hashed; the
    whole condition is then checked on each candidate pair."""
    test, dtype = compile_col(condition, fields, spark)
    if dtype not in (BOOLEAN, VOID):
        raise AnalysisError(f"[DATATYPE_MISMATCH] a join condition of type {dtype}")
    left_keys, right_keys, null_safe = [], [], []
    for c in conjuncts(condition):
        if c.op in ("eq", "eqns"):
            sides = side(c.args[0], fields, split), side(c.args[1], fields, split)
            if set(sides) == {0, 1}:
                lhs, rhs = c.args if sides == (0, 1) else c.args[::-1]
                left_keys.append(compile_col(lhs, fields, spark)[0])
                right_keys.append(compile_col(rhs, fields, spark)[0])
                null_safe.append(c.op == "eqns")
    no_right, no_left = (None,) * (len(fields) - split), (None,) * split

    def usable(key):
        return all(v is not None or ns for v, ns in zip(key, null_safe))

    def matches(left_rows, right_rows):
        index = {}
        for j, r in enumerate(right_rows):
            key = tuple(f(no_left + r) for f in right_keys)
            if usable(key):
                index.setdefault(key, []).append(j)
        found = []
        for l in left_rows:
            key = tuple(f(l + no_right) for f in left_keys)
            candidates = index.get(key, ()) if usable(key) else ()
            found.append([j for j in candidates if test(l + right_rows[j]) is True])
        return found
    return matches


# Tables, reads and writes ------------------------------------------------------------------------------

class Table:
    """A stored Delta table."""

    def __init__(self, names, types, rows):
        self.names, self.types, self.rows = list(names), list(types), [tuple(r) for r in rows]

    def fields(self, *aliases):
        return [Field(n, t, aliases) for n, t in zip(self.names, self.types)]

    def with_rows(self, rows):
        return Table(self.names, self.types, rows)

    def layout(self, frame):
        """The frame's rows as this table's columns, as a Delta write lines them up: by name, with a NULL for
        a column the frame lacks. A column the table lacks, or a different type, fails the write."""
        lookup = {f.name.lower(): i for i, f in enumerate(frame._fields)}
        extra = sorted(set(lookup) - {n.lower() for n in self.names})
        if extra:
            raise AnalysisError(f"[_LEGACY_ERROR_TEMP_DELTA_0007] A schema mismatch: the table has no {extra}")
        picks = []
        for name, dtype in zip(self.names, self.types):
            i = lookup.get(name.lower())
            if i is not None and frame._fields[i].dtype not in (dtype, VOID):
                raise AnalysisError(f"[DELTA_FAILED_TO_MERGE_FIELDS] {name}: {frame._fields[i].dtype} into {dtype}")
            picks.append(i)
        return [tuple(None if i is None else r[i] for i in picks) for r in frame._rows]


def save(frame, name, how, replace_where):
    spark, names = frame._spark, frame.columns
    if len({n.lower() for n in names}) < len(names):
        raise AnalysisError(f"[COLUMN_ALREADY_EXISTS] a write of {names}")
    table = spark.tables.get(name)
    if table is None:
        if replace_where is not None:
            raise not_modelled("replaceWhere on a table that doesn't exist")
        if any(f.dtype == VOID or f.dtype.name == "array" for f in frame._fields):
            raise not_modelled(f"creating {name} with a void or array column")
        spark.commit(name, "create", Table(names, [f.dtype for f in frame._fields], frame._rows))
        return
    if how == "errorifexists":
        raise AnalysisError(f"[TABLE_OR_VIEW_ALREADY_EXISTS] {name}")
    rows = table.layout(frame)
    if how == "append" and replace_where is None:
        spark.commit(name, "append", table.with_rows(table.rows + rows))
        return
    if how == "overwrite" and replace_where is None:
        spark.commit(name, "overwrite", table.with_rows(rows))
        return
    if how != "overwrite":
        raise not_modelled(f"a {how} write")
    test, dtype = compile_col(parse_sql(replace_where), table.fields(name), spark)
    if dtype not in (BOOLEAN, VOID):
        raise AnalysisError(f"[DATATYPE_MISMATCH] replaceWhere of type {dtype}")
    # Delta checks every written row against the predicate, and a NULL fails the check as FALSE does.
    outside = [r for r in rows if test(r) is not True]
    if outside:
        raise DeltaError(f"[DELTA_REPLACE_WHERE_MISMATCH] {len(outside)} written row(s) don't match "
                         f"{replace_where!r}, e.g. {outside[0]}")
    spark.commit(name, "replaceWhere", table.with_rows([r for r in table.rows if test(r) is not True] + rows))


class Writer:
    def __init__(self, frame):
        self.frame, self.how, self.options, self.fmt = frame, "errorifexists", {}, None

    def format(self, fmt):
        self.fmt = fmt
        return self

    def mode(self, how):
        self.how = how.lower()
        return self

    def option(self, key, value):
        self.options[key.lower()] = value
        return self

    def saveAsTable(self, name):
        if self.fmt != "delta":
            raise not_modelled(f"a {self.fmt!r} table")
        if set(self.options) - {"replacewhere"}:
            raise not_modelled(f"write options {sorted(self.options)}")
        save(self.frame, name, self.how, self.options.get("replacewhere"))


CSV_OPTIONS = {"header": True, "inferSchema": False, "multiLine": True, "escape": '"', "encoding": "UTF-8"}


class Reader:
    def __init__(self, spark):
        self.spark, self.options = spark, {}

    def option(self, key, value):
        self.options[key] = value
        return self

    def csv(self, path):
        if self.options != CSV_OPTIONS:
            raise not_modelled(f"CSV options {self.options}")
        if path not in self.spark.files:
            raise AnalysisError(f"[PATH_NOT_FOUND] {path}")
        lines = [r for r in csv.reader(io.StringIO(self.spark.files[path], newline="")) if r]
        header, body = lines[0], lines[1:]
        if len(set(header)) < len(header) or any(len(r) > len(header) for r in body):
            raise not_modelled(f"the layout of {path}")
        # Every column is text (inferSchema is off), and an empty field is NULL.
        rows = [tuple(v if v != "" else None for v in r) + (None,) * (len(header) - len(r)) for r in body]
        return Frame(self.spark, [Field(h, STRING) for h in header], rows)


class FakeSpark:
    def __init__(self):
        self.tables, self.files, self.output, self.writes, self.history = {}, {}, [], [], []
        self.now, self.cell, self.fail_at = None, None, None
        self.catalog = SimpleNamespace(tableExists=lambda name: name in self.tables)

    @property
    def read(self):
        return Reader(self)

    def table(self, name):
        if name not in self.tables:
            raise AnalysisError(f"[TABLE_OR_VIEW_NOT_FOUND] {name}")
        t = self.tables[name]
        return Frame(self, t.fields(name), t.rows)

    def createDataFrame(self, data, schema):
        if not isinstance(schema, str):
            raise not_modelled("createDataFrame() without a DDL schema")
        fields = [Field(n, to_type(t)) for n, t in (part.split() for part in schema.split(","))]
        rows = [tuple(r) for r in data]
        for r in rows:
            if len(r) != len(fields) or not all(fits(v, f.dtype) for v, f in zip(r, fields)):
                raise TypeError(f"createDataFrame(): {r!r} doesn't fit {schema!r}")
        return Frame(self, fields, rows)

    def commit(self, name, operation, table):
        """Every write ends here: it's logged, fails if the test says so, and otherwise replaces the table
        in one step."""
        self.writes.append((self.cell, name, operation))
        if len(self.writes) == self.fail_at:
            raise SimulatedFailure(f"write {self.fail_at} ({operation} on {name}) failed")
        for r in table.rows:
            if len(r) != len(table.types) or not all(fits(v, t) for v, t in zip(r, table.types)):
                raise AssertionError(f"the fake built a row that doesn't fit {name}: {r!r}")
        self.tables[name] = table
        self.history.append(dict(self.tables))

    def ls(self, path):
        prefix = path.rstrip("/") + "/"
        names = sorted(p[len(prefix):] for p in self.files if p.startswith(prefix) and "/" not in p[len(prefix):])
        return [SimpleNamespace(name=n, path=prefix + n, isDir=False) for n in names]


class FakeDeltaTable:
    def __init__(self, spark, name, alias=None):
        self.spark, self.name, self.alias_name = spark, name, alias

    @classmethod
    def forName(cls, spark, name):
        if name not in spark.tables:
            raise AnalysisError(f"[DELTA_MISSING_DELTA_TABLE] {name} is not a Delta table")
        return cls(spark, name)

    def alias(self, name):
        return FakeDeltaTable(self.spark, self.name, name)

    def _table(self):
        return self.spark.tables[self.name]

    def _fields(self):
        return self._table().fields(self.name, *([self.alias_name] if self.alias_name else []))

    def delete(self, condition=None):
        if condition is None:
            raise not_modelled("delete() of every row")
        c = parse_sql(condition) if isinstance(condition, str) else condition
        test, dtype = compile_col(c, self._fields(), self.spark)
        if dtype not in (BOOLEAN, VOID):
            raise AnalysisError(f"[DATATYPE_MISMATCH] a delete condition of type {dtype}")
        table = self._table()
        self.spark.commit(self.name, "delete", table.with_rows([r for r in table.rows if test(r) is not True]))

    def merge(self, source, condition):
        return MergeBuilder(self, source, condition)


class MergeBuilder:
    """Delta's merge with updateAll, insertAll and an unconditional delete, run as one commit."""

    def __init__(self, target, source, condition):
        self.target, self.source, self.condition, self.clauses = target, source, condition, []

    def _add(self, clause, condition):
        if condition is not None or clause in self.clauses:
            raise not_modelled(f"this {clause} clause")
        self.clauses.append(clause)
        return self

    def whenMatchedUpdateAll(self, condition=None):
        return self._add("update", condition)

    def whenMatchedDelete(self, condition=None):
        return self._add("delete", condition)

    def whenNotMatchedInsertAll(self, condition=None):
        return self._add("insert", condition)

    def execute(self):
        spark, table, source = self.target.spark, self.target._table(), self.source
        if "update" in self.clauses and "delete" in self.clauses:
            raise not_modelled("a merge that both updates and deletes")
        target_fields = self.target._fields()
        c = parse_sql(self.condition) if isinstance(self.condition, str) else self.condition
        found = matcher(c, target_fields + source._fields, len(target_fields), spark)(table.rows, source._rows)
        if "update" in self.clauses or "insert" in self.clauses:
            # With schema evolution off, the source needs every target column; any others are ignored.
            lookup = {f.name.lower(): i for i, f in enumerate(source._fields)}
            missing = [n for n in table.names if n.lower() not in lookup]
            if missing:
                raise AnalysisError(f"[DELTA_MERGE_UNRESOLVED_EXPRESSION] {missing} isn't in {source.columns}")
            picks = [lookup[n.lower()] for n in table.names]
            casts = [store_caster(source._fields[i].dtype, t, n) for i, t, n in zip(picks, table.types, table.names)]

            def as_target(s):
                return tuple(cast(s[i]) for i, cast in zip(picks, casts))
        rows, matched = [], set()
        for r, hits in zip(table.rows, found):
            matched.update(hits)
            if not hits or not ({"update", "delete"} & set(self.clauses)):
                rows.append(r)
            elif "update" in self.clauses:
                if len(hits) > 1:
                    raise DeltaError("[DELTA_MULTIPLE_SOURCE_ROW_MATCHING_TARGET_ROW_IN_MERGE] "
                                     f"{len(hits)} source rows match the target row {r}")
                rows.append(as_target(source._rows[hits[0]]))
        if "insert" in self.clauses:
            rows += [as_target(s) for j, s in enumerate(source._rows) if j not in matched]
        spark.commit(self.target.name, "merge", table.with_rows(rows))


def no_network(*args, **kwargs):
    raise AssertionError("the tests make no network calls")


def module(name, **attrs):
    m = ModuleType(name)
    m.__dict__.update(attrs)
    return m


MODULES = {"pyspark.sql.functions": module("pyspark.sql.functions", **FUNCTIONS),
           "delta.tables": module("delta.tables", DeltaTable=FakeDeltaTable),
           "requests": module("requests", post=no_network, get=no_network)}
MODULES["pyspark.sql"] = module("pyspark.sql", functions=MODULES["pyspark.sql.functions"])
MODULES["pyspark"] = module("pyspark", sql=MODULES["pyspark.sql"])
MODULES["delta"] = module("delta", tables=MODULES["delta.tables"])
REAL_MODULES = {"datetime", "re", "time", "json", "math", "urllib.parse"}


def fake_import(name, globals=None, locals=None, fromlist=(), level=0):
    if level == 0 and name in MODULES:
        return MODULES[name] if fromlist else MODULES[name.partition(".")[0]]
    if level == 0 and name in REAL_MODULES:
        return builtins.__import__(name, globals, locals, fromlist, level)
    raise not_modelled(f"import {name}")


BUILTINS = dict(vars(builtins), __import__=fake_import)


# The notebook, and the oracle --------------------------------------------------------------------------

def notebook_cells(text):
    """Each cell's source: the code of a code cell, None for any other cell."""
    return ["".join(c["source"]) if c["cell_type"] == "code" else None for c in json.loads(text)["cells"]]


def find(cells, marker):
    """The index of the one code cell holding marker."""
    hits = [i for i, source in enumerate(cells) if source is not None and marker in source]
    if len(hits) != 1:
        raise AssertionError(f"{marker!r} is in code cells {hits}, not exactly one")
    return hits[0]


def once(text, part, what):
    if text.count(part) != 1:
        raise AssertionError(f"{what}: {part!r} occurs {text.count(part)} times")
    return text.index(part)


def swap(text, after, before, old):
    """text with what lies between `after` and the next `before` put back to old. after None means from
    the start of the cell; before None, to its end."""
    start = 0 if after is None else once(text, after, "swap") + len(after)
    end = len(text) if before is None else text.find(before, start)
    if end < 0:
        raise AssertionError(f"swap: {before!r} doesn't follow {after!r}")
    return text[:start] + old + text[end:]


# The cells the tests run, in order, each found by a line only it has. The last code cell, the summary,
# runs SQL and changes nothing, so it's left out.
RUN_MARKERS = ('LANDING = "Files/landing/studio"', "def merge(", "raw = read(*PAT_TENANT)",
               "raw = read(*PAT_AGENT)", "raw = read(*PAT_USER)", "api_raw = read(*PAT_API_AGENT, api=True)",
               "user_raw = read(*PAT_API_USER, api=True)", "nothing to sum")
SUMMARY_MARKER = "spark.sql("

TENANT_KEYS = '["usage_date", "environment_id", "billing_plan_id", "capacity_type"]'

# Each write site as it was at 99f68c3: (a line of the cell, after, before, the old code between them).
SWAPS = [
    ("def merge(", '        print(f"  {table}: created with {df.count():,} rows")\n\n\n', "def opt(", ""),
    ("api_raw = read(*PAT_API_AGENT, api=True)",
     '    print(f"  {daily.count():,} agent-days over {len(days)} day(s)")\n\n',
     "\n    # studio_agent: months no export covers.\n",
     '    if days and spark.catalog.tableExists(TBL_AGENT_DAILY):\n'
     '        DeltaTable.forName(spark, TBL_AGENT_DAILY).delete(F.col("usage_date").isin(days))\n'
     '    if days:\n'
     '        merge(daily, TBL_AGENT_DAILY, keys)\n'),
    ("api_raw = read(*PAT_API_AGENT, api=True)",
     '                           F.lit(API_SOURCE).alias("source_file"))\n'
     '                   .withColumn("_loaded_at", F.current_timestamp()))\n',
     "\n    # studio_tenant_daily: the entitlement snapshot",
     '        if spark.catalog.tableExists(TBL_AGENT):\n'
     '            DeltaTable.forName(spark, TBL_AGENT).delete(\n'
     '                F.col("snapshot_month").isin(api_months) & (F.col("source_file") == API_SOURCE))\n'
     '        merge(monthly, TBL_AGENT, ["snapshot_month", "agent_id", "billable_feature", "channel", '
     '"environment_id"])\n'),
    ("api_raw = read(*PAT_API_AGENT, api=True)",
     '        tenant_api = tenant_api.join(exported, ["usage_date", "environment_id"], "left_anti")\n', None,
     '        if days:\n'
     '            DeltaTable.forName(spark, TBL_TENANT).delete(\n'
     '                F.col("usage_date").isin(days) & (F.col("source_file") == API_SOURCE))\n'
     '    if days:\n'
     f'        merge(tenant_api, TBL_TENANT, {TENANT_KEYS})'),
    ("user_raw = read(*PAT_API_USER, api=True)",
     '    print(f"  {udaily.count():,} user rows over {len(udays)} day(s)")\n',
     "\n    # studio_user: months no export covers.\n",
     '    if udays and spark.catalog.tableExists(TBL_USER_DAILY):\n'
     '        DeltaTable.forName(spark, TBL_USER_DAILY).delete(F.col("usage_date").isin(udays))\n'
     '    if udays:\n'
     '        merge(udaily, TBL_USER_DAILY, ukeys)\n'),
    ("user_raw = read(*PAT_API_USER, api=True)",
     '                            F.lit(API_SOURCE).alias("source_file"))\n'
     '                    .withColumn("_loaded_at", F.current_timestamp()))\n', None,
     '        if spark.catalog.tableExists(TBL_USER):\n'
     '            DeltaTable.forName(spark, TBL_USER).delete(\n'
     '                F.col("snapshot_month").isin(user_months) & (F.col("source_file") == API_SOURCE))\n'
     '        merge(umonthly, TBL_USER, ["snapshot_month", "user_id", "agent_id"])'),
    ("nothing to sum", None, "\nif not READ_API_FILES:\n",
     'if READ_API_FILES and spark.catalog.tableExists(TBL_TENANT):\n'
     '    DeltaTable.forName(spark, TBL_TENANT).delete(F.col("source_file") == API_USER_SOURCE)\n'),
    ("nothing to sum", "    if spark.catalog.tableExists(TBL_TENANT):\n", "        by_day = by_day.join(covered,",
     '        covered = spark.table(TBL_TENANT).select("usage_date", "environment_id").distinct()\n'),
    ("nothing to sum",
     '        print(f"  {tenant_users.count():,} tenant day(s) summed from the per-user file")\n', None,
     f'        merge(tenant_users, TBL_TENANT, {TENANT_KEYS})'),
]


def old_cells(cells):
    """The cells with every write site put back as it was at 99f68c3."""
    old = list(cells)
    for marker, after, before, code in SWAPS:
        i = find(old, marker)
        old[i] = swap(old[i], after, before, code)
    return old


NOTEBOOK_TEXT = (REPO / NOTEBOOK_PATH).read_text(encoding="utf-8")
NEW_CELLS = notebook_cells(NOTEBOOK_TEXT)
OLD_CELLS = old_cells(NEW_CELLS)
RUN_ORDER = [find(NEW_CELLS, m) for m in RUN_MARKERS]
SETTINGS_CELL = RUN_ORDER[0]


def compiled(cells, version):
    code = []
    for i in RUN_ORDER:
        name = f"<{version} cell {i}>"
        linecache.cache[name] = (len(cells[i]), None, cells[i].splitlines(True), name)
        code.append((i, compile(cells[i], name, "exec")))
    return code


CODE = {"new": compiled(NEW_CELLS, "new"), "old": compiled(OLD_CELLS, "old")}


def run(spark, version, day, read_api=True, fail_at=None, at=time(6), snapshot_month=None):
    """Runs the cells as `version` ("new" or "old") on the morning of `day`. Like a notebook run, it stops at
    the first error, which it returns rather than raises."""
    spark.now, spark.fail_at = datetime.combine(day, at), fail_at
    spark.writes, spark.output, spark.history = [], [], []
    scope = {"__builtins__": BUILTINS, "__name__": "__main__", "spark": spark,
             "notebookutils": SimpleNamespace(fs=SimpleNamespace(ls=spark.ls)),
             "print": lambda *args, **kwargs: spark.output.append(" ".join(map(str, args)))}
    error = tb = None
    for i, code in CODE[version]:
        spark.cell = i
        try:
            exec(code, scope)
        except Exception as e:
            error, tb = e, traceback.format_exc()
            break
        if i == SETTINGS_CELL:
            scope["READ_API_FILES"] = read_api
            scope["SNAPSHOT_MONTH"] = snapshot_month or day.replace(day=1).isoformat()
    spark.cell = None
    return SimpleNamespace(error=error, tb=tb, writes=list(spark.writes), output=list(spark.output),
                           history=list(spark.history))


def snapshot(tables, drop=()):
    """Each table's columns and rows, in a form two runs' tables compare by. drop leaves columns out."""
    if isinstance(tables, FakeSpark):
        tables = tables.tables
    out = {}
    for name, t in tables.items():
        keep = [i for i, n in enumerate(t.names) if n not in drop]
        out[name] = (tuple(t.names[i] for i in keep), tuple(t.types[i] for i in keep),
                     Counter(tuple(r[i] for i in keep) for r in t.rows))
    return out


def differences(a, b, labels=("old", "new")):
    """What differs between two snapshots, as readable lines."""
    lines = []
    for name in sorted(set(a) | set(b)):
        if name not in a or name not in b:
            lines.append(f"{name} exists only in {labels[0] if name in a else labels[1]}")
            continue
        (names, types, rows), (other_names, other_types, other_rows) = a[name], b[name]
        if (names, types) != (other_names, other_types):
            lines.append(f"{name}: columns {list(zip(names, types))} against {list(zip(other_names, other_types))}")
            continue
        for label, extra in ((labels[0], rows - other_rows), (labels[1], other_rows - rows)):
            found = list(extra.elements())
            if found:
                lines.append(f"{name}: {len(found)} row(s) only in {label}, such as")
                lines.extend(f"    {dict(zip(names, r))}" for r in found[:5])
    return lines


def clone(spark):
    """A copy to run on. A write replaces a table rather than changing it, so the tables can be shared."""
    copy = FakeSpark()
    copy.tables, copy.files = dict(spark.tables), dict(spark.files)
    return copy


def rows_of(tables, table, **match):
    """A table's rows as dicts, keeping those whose columns equal every value in match. tables is a FakeSpark
    or its tables."""
    if isinstance(tables, FakeSpark):
        tables = tables.tables
    t = tables[table]
    rows = [dict(zip(t.names, r)) for r in t.rows]
    return [r for r in rows if all(r[k] == v for k, v in match.items())]


# Fixtures ----------------------------------------------------------------------------------------------
# Made-up IDs and names. Every credit is a multiple of 0.25 and the prepaid share is 0.75, so every sum is
# exact, whatever order the rows are added in.

LANDING_DIR = "Files/landing/studio"
PRODUCTION = "3c1e7a52-9b04-4f6d-a8e2-51d7c0b9e4f3"
SANDBOX = "8f2d4b60-1c7e-4a39-b5d8-e0a6f3c29d17"
TRAINING = "b74e0c19-6a2f-4d85-9c31-7f8e2a5b0c64"
ENVIRONMENTS = {PRODUCTION: ("Production", 600.0), SANDBOX: ("Sandbox", 250.0), TRAINING: ("Training", 150.0)}
EXPORT_PLAN = "d9a3f581-2e6c-4b07-8f4d-63c1b0e7a2f5"
API_PLAN = "00000000-0000-0000-0000-000000000000"
API, API_USERS = "ppac-api", "ppac-api-users"
MCS = "MCSMessages"


def agent(id, name, env, feature, channel, models, lag=0):
    return SimpleNamespace(id=id, name=name, env=env, feature=feature, channel=channel, models=models, lag=lag)


HELP_DESK = agent("0a4f2e81-6c3b-4d97-b1e5-8f2a7c9d3e60", "Help desk", PRODUCTION, "Generative answer", "Teams",
                  ("GPT-4o", "GPT-4o mini"))
HR = agent("5b8d1f34-2a6e-4c09-9d7b-3e1f6a0c8b25", "HR policies", PRODUCTION, "Generative answer", "Web", ("GPT-4o",))
SALES = agent("c2e9a7d6-4f13-4b58-a0c4-7d6b2e9f1a38", "Sales coach", SANDBOX, "Agent action", "Teams",
              ("GPT-4o mini",))
# The per-agent file has these two only from a day's third report on, so for two days the per-user file is
# all there is for their environments: one of which is no environment at all.
ONBOARDING = agent("7e3c5a90-8b2d-4e61-9f47-1a0d3c6b8e52", "Onboarding", TRAINING, "Generative answer", "Teams",
                   ("GPT-4o",), lag=2)
PILOT = agent("e1a6d4b7-3c9f-4a20-8e5d-6b2f9c0a7d13", "Pilot", None, "Generative answer", "Web", ("GPT-4o",), lag=2)
AGENTS = (HELP_DESK, HR, SALES, ONBOARDING, PILOT)

USERS = {"4e9a1c07-5d2b-4f83-a6e0-9b7c3d1f5a28": "avery@example.com",
         "a3f7c2e9-1b6d-4a50-8c94-2e5f7b0d6c13": "blake@example.com",
         "6d0b8e5a-9c3f-4e17-b2a6-4f8d1c7e0b95": "casey@example.com",
         "f8c2a6d1-7e4b-4093-9a5c-3b1e8d2f6a70": "devon@example.com"}
AVERY, BLAKE, CASEY, DEVON = USERS
USAGE = ((AVERY, HELP_DESK), (AVERY, HR), (BLAKE, HELP_DESK), (BLAKE, SALES), (CASEY, ONBOARDING),
         (CASEY, PILOT), (DEVON, HELP_DESK), (DEVON, PILOT))


def credit(day, key, age):
    """A day's credits as reported when the day is `age` days old. Late usage keeps arriving for four days."""
    return 0.25 * ((day.toordinal() * 7 + sum(map(ord, key))) % 13 + 1) + 0.25 * min(age, 4)


def us_date(day):
    return f"{day.month}/{day.day}/{day.year} 0:00"


def stamp(day):
    return f"{day:%Y%m%d}050000"


def csv_text(header, rows):
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\r\n")
    writer.writerow(header)
    writer.writerows(["" if v is None else v for v in r] for r in rows)
    return out.getvalue()


def window(run_day, days, skip=()):
    """(day, age) for each day a file the flow saves on run_day covers: the day before, and back."""
    return [(run_day - timedelta(n), n - 1) for n in range(1, days + 1) if run_day - timedelta(n) not in skip]


AGENT_HEADER = ("Usage Date", "Agent Id", "Agent Name", "Environment Id", "Environment Name", "Billed credit",
                "Non-billed credit", "Users", "Channel", "Feature", "LLM Model", "Tool Used", "Knowledge Sources",
                "Unit")
USER_HEADER = ("Usage Date", "User Id", "Environment Id", "Agent Id", "Billed credit", "Non-billed credit", "Unit")
ENTITLEMENT_HEADER = ("Snapshot Date", "Environment Id", "Environment Name", "Environment Allocated",
                      "Tenant Entitled", "Tenant Prepaid Consumed", "Tenant PAYG Consumed",
                      "Tenant Consumed Updated", "Status")


def api_agent_file(run_day, days=10, skip=()):
    rows = []
    for day, age in window(run_day, days, skip):
        for a in AGENTS:
            if age < a.lag:
                continue
            # The flow fills names from the environments API; Training's is missing, so the entitlement fills it.
            env_name = ENVIRONMENTS[a.env][0] if a.env in (PRODUCTION, SANDBOX) else None
            for model in a.models:
                rows.append((day.isoformat(), a.id, a.name, a.env, env_name, credit(day, a.id + model, age),
                             0.25 * (day.day % 3), 2 + day.day % 4, a.channel, a.feature, model,
                             "SharePoint search" if a is HELP_DESK else None, "HR site" if a is HR else None,
                             "Credits"))
    return csv_text(AGENT_HEADER, rows)


def api_user_file(run_day, days=10, skip=(), usage=USAGE):
    rows = []
    for day, age in window(run_day, days, skip):
        for user, a in usage:
            # The API gives Devon's object ID in upper case.
            rows.append((day.isoformat(), user.upper() if user == DEVON else user, a.env, a.id,
                         credit(day, user + a.id, age), 0.25 * (day.day % 2), "Credits"))
    return csv_text(USER_HEADER, rows)


def api_entitlement_file(run_day):
    return csv_text(ENTITLEMENT_HEADER, [(run_day.isoformat(), env, name, allocated, 1000.0, 300.0, 100.0,
                                          run_day.isoformat(), "Active")
                                         for env, (name, allocated) in ENVIRONMENTS.items()])


TENANT_EXPORT_HEADER = ("BillingPlan Id", "BillingPlan Name", "Environment Id", "Environment Name", "Capacity Type",
                        "Entitled Quantity", "Prepaid Consumed Quantity", "Pay as you go Consumed Quantity",
                        "Usage Date")
AGENT_EXPORT_HEADER = ("Agent Name", "Agent Id", "Product", "AI Feature/Billable Feature", "Billed credit",
                       "Non-billed credit", "Channel", "Knowledge Sources", "Tool Used", "LLM Model", "Scenario Name",
                       "Environment Id", "Environment Name")
USER_EXPORT_HEADER = ("User Id", "User Email", "Agent Id", "Agent Name", "Billable credit used", "Credits used",
                      "M365 Copilot Licensed")


def tenant_export(first, last, skip=(), no_environment=()):
    """PPAC's tenant export from first to last. no_environment: days with a row for no environment."""
    rows, day = [], first
    while day <= last:
        if day not in skip:
            rows += [(EXPORT_PLAN, "Copilot Studio capacity", env, name, MCS, allocated,
                      credit(day, "prepaid" + env, 9), credit(day, "payg" + env, 0) - 0.25, us_date(day))
                     for env, (name, allocated) in ENVIRONMENTS.items()]
        if day in no_environment:
            rows.append((EXPORT_PLAN, "Copilot Studio capacity", None, None, MCS, 0.0, 1.5, 0.0, us_date(day)))
        day += timedelta(1)
    return csv_text(TENANT_EXPORT_HEADER, rows)


def agent_export():
    """Sales coach isn't in it, so its API rows for the month don't share a key with an export row: the
    export's merge leaves them, and drop_api_rows deletes them."""
    return csv_text(AGENT_EXPORT_HEADER, [
        (a.name, a.id, "Copilot Studio", a.feature, 40.0 + 2.5 * i, 2.5, a.channel, None, None, a.models[0],
         None, a.env, ENVIRONMENTS[a.env][0] if a.env else None) for i, a in enumerate(AGENTS) if a is not SALES])


def user_export():
    """Devon isn't in it, so Devon's rows keep showing by ID."""
    return csv_text(USER_EXPORT_HEADER, [
        (user, f" {USERS[user].capitalize()} ", a.id, a.name, 10.0 + i, 12.5 + i, ("FALSE", "TRUE")[i % 2])
        for i, (user, a) in enumerate(USAGE) if user != DEVON])


def tenant_export_name(day):
    return f"EntitlementConsumptionTenantDetailsReport_MCSMessages_{stamp(day)}.csv"


def agent_export_name(day):
    return f"EntitlementConsumptionTenantPerAgentDetailsReport_MCSMessages_{stamp(day)}.csv"


def user_export_name(day):
    return f"EntitlementConsumptionTenantPerUserDetailsReport_MCSMessages_{stamp(day)}.csv"


def kind(name):
    """The file's kind: its name without the timestamp."""
    return name.rsplit("/", 1)[-1].rsplit("_", 1)[0]


def remove(spark, file_kind):
    for path in [p for p in spark.files if kind(p) == file_kind]:
        del spark.files[path]


def land(spark, name, text):
    """Saves a file into the landing folder as the flow and the installer do: it replaces the older file of
    its kind."""
    remove(spark, kind(name))
    spark.files[f"{LANDING_DIR}/{name}"] = text


def land_api(spark, run_day, days=10, skip=(), usage=USAGE):
    """The licensing API files the flow saves early on run_day. usage: the per-user file's (user, agent)
    pairs."""
    land(spark, f"StudioApiAgentDaily_{stamp(run_day)}.csv", api_agent_file(run_day, days, skip))
    land(spark, f"StudioApiUserDaily_{stamp(run_day)}.csv", api_user_file(run_day, days, skip, usage))
    land(spark, f"StudioApiEntitlement_{stamp(run_day)}.csv", api_entitlement_file(run_day))


def add(spark, table, **values):
    """Adds a row to a stored table, NULL in every column not given."""
    t = spark.tables[table]
    if set(values) - set(t.names):
        raise AssertionError(f"{table} has no {sorted(set(values) - set(t.names))}")
    spark.tables[table] = t.with_rows(t.rows + [tuple(values.get(n) for n in t.names)])


SEEDED = datetime(2026, 6, 1, 6)
OLD_EXPORT = tenant_export_name(date(2026, 6, 1))
NO_ENV_EXPORT_DAY, NO_ENV_NO_SOURCE_DAY, NO_SOURCE_DAY = date(2026, 6, 22), date(2026, 6, 23), date(2026, 6, 21)


def seed(spark):
    """Rows no file gives: NULL dates and months in every table, and on days the next runs replace, a tenant
    row with no environment from an older export, one with no environment and no source, sharing a key
    with a later API row, and one with no source, which counts as an export's."""
    add(spark, "studio_agent_daily", agent_id=HR.id, agent_name=HR.name, environment_id=PRODUCTION,
        billable_feature=HR.feature, channel=HR.channel, billed_credit=2.5, source_file=API, _loaded_at=SEEDED)
    add(spark, "studio_agent", agent_id=HR.id, agent_name=HR.name, product="Copilot Studio",
        environment_id=PRODUCTION, billed_credit=7.5, source_file=API, _loaded_at=SEEDED)
    add(spark, "studio_user_daily", user_id=AVERY, environment_id=PRODUCTION, agent_id=HR.id, billed_credit=1.25,
        source_file=API, _loaded_at=SEEDED)
    add(spark, "studio_user", user_id=AVERY, agent_id=HR.id, credits_used=3.75, source_file=API, _loaded_at=SEEDED)
    tenant = dict(billing_plan_id=API_PLAN, capacity_type=MCS, entitled_quantity=0.0, payg_consumed=0.0,
                  _loaded_at=SEEDED)
    add(spark, "studio_tenant_daily", **tenant, environment_id=PRODUCTION, prepaid_consumed=4.5, source_file=API)
    add(spark, "studio_tenant_daily", **tenant, environment_id=TRAINING, prepaid_consumed=1.5, source_file=API_USERS)
    add(spark, "studio_tenant_daily", **dict(tenant, billing_plan_id=EXPORT_PLAN), usage_date=NO_ENV_EXPORT_DAY,
        prepaid_consumed=2.0, source_file=OLD_EXPORT)
    add(spark, "studio_tenant_daily", **tenant, usage_date=NO_ENV_NO_SOURCE_DAY, prepaid_consumed=0.75)
    add(spark, "studio_tenant_daily", **dict(tenant, billing_plan_id=EXPORT_PLAN), usage_date=NO_SOURCE_DAY,
        environment_id=SANDBOX, prepaid_consumed=5.0)


# The scenario ------------------------------------------------------------------------------------------

AGENT_DAILY, AGENT_MONTHLY, TENANT = "studio_agent_daily", "studio_agent", "studio_tenant_daily"
USER_DAILY, USER_MONTHLY = "studio_user_daily", "studio_user"
CELL = dict(zip(("settings", "helpers", "tenant", "agent", "user", "api_agent", "api_user", "sum"), RUN_ORDER))
API_CELLS = {CELL["api_agent"], CELL["api_user"], CELL["sum"]}

FIRST_RUN, LAST_RUN = date(2026, 6, 24), date(2026, 8, 4)
RERUN_DAY = date(2026, 7, 5)                                # run again at 07:00 on the same files
EXPORT_DAY = date(2026, 7, 12)                              # PPAC's three exports land
GAP_RUN, GAP_DAY = date(2026, 7, 20), date(2026, 7, 15)     # that run's files have nothing for GAP_DAY,
NO_ENV_DAY = date(2026, 7, 17)                              # and a newer tenant export with a no-environment row lands
READ_OFF_DAY = date(2026, 7, 25)                            # READ_API_FILES is off for one run
EXPORTS_GONE = date(2026, 8, 1)                             # the per-agent and per-user exports are taken out
CONVERT_RUN = date(2026, 6, 30)                             # a day the tests look at closely
JUNE, JULY, AUGUST = date(2026, 6, 1), date(2026, 7, 1), date(2026, 8, 1)


def prepare(spark, day):
    """What lands before the run on day."""
    land_api(spark, day, days=20 if day == FIRST_RUN else 10, skip={GAP_DAY} if day == GAP_RUN else ())
    if day == EXPORT_DAY:
        land(spark, tenant_export_name(day), tenant_export(date(2026, 6, 1), date(2026, 7, 10)))
        land(spark, agent_export_name(day), agent_export())
        land(spark, user_export_name(day), user_export())
    if day == GAP_RUN:
        land(spark, tenant_export_name(day),
             tenant_export(date(2026, 6, 1), date(2026, 7, 18), skip={GAP_DAY}, no_environment={NO_ENV_DAY}))
    if day == EXPORTS_GONE:
        remove(spark, kind(agent_export_name(day)))
        remove(spark, kind(user_export_name(day)))


def days_between(first, last):
    return [first + timedelta(n) for n in range((last - first).days + 1)]


@functools.cache
def scenario():
    """Both versions, run daily from FIRST_RUN, when no table exists, to LAST_RUN, on the same files. Each
    run records its results and the tables before and after it."""
    sparks = {"old": FakeSpark(), "new": FakeSpark()}
    runs = []
    for day in days_between(FIRST_RUN, LAST_RUN):
        for spark in sparks.values():
            prepare(spark, day)
        for at in (time(6), time(7)) if day == RERUN_DAY else (time(6),):
            before = {v: dict(s.tables) for v, s in sparks.items()}
            results = {v: run(s, v, day, read_api=day != READ_OFF_DAY, at=at) for v, s in sparks.items()}
            runs.append(SimpleNamespace(day=day, at=at, before=before, results=results,
                                        after={v: dict(s.tables) for v, s in sparks.items()}))
        if day == FIRST_RUN:
            for spark in sparks.values():
                seed(spark)
    return SimpleNamespace(runs=runs, sparks=sparks, seeded=runs[1].before)


def run_on(day, at=time(6)):
    return next(r for r in scenario().runs if r.day == day and r.at == at)


def before_run(day, version="new"):
    """A FakeSpark holding the scenario's tables as they were before its run on day, and the landing folder
    as that run found it."""
    spark = FakeSpark()
    for d in days_between(FIRST_RUN, day):
        prepare(spark, d)
    spark.tables = dict(run_on(day).before[version])
    return spark


def sources(tables, table, **match):
    """How many of the rows match has each source file."""
    return Counter(r["source_file"] for r in rows_of(tables, table, **match))


def frozen(rows, drop=()):
    """Rows as a multiset of their values, leaving out the columns in drop."""
    return Counter(tuple(v for k, v in r.items() if k not in drop) for r in rows)


LOADED = ("_loaded_at",)

# What a day is in each table: a date, a month, or for the tenant table a date and an environment.
DAY_COLUMNS = ((AGENT_DAILY, ("usage_date",)), (AGENT_MONTHLY, ("snapshot_month",)), (USER_DAILY, ("usage_date",)),
               (USER_MONTHLY, ("snapshot_month",)), (TENANT, ("usage_date", "environment_id")))


def counted(tables):
    """{(table, day): how many licensing API rows the day has} for every day a dated row is on. A day only
    an export's rows are on maps to 0."""
    out = {}
    for table, columns in DAY_COLUMNS:
        t = tables.get(table)
        if t is None:
            continue
        picks, source = [t.names.index(c) for c in columns], t.names.index("source_file")
        for r in t.rows:
            if r[picks[0]] is not None:
                key = (table,) + tuple(r[i] for i in picks)
                out[key] = out.get(key, 0) + (r[source] in (API, API_USERS))
    return out


def oracle_text():
    """The notebook at ORACLE_COMMIT, or None where git can't show it, as in CI's shallow checkout."""
    try:
        out = subprocess.run(["git", "show", f"{ORACLE_COMMIT}:{NOTEBOOK_PATH}"], cwd=REPO, capture_output=True,
                             check=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.decode("utf-8")


# Tests -------------------------------------------------------------------------------------------------

class Structure(unittest.TestCase):
    def test_the_old_cells_are_the_notebook_at_the_oracle_commit(self):
        text = oracle_text()
        if text is None:
            self.skipTest(f"git can't show {ORACLE_COMMIT} here")
        self.assertEqual(OLD_CELLS, notebook_cells(text))

    def test_each_old_write_site_is_the_code_at_the_oracle_commit(self):
        text = oracle_text()
        if text is None:
            self.skipTest(f"git can't show {ORACLE_COMMIT} here")
        cells = notebook_cells(text)
        for marker, after, before, old in SWAPS:
            cell, whole = cells[find(cells, marker)], (after or "") + old + (before or "")
            with self.subTest(marker=marker, code=old[:60]):
                if after is None:
                    self.assertTrue(cell.startswith(whole))
                elif before is None:
                    self.assertTrue(cell.endswith(whole))
                else:
                    self.assertEqual(cell.count(whole), 1)

    def test_every_code_cell_runs_but_the_summary_which_writes_nothing(self):
        skipped = [i for i, c in enumerate(NEW_CELLS) if c is not None and i not in RUN_ORDER]
        self.assertEqual(len(skipped), 1)
        summary = NEW_CELLS[skipped[0]]
        self.assertIn(SUMMARY_MARKER, summary)
        for write in ("saveAsTable", "DeltaTable", "delete(", "merge(", "replace_rows("):
            self.assertNotIn(write, summary)


class SameEndState(unittest.TestCase):
    """Daily runs from a first run, with no tables, to LAST_RUN: every run ends as the code at ORACLE_COMMIT
    would end it."""

    def test_every_run_succeeds(self):
        for r in scenario().runs:
            for version, result in r.results.items():
                self.assertIsNone(result.error, f"{version} on {r.day} at {r.at}:\n{result.tb}")

    def test_every_run_ends_as_the_old_code_would(self):
        for r in scenario().runs:
            with self.subTest(day=r.day, at=r.at):
                self.assertEqual(differences(snapshot(r.after["old"]), snapshot(r.after["new"])), [])

    def test_the_export_cells_write_as_before(self):
        for r in scenario().runs:
            old, new = ([w for w in r.results[v].writes if w[0] not in API_CELLS] for v in ("old", "new"))
            self.assertEqual(old, new, r.day)

    def test_each_api_cell_writes_each_table_in_one_commit(self):
        for r in scenario().runs:
            writes = [w for w in r.results["new"].writes if w[0] in API_CELLS]
            with self.subTest(day=r.day, at=r.at):
                self.assertEqual(len(writes), len({(cell, table) for cell, table, _ in writes}))
                self.assertEqual({operation for _, _, operation in writes} - {"create", "replaceWhere"}, set())


class Cases(unittest.TestCase):
    """What the scenario's runs did, so the comparison above isn't empty."""

    def test_a_first_run_creates_every_table(self):
        r = run_on(FIRST_RUN)
        self.assertEqual(r.before["new"], {})
        agent, user, total = CELL["api_agent"], CELL["api_user"], CELL["sum"]
        self.assertEqual(r.results["new"].writes,
                         [(agent, AGENT_DAILY, "create"), (agent, AGENT_MONTHLY, "create"), (agent, TENANT, "create"),
                          (user, USER_DAILY, "create"), (user, USER_MONTHLY, "create"),
                          (total, TENANT, "replaceWhere")])
        self.assertEqual(len({x["usage_date"] for x in rows_of(r.after["new"], AGENT_DAILY)}), 20)

    def test_a_rerun_of_the_same_files_changes_only_load_times(self):
        first, again = run_on(RERUN_DAY), run_on(RERUN_DAY, time(7))
        self.assertTrue(again.results["new"].writes)
        self.assertEqual(differences(snapshot(first.after["new"], drop=LOADED),
                                     snapshot(again.after["new"], drop=LOADED), ("06:00", "07:00")), [])
        window = {RERUN_DAY - timedelta(n) for n in range(1, 11)}
        for table in (AGENT_DAILY, USER_DAILY):
            self.assertEqual({x["_loaded_at"] for x in rows_of(again.after["new"], table) if x["usage_date"] in window},
                             {datetime.combine(RERUN_DAY, time(7))}, table)

    def test_an_overlapping_file_restates_its_days_and_keeps_older_ones(self):
        r = run_on(CONVERT_RUN)
        first, restated = CONVERT_RUN - timedelta(10), CONVERT_RUN - timedelta(2)
        for table in (AGENT_DAILY, USER_DAILY):
            with self.subTest(table=table):
                def older(tables):
                    return frozen(x for x in rows_of(tables, table) if x["usage_date"] and x["usage_date"] < first)

                def credits(tables):
                    return sum(x["billed_credit"] for x in rows_of(tables, table, usage_date=restated))
                self.assertTrue(older(r.before["new"]))
                self.assertEqual(older(r.after["new"]), older(r.before["new"]))
                self.assertGreater(credits(r.after["new"]), credits(r.before["new"]))

    def test_per_user_tenant_rows_turn_into_api_rows_as_the_agent_file_catches_up(self):
        r = run_on(CONVERT_RUN)
        # (days before the run, sources before, sources after) for an environment the agent file has from
        # a day's third report on.
        expected = ((1, {}, {API_USERS: 1}), (2, {API_USERS: 1}, {API_USERS: 1}), (3, {API_USERS: 1}, {API: 1}))
        for env in (TRAINING, None):
            for n, was, now in expected:
                with self.subTest(env=env, day=CONVERT_RUN - timedelta(n)):
                    on = dict(usage_date=CONVERT_RUN - timedelta(n), environment_id=env)
                    self.assertEqual(sources(r.before["new"], TENANT, **on), Counter(was))
                    self.assertEqual(sources(r.after["new"], TENANT, **on), Counter(now))

    def test_a_day_the_files_leave_out_keeps_its_rows(self):
        r = run_on(GAP_RUN)
        for table in (AGENT_DAILY, USER_DAILY, TENANT):
            with self.subTest(table=table):
                was = frozen(rows_of(r.before["new"], table, usage_date=GAP_DAY))
                self.assertTrue(was)
                self.assertEqual(frozen(rows_of(r.after["new"], table, usage_date=GAP_DAY)), was)

    def test_each_api_file_restates_only_its_own_days(self):
        # The per-user file has 6 days and the per-agent file 10: the 4 days only the agent file has keep
        # their user rows.
        day = date(2026, 7, 8)
        only_agent = {day - timedelta(n) for n in range(7, 11)}
        ends = {}
        for version in ("old", "new"):
            with self.subTest(version=version):
                spark = before_run(day, version)
                before = dict(spark.tables)
                land(spark, f"StudioApiUserDaily_{stamp(day)}.csv", api_user_file(day, days=6))
                result = run(spark, version, day)
                ends[version] = spark.tables
                self.assertIsNone(result.error, result.tb)
                kept = frozen(x for x in rows_of(before, USER_DAILY) if x["usage_date"] in only_agent)
                self.assertTrue(kept)
                self.assertEqual(frozen(x for x in rows_of(spark, USER_DAILY) if x["usage_date"] in only_agent), kept)
                self.assertEqual({x["_loaded_at"] for x in rows_of(spark, AGENT_DAILY) if x["usage_date"] in only_agent},
                                 {datetime.combine(day, time(6))})
        self.assertEqual(differences(snapshot(ends["old"]), snapshot(ends["new"])), [])

    def test_an_export_replaces_the_api_figures_for_what_it_covers(self):
        r = run_on(EXPORT_DAY)
        before, after, end = r.before["new"], r.after["new"], scenario().runs[-1].after["new"]
        for table in (AGENT_MONTHLY, USER_MONTHLY):
            with self.subTest(table=table):
                self.assertEqual(set(sources(before, table, snapshot_month=JULY)), {API})
                self.assertEqual(set(sources(after, table, snapshot_month=JULY)) & {API, API_USERS}, set())
                self.assertTrue(rows_of(before, table, snapshot_month=JUNE))
                self.assertEqual(frozen(rows_of(after, table, snapshot_month=JUNE)),
                                 frozen(rows_of(before, table, snapshot_month=JUNE)))
                # A month no export covers gets the API figures; July keeps the export's.
                self.assertEqual(set(sources(end, table, snapshot_month=AUGUST)), {API})
                self.assertEqual(sources(end, table, snapshot_month=JULY), sources(after, table, snapshot_month=JULY))
        exported = set(days_between(JUNE, date(2026, 7, 10)))
        self.assertIn(API, sources(before, TENANT, usage_date=date(2026, 7, 5), environment_id=PRODUCTION))
        self.assertEqual([x for x in rows_of(after, TENANT) if x["usage_date"] in exported and x["environment_id"]
                          and x["source_file"] in (API, API_USERS)], [])
        # The export's merge takes over a row with no source.
        on = dict(usage_date=NO_SOURCE_DAY, environment_id=SANDBOX)
        self.assertEqual(sources(before, TENANT, **on), Counter({None: 1}))
        self.assertEqual(sources(after, TENANT, **on), Counter({tenant_export_name(EXPORT_DAY): 1}))

    def test_a_no_environment_row_from_an_export_is_kept(self):
        # An older export's, which the API rows' write selects while its day is in the window.
        seeded = rows_of(scenario().seeded["new"], TENANT, source_file=OLD_EXPORT)
        self.assertEqual(len(seeded), 1)
        for r in scenario().runs[1:]:
            self.assertEqual(rows_of(r.after["new"], TENANT, source_file=OLD_EXPORT), seeded, r.day)
        # A newer export's. Its API row is deleted and written again as long as the day is in the window,
        # as before: the API rows' check for exported days doesn't match a missing environment ID.
        export = Counter({tenant_export_name(GAP_RUN): 1})
        for day, also in ((GAP_RUN, {API: 1}), (READ_OFF_DAY, {}), (date(2026, 7, 27), {API: 1}),
                          (date(2026, 7, 28), {}), (LAST_RUN, {})):
            with self.subTest(day=day):
                self.assertEqual(sources(run_on(day).after["new"], TENANT, usage_date=NO_ENV_DAY, environment_id=None),
                                 export + Counter(also))

    def test_rows_with_no_date_stay_but_per_user_tenant_rows(self):
        dated = ((AGENT_DAILY, "usage_date"), (AGENT_MONTHLY, "snapshot_month"), (USER_DAILY, "usage_date"),
                 (USER_MONTHLY, "snapshot_month"), (TENANT, "usage_date"))
        for version in ("old", "new"):
            for table, column in dated:
                with self.subTest(version=version, table=table):
                    def undated(tables):
                        return frozen(x for x in rows_of(tables, table) if x[column] is None)
                    seeded = frozen(x for x in rows_of(scenario().seeded[version], table)
                                    if x[column] is None and x["source_file"] != API_USERS)
                    self.assertTrue(seeded)
                    self.assertEqual(undated(scenario().runs[-1].after[version]), seeded)
            self.assertEqual(sources(scenario().seeded[version], TENANT, usage_date=None),
                             Counter({API: 1, API_USERS: 1}))
            self.assertEqual(sources(run_on(FIRST_RUN + timedelta(1)).after[version], TENANT, usage_date=None),
                             Counter({API: 1}))

    def test_with_the_api_files_off_only_the_export_cells_write(self):
        r = run_on(READ_OFF_DAY)
        for version in ("old", "new"):
            with self.subTest(version=version):
                writes = r.results[version].writes
                self.assertTrue(writes)
                self.assertEqual({cell for cell, _, _ in writes} & API_CELLS, set())
                self.assertIn("licensing API files are off - nothing to sum", r.results[version].output)
                for table in (AGENT_DAILY, USER_DAILY):
                    self.assertIs(r.after[version][table], r.before[version][table])


class Cell14(unittest.TestCase):
    """When there's nothing to sum, the per-user tenant rows are deleted in one commit, as before."""

    NEXT = FIRST_RUN + timedelta(1)

    def check(self, land_files, message):
        sparks = {"old": FakeSpark(), "new": FakeSpark()}
        older = dict(usage_date=date(2026, 6, 1), environment_id=TRAINING, billing_plan_id=API_PLAN,
                     capacity_type=MCS, prepaid_consumed=1.5, source_file=API_USERS, _loaded_at=SEEDED)
        for day in (FIRST_RUN, self.NEXT):
            for version, spark in sparks.items():
                land_files(spark, day)
                result = run(spark, version, day)
                self.assertIsNone(result.error, result.tb)
                if version == "new":
                    self.assertEqual([w for w in result.writes if w[0] == CELL["sum"]],
                                     [(CELL["sum"], TENANT, "delete")])
                    self.assertIn(message, result.output)
                self.assertEqual(sources(spark, TENANT)[API_USERS], 0)
            self.assertEqual(differences(snapshot(sparks["old"]), snapshot(sparks["new"])), [])
            if day == FIRST_RUN:
                for spark in sparks.values():
                    add(spark, TENANT, **older)

    def test_every_day_with_user_credits_has_tenant_rows(self):
        def land_files(spark, day):
            land_api(spark, day, days=20 if day == FIRST_RUN else 10, usage=USAGE[:4])
        self.check(land_files, "  every day with user credits already has tenant rows")

    def test_there_is_no_per_user_table(self):
        def land_files(spark, day):
            land_api(spark, day, days=20 if day == FIRST_RUN else 10)
            remove(spark, "StudioApiUserDaily")
        self.check(land_files, "no per-user daily table - nothing to sum")


class Failures(unittest.TestCase):
    """A failed write leaves its table as it was. A rerun, or the next day's run, ends as if nothing had
    failed."""

    DAY, NEXT = LAST_RUN + timedelta(1), LAST_RUN + timedelta(2)

    @classmethod
    def start(cls, version, day=None):
        spark = clone(scenario().sparks[version])
        prepare(spark, day or cls.DAY)
        return spark

    @classmethod
    def setUpClass(cls):
        cls.clean = {}
        for version in ("old", "new"):
            spark = cls.start(version)
            first = run(spark, version, cls.DAY)
            day_end = dict(spark.tables)
            prepare(spark, cls.NEXT)
            second = run(spark, version, cls.NEXT)
            cls.clean[version] = SimpleNamespace(first=first, day_end=day_end, second=second, end=dict(spark.tables))

    def test_the_clean_runs_succeed_and_write_every_table(self):
        for version, clean in self.clean.items():
            self.assertIsNone(clean.first.error, clean.first.tb)
            self.assertIsNone(clean.second.error, clean.second.tb)
        self.assertEqual([w[:2] for w in self.clean["new"].first.writes],
                         [(CELL["tenant"], TENANT), (CELL["tenant"], TENANT),
                          (CELL["api_agent"], AGENT_DAILY), (CELL["api_agent"], AGENT_MONTHLY),
                          (CELL["api_agent"], TENANT), (CELL["api_user"], USER_DAILY),
                          (CELL["api_user"], USER_MONTHLY), (CELL["sum"], TENANT)])

    def test_a_failed_write_changes_nothing_and_the_next_run_heals(self):
        clean = self.clean["new"]
        for k, write in enumerate(clean.first.writes, 1):
            with self.subTest(failing=write, at=k):
                spark = self.start("new")
                expected = snapshot(spark if k == 1 else clean.first.history[k - 2])
                failed = run(spark, "new", self.DAY, fail_at=k)
                self.assertIsInstance(failed.error, SimulatedFailure)
                self.assertEqual(failed.writes[-1], write)
                self.assertEqual(differences(expected, snapshot(spark), ("before", "after")), [])
                rerun = clone(spark)
                self.assertIsNone(run(rerun, "new", self.DAY).error)
                self.assertEqual(differences(snapshot(clean.day_end), snapshot(rerun), ("clean", "rerun")), [])
                prepare(spark, self.NEXT)
                self.assertIsNone(run(spark, "new", self.NEXT).error)
                self.assertEqual(differences(snapshot(clean.end, drop=LOADED), snapshot(spark, drop=LOADED),
                                             ("clean", "next day")), [])

    def test_no_failure_leaves_a_day_missing_or_counted_twice(self):
        # A failed write leaves the tables as the write before it left them (the test above), so every state
        # between two of a run's writes is one a failure can leave.
        found = {version: {"missing": set(), "twice": set()} for version in ("old", "new")}
        for r in scenario().runs:
            for version, result in r.results.items():
                start = counted(r.before[version])
                for tables in result.history:
                    now = counted(tables)
                    found[version]["missing"] |= {(r.day, day) for day in start if day not in now}
                    found[version]["twice"] |= {(r.day, day) for day, n in now.items() if n > 1 and day[0] == TENANT}
        for version, what in (("new", "missing"), ("new", "twice"), ("old", "twice")):
            self.assertEqual(sorted(found[version][what], key=str)[:5], [], f"{version}: days {what}")
        # The old code deleted, then merged or appended: a failed merge left the deleted days missing.
        self.assertTrue(found["old"]["missing"])

    def test_the_oldest_day_survives_where_the_old_code_lost_it(self):
        oldest = self.DAY - timedelta(10)
        self.assertTrue(rows_of(self.clean["old"].end, AGENT_DAILY, usage_date=oldest))
        lost = {}
        for version, k, write in (("old", 4, "merge"), ("new", 3, "replaceWhere")):
            spark = self.start(version)
            failed = run(spark, version, self.DAY, fail_at=k)
            self.assertEqual(failed.writes[-1], (CELL["api_agent"], AGENT_DAILY, write))
            prepare(spark, self.NEXT)
            self.assertIsNone(run(spark, version, self.NEXT).error)
            lost[version] = (frozen(rows_of(self.clean[version].end, AGENT_DAILY, usage_date=oldest), LOADED)
                             - frozen(rows_of(spark, AGENT_DAILY, usage_date=oldest), LOADED))
        # The old code deleted the file's days, then failed to merge; the next file starts a day later.
        self.assertTrue(lost["old"])
        self.assertEqual(lost["new"], Counter())

    def test_a_failed_first_run_leaves_a_missing_table_missing(self):
        clean = FakeSpark()
        prepare(clean, FIRST_RUN)
        ok = run(clean, "new", FIRST_RUN)
        self.assertIsNone(ok.error, ok.tb)
        for k, write in enumerate(ok.writes, 1):
            with self.subTest(failing=write, at=k):
                spark = FakeSpark()
                prepare(spark, FIRST_RUN)
                failed = run(spark, "new", FIRST_RUN, fail_at=k)
                self.assertIsInstance(failed.error, SimulatedFailure)
                self.assertEqual(snapshot(spark), snapshot({} if k == 1 else ok.history[k - 2]))
                if write[2] == "create":
                    self.assertNotIn(write[1], spark.tables)
                self.assertIsNone(run(spark, "new", FIRST_RUN).error)
                self.assertEqual(differences(snapshot(clean), snapshot(spark), ("clean", "rerun")), [])


class Divergence(unittest.TestCase):
    """The one stored state the new tenant write ends differently from: identical rows on one key."""

    def test_two_identical_rows_on_a_key_become_one_api_row_rather_than_two(self):
        day, on = CONVERT_RUN - timedelta(3), dict(usage_date=CONVERT_RUN - timedelta(3), environment_id=TRAINING)
        sparks = {}
        for version in ("old", "new"):
            spark = before_run(CONVERT_RUN, version)
            stored = rows_of(spark, TENANT, **on)
            self.assertEqual([x["source_file"] for x in stored], [API_USERS], version)
            add(spark, TENANT, **stored[0])
            result = run(spark, version, CONVERT_RUN)
            self.assertIsNone(result.error, result.tb)
            sparks[version] = spark
        # The old merge updated both copies; the new write replaces the key's rows with the file's one row.
        self.assertEqual(sources(sparks["old"], TENANT, **on), Counter({API: 2}))
        self.assertEqual(sources(sparks["new"], TENANT, **on), Counter({API: 1}))
        old = snapshot(sparks["old"])
        names, types, rows = old[TENANT]
        [extra] = {r for r in rows if r[names.index("usage_date")] == day and r[names.index("environment_id")] == TRAINING}
        old[TENANT] = (names, types, rows - Counter([extra]))
        self.assertEqual(differences(old, snapshot(sparks["new"])), [])


class ExportPairs(unittest.TestCase):
    """Cells 4, 6 and 8 merge an export, then delete the API rows it covers: two commits, which this change
    leaves as they were. Until the delete runs, the export and the API rows count the same credits."""

    NEXT = EXPORT_DAY + timedelta(1)
    PAIRS = ((CELL["tenant"], TENANT), (CELL["agent"], AGENT_MONTHLY), (CELL["user"], USER_MONTHLY))

    @staticmethod
    def second_write(writes, cell, table):
        return [i for i, w in enumerate(writes, 1) if w[:2] == (cell, table)][1]

    def test_a_failed_delete_heals_at_the_next_run_in_the_month(self):
        writes = run_on(EXPORT_DAY).results["new"].writes
        exported = dict(usage_date=date(2026, 7, 5), environment_id=PRODUCTION)
        for cell, table in self.PAIRS:
            with self.subTest(table=table):
                spark = before_run(EXPORT_DAY)
                failed = run(spark, "new", EXPORT_DAY, fail_at=self.second_write(writes, cell, table))
                self.assertIsInstance(failed.error, SimulatedFailure)
                if table == TENANT:
                    self.assertEqual(set(sources(spark, TENANT, **exported)), {API, tenant_export_name(EXPORT_DAY)})
                else:
                    self.assertEqual(set(sources(spark, table, snapshot_month=JULY)) & {API}, {API})
                    self.assertGreater(len(sources(spark, table, snapshot_month=JULY)), 1)
                prepare(spark, self.NEXT)
                self.assertIsNone(run(spark, "new", self.NEXT).error)
                self.assertEqual(snapshot(spark, drop=LOADED)[table],
                                 snapshot(run_on(self.NEXT).after["new"], drop=LOADED)[table])

    def test_a_failed_delete_on_a_months_last_run_heals_only_with_a_rerun_for_that_month(self):
        last = date(2026, 7, 31)
        for cell, table, name in ((CELL["agent"], AGENT_MONTHLY, agent_export_name(last)),
                                  (CELL["user"], USER_MONTHLY, user_export_name(last))):
            with self.subTest(table=table):
                spark = FakeSpark()
                land_api(spark, last - timedelta(1), days=30)
                self.assertIsNone(run(spark, "new", last - timedelta(1)).error)
                land_api(spark, last)
                # PPAC's three exports land together. Without the tenant one, cell 4's looser pattern would
                # pick up the other two.
                land(spark, tenant_export_name(last), tenant_export(JULY, last - timedelta(2)))
                land(spark, agent_export_name(last), agent_export())
                land(spark, user_export_name(last), user_export())
                clean = run(clone(spark), "new", last)
                failed = run(spark, "new", last, fail_at=self.second_write(clean.writes, cell, table))
                self.assertIsInstance(failed.error, SimulatedFailure)
                july = sources(spark, table, snapshot_month=JULY)
                self.assertEqual(set(july), {API, name})
                # The next run is in August, so it takes the export, still in landing, as August's.
                land_api(spark, AUGUST)
                self.assertIsNone(run(spark, "new", AUGUST).error)
                self.assertEqual(sources(spark, table, snapshot_month=JULY), july)
                self.assertIn(name, sources(spark, table, snapshot_month=AUGUST))
                self.assertIsNone(run(spark, "new", AUGUST, snapshot_month=JULY.isoformat()).error)
                self.assertEqual(set(sources(spark, table, snapshot_month=JULY)), {name})


def without(spark, table, column):
    """Takes a column out of a stored table."""
    t = spark.tables[table]
    i = t.names.index(column)
    spark.tables[table] = Table(t.names[:i] + t.names[i + 1:], t.types[:i] + t.types[i + 1:],
                                [r[:i] + r[i + 1:] for r in t.rows])


def with_column(spark, table, column, dtype):
    """Adds a column, NULL in every row, to a stored table."""
    t = spark.tables[table]
    spark.tables[table] = Table(t.names + [column], t.types + [dtype], [r + (None,) for r in t.rows])


class Schema(unittest.TestCase):
    """A table and the rows written to it can differ by a column, for instance after someone changes one."""

    DAY = CONVERT_RUN - timedelta(2)
    TABLES = (AGENT_DAILY, AGENT_MONTHLY, TENANT, USER_DAILY, USER_MONTHLY)

    def test_a_column_the_table_lacks_is_left_out_as_before(self):
        for table in self.TABLES:
            with self.subTest(table=table):
                sparks = {}
                for version in ("old", "new"):
                    spark = before_run(self.DAY, version)
                    without(spark, table, "_loaded_at")
                    result = run(spark, version, self.DAY)
                    self.assertIsNone(result.error, result.tb)
                    self.assertIn(table, {w[1] for w in result.writes})
                    self.assertNotIn("_loaded_at", spark.tables[table].names)
                    sparks[version] = spark
                self.assertEqual(differences(snapshot(sparks["old"]), snapshot(sparks["new"])), [])

    def test_a_column_the_rows_lack_fails_the_run_which_now_leaves_the_table_as_it_was(self):
        for table in self.TABLES:
            for version in ("old", "new"):
                with self.subTest(table=table, version=version):
                    spark = before_run(self.DAY, version)
                    with_column(spark, table, "notes", STRING)
                    before = dict(spark.tables)
                    result = run(spark, version, self.DAY)
                    self.assertIsInstance(result.error, AnalysisError)
                    if version == "new":
                        self.assertIn("UNRESOLVED_COLUMN", str(result.error))
                        self.assertEqual([w for w in result.writes if w[1] == table], [])
                        self.assertEqual(snapshot(spark)[table], snapshot(before)[table])
                    else:
                        # The old code's delete went through, then its merge failed.
                        self.assertIn("DELTA_MERGE_UNRESOLVED_EXPRESSION", str(result.error))
                        self.assertEqual(result.writes[-1][1:], (table, "delete"))
                        self.assertLess(len(spark.tables[table].rows), len(before[table].rows))


if __name__ == "__main__":
    unittest.main()


