#!/usr/bin/env python3
"""Build a self-contained static report demo from the repository's three PBIR templates."""

import collections
import json
import re
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SOURCE = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "demo" / "consumption-central-report"
TEMPLATES = (
    ROOT / "1. Local CSV" / "Consumption Central - Local CSV.pbit",
    ROOT / "2. Fabric" / "Consumption Central - Fabric.pbit",
    ROOT / "3. Viva Direct" / "Consumption Central - Viva Direct.pbit",
)
MEASURES = ROOT / "docs" / "MEASURES.md"


def json_from_zip(archive: zipfile.ZipFile, name: str) -> dict:
    return json.loads(archive.read(name).decode("utf-8-sig"))


def clean_label(value: str) -> str:
    return " ".join(value.replace("\ufffd", "—").replace("\n", " ").split())[:100]


def query_labels(value, found: list[str]) -> None:
    if isinstance(value, dict):
        for key in ("displayName", "nativeQueryRef"):
            label = value.get(key)
            if isinstance(label, str):
                cleaned = clean_label(label)
                if cleaned and cleaned not in found:
                    found.append(cleaned)
        for child in value.values():
            query_labels(child, found)
    elif isinstance(value, list):
        for child in value:
            query_labels(child, found)


def template_pages(path: Path) -> tuple[list[str], dict[str, dict]]:
    pages = {}
    with zipfile.ZipFile(path) as archive:
        order = json_from_zip(archive, "Report/definition/pages/pages.json")["pageOrder"]
        for page_id in order:
            page = json_from_zip(archive, f"Report/definition/pages/{page_id}/page.json")
            visual_prefix = f"Report/definition/pages/{page_id}/visuals/"
            visuals = []
            for name in archive.namelist():
                if not name.startswith(visual_prefix) or not name.endswith("/visual.json"):
                    continue
                source_visual = json_from_zip(archive, name)
                visual = source_visual.get("visual", {})
                position = source_visual.get("position", {})
                labels: list[str] = []
                query_labels(visual.get("query", {}).get("queryState", {}), labels)
                visuals.append(
                    {
                        "type": visual.get("visualType", "unknown"),
                        "position": {
                            "x": round(float(position.get("x", 0)), 2),
                            "y": round(float(position.get("y", 0)), 2),
                            "width": round(float(position.get("width", 0)), 2),
                            "height": round(float(position.get("height", 0)), 2),
                            "z": int(position.get("z", 1)),
                        },
                        "label": labels[0] if labels else "",
                        "fields": labels[:5],
                    }
                )
            visuals.sort(key=lambda item: (item["position"]["z"], item["position"]["y"], item["position"]["x"]))
            pages[page_id] = {
                "title": clean_label(page.get("displayName", page_id)),
                "canvas": {
                    "width": int(page.get("width", 1280)),
                    "height": max(
                        int(page.get("height", 720)),
                        max((int(v["position"]["y"] + v["position"]["height"]) for v in visuals), default=720),
                    ),
                },
                "visuals": visuals,
            }
    return order, pages


def type_signature(page: dict) -> collections.Counter:
    return collections.Counter(visual["type"] for visual in page["visuals"])


def measure_definitions() -> dict[str, str]:
    definitions = {}
    current_name = None
    description = []
    for line in MEASURES.read_text(encoding="utf-8").splitlines() + [""]:
        match = re.match(r"^\*\*`([^`]+)`\*\*", line)
        if match:
            if current_name and description:
                text = " ".join(part.strip() for part in description if part.strip())
                definitions[current_name] = text
            current_name = clean_label(match.group(1))
            description = []
        elif current_name and line.strip() and not line.startswith("#"):
            description.append(line.strip())
        elif current_name and not line.strip():
            text = " ".join(part.strip() for part in description if part.strip())
            if text:
                definitions[current_name] = text
            current_name = None
            description = []
    return definitions


def build() -> None:
    variants = [template_pages(path) for path in TEMPLATES]
    reference_order, reference_pages = variants[0]
    if not reference_order:
        raise ValueError("The report templates contain no pages.")
    for path, (order, pages) in zip(TEMPLATES[1:], variants[1:]):
        if order != reference_order:
            raise ValueError(f"{path} does not share the canonical page order.")
        for page_id in reference_order:
            reference = reference_pages[page_id]
            candidate = pages[page_id]
            if reference["title"] != candidate["title"] or type_signature(reference) != type_signature(candidate):
                raise ValueError(f"{path} has a different page or visual structure for {page_id}.")

    schema = {
        "title": "Consumption Central report demo",
        "pageCount": len(reference_order),
        "sourcePages": "Local CSV, Fabric, and Viva Direct templates share this page order and visual types.",
        "layoutSource": "Local CSV template; the report README recommends it as the starting path.",
        "pages": [
            {"id": page_id, **reference_pages[page_id], "index": index}
            for index, page_id in enumerate(reference_order)
        ],
    }
    definitions = measure_definitions()
    if not definitions:
        raise ValueError("No measure definitions were found.")

    OUTPUT.mkdir(parents=True, exist_ok=True)
    for name in ("index.html", "styles.css", "app.js"):
        shutil.copy2(SOURCE / name, OUTPUT / name)
    shutil.copy2(ROOT / "LICENSE", OUTPUT / "LICENSE")
    (OUTPUT / "THIRD-PARTY-NOTICES.txt").write_text(
        "This static report bundle has no third-party runtime dependencies. "
        "The report port and its source templates are covered by the repository MIT License.\n",
        encoding="utf-8",
    )
    (OUTPUT / "report-schema.json").write_text(json.dumps(schema, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    (OUTPUT / "measure-definitions.json").write_text(json.dumps(definitions, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


if __name__ == "__main__":
    build()
