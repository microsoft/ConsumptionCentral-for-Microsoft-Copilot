"""Port Analytics Hub's fixes to three measures into the three current templates.

Taken from microsoft/AnalyticsHub-Dashboard at commit 5d5d80a:

* CoworkBilling[Users Over Limit] and CoworkBilling[Policy Allowance] come
  from scripts/Update-Template-Dax.py's CONSUMPTION_OBJECTS (P9: a blank or
  zero Cowork limit means no limit is set).
    - Users Over Limit counted everyone who used credits without a limit, or
      with a limit of 0, as over it. It now counts only people who have a
      limit, and gives 0 rather than BLANK when nobody is over.
    - Policy Allowance gives BLANK rather than 0 when the spending policies
      set no limit.
* AzureAiSpend[Foundry Tokens (M)] comes from Analytics Hub's Foundry token
  counts fix (378ef72). It added up UsageQuantity as if every token meter were
  billed per million tokens. Older meters are billed per thousand, so their
  tokens counted a thousand times over. Each row is now converted by its
  meter's name: meters with "1M Token" in it count as they are, other token
  meters are divided by 1,000, and meters that aren't tokens (pages, images,
  hours) count as zero. Its description says so. Foundry Cost per 1M Tokens
  divides by it, so it is corrected too.

The rest of P9 (Person Allowance, Person Headroom, Over Limit Credits, Users
Near Limit and Policy Headroom) is not ported here.

Only DataModelSchema changes: these are measures, and UnappliedChanges holds
queries alone. Each measure moves only from the exact text it shipped with,
so one edited since fails the run, as does anything else that moves in the
model. Every other ZIP member keeps its raw bytes - the report layer is signed
by SecurityBindings. Running it twice changes nothing. The archived Power
Automate + Dataverse template keeps its text.

    python docs/scripts/fix_limit_and_token_measures.py --dry-run
    python docs/scripts/fix_limit_and_token_measures.py
    python docs/scripts/fix_limit_and_token_measures.py --check   # exit 1 if a template is stale

A Desktop re-export drops descriptions: run fix_pbit_defaults.py --reference
first, then this. Desktop refresh and rendering still need checking after a
change here.
"""

import argparse
import copy
import os
import sys
import uuid
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fix_pbit_defaults import layout_for  # noqa: E402
from fix_refresh_time_cuts import OWNED, SCHEMA, UNAPPLIED, joined, lines, one, validate  # noqa: E402
from fix_viva_query_org import Package, PatchError, require  # noqa: E402,F401 - PatchError is re-exported

REPO = Path(__file__).resolve().parents[2]

TEMPLATES = (
    REPO / "1. Local CSV" / "Consumption Central - Local CSV.pbit",
    REPO / "2. Fabric" / "Consumption Central - Fabric.pbit",
    REPO / "3. Viva Direct" / "Consumption Central - Viva Direct.pbit",
)

# ---------------------------------------------------------------------------
# The measures: (table, measure) -> {field: (shipped text, Analytics Hub's text)}
# ---------------------------------------------------------------------------

PER_PERSON = ("VAR T = SUMMARIZE('CoworkBilling', 'CoworkBilling'[UserPrincipalName], "
              "\"u\", [Cowork Total Credits Used], \"l\", [Person Allowance])")
NO_POLICY = "'SpendingPolicy'[SpendingPolicyId] <> \"00000000-0000-0000-0000-000000000000\""
FOUNDRY_FILTERS = "\n".join((
    "    KEEPFILTERS( 'AzureAiSpend'[ServiceName] = \"Foundry Models\" ),",
    "    KEEPFILTERS(",
    "        FILTER( ALL( 'AzureAiSpend'[UsageDate] ),",
    "                'AzureAiSpend'[UsageDate] >= FromDate )",
    "    )",
    ")",
))

MEASURES = {
    ("CoworkBilling", "Users Over Limit"): {
        "expression": (
            PER_PERSON + "\nRETURN COUNTROWS(FILTER(T, [u] > [l]))",
            PER_PERSON + "\nRETURN COUNTROWS(FILTER(T, [l] > 0 && [u] > [l])) + 0",
        ),
    },
    ("CoworkBilling", "Policy Allowance"): {
        "expression": (
            "\n".join(("", "CALCULATE(", "    SUM('SpendingPolicy'[PlanLimit]),", f"    {NO_POLICY}", ")", "")),
            "\n".join(("VAR Limit =", "    CALCULATE(", "        SUM('SpendingPolicy'[PlanLimit]),",
                       f"        {NO_POLICY}", "    )", "RETURN IF(Limit > 0, Limit)")),
        ),
    },
    ("AzureAiSpend", "Foundry Tokens (M)"): {
        "expression": (
            "\n".join((
                "VAR FromDate = [Foundry Period Start]",
                "RETURN",
                "CALCULATE(",
                "    SUM( 'AzureAiSpend'[UsageQuantity] ),",
                FOUNDRY_FILTERS,
            )),
            "\n".join((
                "// UsageQuantity is in each meter's own unit: thousands of tokens for older",
                "// meters, millions for newer ones, which say \"1M Tokens\" in their name.",
                "VAR FromDate = [Foundry Period Start]",
                "RETURN",
                "CALCULATE(",
                "    SUMX(",
                "        'AzureAiSpend',",
                "        'AzureAiSpend'[UsageQuantity]",
                "            * SWITCH( TRUE(),",
                "                CONTAINSSTRING( 'AzureAiSpend'[Meter], \"1M Token\" ), 1,",
                "                CONTAINSSTRING( 'AzureAiSpend'[Meter], \"Token\" ), 0.001,",
                "                0 )",
                "    ),",
                FOUNDRY_FILTERS,
            )),
        ),
        "description": (
            "\n".join((
                "Millions of tokens billed. Foundry rows only - Copilot Studio rows in",
                "this table carry credits in the same column, and adding the two would",
                "produce a number with no meaning.",
            )),
            "\n".join((
                "Millions of tokens billed. Azure bills older token meters per 1K tokens",
                "and newer ones per 1M (their names say \"1M Tokens\"), so each row is",
                "converted; meters that aren't tokens (pages, images, hours) are left out.",
                "Foundry rows only - Copilot Studio rows in this table carry credits in",
                "the same column, and adding the two would produce a number with no meaning.",
            )),
        ),
    },
}


def measure(model, table_name, measure_name):
    table = one(model["tables"], table_name, f"{SCHEMA} tables")
    return one(table.get("measures", []), measure_name, table_name)


def edit_measures(document):
    """Move each measure from its shipped text to Analytics Hub's; return the labels it changed."""
    changed = []
    for (table_name, measure_name), fields in MEASURES.items():
        record = measure(document["model"], table_name, measure_name)
        moved = []
        for field, (old, new) in fields.items():
            current = joined(record.get(field))
            if current == new:
                continue
            require(current == old, f"{table_name}[{measure_name}] {field} has changed; review it before patching")
            record[field] = lines(new)
            moved.append(field)
        if moved:
            changed.append(f"{table_name}[{measure_name}] {' and '.join(moved)}")
    return changed


def owned_mask(document):
    """The model with the fields this script owns blanked out: everything else must not move."""
    result = copy.deepcopy(document)
    for (table_name, measure_name), fields in MEASURES.items():
        record = measure(result["model"], table_name, measure_name)
        for field in fields:
            record[field] = OWNED
    return result


# ---------------------------------------------------------------------------
# Archive
# ---------------------------------------------------------------------------


def build(raw):
    """Return (bytes, changes) for one template. One with nothing to change comes back as raw."""
    package = Package(raw)
    # layout_for re-encodes each part byte for byte before handing it over, so an edit
    # cannot quietly change the BOM, the indentation or the line endings.
    model, encode_model = layout_for(package.contents[SCHEMA], SCHEMA)
    pending = layout_for(package.contents[UNAPPLIED], UNAPPLIED)[0]
    before = copy.deepcopy(model)
    edits = edit_measures(model)
    if not edits:
        return raw, []
    require(owned_mask(before) == owned_mask(model), f"{SCHEMA}: a field outside the three measures changed")
    updates = {SCHEMA: encode_model(model)}
    candidate = package.rebuild(updates)
    validate(package, candidate, updates, model, pending)
    return candidate, [f"{SCHEMA} {edit}" for edit in edits]


def publish(path, raw, candidate):
    """Write through a scratch file, and only over the bytes the patch was built from."""
    scratch = path.with_name(f".fix-limit-and-token-measures-{uuid.uuid4().hex}.pbit")
    owned = False
    try:
        with scratch.open("xb") as stream:
            owned = True
            stream.write(candidate)
            stream.flush()
            os.fsync(stream.fileno())
        require(scratch.read_bytes() == candidate, "scratch write verification failed")
        require(path.read_bytes() == raw, f"{path.name} changed during the patch; refusing to publish")
        os.replace(scratch, path)
        owned = False
    finally:
        if owned:
            scratch.unlink()


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="validate and report without writing")
    mode.add_argument("--check", action="store_true", help="exit 1 if any template still needs a change")
    args = parser.parse_args(argv)

    stale = failed = 0
    for path in TEMPLATES:
        print(path.parent.name)
        try:
            require(path.is_file(), f"missing template: {path}")
            raw = path.read_bytes()
            candidate, changes = build(raw)
            if not changes:
                print("  already ported; left byte for byte unchanged")
                continue
            stale += 1
            for change in changes:
                print(f"  {change}")
            if not (args.dry_run or args.check):
                publish(path, raw, candidate)
                print("  validated patch written")
        except (ValueError, KeyError, TypeError, zipfile.BadZipFile) as error:
            print(f"  FAILED: {error}", file=sys.stderr)
            failed += 1
    would = "would be " if args.dry_run or args.check else ""
    print(f"\n{stale} template(s) {would}patched" + (f", {failed} failed" if failed else ""))
    return 1 if failed or (args.check and stale) else 0


if __name__ == "__main__":
    sys.exit(main())
