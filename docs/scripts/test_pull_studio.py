"""Offline tests for `1. Local CSV/pull_studio.py`.

No network. The API is replaced with recorded-looking payloads so the shaping,
the defensive metadata reads and the guards can be checked without a tenant.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "1. Local CSV" / "pull_studio.py"


def load():
    spec = importlib.util.spec_from_file_location("pull_studio", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules["pull_studio"] = module
    spec.loader.exec_module(module)
    return module


pull = load()


class KeyTests(unittest.TestCase):
    def test_key_matches_the_templates_own_rule(self):
        # The report keys columns by lowercase alphanumerics only. If this
        # drifts, columns stop binding and pages go blank without an error.
        self.assertEqual(pull.key("Agent Name"), "agentname")
        self.assertEqual(pull.key("Agent_Name"), "agentname")
        self.assertEqual(pull.key("AI Feature/Billable Feature"), "aifeaturebillablefeature")


class MetadataTests(unittest.TestCase):
    def test_reads_a_key_whatever_its_casing_or_separators(self):
        for spelling in ("agentName", "Agent_Name", "AGENTNAME", "agent name"):
            with self.subTest(spelling=spelling):
                row = {"metadata": {spelling: "Finance Bot"}}
                self.assertEqual(pull.field(row, "agent_name"), "Finance Bot")

    def test_prefers_the_row_over_its_metadata(self):
        row = {"resourceId": "top", "metadata": {"agentId": "nested"}}
        self.assertEqual(pull.field(row, "agent_id"), "top")

    def test_falls_back_to_metadata_when_the_row_has_nothing(self):
        row = {"metadata": {"agentId": "nested"}}
        self.assertEqual(pull.field(row, "agent_id"), "nested")

    def test_blank_is_not_a_value(self):
        row = {"resourceId": "", "metadata": {"agentId": "nested"}}
        self.assertEqual(pull.field(row, "agent_id"), "nested")

    def test_missing_everywhere_gives_the_default(self):
        self.assertEqual(pull.field({}, "agent_name", "none"), "none")

    def test_survives_metadata_that_is_not_a_dict(self):
        self.assertEqual(pull.field({"metadata": "text"}, "agent_name", "x"), "x")


class NumberTests(unittest.TestCase):
    def test_parses_numbers_and_numeric_text(self):
        self.assertEqual(pull.number(3), 3.0)
        self.assertEqual(pull.number("2.5"), 2.5)

    def test_unparseable_becomes_zero_rather_than_crashing(self):
        self.assertEqual(pull.number("n/a"), 0.0)
        self.assertEqual(pull.number(None), 0.0)

    def test_a_real_zero_is_kept(self):
        # Zero consumption is a fact. It must not be confused with no telemetry.
        self.assertEqual(pull.number(0), 0.0)
        self.assertEqual(pull.number("0"), 0.0)


class UrlGuardTests(unittest.TestCase):
    def test_accepts_the_licensing_host(self):
        url = pull.url_for("/licensing/entitlements/MCSMessages")
        self.assertEqual(pull.checked(url), url)

    def test_rejects_another_host(self):
        with self.assertRaises(pull.CollectionError):
            pull.checked("https://evil.example.com/licensing")

    def test_rejects_plain_http(self):
        with self.assertRaises(pull.CollectionError):
            pull.checked("http://api.powerplatform.com/licensing")

    def test_rejects_control_characters_and_backslashes(self):
        for bad in ("https://api.powerplatform.com/a\\b",
                    "https://api.powerplatform.com/a\nb"):
            with self.subTest(url=bad):
                with self.assertRaises(pull.CollectionError):
                    pull.checked(bad)

    def test_always_pins_the_api_version(self):
        self.assertIn(f"api-version={pull.API}", pull.url_for("/x"))
        self.assertIn(f"api-version={pull.API}", pull.url_for("/x", fromDate="2026-01-01"))


class HeaderTests(unittest.TestCase):
    """The headers must match what the templates already read."""

    def test_tenant_headers_match_the_sample_file(self):
        sample = ROOT / "1. Local CSV" / "sample-data" / "StudioTenantDaily.csv"
        first = sample.read_text(encoding="utf-8-sig").splitlines()[0]
        self.assertEqual(first.split(","), pull.TENANT_HEADERS)

    def test_agent_headers_match_the_sample_file_plus_snapshot_month(self):
        sample = ROOT / "1. Local CSV" / "sample-data" / "StudioPerAgent.csv"
        first = sample.read_text(encoding="utf-8-sig").splitlines()[0]
        self.assertEqual(first.split(","), pull.AGENT_HEADERS[:-1])
        self.assertEqual(pull.AGENT_HEADERS[-1], "Snapshot Month")


class CollectTests(unittest.TestCase):
    def setUp(self):
        self.today = datetime.now(timezone.utc).date()
        self.days = [(self.today - timedelta(days=n)).isoformat() for n in (2, 1)]

    def rows_for(self, day):
        return [
            {"environmentId": "ENV-1", "consumed": 10,
             "metadata": {"agentId": "a1", "agentName": "Finance Bot",
                          "feature": "Process Agent", "capacityType": "Pay as you go",
                          "nonBillableConsumed": 2}},
            {"environmentId": "ENV-1", "consumed": 5,
             "metadata": {"agentId": "a2", "agentName": "HR Bot",
                          "feature": "Answer", "capacityType": "Prepaid",
                          "nonBillableConsumed": 0}},
        ]

    def collect(self, days=2, rows=None):
        original = pull.day_rows
        pull.day_rows = lambda bearer, day: (rows if rows is not None
                                             else self.rows_for(day))
        try:
            return pull.collect("token", days, {"env-1": "Production"},
                                {"env-1": {"entitled": 1000, "plan_id": "P1",
                                           "plan_name": "Credits"}})
        finally:
            pull.day_rows = original

    def test_splits_prepaid_from_pay_as_you_go(self):
        tenant, _ = self.collect()
        payg = sum(r["Pay as you go Consumed Quantity"] for r in tenant)
        prepaid = sum(r["Prepaid Consumed Quantity"] for r in tenant)
        self.assertEqual(payg, 20)     # 10 a day, two days
        self.assertEqual(prepaid, 10)  # 5 a day, two days

    def test_keeps_the_daily_grain(self):
        tenant, _ = self.collect()
        self.assertEqual(sorted({r["Usage Date"] for r in tenant}), self.days)

    def test_aggregates_agents_over_the_whole_window(self):
        _, agents = self.collect()
        finance = [r for r in agents if r["Agent Id"] == "a1"]
        self.assertEqual(len(finance), 1, "one row per agent, not one per day")
        self.assertEqual(finance[0]["Billed credit"], 20)
        self.assertEqual(finance[0]["Non-billed credit"], 4)

    def test_resolves_environment_names(self):
        tenant, agents = self.collect()
        self.assertEqual({r["Environment Name"] for r in tenant}, {"Production"})
        self.assertEqual({r["Environment Name"] for r in agents}, {"Production"})

    def test_carries_the_entitlement_through(self):
        tenant, _ = self.collect()
        self.assertTrue(all(r["Entitled Quantity"] == 1000 for r in tenant))
        self.assertTrue(all(r["BillingPlan Name"] == "Credits" for r in tenant))

    def test_snapshot_month_is_never_blank(self):
        # A present-but-empty Snapshot Month fails the refresh outright with
        # MissingExportDate, so this is a correctness guard, not cosmetics.
        _, agents = self.collect()
        self.assertTrue(agents)
        for row in agents:
            self.assertTrue(row["Snapshot Month"])
            self.assertRegex(row["Snapshot Month"], r"^\d{4}-\d{2}$")

    def test_product_defaults_to_copilot_studio(self):
        _, agents = self.collect()
        self.assertTrue(all(r["Product"] == "Copilot Studio" for r in agents))

    def test_refuses_to_publish_when_the_window_is_entirely_empty(self):
        with self.assertRaises(pull.CollectionError) as caught:
            self.collect(rows=[])
        self.assertIn("Nothing was written", str(caught.exception))

    def test_a_partly_empty_window_still_publishes(self):
        calls = {"n": 0}

        def sometimes(bearer, day):
            calls["n"] += 1
            return [] if calls["n"] == 1 else self.rows_for(day)

        original = pull.day_rows
        pull.day_rows = sometimes
        try:
            tenant, agents = pull.collect("token", 2, {}, {})
        finally:
            pull.day_rows = original
        self.assertTrue(tenant)
        self.assertTrue(agents)


class WriteTests(unittest.TestCase):
    def test_writes_the_declared_headers_and_replaces_atomically(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder)
            pull.write(target, "StudioTenantDaily.csv", pull.TENANT_HEADERS,
                       [{"Environment Id": "env-1", "Usage Date": "2026-01-01"}])
            written = (target / "StudioTenantDaily.csv").read_text(encoding="utf-8-sig")
            self.assertEqual(written.splitlines()[0].split(","), pull.TENANT_HEADERS)
            self.assertEqual(list(target.iterdir()).__len__(), 1, "no scratch file left")

    def test_ignores_extra_keys_rather_than_failing(self):
        with tempfile.TemporaryDirectory() as folder:
            pull.write(Path(folder), "x.csv", ["Usage Date"],
                       [{"Usage Date": "2026-01-01", "Unexpected": "value"}])
            body = (Path(folder) / "x.csv").read_text(encoding="utf-8-sig")
            self.assertNotIn("Unexpected", body)


if __name__ == "__main__":
    unittest.main(verbosity=2)
