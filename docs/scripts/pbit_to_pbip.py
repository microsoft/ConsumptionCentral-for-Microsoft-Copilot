#!/usr/bin/env python3
"""Expand a .pbit into a Power BI Project (PBIP) folder.

Desktop rejects a .pbit whose report parts were hand-edited, because
SecurityBindings signs them. A PBIP has no such signature, so the supported
route for a report-layer change is: expand the template here, edit the plain
files, then re-export the .pbit from Power BI Desktop.

The report definition and static resources are copied out byte for byte; only
the small project descriptor files are generated.
"""

import argparse
import json
import pathlib
import sys
import zipfile

REPORT_PREFIX = "Report/"
MODEL_PART = "DataModelSchema"
UNAPPLIED_PART = "UnappliedChanges"

# Parts a .pbit carries that a project does not: Desktop regenerates them on
# export, so dropping them here loses nothing.
GENERATED_PARTS = frozenset({
    "Version", "[Content_Types].xml", "Settings", "Metadata", "SecurityBindings",
})

PBIP = {
    "$schema": "https://developer.microsoft.com/json-schemas/fabric/pbip/"
               "pbipProperties/1.0.0/schema.json",
    "version": "1.0",
    "artifacts": [],
    "settings": {"enableAutoRecovery": True},
}
PBIR = {
    "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/"
               "definitionProperties/2.0.0/schema.json",
    "version": "4.0",
    "datasetReference": {"byPath": {"path": ""}},
}
PBISM = {
    "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/"
               "semanticModel/definitionProperties/1.0.0/schema.json",
    "version": "1.0",
    "settings": {},
}
GITIGNORE = "**/.pbi/localSettings.json\n**/.pbi/cache.abf\n"

MAX_PATH = 260


class Failure(Exception):
    pass


def require(condition, message):
    if not condition:
        raise Failure(message)


def decode(raw):
    """A .pbit stores DataModelSchema as UTF-16LE and most JSON as UTF-8."""
    if raw[:2] == b"\xff\xfe":
        return raw[2:].decode("utf-16-le")
    if raw[:3] == b"\xef\xbb\xbf":
        return raw.decode("utf-8-sig")
    if len(raw) > 1 and raw[1] == 0:
        return raw.decode("utf-16-le")
    return raw.decode("utf-8")


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def convert(pbit_path, out_root, project_name=None):
    pbit = pathlib.Path(pbit_path)
    require(pbit.is_file(), f"{pbit}: not a file")
    name = project_name or pbit.stem
    require(name not in (".", "..") and not any(c in name for c in '\\/:*?"<>|'),
            "project name must be a single valid folder name")
    project = pathlib.Path(out_root) / name
    require(not project.exists(), f"{project}: already exists, refusing to overwrite")

    report_dir = project / f"{name}.Report"
    model_dir = project / f"{name}.SemanticModel"

    with zipfile.ZipFile(pbit) as archive:
        names = archive.namelist()
        require(MODEL_PART in names, f"{pbit}: no {MODEL_PART} part")
        require(f"{REPORT_PREFIX}definition/report.json" in names,
                f"{pbit}: not in PBIR format, cannot expand to a project")

        copied = 0
        for entry in names:
            if entry.endswith("/"):
                continue
            if entry.startswith(REPORT_PREFIX):
                target = report_dir / entry[len(REPORT_PREFIX):]
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(entry))
                copied += 1
            elif entry in (MODEL_PART, UNAPPLIED_PART):
                continue
            else:
                require(entry in GENERATED_PARTS, f"{pbit}: unexpected part {entry}")

        model = decode(archive.read(MODEL_PART))
        json.loads(model)  # refuse to write a model the exporter cannot parse
        write(model_dir / "model.bim", model)

        if UNAPPLIED_PART in names:
            # Pending Power Query edits the template carried; dropping them
            # would silently change the queries Desktop applies.
            unapplied = decode(archive.read(UNAPPLIED_PART))
            json.loads(unapplied)
            write(model_dir / ".pbi" / "unappliedChanges.json", unapplied)

    pbir = json.loads(json.dumps(PBIR))
    pbir["datasetReference"]["byPath"]["path"] = f"../{name}.SemanticModel"
    write(report_dir / "definition.pbir", json.dumps(pbir, indent=2) + "\n")
    write(model_dir / "definition.pbism", json.dumps(PBISM, indent=2) + "\n")

    pbip = json.loads(json.dumps(PBIP))
    pbip["artifacts"] = [{"report": {"path": f"{name}.Report"}}]
    write(project / f"{name}.pbip", json.dumps(pbip, indent=2) + "\n")
    write(project / ".gitignore", GITIGNORE)

    # Power BI Desktop is not long-path aware: it reports a PBIR file as "not
    # found" once its full path passes MAX_PATH, so fail here instead.
    longest = max((len(str(p)) for p in project.rglob("*") if p.is_file()), default=0)
    require(longest < MAX_PATH,
            f"{project}: longest file path is {longest} characters; Desktop cannot "
            f"open a project past {MAX_PATH - 1}. Use a shorter --out folder.")

    print(f"{name}: {copied} report files, model.bim written -> {project}")
    return project


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pbit", nargs="+")
    parser.add_argument("--out", required=True, help="folder to create projects in")
    parser.add_argument("--project-name", help="short project name (one input only)")
    args = parser.parse_args(argv)
    try:
        require(not args.project_name or len(args.pbit) == 1,
                "--project-name requires exactly one input")
        for path in args.pbit:
            convert(path, args.out, args.project_name)
    except Failure as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
