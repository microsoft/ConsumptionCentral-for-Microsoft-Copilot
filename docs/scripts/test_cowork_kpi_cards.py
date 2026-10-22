"""Regression tests for docs/scripts/fix_cowork_kpi_cards.py.

    python docs/scripts/test_cowork_kpi_cards.py
"""
import json
import re
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fix_cowork_kpi_cards as F  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
FABRIC = ROOT / "2. Fabric" / "Consumption Central - Fabric.pbit"
BRANCH = re.compile(r'^\s*"(\d)",\s*(.+?),\s*$')

ACTION_VALUE = F.lines("""
VAR Rate = [Cowork PAYG Rate Value]
RETURN
SUMX(
    'CoworkBilling',
    VAR Act   = 'CoworkBilling'[Seat Action]
    VAR Limit = 'CoworkBilling'[MonthlyCreditLimit]
    VAR Delta = 'CoworkBilling'[Seat Delta]
    RETURN
        SWITCH(
            LEFT( Act, 1 ),
            "1", Limit * Rate,
            "2", Limit * Rate,
            "3", MAX( 0, Delta ) * Rate,
            "6", -MAX( 0, -Delta ) * Rate,
            0
        )
)
""")


def branches(expression):
    found = {}
    for line in F._as_lines(expression):
        match = BRANCH.match(line)
        if match:
            found[match.group(1)] = match.group(2)
    return found


def model():
    def measure(name, expression="1"):
        return {"name": name, "expression": expression}
    return {"model": {"tables": [
        {"name": F.BILLING,
         "columns": [{"name": c} for c in ("Seat Action", "Seat Delta",
                                          "MonthlyCreditLimit", "UserPrincipalName")],
         "measures": [measure("Action Value /mo", ACTION_VALUE),
                      measure("Right-Size Net $", "[Action Value /mo]"),
                      measure("Consuming Users"), measure("User Count"),
                      measure("Licensed but Inactive")]},
        {"name": F.WEEKLY, "columns": [], "measures": [measure("Weekly Active Users")]},
        {"name": F.PERIOD_TABLE, "columns": [],
         "partitions": [{"source": {"type": "calculated", "expression": "old"}}]},
    ]}}


def tile(entity, prop):
    return {"field": F.measure_ref(entity, prop), "queryRef": f"{entity}.{prop}"}


def card(projections):
    return {"name": "x", "visual": {
        "visualType": "cardVisual",
        "query": {"queryState": {"Data": {"projections": projections}}},
        "objects": {"layout": [{"properties": {"columnCount": F.literal("7L")}},
                               {"properties": {}, "selector": {"id": "default"}}]}}}


def slicer():
    return {"name": "s", "visual": {
        "visualType": "slicer",
        "query": {"queryState": {"Values": {"projections": [
            {"queryRef": f"{F.PERIOD_TABLE}.Period"}]}}},
        "objects": {"selection": [{"properties": {
            "singleSelect": F.literal("false")}}]}}}


def project(root):
    (root / "x.SemanticModel").mkdir()
    (root / "x.SemanticModel" / "model.bim").write_text(json.dumps(model()), encoding="utf-8")
    definition = root / "x.Report" / "definition"
    documents = {(F.EXEC_PAGE, F.EXEC_CARD): card([tile(F.WEEKLY, "Weekly Active Users"),
                                                  tile(F.BILLING, "Consuming Users")]),
                 (F.OPT_PAGE, F.OPT_CARD): card([tile(F.BILLING, "Reclaimable $"),
                                                tile(F.BILLING, "Licensed but Inactive")])}
    documents.update({s: slicer() for s in F.PERIOD_SLICERS})
    for (page, name), document in documents.items():
        path = F._visual_path(definition, page, name)
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps(document), encoding="utf-8")
    return definition


def read(definition, page, name):
    return json.loads(F._visual_path(definition, page, name).read_text(encoding="utf-8"))


class PatchProject(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.definition = project(self.root)
        self.changes = F.patch_project(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def test_idempotent(self):
        self.assertTrue(self.changes)
        self.assertEqual(F.patch_project(self.root), [])

    def test_model(self):
        bim = json.loads((self.root / "x.SemanticModel" / "model.bim").read_text(encoding="utf-8"))
        tables = {t["name"]: t for t in bim["model"]["tables"]}
        measures = {m["name"]: m for m in tables[F.BILLING]["measures"]}
        for name in F.NEW_MEASURES:
            self.assertIn(name, measures)
        tags = [m["lineageTag"] for m in measures.values() if "lineageTag" in m]
        self.assertEqual(len(tags), len(set(tags)))
        self.assertIn("Weekly Active Users",
                      {m["name"] for m in tables[F.WEEKLY]["measures"]})
        self.assertIn('"Current period (4 weeks)"', "\n".join(
            tables[F.PERIOD_TABLE]["partitions"][0]["source"]["expression"]))

    def test_exec_card(self):
        refs = [p["queryRef"] for p in read(self.definition, F.EXEC_PAGE, F.EXEC_CARD)
                ["visual"]["query"]["queryState"]["Data"]["projections"]]
        self.assertEqual(refs, [f"{F.BILLING}.Avg Weekly Active Users",
                                f"{F.BILLING}.Consuming Users"])

    def test_opt_card(self):
        visual = read(self.definition, F.OPT_PAGE, F.OPT_CARD)["visual"]
        refs = [p["queryRef"] for p in visual["query"]["queryState"]["Data"]["projections"]]
        self.assertEqual(refs, [f"{F.BILLING}.{v}" for v, _, _ in F.OPT_TILES])
        labels = visual["objects"]["referenceLabel"]
        self.assertEqual([l["selector"]["metadata"] for l in labels], refs)
        self.assertEqual([l["properties"]["value"]["expr"]["Measure"]["Property"]
                          for l in labels], [c for _, _, c in F.OPT_TILES])
        ids = [l["selector"]["id"] for l in labels]
        self.assertEqual(len(ids), len(set(ids)))
        layout = visual["objects"]["layout"][0]["properties"]
        self.assertEqual(layout["columnCount"], F.literal("4L"))

    def test_slicers(self):
        for page, name in F.PERIOD_SLICERS:
            objects = read(self.definition, page, name)["visual"]["objects"]
            props = objects["selection"][0]["properties"]
            self.assertEqual(props["singleSelect"], F.literal("true"))
            self.assertEqual(props["strictSingleSelect"], F.literal("true"))
            self.assertEqual(objects["general"][0]["properties"]["filter"], F.period_filter())

    def test_missing_branch_refuses(self):
        bim = model()
        bim["model"]["tables"][0]["measures"][0]["expression"] = "0"
        with self.assertRaises(F.PatchError):
            F.patch_model(bim)


class Reconciles(unittest.TestCase):
    """The three part measures are exactly the Action Value /mo branches."""

    def check(self, action_value):
        wanted = branches(action_value)
        parts = {}
        for name in ("Unused Seats $", "Oversized Seats $", "Upgrade Seats $"):
            found = branches(F.NEW_MEASURES[name]["expression"])
            self.assertFalse(set(found) & set(parts), f"{name} overlaps another card")
            parts.update(found)
        self.assertEqual(parts, wanted)
        counted = set()
        for name in ("Unused Seats", "Oversized Seats", "Upgrade Seats"):
            groups = set(re.findall(r'"(\d)"', "\n".join(F.NEW_MEASURES[name]["expression"])))
            self.assertFalse(groups & counted)
            counted |= groups
        self.assertEqual(counted, set(wanted))
        self.assertEqual(set(re.findall(r'"(\d)"', "\n".join(
            F.NEW_MEASURES["Actioned Seats"]["expression"]))), set(wanted))

    def test_spec(self):
        self.check(ACTION_VALUE)

    @unittest.skipUnless(FABRIC.is_file(), "template not present")
    def test_shipped_action_value(self):
        with zipfile.ZipFile(FABRIC) as z:
            schema = json.loads(z.read("DataModelSchema").decode("utf-16-le").lstrip("\ufeff"))
        billing = next(t for t in schema["model"]["tables"] if t["name"] == F.BILLING)
        measure = next(m for m in billing["measures"] if m["name"] == "Action Value /mo")
        self.check(measure["expression"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
