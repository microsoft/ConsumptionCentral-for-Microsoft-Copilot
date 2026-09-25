"""Offline tests for `4. Power Automate + Dataverse/scripts/Build-FlowPackage.py`.

These pin the parts of the generated flows that were wrong in a way nothing
would have reported: a token the licensing API refuses, a response shape that
reads as empty rather than failing, and a page loop that never ran.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PATH4 = ROOT / "4. Power Automate + Dataverse"
SCRIPT = PATH4 / "scripts" / "Build-FlowPackage.py"
SCHEMA_FILE = PATH4 / "dataverse-schema.json"


def load():
    spec = importlib.util.spec_from_file_location("build_flow_package", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules["build_flow_package"] = module
    spec.loader.exec_module(module)
    return module


build = load()
SCHEMA = json.loads(SCHEMA_FILE.read_text(encoding="utf-8"))
PREFIX = SCHEMA["publisherPrefix"] + "_"
TABLES = {t["sourceTable"]: t for t in SCHEMA["tables"]}
FEEDS = {f["name"]: f for f in build.FEEDS}

STUDIO = ("Studio Consumption", "Studio Agents")


def built(name, backfill=False):
    feed = FEEDS[name]
    return build.definition(feed, TABLES[feed["table"]], PREFIX, backfill)


def day_actions(name, backfill=False):
    return built(name, backfill)["actions"]["For_each_day"]["actions"]


def fetch_of(name):
    """The Fetch action, wherever the feed happens to put it."""
    actions = day_actions(name)
    if "Until_page" in actions:
        return actions["Until_page"]["actions"]["Fetch"]
    return actions["Fetch"]


class LicensingAuthTests(unittest.TestCase):
    """These routes need a delegated admin *and* a client the API trusts."""

    def test_studio_feeds_use_the_entra_connector(self):
        for name in STUDIO:
            with self.subTest(name):
                host = fetch_of(name)["inputs"]["host"]
                self.assertEqual(host["operationId"], "InvokeHttp")
                self.assertTrue(host["apiId"].endswith("shared_webcontents"))
                self.assertEqual(host["connectionName"], build.ENTRA_CONNECTION)

    def test_studio_feeds_never_request_a_client_credentials_token(self):
        # An application token is what produced the 403; there is no app role
        # for these routes, so re-introducing one would silently break the feed.
        for name in STUDIO:
            with self.subTest(name):
                body = json.dumps(built(name))
                self.assertNotIn("client_credentials", body)
                self.assertNotIn("Get_token", body)

    def test_studio_fetch_sends_no_authorization_header(self):
        for name in STUDIO:
            with self.subTest(name):
                inputs = fetch_of(name)["inputs"]
                self.assertNotIn("headers", inputs)
                self.assertEqual(inputs["authentication"],
                                 "@parameters('$authentication')")

    def test_other_feeds_keep_their_own_auth(self):
        # Cost Management does grant application permissions, and GitHub uses a
        # PAT. Neither should have been swept into the connector change.
        azure = day_actions("Azure AI Spend")
        self.assertIn("Get_token", azure)
        self.assertEqual(azure["Fetch"]["type"], "Http")
        github = day_actions("GitHub Usage")
        self.assertIn("Get_secret", github)
        self.assertNotIn("Get_token", github)

    def test_no_feed_pairs_client_credentials_with_the_licensing_host(self):
        for name, feed in FEEDS.items():
            with self.subTest(name):
                if feed["host"] == "api.powerplatform.com":
                    self.assertEqual(feed["auth"], "entra_connector")


class RequestContractTests(unittest.TestCase):
    """Pin the query string a live tenant was confirmed to answer."""

    def test_include_fields_is_sent(self):
        # Without it the response carries no metadata block, so every rich
        # column lands empty and nothing errors.
        for name in STUDIO:
            with self.subTest(name):
                url = fetch_of(name)["inputs"]["parameters"]["request/url"]
                self.assertIn("includeFields=users%2Ctags%2CasOfDate", url)

    def test_required_query_parameters_are_present(self):
        for name in STUDIO:
            with self.subTest(name):
                url = fetch_of(name)["inputs"]["parameters"]["request/url"]
                self.assertIn("api-version=2024-10-01", url)
                self.assertIn("pageSize=5000", url)
                self.assertIn("/licensing/entitlements/MCSMessages/resources", url)

    def test_each_request_covers_exactly_one_day(self):
        # A multi-day window collapses the dates and loses the daily grain.
        for name in STUDIO:
            with self.subTest(name):
                url = fetch_of(name)["inputs"]["parameters"]["request/url"]
                self.assertEqual(url.count("items('For_each_day')"), 2)
                self.assertIn("fromDate=", url)
                self.assertIn("toDate=", url)

    def test_continuation_token_rides_on_the_same_window(self):
        # Rebuilding a continuation request without the original window would
        # return a different day's rows under the current day's date.
        for name in STUDIO:
            with self.subTest(name):
                url = fetch_of(name)["inputs"]["parameters"]["request/url"]
                self.assertIn("continuationtoken=", url)
                self.assertIn("variables('ContinuationToken')", url)
                self.assertLess(url.index("fromDate="),
                                url.index("continuationtoken="))


class PagingTests(unittest.TestCase):
    def test_studio_feeds_page_until_the_token_empties(self):
        for name in STUDIO:
            with self.subTest(name):
                actions = day_actions(name)
                self.assertIn("Until_page", actions)
                loop = actions["Until_page"]
                self.assertEqual(loop["type"], "Until")
                self.assertEqual(loop["expression"],
                                 "@equals(variables('ContinuationToken'), '')")

    def test_the_token_is_cleared_before_each_day(self):
        # The variable is shared across days; a leftover token would skip the
        # first page of the next day.
        for name in STUDIO:
            with self.subTest(name):
                actions = day_actions(name)
                self.assertEqual(actions["Reset_continuation"]["inputs"]["value"], "")
                self.assertEqual(
                    actions["Until_page"]["runAfter"],
                    {"Reset_continuation": ["Succeeded"]})

    def test_the_token_is_read_back_from_the_body(self):
        for name in STUDIO:
            with self.subTest(name):
                loop = day_actions(name)["Until_page"]["actions"]
                value = loop["Set_continuation"]["inputs"]["value"]
                # Lowercase at the top level of the body, not camelCase.
                self.assertIn("body('Fetch')?['continuationtoken']", value)
                self.assertEqual(loop["Set_continuation"]["runAfter"],
                                 {"For_each_row": ["Succeeded"]})

    def test_the_loop_is_bounded(self):
        for name in STUDIO:
            with self.subTest(name):
                self.assertIn("limit", day_actions(name)["Until_page"])

    def test_days_run_one_at_a_time(self):
        for name in STUDIO:
            with self.subTest(name):
                loop = built(name)["actions"]["For_each_day"]
                self.assertEqual(
                    loop["runtimeConfiguration"]["concurrency"]["repetitions"], 1)


class ResponseShapeTests(unittest.TestCase):
    def test_rows_are_read_from_the_nested_envelope_first(self):
        # A real tenant returns value[0].resources[]. Reading the flat value[]
        # yields group objects, so every column is blank and nothing raises.
        for name in STUDIO:
            with self.subTest(name):
                source = build.row_source(FEEDS[name])
                self.assertIn("first(body('Fetch')?['value'])?['resources']", source)
                self.assertLess(source.index("['resources']"),
                                source.index("body('Fetch')?['value'], json"))

    def test_flat_shape_is_still_accepted(self):
        for name in STUDIO:
            with self.subTest(name):
                self.assertIn("body('Fetch')?['value']", build.row_source(FEEDS[name]))

    def test_non_licensing_feeds_read_the_flat_shape(self):
        self.assertEqual(build.row_source(FEEDS["Azure AI Spend"]),
                         "@coalesce(body('Fetch')?['value'], json('[]'))")

    def test_the_row_loop_uses_that_source(self):
        for name in STUDIO:
            with self.subTest(name):
                loop = day_actions(name)["Until_page"]["actions"]["For_each_row"]
                self.assertEqual(loop["foreach"], build.row_source(FEEDS[name]))


class VariableTests(unittest.TestCase):
    def test_each_initialise_declares_exactly_one_variable(self):
        # InitializeVariable takes a single variable; a list of them leaves all
        # but the first undeclared, and the flow fails at first use.
        for name in FEEDS:
            with self.subTest(name):
                for key, action in built(name)["actions"].items():
                    if action.get("type") == "InitializeVariable":
                        self.assertEqual(len(action["inputs"]["variables"]), 1, key)

    def test_the_continuation_variable_is_declared(self):
        for name in STUDIO:
            with self.subTest(name):
                declared = {
                    v["name"]
                    for a in built(name)["actions"].values()
                    if a.get("type") == "InitializeVariable"
                    for v in a["inputs"]["variables"]
                }
                self.assertIn("ContinuationToken", declared)

    def test_setup_runs_before_the_days_are_built(self):
        for name in STUDIO:
            with self.subTest(name):
                actions = built(name)["actions"]
                self.assertTrue(actions["Days"]["runAfter"])
                previous = next(iter(actions["Days"]["runAfter"]))
                self.assertEqual(actions[previous]["type"], "InitializeVariable")


class SnapshotMonthTests(unittest.TestCase):
    def test_snapshot_month_comes_from_the_day_not_the_row(self):
        # The API returns no such field, so reading it off the row is always
        # null - and a null there fails the refresh with MissingExportDate.
        for name in STUDIO:
            with self.subTest(name):
                table = TABLES[FEEDS[name]["table"]]
                columns = {c["canonical"]: c["logicalName"] for c in table["columns"]}
                if "snapshot_month" not in columns:
                    self.skipTest("table has no snapshot_month")
                item = build.upsert_action(FEEDS[name], table, PREFIX)
                item = item["Upsert_row"]["inputs"]["parameters"]["item"]
                value = item[columns["snapshot_month"]]
                self.assertIn("items('For_each_day')", value)
                self.assertNotIn("For_each_row", value)


class BackfillTests(unittest.TestCase):
    def test_backfill_covers_more_days_than_a_daily_run(self):
        for name in FEEDS:
            with self.subTest(name):
                daily = built(name, False)["actions"]["Days"]["inputs"]
                back = built(name, True)["actions"]["Days"]["inputs"]
                self.assertNotEqual(daily, back)

    def test_backfill_and_daily_keep_the_same_request_contract(self):
        for name in STUDIO:
            with self.subTest(name):
                feed = FEEDS[name]
                table = TABLES[feed["table"]]
                a = build.definition(feed, table, PREFIX, False)
                b = build.definition(feed, table, PREFIX, True)
                pick = lambda d: (d["actions"]["For_each_day"]["actions"]["Until_page"]
                                  ["actions"]["Fetch"]["inputs"]["parameters"])
                self.assertEqual(pick(a), pick(b))


class PackageTests(unittest.TestCase):
    """Every connector a flow calls must be declared in the package."""

    def connectors_used(self) -> set[str]:
        """Walk the built definitions and collect each apiId's connector."""
        found: set[str] = set()
        stack = []
        for name, feed in FEEDS.items():
            table = TABLES[feed["table"]]
            for backfill in (False, True):
                stack.append(build.definition(feed, table, PREFIX, backfill))
        while stack:
            node = stack.pop()
            if isinstance(node, dict):
                api = node.get("apiId")
                if isinstance(api, str):
                    found.add(api.rsplit("/", 1)[-1])
                stack.extend(node.values())
            elif isinstance(node, list):
                stack.extend(node)
        return found

    def test_apis_map_covers_every_connector(self):
        """Read the committed package, not the source that writes it."""
        import zipfile

        package = (Path(build.__file__).parent.parent / "flows"
                   / "ConsumptionCentral-Dataverse.zip")
        self.assertTrue(package.exists(), f"{package.name} has not been built")
        with zipfile.ZipFile(package) as zf:
            declared = json.loads(zf.read("Microsoft.Flow/apisMap.json"))
        for connector in self.connectors_used():
            with self.subTest(connector):
                self.assertIn(connector, declared)

    def test_entra_connector_is_actually_used(self):
        self.assertIn(build.ENTRA_CONNECTOR, self.connectors_used())


if __name__ == "__main__":
    unittest.main()
