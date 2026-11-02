"""Verify the current templates carry the chargeback model.

docs/scripts/fix_chargeback.py is the source of truth. This replays it against
each current .pbit and fails if it would still change something, so the spec
and the templates cannot drift apart.

    python docs/scripts/check_chargeback.py

Checks, for Local CSV, Fabric and Viva Direct:

1. SpendingPolicy loads the optional CostCentre, Department, BillingOwner and
   ChargeCode columns, in the model and in UnappliedChanges.
2. CoworkBilling carries the eight Chargeback measures, and Chargeback $,
   Chargeback and Chargeback % say what they measure. A description a Desktop
   re-export dropped shows up here as outstanding.
3. The report layer is still signed (SecurityBindings present).
"""
import io
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fix_chargeback as spec  # noqa: E402


def main():
    problems = []
    for variant, template in spec.TEMPLATES.items():
        print(f"\n{template.name}")
        if not template.is_file():
            problems.append(f"{template.name}: missing")
            continue
        raw = template.read_bytes()
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as z:
                if "SecurityBindings" not in z.namelist():
                    problems.append(f"{template.name}: SecurityBindings was dropped")
            _, changes = spec.build(raw, variant)
        except (KeyError, TypeError, ValueError, zipfile.BadZipFile) as error:
            problems.append(f"{template.name}: {error}")
            continue
        problems += [f"{template.name}: not applied - {change}" for change in changes]
        print(f"  {len(spec.COLUMNS)} columns, {len(spec.MEASURES)} measures, "
              f"{len(spec.QUERIES[variant])} queries: {'ok' if not changes else f'{len(changes)} outstanding'}")
    print()
    if problems:
        for problem in problems:
            print(f"FAIL {problem}")
        return 1
    print("The chargeback model is in every current template")
    return 0


if __name__ == "__main__":
    sys.exit(main())
