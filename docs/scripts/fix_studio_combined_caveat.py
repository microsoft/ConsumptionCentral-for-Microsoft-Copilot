"""Remove unsupported Studio attribution/completeness claims from active templates.

Only Settings[Combined Caveat]'s expression and description change. The old
positive-gap and non-positive-gap branches are both misleading: tenant and user
totals can differ in coverage, dates and billing definitions. A zero or blank
tenant total does not establish that no Studio user data was loaded either.

The two known shipped expressions are accepted, as is the corrected expression.
Unexpected edits fail closed. Every other model field and raw ZIP member,
including the signed report layer and UnappliedChanges, is preserved.

    python docs/scripts/fix_studio_combined_caveat.py --dry-run
    python docs/scripts/fix_studio_combined_caveat.py
    python docs/scripts/fix_studio_combined_caveat.py --check
"""

import argparse
import copy
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fix_limit_and_token_measures import TEMPLATES, measure, publish  # noqa: E402
from fix_pbit_defaults import layout_for  # noqa: E402
from fix_refresh_time_cuts import OWNED, SCHEMA, UNAPPLIED, joined, validate  # noqa: E402
from fix_viva_query_org import Package, require  # noqa: E402

OLD_DESCRIPTION = (
    "Why the combined figures understate Copilot Studio. Adapts to whether any\n"
    "unattributed Studio credits are actually present in this tenant's export."
)
OLD_PREFIX = """
VAR Tenant = [Studio Consumed Credits (Tenant)]
VAR Attributed = [Studio Total Credits Used]
VAR Gap = Tenant - Attributed
RETURN
"""
OLD_IF = OLD_PREFIX + """    IF(
        Gap > 0,
        "Studio counts only credits attributed to a named user. Its agent and "
            & "environment exports carry no person, so about "
            & FORMAT( Gap, "#,0" ) & " credits ("
            & FORMAT( DIVIDE( Gap, Tenant ), "0%" )
            & " of Studio usage) sit outside the per-person and per-department "
            & "views on this page.",
        "Studio counts only credits attributed to a named user. All Studio "
            & "credits in this export carry a person, so nothing is missing here."
    )
"""
OLD_SWITCH = OLD_PREFIX + """    SWITCH(
        TRUE(),
        ISBLANK( Tenant ) || Tenant = 0,
            "No Copilot Studio data loaded, so these figures cover the other "
                & "products only.",
        Gap > 0,
            "Studio counts only credits attributed to a named user. Its agent and "
                & "environment exports carry no person, so about "
                & FORMAT( Gap, "#,0" ) & " credits ("
                & FORMAT( DIVIDE( Gap, Tenant ), "0%" )
                & " of Studio usage) sit outside the per-person and per-department "
                & "views on this page.",
        "Studio counts only credits attributed to a named user. All Studio "
            & "credits in this export carry a person, so nothing is missing here."
    )
"""
CAVEAT = (
    "Studio tenant and user totals may differ in coverage, dates and billing definitions. "
    "Their difference does not identify unattributed usage or establish completeness. "
    "Person and department views depend on the user data supplied."
)
EXPRESSION = f'"{CAVEAT}"'
DESCRIPTION = (
    "Studio tenant/user totals are not a reconciliation of attributable usage. "
    "A positive, zero, negative or blank gap does not establish missing usage or completeness."
)


def build(raw):
    package = Package(raw)
    document, encode = layout_for(package.contents[SCHEMA], SCHEMA)
    before = copy.deepcopy(document)
    target = measure(document["model"], "Settings", "Combined Caveat")
    current = joined(target.get("expression"))
    description = joined(target.get("description"))
    require(current in (OLD_IF, OLD_SWITCH, EXPRESSION), "Combined Caveat expression has changed; review before patching")
    require(description in (OLD_DESCRIPTION, DESCRIPTION), "Combined Caveat description has changed; review before patching")
    if current == EXPRESSION and description == DESCRIPTION:
        return raw, []
    target["expression"] = EXPRESSION
    target["description"] = DESCRIPTION
    masked = copy.deepcopy(document)
    for model in (before, masked):
        record = measure(model["model"], "Settings", "Combined Caveat")
        for field in ("expression", "description"):
            record[field] = OWNED
    require(before == masked, "A field outside Combined Caveat changed")
    updates = {SCHEMA: encode(document)}
    candidate = package.rebuild(updates)
    pending = layout_for(package.contents[UNAPPLIED], UNAPPLIED)[0]
    validate(package, candidate, updates, document, pending)
    return candidate, ["Settings[Combined Caveat] expression and description"]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    stale = failed = 0
    for path in TEMPLATES:
        try:
            raw = path.read_bytes()
            candidate, changes = build(raw)
            print(f"{path.parent.name}: {'needs repair' if changes else 'ok'}")
            if changes:
                stale += 1
                if not (args.check or args.dry_run):
                    publish(path, raw, candidate)
        except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile) as error:
            print(f"{path.parent.name}: FAILED: {error}", file=sys.stderr)
            failed += 1
    return 1 if failed or (args.check and stale) else 0


if __name__ == "__main__":
    sys.exit(main())
