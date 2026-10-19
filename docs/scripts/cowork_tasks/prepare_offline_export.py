#!/usr/bin/env python3
"""Create a NEW offline export project; restore real sources before shipping its PBIT."""
import argparse
import json
from pathlib import Path
import sys

import model
from apply import apply

sys.path.insert(0, str(model.HERE.parent))
from pbit_to_pbip import convert

MARKER = "CC_OFFLINE_EXPORT_ONLY"
OVERRIDES = {
    "fabric": {
        "FabricSource": '#table(type table [Schema=text, Item=text, Kind=text, Data=table], {})',
    },
    "viva": {
        "VivaConnectorSource": "#table(type table [], {})",
        "VivaOrgSource": "null",
    },
}


def prepare(source, output, profile, project_name):
    if profile not in OVERRIDES:
        raise ValueError(f"Unsupported offline export profile: {profile}")
    root = convert(source, output, project_name)
    project = root / f"{project_name}.pbip"
    apply(project, profile)
    model_dir = root / f"{project_name}.SemanticModel"
    model_path = model_dir / "model.bim"
    query_path = model_dir / ".pbi" / "unappliedChanges.json"
    document = json.loads(model_path.read_text(encoding="utf-8"))
    unapplied = json.loads(query_path.read_text(encoding="utf-8"))
    expressions = {e["name"]: e for e in document["model"]["expressions"]}
    queries = {q["name"]: q for q in unapplied["queries"]}
    for name, body in OVERRIDES[profile].items():
        if name not in expressions or name not in queries:
            raise ValueError(f"Missing source root in offline export project: {name}")
        text = f"// {MARKER}: restore from the neutral reference before shipping.\n{body}"
        expressions[name]["expression"] = text
        queries[name]["text"] = text.split("\n")
    for path, value in ((model_path, document), (query_path, unapplied)):
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("OFFLINE EXPORT ONLY: no connector validation. Repair BOTH model parts from the real-source reference.")
    return project


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--profile", required=True, choices=tuple(OVERRIDES))
    parser.add_argument("--project-name", required=True)
    args = parser.parse_args()
    prepare(args.source, args.out, args.profile, args.project_name)
