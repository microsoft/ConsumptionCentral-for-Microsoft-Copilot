"""Add separate paired Power Platform report views to file-backed templates.

The pair is read from SourceFiles (SharePoint on automated No Fabric installs).
Existing CSV sources and person facts remain intact. Billing covers Power
Platform environments, not necessarily Copilot Studio alone.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path

from fix_credit_api_tables import tag
from fix_limit_and_token_measures import TEMPLATES, publish
from fix_pbit_defaults import layout_for
from fix_viva_query_org import Package, require
from fix_refresh_time_cuts import joined

EXPRESSION = "StudioCreditReportPair"
PREVIOUS_HASHES = {
    "0da4795b080903f46982418904ab84c3fe6685b901086723ced3fb274e7e8816",
    "9c7ce3ba154f3049790b00339424870389b22501f4266e7ca4aeb5236a34e174",
}
TABLES = {
    "Power Platform Credit Resources": ("Resources", [
        ("ConsumptionDate", "date"), ("ResourceId", "text"), ("ResourceName", "text"),
        ("ResourceType", "text"), ("HarnessType", "text"), ("Product", "text"),
        ("Feature", "text"), ("Channel", "text"), ("EnvironmentId", "text"),
        ("EnvironmentName", "text"), ("BilledCredits", "number"), ("NonBilledCredits", "number"),
    ]),
    "Power Platform Credit Billing": ("Billing", [
        ("BilledDate", "date"), ("EnvironmentId", "text"), ("EnvironmentName", "text"),
        ("EntitlementId", "text"), ("BillingPolicyId", "text"),
        ("CapacityPackCreditsConsumed", "number"), ("PayGoConsumedQuantity", "number"),
    ]),
}


def query(name):
    field, columns = TABLES[name]
    schema = ", ".join(f"{c} = nullable {kind}" for c, kind in columns)
    return f"Table.FromRecords({EXPRESSION}[{field}], type table [{schema}], MissingField.Error)"


def build(raw):
    package = Package(raw)
    schema, encode_schema = layout_for(package.contents["DataModelSchema"], "schema")
    unapplied, encode_pending = layout_for(package.contents["UnappliedChanges"], "pending")
    model = schema["model"]
    names = {e["name"] for e in model["expressions"]}
    if "FabricSource" in names:
        return raw, []
    source = "SourceFiles" if "SourceFiles" in names else "Folder.Files(DataFolder)"
    expression = Path(__file__).with_name("studio_credit_report_pair.m").read_text(encoding="utf-8").replace("__FILES__", source).splitlines()
    before_schema, before_pending = copy.deepcopy(schema), copy.deepcopy(unapplied)
    objects = [(model["expressions"], {
        "name": EXPRESSION, "kind": "m", "expression": expression, "lineageTag": tag(EXPRESSION),
    }), (unapplied["queries"], {
        "name": EXPRESSION, "lineageTag": tag(EXPRESSION), "text": expression,
        "isDirectQuery": False, "loadAsTableDisabled": True, "resultType": "Record",
    })]
    for name, (_, columns) in TABLES.items():
        body = query(name)
        table = {
            "name": name, "lineageTag": tag(name),
            "description": "Power Platform preview report view. Resources need not be agents; billing has no product dimension. These views overlap and are not additive to other product totals.",
            "partitions": [{"name": name, "mode": "import", "source": {"type": "m", "expression": body}}],
            "columns": [], "measures": [],
        }
        for column, kind in columns:
            record = {"name": column, "sourceColumn": column, "lineageTag": tag(name + "/" + column),
                      "dataType": {"date": "dateTime", "text": "string", "number": "double"}[kind], "summarizeBy": "none"}
            if kind == "number":
                record.update(isHidden=True, isAvailableInMdx=False)
                table["measures"].append({
                    "name": name + " " + column, "expression": f"SUM('{name}'[{column}])",
                    "formatString": "#,0.##", "lineageTag": tag(name + "/measure/" + column),
                    "description": "Credits in this report view only; non-billing does not establish entitlement or prepaid coverage.",
                })
            if kind == "date":
                record["formatString"] = "yyyy-MM-dd"
            table["columns"].append(record)
        objects += [(model["tables"], table), (unapplied["queries"], {
            "name": name, "lineageTag": tag(name), "text": [body], "isDirectQuery": False,
            "loadAsTableDisabled": False, "isHidden": False, "resultType": "Table",
            "lastLoadedAsTableFormulaText": json.dumps({
                "IncludesReferencedQueries": False, "RootFormulaText": body, "ReferencedQueriesFormulaText": {},
            }, separators=(",", ":")),
        })]
    changes = []
    for items, expected in objects:
        found = [item for item in items if item["name"] == expected["name"]]
        if len(found) == 1 and expected["name"] in TABLES and isinstance(found[0].get("text"), str):
            require(found[0]["text"] == expected["text"][0], "Unexpected table query edit")
            found[0]["text"] = expected["text"]
            changes.append(expected["name"])
        if len(found) == 1 and expected["name"] == EXPRESSION and found != [expected]:
            field = "expression" if "expression" in expected else "text"
            require(hashlib.sha256(joined(found[0][field]).encode()).hexdigest() in PREVIOUS_HASHES, "Unexpected paired source edit")
            previous = copy.deepcopy(found[0])
            previous[field] = expected[field]
            require(previous == expected, "Unexpected paired query metadata edit")
            found[0][field] = expected[field]
            changes.append(EXPRESSION)
        require(not found or found == [expected], f'{expected["name"]} has changed; review before patching')
        if not found:
            items.append(expected)
            changes.append(expected["name"])
    if not changes:
        return raw, []
    owned = {EXPRESSION, *TABLES}
    masked_schema, masked_pending = copy.deepcopy(schema), copy.deepcopy(unapplied)
    for target, key in ((masked_schema["model"], "expressions"), (masked_schema["model"], "tables"), (masked_pending, "queries")):
        target[key] = [x for x in target[key] if x["name"] not in owned]
    for target, key in ((before_schema["model"], "expressions"), (before_schema["model"], "tables"), (before_pending, "queries")):
        target[key] = [x for x in target[key] if x["name"] not in owned]
    require(masked_schema == before_schema and masked_pending == before_pending, "Unexpected edit outside paired report views")
    candidate = package.rebuild({"DataModelSchema": encode_schema(schema), "UnappliedChanges": encode_pending(unapplied)})
    return candidate, changes


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    candidates = [(p, p.read_bytes()) for p in TEMPLATES]
    candidates = [(p, raw, *build(raw)) for p, raw in candidates]
    for p, raw, candidate, changes in candidates:
        print(f"{p.parent.name}: {'needs paired report views' if changes else 'ok'}")
        if changes and not (args.check or args.dry_run):
            publish(p, raw, candidate)
    return int(args.check and any(c[3] for c in candidates))


if __name__ == "__main__":
    raise SystemExit(main())
