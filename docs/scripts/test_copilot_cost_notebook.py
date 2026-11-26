import json
import unittest
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import UUID

import sync_copilot_cost_notebook as generated


class Frame:
    def __init__(self, spark, rows, schema):
        self.spark, self.rows = spark, list(rows)
        self.dtypes = list(schema)

    @property
    def write(self):
        return Writer(self.spark, self)

    def count(self):
        return len(self.rows)


class Writer:
    def __init__(self, spark, frame):
        self.spark, self.frame, self.predicate = spark, frame, None

    def format(self, _):
        return self

    def mode(self, _):
        return self

    def option(self, name, value):
        if name == "replaceWhere":
            self.predicate = value
        return self

    def saveAsTable(self, table):
        old = self.spark.tables.get(table)
        rows = list(self.frame.rows)
        if old is not None and self.predicate:
            column = self.predicate.split("`")[1]
            cutoff = date.fromisoformat(self.predicate.split("'")[1])
            index = [name for name, _ in old.dtypes].index(column)
            rows = [r for r in old.rows if r[index] is not None and r[index] < cutoff] + rows
        self.spark.tables[table] = Frame(self.spark, rows, self.frame.dtypes)
        self.spark.writes.append(table)


class Spark:
    def __init__(self):
        self.tables, self.writes = {}, []
        self.catalog = SimpleNamespace(tableExists=lambda name: name in self.tables)

    def createDataFrame(self, rows, schema):
        return Frame(self, rows, schema)

    def table(self, name):
        return self.tables[name]


class NotebookTests(unittest.TestCase):
    def test_notebook_is_generated_and_cells_compile(self):
        book = json.loads(generated.NOTEBOOK.read_text(encoding="utf-8"))
        self.assertEqual(book, generated.notebook())
        for cell in book["cells"]:
            if cell["cell_type"] == "code":
                compile("".join(cell["source"]), "notebook", "exec")

    def context(self, spark, collector):
        item = SimpleNamespace
        return {
            "TENANT_ID": "00000000-0000-0000-0000-000000000001",
            "CLIENT_ID": "00000000-0000-0000-0000-000000000002",
            "KEY_VAULT_URL": "https://example.vault.azure.net/",
            "CLIENT_SECRET_NAME": "test", "DAYS": 14,
            "UUID": UUID, "datetime": datetime, "timedelta": timedelta, "timezone": timezone,
            "date": date, "GRAPH": "https://graph.microsoft.com",
            "notebookutils": item(credentials=item(getSecret=lambda *_: "test")),
            "requests": item(post=lambda *a, **k: item(status_code=200, json=lambda: {"access_token": "test"})),
            "app_token": lambda value: value["accessToken"], "GraphClient": lambda token: token,
            "collect": collector, "CollectionError": RuntimeError, "spark": spark,
            "DateType": lambda: "date", "DoubleType": lambda: "double",
            "StringType": lambda: "string", "StructField": lambda name, kind, _: (name, kind),
            "StructType": lambda fields: fields,
            "SERVICE_FILE": "services", "FUNDING_FILE": "funding", "BALANCE_FILE": "balance",
        }

    @staticmethod
    def datasets(_client, start, _end, _now):
        return {
            "services": (None, [{"Date": start.isoformat(), "ServiceId": "service",
                                  "ConsumedQuantity": 3, "Unit": "copilotCredit"}]),
            "funding": (None, [{"Month": start.replace(day=1).isoformat(), "FundingClass": "prepaid",
                                "ConsumedQuantity": 3, "Unit": "copilotCredit", "LatestSourceDateTime": ""}]),
            "balance": (None, [{"AsOfUTC": "now", "BillingMethod": "prepaid", "PurchasedQuantity": "",
                                "ConsumedQuantity": 3, "RemainingQuantity": "", "Unit": "copilotCredit",
                                "LastModifiedDateTime": ""}]),
        }

    def test_reloads_windows_preserving_old_history_and_replaces_snapshot(self):
        spark = Spark()
        context = self.context(spark, self.datasets)
        exec(generated.RUN, context)
        service = spark.table("copilot_cost_service_daily")
        today = datetime.now(timezone.utc).date()
        old_day = today - timedelta(days=100)
        service.rows.append((old_day, "older", 2.0, "copilotCredit"))
        service.rows.append((today - timedelta(days=2), "stale", 99.0, "copilotCredit"))
        spark.table("copilot_cost_balance").rows.append(("old", "stale", None, 1.0, None, "copilotCredit", ""))
        exec(generated.RUN, context)
        self.assertEqual({row[1] for row in spark.table("copilot_cost_service_daily").rows}, {"older", "service"})
        self.assertEqual([row[1] for row in spark.table("copilot_cost_balance").rows], ["prepaid"])

    def test_collection_or_schema_failure_prevents_all_writes(self):
        spark = Spark()
        collector = Mock(side_effect=RuntimeError("unavailable"))
        with self.assertRaisesRegex(RuntimeError, "unavailable"):
            exec(generated.RUN, self.context(spark, collector))
        self.assertEqual(spark.writes, [])
        spark.tables["copilot_cost_balance"] = Frame(spark, [], [("ConsumedQuantity", "string")])
        with self.assertRaisesRegex(RuntimeError, "nothing was written"):
            exec(generated.RUN, self.context(spark, self.datasets))
        self.assertEqual(spark.writes, [])

    def test_empty_success_clears_only_the_requested_window(self):
        spark = Spark()
        exec(generated.RUN, self.context(spark, self.datasets))
        today = datetime.now(timezone.utc).date()
        old = today - timedelta(days=100)
        spark.table("copilot_cost_service_daily").rows.append((old, "older", 2.0, "copilotCredit"))

        def empty(*_):
            return {key: (None, []) for key in ("services", "funding", "balance")}

        exec(generated.RUN, self.context(spark, empty))
        self.assertEqual([row[1] for row in spark.table("copilot_cost_service_daily").rows], ["older"])
        self.assertEqual(spark.table("copilot_cost_balance").rows, [])


if __name__ == "__main__":
    unittest.main()
