"""Generate only the new task page and its additions to the existing Cowork guide.

Styling mirrors the established Cowork pages (exec-overview, dept-chargeback and
optimization) so the task page shares their fonts, theme colours, grid and matrix look.
"""
import json
import shutil

from model import FACT, CATEGORY, DATES, PEOPLE, PERIOD, SCENARIO, HOURLY

PAGE = "cowork-tasks"
AFTER_PAGE = "dept-chargeback"
DISPLAY_NAME = "2.1. Cowork: Tasks"
SCHEMA = "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.11.0/schema.json"
SEMIBOLD = "'Segoe UI Semibold', wf_segoe-ui_semibold, helvetica, arial, sans-serif"
REGULAR = "'Segoe UI', wf_segoe-ui_normal, helvetica, arial, sans-serif"
LEGEND_FONT = "wf_standard-font, helvetica, arial, sans-serif"

# Grid shared with the sibling pages: content column, right-hand control column, row starts.
LEFT, CONTENT_WIDTH, GAP = 8.33, 1026.64, 10
RIGHT, RIGHT_WIDTH = 1045.23, 222
TOP, ROW, BOTTOM = 68.72, 151, 710


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


def integer(value):
    return {"expr": {"Literal": {"Value": f"{value}L"}}}


def color(value):
    return {"solid": {"color": literal(value)}}


def theme(color_id, percent=0):
    return {"solid": {"color": {"expr": {"ThemeDataColor": {"ColorId": color_id, "Percent": percent}}}}}


def selected(selector, **properties):
    return {"properties": obj(**properties)[0]["properties"], "selector": selector}


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
                     background=color("#FFFFFF"), fontFamily=SEMIBOLD, alignment="left"),
        "subTitle": obj(show=bool(subtitle), text=subtitle or "", fontSize=9, fontColor=color("#6B7280")),
        "background": obj(show=True, color=theme(0), transparency=0),
        "border": obj(show=False, color=theme(0, -0.1), radius=5, width=1),
        "dropShadow": obj(show=False),
        "padding": obj(top=5, bottom=5, left=5, right=10),
        "visualHeader": obj(show=False),
        "general": obj(keepLayerOrder=True),
        "visualTooltip": obj(titleFontColor=color("#1C2632"), valueFontColor=color("#1C2632"),
                             background=color("#FFFFFF")),
    }
    result = {"$schema": SCHEMA, "name": name,
              "position": {"x": x, "y": y, "width": width, "height": height, "z": 1000,
                           "tabOrder": round(y) * 10 + round(x)},
              "visual": {"visualType": kind, "objects": {}, "visualContainerObjects": chrome,
                         "drillFilterOtherVisuals": True}}
    if roles:
        result["visual"]["query"] = {"queryState": {
            role: {"projections": values} for role, values in roles.items()}}
    return result


def card(name, position, values, font=11, labels=True, align=None):
    """KPI tiles when labels are shown; otherwise an outlined single-value note."""
    result = visual(name, "cardVisual", position, {"Data": values})
    value = {"fontSize": font, "fontFamily": SEMIBOLD if labels else REGULAR, "bold": False,
             "fontColor": theme(0, -0.5) if labels else color("#1C2632"), "showBlankAs": "-",
             "labelDisplayUnits": 0, "textWrap": True}
    if align:
        value["horizontalAlignment"] = align
    result["visual"]["objects"] = {
        "value": obj(True, **value),
        "label": obj(True, show=labels, fontSize=8, fontFamily=REGULAR, textWrap=True,
                     position="belowValue", fontColor=theme(1)),
        "outline": obj(True, show=True, lineColor=theme(0, -0.1)),
        "accentBar": obj(True, show=False),
        "divider": obj(True, show=False),
        "fillCustom": obj(True, fillColor=theme(0), transparency=0),
        "shapeCustomRectangle": obj(True, tileShape="rectangleRoundedByPixel",
                                    rectangleRoundedCurve=integer(5)),
        "padding": obj(True, paddingUniform=8),
        "spacing": obj(True, verticalSpacing=2),
        "layout": obj(orientation=2, rowCount=integer(1), columnCount=integer(len(values)),
                      maxTiles=integer(len(values)), cellPadding=integer(11), paddingUniform=0,
                      autoGrid=False) + obj(True, backgroundShow=False),
    }
    chrome = result["visual"]["visualContainerObjects"]
    chrome["background"] = obj(show=False)
    chrome["padding"] = obj(top=0, bottom=0, left=0, right=0)
    return result


def slicer(name, y, table, column, label, default=None, strict=False):
    result = visual(name, "slicer", (RIGHT, y, RIGHT_WIDTH, 80),
                    {"Values": [projection(table, column)]})
    result["visual"]["objects"] = {
        "data": obj(mode="Dropdown"),
        "header": obj(show=True, text=label.upper(), textSize=9, fontColor=theme(1, 0.4)),
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


def textbox(name, position, paragraphs, size=11, font_color="#1C2632"):
    result = visual(name, "textbox", position)
    result["visual"]["objects"] = {"general": [{"properties": {"paragraphs": [
        {"textRuns": [{"value": text, "textStyle": {"fontFamily": "Segoe UI", "fontSize": f"{size}pt", "color": font_color}}]}
        for text in paragraphs
    ]}}]}
    result["visual"]["visualContainerObjects"]["background"] = obj(show=False)
    return result


def axis_style(**properties):
    return obj(labelColor=theme(1, 0.4), showAxisTitle=False, titleFontSize=9, titleBold=False,
               titleColor=theme(0, -0.6), **properties)


def matrix_style(rows, values, row_width, value_width):
    """Match the sibling matrices; numeric columns are right-aligned, headers and totals included."""
    widths = [selected({"metadata": rows["queryRef"]}, value=row_width)]
    formats = []
    for item in values:
        widths.append(selected({"metadata": item["queryRef"]}, value=value_width))
        formats.append(selected({"metadata": item["queryRef"]}, alignment="Right",
                                styleHeader=True, styleTotal=True))
    return {
        "columnHeaders": obj(outlineStyle=0, fontFamily=REGULAR, fontSize=8, bold=False, alignment="Left",
                             titleAlignment="Left", wordWrap=True, columnAdjustment="fixedWidth",
                             defaultColumnWidth=value_width),
        "rowHeaders": obj(outlineStyle=3, fontFamily=REGULAR, fontSize=8, alignment="Left",
                          steppedLayoutIndentation=10, showExpandCollapseButtons=False,
                          repeatRowHeaders=False, wordWrap=True),
        "values": obj(outlineStyle=1, outlineWeight=2, fontFamily=REGULAR, fontSize=8,
                      backColorSecondary=theme(0, -0.1), bandedRowHeaders=True, wordWrap=True),
        "grid": obj(outlineStyle=15, outlineColor=color("#E5E5E5"), outlineWeight=2, gridVertical=True,
                    gridVerticalWeight=2, gridHorizontal=True, gridHorizontalWeight=2, rowPadding=5),
        "general": obj(layout="Outline"),
        "blankRows": obj(showBlankRows=False),
        "columnWidth": widths,
        "columnFormatting": formats,
    }


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
    half = round((CONTENT_WIDTH - GAP) / 2, 2)
    visuals.append(card("task_kpis", (LEFT, TOP, CONTENT_WIDTH, 71.84), [
        metric("Reported Cowork Tasks", "Reported tasks"),
        metric("Cowork Task Credits", "Task credits"),
        metric("Cowork Credits per Task", "Credits per task"),
        metric("Cowork Expert-equivalent Hours", "Est. expert-equivalent hours"),
    ]))
    visuals.append(card("task_status", (LEFT, ROW, CONTENT_WIDTH, 30),
                         [metric("Cowork Task Status Message")], font=9, labels=False, align="left"))
    category = visual("task_mix", "clusteredBarChart", (LEFT, 191, half, 230), {
        "Category": [projection(CATEGORY, "TaskCategory", label="Task category")],
        "Y": [metric("Cowork Task Share", "Share of reported tasks")],
        "Tooltips": [metric("Reported Cowork Tasks"), metric("Cowork Credits per Task")],
    }, "REPORTED TASKS BY CATEGORY", "Share of tasks in the current selection")
    category["visual"]["objects"] = {
        "categoryAxis": axis_style(maxMarginFactor=integer(55), preferredCategoryWidth=10,
                                   innerPadding=integer(15)),
        "valueAxis": obj(show=False, showAxisTitle=False),
        "labels": obj(show=True, color=theme(1)),
        "legend": obj(show=False, fontFamily=LEGEND_FONT),
        "dataPoint": obj(defaultColor=color("#7F215D")),
    }
    category["visual"]["query"]["sortDefinition"] = {
        "sort": [{"field": field(FACT, "Cowork Task Share", True), "direction": "Descending"}]}
    visuals.append(category)
    trend = visual("task_trend", "columnChart", (round(LEFT + half + GAP, 2), 191, half, 230), {
        "Category": [projection(DATES, "Week Start")],
        "Y": [metric("Reported Cowork Tasks", "Reported tasks")],
        "Series": [projection(FACT, "TaskType", label="Initiation type")],
        "Tooltips": [metric("Cowork Task Credits"), metric("Cowork Credits per Task")],
    }, "REPORTED TASKS OVER TIME", "Weekly activity by initiation type")
    trend["visual"]["objects"] = {
        "categoryAxis": axis_style(axisType="Categorical"),
        "valueAxis": obj(showAxisTitle=False, titleFontSize=9, titleBold=False, titleColor=theme(0, -0.6)),
        "legend": obj(show=True, position="Top", showTitle=False, fontFamily=LEGEND_FONT),
        "labels": obj(show=False, color=theme(1)),
    }
    trend["visual"]["query"]["sortDefinition"] = {
        "sort": [{"field": field(DATES, "Week Start"), "direction": "Ascending"}]}
    visuals.append(trend)
    rows = projection(CATEGORY, "TaskCategory", label="Task category")
    values = [
        metric("Reported Cowork Tasks", "Tasks"),
        metric("Cowork Credits per Task", "Credits / task"),
        metric("Cowork PAYG Cost per Task", "Est. PAYG / task"),
        metric("Cowork Task Effort Minutes", "Est. min / task"),
        metric("Cowork Expert-equivalent Hours", "Est. expert hours"),
        metric("Cowork Task Monetary Equivalent", "Est. equivalent (USD)"),
    ]
    matrix = visual("task_details", "pivotTable", (LEFT, 431, CONTENT_WIDTH, 245),
                    {"Rows": [rows], "Values": values},
                    "TASK ACTIVITY AND ESTIMATED WORK EQUIVALENT",
                    "Observed counts and credits; provisional effort and value assumptions")
    matrix["visual"]["objects"] = matrix_style(rows, values, 270, 122)
    chrome = matrix["visual"]["visualContainerObjects"]
    chrome["background"] = obj(show=False, color=theme(0), transparency=0)
    chrome["border"] = obj(show=True, color=theme(0, -0.1), radius=5, width=1)
    chrome["padding"] = obj(top=5, bottom=5, left=5, right=5)
    chrome["spacing"] = obj(customizeSpacing=True, verticalSpacing=2, spaceBelowSubTitle=16)
    visuals.append(matrix)
    visuals.append(textbox("task_footnote", (LEFT, 682, CONTENT_WIDTH, 28), [
        "Estimates are not measured time saved or successful completions. Unknown and unmapped tasks remain in observed totals."
    ], 9, "#6B7280"))
    for args in (
        ("task_period", 69, PERIOD, "Period", "Task period", None, True),
        ("task_type", 151, FACT, "TaskType", "Initiation type"),
        ("task_category", 233, CATEGORY, "TaskCategory", "Task category"),
        ("task_organization", 315, PEOPLE, "Organization", "Task organization"),
        ("task_scenario", 397, SCENARIO, "Scenario", "Effort scenario", "Typical", True),
        ("task_hourly", 479, HOURLY, "Hourly Value", "Expert hourly value (USD)", None, True),
    ):
        visuals.append(slicer(*args))
    hourly = visuals[-1]
    hourly["visual"]["query"]["sortDefinition"] = {
        "sort": [{"field": field(HOURLY, "Hourly Value"), "direction": "Ascending"}]}
    visuals.append(card("task_value_basis", (RIGHT, 569, RIGHT_WIDTH, BOTTOM - 569),
                         [metric("Cowork Task Value Basis")], font=9, labels=False, align="center"))
    shutil.rmtree(root / "visuals", ignore_errors=True)
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
    marker = "Task categories (optional)"
    write(foot, textbox("guidecowor_foot", (28, 524, 580, 170), [
        "Watch out for",
        "Legacy consumption: de-identified totals remain valid. For person and department views, enable identification in Viva Feature Access Management or, on the CSV path, use PersonPolicyMap.csv to link hashes to UPNs.",
        "Task metadata is separate and can supply historical organization without a UPN.",
        "Forecast quality depends on the weeks loaded. A short history gives little more than a straight line.",
    ], 11))
    note = textbox("guide_cowork_tasks", (650, 516, 602, 190), [
        marker,
        "Independent task export: counts and fractional credits, not additional billing. Missing data leaves the task page blank.",
        "Typical provisional ValueLens category minutes are selected initially. In Transform data, select Cowork Task Categories > Advanced Editor to edit bands; use the matrix to inspect effective minutes.",
        "Hours = reported tasks x category minutes / 60. Monetary equivalent requires an explicit hourly value. PAYG cost uses task credits only; neither estimate is realized savings.",
    ], 10)
    write(root / "guide_cowork_tasks" / "visual.json", note)
