#!/usr/bin/env python3
"""Apply reviewable task definitions to a closed, worktree-local PBIP project."""
import argparse
import json
from pathlib import Path

import model
import report


def apply(project, profile):
    project = project.resolve()
    definition = json.loads(project.read_text(encoding="utf-8-sig"))
    report_dir = project.parent / definition["artifacts"][0]["report"]["path"]
    binding = json.loads((report_dir / "definition.pbir").read_text(encoding="utf-8-sig"))
    model_dir = (report_dir / binding["datasetReference"]["byPath"]["path"]).resolve()
    model_path = model_dir / "model.bim"
    unapplied_path = model_dir / ".pbi" / "unappliedChanges.json"
    document = json.loads(model_path.read_text(encoding="utf-8-sig"))
    unapplied = json.loads(unapplied_path.read_text(encoding="utf-8-sig"))
    model.apply(document["model"], unapplied, profile)
    model_path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    unapplied_path.write_text(json.dumps(unapplied, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    report.apply(report_dir)
    print(f"Applied optional task model and page ({profile}); Desktop refresh/export is still required.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", type=Path)
    parser.add_argument("--profile", required=True, choices=("csv", "fabric", "viva"))
    args = parser.parse_args()
    apply(args.project, args.profile)
