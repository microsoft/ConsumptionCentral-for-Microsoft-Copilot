"""Verify the shipped templates carry the Cowork KPI card fixes.

docs/scripts/fix_cowork_kpi_cards.py is the source of truth. This replays its
patch functions against each shipped .pbit and fails if any of them would
still change something, so the spec and the templates cannot drift apart.

    python docs/scripts/check_cowork_kpi_cards.py

Checks, for every current template:

1. The model has the new measures (Avg Weekly Active Users and the reconciling
   seat measures), the corrected descriptions and the Cowork Period table that
   always offers "Current period (4 weeks)".
2. The Consumption KPI card shows Avg weekly active, not Weekly Active Users.
3. The Optimisation KPI card is the four reconciling tiles, each with its seat
   count, and nothing else.
4. Every Cowork Period slicer is single-select with the current period saved.
5. The report layer is still signed (SecurityBindings present).
"""
import json
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fix_cowork_kpi_cards as spec  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
TEMPLATES = (
    ROOT / "1. Local CSV" / "Consumption Central - Local CSV.pbit",
    ROOT / "2. Fabric" / "Consumption Central - Fabric.pbit",
    ROOT / "3. Viva Direct" / "Consumption Central - Viva Direct.pbit",
    ROOT / "archive" / "4. Power Automate + Dataverse"
    / "Consumption Central - Power Automate + Dataverse.pbit",
)


def schema(z):
    raw = z.read("DataModelSchema")
    return json.loads(raw.decode("utf-16-le").lstrip("\ufeff"))


def visual(z, page, name):
    return json.loads(z.read(f"Report/definition/pages/{page}/visuals/{name}/visual.json"))


def outstanding(z):
    """Every change the fix script would still make to this template."""
    changes = spec.patch_model(schema(z))
    changes += spec.patch_exec_card(visual(z, spec.EXEC_PAGE, spec.EXEC_CARD))
    changes += spec.patch_opt_card(visual(z, spec.OPT_PAGE, spec.OPT_CARD))
    for slicer in spec.PERIOD_SLICERS:
        changes += spec.patch_period_slicer(visual(z, *slicer), "/".join(slicer))
    return changes


def main():
    problems = []
    for template in TEMPLATES:
        print(f"\n{template.name}")
        if not template.is_file():
            problems.append(f"{template.name}: missing")
            continue
        with zipfile.ZipFile(template) as z:
            if "SecurityBindings" not in z.namelist():
                problems.append(f"{template.name}: SecurityBindings was dropped")
            try:
                changes = outstanding(z)
            except (KeyError, spec.PatchError) as error:
                problems.append(f"{template.name}: {error}")
                continue
        for change in changes:
            problems.append(f"{template.name}: not applied - {change}")
        print(f"  {len(spec.NEW_MEASURES)} measures, "
              f"{len(spec.PERIOD_SLICERS)} Period slicers, "
              f"{len(spec.OPT_TILES)} optimisation tiles: "
              f"{'ok' if not changes else f'{len(changes)} outstanding'}")
    print()
    if problems:
        for problem in problems:
            print(f"FAIL {problem}")
        return 1
    print("Cowork KPI card fixes are in every template")
    return 0


if __name__ == "__main__":
    sys.exit(main())
