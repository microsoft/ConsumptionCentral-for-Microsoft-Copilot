"""Generate only the new task page and its additions to the existing Cowork guide."""
import json

from model import FACT, CATEGORY, DATES, PEOPLE, PERIOD, SCENARIO, HOURLY

PAGE = "cowork-tasks"
AFTER_PAGE = "dept-chargeback"
DISPLAY_NAME = "2.1. Cowork: Tasks"
SCHEMA = "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.11.0/schema.json"


def literal(value):
    if isinstance(value, bool):
        encoded = str(value).lower()
    elif isinstance(value, (int, float)):
        encoded = f"{value}D"
    else:
        encoded = "'" + value.replace("'", "''") + "'"
    return {"expr": {"Literal": {"Value": encoded}}}


def obj(selector=False, **properties):
    result = {"properties": {key: value if isinstance(value, dict) else literal(value)
                             for key, value in properties.items()}}
    if selector:
        result["selector"] = {"id": "default"}
    return [result]


def color(value):
    return {"solid": {"color": literal(value)}}


def field(table, name, measure=False):
    return {"Measure" if measure else "Column": {
        "Expression": {"SourceRef": {"Entity": table}}, "Property": name}}


def projection(table, name, measure=False, label=None):
    result = {"field": field(table, name, measure), "queryRef": f"{table}.{name}",
              "nativeQueryRef": label or name}
    if label:
        result["displayName"] = label
    return result


def metric(name, label=None):
    return projection(FACT, name, True, label)


def visual(name, kind, position, roles=None, title=None, subtitle=None):
    x, y, width, height = position
    chrome = {
        "title": obj(show=bool(title), text=title or "", fontSize=11, fontColor=color("#1C2632"),
                     fontFamily="Segoe UI Semibold", alignment="left"),
        "subTitle": obj(show=bool(subtitle), text=subtitle or "", fontSize=9, fontColor=color("#6B7280")),
        "background": obj(show=True, color=color("#FFFFFF"), transparency=0),
        "border": obj(show=False, color=color("#E1E6EC"), radius=5, width=1),
        "padding": obj(top=5, bottom=5, left=5, right=10),
        "visualHeader": obj(show=False),
    }
    result = {"$schema": SCHEMA, "name": name,
              "position": {"x": x, "y": y, "width": width, "height": height, "z": 1000, "tabOrder": y * 10 + x},
              "visual": {"visualType": kind, "objects": {}, "visualContainerObjects": chrome,
                         "drillFilterOtherVisuals": True}}
    if roles:
        result["visual"]["query"] = {"queryState": {
            role: {"projections": values} for role, values in roles.items()}}
    return result


def card(name, position, values, font=11, labels=True):
    result = visual(name, "cardVisual", position, {"Data": values})
    result["visual"]["objects"] = {
        "value": obj(True, fontSize=font, fontFamily="Segoe UI Semibold", bold=False,
                     fontColor=color("#666666"), showBlankAs="-", labelDisplayUnits=0, textWrap=True),
        "label": obj(True, show=labels, fontSize=8, fontFamily="Segoe UI", textWrap=True,
                     position="belowValue", fontColor=color("#1C2632")),
        "outline": obj(True, show=labels, lineColor=color("#E1E6EC"), weight=1),
        "accentBar": obj(True, show=False),
        "divider": obj(True, show=False),
        "fillCustom": obj(True, show=True, fillColor=color("#FFFFFF"), transparency=0),
        "shapeCustomRectangle": obj(True, tileShape="rectangleRoundedByPixel", rectangleRoundedCurve=5),
        "padding": obj(True, paddingUniform=8 if labels else 0),
        "spacing": obj(True, verticalSpacing=2),
        "layout": obj(orientation=2, rowCount=1, columnCount=len(values), maxTiles=len(values),
                      cellPadding=11, paddingUniform=0, autoGrid=False) + obj(True, backgroundShow=False),
    }
    result["visual"]["visualContainerObjects"]["background"] = obj(show=not labels)
    padding = 0 if labels else 5
    result["visual"]["visualContainerObjects"]["padding"] = obj(
        top=padding, bottom=padding, left=padding, right=padding)
    return result


def slicer(name, y, table, column, label, default=None, strict=False):
    result = visual(name, "slicer", (1045, y, 222, 80),
                    {"Values": [projection(table, column)]})
    result["visual"]["objects"] = {
        "data": obj(mode="Dropdown"),
        "header": obj(show=True, text=label.upper(), textSize=9, fontColor=color("#666666")),
        "items": obj(textSize=9),
        "selection": obj(strictSingleSelect=strict),
    }
    result["visual"]["visualContainerObjects"]["background"] = obj(show=False)
    result["visual"]["visualContainerObjects"]["padding"] = obj(top=0, bottom=0, left=0, right=0)
    if default is not None:
        result["visual"]["objects"]["general"] = [{"properties": {
            "filter": {"filter": {"Version": 2, "From": [{"Name": "s", "Entity": table, "Type": 0}],
                "Where": [{"Condition": {"In": {
                    "Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "s"}}, "Property": column}}],
                    "Values": [[literal(default)["expr"]]],
                }}}]}}
        }}]
    return result


def textbox(name, position, paragraphs, size=11):
    result = visual(name, "textbox", position)
    result["visual"]["objects"] = {"general": [{"properties": {"paragraphs": [
        {"textRuns": [{"value": text, "textStyle": {"fontFamily": "Segoe UI", "fontSize": f"{size}pt", "color": "#1C2632"}}]}
        for text in paragraphs
    ]}}]}
    result["visual"]["visualContainerObjects"]["background"] = obj(show=False)
    return result


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")


def apply(report):
    pages = report / "definition" / "pages"
    root = pages / PAGE
    base = pages / "exec-overview"
    page = json.loads((base / "page.json").read_text(encoding="utf-8"))
    page.update(name=PAGE, displayName=DISPLAY_NAME)
    page.pop("visualInteractions", None)
    write(root / "page.json", page)
    visuals = []
    for old, new in (("e1f908be0732c0914e41", "task_logo"),
                     ("shell_header_accent", "task_accent"),
                     ("gd_execoverview_btn", "task_guide")):
        item = json.loads((base / "visuals" / old / "visual.json").read_text(encoding="utf-8"))
        item["name"] = new
        visuals.append(item)
    header = json.loads((pages / AFTER_PAGE / "visuals" / "bba771b1b975d56897fb" / "visual.json").read_text(encoding="utf-8"))
    header["name"] = "task_title"
    header["position"].update(x=66, y=5, width=1135, height=48)
    runs = header["visual"]["objects"]["general"][0]["properties"]["paragraphs"][0]["textRuns"]
    runs[0]["value"] = "Cowork / WorkIQ: Tasks   "
    runs[2]["value"] = "Task mix, credit intensity and estimated work equivalent"
    visuals.append(header)
    visuals.append(card("task_kpis", (8, 69, 1027, 72), [
        metric("Reported Cowork Tasks", "Reported tasks"),
        metric("Cowork Task Credits", "Task credits"),
        metric("Cowork Credits per Task", "Credits per task"),
        metric("Cowork Expert-equivalent Hours", "Est. expert-equivalent hours"),
    ]))
    visuals.append(card("task_status", (8, 151, 1027, 40),
                         [metric("Cowork Task Status Message")], font=9, labels=False))
    category = visual("task_mix", "clusteredBarChart", (8, 201, 510, 250), {
        "Category": [projection(CATEGORY, "TaskCategory", label="Task category")],
        "Y": [metric("Cowork Task Share", "Share of reported tasks")],
        "Tooltips": [metric("Reported Cowork Tasks"), metric("Cowork Credits per Task")],
    }, "REPORTED TASKS BY CATEGORY", "Share of tasks in the current selection")
    category["visual"]["objects"] = {
        "categoryAxis": obj(fontSize=9, showAxisTitle=False, maxMarginFactor=55),
        "valueAxis": obj(fontSize=9, showAxisTitle=False),
        "labels": obj(show=True, fontSize=9),
        "dataPoint": obj(defaultColor=color("#7F215D")),
    }
    category["visual"]["query"]["sortDefinition"] = {
        "sort": [{"field": field(FACT, "Cowork Task Share", True), "direction": "Descending"}]}
    category["visual"]["visualContainerObjects"]["visualTooltip"] = obj(show=True)
    visuals.append(category)
    trend = visual("task_trend", "columnChart", (526, 201, 509, 250), {
        "Category": [projection(DATES, "Week Start")],
        "Y": [metric("Reported Cowork Tasks", "Reported tasks")],
        "Series": [projection(FACT, "TaskType", label="Initiation type")],
        "Tooltips": [metric("Cowork Task Credits"), metric("Cowork Credits per Task")],
    }, "REPORTED TASKS OVER TIME", "Weekly activity by initiation type")
    trend["visual"]["objects"] = {
        "categoryAxis": obj(axisType="Categorical", fontSize=9, showAxisTitle=False),
        "valueAxis": obj(fontSize=9, showAxisTitle=False),
        "legend": obj(show=True, position="Top", showTitle=False, fontSize=9),
    }
    trend["visual"]["query"]["sortDefinition"] = {
        "sort": [{"field": field(DATES, "Week Start"), "direction": "Ascending"}]}
    trend["visual"]["visualContainerObjects"]["visualTooltip"] = obj(show=True)
    visuals.append(trend)
    matrix = visual("task_details", "pivotTable", (8, 461, 1027, 207), {
        "Rows": [projection(CATEGORY, "TaskCategory", label="Task category")],
        "Values": [
            metric("Reported Cowork Tasks", "Tasks"),
            metric("Cowork Credits per Task", "Credits / task"),
            metric("Cowork PAYG Cost per Task", "Est. PAYG / task"),
            metric("Cowork Task Effort Minutes", "Est. min / task"),
            metric("Cowork Expert-equivalent Hours", "Est. expert hours"),
            metric("Cowork Task Monetary Equivalent", "Est. equivalent (USD)"),
        ],
    }, "TASK ACTIVITY AND ESTIMATED WORK EQUIVALENT", "Observed counts and credits; provisional effort and value assumptions")
    matrix["visual"]["objects"] = {
        "columnHeaders": obj(autoSizeColumnWidth=True, columnAdjustment="growToFit", fontSize=9, wordWrap=True),
        "rowHeaders": obj(fontSize=9, wordWrap=True),
        "values": obj(fontSize=9, wordWrap=True),
    }
    visuals.append(matrix)
    visuals.append(textbox("task_footnote", (8, 676, 1027, 36), [
        "Estimates are not measured time saved or successful completions. Unknown and unmapped tasks remain in observed totals."
    ], 9))
    for args in (
        ("task_period", 69, PERIOD, "Period", "Task period", None, True),
        ("task_type", 166, FACT, "TaskType", "Initiation type"),
        ("task_category", 250, CATEGORY, "TaskCategory", "Task category"),
        ("task_organization", 334, PEOPLE, "Organization", "Task organization"),
        ("task_scenario", 418, SCENARIO, "Scenario", "Effort scenario", "Typical", True),
        ("task_hourly", 502, HOURLY, "Hourly Value", "Expert hourly value (USD)"),
    ):
        visuals.append(slicer(*args))
    visuals.append(card("task_value_basis", (1045, 590, 222, 120),
                         [metric("Cowork Task Value Basis")], font=9, labels=False))
    for item in visuals:
        write(root / "visuals" / item["name"] / "visual.json", item)
    order_path = pages / "pages.json"
    order = json.loads(order_path.read_text(encoding="utf-8"))
    order["pageOrder"] = [name for name in order["pageOrder"] if name != PAGE]
    index = order["pageOrder"].index(AFTER_PAGE) + 1
    order["pageOrder"].insert(index, PAGE)
    write(order_path, order)
    extend_guide(pages)


def extend_guide(pages):
    root = pages / "guide-cowork" / "visuals"
    foot = root / "guidecowor_foot" / "visual.json"
    original = json.loads(foot.read_text(encoding="utf-8"))
    paragraphs = original["visual"]["objects"]["general"][0]["properties"]["paragraphs"]
    marker = "Task categories (optional)"
    if any(marker in run.get("value", "") for p in paragraphs for run in p.get("textRuns", [])):
        return
    write(foot, textbox("guidecowor_foot", (28, 524, 580, 170), [
        "Watch out for",
        "Legacy consumption: de-identified totals remain valid, but person and department views require identification or PersonPolicyMap.csv linking hashes to UPNs. Task metadata is separate and can provide historical organization without a UPN.",
        "Forecast quality depends on the weeks loaded. A short history gives little more than a straight line.",
    ], 11))
    note = textbox("guide_cowork_tasks", (650, 516, 602, 190), [
        marker,
        "Independent task export: counts and fractional credits, not additional billing. Missing data leaves the task page blank.",
        "Typical provisional ValueLens category minutes are selected initially. In Transform data, select Cowork Task Categories > Advanced Editor to edit bands; use the matrix to inspect effective minutes.",
        "Hours = reported tasks x category minutes / 60. Monetary equivalent requires an explicit hourly value. PAYG cost uses task credits only; neither estimate is realized savings.",
    ], 10)
    write(root / "guide_cowork_tasks" / "visual.json", note)
