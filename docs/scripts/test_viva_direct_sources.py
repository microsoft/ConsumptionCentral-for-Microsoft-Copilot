"""Tests for docs/scripts/fix_viva_direct_sources.py and check_viva_direct_sources.py.

The fix runs against the shipped Viva Direct template, which carries it in both
model parts. Undoing it in memory (the old DataFiles and CoworkTaskInput,
OrgNormalised before PAX's aliases, no SharePointSiteUrl or SourceFiles) and
running it again gives the shipped template back, and a second run changes
nothing. The fix refuses input it does not recognise. The check flags a template
that reads local files anywhere but SourceFiles, or that would still read them
once a SharePoint form is swapped in, so the published model needs no gateway.

No M runs here, so the rules the M applies are replayed in Python:

* Depth, in the old DataFiles, the local SourceFiles and the SharePoint form;
* how the SharePoint forms resolve DataFolder and SharePointSiteUrl;
* how GetDataFile picks the org file from a folder's file names;
* how OrgNormalised reads PAX's Entra export, and which of its columns Org
  Attribute Source turns into Group By attributes. The export is
  viva_direct_sources/entra_org.pax-sample.csv: six fictional people, in the
  columns PAX v1.11.15 writes.

Each replay pins the M lines it follows, so changing them fails here until the
replay changes too.

    python docs/scripts/test_viva_direct_sources.py
"""
import codecs
import contextlib
import copy
import csv
import functools
import hashlib
import io
import json
import re
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, unquote

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_viva_direct_sources as check  # noqa: E402
import fix_viva_direct_sources as F  # noqa: E402
import fix_viva_query_org as org_fix  # noqa: E402

RAW = F.TEMPLATE.read_bytes()
FIXTURE = F.HERE / "viva_direct_sources" / "entra_org.pax-sample.csv"
LABELS = [
    "DataModelSchema SharePointSiteUrl added",
    "DataModelSchema SourceFiles added",
    "DataModelSchema DataFiles",
    "DataModelSchema CoworkTaskInput",
    "DataModelSchema OrgNormalised",
    "DataModelSchema PBI_QueryOrder",
    "UnappliedChanges SharePointSiteUrl added",
    "UnappliedChanges SourceFiles added",
    "UnappliedChanges DataFiles",
    "UnappliedChanges CoworkTaskInput",
    "UnappliedChanges OrgNormalised",
]


def parts(raw):
    """DataModelSchema and UnappliedChanges, read with zipfile rather than the fix's own codec."""
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        return tuple(json.loads(archive.read(name).decode("utf-16-le").lstrip("\ufeff"))
                     for name in (F.SCHEMA, F.UNAPPLIED))


def named(records, name):
    hits = [record for record in records if record.get("name") == name]
    if len(hits) != 1:
        raise AssertionError(f"{name}: {len(hits)} records with this name")
    return hits[0]


def expressions(model):
    return {e["name"]: F.joined(e["expression"]) for e in model["model"]["expressions"]}


def queries(pending):
    return {q["name"]: F.joined(q["text"]) for q in pending["queries"]}


def query_order(model):
    return json.loads(named(model["model"]["annotations"], F.QUERY_ORDER)["value"])


def lineage_tags(value):
    """Every lineageTag in a JSON document."""
    if isinstance(value, dict):
        own = [value["lineageTag"]] if isinstance(value.get("lineageTag"), str) else []
        return own + [tag for item in value.values() for tag in lineage_tags(item)]
    if isinstance(value, list):
        return [tag for item in value for tag in lineage_tags(item)]
    return []


def edited(raw, change):
    """raw with change(model, pending) applied to its two model parts, every other member kept."""
    package = F.Package(raw)
    model, encode_model = F.layout_for(package.contents[F.SCHEMA], F.SCHEMA)
    pending, encode_pending = F.layout_for(package.contents[F.UNAPPLIED], F.UNAPPLIED)
    change(model, pending)
    return package.rebuild({F.SCHEMA: encode_model(model), F.UNAPPLIED: encode_pending(pending)})


def set_text(model, pending, name, text, where=("model", "pending")):
    """Give a query new text in the model, in UnappliedChanges or in both, each in its own shape."""
    if "model" in where:
        expression = named(model["model"]["expressions"], name)
        expression["expression"] = text.split("\n") if isinstance(expression["expression"], list) else text
    if "pending" in where:
        named(pending["queries"], name)["text"] = text.split("\n")


def undo(text, edits):
    """text with edits taken off, newest first."""
    for old, new in reversed(edits):
        if text.count(new) != 1:
            raise AssertionError(f"cannot undo {new[:60]!r}")
        text = text.replace(new, old)
    return text


def pre_pax(text):
    """OrgNormalised as it was before PAX's aliases."""
    return undo(text, F.ORG_EDITS)


def pax_first_shipped(text):
    """OrgNormalised as PAX's aliases first shipped, when its postal code and account flags were Group Bys."""
    return undo(text, F.ORG_EDITS[-1:])


def text_before(name):
    return pre_pax(F.ORG_NORMALISED_M) if name == F.ORG_NORMALISED else F.REWRITES[name][0]


def text_after(name):
    return F.ORG_NORMALISED_M if name == F.ORG_NORMALISED else F.REWRITES[name][1]


@functools.lru_cache(maxsize=None)
def unpatch(raw, names=F.REWRITTEN, added=True):
    """The template before the fix, undone in memory: the named rewrites and, if added is
    set, SharePointSiteUrl and SourceFiles. Desktop's last-loaded copies move back too."""
    def change(model, pending):
        for name in names:
            set_text(model, pending, name, text_before(name))
        rewound = {name: (text_after(name), text_before(name)) for name in names}
        for query in pending["queries"]:
            F.sync_last_loaded(query, rewound)
        if added:
            model["model"]["expressions"] = [
                e for e in model["model"]["expressions"] if e["name"] not in F.ADDED]
            pending["queries"] = [q for q in pending["queries"] if q["name"] not in F.ADDED]
            order = named(model["model"]["annotations"], F.QUERY_ORDER)
            order["value"] = F.dumps([n for n in json.loads(order["value"]) if n not in F.ADDED])
    return edited(raw, change)


def run(function, *args):
    output = io.StringIO()
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        code = function(*args)
    return code, output.getvalue()


def run_check(raw):
    """check_viva_direct_sources.main() against these template bytes."""
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "template.pbit"
        path.write_bytes(raw)
        with mock.patch.object(F, "TEMPLATE", path):
            return run(check.main)


class Shipped(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model, cls.pending = parts(RAW)

    def test_the_fix_and_the_check_find_nothing_to_do(self):
        rebuilt, changes = F.build(RAW)
        self.assertEqual(changes, [])
        self.assertIs(rebuilt, RAW)
        code, output = run_check(RAW)
        self.assertEqual(code, 0, output)
        self.assertIn("its SharePoint forms need no gateway", output)

    def test_the_added_queries_come_straight_after_data_folder(self):
        for part, names in (
                ("model", [e["name"] for e in self.model["model"]["expressions"]]),
                ("pending", [q["name"] for q in self.pending["queries"]]),
                ("query order", query_order(self.model))):
            with self.subTest(part=part):
                at = names.index(F.DATA_FOLDER)
                self.assertEqual(names[at:at + 3], [F.DATA_FOLDER, *F.ADDED])
                for name in F.ADDED:
                    self.assertEqual(names.count(name), 1)

    def test_the_added_queries_are_the_fixs_entries_and_unloaded(self):
        schema, pending = F.schema_entries(), F.pending_entries()
        tables = [t["name"] for t in self.model["model"]["tables"]]
        for name in F.ADDED:
            with self.subTest(query=name):
                self.assertEqual(list(named(self.model["model"]["expressions"], name).items()),
                                 list(schema[name].items()))
                self.assertEqual(list(named(self.pending["queries"], name).items()),
                                 list(pending[name].items()))
                self.assertNotIn(name, tables)

    def test_the_added_queries_keep_fixed_lineage_tags(self):
        self.assertEqual(F.tag(F.SITE_URL), "f2300be4-39bc-54b9-856f-01551bb48aad")
        self.assertEqual(F.tag(F.SOURCE_FILES), "83efcd96-a36d-5049-92b5-a0e7badda7a2")
        for part, document in (("model", self.model), ("pending", self.pending)):
            with self.subTest(part=part):
                found = lineage_tags(document)
                for name in F.ADDED:
                    self.assertEqual(found.count(F.tag(name)), 1)
        found = lineage_tags(self.model)
        self.assertEqual(len(found), len(set(found)))

    def test_both_parts_hold_the_shipped_sources(self):
        model, pending = expressions(self.model), queries(self.pending)
        for name in F.REWRITTEN:
            with self.subTest(query=name):
                self.assertEqual(model[name], text_after(name))
                self.assertEqual(pending[name], text_after(name))
        self.assertEqual(model[F.SOURCE_FILES], F.SOURCE_FILES_M)
        self.assertEqual(model[F.SITE_URL], F.SITE_URL_M)
        for name, text in model.items():
            with self.subTest(query=name):
                self.assertEqual(pending[name], text)

    def test_nothing_reads_local_files_once_a_sharepoint_form_is_swapped_in(self):
        """No expression or partition calls Folder.Files, Folder.Contents or File.Contents, so no gateway."""
        partitions = sum(1 for t in self.model["model"]["tables"] for p in t.get("partitions", [])
                         if p["source"].get("type") == "m")
        self.assertEqual(len(check.m_sources(self.model)),
                         len(self.model["model"]["expressions"]) + partitions)
        self.assertEqual(check.local_reads(self.model), {F.SOURCE_FILES: ["Folder.Files"]})
        self.assertEqual(check.shipped_problems(self.model), [])
        self.assertEqual(check.form_problems(self.model), [])
        for form in F.SHAREPOINT_FORMS:
            with self.subTest(form=form.name):
                published = check.swapped(self.model, form)
                self.assertEqual(check.local_reads(published), {})
                self.assertEqual(check.m_sources(published)[F.SOURCE_FILES], F.source(form))


class RevertAndRerun(unittest.TestCase):
    def assertShipped(self, rebuilt):
        shipped, again = F.Package(RAW), F.Package(rebuilt)
        self.assertEqual(list(again.infos), list(shipped.infos))
        for member in shipped.infos:
            self.assertTrue(again.contents[member] == shipped.contents[member], member)
            if member not in (F.SCHEMA, F.UNAPPLIED):
                self.assertTrue(again.locals[member] == shipped.locals[member], member)

    def test_undoing_the_fix_and_running_it_again_gives_the_shipped_template(self):
        stale = unpatch(RAW)
        self.assertFalse(F.Package(stale).contents[F.SCHEMA] == F.Package(RAW).contents[F.SCHEMA])
        rebuilt, changes = F.build(stale)
        self.assertEqual(changes, LABELS)
        self.assertShipped(rebuilt)
        again, changes = F.build(rebuilt)
        self.assertEqual(changes, [])
        self.assertIs(again, rebuilt)

    def test_each_part_of_the_fix_applies_on_its_own(self):
        cases = (
            ((F.ORG_NORMALISED,), False,
             ["DataModelSchema OrgNormalised", "UnappliedChanges OrgNormalised"]),
            (("DataFiles", "CoworkTaskInput"), False,
             ["DataModelSchema DataFiles", "DataModelSchema CoworkTaskInput",
              "UnappliedChanges DataFiles", "UnappliedChanges CoworkTaskInput"]),
            ((), True,
             ["DataModelSchema SharePointSiteUrl added", "DataModelSchema SourceFiles added",
              "DataModelSchema PBI_QueryOrder",
              "UnappliedChanges SharePointSiteUrl added", "UnappliedChanges SourceFiles added"]),
        )
        for names, added, expected in cases:
            with self.subTest(names=names, added=added):
                rebuilt, changes = F.build(unpatch(RAW, names, added))
                self.assertEqual(changes, expected)
                self.assertShipped(rebuilt)

    def test_desktops_last_loaded_copies_move_with_the_rewrite(self):
        stale = unpatch(RAW)
        old = text_before("DataFiles")
        other = next(q["name"] for q in parts(stale)[1]["queries"]
                     if q.get("lastLoadedAsTableFormulaText") and q["name"] not in F.REWRITTEN)

        def cached(_, pending):
            named(pending["queries"], "DataFiles")["lastLoadedAsTableFormulaText"] = F.dumps(
                {"RootFormulaText": old})
            query = named(pending["queries"], other)
            cache = json.loads(query["lastLoadedAsTableFormulaText"])
            cache["ReferencedQueriesFormulaText"] = {"DataFiles": old, "Elsewhere": old}
            query["lastLoadedAsTableFormulaText"] = F.dumps(cache)

        rebuilt, _ = F.build(edited(stale, cached))
        pending = parts(rebuilt)[1]
        self.assertEqual(json.loads(named(pending["queries"], "DataFiles")["lastLoadedAsTableFormulaText"]),
                         {"RootFormulaText": F.DATA_FILES_M})
        cache = json.loads(named(pending["queries"], other)["lastLoadedAsTableFormulaText"])
        self.assertEqual(cache["ReferencedQueriesFormulaText"], {"DataFiles": F.DATA_FILES_M, "Elsewhere": old})

    def test_fix_viva_query_org_still_accepts_each_earlier_orgnormalised(self):
        profile = org_fix.PROFILES["direct"]
        replacements = {F.ORG_NORMALISED: F.ORG_NORMALISED_M}
        for old, digest in (
                (text_before(F.ORG_NORMALISED), "04e88e974a8778603ac3c93944e2cf4847c1b6b48cd668ca0c5c3421ed516214"),
                (pax_first_shipped(F.ORG_NORMALISED_M),
                 "300423f0a26c26a5a299c3887d21c2145103c4d60d05205aeb647e79c0c9de8d")):
            with self.subTest(digest=digest):
                self.assertEqual(hashlib.sha256(old.encode("utf-8")).hexdigest(), digest)
                self.assertIn(digest, profile["previous_sha256"][F.ORG_NORMALISED])
                with mock.patch.object(org_fix, "ACTIVE_PROFILE", "direct"), \
                        mock.patch.object(org_fix, "ORIGINAL_SHA256", dict(profile["original_sha256"])):
                    for text in (old, F.ORG_NORMALISED_M):
                        org_fix.check_anchor(F.ORG_NORMALISED, text, replacements, "test")
                    with self.assertRaisesRegex(F.PatchError, "unsupported source"):
                        org_fix.check_anchor(F.ORG_NORMALISED, old + "\n", replacements, "test")

    def test_orgnormalised_as_pax_first_shipped_is_upgraded(self):
        old = pax_first_shipped(F.ORG_NORMALISED_M)

        def change(model, pending):
            set_text(model, pending, F.ORG_NORMALISED, old)
            for query in pending["queries"]:
                F.sync_last_loaded(query, {F.ORG_NORMALISED: (F.ORG_NORMALISED_M, old)})

        rebuilt, changes = F.build(edited(RAW, change))
        self.assertEqual(changes, ["DataModelSchema OrgNormalised", "UnappliedChanges OrgNormalised"])
        self.assertShipped(rebuilt)
        again, changes = F.build(rebuilt)
        self.assertEqual(changes, [])
        self.assertIs(again, rebuilt)


class Refusals(unittest.TestCase):
    def assertRefused(self, raw, pattern):
        with self.assertRaisesRegex(F.PatchError, pattern):
            F.build(raw)

    def test_a_rewritten_query_it_does_not_recognise_is_refused(self):
        for template, raw in (("shipped", RAW), ("stale", unpatch(RAW))):
            for name in F.REWRITTEN:
                with self.subTest(template=template, query=name):
                    def change(model, pending, name=name):
                        text = F.joined(named(pending["queries"], name)["text"]) + "\n// edited"
                        set_text(model, pending, name, text)
                    self.assertRefused(edited(raw, change), f"^{name}: neither .* review it before patching")

    def test_an_added_query_holding_other_text_is_refused(self):
        cases = (
            (F.SITE_URL, "null" + F.SITE_URL_M[2:], "is null; run fix_pbit_defaults.py first"),
            (F.SITE_URL, '"https://contoso.sharepoint.com/sites/Elsewhere"' + F.SITE_URL_M[2:],
             "is already there with other text"),
            (F.SOURCE_FILES, F.source(F.SHAREPOINT_FORMS[0]), "is already there with other text"),
        )
        for name, text, message in cases:
            for where, label in ((("model", "pending"), F.SCHEMA), (("pending",), F.UNAPPLIED)):
                with self.subTest(query=name, text=text[:24], where=where):
                    raw = edited(RAW, lambda model, pending: set_text(model, pending, name, text, where))
                    self.assertRefused(raw, f"^{label}: {name} {re.escape(message)}")

    def test_a_pending_copy_out_of_step_with_the_model_is_refused(self):
        def drift(_, pending):
            named(pending["queries"], "DataFiles")["text"].append("// drift")

        self.assertRefused(edited(RAW, drift), "^DataFiles: .*fix_query_body_drift")

    def test_no_data_folder_to_put_the_added_queries_after_is_refused(self):
        def without(records):
            return [r for r in records if r["name"] != F.DATA_FOLDER]

        def order_without(model, _):
            order = named(model["model"]["annotations"], F.QUERY_ORDER)
            order["value"] = F.dumps([n for n in json.loads(order["value"]) if n != F.DATA_FOLDER])

        cases = (
            (lambda model, _: model["model"].update(expressions=without(model["model"]["expressions"])),
             "DataModelSchema expressions: no DataFolder to put SharePointSiteUrl after"),
            (lambda _, pending: pending.update(queries=without(pending["queries"])),
             "UnappliedChanges queries: no DataFolder to put SharePointSiteUrl after"),
            (order_without, "DataModelSchema: PBI_QueryOrder has no DataFolder to put SharePointSiteUrl after"),
        )
        for change, message in cases:
            with self.subTest(message=message):
                self.assertRefused(edited(unpatch(RAW), change), f"^{re.escape(message)}$")

    def test_owned_masks_cover_only_the_fixs_queries(self):
        refs = {"DataFiles": "c", "GetDataFile": "d"}
        model = {"model": {
            "expressions": [
                {"name": "DataFolder", "kind": "m", "expression": "x"},
                {"name": "SharePointSiteUrl", "kind": "m", "expression": "y"},
                {"name": "SourceFiles", "kind": "m", "expression": ["a", "b"]},
                {"name": "DataFiles", "kind": "m", "expression": ["c"], "lineageTag": "t"},
                {"name": "GetDataFile", "kind": "m", "expression": ["d"]},
            ],
            "annotations": [
                {"name": "PBI_QueryOrder", "value": '["DataFolder","SharePointSiteUrl","SourceFiles","DataFiles"]'},
                {"name": "Other", "value": "v"},
            ],
        }}
        pending = {"queries": [
            {"name": "DataFolder", "text": ["x"]},
            {"name": "SourceFiles", "text": ["a", "b"]},
            {"name": "DataFiles", "text": ["c"], "lastLoadedAsTableFormulaText": '{"RootFormulaText":"c"}'},
            {"name": "Org", "text": ["o"], "lastLoadedAsTableFormulaText": F.dumps(
                {"RootFormulaText": "o", "ReferencedQueriesFormulaText": refs})},
        ]}

        def cache(document, root="o", **changed):
            named(document["queries"], "Org")["lastLoadedAsTableFormulaText"] = F.dumps(
                {"RootFormulaText": root, "ReferencedQueriesFormulaText": {**refs, **changed}})

        def same(mask, document, change):
            changed = copy.deepcopy(document)
            change(changed)
            return mask(changed) == mask(document)

        def model_expression(name, **changed):
            return lambda d: named(d["model"]["expressions"], name).update(changed)

        def order(value):
            return lambda d: named(d["model"]["annotations"], "PBI_QueryOrder").update(value=value)

        inside = (
            (F.owned_mask_model, model, model_expression("DataFiles", expression=["new"])),
            (F.owned_mask_model, model, model_expression("SharePointSiteUrl", expression="z")),
            (F.owned_mask_model, model, lambda d: d["model"]["expressions"].pop(2)),
            (F.owned_mask_model, model, order('["DataFolder","DataFiles"]')),
            (F.owned_mask_pending, pending, lambda d: named(d["queries"], "DataFiles").update(
                text=["new"], lastLoadedAsTableFormulaText='{"RootFormulaText":"new"}')),
            (F.owned_mask_pending, pending, lambda d: named(d["queries"], "SourceFiles").update(text=["z"])),
            (F.owned_mask_pending, pending, lambda d: cache(d, DataFiles="new")),
        )
        outside = (
            (F.owned_mask_model, model, model_expression("DataFolder", expression="new")),
            (F.owned_mask_model, model, model_expression("DataFiles", lineageTag="u")),
            (F.owned_mask_model, model, model_expression("GetDataFile", expression=["new"])),
            (F.owned_mask_model, model, order('["DataFiles","DataFolder","SharePointSiteUrl","SourceFiles"]')),
            (F.owned_mask_model, model, lambda d: named(d["model"]["annotations"], "Other").update(value="w")),
            (F.owned_mask_pending, pending, lambda d: named(d["queries"], "DataFolder").update(text=["new"])),
            (F.owned_mask_pending, pending, lambda d: named(d["queries"], "Org").update(text=["new"])),
            (F.owned_mask_pending, pending, lambda d: cache(d, GetDataFile="new")),
            (F.owned_mask_pending, pending, lambda d: cache(d, root="new")),
        )
        for index, (mask, document, change) in enumerate(inside):
            with self.subTest(inside=index):
                self.assertTrue(same(mask, document, change))
        for index, (mask, document, change) in enumerate(outside):
            with self.subTest(outside=index):
                self.assertFalse(same(mask, document, change))


class CommandLine(unittest.TestCase):
    def test_check_dry_run_and_write(self):
        stale = unpatch(RAW)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "template.pbit"
            path.write_bytes(stale)
            with mock.patch.object(F, "TEMPLATE", path):
                code, output = run(F.main, ["--check"])
                self.assertEqual(code, 1)
                self.assertIn("the template is stale", output)
                for label in LABELS:
                    self.assertIn(f"  {label}\n", output)
                self.assertEqual(run(F.main, ["--dry-run"])[0], 0)
                self.assertTrue(path.read_bytes() == stale)
                code, output = run(F.main, [])
                self.assertEqual(code, 0)
                self.assertIn("validated patch written", output)
                written = path.read_bytes()
                self.assertTrue(F.Package(written).contents == F.Package(RAW).contents)
                code, output = run(F.main, ["--check"])
                self.assertEqual(code, 0)
                self.assertIn("already applied", output)
                self.assertEqual(run(F.main, [])[0], 0)
                self.assertTrue(path.read_bytes() == written)
            with mock.patch.object(F, "TEMPLATE", Path(folder) / "missing.pbit"):
                code, output = run(F.main, [])
                self.assertEqual(code, 1)
                self.assertIn("missing template", output)
            refused = edited(stale, lambda model, pending: set_text(
                model, pending, "DataFiles", "let\n\tx = 1\nin\n\tx"))
            path.write_bytes(refused)
            with mock.patch.object(F, "TEMPLATE", path):
                code, output = run(F.main, [])
                self.assertEqual(code, 1)
                self.assertIn("FAILED: DataFiles: neither", output)
                self.assertTrue(path.read_bytes() == refused)
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


def reads(text):
    """check.local_reads on one M text."""
    return check.local_reads({"model": {"expressions": [{"name": "Q", "kind": "m", "expression": text}],
                                        "tables": []}})


class Check(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model = parts(RAW)[0]

    def test_a_stale_template_fails_with_each_change_it_lacks(self):
        code, output = run_check(unpatch(RAW))
        self.assertEqual(code, 1)
        for label in LABELS:
            self.assertIn(f"FAIL not applied - {label}\n", output)

    def test_a_file_that_is_not_a_template_fails(self):
        code, output = run_check(b"not a template")
        self.assertEqual(code, 1)
        self.assertIn("\nFAIL ", output)

    def test_another_local_read_fails_with_or_without_a_form_swapped_in(self):
        def added_expression(model):
            model["model"]["expressions"].append({
                "name": "Extra", "kind": "m", "expression": 'Csv.Document(File.Contents("C:\\Data\\extra.csv"))'})
            return "Extra", ["File.Contents"]

        def replaced_partition(model):
            table = next(t for t in model["model"]["tables"]
                         if any(p["source"].get("type") == "m" for p in t.get("partitions", [])))
            partition = next(p for p in table["partitions"] if p["source"].get("type") == "m")
            partition["source"]["expression"] = 'Folder.Contents("C:\\Data")'
            return f"{table['name']} (partition)", ["Folder.Contents"]

        for change in (added_expression, replaced_partition):
            with self.subTest(change=change.__name__):
                model = copy.deepcopy(self.model)
                name, calls = change(model)
                self.assertEqual(check.local_reads(model), {F.SOURCE_FILES: ["Folder.Files"], name: calls})
                self.assertTrue(any(problem.startswith("only SourceFiles may read local files")
                                    for problem in check.shipped_problems(model)))
                swapped_in = [problem for problem in check.form_problems(model)
                              if "still reads local files once swapped in" in problem]
                self.assertEqual(len(swapped_in), len(F.SHAREPOINT_FORMS))
                for problem in swapped_in:
                    self.assertTrue(problem.endswith(f": {({name: calls})}"), problem)

    def test_a_source_it_cannot_read_is_left_for_review(self):
        model = copy.deepcopy(self.model)
        model["model"]["expressions"].append({"name": "Odd", "kind": "other", "expression": "1"})
        with self.assertRaisesRegex(ValueError, "^Odd: a other expression; review it by hand$"):
            check.m_sources(model)
        model = copy.deepcopy(self.model)
        table = next(t for t in model["model"]["tables"] if t.get("partitions"))
        table["partitions"][0]["source"] = {"type": "entity", "entityName": "Odd"}
        with self.assertRaisesRegex(ValueError, "a entity partition; review it by hand$"):
            check.m_sources(model)

    def test_only_code_counts_as_a_read_or_a_reference(self):
        for text in ('// Folder.Files(DataFolder)\n1',
                     '/* File.Contents("a")\nFolder.Contents(b) */ 1',
                     '"Folder.Files("" quoted "") File.Contents"',
                     'Table.SelectRows(t, each [#"Folder Path"] <> null)'):
            with self.subTest(text=text):
                self.assertEqual(reads(text), {})
        self.assertEqual(reads('#"File.Contents"("C:\\a.csv")'), {"Q": ["File.Contents"]})
        self.assertEqual(reads('let x = Folder.Files(p) in File.Contents(x{0}[Path])'),
                         {"Q": ["File.Contents", "Folder.Files"]})
        for text, expected in (('Folder.Files(DataFolder)', True), ('#"DataFolder"', True),
                               ('DataFolder2', False), ('My.DataFolder', False), ('DataFolder.Name', False),
                               ('"DataFolder"', False), ('// DataFolder', False), ('#"DataFolder Copy"', False)):
            with self.subTest(text=text):
                self.assertIs(check.references(text, F.DATA_FOLDER), expected)
        self.assertEqual(check.code('a "b" // c'), 'a    ')
        self.assertEqual(check.code('a "b" // c', strings=True), 'a "b"  ')

    def test_the_swap_sets_the_two_parameters_and_replaces_source_files_only(self):
        before = copy.deepcopy(self.model)
        for form in F.SHAREPOINT_FORMS:
            with self.subTest(form=form.name):
                published = check.swapped(self.model, form)
                self.assertEqual(self.model, before)
                old, new = expressions(self.model), expressions(published)
                meta = old[F.DATA_FOLDER].partition(" meta [")[2]
                self.assertTrue(meta)
                self.assertEqual(new[F.DATA_FOLDER], f'"{check.FOLDER}" meta [{meta}')
                self.assertEqual(new[F.SITE_URL], f'"{check.SITE}"{F.SITE_URL_M[2:]}')
                self.assertEqual(new[F.SOURCE_FILES], F.source(form))
                restored = copy.deepcopy(published)
                for name in (F.DATA_FOLDER, *F.ADDED):
                    check.named(restored, name)["expression"] = check.named(self.model, name)["expression"]
                self.assertEqual(restored, self.model)

    def test_the_swap_throws_where_the_installer_would(self):
        model = copy.deepcopy(self.model)
        with self.assertRaisesRegex(KeyError, "Missing: 0 expressions with this name"):
            check.set_parameter(model, "Missing", "x")
        with self.assertRaisesRegex(KeyError, "Missing: 0 expressions with this name"):
            check.replace_expression(model, "Missing", "x")
        with self.assertRaisesRegex(ValueError, "^SourceFiles is not a parameter$"):
            check.set_parameter(model, F.SOURCE_FILES, "x")
        self.assertEqual(check.m_string('a "b"'), '"a ""b"""')

    def test_the_forms_share_their_resolve_steps_and_stay_plain_lf_text(self):
        def rewrite(path, old, new):
            raw = path.read_bytes()
            self.assertEqual(raw.count(old), 1, old)
            path.write_bytes(raw.replace(old, new))

        first, second = (form.name for form in F.SHAREPOINT_FORMS)
        plain_lf = [f"{first}: not plain LF text without a byte order mark"]
        cases = (
            ("identical", lambda a, b: None, []),
            ("steps differ", lambda a, b: rewrite(b, b'"/forms/"', b'"/Forms/"'),
             ["the SharePoint forms resolve the folder's address differently"]),
            ("CRLF", lambda a, b: a.write_bytes(a.read_bytes().replace(b"\n", b"\r\n")), plain_lf),
            ("BOM", lambda a, b: a.write_bytes(codecs.BOM_UTF8 + a.read_bytes()), plain_lf),
            ("local listing", lambda a, b: rewrite(a, b"Listing = SharePoint.Files(Site, [ApiVersion = 15]),",
                                                   b"Listing = Folder.Files(Given),"),
             [f"{first}: still reads local files once swapped in: {({F.SOURCE_FILES: ['Folder.Files']})}",
              f"{first}: does not list the folder with SharePoint.Files"]),
        )
        self.assertEqual(second, "SourceFiles.SharePoint.Contents.m")
        for label, change, expected in cases:
            with self.subTest(case=label), tempfile.TemporaryDirectory() as folder:
                copies = []
                for form in F.SHAREPOINT_FORMS:
                    path = Path(folder) / form.name
                    path.write_bytes(form.read_bytes())
                    copies.append(path)
                change(*copies)
                with mock.patch.object(F, "SHAREPOINT_FORMS", tuple(copies)):
                    self.assertEqual(check.form_problems(self.model), expected)


# The SharePoint forms' shared resolve steps, ported to Python below.
RESOLVE_PINS = (
    'Site = if SharePointSiteUrl = null then ""',
    'else Text.TrimEnd(Text.BeforeDelimiter(Text.Trim(Text.From(SharePointSiteUrl)), "?"), {"/", "\\"}),',
    'Given = if DataFolder = null then "" else Text.Trim(Text.From(DataFolder)),',
    'if not Text.Contains(path, "%") then path',
    'if _ = "+" then "%2B" else if _ = "&" then "%26" else if _ = "#" then "%23"',
    'else if _ = "=" then "%3D" else if _ = ";" then "%3B" else if _ = " " then "%20" else _)))[Query], "p")',
    'Plain = (path as text) as text => Text.TrimEnd(Text.Replace(Decode(path), "\\", "/"), "/") & "/",',
    'Key = (path as text) as text => Text.Lower(Plain(path)),',
    'Segments = (path as text) as number => List.Count(List.Select(Text.Split(path, "/"), each _ <> "")),',
    'Slashed = Text.Replace(Given, "\\", "/"),',
    'Lowered = Text.Lower(Given),',
    'IsUrl = Text.StartsWith(Lowered, "https://") or Text.StartsWith(Lowered, "http://"),',
    'IsLocal = (Text.Length(Given) > 1 and Text.Middle(Given, 1, 1) = ":")',
    'or Text.StartsWith(Slashed, "//") or Text.StartsWith(Lowered, "file:"),',
    'IsShared = IsUrl and Text.Contains(Text.BeforeDelimiter(Given, "?"), "/:"),',
    'Origin = (url as text) as text => Text.BeforeDelimiter(url, "/", 2),',
    'Address = Text.BeforeDelimiter(url, "?"),',
    'Query = if Text.Contains(url, "?") then try Uri.Parts(url)[Query] otherwise [] else [],',
    'Viewed = Record.FieldOrDefault(Query, "id", Record.FieldOrDefault(Query, "RootFolder", null)),',
    'At = Text.PositionOf(Text.Lower(Address), "/forms/", Occurrence.Last)',
    'if Viewed <> null then Origin(url) & Viewed',
    'else if At >= 0 and Text.EndsWith(Text.Lower(Address), ".aspx") then Text.Start(Address, At)',
    'else Address,',
    'if IsUrl then FromUrl(Given)',
    'else if Text.StartsWith(Slashed, "/") then Origin(Site) & Slashed',
    'else Site & "/" & Slashed,',
    'SiteKey = Key(Site),',
    'FolderPlain = Plain(Folder),',
    'FolderKey = Text.Lower(FolderPlain),',
)
# The checks, in the order the forms make them.
PROBLEM_PINS = (
    'if IsLocal then',
    'else if IsShared then',
    'else if Site = "" then',
    'else if not Text.StartsWith(FolderKey, SiteKey) then',
    'else null,',
)
FINAL_PIN = 'if Given = "" then null else if Problem <> null then error Problem else Files'
STEPS_PIN = 'Steps = List.Select(Text.Split(Text.Middle(FolderPlain, Text.Length(SiteKey)), "/"), each _ <> ""),'
FILES_FORM_PINS = (
    'FolderDepth = Segments(FolderKey),',
    'Listing = SharePoint.Files(Site, [ApiVersion = 15]),',
    'Inside = Table.SelectRows(Listing, each Text.StartsWith(Key([#"Folder Path"]), FolderKey)),',
    'Files = Table.AddColumn(Kept, "Depth", each Segments(Key([#"Folder Path"])) - FolderDepth, Int64.Type)',
)
LOCAL_FORM_PINS = (
    'Root = if DataFolder = null then "" else Text.Trim(Text.From(DataFolder)),',
    'List.Count(List.Select(Text.SplitAny(path, "/\\"), each _ <> ""))',
    'RootDepth = Segments(Root),',
    'Listing = if Root = "" then null else Folder.Files(Root),',
    'each Segments([#"Folder Path"]) - RootDepth, Int64.Type)',
)
OLD_DEPTH_PINS = (
    'else Text.From(DataFolder),',
    'each List.Count(Text.Split(Text.Trim([#"Folder Path"], "\\"), "\\"))',
    '- List.Count(Text.Split(Text.Trim(Root, "\\"), "\\")),',
)
SITE, FOLDER = check.SITE, check.FOLDER
LIBRARY_VIEW = SITE + "/Shared%20Documents/Forms/AllItems.aspx"
VIEWED = "%2Fsites%2FConsumptionCentral%2FShared%20Documents%2FConsumption%20Central"
FOLDER_KEY = "https://contoso.sharepoint.com/sites/consumptioncentral/shared documents/consumption central/"


class Refused(Exception):
    """An address the SharePoint forms stop at before listing anything; kind names the check."""

    def __init__(self, kind):
        super().__init__(kind)
        self.kind = kind


def before(text, delimiter, index=0):
    """Text.BeforeDelimiter: the text before the index-th delimiter, counting from 0, or all of it."""
    at = -1
    for _ in range(index + 1):
        at = text.find(delimiter, at + 1)
        if at < 0:
            return text
    return text[:at]


def decode(path):
    return unquote(path) if "%" in path else path


def plain(path):
    return decode(path).replace("\\", "/").rstrip("/") + "/"


def key(path):
    return plain(path).lower()


def url_segments(path):
    return len([piece for piece in path.split("/") if piece])


def origin(url):
    return before(url, "/", 2)


def from_url(url):
    address = before(url, "?")
    query = {name: values[0] for name, values in parse_qs(url.partition("?")[2], keep_blank_values=True).items()}
    viewed = query.get("id", query.get("RootFolder"))
    at = address.lower().rfind("/forms/")
    if viewed is not None:
        return origin(url) + viewed
    if at >= 0 and address.lower().endswith(".aspx"):
        return address[:at]
    return address


def resolve(data_folder, site_url):
    """The shared resolve steps: None for a blank DataFolder, else the folder's Plain and Key and
    the site's Key. Raises Refused where the forms raise their Problem."""
    site = "" if site_url is None else before(site_url.strip(), "?").rstrip("/\\")
    given = "" if data_folder is None else data_folder.strip()
    slashed, lowered = given.replace("\\", "/"), given.lower()
    is_url = lowered.startswith(("https://", "http://"))
    is_local = (len(given) > 1 and given[1] == ":") or slashed.startswith("//") or lowered.startswith("file:")
    is_shared = is_url and "/:" in before(given, "?")
    if is_url:
        folder = from_url(given)
    elif slashed.startswith("/"):
        folder = origin(site) + slashed
    else:
        folder = site + "/" + slashed
    site_key, folder_plain = key(site), plain(folder)
    folder_key = folder_plain.lower()
    if given == "":
        return None
    for kind, refused in (("local", is_local), ("shared", is_shared), ("site", site == ""),
                          ("outside", not folder_key.startswith(site_key))):
        if refused:
            raise Refused(kind)
    return {"plain": folder_plain, "key": folder_key, "site_key": site_key}


def old_depth(folder_path, root):
    """The old DataFiles: Text.Split on \\ only."""
    return len(folder_path.strip("\\").split("\\")) - len(root.strip("\\").split("\\"))


def local_depth(folder_path, root):
    """SourceFiles.m: either separator."""
    def segments(path):
        return len([piece for piece in re.split(r"[/\\]", path) if piece])
    return segments(folder_path) - segments(root.strip())


def sharepoint_depth(folder_path, data_folder, site_url):
    """SourceFiles.SharePoint.m: None for a file outside the folder, which Inside drops."""
    folder_key = resolve(data_folder, site_url)["key"]
    if not key(folder_path).startswith(folder_key):
        return None
    return url_segments(key(folder_path)) - url_segments(folder_key)


class DepthReplay(unittest.TestCase):
    """Depth 0 is the folder DataFolder names, so GetDataFile prefers its copy of a file."""

    def test_the_replay_follows_the_queries(self):
        files_form = F.SHAREPOINT_FORMS[0]
        for label, text, lines in (("old DataFiles", F.DATA_FILES_BEFORE, OLD_DEPTH_PINS),
                                   ("SourceFiles", F.SOURCE_FILES_M, LOCAL_FORM_PINS),
                                   (files_form.name, F.source(files_form), FILES_FORM_PINS)):
            for line in lines:
                with self.subTest(query=label, line=line):
                    self.assertIn(line, text)

    def test_a_local_folder_named_with_either_separator(self):
        cases = (
            ("C:\\Data\\Consumption Central", "\\", (0, 1), (0, 1)),
            ("C:/Data/Consumption Central", "\\", (2, 3), (0, 1)),
            ("C:/Data/Consumption Central", "/", (0, 0), (0, 1)),
            ("C:\\Data\\Consumption Central\\", "\\", (0, 1), (0, 1)),
            ("\\\\server\\share\\Consumption Central", "\\", (0, 1), (0, 1)),
        )
        for root, separator, old, new in cases:
            with self.subTest(root=root, listed_with=separator):
                base = root.rstrip("/\\").translate(str.maketrans("/\\", separator * 2))
                listing = (base + separator, base + separator + "Archive" + separator)
                self.assertEqual(tuple(old_depth(path, root) for path in listing), old)
                self.assertEqual(tuple(local_depth(path, root) for path in listing), new)

    def test_a_sharepoint_folder(self):
        top = SITE + "/Shared Documents/Consumption Central/"
        listing = (top, top + "Archive/")
        self.assertEqual(tuple(old_depth(path, FOLDER) for path in listing), (0, 0))
        self.assertEqual(tuple(sharepoint_depth(path, FOLDER, SITE) for path in listing), (0, 1))
        self.assertIsNone(sharepoint_depth(SITE + "/Shared Documents/Consumption Central Old/", FOLDER, SITE))
        self.assertEqual(sharepoint_depth(SITE.upper() + "/SHARED DOCUMENTS/Consumption Central/Archive/",
                                          FOLDER, SITE), 1)


class AddressReplay(unittest.TestCase):
    def test_the_replay_follows_both_forms(self):
        for form in F.SHAREPOINT_FORMS:
            text = F.source(form)
            steps = check.resolve_steps(text, form.name)
            for line in RESOLVE_PINS:
                with self.subTest(form=form.name, line=line):
                    self.assertIn(line, steps)
            with self.subTest(form=form.name, line="the checks' order"):
                at = [steps.find(line) for line in PROBLEM_PINS]
                self.assertNotIn(-1, at)
                self.assertEqual(at, sorted(at))
                self.assertTrue(text.endswith(FINAL_PIN))
        self.assertIn(STEPS_PIN, F.source(F.SHAREPOINT_FORMS[1]))

    def test_each_way_of_naming_the_folder_finds_the_same_folder(self):
        cases = (
            (FOLDER, SITE),
            (SITE + "/Shared Documents/Consumption Central/", SITE),
            (LIBRARY_VIEW + "?id=" + VIEWED + "&viewid=6f2c0c8e-0000-4000-8000-000000000001", SITE),
            (LIBRARY_VIEW + "?RootFolder=" + VIEWED + "&FolderCTID=0x0120", SITE),
            ("/sites/ConsumptionCentral/Shared Documents/Consumption Central", SITE),
            ("Shared Documents/Consumption Central", SITE),
            ("Shared Documents\\Consumption Central\\", SITE),
            (FOLDER, SITE + "/?web=1"),
            (FOLDER.replace("contoso", "CONTOSO"), SITE),
            (FOLDER + "?web=1", SITE),
            ("  " + FOLDER + "  ", "  " + SITE + "/  "),
        )
        for data_folder, site_url in cases:
            with self.subTest(data_folder=data_folder, site_url=site_url):
                self.assertEqual(resolve(data_folder, site_url)["key"], FOLDER_KEY)
        self.assertEqual(resolve(LIBRARY_VIEW, SITE)["key"], SITE.lower() + "/shared documents/")

    def test_addresses_the_forms_stop_at_before_listing_anything(self):
        cases = (
            ("C:\\Data\\Consumption Central", SITE, "local"),
            ("\\\\server\\share\\Consumption Central", SITE, "local"),
            ("file:///C:/Data/Consumption%20Central", SITE, "local"),
            ("C:\\Data", None, "local"),
            ("https://contoso.sharepoint.com/:f:/s/ConsumptionCentral/EabcDEF123?e=AbC123", SITE, "shared"),
            ("https://contoso.sharepoint.com/:f:/s/ConsumptionCentral/EabcDEF123", None, "shared"),
            (FOLDER, "", "site"),
            (FOLDER, None, "site"),
            (FOLDER, "  ", "site"),
            ("https://contoso.sharepoint.com/sites/ConsumptionCentralArchive/Shared Documents", SITE, "outside"),
            ("/Shared Documents/Consumption Central", SITE, "outside"),
        )
        for data_folder, site_url, kind in cases:
            with self.subTest(data_folder=data_folder, site_url=site_url):
                with self.assertRaises(Refused) as caught:
                    resolve(data_folder, site_url)
                self.assertEqual(caught.exception.kind, kind)

    def test_a_blank_data_folder_lists_nothing(self):
        for data_folder in (None, "", "   "):
            for site_url in (SITE, None):
                with self.subTest(data_folder=data_folder, site_url=site_url):
                    self.assertIsNone(resolve(data_folder, site_url))

    def test_the_contents_form_opens_the_library_then_each_folder(self):
        resolved = resolve(FOLDER, SITE)
        steps = [piece for piece in resolved["plain"][len(resolved["site_key"]):].split("/") if piece]
        self.assertEqual(steps, ["Shared Documents", "Consumption Central"])


GET_DATA_FILE_PINS = (
    'Table.SelectRows(DataFiles, each Text.Contains([MatchKey], p)),',
    '{{"Depth", Order.Ascending}, {"Date modified", Order.Descending}}),',
    'List.Select(List.Transform(patterns, Ranked),',
    'each Table.RowCount(_) > 0),',
    'if Hit = null then null else Hit{0}[Content]',
)
DATA_FILES_PINS = (
    'Raw = try SourceFiles otherwise null,',
    'else Table.SelectRows(Raw, each Text.Lower([Extension]) = ".csv"),',
    'each Text.Lower(Text.Remove([Name], {" ", "_", "-"})), type text)',
)


def match_key(name):
    """DataFiles' MatchKey, which is also OrgNormalised's Key."""
    return re.sub(r"[ _-]", "", name).lower()


def get_data_file(files, patterns):
    """GetDataFile over DataFiles. files are (name, depth, modified); the first pattern any CSV's
    name holds wins, then the shallowest copy, then the newest. Returns that file, or None."""
    csvs = [file for file in files if Path(file[0]).suffix.lower() == ".csv"]
    for pattern in patterns:
        ranked = sorted((file for file in csvs if pattern in match_key(file[0])),
                        key=lambda file: (file[1], -file[2]))
        if ranked:
            if len(ranked) > 1 and ranked[0][1:] == ranked[1][1:]:
                raise AssertionError(f"{ranked[0]} ties with {ranked[1]}, and Table.Sort keeps no order")
            return ranked[0]
    return None


class GetDataFileReplay(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.texts = expressions(parts(RAW)[0])
        found = re.search(r"GetDataFile\(\{([^{}]*)\}\)", cls.texts["EntraOrgSource"])
        cls.patterns = re.findall(r'"([^"]*)"', found.group(1)) if found else []

    def test_the_replay_follows_the_template(self):
        self.assertEqual(self.patterns, ["entra", "orgdata", "exportusers", "users"])
        for name, lines in (("GetDataFile", GET_DATA_FILE_PINS), ("DataFiles", DATA_FILES_PINS)):
            for line in lines:
                with self.subTest(query=name, line=line):
                    self.assertIn(line, self.texts[name])

    def test_paxs_file_names_are_found(self):
        for name in ("entra_org.csv", "EntraUsers_MAClicensing_20260910_120000.csv", "Entra Org.CSV"):
            with self.subTest(name=name):
                self.assertEqual(get_data_file([(name, 0, 1)], self.patterns), (name, 0, 1))
        self.assertIsNone(get_data_file([("entra_org.xlsx", 0, 1)], self.patterns))

    def test_no_other_sample_file_is_taken_for_the_org_file(self):
        names = sorted(path.name for path in (F.REPO / "1. Local CSV" / "sample-data").rglob("*.csv"))
        self.assertIn("entra_org.csv", names)
        for name in names:
            with self.subTest(name=name):
                found = get_data_file([(name, 0, 1)], self.patterns)
                self.assertEqual(found, (name, 0, 1) if name == "entra_org.csv" else None)
        files = [(name, 0, modified) for modified, name in enumerate(names)]
        self.assertEqual(get_data_file(files, self.patterns)[0], "entra_org.csv")

    def test_the_first_pattern_wins_then_the_top_folder_then_the_newest(self):
        newer_users = [("entra_org.csv", 0, 1), ("users.csv", 0, 2)]
        self.assertEqual(get_data_file(newer_users, self.patterns), ("entra_org.csv", 0, 1))
        newer_below = [("entra_org.csv", 0, 1), ("entra_org.csv", 1, 2)]
        self.assertEqual(get_data_file(newer_below, self.patterns), ("entra_org.csv", 0, 1))
        both_on_top = [("entra_org.csv", 0, 1), ("EntraUsers_MAClicensing_20260910_120000.csv", 0, 2)]
        self.assertEqual(get_data_file(both_on_top, self.patterns)[0], "EntraUsers_MAClicensing_20260910_120000.csv")

    def test_on_sharepoint_the_old_depth_let_a_newer_copy_below_win(self):
        top = SITE + "/Shared Documents/Consumption Central/"
        listing = (("entra_org.csv", top, 1), ("entra_org.csv", top + "Archive/", 2))
        old = [(name, old_depth(path, FOLDER), modified) for name, path, modified in listing]
        new = [(name, sharepoint_depth(path, FOLDER, SITE), modified) for name, path, modified in listing]
        self.assertEqual(get_data_file(old, self.patterns), ("entra_org.csv", 0, 2))
        self.assertEqual(get_data_file(new, self.patterns), ("entra_org.csv", 0, 1))

    def test_a_newer_csv_named_for_consumption_central_is_taken_for_the_org_file(self):
        """The caveat the README gives: "central" holds "entra"."""
        files = [("entra_org.csv", 0, 1), ("Consumption Central notes.csv", 0, 2)]
        self.assertEqual(get_data_file(files, self.patterns), ("Consumption Central notes.csv", 0, 2))


# OrgNormalised's Normalise and the Group By rule in Org Attribute Source, ported below.
NORMALISE_PINS = (
    'Key = (n as text) as text => Text.Lower(Text.Remove(n, {" ", "_", "-"})),',
    'if v = null then null else let t = Text.Trim(Text.From(v)) in if t = "" then null else t,',
    'let t = Clean(v) in if t = null then null else Text.Lower(t),',
    'Expected = {"UserPrincipalName"} & Canonical,',
    'List.Combine(List.Transform(aliases, (a) => List.Select(columns, each Key(_) = a))),',
    'List.Distinct(List.RemoveNulls(List.Transform(columns, each Identity(Record.Field(row, _))))),',
    'else if List.IsEmpty(Matches) then List.First(ids, null)',
    'List.Select(Copies, (pair) => List.Contains(PresentKeys, pair{1})), each _{0})),',
    'IdentityColumns = List.Buffer(ColumnsFor(Present, IdAliases)),',
    'not List.Contains(NotOrg, Key(_)) and not List.Contains(Known, Key(_))',
    'and not List.Contains(Surplus, Key(_)))),',
    'Keep = List.Buffer(Expected & Extras),',
    '(if List.Contains(Present, spec{0}) then {spec{0}} else {})',
    '& ColumnsFor(Present, spec{1}))))),',
    '{Resolve(Ids(row, IdentityColumns))}',
    'List.Transform(columns, each Clean(Record.Field(row, _)))), null))',
    '& List.Transform(Extras, each Clean(Record.Field(row, _))),',
    'Real = Table.SelectRows(Named, each [UserPrincipalName] <> null),',
    '{c, each List.First(List.RemoveNulls(Table.Column(_, c)), null), type nullable text})))',
    'if e <> null and e <> "" then e else v), AllCols)),',
)
ATTRIBUTE_PINS = (
    'Attrs = List.RemoveItems(Table.ColumnNames(Base), {"UserPrincipalName"}),',
    'v = null or Text.Trim(Text.From(v)) = "",',
    'MinShare = 0.05,',
    'Total > 0 and Covered(c) / Total >= MinShare),',
    'then List.Select(Attrs, (c) => Covered(c) > 0)',
)
PAX_COLUMNS = [
    "userPrincipalName", "displayName", "id", "mail", "givenName", "surname",
    "jobTitle", "department", "employeeType", "employeeId", "employeeHireDate",
    "officeLocation", "city", "state", "country", "postalCode", "companyName",
    "employeeOrgData_division", "employeeOrgData_costCenter",
    "accountEnabled", "userType", "createdDateTime", "usageLocation", "preferredLanguage",
    "onPremisesSyncEnabled", "onPremisesImmutableId", "externalUserState",
    "proxyAddresses_Primary", "proxyAddresses_Count", "proxyAddresses_All",
    "manager_id", "manager_displayName", "manager_userPrincipalName", "manager_mail", "manager_jobTitle",
    "ManagerID", "BusinessAreaLabel", "CountryofEmployment", "CompanyCodeLabel", "CostCentreLabel", "UserName",
    "EffectiveDate", "FunctionType", "BusinessAreaCode", "OrgLevel_3Label",
    "assignedLicenses", "hasLicense",
]
# PAX's AI-in-One columns: each copy and the column PAX fills it from. The other four are always empty.
PAX_COPIES = {
    "ManagerID": "manager_id", "BusinessAreaLabel": "employeeOrgData_division",
    "CountryofEmployment": "country", "CompanyCodeLabel": "companyName",
    "CostCentreLabel": "employeeOrgData_costCenter", "UserName": "displayName",
}
PAX_ALWAYS_EMPTY = ("EffectiveDate", "FunctionType", "BusinessAreaCode", "OrgLevel_3Label")
CANONICAL = ["DisplayName", "Department", "Organisation", "JobTitle", "JobFamily",
             "City", "Country", "CostCenter", "Manager", "BusinessUnit"]
PAX_EXTRAS = ["employeeType", "state", "userType", "usageLocation", "preferredLanguage", "manager_jobTitle",
              "EffectiveDate", "BusinessAreaCode", "OrgLevel_3Label", "hasLicense"]
# Group Bys when PAX's aliases first shipped; they describe the directory entry, not the organisation.
PAX_DROPPED = ["postalCode", "accountEnabled", "onPremisesSyncEnabled", "externalUserState"]


def read_fixture():
    with FIXTURE.open(encoding="utf-8-sig", newline="") as handle:
        header, *rows = csv.reader(handle)
    return header, rows


def braces(text, opener):
    """What the braces straight after opener hold, or None without opener."""
    found = re.search(opener, text)
    if found is None:
        return None
    depth, start = 0, found.end() - 1
    for at in range(start, len(text)):
        depth += {"{": 1, "}": -1}.get(text[at], 0)
        if depth == 0:
            return text[start + 1:at]
    raise AssertionError(f"unbalanced braces after {opener}")


def org_rules(m):
    """OrgNormalised's alias rules, read from its code: its comments hold braces too."""
    code = check.code(m, strings=True)
    ids = re.findall(r'"(\w+)"', braces(code, r"(?<!\w)IdAliases = \{"))
    aliases = [(name, re.findall(r'"(\w+)"', names)) for name, names in
               re.findall(r'\{\s*"(\w+)"\s*,\s*\{([^{}]*)\}\s*\}', braces(code, r"(?<!\w)Aliases = \{"))]
    return {
        "ids": ids,
        "not_org": ids + re.findall(r'"(\w+)"', braces(code, r"(?<!\w)NotOrg = IdAliases & \{")),
        "aliases": aliases,
        "copies": re.findall(r'\{\s*"(\w+)"\s*,\s*"(\w+)"\s*\}', braces(code, r"(?<!\w)Copies = \{") or ""),
    }


def clean(value):
    value = None if value is None else value.strip()
    return value or None


def normalise(header, rows, rules):
    """Normalise for an org file on its own. With no consumption data the crosswalk is empty, so
    each row's key is its first identifier, lower-cased. Rows sharing a key take each column's
    first value."""
    keys = [match_key(column) for column in header]

    def columns_for(aliases):
        return [column for alias in aliases for column in header if match_key(column) == alias]

    surplus = [copy for copy, original in rules["copies"] if original in keys]
    known = [alias for _, names in rules["aliases"] for alias in names]
    identity = columns_for(rules["ids"])
    extras = [column for column in header if match_key(column) not in rules["not_org"]
              and match_key(column) not in known and match_key(column) not in surplus]
    keep = ["UserPrincipalName"] + [name for name, _ in rules["aliases"]] + extras
    bindings = {name: list(dict.fromkeys(([name] if name in header else []) + columns_for(aliases)))
                for name, aliases in rules["aliases"]}
    people = {}
    for row in rows:
        record = dict(zip(header, row))
        ids = list(dict.fromkeys(value.lower() for value in (clean(record[c]) for c in identity) if value))
        if not ids:
            continue
        values = {name: next((value for value in (clean(record[c]) for c in columns) if value), None)
                  for name, columns in bindings.items()}
        values.update((column, clean(record[column])) for column in extras)
        person = people.setdefault(ids[0], dict.fromkeys(keep[1:]))
        for column, value in values.items():
            if person[column] is None:
                person[column] = value
    return {"identity": identity, "extras": extras, "keep": keep, "bindings": bindings, "people": people}


def group_by(keep, people):
    """Org Attribute Source's attributes: those at least 5% of people have, else any anyone has."""
    def covered(column):
        return sum(1 for person in people.values() if person[column] is not None)
    attributes = keep[1:]
    useful = [c for c in attributes if people and covered(c) / len(people) >= 0.05]
    return useful or [c for c in attributes if covered(c) > 0]


class PaxReplay(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.header, cls.rows = read_fixture()
        cls.new = org_rules(F.ORG_NORMALISED_M)
        cls.old = org_rules(pre_pax(F.ORG_NORMALISED_M))
        cls.normalised = normalise(cls.header, cls.rows, cls.new)
        cls.before = normalise(cls.header, cls.rows, cls.old)

    def test_the_replay_follows_the_template(self):
        model = parts(RAW)[0]
        attribute_source = check.m_sources(model)["Org Attribute Source (partition)"]
        for label, text, lines in (("OrgNormalised", F.ORG_NORMALISED_M, NORMALISE_PINS),
                                   ("Org Attribute Source", attribute_source, ATTRIBUTE_PINS)):
            for line in lines:
                with self.subTest(query=label, line=line):
                    self.assertIn(line, text)

    def test_the_rules_paxs_columns_meet(self):
        new, old = self.new, self.old
        self.assertEqual((len(new["ids"]), len(new["not_org"]), len(new["copies"])), (17, 54, 5))
        self.assertEqual(new["not_org"][-4:], [match_key(column) for column in PAX_DROPPED])
        self.assertEqual((len(old["ids"]), len(old["not_org"]), len(old["copies"])), (17, 38, 0))
        self.assertEqual([name for name, _ in new["aliases"]], CANONICAL)
        self.assertEqual({name: len(aliases) for name, aliases in new["aliases"]}, {
            "DisplayName": 4, "Department": 2, "Organisation": 2, "JobTitle": 3, "JobFamily": 4,
            "City": 3, "Country": 3, "CostCenter": 3, "Manager": 7, "BusinessUnit": 6})
        aliases = dict(new["aliases"])
        self.assertIn("employeeorgdatacostcenter", aliases["CostCenter"])
        manager, unit = aliases["Manager"], aliases["BusinessUnit"]
        self.assertLess(manager.index("managerdisplayname"), manager.index("managerid"))
        self.assertLess(unit.index("employeeorgdatadivision"), unit.index("companyname"))
        old_aliases = dict(old["aliases"])
        self.assertEqual(old_aliases["CostCenter"], ["costcenter", "costcentre"])
        self.assertEqual(len(old_aliases["Manager"]), 6)
        self.assertEqual(len(old_aliases["BusinessUnit"]), 5)

    def test_paxs_columns_bind_to_the_org_attributes(self):
        normalised = self.normalised
        self.assertEqual(normalised["identity"], ["userPrincipalName", "mail"])
        self.assertEqual(normalised["extras"], PAX_EXTRAS)
        self.assertEqual(normalised["keep"], ["UserPrincipalName"] + CANONICAL + PAX_EXTRAS)
        self.assertEqual(len(normalised["keep"]), 21)
        self.assertEqual(normalised["bindings"], {
            "DisplayName": ["displayName"], "Department": ["department"], "Organisation": [],
            "JobTitle": ["jobTitle"], "JobFamily": ["FunctionType"], "City": ["city", "officeLocation"],
            "Country": ["country"], "CostCenter": ["employeeOrgData_costCenter"],
            "Manager": ["manager_displayName", "manager_id", "ManagerID", "manager_userPrincipalName"],
            "BusinessUnit": ["employeeOrgData_division", "companyName"]})

    def test_ids_per_person_values_and_copies_stay_out_of_group_by(self):
        self.assertEqual(group_by(self.normalised["keep"], self.normalised["people"]), [
            "DisplayName", "Department", "JobTitle", "City", "Country", "CostCenter", "Manager", "BusinessUnit",
            "employeeType", "state", "userType", "usageLocation", "preferredLanguage", "manager_jobTitle",
            "hasLicense"])
        before = self.before
        self.assertEqual(len(before["extras"]), 34)
        self.assertEqual(len(before["keep"]), 45)
        attributes = group_by(before["keep"], before["people"])
        self.assertEqual(len(attributes), 38)
        self.assertEqual([c for c in attributes if c in CANONICAL],
                         ["DisplayName", "Department", "JobTitle", "City", "Country", "Manager", "BusinessUnit"])

    def test_postal_code_and_account_flags_are_no_longer_group_bys(self):
        first = normalise(self.header, self.rows, org_rules(pax_first_shipped(F.ORG_NORMALISED_M)))
        offered = group_by(first["keep"], first["people"])
        self.assertEqual([c for c in offered if c in PAX_DROPPED], PAX_DROPPED)
        self.assertEqual([c for c in offered if c not in PAX_DROPPED],
                         group_by(self.normalised["keep"], self.normalised["people"]))
        for column in PAX_DROPPED:
            with self.subTest(column=column):
                self.assertIn(column, self.header)
                self.assertNotIn(column, self.normalised["keep"])

    def test_each_person_from_paxs_export(self):
        people = self.normalised["people"]
        self.assertEqual(list(people), [
            "avery.lane@example.com", "blake.rivera@example.com", "casey.morgan@example.com",
            "drew.patel@example.com", "emery.chen@example.com", "finley.brooks_partner.example#ext#@example.com"])
        self.assertEqual(people["avery.lane@example.com"], {
            "DisplayName": "Avery Lane", "Department": "Finance", "Organisation": None,
            "JobTitle": "Finance Analyst", "JobFamily": None, "City": "Dublin", "Country": "Ireland",
            "CostCenter": "CC-100", "Manager": "Emery Chen", "BusinessUnit": "Corporate Services",
            "employeeType": "Employee", "state": "Leinster", "userType": "Member", "usageLocation": "IE",
            "preferredLanguage": "en-IE", "manager_jobTitle": "Chief Executive",
            "EffectiveDate": None, "BusinessAreaCode": None, "OrgLevel_3Label": None, "hasLicense": "True"})
        expected = {
            "blake.rivera@example.com": {"BusinessUnit": "Contoso Sales Ltd", "Manager": "Drew Patel",
                                         "CostCenter": "CC-200", "City": "Manchester", "state": None},
            "casey.morgan@example.com": {"BusinessUnit": "Field Sales", "CostCenter": "CC-210",
                                         "employeeType": "Contractor", "preferredLanguage": None},
            "drew.patel@example.com": {"City": "London", "Manager": "Emery Chen"},
            "emery.chen@example.com": {"Manager": None, "BusinessUnit": "Executive Office", "CostCenter": "CC-001"},
            "finley.brooks_partner.example#ext#@example.com": {
                "DisplayName": "Finley Brooks", "userType": "Guest",
                "Department": None, "City": None, "BusinessUnit": None, "Manager": None, "hasLicense": "False"},
        }
        for upn, values in expected.items():
            with self.subTest(person=upn):
                self.assertEqual({column: people[upn][column] for column in values}, values)
        avery = self.before["people"]["avery.lane@example.com"]
        self.assertEqual((avery["Manager"], avery["CostCenter"], avery["BusinessUnit"]),
                         ("00000000-0000-4000-8000-000000000005", None, "Contoso Ltd"))

    def test_a_copy_without_its_original_is_kept(self):
        header = ["userPrincipalName", "UserName", "BusinessAreaLabel", "CompanyCodeLabel",
                  "CostCentreLabel", "CountryofEmployment"]
        self.assertEqual(normalise(header, [], self.new)["extras"], header[1:])
        header = ["userPrincipalName", "displayName", "UserName", "BusinessAreaLabel"]
        self.assertEqual(normalise(header, [], self.new)["extras"], ["BusinessAreaLabel"])


class Fixture(unittest.TestCase):
    def test_the_columns_are_paxs(self):
        header, rows = read_fixture()
        self.assertEqual(header, PAX_COLUMNS)
        self.assertEqual(len(rows), 6)
        for row in rows:
            self.assertEqual(len(row), len(PAX_COLUMNS))

    def test_the_people_are_fictional(self):
        text = FIXTURE.read_text(encoding="utf-8-sig")
        addresses = re.findall(r"[\w.#+-]+@[\w.-]+", text)
        self.assertTrue(addresses)
        for address in addresses:
            self.assertTrue(address.endswith("@example.com"), address)
        self.assertIsNone(re.search(r"@(microsoft|[a-zA-Z0-9]+\.onmicrosoft)\.com", text))

    def test_the_copies_repeat_their_originals_as_pax_writes_them(self):
        header, rows = read_fixture()
        for row in rows:
            record = dict(zip(header, row))
            with self.subTest(person=record["userPrincipalName"]):
                for copy_name, original in PAX_COPIES.items():
                    self.assertEqual(record[copy_name], record[original])
                for name in PAX_ALWAYS_EMPTY:
                    self.assertEqual(record[name], "")

    def test_orgnormalised_pairs_each_copy_with_its_original(self):
        """ManagerID needs no pair: it and manager_id are both Manager aliases."""
        rules = org_rules(F.ORG_NORMALISED_M)
        self.assertEqual(sorted(rules["copies"]), sorted(
            (match_key(copy_name), match_key(original)) for copy_name, original in PAX_COPIES.items()
            if copy_name != "ManagerID"))
        manager = dict(rules["aliases"])["Manager"]
        self.assertIn(match_key("ManagerID"), manager)
        self.assertIn(match_key("manager_id"), manager)


if __name__ == "__main__":
    unittest.main(verbosity=2)
