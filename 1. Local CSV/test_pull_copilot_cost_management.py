import base64
import csv
import io
import json
import tempfile
import unittest
from datetime import date
from email.message import Message
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

import pull_copilot_cost_management as collector
from pull_azure_ai import CollectionError, publish


class Client:
    def __init__(self):
        self.urls = []

    def list(self, url):
        self.urls.append(url)
        if "serviceUsageRecords" in url:
            return [{"serviceId": "cowork", "consumedQuantity": 1.5, "unit": "copilotCredit"}]
        return [{"fundingClass": "prepaid", "consumedQuantity": 3,
                 "unit": "copilotCredit", "dataStatus": None}]

    def get(self, url):
        self.urls.append(url)
        return {"billingMethodBalances": [
            {"billingMethod": "payAsYouGo", "consumedQuantity": 2, "unit": "copilotCredit"}]}


def jwt(claims):
    part = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return "header." + part + ".signature"


class CollectorTests(unittest.TestCase):
    def test_selectors_funding_and_balance_are_distinct(self):
        client = Client()
        datasets = collector.collect(client, date(2026, 1, 31), date(2026, 2, 2), "snapshot")
        daily = datasets[collector.SERVICE_FILE][1]
        self.assertEqual([r["Date"] for r in daily], ["2026-01-31", "2026-02-01"])
        self.assertEqual(parse_qs(urlsplit(client.urls[0]).query),
                         {"startDate": ["2026-01-31"], "endDate": ["2026-02-01"]})
        funding = datasets[collector.FUNDING_FILE][1]
        self.assertEqual([r["Month"] for r in funding], ["2026-01-01", "2026-02-01"])
        balance = datasets[collector.BALANCE_FILE][1][0]
        self.assertEqual((balance["PurchasedQuantity"], balance["RemainingQuantity"]), ("", ""))
        self.assertEqual(balance["AsOfUTC"], "snapshot")

    def test_history_is_preserved_and_window_replaced(self):
        with tempfile.TemporaryDirectory() as folder:
            first = collector.collect(Client(), date(2026, 1, 1), date(2026, 1, 3), "old")
            publish(folder, first)
            second = collector.collect(Client(), date(2026, 1, 2), date(2026, 1, 4), "new")
            collector.preserve_history(folder, second, date(2026, 1, 2), date(2026, 1, 4))
            publish(folder, second)
            with (Path(folder) / collector.SERVICE_FILE).open(newline="", encoding="utf-8") as handle:
                self.assertEqual([r["Date"] for r in csv.DictReader(handle)],
                                 ["2026-01-01", "2026-01-02", "2026-01-03"])
            with (Path(folder) / collector.FUNDING_FILE).open(newline="", encoding="utf-8") as handle:
                self.assertEqual(len(list(csv.DictReader(handle))), 1)

    def test_bad_existing_file_does_not_publish(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / collector.SERVICE_FILE
            path.write_text("bad\n", encoding="utf-8")
            datasets = collector.collect(Client(), date(2026, 1, 1), date(2026, 1, 2), "now")
            with self.assertRaises(CollectionError):
                collector.preserve_history(folder, datasets, date(2026, 1, 1), date(2026, 1, 2))
            self.assertEqual(path.read_text(encoding="utf-8"), "bad\n")

    def test_app_only_token_required(self):
        token = jwt({"roles": ["CopilotCostManagement.Read.All"]})
        self.assertEqual(collector.app_token({"accessToken": token}), token)
        for claims in ({"scp": "CopilotCostManagement.Read.All"},
                       {"roles": ["CopilotCostManagement-Reports.Read.All"]},
                       {"roles": None}, {}):
            with self.subTest(claims=claims), self.assertRaises(CollectionError):
                collector.app_token({"accessToken": jwt(claims)})

    def test_follows_pages_and_rejects_untrusted_or_repeated_continuation(self):
        first = collector.ROOT + "/usageReports/serviceUsageRecords?startDate=2026-01-01&endDate=2026-01-02"
        second = first + "&%24skiptoken=abc"
        client = collector.GraphClient("not-a-real-token")
        pages = {first: {"value": [1], "@odata.nextLink": second}, second: {"value": [2]}}
        client.get = lambda url: pages[url]
        self.assertEqual(client.list(first), [1, 2])
        pages[second]["@odata.nextLink"] = first
        with self.assertRaises(CollectionError):
            client.list(first)
        pages[second]["@odata.nextLink"] = "https://example.com/steal"
        with self.assertRaises(CollectionError):
            client.list(first)

    def test_unknown_unit_and_conflicting_records_fail(self):
        client = Client()
        client.list = lambda url: [{"serviceId": "cowork", "consumedQuantity": 1, "unit": "dollars"}]
        with self.assertRaises(CollectionError):
            collector.collect(client, date(2026, 1, 1), date(2026, 1, 2), "now")
        with self.assertRaises(CollectionError):
            collector.distinct([{"key": "x", "value": 1}, {"key": "x", "value": 2}], ["key"])

    def test_graph_throttling_waits_for_retry_after(self):
        headers = Message()
        headers["Retry-After"] = "9"
        attempts, waits = [], []

        def open_request(request, timeout):
            attempts.append(request)
            if len(attempts) == 1:
                raise HTTPError(request.full_url, 429, "Throttled", headers, None)
            return io.BytesIO(b'{"value":[]}')

        client = collector.GraphClient("not-a-real-token", opener=open_request, sleep=waits.append)
        self.assertEqual(client.list(collector.ROOT + "/usageReports/serviceUsageRecords"), [])
        self.assertEqual(waits, [9])
        self.assertEqual(len(attempts), 2)


if __name__ == "__main__":
    unittest.main()
