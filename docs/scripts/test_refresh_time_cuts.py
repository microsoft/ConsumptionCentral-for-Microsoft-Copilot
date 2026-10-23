"""Tests for docs/scripts/fix_refresh_time_cuts.py.

Ported from Analytics Hub at commit 1af87db (microsoft/AnalyticsHub-Dashboard#175
and #176): tests/test_consumption_cohort_dax.py, and the Consumption Central
parts of tests/test_model_refresh_fixes.py.

The old columns ranked with RANKX. Analytics Hub replayed them with DuckDB's
RANK(); here a plain Python rank does the same job, so the tests need only the
standard library. RANKX ascending, with its default Skip ties, gives each row
1 plus the number of strictly smaller values, and DAX compares a blank number
as 0. The new columns are replayed step by step with DAX's blank and DIVIDE
rules (and, for UsageCohortRank, the steps of CoworkBilling's query), over
generated values with ties, blanks, zeros, negatives and fractions, and table
sizes from 0 up. Analytics Hub's per-row COUNT test is left out: that form
never shipped here, and it is the reference rank itself.

The rest runs the fix against all four shipped templates. They carry the cuts
in both model parts. Undoing every cut in memory and running the fix again
gives the shipped template back, and a second run changes nothing. The fix
refuses input it does not recognise.

    python docs/scripts/test_refresh_time_cuts.py
"""
import bisect
import contextlib
import copy
import functools
import io
import json
import math
import random
import re
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_refresh_time_cuts as check  # noqa: E402
import fix_refresh_time_cuts as F  # noqa: E402

CUTS = [float(cut) for _, cut in F.COHORT_CUTS]
COHORT_LABELS = [label.strip('"') for label in F.COHORT_LABELS]
INTENSITY_LABELS = [label.strip('"') for label in F.INTENSITY_LABELS]
LINEAGE_TAG = "7b0e3f86-4d29-4c51-9f3a-8e2c6b9d4e73"
BUFFERED_RAW = r'Raw = let r = GetTable\("\w+"\) in if r = null then null else Table\.Buffer\(r\),'


def joined(value):
    return "\n".join(value) if isinstance(value, list) else value


def code(dax):
    return "\n".join(line for line in dax.split("\n") if not line.lstrip().startswith("//"))


def number(value):
    """DAX compares a blank number as 0."""
    return 0 if value is None else value


def divide(numerator, denominator):
    return None if denominator == 0 else numerator / denominator


# ---------------------------------------------------------------------------
# The old and new forms, replayed
# ---------------------------------------------------------------------------


def build_samples():
    rng = random.Random(20240611)
    fixed = [
        [], [None], [0], [7], [-3], [None, None], [0, 0], [1, 1], [1, 2], [2, 1], [None, 0, -1],
        [5] * 100, list(range(1, 101)), list(range(100, 0, -1)), [0.1, 0.2, 0.30000000000000004, 0.3],
        [1e-12, 0, -1e-12, 1e15], [float(i % 3) for i in range(57)],
    ]
    for n in range(1, 41):
        fixed.append([rng.choice([None, 0, 1, 2, 2, 3]) for _ in range(n)])
    generated = []
    for _ in range(300):
        n = rng.choice([rng.randint(1, 30), rng.randint(31, 400), rng.randint(401, 2500)])
        pool = [None, 0, -5] + [rng.randint(1, max(2, n // 4)) for _ in range(8)] + [round(rng.random() * 50, 2)]
        style = rng.random()
        if style < 0.3:
            values = [rng.choice(pool) for _ in range(n)]
        elif style < 0.6:
            values = [rng.randint(-2, 3 * n) for _ in range(n)]
        else:
            values = [rng.choice([None, 0, rng.random() * 1000, rng.randint(1, 20)]) for _ in range(n)]
        generated.append(values)
    return fixed + generated


SAMPLES = build_samples()


def rank_ascending(keys):
    """RANKX( ..., ASC ) with the default Skip ties: 1 plus the number of strictly smaller values."""
    ordered = sorted(keys)
    return [1 + bisect.bisect_left(ordered, key) for key in keys]


def old_cohort_ranks(values):
    """Old UsageCohortRank: SWITCH on DIVIDE( RANKX( ALL(table), v,, ASC ), COUNTROWS ) per row."""
    keys = [float(number(v)) for v in values]
    return [next((i for i, cut in enumerate(CUTS, start=1) if rank / len(keys) <= cut), 6)
            for rank in rank_ascending(keys)]


def query_cut_rank(k, count):
    """CutValue's Rank: the largest of Near - 2 .. Near + 2 in 1..count with rank / count <= k."""
    near = math.floor(k * count)
    fits = [r for r in range(near - 2, near + 3) if 1 <= r <= count and r / count <= k]
    return max(fits) if fits else None


def new_cohort_ranks(values):
    """New UsageCohortRank, replaying CoworkBilling's query: sort once, read five cuts, compare."""
    ordered = sorted(number(v) for v in values)
    count = len(ordered)
    cuts = []
    for k in CUTS:
        rank = query_cut_rank(k, count)
        cuts.append(None if rank is None else ordered[rank - 1])
    result = []
    for value in values:
        used = number(value)
        hits = [cut is not None and used <= cut for cut in cuts]
        result.append(hits.index(True) + 1 if True in hits else 6)
    return result


def old_intensity(used):
    """Old Group By rows: [@Used] <= 0, else DIVIDE( RANKX( ByUser, [@Used],, ASC ), COUNTROWS ) <= k."""
    labels = []
    for value, rank in zip(used, rank_ascending(used)):
        if value <= 0:
            labels.append("0. Not used")
        else:
            share = rank / len(used)
            labels.append(next((label for cut, label in zip(CUTS, INTENSITY_LABELS) if share <= cut),
                               INTENSITY_LABELS[-1]))
    return labels


def topn_ascending(count, values):
    """TOPN( count, table, value, ASC ): the first count rows in ascending order plus any ties at the edge."""
    if count <= 0 or not values:
        return []
    ordered = sorted(values)
    edge = ordered[min(count, len(ordered)) - 1]
    return [v for v in values if v <= edge]


def new_intensity(used):
    """New Group By rows, replaying the shipped VARs: N, Steps, M<k> and T<k>, then the SWITCH."""
    n = len(used) or None
    steps = range(1, max(number(n), 1) + 1)
    cuts = []
    for cut in CUTS:
        fits = [i for i in steps if number(divide(i, number(n))) <= cut]
        m = max(fits) if fits else 0
        top = topn_ascending(m, used)
        cuts.append(max(top) if m >= 1 and top else None)
    labels = []
    for value in used:
        if value <= 0:
            labels.append("0. Not used")
        else:
            labels.append(next((label for t, label in zip(cuts, INTENSITY_LABELS) if value <= number(t)),
                               INTENSITY_LABELS[-1]))
    return labels


class ReferenceRank(unittest.TestCase):
    """The stand-in for DuckDB's RANK() is RANKX's ascending rank with ties skipped."""

    def test_hand_checked_ranks(self):
        # A blank counts as 0, the tied 3s share rank 2, and the next value skips to 4.
        self.assertEqual(rank_ascending([number(v) for v in [5, 3, 3, None, 7]]), [4, 2, 2, 1, 5])
        # Shares 0.25, 0.5, 0.75 and 1: each cut includes its edge, and 1 is past 0.99.
        self.assertEqual(old_cohort_ranks([1, 2, 3, 4]), [1, 1, 2, 6])

    def test_matches_a_brute_force_count(self):
        for values in SAMPLES:
            if len(values) <= 100:
                keys = [number(v) for v in values]
                self.assertEqual(rank_ascending(keys), [1 + sum(other < key for other in keys) for key in keys])


class CohortEquivalence(unittest.TestCase):
    def test_usage_cohort_rank_matches_rankx(self):
        for values in SAMPLES:
            self.assertEqual(new_cohort_ranks(values), old_cohort_ranks(values), values[:20])

    def test_usage_cohort_label_follows_the_rank(self):
        # The old column ran the same ranking with labels in place of 1..6.
        for values in SAMPLES:
            old = [COHORT_LABELS[b - 1] for b in old_cohort_ranks(values)]
            new = [COHORT_LABELS[b - 1] for b in new_cohort_ranks(values)]
            self.assertEqual(new, old, values[:20])

    def test_group_by_intensity_matches_rankx(self):
        for values in SAMPLES:
            # @Used is CALCULATE( SUM(...) ) + 0, so it is never blank.
            used = [float(number(v)) for v in values]
            self.assertEqual(new_intensity(used), old_intensity(used), used[:20])

    def test_query_window_finds_the_largest_rank_under_each_cut(self):
        # The query looks only near floor(k * N); that window must hold the true largest m.
        sizes = [*range(0, 5001), 9999, 10000, 20000, 59999, 60000, 60001, 99999, 250000, 1000003]
        for n in sizes:
            for k in CUTS:
                m = math.floor(k * n)
                while m + 1 <= n and (m + 1) / n <= k:
                    m += 1
                while m >= 1 and m / n > k:
                    m -= 1
                self.assertEqual(query_cut_rank(k, n), m if m >= 1 else None, (n, k))

    def test_rank_share_is_monotone_at_every_size(self):
        # rank <= m stands in for DIVIDE( rank, N ) <= k only if the shares never dip back under k.
        for n in [*range(1, 401), 1000, 4999, 20000, 59999, 60000, 60001, 250000]:
            for cut in CUTS:
                fits = [i / n <= cut for i in range(1, n + 1)]
                m = sum(fits)
                self.assertEqual(fits, [True] * m + [False] * (n - m), (n, cut))

    def test_every_branch_is_reached(self):
        seen_rank, seen_label = set(), set()
        for values in SAMPLES:
            seen_rank.update(new_cohort_ranks(values))
            seen_label.update(new_intensity([float(number(v)) for v in values]))
        self.assertEqual(seen_rank, set(range(1, 7)))
        self.assertEqual(seen_label, {"0. Not used", *INTENSITY_LABELS})


# ---------------------------------------------------------------------------
# The shipped templates
# ---------------------------------------------------------------------------

TEMPLATES = []  # (folder, raw bytes, buffered), read once


def setUpModule():
    for path, buffered in F.TEMPLATES:
        TEMPLATES.append((path.parent.name, path.read_bytes(), buffered))


def template(folder):
    return next(raw for name, raw, _ in TEMPLATES if name == folder)


def parts(raw):
    """DataModelSchema and UnappliedChanges, read with zipfile rather than the fix's own codec."""
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        return tuple(json.loads(archive.read(name).decode("utf-16-le").lstrip("\ufeff"))
                     for name in (F.SCHEMA, F.UNAPPLIED))


def named(records, name):
    return next(record for record in records if record["name"] == name)


def column(document, table_name, column_name):
    return named(named(document["model"]["tables"], table_name)["columns"], column_name)


def source(document, table_name):
    return named(document["model"]["tables"], table_name)["partitions"][0]["source"]


def model_queries(document):
    found = {}
    for table in document["model"]["tables"]:
        for partition in table.get("partitions", []):
            if partition["source"].get("type") == "m":
                found[table["name"]] = joined(partition["source"]["expression"])
    for expression in document["model"].get("expressions", []):
        found[expression["name"]] = joined(expression["expression"])
    return found


def pending_queries(pending):
    return {query["name"]: joined(query["text"]) for query in pending["queries"]}


def edited(raw, change):
    """raw with change(model, pending) applied to its two model parts, every other member kept."""
    package = F.Package(raw)
    model, encode_model = F.layout_for(package.contents[F.SCHEMA], F.SCHEMA)
    pending, encode_pending = F.layout_for(package.contents[F.UNAPPLIED], F.UNAPPLIED)
    change(model, pending)
    return package.rebuild({F.SCHEMA: encode_model(model), F.UNAPPLIED: encode_pending(pending)})


def undo(text, edits):
    for old, new in edits:
        if text.count(new) != 1 or old in text:
            raise AssertionError(f"cannot undo {new[:60]!r}")
        text = text.replace(new, old)
    return text


@functools.lru_cache(maxsize=None)
def revert(raw, buffered):
    """The template as it was before the cuts: every one of them undone in memory."""
    def change(model, pending):
        for name, edits in F.query_edits(buffered).items():
            query_source = source(model, name)
            text = undo(joined(query_source["expression"]), edits)
            query_source["expression"] = F.lines(text)
            query = named(pending["queries"], name)
            query["text"] = text.split("\n")
            cache = json.loads(query["lastLoadedAsTableFormulaText"])
            cache["RootFormulaText"] = text
            query["lastLoadedAsTableFormulaText"] = F.dumps(cache)
        columns = named(model["model"]["tables"], F.COWORK_BILLING)["columns"]
        loaded = named(columns, F.USAGE_COHORT_RANK)
        columns[columns.index(loaded)] = {
            "type": "calculated", "name": loaded["name"], "dataType": loaded["dataType"],
            "isHidden": loaded["isHidden"], "expression": F.lines(F.USAGE_COHORT_RANK_OLD),
            "lineageTag": loaded["lineageTag"], "summarizeBy": loaded["summarizeBy"],
        }
        for (table_name, column_name), (old, _) in F.CONSUMPTION_COLUMNS.items():
            column(model, table_name, column_name)["expression"] = F.lines(old)
        group_by = source(model, F.GROUP_BY)
        group_by["expression"] = F.lines(undo(joined(group_by["expression"]), F.GROUP_BY_EDITS))
    return edited(raw, change)


class ShippedCohortDax(unittest.TestCase):
    """What Analytics Hub checked in its Fabric template, here in all four."""

    @classmethod
    def setUpClass(cls):
        cls.parsed = [(name, *parts(raw)) for name, raw, _ in TEMPLATES]

    def test_columns_ship_the_new_expressions(self):
        for name, model, _ in self.parsed:
            with self.subTest(template=name):
                for (table_name, column_name), (old, new) in F.CONSUMPTION_COLUMNS.items():
                    self.assertEqual(joined(column(model, table_name, column_name)["expression"]), new, column_name)
                    self.assertNotEqual(old, new)
                self.assertTrue(joined(column(model, "CoworkBilling", "UsageCohort")["expression"]).startswith(
                    "SWITCH('CoworkBilling'[UsageCohortRank],"))
                self.assertNotIn("CALCULATE", joined(column(model, "CreditsWeekly", "Weeks Ago")["expression"]))

    def test_usage_cohort_rank_is_loaded_by_the_query(self):
        self.assertIn("{0.50, 0.75, 0.90, 0.95, 0.99}", F.COHORT_QUERY_STEPS)
        for name, model, pending in self.parsed:
            with self.subTest(template=name):
                self.assertEqual(column(model, "CoworkBilling", "UsageCohortRank"), {
                    "name": "UsageCohortRank", "dataType": "int64", "isHidden": True,
                    "sourceColumn": "UsageCohortRank", "lineageTag": LINEAGE_TAG, "summarizeBy": "none",
                })
                self.assertEqual(column(model, "CoworkBilling", "UsageCohort").get("sortByColumn"), "UsageCohortRank")
                partition = joined(source(model, "CoworkBilling")["expression"])
                query = named(pending["queries"], "CoworkBilling")
                for text in (partition, joined(query["text"])):
                    self.assertIn(F.COHORT_QUERY_STEPS, text)
                    self.assertTrue(text.endswith("\nin\n\tAddedCohortRank"))
                self.assertEqual(json.loads(query["lastLoadedAsTableFormulaText"])["RootFormulaText"], partition)

    def test_no_calculated_column_needs_a_context_transition_it_did_not_have(self):
        # A second CALCULATE in CoworkBilling next to Weeks Active risks a circular dependency.
        for name, model, _ in self.parsed:
            for column_name in ("UsageCohort", "Weeks Over Limit"):
                with self.subTest(template=name, column=column_name):
                    self.assertNotIn("CALCULATE", joined(column(model, "CoworkBilling", column_name)["expression"]))

    def test_group_by_ranks_each_product_once(self):
        for name, model, _ in self.parsed:
            with self.subTest(template=name):
                text = joined(source(model, "Group By")["expression"])
                self.assertNotIn("[@P]", text)
                self.assertNotIn("RANKX", code(text))
                for product in ("Studio", "GitHub"):
                    for cut_name, cut in F.COHORT_CUTS:
                        self.assertIn(f"VAR {product}M{cut_name} = MAXX( FILTER( {product}Steps, "
                                      f"DIVIDE( [Value], {product}N ) <= {cut} ), [Value] ) + 0", text)
                        self.assertIn(f"VAR {product}T{cut_name} = IF( {product}M{cut_name} >= 1, "
                                      f"MAXX( TOPN( {product}M{cut_name}, {product}ByUser, [@Used], ASC ), [@Used] ) )",
                                      text)
                    for (cut_name, _), label in zip(F.COHORT_CUTS, INTENSITY_LABELS):
                        self.assertIn(f'[@Used] <= {product}T{cut_name}, "{label}",', text)
                for label in INTENSITY_LABELS:
                    self.assertEqual(text.count(f'"{label}"'), 2, label)

    def test_no_calculated_column_ranks_a_whole_table_per_row(self):
        whole_table = re.compile(r"RANKX\s*\(\s*ALL\s*\(\s*'[^']+'\s*\)", re.IGNORECASE)
        for name, model, _ in self.parsed:
            with self.subTest(template=name):
                for table in model["model"]["tables"]:
                    for calculated in table.get("columns", []):
                        if calculated.get("type") == "calculated":
                            text = code(joined(calculated["expression"]))
                            where = (table["name"], calculated["name"])
                            self.assertIsNone(whole_table.search(text), where)
                            self.assertNotIn("EARLIER", text.upper(), where)


class ShippedTemplates(unittest.TestCase):
    def test_templates_are_current(self):
        for name, raw, buffered in TEMPLATES:
            with self.subTest(template=name):
                rebuilt, changes = F.build(raw, buffered)
                self.assertEqual(changes, [])
                self.assertIs(rebuilt, raw)

    def test_pending_query_copies_match_the_model(self):
        for name, raw, buffered in TEMPLATES:
            with self.subTest(template=name):
                model, pending = parts(raw)
                in_model, in_pending = model_queries(model), pending_queries(pending)
                for query_name, text in in_pending.items():
                    if query_name in in_model:
                        self.assertEqual(text, in_model[query_name], query_name)
                # Desktop decides what is pending from its last-loaded copy.
                for query_name in F.query_edits(buffered):
                    cache = json.loads(named(pending["queries"], query_name)["lastLoadedAsTableFormulaText"])
                    self.assertEqual(cache["RootFormulaText"], in_model[query_name], query_name)

    def test_buffering_follows_the_template(self):
        self.assertEqual([path.parent.name for path, buffered in F.TEMPLATES if buffered],
                         ["2. Fabric", "4. Power Automate + Dataverse"])
        for name, raw, buffered in TEMPLATES:
            model, pending = parts(raw)
            for member, queries in ((F.SCHEMA, model_queries(model)), (F.UNAPPLIED, pending_queries(pending))):
                with self.subTest(template=name, member=member):
                    # Unbuffered, each column read, through Normalize or Table.Column, is its own SQL query.
                    read = {query_name: text for query_name, text in queries.items()
                            if "GetTable(" in text and ("Normalize" in text or "Table.Column(Raw" in text)}
                    self.assertEqual(sorted(read), sorted(F.BUFFERED_TABLES) if buffered else [])
                    for query_name, text in read.items():
                        self.assertRegex(text, BUFFERED_RAW, query_name)
                        self.assertIn(f'GetTable("{F.BUFFERED_TABLES[query_name]}")', text, query_name)
                    # AzureAiTokens renames and selects its columns in one folded read, and
                    # CoworkTaskInput hands its table on whole. Neither reads column by column, so both
                    # stay unbuffered, as AzureAiTokens does in AH. A new plain read needs the same review.
                    plain = sorted(query_name for query_name, text in queries.items() if "Raw = GetTable(" in text)
                    self.assertEqual(sorted(set(plain) & set(read)), [])
                    self.assertEqual(plain, ["AzureAiTokens", "CoworkTaskInput"] if buffered else [])

    def test_the_check_spots_a_stale_last_loaded_copy(self):
        raw = template("1. Local CSV")
        self.assertEqual(check.out_of_step(raw, False), [])

        def stale(_, pending):
            query = named(pending["queries"], "CoworkBilling")
            cache = json.loads(query["lastLoadedAsTableFormulaText"])
            cache["RootFormulaText"] += "\n"
            query["lastLoadedAsTableFormulaText"] = F.dumps(cache)

        candidate = edited(raw, stale)
        self.assertEqual(F.build(candidate, False)[1], [])
        self.assertEqual(check.out_of_step(candidate, False),
                         ["CoworkBilling: Desktop's last-loaded copy differs from the model"])


class RevertAndRerun(unittest.TestCase):
    def test_undoing_the_cuts_and_running_again_gives_the_shipped_template(self):
        for name, raw, buffered in TEMPLATES:
            with self.subTest(template=name):
                queries = [*F.BUFFERED_TABLES, "CoworkBilling"] if buffered else ["CoworkBilling"]
                expected = [f"DataModelSchema {query}" for query in queries] + [
                    "DataModelSchema CoworkBilling[UsageCohortRank] loaded by the query",
                    "DataModelSchema CoworkBilling[UsageCohort]",
                    "DataModelSchema CreditsWeekly[Weeks Ago]",
                    "DataModelSchema Group By",
                ] + [f"UnappliedChanges {query}" for query in queries]
                rebuilt, changes = F.build(revert(raw, buffered), buffered)
                self.assertEqual(changes, expected)
                shipped, again = F.Package(raw), F.Package(rebuilt)
                self.assertEqual(list(again.infos), list(shipped.infos))
                for member in shipped.infos:
                    self.assertTrue(again.contents[member] == shipped.contents[member], member)
                    if member not in (F.SCHEMA, F.UNAPPLIED):
                        self.assertTrue(again.locals[member] == shipped.locals[member], member)
                self.assertEqual(F.build(rebuilt, buffered), (rebuilt, []))

    def test_another_querys_last_loaded_copy_moves_with_the_rewrite(self):
        before = revert(template("1. Local CSV"), False)
        _, pending = parts(before)
        old = joined(named(pending["queries"], "CoworkBilling")["text"])
        other = next(query["name"] for query in pending["queries"]
                     if query["name"] != "CoworkBilling" and query.get("lastLoadedAsTableFormulaText"))

        def reference(_, pending):
            query = named(pending["queries"], other)
            cache = json.loads(query["lastLoadedAsTableFormulaText"])
            cache["ReferencedQueriesFormulaText"] = {"CoworkBilling": old, "Elsewhere": old}
            query["lastLoadedAsTableFormulaText"] = F.dumps(cache)

        rebuilt, _ = F.build(edited(before, reference), False)
        _, after = parts(rebuilt)
        new = joined(named(after["queries"], "CoworkBilling")["text"])
        self.assertNotEqual(new, old)
        cache = json.loads(named(after["queries"], other)["lastLoadedAsTableFormulaText"])
        self.assertEqual(cache["ReferencedQueriesFormulaText"], {"CoworkBilling": new, "Elsewhere": old})


class Refusals(unittest.TestCase):
    def test_a_snippet_must_be_there_once_unless_already_replaced(self):
        edit = (("old", "new"),)
        self.assertEqual(F.replace_snippets("q", "an old one", edit), "an new one")
        self.assertEqual(F.replace_snippets("q", "a new one", edit), "a new one")
        for text in ("old and old", "neither"):
            with self.subTest(text=text), self.assertRaises(F.PatchError):
                F.replace_snippets("q", text, edit)

    def test_a_changed_usage_cohort_rank_is_refused(self):
        calculated = {
            "type": "calculated", "name": "UsageCohortRank", "dataType": "int64", "isHidden": True,
            "expression": F.lines(F.USAGE_COHORT_RANK_OLD), "lineageTag": LINEAGE_TAG, "summarizeBy": "none",
        }

        def model(rank):
            return {"tables": [{"name": "CoworkBilling", "columns": [rank]}]}

        for changed in ({**calculated, "expression": "1"}, {**calculated, "dataType": "double"},
                        {"name": "UsageCohortRank", "dataType": "int64", "sourceColumn": "Other"}):
            with self.subTest(column=changed), self.assertRaises(F.PatchError):
                F.edit_cohort_rank_column(model(changed))
        loaded = model(dict(calculated))
        self.assertEqual(F.edit_cohort_rank_column(loaded), ["CoworkBilling[UsageCohortRank] loaded by the query"])
        self.assertEqual(list(loaded["tables"][0]["columns"][0].items()), [
            ("name", "UsageCohortRank"), ("dataType", "int64"), ("isHidden", True),
            ("sourceColumn", "UsageCohortRank"), ("lineageTag", LINEAGE_TAG), ("summarizeBy", "none"),
        ])
        self.assertEqual(F.edit_cohort_rank_column(loaded), [])

    def test_a_wrong_buffering_flag_is_refused(self):
        with self.assertRaisesRegex(F.PatchError, "nothing to buffer"):
            F.build(template("2. Fabric"), False)
        with self.assertRaisesRegex(F.PatchError, "nothing to buffer"):
            F.build(template("4. Power Automate + Dataverse"), False)
        with self.assertRaises(F.PatchError):
            F.build(template("1. Local CSV"), True)

    def test_a_pending_copy_out_of_step_with_the_model_is_refused(self):
        def drift(_, pending):
            named(pending["queries"], "CoworkBilling")["text"].append("// drift")

        with self.assertRaisesRegex(F.PatchError, "fix_query_body_drift"):
            F.build(edited(template("1. Local CSV"), drift), False)

    def test_last_loaded_copies_move_only_from_the_old_text(self):
        old, new = "let\n\ta = 1\nin\n\ta", "let\n\ta = 2\nin\n\ta"

        def query(name, root, refs=None):
            cache = {"RootFormulaText": root}
            if refs is not None:
                cache["ReferencedQueriesFormulaText"] = refs
            return {"name": name, "lastLoadedAsTableFormulaText": F.dumps(cache)}

        rewritten = {"Q": (old, new)}
        current, stale, other = query("Q", old), query("Q", "earlier"), query("R", "r", {"Q": old, "S": old})
        for each in (current, stale, other):
            F.sync_last_loaded(each, rewritten)
        self.assertEqual(json.loads(current["lastLoadedAsTableFormulaText"]), {"RootFormulaText": new})
        self.assertEqual(json.loads(stale["lastLoadedAsTableFormulaText"]), {"RootFormulaText": "earlier"})
        self.assertEqual(json.loads(other["lastLoadedAsTableFormulaText"]),
                         {"RootFormulaText": "r", "ReferencedQueriesFormulaText": {"Q": new, "S": old}})
        with self.assertRaises(F.PatchError):
            F.sync_last_loaded({"name": "Q", "lastLoadedAsTableFormulaText": '{"RootFormulaText": "a"}'}, rewritten)

    def test_pending_text_keeps_its_shape(self):
        document = {"queries": [{"name": "One", "text": "a"}, {"name": "Many", "text": ["a", "b"]}]}
        changed = F.edit_queries_pending(document, {"One": (("a", "c"),), "Many": (("a\nb", "c\nd"),)})
        self.assertEqual(changed, ["One", "Many"])
        self.assertEqual([query["text"] for query in document["queries"]], ["c", ["c", "d"]])

    def test_owned_masks_cover_only_the_cuts(self):
        model = {"model": {"tables": [
            {"name": "CoworkBilling", "lineageTag": "a",
             "partitions": [{"name": "p", "source": {"type": "m", "expression": ["let", "in"]}}],
             "columns": [{"name": "UsageCohortRank", "dataType": "int64", "sourceColumn": "UsageCohortRank"},
                         {"name": "UsageCohort", "expression": "x", "sortByColumn": "UsageCohortRank"},
                         {"name": "Weeks Over Limit", "expression": "y"}]},
            {"name": "CreditsWeekly", "columns": [{"name": "Weeks Ago", "expression": "z"}]},
            {"name": "Group By", "partitions": [{"name": "g", "source": {"type": "calculated", "expression": "t"}}]},
        ]}}
        pending = {"queries": [{"name": "CoworkBilling", "text": ["let", "in"], "lastLoadedAsTableFormulaText": "{}"},
                               {"name": "Other", "text": ["o"]}]}
        queries = F.query_edits(False)

        def same(mask, document, change):
            changed = copy.deepcopy(document)
            change(changed)
            return mask(changed, queries) == mask(document, queries)

        inside = (
            lambda d: source(d, "CoworkBilling").update(expression="new"),
            lambda d: column(d, "CoworkBilling", "UsageCohortRank").update(type="calculated", expression="r"),
            lambda d: column(d, "CoworkBilling", "UsageCohort").update(expression="new"),
            lambda d: column(d, "CreditsWeekly", "Weeks Ago").update(expression="new"),
            lambda d: source(d, "Group By").update(expression="new"),
        )
        outside = (
            lambda d: column(d, "CoworkBilling", "UsageCohort").update(sortByColumn="other"),
            lambda d: column(d, "CoworkBilling", "Weeks Over Limit").update(expression="new"),
            lambda d: named(d["model"]["tables"], "CoworkBilling").update(lineageTag="b"),
            lambda d: named(d["model"]["tables"], "Group By")["partitions"][0].update(mode="import"),
        )
        for index, change in enumerate(inside):
            with self.subTest(inside=index):
                self.assertTrue(same(F.owned_mask_model, model, change))
        for index, change in enumerate(outside):
            with self.subTest(outside=index):
                self.assertFalse(same(F.owned_mask_model, model, change))
        self.assertTrue(same(F.owned_mask_pending, pending, lambda d: d["queries"][0].update(
            text=["new"], lastLoadedAsTableFormulaText='{"RootFormulaText":"new"}')))
        self.assertFalse(same(F.owned_mask_pending, pending, lambda d: d["queries"][1].update(text=["new"])))

    def test_validate_refuses_a_candidate_that_is_not_the_intended_document(self):
        package = F.Package(template("1. Local CSV"))
        model, encode_model = F.layout_for(package.contents[F.SCHEMA], F.SCHEMA)
        pending = F.layout_for(package.contents[F.UNAPPLIED], F.UNAPPLIED)[0]
        updates = {F.SCHEMA: encode_model(model)}
        candidate = package.rebuild(updates)
        F.validate(package, candidate, updates, model, pending)
        other = copy.deepcopy(pending)
        other["queries"].pop()
        with self.assertRaisesRegex(F.PatchError, "intended document"):
            F.validate(package, candidate, updates, model, other)
        with self.assertRaisesRegex(F.PatchError, "content mismatch"):
            F.validate(package, candidate, {F.SCHEMA: b""}, model, pending)


class CommandLine(unittest.TestCase):
    @staticmethod
    def run_main(argv):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            code = F.main(argv)
        return code, output.getvalue()

    def test_dry_run_check_and_write(self):
        raw = template("1. Local CSV")
        stale = revert(raw, False)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "template.pbit"
            path.write_bytes(stale)
            with mock.patch.object(F, "TEMPLATES", ((path, False),)):
                self.assertEqual(self.run_main(["--check"])[0], 1)
                self.assertEqual(self.run_main(["--dry-run"])[0], 0)
                self.assertTrue(path.read_bytes() == stale)
                self.assertEqual(self.run_main([])[0], 0)
                written = path.read_bytes()
                self.assertTrue(F.Package(written).contents == F.Package(raw).contents)
                self.assertEqual(self.run_main(["--check"])[0], 0)
                self.assertEqual(self.run_main([])[0], 0)
                self.assertTrue(path.read_bytes() == written)
            # A template that cannot be read fails the run without stopping the others.
            path.write_bytes(stale)
            with mock.patch.object(F, "TEMPLATES", ((Path(folder) / "missing.pbit", False), (path, False))):
                code, output = self.run_main([])
                self.assertEqual(code, 1)
                self.assertIn("missing template", output)
                self.assertTrue(F.Package(path.read_bytes()).contents == F.Package(raw).contents)
            self.assertEqual([entry.name for entry in Path(folder).iterdir()], ["template.pbit"])

    def test_publish_only_replaces_the_bytes_it_was_built_from(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "template.pbit"
            path.write_bytes(b"before")
            F.publish(path, b"before", b"after")
            self.assertEqual(path.read_bytes(), b"after")
            with self.assertRaisesRegex(F.PatchError, "changed during the patch"):
                F.publish(path, b"before", b"later")
            self.assertEqual(path.read_bytes(), b"after")
            self.assertEqual([entry.name for entry in Path(folder).iterdir()], ["template.pbit"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
