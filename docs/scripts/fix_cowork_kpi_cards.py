"""Source of truth for the Cowork KPI card fixes, applied to a PBIP project.

The report layer of a shipped .pbit is signed, so this script never touches a
.pbit. It patches a working PBIP project produced by pbit_to_pbip.py (or
cowork_tasks/prepare_offline_export.py); Desktop then re-exports the template
and fix_pbit_defaults.py repairs the model parts. See docs/BUILD.md.

    python docs/scripts/fix_cowork_kpi_cards.py <project folder>

What it changes, and why:

1. "Weekly active" on the Consumption page counted anyone active in ANY loaded
   week, so it could exceed "Users" (people active in the selected period). It
   now reads Avg Weekly Active Users: the average of each week's distinct
   users inside the Cowork Period window, scoped like Consuming Users, so it
   can never exceed "Users". Weekly Active Users is unchanged - the weekly
   charts and external consumers read it per week.
2. The Cowork Period slicers showed "All" while every measure used four weeks.
   Each one is now single-select with "Current period (4 weeks)" selected, and
   that option always exists in the Cowork Period table so the saved default
   can never point at a missing value. The four-week fallback in Cowork Period
   Weeks stays as the safety net.
3. The Optimisation KPI row mixed figures that matched nothing else on the
   page. It is now four cards that add up and tie to "Financial impact by
   action": unused seats + oversized seats + upgrades (a cost) = net saving.
   Each $/mo value carries its seat count underneath. Licensed but Inactive
   is no longer shown; its description now says what it actually counts.

Every edit is idempotent. Running it twice changes nothing the second time.
"""
import copy
import json
import sys
import uuid
from pathlib import Path

BILLING = "CoworkBilling"
WEEKLY = "CreditsWeekly"
PERIOD_TABLE = "Cowork Period"
PERIOD_DEFAULT = "Current period (4 weeks)"

EXEC_PAGE = "exec-overview"
EXEC_CARD = "shell_right_kpi_0"
OPT_PAGE = "optimization"
OPT_CARD = "d5f31f7a4c29731259d1"
PERIOD_SLICERS = (
    ("exec-overview", "5692ed1abaddeaa99ea0"),
    ("optimization", "c469b2340514ccb66037"),
    ("dept-chargeback", "5f09f0e06ae088cc348d"),
    ("15fea4833c3bb97cc949", "bfad320015a44e333801"),
)


def lines(text):
    return text.strip("\n").split("\n")


def seat_value(groups, value):
    """Sum one Action Value /mo branch, so each card reconciles with it."""
    switch = "\n".join(f'            "{g}", {value},' for g in groups)
    return lines(f"""
VAR Rate = [Cowork PAYG Rate Value]
RETURN
SUMX(
    'CoworkBilling',
    VAR Act   = 'CoworkBilling'[Seat Action]
    VAR Limit = 'CoworkBilling'[MonthlyCreditLimit]
    VAR Delta = 'CoworkBilling'[Seat Delta]
    RETURN
        SWITCH(
            LEFT( Act, 1 ),
{switch}
            0
        )
)
""")


def seat_count(groups):
    members = ", ".join(f'"{g}"' for g in groups)
    return lines(f"""
CALCULATE(
    [User Count],
    KEEPFILTERS( LEFT( 'CoworkBilling'[Seat Action], 1 ) IN {{ {members} }} )
) + 0
""")


AVG_WEEKLY_ACTIVE = lines("""
VAR Wks = [Cowork Period Weeks]
VAR Seats = VALUES( 'CoworkBilling'[UserPrincipalName] )
VAR InWindow =
    FILTER( ALL( 'CreditsWeekly'[Weeks Ago] ), 'CreditsWeekly'[Weeks Ago] < Wks )
VAR PersonWeeks =
    SUMX(
        InWindow,
        CALCULATE(
            DISTINCTCOUNT( 'CreditsWeekly'[UserPrincipalName] ),
            REMOVEFILTERS( 'CreditsWeekly'[MetricDate] ),
            REMOVEFILTERS( 'CreditsWeekly'[Week Index] ),
            REMOVEFILTERS( 'CreditsWeekly'[Week Label] ),
            REMOVEFILTERS( 'Date' ),
            TREATAS( Seats, 'CreditsWeekly'[UserPrincipalName] )
        )
    )
RETURN
    DIVIDE( PersonWeeks, COUNTROWS( InWindow ) )
""")

UNUSED = ("1", "2")
OVERSIZED = ("3",)
UPGRADE = ("6",)
ACTIONED = UNUSED + OVERSIZED + UPGRADE

NEW_MEASURES = {
    "Avg Weekly Active Users": {
        "description": lines("""
Average number of people active each week across the selected Cowork period.
Uses the same window and seat scoping as Consuming Users, so it can never
exceed it. Weekly Active Users counts anyone active in any loaded week when no
week is in context, which is why it is not used on a card.
"""),
        "expression": AVG_WEEKLY_ACTIVE,
        "formatString": "#,0",
        "displayFolder": "Counts",
        "lineageTag": "5c0a6b1e-2f47-4d1a-9e01-3b8c7d000001",
    },
    "Unused Seats $": {
        "description": lines("""
Monthly value of the seats nobody is using: "1. Reclaim - never used" and
"2. Review - no usage in billing period", each at its full limit. The same
branches as Action Value /mo, so it ties to the Financial impact table.
"""),
        "expression": seat_value(UNUSED, "Limit * Rate"),
        "formatString": "\\$#,0",
        "displayFolder": "Optimisation",
        "lineageTag": "5c0a6b1e-2f47-4d1a-9e01-3b8c7d000002",
    },
    "Unused Seats": {
        "description": "Seats recommended to reclaim or review (actions 1 and 2).",
        "expression": seat_count(UNUSED),
        "formatString": "#,0",
        "displayFolder": "Optimisation",
        "lineageTag": "5c0a6b1e-2f47-4d1a-9e01-3b8c7d000003",
    },
    "Oversized Seats $": {
        "description": lines("""
Monthly value released by downsizing oversized seats ("3. Downsize"): only the
portion above the recommended limit. The same branch as Action Value /mo.
"""),
        "expression": seat_value(OVERSIZED, "MAX( 0, Delta ) * Rate"),
        "formatString": "\\$#,0",
        "displayFolder": "Optimisation",
        "lineageTag": "5c0a6b1e-2f47-4d1a-9e01-3b8c7d000004",
    },
    "Oversized Seats": {
        "description": "Seats recommended to downsize (action 3).",
        "expression": seat_count(OVERSIZED),
        "formatString": "#,0",
        "displayFolder": "Optimisation",
        "lineageTag": "5c0a6b1e-2f47-4d1a-9e01-3b8c7d000005",
    },
    "Upgrade Seats $": {
        "description": lines("""
Monthly cost of upgrading people who are persistently over their seat
("6. Upgrade - persistently over"). Negative, because it is spend rather than
a saving. The same branch as Action Value /mo.
"""),
        "expression": seat_value(UPGRADE, "-MAX( 0, -Delta ) * Rate"),
        "formatString": "\\$#,0",
        "displayFolder": "Optimisation",
        "lineageTag": "5c0a6b1e-2f47-4d1a-9e01-3b8c7d000006",
    },
    "Upgrade Seats": {
        "description": "Seats recommended to upgrade (action 6).",
        "expression": seat_count(UPGRADE),
        "formatString": "#,0",
        "displayFolder": "Optimisation",
        "lineageTag": "5c0a6b1e-2f47-4d1a-9e01-3b8c7d000007",
    },
    "Actioned Seats": {
        "description": lines("""
Seats with a recommendation that carries a monthly value: reclaim, review,
downsize or upgrade (actions 1, 2, 3 and 6). The seat count behind Right-Size
Net $.
"""),
        "expression": seat_count(ACTIONED),
        "formatString": "#,0",
        "displayFolder": "Optimisation",
        "lineageTag": "5c0a6b1e-2f47-4d1a-9e01-3b8c7d000008",
    },
}

UPDATED_DESCRIPTIONS = {
    "Licensed but Inactive": lines("""
Licensed people with no consumption in the four-week billing snapshot - a
licence-management question rather than a capacity one. Not "never used":
someone idle this period may have used Cowork earlier. Seat Action's
"1. Reclaim - never used" is the never-used count.
"""),
    "Right-Size Net $": lines("""
Value released each month by acting on every recommendation: reclaims and
downsizes, less the cost of the upgrades. Positive is a net saving. Equals
Unused Seats $ + Oversized Seats $ + Upgrade Seats $. Prefer it to
Reclaimable $, which resizes every seat and is not scoped to the
recommendation.
"""),
}

PERIOD_EXPRESSION = lines("""
// The window options are built from the history that is actually loaded,
// so the labels cannot drift from the data. "Current period (4 weeks)" is
// always present: it is the billing period every cost figure means, and the
// Period slicers save it as their default selection. Wider options appear
// only when there is more history than that - "Last 8 weeks" once more than
// eight weeks are loaded, "All history" once more than four are.
//
// VAR names avoid All, Filter and Current: DAX function names, and a
// colliding VAR name breaks every query on the model.
VAR MaxWeeks =
    COUNTROWS( DISTINCT( 'CreditsWeekly'[Week Index] ) )
VAR BillingPeriod =
    ROW( "Period", "Current period (4 weeks)", "Period Order", 1, "Weeks", 4 )
VAR Wider =
    FILTER(
        UNION(
            ROW( "Period", "Last 8 weeks", "Period Order", 2, "Weeks", 8 ),
            ROW(
                "Period", "All history (" & FORMAT( MaxWeeks, "#,0" ) & " weeks)",
                "Period Order", 3,
                "Weeks", MaxWeeks
            )
        ),
        [Weeks] > 4 && ( [Period Order] = 3 || [Weeks] < MaxWeeks )
    )
RETURN
    UNION( BillingPeriod, Wider )
""")


def measure_ref(entity, name):
    return {"Measure": {"Expression": {"SourceRef": {"Entity": entity}},
                        "Property": name}}


def projection(entity, name, native, display):
    return {"field": measure_ref(entity, name),
            "queryRef": f"{entity}.{name}",
            "nativeQueryRef": native,
            "displayName": display}


# (value measure, label, seat-count measure). Order is the reading order:
# the three parts, then the total they add up to.
OPT_TILES = (
    ("Unused Seats $", "Unused seats /mo", "Unused Seats"),
    ("Oversized Seats $", "Oversized seats /mo", "Oversized Seats"),
    ("Upgrade Seats $", "Upgrades (cost) /mo", "Upgrade Seats"),
    ("Right-Size Net $", "Net saving /mo", "Actioned Seats"),
)
SEAT_TITLES = {
    "Unused Seats": "Seats",
    "Oversized Seats": "Seats",
    "Upgrade Seats": "Seats",
    "Actioned Seats": "Seats actioned",
}

EXEC_OLD = f"{WEEKLY}.Weekly Active Users"
EXEC_NEW = projection(BILLING, "Avg Weekly Active Users",
                      "Avg weekly active", "Avg weekly active")


def literal(value):
    return {"expr": {"Literal": {"Value": value}}}


def period_filter():
    return {"filter": {
        "Version": 2,
        "From": [{"Name": "c", "Entity": PERIOD_TABLE, "Type": 0}],
        "Where": [{"Condition": {"In": {
            "Expressions": [{"Column": {
                "Expression": {"SourceRef": {"Source": "c"}},
                "Property": "Period"}}],
            "Values": [[{"Literal": {"Value": f"'{PERIOD_DEFAULT}'"}}]]}}}]}}


class PatchError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise PatchError(message)


def named(items, label):
    require(isinstance(items, list), f"{label}: expected a list")
    return {item.get("name"): item for item in items}


def patch_model(bim):
    """Patch a model.bim / DataModelSchema document in place."""
    changes = []
    tables = named(bim["model"]["tables"], "tables")
    for table in (BILLING, WEEKLY, PERIOD_TABLE):
        require(table in tables, f"missing table {table}")
    billing = tables[BILLING]["measures"]
    measures = named(billing, BILLING)
    for name in ("Action Value /mo", "Right-Size Net $", "Consuming Users",
                 "User Count", "Licensed but Inactive"):
        require(name in measures, f"missing measure {name}")
    columns = named(tables[BILLING]["columns"], f"{BILLING} columns")
    for name in ("Seat Action", "Seat Delta", "MonthlyCreditLimit"):
        require(name in columns, f"missing column {name}")
    for group in ACTIONED:
        require(f'"{group}"' in "\n".join(_as_lines(measures["Action Value /mo"]["expression"])),
                f"Action Value /mo no longer has branch {group}")

    for name, spec in NEW_MEASURES.items():
        target = measures.get(name)
        if target is None:
            target = {"name": name, **copy.deepcopy(spec)}
            billing.append(target)
            measures[name] = target
            changes.append(f"added measure {name}")
            continue
        for key, value in spec.items():
            if target.get(key) != value:
                target[key] = copy.deepcopy(value)
                changes.append(f"{name}: {key}")

    for name, description in UPDATED_DESCRIPTIONS.items():
        if measures[name].get("description") != description:
            measures[name]["description"] = description
            changes.append(f"{name}: description")

    partition = tables[PERIOD_TABLE]["partitions"][0]["source"]
    require(partition.get("type") == "calculated", "Cowork Period is not a calculated table")
    if partition.get("expression") != PERIOD_EXPRESSION:
        partition["expression"] = PERIOD_EXPRESSION
        changes.append("Cowork Period: expression")

    names = [m["name"] for m in billing]
    require(len(names) == len(set(names)), "duplicate measure names")
    return changes


def _as_lines(expression):
    return expression if isinstance(expression, list) else str(expression).split("\n")


def _visual_path(definition, page, visual):
    return Path(definition) / "pages" / page / "visuals" / visual / "visual.json"


def patch_exec_card(document):
    visual = document["visual"]
    projections = visual["query"]["queryState"]["Data"]["projections"]
    refs = [p["queryRef"] for p in projections]
    if EXEC_NEW["queryRef"] in refs:
        return []
    require(EXEC_OLD in refs, f"{EXEC_CARD}: no Weekly Active Users tile")
    projections[refs.index(EXEC_OLD)] = copy.deepcopy(EXEC_NEW)
    return [f"{EXEC_CARD}: Weekly active -> Avg weekly active"]


def opt_projections():
    return [projection(BILLING, value, label, label) for value, label, _ in OPT_TILES]


def patch_opt_card(document):
    visual = document["visual"]
    require(visual.get("visualType") == "cardVisual", f"{OPT_CARD}: not a cardVisual")
    changes = []
    data = visual["query"]["queryState"]["Data"]
    wanted = opt_projections()
    if data.get("projections") != wanted:
        data["projections"] = wanted
        changes.append(f"{OPT_CARD}: four reconciling tiles")
    layout = visual["objects"].setdefault("layout", [])
    for entry in layout:
        if "selector" not in entry:
            props = entry.setdefault("properties", {})
            for key, value in (("columnCount", "4L"), ("maxTiles", "4L")):
                if props.get(key) != literal(value):
                    props[key] = literal(value)
                    changes.append(f"{OPT_CARD}: layout {key}")
    changes += patch_reference_labels(visual)
    return changes


def reference_id(count_measure):
    """Stable per-tile reference-label id, so a re-run writes identical JSON."""
    key = f"consumption-central/{OPT_CARD}/{count_measure}"
    return f"field-{uuid.uuid5(uuid.NAMESPACE_URL, key)}"


def reference_objects():
    """Seat-count reference label under each tile.

    The selector shape (data wildcard + metadata = the tile's queryRef + a
    "field-<uuid>" id + order) and the per-id title/detail entries mirror cards
    authored in Power BI Desktop.
    """
    labels, titles, details, values = [], [], [], []
    for value, _, count in OPT_TILES:
        tile = f"{BILLING}.{value}"
        ident = reference_id(count)
        labels.append({
            "properties": {"value": {"expr": measure_ref(BILLING, count)}},
            "selector": {"data": [{"dataViewWildcard": {"matchingOption": 0}}],
                         "metadata": tile, "id": ident, "order": 0}})
        titles.append({
            "properties": {"show": literal("true"),
                           "titleContentType": literal("'custom'"),
                           "titleText": literal(f"'{SEAT_TITLES[count]}'"),
                           "titleFontSize": literal("8D")},
            "selector": {"metadata": tile, "id": ident}})
        details.append({"properties": {"show": literal("false")},
                        "selector": {"metadata": tile, "id": ident}})
        values.append({"properties": {"valueFontSize": literal("8D"),
                                      "valueDisplayUnits": literal("1D")},
                       "selector": {"metadata": tile, "id": ident}})
    return {"referenceLabel": labels, "referenceLabelTitle": titles,
            "referenceLabelDetail": details, "referenceLabelValue": values}


def patch_reference_labels(visual):
    objects = visual.setdefault("objects", {})
    changes = []
    for key, wanted in reference_objects().items():
        if objects.get(key) != wanted:
            objects[key] = wanted
            changes.append(f"{OPT_CARD}: {key}")
    return changes


def patch_period_slicer(document, label):
    visual = document["visual"]
    require(visual.get("visualType") == "slicer", f"{label}: not a slicer")
    projections = visual["query"]["queryState"]["Values"]["projections"]
    require([p.get("queryRef") for p in projections] == [f"{PERIOD_TABLE}.Period"],
            f"{label}: not the Cowork Period slicer")
    objects = visual.setdefault("objects", {})
    changes = []
    selection = objects.setdefault("selection", [{"properties": {}}])
    props = selection[0].setdefault("properties", {})
    for key in ("singleSelect", "strictSingleSelect"):
        if props.get(key) != literal("true"):
            props[key] = literal("true")
            changes.append(f"{label}: {key}")
    general = objects.setdefault("general", [])
    stored = [e for e in general if "filter" in e.get("properties", {})]
    if not stored:
        general.append({"properties": {"filter": period_filter()}})
        changes.append(f"{label}: default {PERIOD_DEFAULT}")
    elif stored[0]["properties"]["filter"] != period_filter():
        stored[0]["properties"]["filter"] = period_filter()
        changes.append(f"{label}: default {PERIOD_DEFAULT}")
    return changes


def patch_report(definition):
    changes = []
    targets = [((EXEC_PAGE, EXEC_CARD), patch_exec_card),
               ((OPT_PAGE, OPT_CARD), patch_opt_card)]
    targets += [(slicer, lambda d, s=slicer: patch_period_slicer(d, "/".join(s)))
                for slicer in PERIOD_SLICERS]
    for (page, visual), patch in targets:
        path = _visual_path(definition, page, visual)
        require(path.is_file(), f"missing {path}")
        document = json.loads(path.read_text(encoding="utf-8"))
        changed = patch(document)
        if changed:
            path.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n",
                            encoding="utf-8", newline="\n")
            changes += changed
    return changes


def patch_project(project):
    project = Path(project)
    models = list(project.glob("*.SemanticModel/model.bim"))
    reports = list(project.glob("*.Report/definition"))
    require(len(models) == 1 and len(reports) == 1,
            f"{project}: expected one model.bim and one report definition")
    bim = json.loads(models[0].read_text(encoding="utf-8-sig"))
    changes = patch_model(bim)
    if changes:
        models[0].write_text(json.dumps(bim, indent=2, ensure_ascii=False) + "\n",
                             encoding="utf-8", newline="\n")
    return changes + patch_report(reports[0])


def main(argv):
    if len(argv) != 1:
        print(__doc__)
        return 2
    try:
        changes = patch_project(argv[0])
    except PatchError as error:
        print(f"FAIL {error}")
        return 1
    for change in changes:
        print(f"  {change}")
    print(f"{len(changes)} change(s)" if changes else "already patched")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
