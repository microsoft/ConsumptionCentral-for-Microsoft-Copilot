"""Tests for docs/scripts/fix_limit_and_token_measures.py.

The three measures take Analytics Hub's text at 5d5d80a. These tests replay
what the new text means, with DAX's blank rules: Foundry Tokens (M) is
replayed from the SWITCH branches read out of the shipped text. The Local CSV
sample data only has per-1M Foundry meters, so its token figures don't move.

The rest runs the fix against the three current templates. They ship the new
text, undoing it in memory and running the fix again gives the shipped
template back byte for byte, a second run changes nothing, and text the fix
does not recognise is refused.

    python docs/scripts/test_limit_and_token_measures.py
"""
import contextlib
import copy
import csv
import io
import json
import re
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_limit_and_token_measures as check  # noqa: E402
import fix_limit_and_token_measures as F  # noqa: E402

OVER_LIMIT = ("CoworkBilling", "Users Over Limit")
POLICY_ALLOWANCE = ("CoworkBilling", "Policy Allowance")
FOUNDRY_TOKENS = ("AzureAiSpend", "Foundry Tokens (M)")
SAMPLE_SPEND = F.REPO / "1. Local CSV" / "sample-data" / "AzureAiSpendDaily.csv"


def joined(value):
    return "\n".join(value) if isinstance(value, list) else value


def code(dax):
    """DAX without its // comments."""
    return "\n".join(line for line in dax.split("\n") if not line.lstrip().startswith("//"))


def new_text(key, field="expression"):
    return F.MEASURES[key][field][1]


# ---------------------------------------------------------------------------
# What the new text means, replayed with DAX's blank rules
# ---------------------------------------------------------------------------


def number(value):
    """DAX compares a blank number as 0."""
    return 0 if value is None else value


def users_over_limit_old(people):
    """COUNTROWS(FILTER(T, [u] > [l])), over (credits used, person allowance) pairs. BLANK when none pass."""
    return sum(1 for used, limit in people if number(used) > number(limit)) or None


def users_over_limit_new(people):
    """COUNTROWS(FILTER(T, [l] > 0 && [u] > [l])) + 0."""
    return sum(1 for used, limit in people if number(limit) > 0 and number(used) > number(limit))


def policy_sum(limits):
    """SUM over the policies: BLANK when every limit is blank or there are none."""
    present = [limit for limit in limits if limit is not None]
    return sum(present) if present else None


def policy_allowance_old(limits):
    return policy_sum(limits)


def policy_allowance_new(limits):
    """VAR Limit = the same SUM. RETURN IF(Limit > 0, Limit): BLANK otherwise."""
    total = policy_sum(limits)
    return total if number(total) > 0 else None


def meter_rule(expression):
    """The SWITCH in Foundry Tokens (M), read from its text: [(text, factor)] and the factor for no match."""
    branches = re.findall(r"CONTAINSSTRING\( 'AzureAiSpend'\[Meter\], \"([^\"]+)\" \), ([\d.]+),", expression)
    default = re.search(r"\n\s+(\d+) \)\n\s+\),", expression)
    if len(branches) != 2 or default is None:
        raise AssertionError("Foundry Tokens (M) no longer has the expected SWITCH")
    return [(text, float(factor)) for text, factor in branches], float(default.group(1))


def meter_factor(meter, rule):
    """CONTAINSSTRING ignores case; SWITCH(TRUE(), ...) takes the first branch that matches."""
    branches, default = rule
    return next((factor for text, factor in branches if text.lower() in meter.lower()), default)


class Semantics(unittest.TestCase):
    def test_users_over_limit_counts_only_people_with_a_limit(self):
        self.assertIn("RETURN COUNTROWS(FILTER(T, [l] > 0 && [u] > [l])) + 0", new_text(OVER_LIMIT))
        people = [(120, 100), (50, 100), (100, 100), (30, None), (30, 0), (None, None), (0, 0), (None, 40)]
        # Before, someone who used credits with no limit, or a limit of 0, counted as over it.
        self.assertEqual(users_over_limit_old(people), 3)
        self.assertEqual(users_over_limit_new(people), 1)
        for nobody_over in ([], [(50, 100)], [(30, None), (30, 0)]):
            with self.subTest(people=nobody_over):
                self.assertEqual(users_over_limit_new(nobody_over), 0)
        self.assertIsNone(users_over_limit_old([(50, 100)]))

    def test_policy_allowance_is_blank_without_a_limit(self):
        text = new_text(POLICY_ALLOWANCE)
        self.assertTrue(text.startswith("VAR Limit =\n    CALCULATE(\n        SUM('SpendingPolicy'[PlanLimit]),"))
        self.assertTrue(text.endswith("\nRETURN IF(Limit > 0, Limit)"))
        self.assertIn(F.NO_POLICY, text)
        for limits, old, new in (([], None, None), ([None], None, None), ([0, 0], 0, None),
                                 ([100, 0], 100, 100), ([100, 250, None], 350, 350)):
            with self.subTest(limits=limits):
                self.assertEqual(policy_allowance_old(limits), old)
                self.assertEqual(policy_allowance_new(limits), new)

    def test_foundry_tokens_reads_each_meters_unit(self):
        rule = meter_rule(new_text(FOUNDRY_TOKENS))
        self.assertEqual(rule, ([("1M Token", 1.0), ("Token", 0.001)], 0.0))
        for meter, factor in (
            ("GPT 4.1 Inpt Glbl 1M Tokens", 1),
            ("5.4 cd inp Gl 1M Tokens", 1),
            ("gpt 4o mini inp glbl 1m tokens", 1),
            ("gpt-4o-0513 Input global Tokens", 0.001),
            ("Ada Tokens", 0.001),
            ("Provisioned Managed Global Hours", 0),
            ("S0 Pages", 0),
            ("Standard Images", 0),
        ):
            with self.subTest(meter=meter):
                self.assertEqual(meter_factor(meter, rule), factor)
        # Analytics Hub's example: 212 tokens on a per-1K meter used to read as 0.212 million.
        self.assertAlmostEqual(0.212 * meter_factor("gpt-4o-0513 Input global Tokens", rule), 0.000212)

    def test_foundry_tokens_keeps_its_filters(self):
        old, new = F.MEASURES[FOUNDRY_TOKENS]["expression"]
        self.assertEqual(code(new).replace(
            "    SUMX(\n        'AzureAiSpend',\n        'AzureAiSpend'[UsageQuantity]\n"
            "            * SWITCH( TRUE(),\n"
            "                CONTAINSSTRING( 'AzureAiSpend'[Meter], \"1M Token\" ), 1,\n"
            "                CONTAINSSTRING( 'AzureAiSpend'[Meter], \"Token\" ), 0.001,\n"
            "                0 )\n    ),", "    SUM( 'AzureAiSpend'[UsageQuantity] ),"), old)
        description = new_text(FOUNDRY_TOKENS, "description")
        self.assertIn("per 1K tokens", description)
        self.assertIn("meters that aren't tokens (pages, images, hours) are left out", description)

    def test_the_sample_data_token_figures_do_not_move(self):
        rule = meter_rule(new_text(FOUNDRY_TOKENS))
        with SAMPLE_SPEND.open(encoding="utf-8-sig", newline="") as stream:
            rows = [row for row in csv.DictReader(stream) if row["ServiceName"] == "Foundry Models"]
        self.assertTrue(rows)
        self.assertEqual({meter_factor(row["Meter"], rule) for row in rows}, {1.0})
        self.assertEqual(sum(float(row["UsageQuantity"]) * meter_factor(row["Meter"], rule) for row in rows),
                         sum(float(row["UsageQuantity"]) for row in rows))


# ---------------------------------------------------------------------------
# The shipped templates
# ---------------------------------------------------------------------------

TEMPLATES = []  # (folder, raw bytes), read once


def setUpModule():
    for path in F.TEMPLATES:
        TEMPLATES.append((path.parent.name, path.read_bytes()))


def template(folder):
    return next(raw for name, raw in TEMPLATES if name == folder)


def parts(raw):
    """DataModelSchema and UnappliedChanges, read with zipfile rather than the fix's own codec."""
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        return tuple(json.loads(archive.read(name).decode("utf-16-le").lstrip("\ufeff"))
                     for name in (F.SCHEMA, F.UNAPPLIED))


def named(records, name):
    return next(record for record in records if record["name"] == name)


def measure(document, key):
    table_name, measure_name = key
    return named(named(document["model"]["tables"], table_name)["measures"], measure_name)


def edited(raw, change):
    """raw with change(model) applied to DataModelSchema, every other member kept."""
    package = F.Package(raw)
    model, encode_model = F.layout_for(package.contents[F.SCHEMA], F.SCHEMA)
    change(model)
    return package.rebuild({F.SCHEMA: encode_model(model)})


def revert(raw, only=None):
    """The template as it shipped before the port: every field (or only those in `only`) put back."""
    def change(model):
        for key, fields in F.MEASURES.items():
            for field, (old, _) in fields.items():
                if only is None or (key, field) in only:
                    measure(model, key)[field] = F.lines(old)
    return edited(raw, change)


class ShippedTemplates(unittest.TestCase):
    def test_only_the_current_templates_are_ported(self):
        self.assertEqual([path.parent.name for path in F.TEMPLATES], ["1. Local CSV", "2. Fabric", "3. Viva Direct"])

    def test_templates_carry_analytics_hubs_text(self):
        for name, raw in TEMPLATES:
            model, _ = parts(raw)
            for key, fields in F.MEASURES.items():
                for field, (old, new) in fields.items():
                    with self.subTest(template=name, measure=key, field=field):
                        self.assertNotEqual(old, new)
                        self.assertEqual(measure(model, key)[field], F.lines(new))

    def test_templates_are_current(self):
        for name, raw in TEMPLATES:
            with self.subTest(template=name):
                rebuilt, changes = F.build(raw)
                self.assertEqual(changes, [])
                self.assertIs(rebuilt, raw)

    def test_unapplied_changes_holds_none_of_the_measures(self):
        for name, raw in TEMPLATES:
            with self.subTest(template=name):
                _, pending = parts(raw)
                self.assertNotIn("model", pending)
                text = json.dumps(pending, ensure_ascii=False)
                for _, measure_name in F.MEASURES:
                    self.assertNotIn(measure_name, text)

    def test_the_check_passes_and_the_report_layer_is_signed(self):
        for name, raw in TEMPLATES:
            with self.subTest(template=name), zipfile.ZipFile(io.BytesIO(raw)) as archive:
                self.assertIn("SecurityBindings", archive.namelist())
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(check.main(), 0)


class RevertAndRerun(unittest.TestCase):
    def assertSameTemplate(self, rebuilt, raw):
        shipped, again = F.Package(raw), F.Package(rebuilt)
        self.assertEqual(list(again.infos), list(shipped.infos))
        for member in shipped.infos:
            self.assertTrue(again.contents[member] == shipped.contents[member], member)
            if member != F.SCHEMA:
                self.assertTrue(again.locals[member] == shipped.locals[member], member)

    def test_undoing_the_port_and_running_again_gives_the_shipped_template(self):
        for name, raw in TEMPLATES:
            with self.subTest(template=name):
                rebuilt, changes = F.build(revert(raw))
                self.assertEqual(changes, [
                    "DataModelSchema CoworkBilling[Users Over Limit] expression",
                    "DataModelSchema CoworkBilling[Policy Allowance] expression",
                    "DataModelSchema AzureAiSpend[Foundry Tokens (M)] expression and description",
                ])
                self.assertSameTemplate(rebuilt, raw)
                self.assertEqual(F.build(rebuilt), (rebuilt, []))

    def test_a_half_ported_template_is_finished(self):
        raw = template("2. Fabric")
        rebuilt, changes = F.build(revert(raw, {(FOUNDRY_TOKENS, "expression")}))
        self.assertEqual(changes, ["DataModelSchema AzureAiSpend[Foundry Tokens (M)] expression"])
        self.assertSameTemplate(rebuilt, raw)


class Refusals(unittest.TestCase):
    def test_text_edited_since_it_shipped_is_refused(self):
        raw = revert(template("1. Local CSV"))
        for key, field, value in ((OVER_LIMIT, "expression", "COUNTROWS('CoworkBilling')"),
                                  (POLICY_ALLOWANCE, "expression", ["", "SUM('SpendingPolicy'[PlanLimit])"]),
                                  (FOUNDRY_TOKENS, "description", "Tokens.")):
            with self.subTest(measure=key, field=field):
                candidate = edited(raw, lambda model: measure(model, key).update({field: value}))
                with self.assertRaisesRegex(F.PatchError, re.escape(f"{key[0]}[{key[1]}] {field} has changed")):
                    F.build(candidate)

    def test_a_dropped_description_is_refused(self):
        # A Desktop re-export drops descriptions; fix_pbit_defaults.py --reference puts them back first.
        candidate = edited(template("3. Viva Direct"), lambda model: measure(model, FOUNDRY_TOKENS).pop("description"))
        with self.assertRaisesRegex(F.PatchError, re.escape("[Foundry Tokens (M)] description has changed")):
            F.build(candidate)

    def test_a_missing_measure_is_refused(self):
        def drop(model):
            table = named(model["model"]["tables"], "CoworkBilling")
            table["measures"] = [m for m in table["measures"] if m["name"] != "Policy Allowance"]

        with self.assertRaisesRegex(F.PatchError, "expected one 'Policy Allowance'"):
            F.build(edited(template("1. Local CSV"), drop))

    def test_a_change_outside_the_three_measures_is_refused(self):
        real = F.edit_measures

        def also_elsewhere(document):
            changed = real(document)
            measure(document, ("CoworkBilling", "Policy Headroom"))["expression"] = "0"
            return changed

        with mock.patch.object(F, "edit_measures", also_elsewhere), \
                self.assertRaisesRegex(F.PatchError, "outside the three measures"):
            F.build(revert(template("1. Local CSV")))

    def test_the_owned_mask_covers_only_the_ported_fields(self):
        model = {"model": {"tables": [
            {"name": "CoworkBilling", "measures": [
                {"name": "Users Over Limit", "expression": "a", "formatString": "#,0"},
                {"name": "Policy Allowance", "description": "d", "expression": "b"},
                {"name": "Policy Headroom", "expression": "c"},
            ]},
            {"name": "AzureAiSpend", "measures": [
                {"name": "Foundry Tokens (M)", "description": "e", "expression": "f", "displayFolder": "Foundry"},
            ]},
        ]}}

        def same(change):
            changed = copy.deepcopy(model)
            change(changed)
            return F.owned_mask(changed) == F.owned_mask(model)

        inside = (
            lambda d: measure(d, OVER_LIMIT).update(expression="new"),
            lambda d: measure(d, POLICY_ALLOWANCE).update(expression="new"),
            lambda d: measure(d, FOUNDRY_TOKENS).update(expression="new", description="new"),
        )
        outside = (
            lambda d: measure(d, OVER_LIMIT).update(formatString="0"),
            lambda d: measure(d, OVER_LIMIT).update(description="new"),
            lambda d: measure(d, POLICY_ALLOWANCE).update(description="new"),
            lambda d: measure(d, ("CoworkBilling", "Policy Headroom")).update(expression="new"),
            lambda d: measure(d, FOUNDRY_TOKENS).update(displayFolder="Other"),
        )
        for index, change in enumerate(inside):
            with self.subTest(inside=index):
                self.assertTrue(same(change))
        for index, change in enumerate(outside):
            with self.subTest(outside=index):
                self.assertFalse(same(change))


class CommandLine(unittest.TestCase):
    @staticmethod
    def run_main(main, argv=None):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            code = main() if argv is None else main(argv)
        return code, output.getvalue()

    def test_dry_run_check_and_write(self):
        raw = template("1. Local CSV")
        stale = revert(raw)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "template.pbit"
            path.write_bytes(stale)
            with mock.patch.object(F, "TEMPLATES", (path,)):
                self.assertEqual(self.run_main(F.main, ["--check"])[0], 1)
                self.assertEqual(self.run_main(F.main, ["--dry-run"])[0], 0)
                self.assertTrue(path.read_bytes() == stale)
                self.assertEqual(self.run_main(F.main, [])[0], 0)
                written = path.read_bytes()
                self.assertTrue(F.Package(written).contents == F.Package(raw).contents)
                self.assertEqual(self.run_main(F.main, ["--check"])[0], 0)
                self.assertEqual(self.run_main(F.main, [])[0], 0)
                self.assertTrue(path.read_bytes() == written)
            # A template that cannot be read fails the run without stopping the others.
            path.write_bytes(stale)
            with mock.patch.object(F, "TEMPLATES", (Path(folder) / "missing.pbit", path)):
                code, output = self.run_main(F.main, [])
                self.assertEqual(code, 1)
                self.assertIn("missing template", output)
                self.assertTrue(F.Package(path.read_bytes()).contents == F.Package(raw).contents)
            self.assertEqual([entry.name for entry in Path(folder).iterdir()], ["template.pbit"])

    def test_the_check_names_what_is_missing(self):
        raw = template("1. Local CSV")
        with zipfile.ZipFile(io.BytesIO(raw)) as source:
            unsigned = io.BytesIO()
            with zipfile.ZipFile(unsigned, "w", zipfile.ZIP_DEFLATED) as target:
                for info in source.infolist():
                    if info.filename != "SecurityBindings":
                        target.writestr(info, source.read(info.filename))
        with tempfile.TemporaryDirectory() as folder:
            stale, bare = Path(folder) / "stale.pbit", Path(folder) / "bare.pbit"
            stale.write_bytes(revert(raw))
            bare.write_bytes(unsigned.getvalue())
            with mock.patch.object(F, "TEMPLATES", (stale, bare, Path(folder) / "gone.pbit")):
                code, output = self.run_main(check.main)
        self.assertEqual(code, 1)
        self.assertIn("FAIL stale.pbit: not applied - DataModelSchema CoworkBilling[Users Over Limit] expression",
                      output)
        self.assertIn("FAIL bare.pbit: SecurityBindings was dropped", output)
        self.assertIn("FAIL gone.pbit: missing", output)

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
