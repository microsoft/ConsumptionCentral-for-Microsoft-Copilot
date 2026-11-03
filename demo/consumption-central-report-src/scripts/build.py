#!/usr/bin/env python3
"""Build a self-contained static report demo from the repository's three PBIR templates."""

import collections
import base64
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


def literal(value):
    if not isinstance(value, dict):
        return value
    raw = value.get("expr", {}).get("Literal", {}).get("Value")
    if raw is not None:
        if raw.startswith("'") and raw.endswith("'"):
            return raw[1:-1].replace("''", "'")
        if raw in ("true", "false"):
            return raw == "true"
        try:
            return float(raw.rstrip("DL"))
        except ValueError:
            return raw
    return None


def property_value(objects, group, key, default=None):
    for entry in objects.get(group, []):
        if key in entry.get("properties", {}):
            value = literal(entry["properties"][key])
            return default if value is None else value
    return default


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
                roles = {}
                for role, binding in visual.get("query", {}).get("queryState", {}).items():
                    roles[role] = [
                        {
                            "ref": p["queryRef"],
                            "label": p.get("displayName", p.get("nativeQueryRef", p["queryRef"])),
                            "kind": next(iter(p["field"])),
                        }
                        for p in binding.get("projections", [])
                        if p.get("active", True)
                    ]
                container = visual.get("visualContainerObjects", {})
                objects = visual.get("objects", {})
                paragraphs = [
                    paragraph
                    for entry in objects.get("general", [])
                    for paragraph in entry.get("properties", {}).get("paragraphs", [])
                ]
                image = None
                for entry in objects.get("general", []):
                    resource = entry.get("properties", {}).get("imageUrl", {}).get("expr", {}).get("ResourcePackageItem")
                    if resource:
                        asset = f"Report/StaticResources/{resource['PackageName']}/{resource['ItemName']}"
                        if not asset.endswith(".png"):
                            raise ValueError(f"Unsupported report image: {asset}")
                        image = "data:image/png;base64," + base64.b64encode(archive.read(asset)).decode("ascii")
                fill = objects.get("fill", [{}])[0].get("properties", {})
                color = literal(fill.get("fillColor", {}).get("solid", {}).get("color", {}))
                visuals.append(
                    {
                        "id": source_visual["name"],
                        "type": visual.get("visualType", "unknown"),
                        "position": {
                            "x": round(float(position.get("x", 0)), 2),
                            "y": round(float(position.get("y", 0)), 2),
                            "width": round(float(position.get("width", 0)), 2),
                            "height": round(float(position.get("height", 0)), 2),
                            "z": int(position.get("z", 1)),
                        },
                        "label": property_value(container, "title", "text", ""),
                        "subtitle": property_value(container, "subTitle", "text", ""),
                        "roles": roles,
                        "paragraphs": paragraphs,
                        "image": image,
                        "fill": color,
                        "target": property_value(container, "visualLink", "navigationSection"),
                        "action": property_value(container, "visualLink", "type"),
                        "sort": visual.get("query", {}).get("sortDefinition", {}),
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
    with zipfile.ZipFile(TEMPLATES[0]) as archive:
        model = json.loads(archive.read("DataModelSchema").decode("utf-16-le"))["model"]
        schema["measures"] = {
            f"{table['name']}.{measure['name']}": {
                "format": measure.get("formatString", ""),
                "dax": "\n".join(measure["expression"]) if isinstance(measure["expression"], list) else measure["expression"],
            }
            for table in model["tables"]
            for measure in table.get("measures", [])
        }
    definitions = measure_definitions()
    if not definitions:
        raise ValueError("No measure definitions were found.")

    OUTPUT.mkdir(parents=True, exist_ok=True)
    if (OUTPUT / "assets").exists():
        shutil.rmtree(OUTPUT / "assets")
    for name in ("app.js", "styles.css"):
        (OUTPUT / name).unlink(missing_ok=True)
    shutil.copy2(ROOT / "LICENSE", OUTPUT / "LICENSE")
    with (OUTPUT / "report-schema.json").open("w", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(schema, ensure_ascii=False, separators=(",", ":")) + "\n")
    with (OUTPUT / "measure-definitions.json").open("w", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(definitions, ensure_ascii=False, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    build()
