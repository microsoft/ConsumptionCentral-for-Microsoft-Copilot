"""Offline contract tests; never invoke Azure or inspect credentials.

Run with python -m unittest discover -s "<this directory>"
    -p "test_pull_azure_ai.py"
"""

import contextlib
import copy
import csv
import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import Mock, patch


MODULE_PATH = Path(__file__).with_name("pull_azure_ai.py")
SPEC = importlib.util.spec_from_file_location("azure_ai_collector_under_test", MODULE_PATH)
collector = importlib.util.module_from_spec(SPEC)
with patch("subprocess.run", side_effect=AssertionError("Azure invocation during import")):
    SPEC.loader.exec_module(collector)

START = date(2026, 9, 1)
END = date(2026, 9, 3)
SUBSCRIPTION = "00000000-0000-0000-0000-000000000001"
URL = "https://management.azure.com/subscriptions/" + SUBSCRIPTION + "/resources?api-version=2021-04-01"
NEXT_URL = URL + "&$skiptoken=next"
RESOURCE_ID = (
    "/subscriptions/" + SUBSCRIPTION
    + "/resourceGroups/Example/providers/Microsoft.CognitiveServices/accounts/ExampleAI"
)
ACCOUNT = {"id": RESOURCE_ID, "name": "ExampleAI", "resourceGroup": "Example", "location": "eastus"}
FILENAMES = {"AzureAiSpendDaily.csv", "AzureAiTokensDaily.csv", "AzureAiDeployments.csv"}
SPEND, TOKENS, INVENTORY = "AzureAiSpendDaily.csv", "AzureAiTokensDaily.csv", "AzureAiDeployments.csv"
HEADERS = {SPEND: collector.SPEND_HEADERS, TOKENS: collector.TOKEN_HEADERS,
           INVENTORY: collector.DEPLOYMENT_HEADERS}
JUNE_12 = date(2026, 6, 12)
NOTHING_PUBLISHED = "; nothing was published. Fix the file, or delete it to start it again, then rerun."


def cost_page(rows=None, columns=None, next_link=None):
    columns = columns or ["Cost", "UsageQuantity", "UsageDate", "Meter", "ResourceId", "Currency"]
    properties = {
        "columns": [
            {"name": name, "type": "Number" if name in ("Cost", "UsageQuantity", "UsageDate") else "String"}
            for name in columns
        ],
        "rows": rows if rows is not None else [[1.25, 20, 20260901, "Input tokens", RESOURCE_ID, "USD"]],
    }
    if next_link is not None:
        properties["nextLink"] = next_link
    return {"properties": properties}


def definition(name, dimensions=("ModelDeploymentName",), aggregation=None):
    aggregation = aggregation or ("Average" if "Utilization" in name else "Total")
    return {
        "name": {"value": name, "localizedValue": name},
        "primaryAggregationType": aggregation,
        "supportedAggregationTypes": [aggregation],
        "dimensions": [{"value": dimension, "localizedValue": dimension} for dimension in dimensions],
        "metricAvailabilities": [{"timeGrain": "P1D", "retention": "P93D"}],
    }


def metric_payload(data=None, name="InputTokens", dimensions=None):
    return {
        "timespan": "2026-09-01T00:00:00Z/2026-09-03T00:00:00Z",
        "interval": "P1D",
        "value": [{
            "name": {"value": name},
            "errorCode": "Success",
            "timeseries": [{
                "metadatavalues": dimensions if dimensions is not None else [
                    {"name": {"value": "ModelDeploymentName"}, "value": "chat"}
                ],
                "data": data if data is not None else [
                    {"timeStamp": "2026-09-01T00:00:00Z", "total": 0},
                    {"timeStamp": "2026-09-02T00:00:00Z", "total": 42},
                ],
            }],
        }],
    }


class OfflineTestCase(unittest.TestCase):
    def setUp(self):
        self.no_azure = self.enterContext(
            patch.object(collector.subprocess, "run", side_effect=AssertionError("Unmocked Azure call"))
        )
        for target in ("builtins.open", "io.open", "os.replace", "os.makedirs"):
            self.enterContext(patch(target, side_effect=AssertionError("Unmocked filesystem access")))
        self.enterContext(patch.object(Path, "mkdir", side_effect=AssertionError("Unmocked directory creation")))


class MemoryCsvFiles:
    """Mock disk writes so publication tests cannot touch existing user CSVs."""

    def __init__(self, outdir, filenames):
        self.outdir = outdir
        self.files = {str(outdir / name): "previous " + name for name in filenames}
        self.events = []
        self.replacements = []
        self.descriptors = {}
        self.serial = 0
        self.fail_on_write = None
        self.write_count = 0

    def open(self, filename, mode="r", *args, **kwargs):
        key = str(filename)
        if "w" not in mode and "a" not in mode and "x" not in mode:
            return io.StringIO(self.files[key])
        self.write_count += 1
        if self.write_count == self.fail_on_write:
            raise OSError("disk full during staging")
        self.events.append(("open", key))
        owner = self

        class Buffer(io.StringIO):
            name = key

            def fileno(self):
                return 10000  # fsync is mocked; StringIO has no operating-system descriptor.

            def close(self):
                if not self.closed:
                    owner.files[key] = self.getvalue()
                    owner.events.append(("close", key))
                super().close()

        return Buffer()

    def mkstemp(self, suffix=None, prefix=None, dir=None, **kwargs):
        self.serial += 1
        name = str(Path(dir or self.outdir) / ((prefix or "stage") + str(self.serial) + (suffix or "")))
        descriptor = 10000 + self.serial
        self.descriptors[descriptor] = name
        return descriptor, name

    def named_file(self, mode="w+", **kwargs):
        _, name = self.mkstemp(suffix=kwargs.get("suffix"), prefix=kwargs.get("prefix"), dir=kwargs.get("dir"))
        return self.open(name, mode)

    def replace(self, source, destination):
        source, destination = str(source), str(destination)
        self.events.append(("replace", destination))
        self.replacements.append((source, destination))
        self.files[destination] = self.files.pop(source)

    def install(self, test):
        patches = [
            patch("builtins.open", side_effect=self.open),
            patch("io.open", side_effect=self.open),
            patch.object(Path, "mkdir"),
            patch.object(Path, "unlink"),
            patch("os.makedirs"),
            patch("os.replace", side_effect=self.replace),
            patch("os.unlink"),
            patch("os.fsync"),
            patch("os.fdopen", side_effect=lambda fd, mode="w", **kwargs: self.open(self.descriptors[fd], mode)),
            patch("tempfile.mkstemp", side_effect=self.mkstemp),
            patch("tempfile.NamedTemporaryFile", side_effect=self.named_file),
            patch("tempfile.mkdtemp", return_value=str(self.outdir / "mock-stage")),
            patch("shutil.rmtree"),
        ]
        for replacement in patches:
            test.enterContext(replacement)


class AzureCLITests(OfflineTestCase):
    def cli(self):
        return collector.AzureCLI(executable="az", sleep=Mock())

    def test_run_parses_json_without_shell_and_with_timeout(self):
        self.no_azure.side_effect = None
        self.no_azure.return_value = subprocess.CompletedProcess([], 0, '{"id":"example"}', "")
        self.assertEqual(self.cli().run(["account", "show"]), {"id": "example"})
        args, kwargs = self.no_azure.call_args
        self.assertIsInstance(args[0], list)
        self.assertIn("account", args[0])
        self.assertIs(kwargs["shell"], False)
        self.assertIs(kwargs["capture_output"], True)
        self.assertIs(kwargs["text"], True)
        self.assertEqual(kwargs["timeout"], 180)

    def test_cli_failure_is_collection_error(self):
        self.no_azure.side_effect = None
        self.no_azure.return_value = subprocess.CompletedProcess([], 1, "", "authorization failed")
        with self.assertRaises(collector.CollectionError):
            self.cli().run(["account", "show"])

    def test_invalid_json_and_empty_output_fail(self):
        self.no_azure.side_effect = None
        for output in ("not json", "", "{"):
            with self.subTest(output=output):
                self.no_azure.return_value = subprocess.CompletedProcess([], 0, output, "")
                with self.assertRaises(collector.CollectionError):
                    self.cli().run(["account", "show"])

    def test_process_failures_are_collection_errors(self):
        for error in (FileNotFoundError("az unavailable"), subprocess.TimeoutExpired("az", 180)):
            with self.subTest(error=type(error).__name__):
                self.no_azure.side_effect = error
                with self.assertRaises(collector.CollectionError):
                    self.cli().run(["account", "show"])

    def test_request_uses_rest_and_inline_json(self):
        client = self.cli()
        body = {"dataset": {"granularity": "Daily"}}
        with patch.object(client, "run", return_value={"value": []}) as run:
            self.assertEqual(client.request("POST", URL, body), {"value": []})
        command = run.call_args.args[0]
        self.assertIn("rest", command)
        self.assertIn(URL, command)
        self.assertEqual(json.loads(command[command.index("--body") + 1]), body)

    def test_request_rejects_unsafe_urls_before_subprocess(self):
        invalid = [
            "http://management.azure.com/resources",
            "https://example.com/resources",
            "https://management.azure.com.evil.example/resources",
            "https://management.azure.com@evil.example/resources",
            "//management.azure.com/resources",
            "/subscriptions/example/resources",
        ]
        client = self.cli()
        for url in invalid:
            with self.subTest(url=url), self.assertRaises(collector.CollectionError):
                client.request("GET", url)
        self.no_azure.assert_not_called()

    def test_only_cost_query_request_allows_no_content(self):
        client = self.cli()
        cost_url = collector.ARM + "/subscriptions/" + SUBSCRIPTION + "/providers/Microsoft.CostManagement/query"
        with patch.object(client, "run", return_value=None) as run:
            client.request("POST", cost_url, {"type": "ActualCost"})
            self.assertTrue(run.call_args.kwargs["allow_empty"])
            client.request("GET", URL)
            self.assertFalse(run.call_args.kwargs["allow_empty"])

    def test_initial_cost_no_content_is_empty_but_continuation_no_content_fails(self):
        client = self.cli()
        with patch.object(client, "request", return_value=None):
            self.assertEqual(list(client.pages(URL, {"type": "ActualCost"})), [])
        with patch.object(client, "request", side_effect=[cost_page(next_link=NEXT_URL), None]):
            with self.assertRaises(collector.CollectionError):
                list(client.pages(URL, {"type": "ActualCost"}))

    def test_pages_follow_both_nextlink_locations(self):
        for nested in (False, True):
            with self.subTest(nested=nested):
                first = {"value": [{"id": "first"}]}
                first.update({"properties": {"nextLink": NEXT_URL}} if nested else {"nextLink": NEXT_URL})
                second = {"value": [{"id": "second"}]}
                client = self.cli()
                with patch.object(client, "request", side_effect=[first, second]) as request:
                    self.assertEqual(list(client.pages(URL)), [first, second])
                    self.assertEqual(request.call_count, 2)
                    self.assertEqual(request.call_args.args[1], NEXT_URL)

    def test_post_pagination_preserves_body(self):
        body = {"type": "ActualCost"}
        client = self.cli()
        with patch.object(client, "request", side_effect=[
            cost_page(next_link=NEXT_URL), cost_page(rows=[]),
        ]) as request:
            self.assertEqual(len(list(client.pages(URL, body))), 2)
            for call in request.call_args_list:
                self.assertEqual(call.args[0].upper(), "POST")
                sent_body = call.args[2] if len(call.args) > 2 else call.kwargs.get("body")
                self.assertEqual(sent_body, body)

    def test_invalid_nextlink_never_requested(self):
        for next_link in ("https://example.com/steal", "http://management.azure.com/x", "/relative"):
            with self.subTest(next_link=next_link):
                client = self.cli()
                with patch.object(client, "request", return_value={"value": [], "nextLink": next_link}) as request:
                    with self.assertRaises(collector.CollectionError):
                        list(client.pages(URL))
                    self.assertEqual(request.call_count, 1)

    def test_pagination_loop_fails_before_repeating_request(self):
        client = self.cli()
        with patch.object(client, "request", side_effect=[
            {"value": [], "nextLink": NEXT_URL}, {"value": [], "nextLink": URL},
        ]) as request:
            with self.assertRaises(collector.CollectionError):
                list(client.pages(URL))
            self.assertEqual(request.call_count, 2)

    def test_list_flattens_pages(self):
        client = self.cli()
        with patch.object(client, "pages", return_value=iter([
            {"value": [{"id": 1}]}, {"value": []}, {"value": [{"id": 2}]},
        ])):
            self.assertEqual(client.list(URL), [{"id": 1}, {"id": 2}])

    def test_non_object_page_fails(self):
        client = self.cli()
        with patch.object(client, "request", return_value=[]):
            with self.assertRaises(collector.CollectionError):
                list(client.pages(URL))


class CostQueryTests(OfflineTestCase):
    def query(self, pages, grouping=None):
        client = Mock()
        client.pages.return_value = iter(pages)
        return collector.cost_query(client, SUBSCRIPTION, START, END, grouping or ["Meter", "ResourceId"])

    def test_column_order_is_resolved_independently_per_page(self):
        second_columns = ["Currency", "ResourceId", "Meter", "UsageDate", "UsageQuantity", "Cost"]
        rows = self.query([
            cost_page(),
            cost_page([["EUR", RESOURCE_ID, "Output tokens", 20260902, 30, 2.5]], second_columns),
        ])
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["Cost"], 1.25)
        self.assertEqual(rows[1]["Cost"], 2.5)
        self.assertEqual(rows[1]["UsageQuantity"], 30)
        self.assertEqual(rows[1]["Currency"], "EUR")
        self.assertEqual(rows[1]["Meter"], "Output tokens")

    def test_zero_cost_and_quantity_are_preserved(self):
        rows = self.query([cost_page([[0, 0, 20260901, "Input tokens", RESOURCE_ID, "USD"]])])
        self.assertEqual(rows[0]["Cost"], 0)
        self.assertEqual(rows[0]["UsageQuantity"], 0)

    def test_empty_valid_page_is_empty_result(self):
        self.assertEqual(self.query([cost_page(rows=[])]), [])

    def test_more_than_two_groups_fails_without_request(self):
        client = Mock()
        with self.assertRaises(collector.CollectionError):
            collector.cost_query(client, SUBSCRIPTION, START, END, ["Meter", "ResourceId", "ServiceName"])
        self.assertFalse(client.mock_calls)

    def test_required_columns_and_row_width_are_validated(self):
        malformed = [
            cost_page(columns=["Cost", "UsageQuantity", "UsageDate", "Meter", "ResourceId"]),
            cost_page(rows=[[1, 2]]),
            cost_page(rows=[[1, 2, 20260901, "Meter", RESOURCE_ID, "USD", "extra"]]),
        ]
        for page in malformed:
            with self.subTest(page=page), self.assertRaises(collector.CollectionError):
                self.query([page])

    def test_invalid_numeric_date_and_currency_fail(self):
        for index, value in (
            (0, float("nan")), (0, float("inf")), (0, "not a number"),
            (1, float("-inf")), (1, None), (2, 20260230),
            (2, "not a date"), (5, ""), (5, None),
        ):
            row = [1, 2, 20260901, "Meter", RESOURCE_ID, "USD"]
            row[index] = value
            with self.subTest(index=index, value=value), self.assertRaises(collector.CollectionError):
                self.query([cost_page([row])])

    def test_request_contains_two_groups_and_filter(self):
        client = Mock()
        client.pages.return_value = iter([cost_page(rows=[])])
        extra_filter = {"dimensions": {"name": "ServiceName", "operator": "In", "values": ["Foundry Models"]}}
        collector.cost_query(client, SUBSCRIPTION, START, END, ["Meter", "ResourceId"], extra_filter)
        call = client.pages.call_args
        body = call.args[1] if len(call.args) > 1 else call.kwargs["body"]
        self.assertEqual(body["dataset"]["grouping"], [
            {"type": "Dimension", "name": "Meter"}, {"type": "Dimension", "name": "ResourceId"},
        ])
        self.assertEqual(body["dataset"]["filter"], extra_filter)
        self.assertEqual(body["dataset"]["granularity"], "Daily")


class SpendTests(OfflineTestCase):
    def discovery(self):
        return [{
            "ServiceName": "Foundry Models", "MeterCategory": "Azure OpenAI",
            "UsageDate": "2026-09-01", "Cost": 3, "UsageQuantity": 10, "Currency": "USD",
        }]

    def detail(self, currency="USD"):
        return {
            "Meter": "Input tokens", "ResourceId": RESOURCE_ID.upper(),
            "UsageDate": "2026-09-01", "Cost": 1.5, "UsageQuantity": 5, "Currency": currency,
        }

    def test_two_stage_grouping_currency_and_case_insensitive_tag_join(self):
        resource = dict(ACCOUNT, tags={"dEpArTmEnT": "Research"})
        with patch.object(collector, "cost_query", side_effect=[
            self.discovery(), [self.detail(), self.detail("EUR")],
        ]) as query:
            rows = collector.collect_spend(Mock(), SUBSCRIPTION, START, END, [resource])
        self.assertEqual(len(rows), 2)
        self.assertEqual(query.call_args_list[0].args[4], ["ServiceName", "MeterCategory"])
        self.assertEqual(query.call_args_list[1].args[4], ["Meter", "ResourceId"])
        call = query.call_args_list[1]
        extra_filter = call.args[5] if len(call.args) > 5 else call.kwargs["extra_filter"]
        text = json.dumps(extra_filter)
        self.assertIn("ServiceName", text)
        self.assertIn("MeterCategory", text)
        self.assertIn("Foundry Models", text)
        self.assertIn("Azure OpenAI", text)
        self.assertEqual({row["Currency"] for row in rows}, {"USD", "EUR"})
        for row in rows:
            self.assertEqual(row["ResourceId"], RESOURCE_ID.lower())
            self.assertEqual(row["DepartmentTag"], "Research")
            self.assertEqual(set(row), set(collector.SPEND_HEADERS))

    def test_discovered_pair_is_queried_once_across_dates(self):
        pairs = self.discovery() + [dict(self.discovery()[0], UsageDate="2026-09-02")]
        with patch.object(collector, "cost_query", side_effect=[pairs, [self.detail()]]) as query:
            collector.collect_spend(Mock(), SUBSCRIPTION, START, END, [])
        self.assertEqual(query.call_count, 2)

    def test_duplicate_spend_grain_is_rejected(self):
        with patch.object(collector, "cost_query", side_effect=[
            self.discovery(), [self.detail(), self.detail()],
        ]), self.assertRaises(collector.CollectionError):
            collector.collect_spend(Mock(), SUBSCRIPTION, START, END, [])


class MetricSelectionTests(OfflineTestCase):
    def selected(self, names):
        definitions = [definition(name) for name in names]
        result = collector.select_metrics(definitions)
        for name, selected_definition in result:
            self.assertIn(selected_definition, definitions)
            self.assertEqual(selected_definition["name"]["value"], name)
        return [name for name, _ in result]

    def test_alias_precedence_ignores_definition_order(self):
        names = [
            "TotalTokens", "ProcessedPromptTokens", "InputTokens", "GeneratedTokens", "OutputTokens",
            "TotalCalls", "AzureOpenAIRequests", "ModelRequests",
            "AzureOpenAIProvisionedManagedUtilizationV2", "ProvisionedUtilization",
        ]
        expected = {"InputTokens", "OutputTokens", "ModelRequests", "ProvisionedUtilization"}
        self.assertEqual(set(self.selected(names)), expected)
        self.assertEqual(set(self.selected(list(reversed(names)))), expected)

    def test_legacy_aliases_are_used_when_new_names_absent(self):
        names = ["ProcessedPromptTokens", "GeneratedTokens", "AzureOpenAIRequests",
                 "AzureOpenAIProvisionedManagedUtilizationV2"]
        self.assertEqual(set(self.selected(names)), set(names))

    def test_total_calls_is_last_request_fallback(self):
        self.assertEqual(self.selected(["TotalCalls"]), ["TotalCalls"])
        self.assertEqual(self.selected(["TotalCalls", "AzureOpenAIRequests"]), ["AzureOpenAIRequests"])

    def test_openai_does_not_use_total_calls_as_model_requests(self):
        self.assertEqual(collector.select_metrics([definition("TotalCalls")], "OpenAI"), [])

    def test_total_tokens_fallback_warns_on_stderr(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            self.assertEqual(self.selected(["TotalTokens"]), ["TotalTokens"])
        self.assertTrue(stderr.getvalue().strip())

    def test_total_tokens_never_added_to_partial_prompt_or_output_family(self):
        for available in ("InputTokens", "ProcessedPromptTokens", "OutputTokens", "GeneratedTokens"):
            with self.subTest(available=available):
                self.assertEqual(self.selected(["TotalTokens", available]), [available])

    def test_unknown_metrics_are_not_selected(self):
        self.assertEqual(self.selected(["UnrelatedMetric"]), [])


class MetricParameterTests(OfflineTestCase):
    def test_daily_counter_keeps_deployment_split_and_limit(self):
        params, dimension, field = collector.metric_parameters(
            "InputTokens", definition("InputTokens", ("ModelDeploymentName", "StatusCode")), START, END,
        )
        self.assertEqual(field, "total")
        self.assertEqual(dimension, "ModelDeploymentName")
        self.assertEqual(params["aggregation"].lower(), "total")
        self.assertEqual(params["interval"], "P1D")
        self.assertEqual(str(params["top"]), "10000")
        self.assertEqual(params["$filter"], "ModelDeploymentName eq '*'")
        # Azure rollupby would collapse deployments into one series, losing the requested split.
        self.assertNotIn("rollupby", params)
        self.assertEqual(params["timespan"], "2026-09-01T00:00:00Z/2026-09-03T00:00:00Z")

    def test_utilization_requests_average_not_total(self):
        for name in ("ProvisionedUtilization", "AzureOpenAIProvisionedManagedUtilizationV2"):
            with self.subTest(name=name):
                params, _, field = collector.metric_parameters(name, definition(name), START, END)
                self.assertEqual(field, "average")
                self.assertEqual(params["aggregation"].lower(), "average")

    def test_missing_deployment_dimension_returns_none(self):
        _, dimension, _ = collector.metric_parameters("InputTokens", definition("InputTokens", ()), START, END)
        self.assertIsNone(dimension)

    def test_unsupported_aggregation_rejected(self):
        with self.assertRaises(collector.CollectionError):
            collector.metric_parameters("InputTokens", definition("InputTokens", aggregation="Average"), START, END)


class MetricPointTests(OfflineTestCase):
    def points(self, payload, name="InputTokens", field="total", dimension="ModelDeploymentName"):
        return list(collector.metric_points(payload, name, dimension, field, ACCOUNT, START, END))

    def test_zero_is_kept_and_fields_match_csv_contract(self):
        rows = self.points(metric_payload())
        self.assertEqual([row["Value"] for row in rows], [0, 42])
        self.assertEqual([row["Date"] for row in rows], ["2026-09-01", "2026-09-02"])
        for row in rows:
            self.assertEqual(row["Deployment"], "chat")
            self.assertEqual(row["ResourceName"], "ExampleAI")
            self.assertEqual(row["Metric"], "InputTokens")
            self.assertEqual(set(row), set(collector.TOKEN_HEADERS))

    def test_missing_and_null_are_skipped_without_no_traffic_claim(self):
        stderr, stdout = io.StringIO(), io.StringIO()
        with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(stdout):
            rows = self.points(metric_payload([
                {"timeStamp": "2026-09-01T00:00:00Z", "total": None},
                {"timeStamp": "2026-09-02T00:00:00Z"},
            ]))
        self.assertEqual(rows, [])
        self.assertNotIn("genuinely no traffic", (stderr.getvalue() + stdout.getvalue()).lower())

    def test_exclusive_end_midnight_is_skipped(self):
        rows = self.points(metric_payload([
            {"timeStamp": "2026-09-02T00:00:00Z", "total": 2},
            {"timeStamp": "2026-09-03T00:00:00Z", "total": 99},
        ]))
        self.assertEqual([row["Value"] for row in rows], [2])

    def test_average_utilization_preserves_zero(self):
        payload = metric_payload(
            [{"timeStamp": "2026-09-01T00:00:00Z", "average": 0}],
            name="ProvisionedUtilization",
        )
        self.assertEqual(self.points(payload, "ProvisionedUtilization", "average")[0]["Value"], 0)

    def test_nonfinite_or_nonnumeric_metric_fails(self):
        for value in (float("nan"), float("inf"), float("-inf"), "bad"):
            with self.subTest(value=value), self.assertRaises(collector.CollectionError):
                self.points(metric_payload([{"timeStamp": "2026-09-01T00:00:00Z", "total": value}]))

    def test_wrong_aggregation_is_not_silently_used(self):
        with self.assertRaises(collector.CollectionError):
            self.points(metric_payload([{"timeStamp": "2026-09-01T00:00:00Z", "average": 5}]))

    def test_wrong_timegrain_fails(self):
        payload = metric_payload()
        payload["interval"] = "PT1H"
        with self.assertRaises(collector.CollectionError):
            self.points(payload)

    def test_api_and_metric_errors_fail(self):
        metric_error = metric_payload()
        metric_error["value"][0]["errorCode"] = "BadRequest"
        metric_error["value"][0]["errorMessage"] = "unsupported metric"
        for payload in ({"error": {"code": "Forbidden", "message": "denied"}}, metric_error):
            with self.subTest(payload=payload), self.assertRaises(collector.CollectionError):
                self.points(payload)

    def test_unexpected_dimension_split_fails(self):
        payload = metric_payload(dimensions=[
            {"name": {"value": "ModelDeploymentName"}, "value": "chat"},
            {"name": {"value": "StatusCode"}, "value": "200"},
        ])
        with self.assertRaises(collector.CollectionError):
            self.points(payload)

    def test_duplicate_series_and_duplicate_points_fail(self):
        duplicate_series = metric_payload()
        series = duplicate_series["value"][0]["timeseries"]
        series.append(copy.deepcopy(series[0]))
        duplicate_points = metric_payload()
        points = duplicate_points["value"][0]["timeseries"][0]["data"]
        points.append(copy.deepcopy(points[0]))
        for payload in (duplicate_series, duplicate_points):
            with self.subTest(payload=payload), self.assertRaises(collector.CollectionError):
                self.points(payload)


class CollectionAndMainTests(OfflineTestCase):
    def datasets(self):
        return {
            "AzureAiSpendDaily.csv": (collector.SPEND_HEADERS, []),
            "AzureAiTokensDaily.csv": (collector.TOKEN_HEADERS, []),
            "AzureAiDeployments.csv": (collector.DEPLOYMENT_HEADERS, []),
        }

    def test_empty_collection_returns_all_three_dataset_schemas(self):
        client = Mock()
        client.run.return_value = []
        client.list.return_value = []
        client.pages.side_effect = lambda *args, **kwargs: iter([{"value": []}])
        with patch.object(collector, "collect_spend", return_value=[]):
            result = collector.collect(client, SUBSCRIPTION, START, END)
        self.assertEqual(set(result), FILENAMES)
        for filename, (headers, rows) in result.items():
            self.assertEqual(list(headers), list(self.datasets()[filename][0]))
            self.assertEqual(rows, [])

    def test_help_exits_zero_without_azure(self):
        with patch.object(collector, "AzureCLI") as azure, contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit) as caught:
                collector.main(["--help"])
        self.assertEqual(caught.exception.code, 0)
        azure.assert_not_called()

    def test_invalid_days_rejected_without_azure(self):
        for days in ("0", "91", "-1", "not-an-integer"):
            with self.subTest(days=days), patch.object(collector, "AzureCLI") as azure:
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
                    collector.main(["ignored-output", "--days", days])
                self.assertEqual(caught.exception.code, 2)
                azure.assert_not_called()

    def test_explicit_subscription_and_days_collect_before_publish(self):
        datasets = self.datasets()
        events = []
        with patch.object(collector, "AzureCLI") as azure:
            client = azure.return_value
            with patch.object(collector, "collect", side_effect=lambda *args: events.append(("collect", args)) or datasets):
                with patch.object(collector, "keep_older",
                                  side_effect=lambda *args: events.append(("keep_older", args)) or {}):
                    with patch.object(collector, "publish", side_effect=lambda *args: events.append(("publish", args))):
                        result = collector.main(["ignored-output", "--subscription", SUBSCRIPTION, "--days", "7"])
        self.assertEqual(result, 0)
        self.assertEqual([event[0] for event in events], ["collect", "keep_older", "publish"])
        _, args = events[0]
        self.assertIs(args[0], client)
        self.assertEqual(args[1], SUBSCRIPTION)
        self.assertEqual((args[3] - args[2]).days, 7)
        self.assertEqual(events[1][1], (Path("ignored-output"), datasets, args[2]))
        self.assertEqual(events[2][1], (Path("ignored-output"), datasets))
        client.run.assert_not_called()

    def test_default_subscription_and_ninety_day_window(self):
        with patch.object(collector, "AzureCLI") as azure:
            azure.return_value.run.return_value = {"id": SUBSCRIPTION}
            with patch.object(collector, "collect", return_value=self.datasets()) as collect:
                with patch.object(collector, "keep_older", return_value={}), patch.object(collector, "publish"):
                    self.assertEqual(collector.main(["ignored-output"]), 0)
        command = azure.return_value.run.call_args.args[0]
        self.assertEqual(command[:2], ["account", "show"])
        self.assertEqual(collect.call_args.args[1], SUBSCRIPTION)
        self.assertEqual((collect.call_args.args[3] - collect.call_args.args[2]).days, 90)

    def test_collection_failure_never_opens_or_overwrites_outputs(self):
        stderr = io.StringIO()
        with patch.object(collector, "AzureCLI"):
            with patch.object(collector, "collect", side_effect=collector.CollectionError("collection failed")):
                with patch.object(collector, "publish") as publish:
                    with patch.object(Path, "open") as open_file, patch("os.replace") as replace:
                        with contextlib.redirect_stderr(stderr):
                            result = collector.main(["existing-output", "--subscription", SUBSCRIPTION])
        self.assertEqual(result, 1)
        self.assertIn("collection failed", stderr.getvalue())
        publish.assert_not_called()
        open_file.assert_not_called()
        replace.assert_not_called()


class PublicationTests(OfflineTestCase):
    def setUp(self):
        super().setUp()
        self.outdir = MODULE_PATH.parent / "mock-output-not-created"
        self.disk = MemoryCsvFiles(self.outdir, FILENAMES)
        self.disk.install(self)
        self.datasets = {
            filename: (["Label", "Value"], [{"Label": 'comma, quote " and \u00e9', "Value": 0}])
            for filename in sorted(FILENAMES)
        }

    def test_all_csvs_staged_before_any_atomic_replace(self):
        collector.publish(self.outdir, self.datasets)
        replacements = [event for event in self.disk.events if event[0] == "replace"]
        self.assertEqual({destination for _, destination in replacements},
                         {str(self.outdir / name) for name in FILENAMES})
        self.assertEqual(len(replacements), 3)
        first_replace = next(index for index, event in enumerate(self.disk.events) if event[0] == "replace")
        closed = {filename for operation, filename in self.disk.events[:first_replace] if operation == "close"}
        self.assertTrue({source for source, _ in self.disk.replacements}.issubset(closed))
        for filename in FILENAMES:
            text = self.disk.files[str(self.outdir / filename)]
            reader = csv.DictReader(io.StringIO(text))
            self.assertEqual(reader.fieldnames, ["Label", "Value"])
            self.assertEqual(list(reader), [{"Label": 'comma, quote " and \u00e9', "Value": "0"}])
        for operation, filename in self.disk.events:
            if operation == "open":
                self.assertNotIn(filename, {str(self.outdir / name) for name in FILENAMES})

    def test_empty_outputs_still_have_headers(self):
        collector.publish(self.outdir, {
            "AzureAiSpendDaily.csv": (collector.SPEND_HEADERS, []),
            "AzureAiTokensDaily.csv": (collector.TOKEN_HEADERS, []),
            "AzureAiDeployments.csv": (collector.DEPLOYMENT_HEADERS, []),
        })
        expected = {
            "AzureAiSpendDaily.csv": collector.SPEND_HEADERS,
            "AzureAiTokensDaily.csv": collector.TOKEN_HEADERS,
            "AzureAiDeployments.csv": collector.DEPLOYMENT_HEADERS,
        }
        for filename, headers in expected.items():
            rows = list(csv.reader(io.StringIO(self.disk.files[str(self.outdir / filename)])))
            self.assertEqual(rows, [list(headers)])

    def test_staging_failure_leaves_every_existing_output_unchanged(self):
        original = dict(self.disk.files)
        self.disk.fail_on_write = 2
        with self.assertRaises((OSError, collector.CollectionError)):
            collector.publish(self.outdir, self.datasets)
        self.assertFalse(any(event[0] == "replace" for event in self.disk.events))
        for filename, contents in original.items():
            self.assertEqual(self.disk.files[filename], contents)

    def test_replace_failure_is_not_reported_as_success(self):
        with patch.object(os, "replace", side_effect=OSError("replace denied")):
            with self.assertRaises((OSError, collector.CollectionError)):
                collector.publish(self.outdir, self.datasets)

    def test_partial_replace_failure_reports_mixed_batch(self):
        def replace(source, destination):
            if self.disk.replacements:
                raise OSError("second replacement denied")
            self.disk.replace(source, destination)
        with patch.object(os, "replace", side_effect=replace):
            with self.assertRaisesRegex(collector.CollectionError, "Publication partially completed"):
                collector.publish(self.outdir, self.datasets)
        self.assertEqual(len(self.disk.replacements), 1)


class ReloadTests(unittest.TestCase):
    """A reload keeps older rows. These use real files, but only in a new temporary folder."""

    def setUp(self):
        self.enterContext(patch.object(collector.subprocess, "run",
                                       side_effect=AssertionError("Unmocked Azure call")))
        self.outdir = Path(self.enterContext(tempfile.TemporaryDirectory()))

    def row(self, filename, **values):
        return {h: values.get(h, "") for h in HEADERS[filename]}

    def store(self, filename, rows):
        collector.publish(self.outdir, {filename: (HEADERS[filename], rows)})

    def read(self, filename, outdir=None):
        with ((outdir or self.outdir) / filename).open(encoding="utf-8", newline="") as handle:
            return list(csv.DictReader(handle))

    def files(self, outdir=None):
        return {p.name: p.read_bytes() for p in (outdir or self.outdir).iterdir()}

    def main(self, seen, outdir=None):
        def collect(client, subscription, start, end):
            self.assertEqual(subscription, SUBSCRIPTION)
            seen.append(start)
            return {SPEND: (HEADERS[SPEND], [self.row(SPEND, UsageDate=start, Meter="new")]),
                    TOKENS: (HEADERS[TOKENS], []), INVENTORY: (HEADERS[INVENTORY], [])}

        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(collector, "AzureCLI"), patch.object(collector, "collect", side_effect=collect):
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                result = collector.main([str(outdir or self.outdir), "--subscription", SUBSCRIPTION])
        return result, stdout.getvalue(), stderr.getvalue()

    def test_keeps_rows_older_than_the_window_and_replaces_the_rest(self):
        self.store(SPEND, [self.row(SPEND, UsageDate=d, Meter=f"old {d or 'undated'}")
                           for d in ("2026-06-01", "2026-06-11", "2026-06-12", "")])
        self.store(INVENTORY, [self.row(INVENTORY, Deployment="retired")])
        datasets = {
            SPEND: (HEADERS[SPEND], [self.row(SPEND, UsageDate="2026-06-12", Meter="new"),
                                     self.row(SPEND, UsageDate="2026-06-10", Meter="before the window"),
                                     self.row(SPEND, UsageDate="", Meter="new undated")]),
            TOKENS: (HEADERS[TOKENS], [self.row(TOKENS, Date=JUNE_12, Metric="new")]),
            INVENTORY: (HEADERS[INVENTORY], [self.row(INVENTORY, Deployment="current")]),
        }
        self.assertEqual(collector.keep_older(self.outdir, datasets, JUNE_12), {SPEND: 2, TOKENS: 0})
        self.assertEqual([r["Meter"] for r in datasets[SPEND][1]],
                         ["old 2026-06-01", "old 2026-06-11", "new", "new undated"])
        self.assertEqual([r["Metric"] for r in datasets[TOKENS][1]], ["new"])
        self.assertEqual([r["Deployment"] for r in datasets[INVENTORY][1]], ["current"])
        collector.publish(self.outdir, datasets)
        self.assertEqual([(r["UsageDate"], r["Meter"]) for r in self.read(SPEND)], [
            ("2026-06-01", "old 2026-06-01"), ("2026-06-11", "old 2026-06-11"),
            ("2026-06-12", "new"), ("", "new undated")])
        self.assertEqual([r["Date"] for r in self.read(TOKENS)], ["2026-06-12"])
        self.assertEqual([r["Deployment"] for r in self.read(INVENTORY)], ["current"])

    def test_daily_runs_and_a_smaller_window_build_up_history(self):
        def run(start, days):
            window = [(start + timedelta(days=i)).isoformat() for i in range(days)]
            datasets = {
                SPEND: (HEADERS[SPEND], [self.row(SPEND, UsageDate=d, Meter=f"run {start}") for d in window]),
                TOKENS: (HEADERS[TOKENS], [self.row(TOKENS, Date=d, Metric=f"run {start}") for d in window]),
                INVENTORY: (HEADERS[INVENTORY], []),
            }
            kept = collector.keep_older(self.outdir, datasets, start)
            collector.publish(self.outdir, datasets)
            return kept

        self.assertEqual(run(date(2026, 6, 1), 3), {SPEND: 0, TOKENS: 0})
        self.assertEqual(run(date(2026, 6, 2), 3), {SPEND: 1, TOKENS: 1})  # the next day
        self.assertEqual(run(date(2026, 6, 4), 1), {SPEND: 3, TOKENS: 3})  # then --days 1
        expected = [("2026-06-01", "run 2026-06-01"), ("2026-06-02", "run 2026-06-02"),
                    ("2026-06-03", "run 2026-06-02"), ("2026-06-04", "run 2026-06-04")]
        self.assertEqual([(r["UsageDate"], r["Meter"]) for r in self.read(SPEND)], expected)
        self.assertEqual([(r["Date"], r["Metric"]) for r in self.read(TOKENS)], expected)

    def test_a_rerun_with_the_same_rows_changes_nothing(self):
        self.store(SPEND, [self.row(SPEND, UsageDate="2026-06-01", Meter="old", Cost=1.5)])

        def run():
            datasets = {
                SPEND: (HEADERS[SPEND], [self.row(SPEND, UsageDate="2026-06-12", Meter="new", Cost=0.1 + 0.2)]),
                TOKENS: (HEADERS[TOKENS], [self.row(TOKENS, Date="2026-06-13", Metric="InputTokens", Value=42.0)]),
                INVENTORY: (HEADERS[INVENTORY], [self.row(INVENTORY, Deployment="chat", Capacity=10)]),
            }
            collector.keep_older(self.outdir, datasets, JUNE_12)
            collector.publish(self.outdir, datasets)
            return self.files()

        first = run()
        self.assertEqual(run(), first)
        self.assertEqual([r["Meter"] for r in self.read(SPEND)], ["old", "new"])

    def test_an_unreadable_stored_csv_fails_before_anything_is_published(self):
        cases = [
            (b"\xff\xfeUsageDate\r\n", "AzureAiSpendDaily.csv can't be read ("),
            (b"UsageDate,Meter\r\n06/12/2026,m\r\n",
             "AzureAiSpendDaily.csv line 2: UsageDate '06/12/2026' isn't a yyyy-mm-dd date"),
            (b"UsageDate,Meter\r\n2026-06-01,m\r\n2026-06-02,m,extra\r\n",
             "AzureAiSpendDaily.csv line 3 has the wrong number of fields"),
            (b"UsageDate,Meter\r\n2026-06-01\r\n", "AzureAiSpendDaily.csv line 2 has the wrong number of fields"),
            (b"Day,Meter\r\n2026-06-01,m\r\n", "AzureAiSpendDaily.csv has no UsageDate column"),
            (None, "AzureAiSpendDaily.csv can't be read ("),  # a folder where the CSV should be
        ]
        for index, (content, message) in enumerate(cases):
            with self.subTest(message=message):
                outdir = self.outdir / f"case {index}"
                outdir.mkdir()
                if content is None:
                    (outdir / SPEND).mkdir()
                else:
                    (outdir / SPEND).write_bytes(content)
                datasets = {SPEND: (HEADERS[SPEND], [self.row(SPEND, UsageDate="2026-06-12")])}
                with self.assertRaises(collector.CollectionError) as caught:
                    collector.keep_older(outdir, datasets, JUNE_12)
                self.assertIn(message, str(caught.exception))
                self.assertTrue(str(caught.exception).endswith(NOTHING_PUBLISHED), str(caught.exception))

    def test_stored_rows(self):
        path = self.outdir / SPEND
        self.assertEqual(collector.stored_rows(path, HEADERS[SPEND], "UsageDate"), [])  # no file yet
        path.write_bytes(b"")
        self.assertEqual(collector.stored_rows(path, HEADERS[SPEND], "UsageDate"), [])
        path.write_bytes("\ufeffUsageDate,Meter,Retired\r\n2026-06-01,m,x\r\n,blank,y\r\n".encode("utf-8"))
        rows = collector.stored_rows(path, HEADERS[SPEND], "UsageDate")
        self.assertEqual([list(r) for r in rows], [HEADERS[SPEND]] * 2)  # a missing column is blank; extra ones go
        self.assertEqual([(r["UsageDate"], r["Meter"], r["Cost"]) for r in rows],
                         [("2026-06-01", "m", ""), ("", "blank", "")])

    def test_as_day(self):
        for value, expected in [("2026-06-12", JUNE_12), ("20260612", JUNE_12), (JUNE_12, JUNE_12),
                                ("2026-06-12T00:00:00", JUNE_12), ("", None), (None, None),
                                ("06/12/2026", None), ("yesterday", None)]:
            with self.subTest(value=value):
                self.assertEqual(collector.as_day(value), expected)

    def test_the_deployment_inventory_is_replaced_whole_and_never_read(self):
        self.assertEqual(collector.RELOAD, {SPEND: "UsageDate", TOKENS: "Date"})
        for filename, column in collector.RELOAD.items():
            self.assertIn(column, HEADERS[filename])
        (self.outdir / INVENTORY).write_bytes(b"not, a\r\n\xff\xfe valid inventory\r\n")
        datasets = {INVENTORY: (HEADERS[INVENTORY], [self.row(INVENTORY, Deployment="current")])}
        self.assertEqual(collector.keep_older(self.outdir, datasets, JUNE_12), {})
        collector.publish(self.outdir, datasets)
        self.assertEqual([r["Deployment"] for r in self.read(INVENTORY)], ["current"])

    def test_main_keeps_older_rows(self):
        self.store(SPEND, [self.row(SPEND, UsageDate="2000-01-03", Meter="older"),
                           self.row(SPEND, UsageDate="2999-01-01", Meter="replaced")])
        seen = []
        result, out, _ = self.main(seen)
        self.assertEqual(result, 0)
        self.assertIn(f"Wrote {SPEND}: 2 rows (1 older rows kept)\n", out)
        self.assertIn(f"Wrote {TOKENS}: 0 rows\n", out)
        self.assertEqual([(r["UsageDate"], r["Meter"]) for r in self.read(SPEND)],
                         [("2000-01-03", "older"), (str(seen[0]), "new")])

    def test_main_publishes_nothing_when_a_stored_csv_is_unreadable(self):
        self.store(SPEND, [self.row(SPEND, UsageDate="2000-01-03", Meter="older")])
        (self.outdir / TOKENS).write_bytes(b"Date,Metric\r\nyesterday,x\r\n")
        before = self.files()
        result, out, err = self.main([])
        self.assertEqual(result, 1)
        self.assertIn("ERROR: AzureAiTokensDaily.csv line 2: Date 'yesterday' isn't a yyyy-mm-dd date"
                      + NOTHING_PUBLISHED, err)
        self.assertNotIn("Wrote", out)
        self.assertEqual(self.files(), before)

    def test_first_run_with_no_stored_files(self):
        outdir = self.outdir / "Data"
        seen = []
        result, out, _ = self.main(seen, outdir)
        self.assertEqual(result, 0)
        self.assertIn(f"Wrote {SPEND}: 1 rows\n", out)
        self.assertNotIn("older rows kept", out)
        self.assertEqual(set(self.files(outdir)), set(HEADERS))
        self.assertEqual([(r["UsageDate"], r["Meter"]) for r in self.read(SPEND, outdir)],
                         [(str(seen[0]), "new")])
        self.assertEqual(self.read(TOKENS, outdir), [])


if __name__ == "__main__":
    unittest.main()
