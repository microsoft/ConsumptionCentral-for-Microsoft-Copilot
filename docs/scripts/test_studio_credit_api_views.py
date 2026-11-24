import copy
import unittest

from fix_limit_and_token_measures import TEMPLATES, measure
from fix_pbit_defaults import layout_for
from fix_refresh_time_cuts import joined
from fix_studio_report_tables import EXPRESSION, TABLES, build as report_views
from fix_studio_resource_labels import repair as labels
from fix_studio_resource_wording import ACTION_LABELS, EMPTY, build as wording
from fix_viva_query_org import Package, PatchError


class StudioCreditViews(unittest.TestCase):
    def test_resource_heading_overrides_implicit_column_caption(self):
        projection = {
            "field": {"Column": {"Property": "Agent Name"}},
            "queryRef": "Agent Bridge.Agent Name",
            "nativeQueryRef": "Agent Name",
        }
        before = {"queryState": {"Rows": {"projections": [projection]}}}
        after = labels(before)
        expected = copy.deepcopy(before)
        expected["queryState"]["Rows"]["projections"][0]["displayName"] = "Resource"
        self.assertEqual(after, expected)
        self.assertEqual(labels(after), after)
        projection["displayName"] = "Custom caption"
        self.assertEqual(labels(before), before)

    def test_resource_labels_preserve_bindings_and_literal_data_values(self):
        before = {"visual": {
            "query": {"queryState": {"Rows": {"projections": [{
                "displayName": "Agent", "queryRef": "Agent Bridge.Agent Name",
                "field": {"Column": {"Property": "Agent Name"}},
            }]}}},
            "visualContainerObjects": {"title": [{"properties": {"text": {
                "expr": {"Literal": {"Value": "'AGENT ACTION QUEUE'"}}}}}]},
            "filterConfig": {"Literal": {"Value": "'Agent 123'"}},
        }}
        after = labels(before)
        projection = after["visual"]["query"]["queryState"]["Rows"]["projections"][0]
        self.assertEqual(projection["displayName"], "Resource")
        self.assertEqual(projection["queryRef"], "Agent Bridge.Agent Name")
        self.assertEqual(projection["field"], before["visual"]["query"]["queryState"]["Rows"]["projections"][0]["field"])
        self.assertEqual(after["visual"]["filterConfig"], before["visual"]["filterConfig"])
        self.assertEqual(after["visual"]["visualContainerObjects"]["title"][0]["properties"]["text"]["expr"]["Literal"]["Value"],
                         "'RESOURCE ACTION QUEUE'")

    def test_report_views_preserve_person_facts_and_signed_report(self):
        for path in TEMPLATES:
            with self.subTest(path=path.parent.name):
                raw = path.read_bytes()
                candidate, _ = report_views(raw)
                package = Package(candidate)
                model = layout_for(package.contents["DataModelSchema"], "schema")[0]["model"]
                original = layout_for(Package(raw).contents["DataModelSchema"], "schema")[0]["model"]
                if path.parent.name == "2. Fabric":
                    self.assertEqual(candidate, raw)
                    continue
                for name in ("CoworkBilling", "Credit Consumption (User)", "Credit Consumption (Agent)", "Credit Consumption (Tenant)"):
                    self.assertEqual(next(t for t in model["tables"] if t["name"] == name),
                                     next(t for t in original["tables"] if t["name"] == name))
                source = joined(next(e for e in model["expressions"] if e["name"] == EXPRESSION)["expression"])
                self.assertIn("LegacyFiles", source)
                self.assertIn('HarnessType = Label(_, "harnesstype")', source)
                self.assertIn('Duration.Days(Today - End) <= 3', source)
                for name in TABLES:
                    self.assertEqual(len([t for t in model["tables"] if t["name"] == name]), 1)
                self.assertEqual(report_views(candidate), (candidate, []))
                for part, content in Package(raw).contents.items():
                    if part not in ("DataModelSchema", "UnappliedChanges"):
                        self.assertEqual(package.contents[part], content)

    def test_empty_states_and_action_do_not_claim_coverage_or_missing_resources(self):
        for path in TEMPLATES:
            candidate, _ = wording(path.read_bytes())
            model = layout_for(Package(candidate).contents["DataModelSchema"], "schema")[0]["model"]
            action = joined(measure(model, "Credit Consumption (Agent)", "Agent Action")["expression"])
            self.assertNotIn("well covered", action)
            self.assertNotIn("Healthy", action)
            group = next(t for t in model["tables"] if t["name"] == "Agent Action Group")
            axis = joined(group["partitions"][0]["source"]["expression"])
            for label in ACTION_LABELS.values():
                self.assertIn(f'"{label}"', action)
                self.assertIn(f'"{label}"', axis)
            for name in ("Studio Forecast Note", "Studio Forecast Summary", "Studio Headline"):
                self.assertIn(EMPTY, joined(measure(model, "Credit Consumption (Tenant)", name)["expression"]))
            note = joined(measure(model, "Settings", "Studio Snapshot Note")["expression"])
            self.assertIn("User and resource detail", note)
            self.assertIn("No matching resource-detail rows", note)
            self.assertIn("COUNTROWS('Credit Consumption (Agent)')", note)
            self.assertNotIn("User and agent detail", note)
            self.assertEqual(wording(candidate), (candidate, []))

    def test_edited_wording_fails_closed(self):
        candidate, _ = wording(TEMPLATES[0].read_bytes())
        package = Package(candidate)
        schema, encode = layout_for(package.contents["DataModelSchema"], "schema")
        measure(schema["model"], "Credit Consumption (Agent)", "Agent Action")["expression"] += '\n// changed'
        with self.assertRaises(PatchError):
            wording(package.rebuild({"DataModelSchema": encode(schema)}))


if __name__ == "__main__":
    unittest.main()
