"""Data-free additions for all Consumption Central task model variants."""
from pathlib import Path
import uuid

HERE = Path(__file__).resolve().parent
NAMESPACE = uuid.UUID("07c8aa09-2a2e-43ba-9725-a190ff1bebdc")
FACT = "Cowork Tasks"
CATEGORY = "Cowork Task Categories"
DATES = "Cowork Task Date"
PEOPLE = "Cowork Task People"
PERIOD = "Cowork Task Period"
SCENARIO = "Cowork Task Scenario"
HOURLY = "Cowork Task Hourly Value"
STATUS = "Cowork Task Status"


def tag(name):
    return str(uuid.uuid5(NAMESPACE, name))


def text(value):
    return "\n".join(value) if isinstance(value, list) else value


def source(name):
    return (HERE / name).read_text(encoding="utf-8").rstrip()


def column(table, name, kind="string", hidden=False, sort=None):
    result = {
        "name": name, "dataType": kind, "sourceColumn": name,
        "lineageTag": tag(f"{table}.{name}"), "summarizeBy": "none",
    }
    if hidden:
        result["isHidden"] = True
    if sort:
        result["sortByColumn"] = sort
    if kind == "dateTime":
        result["formatString"] = "dd mmm yyyy"
    return result


def table(name, expression, columns, description, hidden=False):
    return {
        "name": name, "description": description, "lineageTag": tag(name),
        "isHidden": hidden, "columns": [column(name, *spec) for spec in columns],
        "partitions": [{"name": name, "mode": "import",
                        "source": {"type": "m", "expression": expression}}],
        "annotations": [{"name": "PBI_ResultType", "value": "Table"}],
    }


def measure(name, expression, fmt="#,0.00", description=None, folder="Tasks"):
    return {
        "name": name, "expression": expression, "formatString": fmt,
        "description": description or name, "displayFolder": folder,
        "lineageTag": tag(f"measure.{name}"),
    }


def window(expression, *filters):
    extra = "".join(",\n    " + f for f in filters)
    return f"""VAR _weeks = SELECTEDVALUE('{PERIOD}'[Weeks], 4)
RETURN CALCULATE(
    {expression},
    KEEPFILTERS('{DATES}'[WeeksAgo] < _weeks){extra}
)"""


def measures():
    return [
        measure("Reported Cowork Tasks", window(f"SUM('{FACT}'[TaskCount])"), "#,0",
                "Reported task counts, not completed tasks or audit prompt rows."),
        measure("Cowork Task Rows", window(f"COUNTROWS('{FACT}')"), "#,0", folder="Task diagnostics"),
        measure("Cowork Task Credit Coverage", window(
            f"DIVIDE(CALCULATE(SUM('{FACT}'[TaskCount]), KEEPFILTERS(NOT ISBLANK('{FACT}'[CreditsUsed]))), SUM('{FACT}'[TaskCount]))"),
            "0.0%", "Share of reported tasks whose row supplies credits.", "Task diagnostics"),
        measure("Cowork Task Credits", window(
            f"IF(COUNT('{FACT}'[CreditsUsed]) = COUNTROWS('{FACT}'), SUM('{FACT}'[CreditsUsed]))"),
            "#,0.00", "Observed credits at task grain. Blank when any selected row has missing credits."),
        measure("Cowork Credits per Task", "DIVIDE([Cowork Task Credits], [Reported Cowork Tasks])",
                "#,0.00", "Ratio of summed credits to summed task counts, not an average of row ratios."),
        measure("Cowork Task Share",
                f"DIVIDE([Reported Cowork Tasks], CALCULATE([Reported Cowork Tasks], ALLSELECTED('{CATEGORY}')))",
                "0.0%", "Task share within selected categories; preserves period, type and organization filters."),
        measure("Cowork Task Cost at PAYG",
                "IF(NOT ISBLANK([Cowork Task Credits]), [Cowork Task Credits] * [Cowork PAYG Rate Value])",
                "$#,0.00", "Estimated task consumption cost at the displayed PAYG rate. No prepaid, seat or shared cost allocation."),
        measure("Cowork PAYG Cost per Task",
                "DIVIDE([Cowork Task Cost at PAYG], [Reported Cowork Tasks])", "$#,0.0000"),
        measure("Cowork Task Effort Minutes", f"""VAR _scenario = SELECTEDVALUE('{SCENARIO}'[Scenario], "Typical")
RETURN IF(HASONEVALUE('{CATEGORY}'[CategoryKey]) && NOT ISBLANK([Reported Cowork Tasks]),
    SWITCH(_scenario,
        "Conservative", SELECTEDVALUE('{CATEGORY}'[Conservative]),
        "Optimistic", SELECTEDVALUE('{CATEGORY}'[Optimistic]),
        SELECTEDVALUE('{CATEGORY}'[Typical])))""", "#,0.0",
                "Provisional ValueLens-aligned expert-equivalent minutes per reported task.", "Task value"),
        measure("Cowork Valued Tasks", f"""SUMX(
    VALUES('{CATEGORY}'[CategoryKey]),
    IF(NOT ISBLANK([Cowork Task Effort Minutes]), [Reported Cowork Tasks])
)""", "#,0", "Only tasks with an explicit category effort assumption.", "Task value"),
        measure("Cowork Task Valuation Coverage",
                "DIVIDE([Cowork Valued Tasks], [Reported Cowork Tasks])", "0.0%",
                "Share of tasks covered by category assumptions; not task success or billing coverage.", "Task value"),
        measure("Cowork Unmapped Tasks",
                "IF(NOT ISBLANK([Reported Cowork Tasks]), [Reported Cowork Tasks] - COALESCE([Cowork Valued Tasks], 0))",
                "#,0", folder="Task value"),
        measure("Cowork Expert-equivalent Hours", f"""SUMX(
    VALUES('{CATEGORY}'[CategoryKey]),
    VAR _minutes = [Cowork Task Effort Minutes]
    VAR _tasks = [Reported Cowork Tasks]
    RETURN IF(NOT ISBLANK(_minutes) && NOT ISBLANK(_tasks), DIVIDE(_tasks * _minutes, 60))
)""", "#,0.0", "Provisional work-equivalent scenario for mapped reported tasks. Not duration, time saved or successful outputs.", "Task value"),
        measure("Cowork Expert Hours per Valued Task",
                "DIVIDE([Cowork Expert-equivalent Hours], [Cowork Valued Tasks])", "#,0.00",
                "Estimated hours divided only by tasks with a mapped assumption.", "Task value"),
        measure("Cowork Task Monetary Equivalent", f"""VAR _rate = SELECTEDVALUE('{HOURLY}'[Hourly Value])
RETURN IF(NOT ISBLANK(_rate) && NOT ISBLANK([Cowork Expert-equivalent Hours]),
    [Cowork Expert-equivalent Hours] * _rate)""", "$#,0.00",
                "Scenario monetary equivalent in USD, not realized financial savings. Requires explicit hourly-value selection.", "Task value"),
        measure("Cowork Task Status Message", f"""VAR _unavailable = MAX('{STATUS}'[SourceUnavailable])
VAR _supplied = MAX('{STATUS}'[Supplied])
VAR _rows = MAX('{STATUS}'[SourceRows])
VAR _selected = [Cowork Task Rows]
VAR _coverage = [Cowork Task Valuation Coverage]
VAR _creditCoverage = [Cowork Task Credit Coverage]
RETURN SWITCH(TRUE(),
    _unavailable = 1, "Task folder unavailable; check DataFolder and folder access.",
    _supplied = 0, "Task categories not supplied",
    _rows = 0, "Task export contains no rows",
    ISBLANK(_selected) || _selected = 0, "No tasks match these filters",
    "Value assumptions cover " & FORMAT(COALESCE(_coverage, 0), "0.0%") &
    " of reported tasks. " &
    IF(ISBLANK([Cowork Task Credits]),
        "Credits are incomplete" &
        IF([Reported Cowork Tasks] > 0, " (" & FORMAT(COALESCE(_creditCoverage, 0), "0.0%") & " task coverage)", "") &
        "; cost estimates are unavailable. ", "") &
    "Expert-equivalent work is estimated, not measured time saved."
)""", "", folder="Task diagnostics"),
        measure("Cowork Task Value Basis", f"""VAR _rate = SELECTEDVALUE('{HOURLY}'[Hourly Value])
VAR _scenario = SELECTEDVALUE('{SCENARIO}'[Scenario], "Typical")
VAR _payg = [Cowork PAYG Rate Value]
RETURN _scenario & " estimates" & UNICHAR(10) &
    IF(ISBLANK(_rate), "Select USD/hour to value work.",
        FORMAT(_rate, "$#,0") & " per expert hour (USD)") & UNICHAR(10) &
    IF(ISBLANK(_payg), "PAYG rate unavailable",
        "PAYG: " & FORMAT(_payg, "$0.0000") & "/credit") & UNICHAR(10) &
    "No prepaid/licence allocation."
""", "", folder="Task diagnostics"),
    ]


def additions():
    return [
        table(FACT, """Table.SelectColumns(CoworkTaskData,
    {"PersonId", "PeopleKey", "MetricDate", "CategoryKey", "TaskType", "CreditsUsed", "TaskCount"})""",
              [("PersonId", "string", True), ("PeopleKey", "string", True),
               ("MetricDate", "dateTime", True), ("CategoryKey", "string", True),
               ("TaskType",), ("CreditsUsed", "double", True), ("TaskCount", "int64", True)],
              "One row per person, week, category and initiation type. Independent of legacy credit billing; never add both facts together."),
        table(CATEGORY, source("Categories.m"),
              [("TaskCategory",), ("CategoryKey", "string", True),
               ("Conservative", "double"), ("Typical", "double"), ("Optimistic", "double")],
              "Editable provisional ValueLens Cowork effort bands in minutes per reported task. Unmapped categories have no estimate."),
        table(PEOPLE, """let
    Rows = Table.Distinct(Table.Buffer(Table.SelectColumns(CoworkTaskData,
        {"PeopleKey", "Organization", "FunctionType", "IsCopilotLicensed"})), {"PeopleKey"}),
    Labels = Table.TransformColumns(Rows, {
        {"Organization", each if _ = null then "Not supplied" else _, type text},
        {"FunctionType", each if _ = null then "Not supplied" else _, type text},
        {"IsCopilotLicensed", each if _ = null then "Not supplied" else if _ then "Yes" else "No", type text}
    })
in Labels""", [("PeopleKey", "string", True), ("Organization",), ("FunctionType",), ("IsCopilotLicensed",)],
              "Task-scoped historical attributes. No inferred UPN or cross-product identity link."),
        table(DATES, """let
    Dates = List.RemoveNulls(CoworkTaskData[MetricDate]),
    First = if List.IsEmpty(Dates) then null else Date.StartOfWeek(List.Min(Dates), Day.Sunday),
    Last = if List.IsEmpty(Dates) then null else Date.StartOfWeek(List.Max(Dates), Day.Sunday),
    Days = if First = null then {} else List.Dates(First, Duration.Days(Last - First) + 7, #duration(1,0,0,0)),
    Base = Table.FromColumns({Days}, type table [Date=date]),
    Week = Table.AddColumn(Base, "Week Start", each Date.StartOfWeek([Date], Day.Sunday), type date),
    Label = Table.AddColumn(Week, "Week Label", each Date.ToText([#"Week Start"], "dd MMM yyyy", "en-US"), type text),
    Ago = Table.AddColumn(Label, "WeeksAgo", each Number.IntegerDivide(Duration.Days(Last - [#"Week Start"]), 7), Int64.Type)
in Ago""", [("Date", "dateTime"), ("Week Start", "dateTime"),
            ("Week Label", "string", False, "Week Start"), ("WeeksAgo", "int64", True)],
              "Task-only date range and period anchor; does not change legacy Cowork dates or forecasts."),
        table(PERIOD, """let
    Dates = List.RemoveNulls(CoworkTaskData[MetricDate]),
    Weeks = List.Transform(Dates, each Date.StartOfWeek(_, Day.Sunday)),
    Span = if List.IsEmpty(Weeks) then 0 else Number.IntegerDivide(Duration.Days(List.Max(Weeks) - List.Min(Weeks)), 7) + 1,
    Choices = List.Select({{"Last 4 weeks",4,1}, {"Last 8 weeks",8,2}}, each _{1} < Span),
    Rows = Choices & {{"All history", Span, 3}}
in #table(type table [Period=text, Weeks=Int64.Type, Sort=Int64.Type], Rows)""",
              [("Period", "string", False, "Sort"), ("Weeks", "int64", True), ("Sort", "int64", True)],
              "Independent task period selector. With no selection, measures use the last four weeks."),
        table(SCENARIO, '#table(type table [Scenario=text, Sort=Int64.Type], {{"Conservative",1},{"Typical",2},{"Optimistic",3}})',
              [("Scenario", "string", False, "Sort"), ("Sort", "int64", True)],
              "Provisional expert-equivalent effort scenario. Default Typical."),
        table(HOURLY, 'Table.FromColumns({{null} & List.Numbers(0,1001)}, type table [#"Hourly Value"=Int64.Type])',
              [("Hourly Value", "int64")], "USD per expert-equivalent hour. Blank means no value selected; editable range."),
        table(STATUS, """#table(type table [Supplied=Int64.Type, SourceRows=Int64.Type, SourceUnavailable=Int64.Type],
    {{if CoworkTaskInput[Supplied] then 1 else 0, Table.RowCount(CoworkTaskData),
      if Record.FieldOrDefault(CoworkTaskInput, "SourceUnavailable", false) then 1 else 0}})""",
              [("Supplied", "int64"), ("SourceRows", "int64"), ("SourceUnavailable", "int64")],
              "Unfiltered source availability, distinct from no matching rows in a selection.", True),
    ]


def load_query(item):
    # QueryStorage.isHidden denotes a managed multi-table source, not a hidden model table.
    return {
        "name": item["name"], "lineageTag": item["lineageTag"], "isDirectQuery": False,
        "loadAsTableDisabled": False, "resultType": "Table",
        "text": text(item["partitions"][0]["source"]["expression"]).splitlines(),
    }


def apply(model, unapplied, profile):
    """Apply deterministic model additions to an offline project, never a signed report."""
    expressions = {e["name"]: e for e in model["expressions"]}
    tables = {t["name"]: t for t in model["tables"]}
    new_expressions = {
        "CoworkTaskNormalize": source("NormalizeTasks.m"),
        "CoworkTaskInput": source("TableInput.m" if profile in ("fabric", "dataverse") else "FileInput.m"),
        "CoworkTaskData": "CoworkTaskNormalize(CoworkTaskInput[Data], CoworkTaskInput[People])",
    }
    if profile == "csv":
        for annotation in expressions["BillingPeriodWeeks"].get("annotations", []):
            if annotation["name"] == "PBI_ResultType":
                annotation["value"] = "Number"
        new_expressions["GetVivaMetadataFile"] = source("LegacyCompanion.m")
        for name in ("OrgNormalised", "VivaSeatRosterFromFiles"):
            old = expressions[name]
            body = text(old["expression"])
            body = body.replace('GetDataFile({"peoplemetadata"})', 'GetVivaMetadataFile({"peoplemetadata"})')
            if name == "VivaSeatRosterFromFiles":
                body = body.replace('[Delimiter=",", Columns=3, Encoding=65001, QuoteStyle=QuoteStyle.Csv]',
                                    '[Delimiter=",", Encoding=65001, QuoteStyle=QuoteStyle.Csv]')
            old["expression"] = body
    for name, body in new_expressions.items():
        expressions[name] = {"name": name, "kind": "m", "expression": body, "lineageTag": tag(name)}
    new_tables = additions()
    new_tables[0]["measures"] = measures()
    for item in new_tables:
        tables[item["name"]] = item
    model["expressions"] = list(expressions.values())
    model["tables"] = list(tables.values())
    relationships = {r["name"]: r for r in model.get("relationships", [])}
    for from_col, to_table, to_col in (
        ("CategoryKey", CATEGORY, "CategoryKey"), ("PeopleKey", PEOPLE, "PeopleKey"), ("MetricDate", DATES, "Date")
    ):
        name = tag(f"relationship.{to_table}")
        relationships[name] = {
            "name": name, "fromTable": FACT, "fromColumn": from_col,
            "toTable": to_table, "toColumn": to_col, "crossFilteringBehavior": "oneDirection",
        }
    model["relationships"] = list(relationships.values())
    queries = {q["name"]: q for q in unapplied["queries"]}
    for name, expr in expressions.items():
        q = queries.setdefault(name, {"name": name, "lineageTag": expr.get("lineageTag", tag(name)),
                                     "loadAsTableDisabled": True, "resultType": "Table"})
        q["text"] = text(expr["expression"]).split("\n")
        if name in new_expressions:
            q.pop("isHidden", None)
        if name == "CoworkTaskInput":
            q["resultType"] = "Record"
        if name in ("CoworkTaskNormalize", "GetVivaMetadataFile"):
            q["resultType"] = "Function"
        if profile == "csv" and name == "DataFiles":
            q["resultType"] = "Table"
    for item in new_tables:
        queries[item["name"]] = load_query(item)
    unapplied["queries"] = list(queries.values())
