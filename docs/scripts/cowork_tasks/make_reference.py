#!/usr/bin/env python3
"""Create a data-free, model-only defaults reference; not a report deliverable."""
import argparse
import json
from pathlib import Path
import sys
import zipfile

import model

sys.path.insert(0, str(model.HERE.parent))
from pbit_to_pbip import decode


def make_reference(source, output, profile):
    if output.exists():
        raise FileExistsError("Refusing to overwrite a defaults reference.")
    with zipfile.ZipFile(source) as archive:
        if any(name.startswith("DataModel/") or name == "DataModel" for name in archive.namelist()):
            raise ValueError("Reference source must be a data-free PBIT, not a PBIX.")
        document = json.loads(decode(archive.read("DataModelSchema")))
        unapplied = json.loads(decode(archive.read("UnappliedChanges")))
        model.apply(document["model"], unapplied, profile)
        replacements = {
            "DataModelSchema": json.dumps(document, ensure_ascii=False, allow_nan=False,
                                         indent=2).encode("utf-16-le"),
            "UnappliedChanges": json.dumps(unapplied, ensure_ascii=False, allow_nan=False,
                                          separators=(",", ":")).encode("utf-16-le"),
        }
        output.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(output, "w") as target:
            for info in archive.infolist():
                target.writestr(info, replacements.get(info.filename, archive.read(info.filename)))
    print("Created defaults reference only; its report is unchanged and is not the task-page deliverable.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--profile", required=True, choices=("csv", "fabric", "viva"))
    args = parser.parse_args()
    make_reference(args.source, args.output, args.profile)
