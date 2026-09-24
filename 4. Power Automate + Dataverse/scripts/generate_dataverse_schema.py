"""Generate dataverse-schema.json from the Fabric template's own column contract.

The Dataverse path has to land columns the report can bind to. Rather than
hand-copy 121 column names out of the model and hope they stay in step, this
reads the Fabric template and derives the schema from it. If a future release
renames a column, re-running this regenerates the schema and the drift shows up
as a diff instead of as a blank visual six months later.

The binding rule this relies on is in the template's own `Normalize` function:

    Key = (s) => Text.Lower(Text.Select(s, {"a".."z","A".."Z","0".."9"}))

Normalize matches an incoming column to a canonical one when the two agree
after `Key`. So a Dataverse column named `cc_agentname`, once the publisher
prefix is stripped by the rewritten `GetTable`, keys to `agentname` - which is
exactly what the canonical `Agent_Name` keys to. The columns bind by
construction rather than by convention.

Usage:
    python generate_dataverse_schema.py            # write dataverse-schema.json
    python generate_dataverse_schema.py --check    # fail if it is out of date
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = ROOT / "2. Fabric" / "Consumption Central - Fabric.pbit"
OUTPUT = Path(__file__).resolve().parents[1] / "dataverse-schema.json"

PREFIX = "cc"

# Dataverse caps a schema name at 50 characters including the publisher prefix.
MAX_LOGICAL = 50

# Model data type -> the Dataverse attribute we create for it.
TYPES = {
    "string": "String",
    "int64": "Integer",
    "double": "Decimal",
    "decimal": "Decimal",
    "dateTime": "DateTime",
    "boolean": "Boolean",
}

# The business key for each table. The flow hashes these into `cc_rowkey`, an
# alternate key, so a re-run upserts the same row instead of duplicating it.
# A key that is wrong here shows up as double-counted credits, so each one is
# the narrowest set that is unique in the source.
KEYS = {
    "studio_tenant_daily": ["Usage_Date", "Environment_Id", "Capacity_Type", "BillingPlan_Id"],
    "studio_agent": ["snapshot_month", "Agent_Id", "Billable_Feature", "Channel",
                     "LLM_Model", "Scenario_Name", "Environment_Id"],
    "studio_user": ["snapshot_month", "User_Id", "Agent_Id"],
    "github_ai_usage": ["Usage_Date", "Username", "Sku", "Model"],
    "github_user_map": ["Username"],
    "azure_ai_spend": ["UsageDate", "ResourceName", "ServiceName", "Meter", "Model",
                       "TokenDirection"],
    "azure_ai_tokens": ["Date", "ResourceName", "Deployment", "Metric"],
    "azure_solution_spend": ["UsageDate", "ResourceId", "ServiceName", "PricingModel"],
    "azure_deployment_health": ["SnapshotDate", "MetricDate", "DeploymentId", "ModelName",
                                "ModelVersion"],
    "azure_billing_reconciliation": ["Period", "Product", "PoolName", "Representation"],
    "viva_spending_policy": ["SpendingPolicyId"],
}


def fail(message: str) -> None:
    sys.exit(f"error: {message}")


def key(text: str) -> str:
    """The template's own column-matching key."""
    return "".join(c for c in text if c.isalnum()).lower()


def read_schema(path: Path) -> dict:
    if not path.exists():
        fail(f"{path} not found")
    with zipfile.ZipFile(path) as archive:
        raw = archive.read("DataModelSchema")
    if raw[:2] == b"\xff\xfe":
        raw = raw[2:]
    return json.loads(raw.decode("utf-16-le"))


def contract(model: dict) -> dict:
    """Every table the template sources through GetTable, and its columns."""
    found = {}
    for table in model["model"]["tables"]:
        partitions = table.get("partitions") or []
        if not partitions:
            continue
        expression = partitions[0]["source"].get("expression", "")
        if isinstance(expression, list):
            expression = "\n".join(expression)
        match = re.search(r'GetTable\("([^"]+)"\)', expression)
        if not match:
            continue
        columns = []
        loaded = set()
        for column in table.get("columns", []):
            if column.get("type") == "calculated" or not column.get("sourceColumn"):
                continue
            loaded.add(column["sourceColumn"])
            columns.append({
                "canonical": column["sourceColumn"],
                "modelColumn": column["name"],
                "dataType": column.get("dataType", "string"),
                "loaded": True,
            })

        # Some columns are read by the query and then dropped, so they never
        # appear as model columns. `snapshot_month` is the one that matters:
        # LatestSnapshot uses it to keep only the newest export. Absent, it
        # passes the table straight through, which is fine. But present and
        # blank it fails the refresh with MissingExportDate - so once it is a
        # column here, whatever writes the table must always populate it.
        # Take every canonical name the M binds, not just the ones that
        # survive to the model.
        for canonical in re.findall(r'\{\s*"([^"]+)"\s*,\s*\{', expression):
            if canonical in loaded:
                continue
            loaded.add(canonical)
            columns.append({
                "canonical": canonical,
                "modelColumn": None,
                "dataType": "string",
                "loaded": False,
            })

        if columns:
            found[match.group(1)] = {"modelTable": table["name"], "columns": columns}
    return found


def build(found: dict) -> dict:
    tables = []
    for source_table, detail in sorted(found.items()):
        logical = f"{PREFIX}_{key(source_table)}"
        if len(logical) > MAX_LOGICAL:
            fail(f"{source_table}: logical name '{logical}' exceeds {MAX_LOGICAL} characters")

        seen: dict[str, str] = {}
        columns = []
        for column in detail["columns"]:
            canonical = column["canonical"]
            bound = key(canonical)
            if bound in seen:
                fail(f"{source_table}: '{canonical}' and '{seen[bound]}' both key to "
                     f"'{bound}', so the report could not tell them apart")
            seen[bound] = canonical
            column_logical = f"{PREFIX}_{bound}"
            if len(column_logical) > MAX_LOGICAL:
                fail(f"{source_table}.{canonical}: logical name '{column_logical}' "
                     f"exceeds {MAX_LOGICAL} characters")
            attribute = TYPES.get(column["dataType"])
            if attribute is None:
                fail(f"{source_table}.{canonical}: unmapped model type "
                     f"'{column['dataType']}'")
            columns.append({
                "canonical": canonical,
                "logicalName": column_logical,
                "displayName": canonical.replace("_", " "),
                "type": attribute,
                "loadedToModel": column.get("loaded", True),
            })

        missing = [c for c in KEYS.get(source_table, []) if key(c) not in seen]
        if source_table not in KEYS:
            fail(f"{source_table}: no business key defined in KEYS")
        if missing:
            fail(f"{source_table}: key columns not in the contract: {', '.join(missing)}")

        tables.append({
            "sourceTable": source_table,
            "modelTable": detail["modelTable"],
            "logicalName": logical,
            "displayName": detail["modelTable"],
            "keyColumns": KEYS[source_table],
            "columns": columns,
        })

    return {
        "$comment": "Generated by scripts/generate_dataverse_schema.py. Do not edit by hand.",
        "publisherPrefix": PREFIX,
        "sourceTemplate": TEMPLATE.name,
        "commonColumns": [
            {"logicalName": f"{PREFIX}_rowkey", "type": "String", "maxLength": 400,
             "displayName": "Row Key",
             "note": "Deterministic hash of keyColumns. Alternate key, so the flow upserts."},
            {"logicalName": f"{PREFIX}_loadedon", "type": "DateTime",
             "displayName": "Loaded On",
             "note": "When the flow last wrote this row. Used to spot a stalled refresh."},
            {"logicalName": f"{PREFIX}_payloadjson", "type": "Memo", "maxLength": 100000,
             "displayName": "Payload JSON",
             "note": "The untouched source row. Keeps a column the report does not "
                     "read yet from being lost before anyone asks for it."},
        ],
        "tables": tables,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true",
                        help="exit non-zero if the committed schema is out of date")
    arguments = parser.parse_args()

    schema = build(contract(read_schema(TEMPLATE)))
    rendered = json.dumps(schema, indent=2, ensure_ascii=False) + "\n"

    if arguments.check:
        if not OUTPUT.exists():
            fail(f"{OUTPUT.name} has not been generated")
        if OUTPUT.read_text(encoding="utf-8") != rendered:
            fail(f"{OUTPUT.name} is out of date - re-run this script")
        print(f"{OUTPUT.name} is up to date")
        return

    OUTPUT.write_text(rendered, encoding="utf-8")
    columns = sum(len(t["columns"]) for t in schema["tables"])
    print(f"wrote {OUTPUT.name}: {len(schema['tables'])} tables, {columns} columns")


if __name__ == "__main__":
    main()
