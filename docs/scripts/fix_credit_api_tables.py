"""Add optional, separate Graph credit views to the three active templates.

Only DataModelSchema and matching UnappliedChanges queries change. Existing
product/person totals are untouched. Each view has its own grain; they remain
disconnected deliberately and must never be added together.
"""

import argparse
import copy
import json
import sys
import uuid

from fix_limit_and_token_measures import TEMPLATES, publish
from fix_pbit_defaults import layout_for
from fix_viva_query_org import Package, require

TABLES = {
    "Copilot Credit Service": (
        "copilot_cost_service_daily", "CopilotCostServiceDaily.csv",
        [("Date", "date"), ("ServiceId", "text"), ("ConsumedQuantity", "number"), ("Unit", "text")],
    ),
    "Copilot Credit Funding": (
        "copilot_cost_funding_monthly", "CopilotCostFundingMonthly.csv",
        [("Month", "date"), ("FundingClass", "text"), ("ConsumedQuantity", "number"),
         ("Unit", "text"), ("LatestSourceDateTime", "text")],
    ),
    "Copilot Credit Balance": (
        "copilot_cost_balance", "CopilotCostBalance.csv",
        [("AsOfUTC", "text"), ("BillingMethod", "text"), ("PurchasedQuantity", "number"),
         ("ConsumedQuantity", "number"), ("RemainingQuantity", "number"), ("Unit", "text"),
         ("LastModifiedDateTime", "text")],
    ),
}


def tag(name):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "consumption-central/credit-apis/" + name))


def query(name, fabric):
    lake, filename, columns = TABLES[name]
    headers = ", ".join(json.dumps(c) for c, _ in columns)
    schema = ", ".join(f"{c} = nullable {kind}" for c, kind in columns)
    if fabric:
        source = f'''Source = if Table.Contains(FabricSource, [Schema="dbo", Item="{lake}"])
        then FabricSource{{[Schema="dbo", Item="{lake}"]}}[Data] else null'''
    else:
        source = f'''Files = {"SourceFiles" if fabric is None else "DataFiles"},
    Matches = if Files = null then #table({{"Name", "Content"}}, {{}})
        else Table.SelectRows(Files, each Text.Lower([Name]) = Text.Lower("{filename}")),
    Bin = if Table.IsEmpty(Matches) then null else if Table.RowCount(Matches) = 1 then Matches{{0}}[Content]
        else error Error.Record("DuplicateCreditFile", "Keep exactly one {filename} in the data folder tree.", null),
    Source = if Bin = null then null else Table.PromoteHeaders(
        Csv.Document(Bin, [Delimiter=",", Encoding=65001, QuoteStyle=QuoteStyle.Csv]), [PromoteAllScalars=true])'''
    conversions = []
    for column, kind in columns:
        if kind == "date":
            convert = 'each if Value.Is(_, type date) or Value.Is(_, type datetime) then Date.From(_) else Date.FromText(Text.From(_), [Format="yyyy-MM-dd", Culture="en-US"])'
        elif kind == "number":
            convert = 'each if _ = null or _ = "" then null else if Value.Is(_, type number) then _ else Number.FromText(Text.From(_), "en-US")'
        else:
            convert = 'each if _ = null then null else Text.From(_)'
        conversions.append(f'{{"{column}", {convert}, type nullable {kind}}}')
    return f'''let
    Empty = #table(type table [{schema}], {{}}),
    {source},
    Columns = {{{headers}}},
    Checked = if Source = null then Empty else if List.Sort(Table.ColumnNames(Source)) = List.Sort(Columns) then Source
        else error Error.Record("CreditSchema", "Unexpected Graph credit columns; refresh stopped.", "{name}"),
    Typed = Table.TransformColumns(Checked, {{{", ".join(conversions)}}}),
    Quantities = List.Combine(List.Transform({{{", ".join(json.dumps(c) for c, k in columns if k == "number")}}}, each Table.Column(Typed, _))),
    Valid = List.AllTrue(List.Transform(Quantities, each _ = null or (not Number.IsNaN(_) and Number.Abs(_) <> #infinity)))
        and List.NonNullCount(Table.Column(Typed, "ConsumedQuantity")) = Table.RowCount(Typed),
    Result = if not Valid then error Error.Record("CreditQuantity", "Missing or invalid credit quantity.", "{name}")
        else if List.AllTrue(List.Transform(Table.Column(Typed, "Unit"), each _ = "copilotCredit")) then Typed
        else error Error.Record("CreditUnit", "Expected copilotCredit, not currency.", "{name}")
in
    Result'''


def table(name, fabric):
    _, _, columns = TABLES[name]
    result = {
        "name": name, "lineageTag": tag(name),
        "description": "Graph beta credit view. Separate grain; not currency, not additive to other credit views or product totals.",
        "columns": [],
        "partitions": [{"name": name, "mode": "import", "source": {"type": "m", "expression": query(name, fabric).splitlines()}}],
        "measures": [],
    }
    for column, kind in columns:
        record = {
            "name": column, "dataType": {"date": "dateTime", "number": "double", "text": "string"}[kind],
            "sourceColumn": column, "lineageTag": tag(name + "/" + column), "summarizeBy": "none",
        }
        if kind == "date":
            record["formatString"] = "yyyy-MM-dd"
        if kind == "number":
            record.update(isHidden=True, isAvailableInMdx=False)
            result["measures"].append({
                "name": name + " " + column,
                "expression": f"SUM('{name}'[{column}])", "formatString": "#,0.##",
                "description": "Credits within this view only. Do not add to the service, funding, balance or product totals.",
                "lineageTag": tag(name + "/measure/" + column),
            })
        result["columns"].append(record)
    return result


def pending(record):
    expression = record["partitions"][0]["source"]["expression"]
    return {
        "name": record["name"], "lineageTag": record["lineageTag"], "text": expression,
        "isDirectQuery": False, "loadAsTableDisabled": False, "resultType": "Table", "isHidden": False,
        "lastLoadedAsTableFormulaText": json.dumps({
            "IncludesReferencedQueries": False, "RootFormulaText": "\n".join(expression),
            "ReferencedQueriesFormulaText": {},
        }, separators=(",", ":")),
    }


def build(raw):
    package = Package(raw)
    schema, encode_schema = layout_for(package.contents["DataModelSchema"], "DataModelSchema")
    unapplied, encode_pending = layout_for(package.contents["UnappliedChanges"], "UnappliedChanges")
    model = schema["model"]
    expressions = {e["name"] for e in model["expressions"]}
    fabric = True if "FabricSource" in expressions else None if "SourceFiles" in expressions else False
    before_schema, before_pending = copy.deepcopy(schema), copy.deepcopy(unapplied)
    changes = []
    for name in TABLES:
        expected = table(name, fabric)
        found = [t for t in model["tables"] if t["name"] == name]
        queries = [q for q in unapplied["queries"] if q["name"] == name]
        require(len(found) <= 1 and len(queries) <= 1, f"Duplicate {name}")
        if found or queries:
            require(found == [expected] and queries == [pending(expected)], f"{name} has changed; review before patching")
        else:
            model["tables"].append(expected)
            unapplied["queries"].append(pending(expected))
            changes.append(name)
    if not changes:
        return raw, []
    for document, original, key in ((schema, before_schema, "tables"), (unapplied, before_pending, "queries")):
        masked = copy.deepcopy(document)
        target = masked["model"] if key == "tables" else masked
        target[key] = [x for x in target[key] if x["name"] not in TABLES]
        require(masked == original, "Unexpected change outside credit API tables")
    updates = {"DataModelSchema": encode_schema(schema), "UnappliedChanges": encode_pending(unapplied)}
    candidate = package.rebuild(updates)
    check = Package(candidate)
    for part in package.contents:
        if part not in updates:
            require(check.contents[part] == package.contents[part], f"Unrelated part changed: {part}")
    return candidate, changes


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    candidates = []
    for path in TEMPLATES:
        raw = path.read_bytes()
        candidate, changes = build(raw)
        candidates.append((path, raw, candidate, changes))
    for path, raw, candidate, changes in candidates:
        print(f"{path.parent.name}: {'needs credit API tables' if changes else 'ok'}")
        if changes and not (args.check or args.dry_run):
            publish(path, raw, candidate)
    return int(args.check and any(c[3] for c in candidates))


if __name__ == "__main__":
    sys.exit(main())
