#!/usr/bin/env python3
"""Generate the Fabric Cost Management notebook from the shared Graph collector."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COLLECTOR = ROOT / "1. Local CSV" / "pull_copilot_cost_management.py"
NOTEBOOK = ROOT / "2. Fabric" / "notebooks" / "Ingest_Copilot_Cost_Management.ipynb"

CONFIG = '''# Attach the destination Lakehouse and configure the app and Key Vault before running.
TENANT_ID = "00000000-0000-0000-0000-000000000000"
CLIENT_ID = "00000000-0000-0000-0000-000000000000"
KEY_VAULT_URL = "https://<your-vault>.vault.azure.net/"
CLIENT_SECRET_NAME = "consumption-central-azure-client-secret"
DAYS = 14  # Completed UTC days, from 1 to 366.
'''

IMPORTS = '''import base64
import json
import math
import time
from datetime import date, datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import UUID
import requests
from pyspark.sql.types import DateType, DoubleType, StringType, StructField, StructType

class CollectionError(Exception):
    pass
'''

RUN = '''for identifier in (TENANT_ID, CLIENT_ID):
    if UUID(identifier).int == 0:
        raise ValueError("Configure the tenant and application client IDs before running")
if not isinstance(DAYS, int) or isinstance(DAYS, bool) or not 1 <= DAYS <= 366:
    raise ValueError("DAYS must be between 1 and 366")
secret = notebookutils.credentials.getSecret(KEY_VAULT_URL, CLIENT_SECRET_NAME)
response = requests.post(
    f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token",
    data={"grant_type": "client_credentials", "client_id": CLIENT_ID,
          "client_secret": secret, "scope": GRAPH + "/.default"},
    timeout=90, allow_redirects=False)
if response.status_code != 200:
    raise CollectionError(f"Graph token request failed with HTTP {response.status_code}")
try:
    token = response.json().get("access_token")
except ValueError as exc:
    raise CollectionError("Graph token response was not JSON") from exc
token = app_token({"accessToken": token})
del secret, response

now = datetime.now(timezone.utc)
end = now.date()
start = end - timedelta(days=DAYS)
datasets = collect(GraphClient(token), start, end, now.isoformat())
del token

def schema(fields):
    return StructType([StructField(name, kind, True) for name, kind in fields])

service_schema = schema([("Date", DateType()), ("ServiceId", StringType()),
                         ("ConsumedQuantity", DoubleType()), ("Unit", StringType())])
funding_schema = schema([("Month", DateType()), ("FundingClass", StringType()),
                         ("ConsumedQuantity", DoubleType()), ("Unit", StringType()),
                         ("LatestSourceDateTime", StringType())])
balance_schema = schema([("AsOfUTC", StringType()), ("BillingMethod", StringType()),
                         ("PurchasedQuantity", DoubleType()), ("ConsumedQuantity", DoubleType()),
                         ("RemainingQuantity", DoubleType()), ("Unit", StringType()),
                         ("LastModifiedDateTime", StringType())])

def number(value):
    return None if value == "" else float(value)

services = [(date.fromisoformat(r["Date"]), r["ServiceId"], number(r["ConsumedQuantity"]), r["Unit"])
            for r in datasets[SERVICE_FILE][1]]
funding = [(date.fromisoformat(r["Month"]), r["FundingClass"], number(r["ConsumedQuantity"]),
            r["Unit"], r["LatestSourceDateTime"]) for r in datasets[FUNDING_FILE][1]]
balances = [(r["AsOfUTC"], r["BillingMethod"], number(r["PurchasedQuantity"]),
             number(r["ConsumedQuantity"]), number(r["RemainingQuantity"]), r["Unit"],
             r["LastModifiedDateTime"]) for r in datasets[BALANCE_FILE][1]]
writes = [
    ("copilot_cost_service_daily", spark.createDataFrame(services, service_schema), "Date", start),
    ("copilot_cost_funding_monthly", spark.createDataFrame(funding, funding_schema), "Month", start.replace(day=1)),
    ("copilot_cost_balance", spark.createDataFrame(balances, balance_schema), None, None),
]

# Check every existing table before the first write. Each table write is atomic, but the
# three tables are not one transaction. If a write fails, stop refresh and rerun the notebook.
for table, frame, column, cut in writes:
    if spark.catalog.tableExists(table):
        stored = {name.lower(): kind for name, kind in spark.table(table).dtypes}
        for name, kind in frame.dtypes:
            if name.lower() in stored and stored[name.lower()] != kind:
                raise CollectionError(f"Incompatible type for {table}.{name}; nothing was written")

for table, frame, column, cut in writes:
    exists = spark.catalog.tableExists(table)
    if not exists:
        frame.write.format("delta").saveAsTable(table)
    elif column:
        predicate = f"`{column}` >= DATE '{cut.isoformat()}' OR `{column}` IS NULL"
        (frame.write.format("delta").mode("overwrite").option("replaceWhere", predicate)
         .option("mergeSchema", "true").saveAsTable(table))
    else:
        frame.write.format("delta").mode("overwrite").option("mergeSchema", "true").saveAsTable(table)
    print(f"Updated {table}: {frame.count():,} rows")
print("Service usage, funding usage and balance are separate credit views; do not add them together.")
'''


def notebook():
    collector = COLLECTOR.read_text(encoding="utf-8")
    shared = collector.split('GRAPH = ', 1)[1].split('\ndef preserve_history(', 1)[0]
    shared = 'GRAPH = ' + shared

    def cell(kind, text):
        result = {"cell_type": kind, "metadata": {}, "source": text.splitlines(keepends=True)}
        if kind == "code":
            result.update({"outputs": [], "execution_count": None})
        return result

    return {
        "cells": [
            cell("markdown", "# Copilot Cost Management (Graph beta)\n\n"
                 "Opt in only after granting application permission and attaching a Lakehouse. "
                 "The beta API is not supported for production use.\n"),
            cell("code", CONFIG),
            cell("code", IMPORTS + "\n" + shared.rstrip() + "\n"),
            cell("code", RUN),
        ],
        "metadata": {"kernelspec": {"display_name": "Synapse PySpark", "name": "synapse_pyspark"},
                     "language_info": {"name": "python"}},
        "nbformat": 4,
        "nbformat_minor": 5,
    }


def sync():
    content = json.dumps(notebook(), indent=1, ensure_ascii=False) + "\n"
    if not NOTEBOOK.exists() or NOTEBOOK.read_text(encoding="utf-8") != content:
        NOTEBOOK.parent.mkdir(parents=True, exist_ok=True)
        NOTEBOOK.write_text(content, encoding="utf-8", newline="\n")


if __name__ == "__main__":
    sync()
