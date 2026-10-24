"""Verify the current templates carry Analytics Hub's limit and Foundry token measures.

docs/scripts/fix_limit_and_token_measures.py is the source of truth. This
replays it against each current .pbit and fails if it would still change
something, so the spec and the templates cannot drift apart.

    python docs/scripts/check_limit_and_token_measures.py

Checks, for Local CSV, Fabric and Viva Direct:

1. Users Over Limit counts only people who have a limit, and Policy Allowance
   is BLANK when the spending policies set no limit.
2. Foundry Tokens (M) converts each billing row by its meter's unit, and its
   description says so.
3. The report layer is still signed (SecurityBindings present).
"""
import io
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fix_limit_and_token_measures as spec  # noqa: E402


def main():
    problems = []
    for template in spec.TEMPLATES:
        print(f"\n{template.name}")
        if not template.is_file():
            problems.append(f"{template.name}: missing")
            continue
        raw = template.read_bytes()
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as z:
                if "SecurityBindings" not in z.namelist():
                    problems.append(f"{template.name}: SecurityBindings was dropped")
            _, changes = spec.build(raw)
        except (KeyError, TypeError, ValueError, zipfile.BadZipFile) as error:
            problems.append(f"{template.name}: {error}")
            continue
        problems += [f"{template.name}: not applied - {change}" for change in changes]
        print(f"  {len(spec.MEASURES)} measures: {'ok' if not changes else f'{len(changes)} outstanding'}")
    print()
    if problems:
        for problem in problems:
            print(f"FAIL {problem}")
        return 1
    print("Analytics Hub's limit and Foundry token measures are in every current template")
    return 0


if __name__ == "__main__":
    sys.exit(main())
