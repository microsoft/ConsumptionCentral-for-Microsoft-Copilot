"""Verify the shipped templates carry the refresh-time cuts.

docs/scripts/fix_refresh_time_cuts.py is the source of truth. This replays it
against each shipped .pbit and fails if it would still change something, so
the spec and the templates cannot drift apart.

    python docs/scripts/check_refresh_time_cuts.py

Checks, for every current template:

1. CoworkBilling's query loads UsageCohortRank, so no calculated column ranks
   every user against every other user.
2. UsageCohort reads its bucket from UsageCohortRank, and Weeks Ago has no
   CALCULATE.
3. Group By's Usage Intensity rows (Studio and GitHub) find each percentile
   cut once with TOPN.
4. Fabric and Power Automate + Dataverse buffer the seven tables Normalize
   reads column by column. Local CSV and Viva Direct read none of them
   through GetTable.
5. The UnappliedChanges copy of each query the cuts touch, and Desktop's
   last-loaded copy of it, match the model, so the template opens with
   nothing pending.
6. The report layer is still signed (SecurityBindings present).
"""
import io
import json
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fix_refresh_time_cuts as spec  # noqa: E402


def out_of_step(raw, buffered):
    """Queries the cuts touch whose pending or last-loaded copy differs from the model."""
    package = spec.Package(raw)
    model = spec.layout_for(package.contents[spec.SCHEMA], spec.SCHEMA)[0]["model"]
    pending = spec.layout_for(package.contents[spec.UNAPPLIED], spec.UNAPPLIED)[0]
    problems = []
    for name in spec.query_edits(buffered):
        text = spec.joined(spec.partition_source(model, name)["expression"])
        query = spec.one(pending["queries"], name, f"{spec.UNAPPLIED} queries")
        if spec.joined(query["text"]) != text:
            problems.append(f"{name}: the {spec.UNAPPLIED} copy differs from the model")
        cache = query.get("lastLoadedAsTableFormulaText")
        if cache and json.loads(cache).get("RootFormulaText") != text:
            problems.append(f"{name}: Desktop's last-loaded copy differs from the model")
    return problems


def main():
    problems = []
    for template, buffered in spec.TEMPLATES:
        print(f"\n{template.name}")
        if not template.is_file():
            problems.append(f"{template.name}: missing")
            continue
        raw = template.read_bytes()
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as z:
                if "SecurityBindings" not in z.namelist():
                    problems.append(f"{template.name}: SecurityBindings was dropped")
            _, changes = spec.build(raw, buffered)
            stale = out_of_step(raw, buffered)
        except (KeyError, TypeError, ValueError, zipfile.BadZipFile) as error:
            problems.append(f"{template.name}: {error}")
            continue
        problems += [f"{template.name}: not applied - {change}" for change in changes]
        problems += [f"{template.name}: {problem}" for problem in stale]
        tables = f"{len(spec.BUFFERED_TABLES)} tables buffered" if buffered else "nothing to buffer"
        outstanding = len(changes) + len(stale)
        print(f"  cohort query, {len(spec.CONSUMPTION_COLUMNS) + 1} columns and {spec.GROUP_BY}; "
              f"{tables}: {'ok' if not outstanding else f'{outstanding} outstanding'}")
    print()
    if problems:
        for problem in problems:
            print(f"FAIL {problem}")
        return 1
    print("Refresh-time cuts are in every template")
    return 0


if __name__ == "__main__":
    sys.exit(main())
