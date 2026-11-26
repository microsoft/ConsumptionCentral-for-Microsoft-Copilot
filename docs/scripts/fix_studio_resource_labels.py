"""Update Studio display labels in an expanded PBIP, then re-export in Desktop.

Never patch a signed PBIT report directly. Semantic query references remain
unchanged; only visual titles, accessible text, text runs and field aliases change.
"""
import argparse
import json
import re
from pathlib import Path

PAGES = ("d0243621b324b4cb196a", "studio-credit-consumption", "studio-optimisation", "studio-forecast")


def resource(match):
    old = match.group()
    word = "resources" if old.lower() == "agents" else "resource"
    if old.isupper():
        return word.upper()
    return word.capitalize() if old[0].isupper() else word


def repair(value, path=()):
    if isinstance(value, dict):
        result = {key: repair(child, path + (key,)) for key, child in value.items()}
        if path[-2:-1] == ("projections",) and "displayName" not in result:
            column = result.get("field", {}).get("Column", {})
            if column.get("Property") == "Agent Name":
                result["displayName"] = "Resource"
        return result
    if isinstance(value, list):
        return [repair(child, path + (index,)) for index, child in enumerate(value)]
    alias = path[-1:] == ("displayName",) and "projections" in path
    caption = path[-2:] == ("Literal", "Value") and "visualContainerObjects" in path
    text_run = path[-1:] == ("value",) and "textRuns" in path
    if isinstance(value, str) and (alias or caption or text_run):
        return re.sub(r"\bagents?\b", resource, value, flags=re.IGNORECASE)
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path, help="Expanded .Report directory, never a PBIT")
    args = parser.parse_args()
    count = 0
    for page in PAGES:
        directory = args.report / "definition" / "pages" / page / "visuals"
        if not directory.is_dir():
            raise ValueError(f"Missing Studio page: {page}")
        for file in directory.glob("*\\visual.json"):
            before = json.loads(file.read_text(encoding="utf-8-sig"))
            after = repair(before)
            if before != after:
                file.write_text(json.dumps(after, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
                count += 1
    print(f"Updated {count} Studio visuals. Validate, open and re-export with Power BI Desktop.")


if __name__ == "__main__":
    main()
