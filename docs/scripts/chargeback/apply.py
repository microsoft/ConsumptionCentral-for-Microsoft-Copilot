#!/usr/bin/env python3
"""Add the "2.2. Cowork: Chargeback" page to a closed, worktree-local PBIP project.

The report layer of a .pbit is signed, so the page goes in through a PBIP
project and Desktop exports the template. The model must already have the
chargeback columns and measures: run fix_chargeback.py on the .pbit first.

    python docs/scripts/fix_chargeback.py
    python docs/scripts/pbit_to_pbip.py "1. Local CSV/Consumption Central - Local CSV.pbit" --out .pbi-work --project-name csv
    python docs/scripts/chargeback/apply.py .pbi-work/csv/csv.pbip

Then open the project in Desktop, refresh, export the .pbit over the repo copy
and run fix_chargeback.py again to restore the descriptions the export drops.
See docs/BUILD.md. Running it twice changes nothing.
"""
import argparse
import json
from pathlib import Path

import page


def apply(project):
    project = project.resolve()
    definition = json.loads(project.read_text(encoding="utf-8-sig"))
    report = project.parent / definition["artifacts"][0]["report"]["path"]
    count = page.apply(report)
    print(f"{project.name}: wrote {page.DISPLAY_NAME} ({count} visuals); Desktop refresh and export are still required.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("project", type=Path, help="the .pbip file")
    apply(parser.parse_args().project)
