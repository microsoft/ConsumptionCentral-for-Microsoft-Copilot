"""Tests for docs/scripts/fix_chargeback.py.

The first part replays what the new text means. The billing headers are read
by the M function in the text, so the test parses that function rather than
copying it. The allocation is replayed with DAX's blank rules, and its total
must equal Cowork Total Cost whatever the capacity pack.

The rest runs the fix against the three current templates. They ship the
chargeback model, undoing it in memory and running the fix again gives the
shipped template back byte for byte, a second run changes nothing, a dropped
description comes back, and text the fix does not recognise is refused.

    python docs/scripts/test_chargeback.py
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
import check_chargeback as check  # noqa: E402
import fix_chargeback as F  # noqa: E402

SAMPLE_POLICY = F.REPO / "1. Local CSV" / "sample-data" / "SpendingPolicyMetadata.csv"
APP_POLICY = F.REPO / "app" / "public" / "sample" / "SpendingPolicyMetadata.csv"
APP_STORE = F.REPO / "app" / "src" / "data" / "store.ts"


def expression(name):
    return F.joined(next(m for m in F.MEASURES if m["name"] == name)["expression"])


# ---------------------------------------------------------------------------
# What the M means
# ---------------------------------------------------------------------------


def header_rule(text):
    """The billing header function, read from the M: (characters removed, {key: column})."""
    removed = re.search(r"Text\.Remove\(n, \{([^}]*)\}\)", text)
    pairs = re.findall(r'k = "([a-z]+)"(?: or k = "([a-z]+)")? then "([A-Za-z]+)"', text)
    if removed is None or not pairs:
        raise AssertionError("the billing header function is not where the test expects it")
    keys = {}
    for first, second, name in pairs:
        keys[first] = name
        if second:
            keys[second] = name
    return re.findall(r'"([^"]*)"', removed.group(1)), keys


def rename(header, rule):
    removed, keys = rule
    key = header
    for character in removed:
        key = key.replace(character, "")
    return keys.get(key.lower(), header)


def blank_rule(text):
    """{column: value for a blank} read from the TransformColumns entries, None for null."""
    found = re.findall(r'\{"(\w+)", each if _ = null or Text\.Trim\(Text\.From\(_\)\) = "" then '
                       r'(null|"[^"]*") else Text\.Trim\(Text\.From\(_\)\), type text\}', text)
    return {name: None if value == "null" else value.strip('"') for name, value in found}


def tidy(value, blank):
    return blank if value is None or str(value).strip() == "" else str(value).strip()


class Queries(unittest.TestCase):
    def test_the_header_function_reads_every_spelling(self):
        rule = header_rule(F.billing_name("", ")"))
        self.assertEqual(rule[0], [" ", "_", "-"])
        for header, name in (("CostCentre", "CostCentre"), ("CostCenter", "CostCentre"),
                             ("Cost Centre", "CostCentre"), ("cost_center", "CostCentre"),
                             ("COST-CENTRE", "CostCentre"), ("department", "Department"),
                             ("Billing Owner", "BillingOwner"), ("billing_owner", "BillingOwner"),
                             ("Charge-Code", "ChargeCode"), ("charge code", "ChargeCode"),
                             ("Name", "Name"), ("SpendingPolicyId", "SpendingPolicyId"),
                             ("Cost Centres", "Cost Centres"), ("Dept", "Dept")):
            with self.subTest(header=header):
                self.assertEqual(rename(header, rule), name)
        self.assertEqual(set(rule[1].values()), set(F.BILLING))

    def test_blank_cost_centres_and_departments_are_not_assigned(self):
        rule = blank_rule(F.billing_values(""))
        self.assertEqual(rule, {"CostCentre": F.NOT_ASSIGNED, "Department": F.NOT_ASSIGNED,
                                "BillingOwner": None, "ChargeCode": None})
        for value, labelled, other in ((None, F.NOT_ASSIGNED, None), ("", F.NOT_ASSIGNED, None),
                                       ("   ", F.NOT_ASSIGNED, None), (" CC-1 ", "CC-1", "CC-1"),
                                       (4410, "4410", "4410")):
            with self.subTest(value=value):
                self.assertEqual(tidy(value, rule["CostCentre"]), labelled)
                self.assertEqual(tidy(value, rule["ChargeCode"]), other)

    def test_every_template_reads_the_four_columns(self):
        for variant, queries in F.QUERIES.items():
            for name, edits in queries.items():
                with self.subTest(variant=variant, query=name):
                    new = "\n".join(edit for _, edit in edits)
                    for column in F.BILLING:
                        self.assertIn(column, new)
        fabric = "\n".join(new for _, new in F.FABRIC_POLICY)
        for column, (source, _) in F.BILLING.items():
            self.assertIn(f'{{"{source}", "{column}"}}', fabric)
        for variant in (F.LOCAL, F.VIVA):
            text = "\n".join(new for edits in F.QUERIES[variant].values() for _, new in edits)
            self.assertIn("Table.TransformColumnNames(", text)

    def test_the_sample_policy_file_carries_the_columns(self):
        with SAMPLE_POLICY.open(encoding="utf-8-sig", newline="") as stream:
            reader = csv.DictReader(stream)
            rows = list(reader)
        self.assertEqual(reader.fieldnames[5:], list(F.BILLING))
        # The app's copy is prepared from the same file (npm run prepare-sample) and must agree with it.
        with APP_POLICY.open(encoding="utf-8-sig", newline="") as stream:
            app = list(csv.DictReader(stream))
        billing = {row["SpendingPolicyId"]: [row[c] for c in F.BILLING] for row in rows}
        self.assertTrue(app)
        for row in app:
            self.assertEqual([row[c] for c in F.BILLING], billing[row["SpendingPolicyId"]])
        rule = header_rule(F.billing_name("", ")"))
        self.assertEqual([rename(h, rule) for h in reader.fieldnames], reader.fieldnames)
        # Some policies are left blank on purpose so "(Not assigned)" shows up in the sample.
        self.assertTrue(any(not row["CostCentre"] for row in rows))
        self.assertTrue(any(row["CostCentre"] for row in rows))


# ---------------------------------------------------------------------------
# What the measures mean, replayed with DAX's blank rules
# ---------------------------------------------------------------------------

PREPAID_RATE, PAYG_RATE = 0.008, 0.01


def times(a, b):
    return None if a is None or b is None else a * b


def minus(a, b):
    """BLANK - BLANK is BLANK; otherwise a blank counts as 0."""
    return None if a is None and b is None else (a or 0) - (b or 0)


def plus(a, b):
    return None if a is None and b is None else (a or 0) + (b or 0)


def divide(a, b):
    return None if not b else a / b


def prepaid_share(credits, balance):
    used = sum(credits.values())
    return divide(min(used, balance), used)


def allocated_cost(group_credits, share):
    prepaid = times(group_credits, share)
    payg = minus(group_credits, prepaid)
    return plus(times(prepaid, PREPAID_RATE), times(payg, PAYG_RATE))


def cowork_total_cost(credits, balance):
    """Cowork Prepaid Cost + Cowork PAYG Cost over the whole tenant."""
    used = sum(credits.values())
    return min(used, balance) * PREPAID_RATE + max(0, used - balance) * PAYG_RATE


class Measures(unittest.TestCase):
    def test_the_share_is_tenant_wide(self):
        text = expression("Chargeback Prepaid Share %")
        for table in ("SpendingPolicy", "Org", "Group By", "CoworkBilling"):
            self.assertIn(f"REMOVEFILTERS( '{table}' )", text)
        self.assertNotIn("Date", text)
        self.assertTrue(text.endswith("DIVIDE( MIN( Used, [Cowork Prepaid Balance] ), Used )"))

    def test_people_follow_their_current_policy(self):
        text = expression("Allocated Credits")
        self.assertIn("REMOVEFILTERS( 'SpendingPolicy' )", text)
        self.assertIn("TREATAS( People, 'CoworkBilling'[UserPrincipalName] )", text)

    def test_the_costs_use_the_templates_rates(self):
        self.assertEqual(expression("Allocated Prepaid Cost"), "[Allocated Prepaid Credits] * [Cowork Prepaid Rate Value]")
        self.assertEqual(expression("Allocated PAYG Cost"), "[Allocated PAYG Credits] * [Cowork PAYG Rate Value]")
        store = APP_STORE.read_text(encoding="utf-8")
        self.assertRegex(store, rf"coworkPayg: {PAYG_RATE}\b")
        self.assertRegex(store, rf"coworkPrepaid: {PREPAID_RATE}\b")

    def test_the_cost_centres_add_up_to_cowork_total_cost(self):
        groups = {"CC-1": 1200, "CC-2": 300, "(Not assigned)": 500, "CC-3": 0}
        for balance in (0, 400, 1999, 2000, 5000):
            with self.subTest(balance=balance):
                share = prepaid_share(groups, balance)
                total = sum(allocated_cost(c, share) for c in groups.values())
                self.assertAlmostEqual(total, cowork_total_cost(groups, balance))
                self.assertAlmostEqual(allocated_cost(sum(groups.values()), share), total)
        # With no pack every credit is at the pay-as-you-go rate, which is Chargeback $.
        self.assertAlmostEqual(allocated_cost(1200, prepaid_share(groups, 0)), 1200 * PAYG_RATE)
        # Cowork Total Cost per cost centre would give each one the whole pack.
        self.assertGreater(sum(allocated_cost(c, prepaid_share(groups, 1000)) for c in groups.values()),
                           sum(cowork_total_cost({k: c}, 1000) for k, c in groups.items()))

    def test_nothing_used_charges_nothing(self):
        share = prepaid_share({"CC-1": 0}, 500)
        self.assertIsNone(share)
        self.assertEqual(allocated_cost(0, share), 0)
        self.assertIsNone(allocated_cost(None, 0.5))

    def test_measures_and_columns_are_well_formed(self):
        self.assertEqual(len({m["lineageTag"] for m in F.MEASURES} | {c["lineageTag"] for c in F.COLUMNS}), 12)
        self.assertEqual({m["displayFolder"] for m in F.MEASURES}, {F.FOLDER})
        self.assertEqual([c["name"] for c in F.COLUMNS], list(F.BILLING))
        for record in F.MEASURES + F.COLUMNS:
            with self.subTest(record=record["name"]):
                self.assertTrue(F.joined(record["description"]).strip())


# ---------------------------------------------------------------------------
# The shipped templates
# ---------------------------------------------------------------------------

TEMPLATES = {}  # variant -> raw bytes, read once


def setUpModule():
    for variant, path in F.TEMPLATES.items():
        TEMPLATES[variant] = path.read_bytes()


def parts(raw):
    """DataModelSchema and UnappliedChanges, read with zipfile rather than the fix's own codec."""
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        return tuple(json.loads(archive.read(name).decode("utf-16-le").lstrip("\ufeff"))
                     for name in (F.SCHEMA, F.UNAPPLIED))


def named(records, name):
    return next(record for record in records if record["name"] == name)


def table(document, name):
    return named(document["model"]["tables"], name)


def edited(raw, change_model=None, change_pending=None):
    """raw with the given changes applied to its two model parts, every other member kept."""
    package = F.Package(raw)
    updates = {}
    for name, change in ((F.SCHEMA, change_model), (F.UNAPPLIED, change_pending)):
        if change:
            document, encode = F.layout_for(package.contents[name], name)
            change(document)
            updates[name] = encode(document)
    return package.rebuild(updates)


def revert(raw, variant):
    """The template as it shipped before the chargeback model."""
    backwards = {name: [(new, old) for old, new in edits] for name, edits in F.QUERIES[variant].items()}

    def model(document):
        F.edit_queries_model(document["model"], backwards)
        policy = table(document, F.POLICY)
        policy["columns"] = [c for c in policy["columns"] if c["name"] not in F.BILLING]
        cowork = table(document, F.COWORK)
        cowork["measures"] = [m for m in cowork["measures"] if m["name"] not in {s["name"] for s in F.MEASURES}]
        for m in cowork["measures"]:
            if m["name"] in F.DESCRIPTIONS:
                del m["description"]

    return edited(raw, model, lambda document: F.edit_queries_pending(document, backwards))


def without(raw, table_name, record_name, collection="measures"):
    def change(document):
        named(table(document, table_name)[collection], record_name).pop("description")
    return edited(raw, change)


class ShippedTemplates(unittest.TestCase):
    def test_only_the_current_templates_are_patched(self):
        self.assertEqual({variant: path.parent.name for variant, path in F.TEMPLATES.items()},
                         {F.LOCAL: "1. Local CSV", F.FABRIC: "2. Fabric", F.VIVA: "3. Viva Direct"})

    def test_templates_carry_the_columns_and_measures(self):
        for variant, raw in TEMPLATES.items():
            with self.subTest(template=variant):
                model, _ = parts(raw)
                columns = [c["name"] for c in table(model, F.POLICY)["columns"]]
                start = columns.index("IncludedServices") + 1
                self.assertEqual(columns[start:start + 4], list(F.BILLING))
                for spec in F.COLUMNS:
                    self.assertEqual(named(table(model, F.POLICY)["columns"], spec["name"]), spec)
                measures = table(model, F.COWORK)["measures"]
                names = [m["name"] for m in measures]
                start = names.index(F.AFTER) + 1
                self.assertEqual(names[start:start + len(F.MEASURES)], [m["name"] for m in F.MEASURES])
                for spec in F.MEASURES:
                    self.assertEqual(named(measures, spec["name"]), spec)
                for name, description in F.DESCRIPTIONS.items():
                    self.assertEqual(F.joined(named(measures, name)["description"]), description)

    def test_both_copies_of_each_query_match(self):
        for variant, raw in TEMPLATES.items():
            model, pending = parts(raw)
            for name, edits in F.QUERIES[variant].items():
                with self.subTest(template=variant, query=name):
                    record, field = F.query_source(model["model"], name)
                    text = F.joined(record[field])
                    self.assertEqual(F.joined(named(pending["queries"], name)["text"]), text)
                    for old, new in edits:
                        self.assertIn(new, text)
                    cache = named(pending["queries"], name).get("lastLoadedAsTableFormulaText")
                    if cache:
                        self.assertEqual(json.loads(cache)["RootFormulaText"], text)

    def test_templates_are_current(self):
        for variant, raw in TEMPLATES.items():
            with self.subTest(template=variant):
                rebuilt, changes = F.build(raw, variant)
                self.assertEqual(changes, [])
                self.assertIs(rebuilt, raw)

    def test_the_check_passes_and_the_report_layer_is_signed(self):
        for variant, raw in TEMPLATES.items():
            with self.subTest(template=variant), zipfile.ZipFile(io.BytesIO(raw)) as archive:
                self.assertIn("SecurityBindings", archive.namelist())
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(check.main(), 0)


class RevertAndRerun(unittest.TestCase):
    def assertSameTemplate(self, rebuilt, raw):
        shipped, again = F.Package(raw), F.Package(rebuilt)
        self.assertEqual(list(again.infos), list(shipped.infos))
        for member in shipped.infos:
            self.assertTrue(again.contents[member] == shipped.contents[member], member)
            if member not in (F.SCHEMA, F.UNAPPLIED):
                self.assertTrue(again.locals[member] == shipped.locals[member], member)

    def test_undoing_the_change_and_running_again_gives_the_shipped_template(self):
        for variant, raw in TEMPLATES.items():
            with self.subTest(template=variant):
                stale = revert(raw, variant)
                model, _ = parts(stale)
                self.assertNotIn("CostCentre", [c["name"] for c in table(model, F.POLICY)["columns"]])
                rebuilt, changes = F.build(stale, variant)
                queries = list(F.QUERIES[variant])
                self.assertEqual(changes, [
                    *(f"{F.SCHEMA} {name}" for name in queries),
                    *(f"{F.SCHEMA} {F.POLICY}[{name}] added" for name in F.BILLING),
                    *(f"{F.SCHEMA} {F.COWORK}[{m['name']}] added" for m in F.MEASURES),
                    *(f"{F.SCHEMA} {F.COWORK}[{name}] description" for name in F.DESCRIPTIONS),
                    *(f"{F.UNAPPLIED} {name}" for name in queries),
                ])
                self.assertSameTemplate(rebuilt, raw)
                self.assertEqual(F.build(rebuilt, variant), (rebuilt, []))

    def test_descriptions_a_re_export_dropped_come_back(self):
        raw = TEMPLATES[F.FABRIC]
        for table_name, name, collection, change in (
                (F.COWORK, "Allocated Cost", "measures", f"{F.SCHEMA} {F.COWORK}[Allocated Cost] description restored"),
                (F.POLICY, "CostCentre", "columns", f"{F.SCHEMA} {F.POLICY}[CostCentre] description restored"),
                (F.COWORK, "Chargeback $", "measures", f"{F.SCHEMA} {F.COWORK}[Chargeback $] description")):
            with self.subTest(record=name):
                rebuilt, changes = F.build(without(raw, table_name, name, collection), F.FABRIC)
                self.assertEqual(changes, [change])
                self.assertSameTemplate(rebuilt, raw)

    def test_desktop_keys_on_an_added_record_are_kept(self):
        raw = TEMPLATES[F.LOCAL]

        def change(document):
            named(table(document, F.COWORK)["measures"], "Allocated Cost").update(
                {"annotations": [{"name": "PBI_FormatHint", "value": "{}"}]})
            named(table(document, F.COWORK)["measures"], "Allocated Cost").pop("description")

        rebuilt, changes = F.build(edited(raw, change), F.LOCAL)
        self.assertEqual(changes, [f"{F.SCHEMA} {F.COWORK}[Allocated Cost] description restored"])
        model, _ = parts(rebuilt)
        record = named(table(model, F.COWORK)["measures"], "Allocated Cost")
        self.assertEqual(list(record)[:2], ["name", "description"])
        self.assertIn("annotations", record)


class Refusals(unittest.TestCase):
    def test_query_text_edited_since_it_shipped_is_refused(self):
        stale = revert(TEMPLATES[F.LOCAL], F.LOCAL)

        def change(document):
            record, field = F.query_source(document["model"] if "model" in document else document, F.POLICY)
            record[field] = F.lines(F.joined(record[field]).replace("Columns=5", "Columns=6"))

        def pending(document):
            query = named(document["queries"], F.POLICY)
            query["text"] = F.lines(F.joined(query["text"]).replace("Columns=5", "Columns=6"))

        with self.assertRaisesRegex(F.PatchError, "SpendingPolicy: expected the original text once, found it 0"):
            F.build(edited(stale, change, pending), F.LOCAL)

    def test_copies_that_disagree_are_refused(self):
        def change(document):
            record, field = F.query_source(document["model"], F.LOOKUP)
            record[field] = F.lines(F.joined(record[field]) + "\n")

        with self.assertRaisesRegex(F.PatchError, "VivaPolicyLookup: the UnappliedChanges copy differs"):
            F.build(edited(TEMPLATES[F.VIVA], change), F.VIVA)

    def test_a_measure_edited_since_it_was_added_is_refused(self):
        def change(document):
            named(table(document, F.COWORK)["measures"], "Allocated PAYG Cost")["expression"] = "0"

        with self.assertRaisesRegex(F.PatchError, re.escape("CoworkBilling[Allocated PAYG Cost] expression has changed")):
            F.build(edited(TEMPLATES[F.LOCAL], change), F.LOCAL)

    def test_a_rewritten_description_is_refused(self):
        def change(document):
            named(table(document, F.COWORK)["measures"], "Chargeback %")["description"] = "Something else."

        with self.assertRaisesRegex(F.PatchError, re.escape("CoworkBilling[Chargeback %] description has changed")):
            F.build(edited(TEMPLATES[F.FABRIC], change), F.FABRIC)

    def test_a_clashing_lineage_tag_is_refused(self):
        stale = revert(TEMPLATES[F.LOCAL], F.LOCAL)

        def change(document):
            named(table(document, F.COWORK)["measures"], "Chargeback $")["lineageTag"] = F.MEASURES[3]["lineageTag"]

        with self.assertRaisesRegex(F.PatchError, "lineage tag of 'Allocated PAYG Credits' already in use"):
            F.build(edited(stale, change), F.LOCAL)

    def test_a_missing_anchor_is_refused(self):
        def change(document):
            cowork = table(document, F.COWORK)
            cowork["measures"] = [m for m in cowork["measures"] if m["name"] != F.AFTER]

        with self.assertRaisesRegex(F.PatchError, re.escape(f"expected one {F.AFTER!r}")):
            F.build(edited(revert(TEMPLATES[F.VIVA], F.VIVA), change), F.VIVA)

    def test_a_change_outside_the_chargeback_model_is_refused(self):
        real = F.edit_model

        def also_elsewhere(document, queries):
            changed = real(document, queries)
            named(table(document, F.COWORK)["measures"], "Cowork Total Cost")["expression"] = "0"
            return changed

        with mock.patch.object(F, "edit_model", also_elsewhere), \
                self.assertRaisesRegex(F.PatchError, "outside the chargeback model"):
            F.build(revert(TEMPLATES[F.LOCAL], F.LOCAL), F.LOCAL)

    def test_the_owned_mask_covers_only_the_chargeback_fields(self):
        model, _ = parts(TEMPLATES[F.FABRIC])
        queries = F.QUERIES[F.FABRIC]

        def same(change):
            changed = copy.deepcopy(model)
            change(changed)
            return F.owned_mask_model(changed, queries) == F.owned_mask_model(model, queries)

        def policy_column(name):
            return lambda d: named(table(d, F.POLICY)["columns"], name)

        def cowork_measure(name):
            return lambda d: named(table(d, F.COWORK)["measures"], name)

        inside = (
            lambda d: F.query_source(d["model"], F.POLICY)[0].update(expression="new"),
            lambda d: policy_column("Department")(d).update(dataType="int64"),
            lambda d: cowork_measure("Allocated Cost")(d).update(expression="new"),
            lambda d: cowork_measure("Chargeback")(d).update(description="new"),
        )
        outside = (
            lambda d: policy_column("PlanLimit")(d).update(description="new"),
            lambda d: cowork_measure("Chargeback")(d).update(expression="new"),
            lambda d: cowork_measure("Cowork Total Cost")(d).update(expression="new"),
            lambda d: F.query_source(d["model"], "CoworkBilling")[0].update(expression="new"),
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
        raw = TEMPLATES[F.LOCAL]
        stale = revert(raw, F.LOCAL)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "template.pbit"
            path.write_bytes(stale)
            with mock.patch.object(F, "TEMPLATES", {F.LOCAL: path}):
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
            with mock.patch.object(F, "TEMPLATES", {F.FABRIC: Path(folder) / "missing.pbit", F.LOCAL: path}):
                code, output = self.run_main(F.main, [])
                self.assertEqual(code, 1)
                self.assertIn("missing template", output)
                self.assertTrue(F.Package(path.read_bytes()).contents == F.Package(raw).contents)
            self.assertEqual([entry.name for entry in Path(folder).iterdir()], ["template.pbit"])

    def test_the_check_names_what_is_missing(self):
        raw = TEMPLATES[F.LOCAL]
        with zipfile.ZipFile(io.BytesIO(raw)) as source:
            unsigned = io.BytesIO()
            with zipfile.ZipFile(unsigned, "w", zipfile.ZIP_DEFLATED) as target:
                for info in source.infolist():
                    if info.filename != "SecurityBindings":
                        target.writestr(info, source.read(info.filename))
        with tempfile.TemporaryDirectory() as folder:
            stale, bare, gone = Path(folder) / "stale.pbit", Path(folder) / "bare.pbit", Path(folder) / "gone.pbit"
            stale.write_bytes(revert(raw, F.LOCAL))
            bare.write_bytes(unsigned.getvalue())
            with mock.patch.object(F, "TEMPLATES", {F.LOCAL: stale, F.FABRIC: gone, F.VIVA: bare}):
                code, output = self.run_main(check.main)
        self.assertEqual(code, 1)
        self.assertIn("FAIL stale.pbit: not applied - DataModelSchema SpendingPolicy", output)
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
