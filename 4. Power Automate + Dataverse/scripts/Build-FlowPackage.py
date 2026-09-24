"""Generate the Power Automate import package for the Dataverse path.

Power Automate has no supported way to author a flow from source, so this emits
a legacy import package: a zip holding the flow definitions plus the manifest
that the importer reads. That keeps the flows reviewable as text in the repo
instead of as an opaque binary nobody can diff.

Each flow does the same three things: read a window of days from a billing API,
shape each row to the column names in `dataverse-schema.json`, and upsert it to
Dataverse keyed on `cc_rowkey`. Upserting on a deterministic key is what makes a
re-run safe - a day that is restated upstream overwrites itself instead of being
counted twice.

    python Build-FlowPackage.py            # write flows/definitions/*.json
    python Build-FlowPackage.py --package  # also zip it for import

Not every table has an API behind it. `studio_user` and `viva_spending_policy`
have none, so no flow here fills them; see the README.
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid
import zipfile
from pathlib import Path

PATH4 = Path(__file__).resolve().parents[1]
SCHEMA_FILE = PATH4 / "dataverse-schema.json"
FLOWS = PATH4 / "flows"
DEFINITIONS = FLOWS / "definitions"
PACKAGE = FLOWS / "ConsumptionCentral-Dataverse.zip"

# A fixed namespace, so re-running produces the same ids and an import updates
# the existing flows rather than creating a second copy of each.
NAMESPACE = uuid.UUID("6f1c0b4e-7a52-4c1e-9c3f-2d8b5a4e9f10")

SECRET_NAMES = {
    "ClientSecret": "consumption-central-client-secret",
    "GitHubToken": "consumption-central-github-token",
}

# Each feed: which Dataverse table it fills, the API it reads, and how far back
# a normal run goes. RESTATE is the trailing window a daily run rewrites,
# because billing APIs revise recent days after first publishing them.
FEEDS = [
    {
        "name": "Studio Consumption",
        "table": "studio_tenant_daily",
        "scope": "https://api.powerplatform.com/.default",
        "host": "api.powerplatform.com",
        "path": "/licensing/entitlements/MCSMessages/resources",
        "query": {"api-version": "2024-10-01", "pageSize": "5000"},
        "restate": 7,
        "backfill": 180,
    },
    {
        "name": "Studio Agents",
        "table": "studio_agent",
        "scope": "https://api.powerplatform.com/.default",
        "host": "api.powerplatform.com",
        "path": "/licensing/entitlements/MCSMessages/resources",
        "query": {"api-version": "2024-10-01", "pageSize": "5000",
                  "includeFields": "tags"},
        "restate": 7,
        "backfill": 180,
    },
    {
        "name": "Azure AI Spend",
        "table": "azure_ai_spend",
        "scope": "https://management.azure.com/.default",
        "host": "management.azure.com",
        "path": "/providers/Microsoft.CostManagement/query",
        "query": {"api-version": "2023-03-01"},
        "restate": 3,
        "backfill": 180,
    },
    {
        "name": "GitHub Usage",
        "table": "github_ai_usage",
        "scope": None,
        "host": "api.github.com",
        "path": "/enterprises/{enterprise}/settings/billing/usage",
        "query": {},
        "restate": 2,
        "backfill": 180,
    },
]


def fail(message: str) -> None:
    sys.exit(f"error: {message}")


def flow_id(name: str) -> str:
    return str(uuid.uuid5(NAMESPACE, name))


def token_action(feed: dict) -> dict:
    """Client-credentials token, with the secret fetched from Key Vault."""
    return {
        "Get_secret": {
            "type": "OpenApiConnection", "runAfter": {},
            "inputs": {
                "host": {"connectionName": "shared_keyvault",
                         "operationId": "GetSecret",
                         "apiId": "/providers/Microsoft.PowerApps/apis/shared_keyvault"},
                "parameters": {"secretName": SECRET_NAMES["ClientSecret"]},
            },
            "runtimeConfiguration": {"secureData": {"properties": ["inputs", "outputs"]}},
        },
        "Get_token": {
            "type": "Http", "runAfter": {"Get_secret": ["Succeeded"]},
            "inputs": {
                "method": "POST",
                "uri": "https://login.microsoftonline.com/@{variables('TenantId')}/oauth2/v2.0/token",
                "headers": {"Content-Type": "application/x-www-form-urlencoded"},
                "body": ("grant_type=client_credentials"
                         "&client_id=@{variables('ClientId')}"
                         "&client_secret=@{body('Get_secret')?['value']}"
                         f"&scope={feed['scope']}"),
            },
            "runtimeConfiguration": {"secureData": {"properties": ["inputs", "outputs"]}},
        },
    }


def fetch_action(feed: dict, after: str) -> dict:
    query = "&".join(f"{k}={v}" for k, v in feed["query"].items())
    separator = "&" if query else ""
    auth = ("Bearer @{body('Get_token')?['access_token']}" if feed["scope"]
            else "Bearer @{body('Get_secret')?['value']}")
    return {
        "Fetch": {
            "type": "Http", "runAfter": {after: ["Succeeded"]},
            "inputs": {
                "method": "GET",
                "uri": (f"https://{feed['host']}{feed['path']}?{query}{separator}"
                        "fromDate=@{items('For_each_day')}"
                        "&toDate=@{items('For_each_day')}"),
                "headers": {"Authorization": auth, "Accept": "application/json"},
            },
            "runtimeConfiguration": {"secureData": {"properties": ["inputs"]}},
        },
    }


def upsert_action(feed: dict, table: dict, prefix: str) -> dict:
    """Upsert each row on cc_rowkey.

    The key is built from the same columns as `keyColumns` in the schema, joined
    with a separator that cannot occur in an id, so two different rows cannot
    collide into one key and silently drop usage.
    """
    parts = "'|'".join(
        f"coalesce(string(items('For_each_row')?['{column}']), '')"
        for column in table["keyColumns"]
    )
    item = {
        f"{prefix}rowkey": f"@{{concat({parts})}}",
        f"{prefix}name": f"@{{first(take(concat(coalesce(string(items('For_each_row')?"
                         f"['{table['keyColumns'][0]}']), 'row')), 400))}}",
        f"{prefix}loadedon": "@{utcNow()}",
        f"{prefix}payloadjson": "@{string(items('For_each_row'))}",
    }
    for column in table["columns"]:
        canonical = column["canonical"]
        if canonical == "snapshot_month":
            # The API has no such field, but the column exists in Dataverse, so
            # the report binds it and then insists every row carries a month.
            # Leaving it null fails the refresh with MissingExportDate, so stamp
            # the month the row's usage falls in.
            value = ("@{formatDateTime(items('For_each_day'), 'yyyy-MM')}")
        else:
            value = f"@{{items('For_each_row')?['{canonical}']}}"
        item[column["logicalName"]] = value
    return {
        "Upsert_row": {
            "type": "OpenApiConnection", "runAfter": {},
            "inputs": {
                "host": {"connectionName": "shared_commondataserviceforapps",
                         "operationId": "UpdateRecordWithAlternateKey",
                         "apiId": "/providers/Microsoft.PowerApps/apis/"
                                  "shared_commondataserviceforapps"},
                "parameters": {
                    "entityName": f"{table['logicalName']}s",
                    "alternateKey": f"{prefix}rowkey",
                    "item": item,
                },
            },
        },
    }


def definition(feed: dict, table: dict, prefix: str, backfill: bool) -> dict:
    days = feed["backfill"] if backfill else feed["restate"]
    trigger = ({"manual": {"type": "Request", "kind": "Button", "inputs": {}}} if backfill
               else {"Daily": {"type": "Recurrence",
                               "recurrence": {"frequency": "Day", "interval": 1,
                                              "startTime": "2024-01-01T03:00:00Z"}}})
    variables = [
        {"name": "TenantId", "type": "string", "value": ""},
        {"name": "ClientId", "type": "string", "value": ""},
        {"name": "DataverseUrl", "type": "string", "value": ""},
    ]
    return {
        "$schema": "https://schema.management.azure.com/providers/Microsoft.Logic/"
                   "schemas/2016-06-01/workflowdefinition.json#",
        "contentVersion": "1.0.0.0",
        "parameters": {"$connections": {"defaultValue": {}, "type": "Object"}},
        "triggers": trigger,
        "actions": {
            "Initialise": {
                "type": "InitializeVariable", "runAfter": {},
                "inputs": {"variables": variables},
            },
            "Days": {
                "type": "Compose", "runAfter": {"Initialise": ["Succeeded"]},
                "inputs": (f"@range(0, {days})"),
            },
            "For_each_day": {
                "type": "Foreach",
                "runAfter": {"Days": ["Succeeded"]},
                "foreach": ("@map(outputs('Days'), "
                            "item => formatDateTime(addDays(utcNow(), mul(-1, item)), "
                            "'yyyy-MM-dd'))"),
                # One day at a time. A multi-day request collapses the dates and
                # the daily grain - the whole reason for using the API - is lost.
                "runtimeConfiguration": {"concurrency": {"repetitions": 1}},
                "actions": {
                    **token_action(feed),
                    **fetch_action(feed, "Get_token" if feed["scope"] else "Get_secret"),
                    "For_each_row": {
                        "type": "Foreach",
                        "runAfter": {"Fetch": ["Succeeded"]},
                        "foreach": "@coalesce(body('Fetch')?['value'], json('[]'))",
                        "actions": upsert_action(feed, table, prefix),
                    },
                },
            },
        },
    }


def manifest(names: list[str]) -> dict:
    return {
        "schema": "1.0",
        "details": {
            "displayName": "Consumption Central - Dataverse",
            "description": "Loads Microsoft Copilot consumption into Dataverse "
                           "for the Consumption Central report.",
            "createdTime": "2024-01-01T00:00:00Z",
            "packageTelemetryId": str(NAMESPACE),
        },
        "resources": {
            flow_id(name): {
                "id": flow_id(name),
                "name": flow_id(name),
                "type": "Microsoft.Flow/flows",
                "suggestedCreationType": "New",
                "details": {"displayName": f"Consumption Central - {name}"},
                "configurableBy": "User",
                "hierarchy": "Root",
                "dependsOn": [],
            }
            for name in names
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--package", action="store_true",
                        help="also build the importable zip")
    arguments = parser.parse_args()

    if not SCHEMA_FILE.exists():
        fail(f"{SCHEMA_FILE.name} not found - run generate_dataverse_schema.py first")
    schema = json.loads(SCHEMA_FILE.read_text(encoding="utf-8"))
    prefix = schema["publisherPrefix"] + "_"
    tables = {t["sourceTable"]: t for t in schema["tables"]}

    DEFINITIONS.mkdir(parents=True, exist_ok=True)
    written: list[tuple[str, Path]] = []

    for feed in FEEDS:
        table = tables.get(feed["table"])
        if table is None:
            fail(f"{feed['name']}: {feed['table']} is not in the schema")
        for backfill in (False, True):
            name = f"{feed['name']}{' Backfill' if backfill else ''}"
            body = definition(feed, table, prefix, backfill)
            path = DEFINITIONS / f"{name.replace(' ', '-').lower()}.json"
            path.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
            written.append((name, path))
            print(f"  {path.relative_to(PATH4)}")

    if not arguments.package:
        print(f"\n{len(written)} definitions written. "
              f"re-run with --package to build the import zip.")
        return

    with zipfile.ZipFile(PACKAGE, "w", zipfile.ZIP_DEFLATED) as out:
        out.writestr("manifest.json",
                     json.dumps(manifest([n for n, _ in written]), indent=2))
        for name, path in written:
            out.writestr(
                f"Microsoft.Flow/flows/{flow_id(name)}/definition.json",
                json.dumps({
                    "name": flow_id(name),
                    "id": f"/providers/Microsoft.Flow/flows/{flow_id(name)}",
                    "type": "Microsoft.Flow/flows",
                    "properties": {
                        "displayName": f"Consumption Central - {name}",
                        "state": "Stopped",
                        "definition": json.loads(path.read_text(encoding="utf-8")),
                    },
                }, indent=2))
        out.writestr("Microsoft.Flow/apisMap.json", json.dumps({
            "shared_commondataserviceforapps": {
                "name": "shared_commondataserviceforapps",
                "id": "/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps",
            },
            "shared_keyvault": {
                "name": "shared_keyvault",
                "id": "/providers/Microsoft.PowerApps/apis/shared_keyvault",
            },
        }, indent=2))

    print(f"\nwrote {PACKAGE.relative_to(PATH4)} "
          f"({PACKAGE.stat().st_size:,} bytes, {len(written)} flows)")
    print("flows import in the Stopped state - turn each one on after import.")


if __name__ == "__main__":
    main()
