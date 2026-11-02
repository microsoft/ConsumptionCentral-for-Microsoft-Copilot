"""Generate the "2.2. Cowork: Chargeback" page in a PBIP report.

The page reads the measures and SpendingPolicy columns that fix_chargeback.py
adds to the model. Its look comes from the Cowork pages beside it: the header
is copied from exec-overview and the Cost page, the styling helpers are the
task page's (cowork_tasks/report.py), and the period, service, pack balance
and spending policy slicers are copies of the Cost page's, so they stay in the
same sync groups and a selection carries between the two pages.

Every run rebuilds the page from scratch, so running it twice changes nothing.
"""
import copy
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "cowork_tasks"))

from report import (  # noqa: E402  (cowork_tasks/report.py)
    BOTTOM, CONTENT_WIDTH, GAP, LEFT, REGULAR, RIGHT, RIGHT_WIDTH, TOP,
    axis_style, card, color, field, integer, obj, projection, selected, slicer, textbox, theme, visual, write,
)

PAGE = "cowork-chargeback"
AFTER_PAGES = ("cowork-tasks", "dept-chargeback")
COST_PAGE = "dept-chargeback"
DISPLAY_NAME = "2.2. Cowork: Chargeback"
TITLE = "Cowork / WorkIQ Credits: Chargeback   "
SUBTITLE = "Who pays - each cost centre's share of the capacity pack and pay-as-you-go"

FACT = "CoworkBilling"
POLICY = "SpendingPolicy"
MEASURES = (
    "Chargeback Prepaid Share %", "Allocated Credits", "Allocated Prepaid Credits", "Allocated PAYG Credits",
    "Allocated Prepaid Cost", "Allocated PAYG Cost", "Allocated Cost", "Allocated Cost Share %",
)
COLUMNS = ("CostCentre", "Department", "BillingOwner", "ChargeCode")

# Cost page visuals copied as they are, then moved: (visual, new name, y, height).
COPIED = (
    ("5f09f0e06ae088cc348d", "cb_period", 69, 64),
    ("506d75e24b0a6c575780", "cb_service", 141, 64),
    ("cost_pack_balance", "cb_pack_balance", 213, 64),
    ("cd0b89209485490d92c9", "cb_policy", 429, 64),
    ("ae33b81252d2ea78c372", "cb_rates", 503, 100),
    ("cost_basis", "cb_basis", 611, BOTTOM - 611),
)
FOOTNOTE = (
    "The capacity pack is shared pro rata: every cost centre is charged the tenant's prepaid share of its "
    "credits at the prepaid rate and the rest at the pay-as-you-go rate, so the charges add up to Cowork Total "
    "Cost. The rates are the ones the Cost page uses. (Not assigned): the spending policy has no cost centre or "
    "department in the policy file. (Blank): the person's spending policy isn't in the policy file."
)


def metric(name, label=None):
    return projection(FACT, name, True, label)


def column(name, label=None):
    return projection(POLICY, name, label=label)


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def framed(item):
    chrome = item["visual"]["visualContainerObjects"]
    chrome["background"] = obj(show=False, color=theme(0), transparency=0)
    chrome["border"] = obj(show=True, color=theme(0, -0.1), radius=5, width=1)
    chrome["padding"] = obj(top=5, bottom=5, left=5, right=5)
    chrome["spacing"] = obj(customizeSpacing=True, verticalSpacing=2, spaceBelowSubTitle=12)
    return item


def numeric(values, width):
    widths, formats = [], []
    for item in values:
        widths.append(selected({"metadata": item["queryRef"]}, value=width))
        formats.append(selected({"metadata": item["queryRef"]}, alignment="Right", styleHeader=True,
                                styleTotal=True))
    return widths, formats


def grid_style(header_width):
    return {
        "columnHeaders": obj(outlineStyle=0, fontFamily=REGULAR, fontSize=8, bold=False, alignment="Left",
                             titleAlignment="Left", wordWrap=True, columnAdjustment="fixedWidth",
                             defaultColumnWidth=header_width),
        "values": obj(outlineStyle=1, outlineWeight=2, fontFamily=REGULAR, fontSize=8,
                      backColorSecondary=theme(0, -0.1), bandedRowHeaders=True, wordWrap=True),
        "grid": obj(outlineStyle=15, outlineColor=color("#E5E5E5"), outlineWeight=2, gridVertical=True,
                    gridVerticalWeight=2, gridHorizontal=True, gridHorizontalWeight=2, rowPadding=5),
    }


def by_cost(item):
    item["visual"]["query"]["sortDefinition"] = {
        "sort": [{"field": field(FACT, "Allocated Cost", True), "direction": "Descending"}]}
    return item


def bar_chart(position):
    item = framed(visual("cb_by_cost_centre", "clusteredBarChart", position, {
        "Category": [column("CostCentre", "Cost centre")],
        "Y": [metric("Allocated Cost", "Allocated cost (USD)")],
        "Tooltips": [metric("Allocated Credits"), metric("Allocated Cost Share %")],
    }, "ALLOCATED COST BY COST CENTRE", "Prepaid share plus pay-as-you-go"))
    item["visual"]["objects"] = {
        "categoryAxis": axis_style(maxMarginFactor=integer(45), preferredCategoryWidth=10),
        "valueAxis": obj(show=False, showAxisTitle=False),
        "labels": obj(show=True, color=theme(1)),
        "legend": obj(show=False),
        "dataPoint": obj(defaultColor=color("#7F215D")),
    }
    return by_cost(item)


def matrix(position):
    rows = [column("CostCentre", "Cost centre"), column("Department")]
    values = [
        metric("Allocated Credits", "Credits"),
        metric("Allocated Prepaid Credits", "Prepaid credits"),
        metric("Allocated PAYG Credits", "PAYG credits"),
        metric("Allocated Cost", "Cost (USD)"),
        metric("Allocated Cost Share %", "Share"),
    ]
    item = framed(visual("cb_matrix", "pivotTable", position, {"Rows": rows, "Values": values},
                         "CHARGEBACK BY COST CENTRE", "Expand a cost centre for its departments"))
    widths, formats = numeric(values, 80)
    style = grid_style(80)
    style.update({
        "rowHeaders": obj(outlineStyle=3, fontFamily=REGULAR, fontSize=8, alignment="Left",
                          steppedLayoutIndentation=10, showExpandCollapseButtons=True,
                          repeatRowHeaders=False, wordWrap=True),
        "general": obj(layout="Outline"),
        "blankRows": obj(showBlankRows=False),
        "columnWidth": [selected({"metadata": rows[0]["queryRef"]}, value=180)] + widths,
        "columnFormatting": formats,
    })
    item["visual"]["objects"] = style
    return by_cost(item)


def charge_lines(position):
    keys = [column("CostCentre", "Cost centre"), column("Department"), column("Policy Name", "Spending policy"),
            column("BillingOwner", "Billing owner"), column("ChargeCode", "Charge code")]
    values = [
        metric("Allocated Credits", "Credits"),
        metric("Allocated Prepaid Cost", "Prepaid (USD)"),
        metric("Allocated PAYG Cost", "PAYG (USD)"),
        metric("Allocated Cost", "Charge (USD)"),
    ]
    item = framed(visual("cb_lines", "tableEx", position, {"Values": keys + values},
                         "CHARGE LINES", "One line per spending policy, ready to book; the total is Cowork Total Cost"))
    widths, formats = numeric(values, 95)
    style = grid_style(120)
    style.update({
        "total": obj(totals=True, fontFamily=REGULAR, fontSize=8),
        "columnWidth": [selected({"metadata": key["queryRef"]}, value=width)
                        for key, width in zip(keys, (130, 130, 150, 130, 110))] + widths,
        "columnFormatting": formats,
    })
    item["visual"]["objects"] = style
    return by_cost(item)


def check_model(model):
    """Refuse a project whose model lacks fix_chargeback.py's columns and measures."""
    tables = {table["name"]: table for table in model["model"]["tables"]}
    columns = {item["name"] for item in tables.get(POLICY, {}).get("columns", [])}
    measures = {item["name"] for item in tables.get(FACT, {}).get("measures", [])}
    missing = sorted((set(COLUMNS) - columns) | (set(MEASURES) - measures))
    require(not missing, "The model has no " + ", ".join(missing) + ". Run docs/scripts/fix_chargeback.py on "
            "the .pbit before expanding it.")


def build(pages):
    """The page's page.json and its visuals, {name: visual.json}."""
    base, cost = pages / "exec-overview", pages / COST_PAGE / "visuals"
    page = read(base / "page.json")
    page.update(name=PAGE, displayName=DISPLAY_NAME)
    page.pop("visualInteractions", None)
    visuals = []
    for old, new in (("e1f908be0732c0914e41", "cb_logo"),
                     ("shell_header_accent", "cb_accent"),
                     ("gd_execoverview_btn", "cb_guide")):
        item = read(base / "visuals" / old / "visual.json")
        item["name"] = new
        visuals.append(item)
    header = read(cost / "bba771b1b975d56897fb" / "visual.json")
    header["name"] = "cb_title"
    header["position"].update(x=66, y=5, width=1135, height=48)
    runs = header["visual"]["objects"]["general"][0]["properties"]["paragraphs"][0]["textRuns"]
    runs[0]["value"], runs[2]["value"] = TITLE, SUBTITLE
    visuals.append(header)

    visuals.append(card("cb_kpis", (LEFT, TOP, CONTENT_WIDTH, 71.84), [
        metric("Allocated Cost", "Allocated cost"),
        metric("Allocated Prepaid Cost", "From the capacity pack"),
        metric("Allocated PAYG Cost", "Pay-as-you-go"),
        metric("Chargeback Prepaid Share %", "Prepaid share of credits"),
        metric("Allocated Credits", "Credits charged"),
    ]))
    chart_width = 400
    visuals.append(bar_chart((LEFT, 151, chart_width, 255)))
    visuals.append(matrix((LEFT + chart_width + GAP, 151, round(CONTENT_WIDTH - chart_width - GAP, 2), 255)))
    visuals.append(charge_lines((LEFT, 416, CONTENT_WIDTH, 256)))
    visuals.append(textbox("cb_footnote", (LEFT, 676, CONTENT_WIDTH, 38), [FOOTNOTE], 8, "#6B7280"))

    for old, new, y, height in COPIED:
        item = copy.deepcopy(read(cost / old / "visual.json"))
        item["name"] = new
        item["position"].update(x=RIGHT, y=y, width=RIGHT_WIDTH, height=height, tabOrder=y * 10 + round(RIGHT))
        if new == "cb_pack_balance":  # its label sits beside it on the Cost page; here it needs its own
            item["visual"]["objects"]["header"][0]["properties"].update(
                obj(show=True, text="CAPACITY PACK BALANCE")[0]["properties"])
        visuals.append(item)
    for name, y, col, label in (("cb_cost_centre", 285, "CostCentre", "Cost centre"),
                                ("cb_department", 357, "Department", "Department")):
        item = slicer(name, y, POLICY, col, label)
        item["position"]["height"] = 64
        visuals.append(item)
    return page, {item["name"]: item for item in visuals}


def apply(report):
    """Write the page into a PBIP report folder and return how many visuals it has."""
    pages = report / "definition" / "pages"
    binding = read(report / "definition.pbir")
    check_model(read((report / binding["datasetReference"]["byPath"]["path"]).resolve() / "model.bim"))
    page, visuals = build(pages)
    root = pages / PAGE
    shutil.rmtree(root, ignore_errors=True)
    write(root / "page.json", page)
    for name, item in visuals.items():
        write(root / "visuals" / name / "visual.json", item)
    order_path = pages / "pages.json"
    order = read(order_path)
    names = [name for name in order["pageOrder"] if name != PAGE]
    after = next(name for name in AFTER_PAGES if name in names)
    names.insert(names.index(after) + 1, PAGE)
    order["pageOrder"] = names
    write(order_path, order)
    return len(visuals)
