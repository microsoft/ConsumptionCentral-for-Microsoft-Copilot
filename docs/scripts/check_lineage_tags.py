"""Assert no .pbit repeats a lineage tag inside a single collection.

Desktop refuses the whole template - "Cannot de-serialize Database. Error: An
object with lineage-tag '...' already exists in the collection." - when two
siblings in the same list carry the same tag. Nothing else in the build
notices, so a template can look fine, pass every other check, ship, and then
fail to open at all. That is exactly what happened when DataversePrefix was
cloned from DataverseDatabase and inherited its tag.

The rule is per collection, not per file. A column and a measure may share a
tag because they live in different lists, and several templates do; flagging
those would be noise. This only reports siblings.

Run with no arguments to check every template in the repo, or pass paths.
"""
import json
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PARTS = ("DataModelSchema", "UnappliedChanges")


def load(raw: bytes):
    """Decode a model part. Some carry a UTF-16LE BOM, some do not."""
    body = raw[2:] if raw[:2] == b"\xff\xfe" else raw
    if len(body) > 1 and body[1] == 0:
        text = body.decode("utf-16-le")
    else:
        text = raw.decode("utf-8-sig")
    return json.loads(text.lstrip("\ufeff"))


def duplicates(value, path="", found=None):
    """Every tag shared by two siblings, as (path, tag, names)."""
    if found is None:
        found = []
    if isinstance(value, dict):
        for key, child in value.items():
            duplicates(child, f"{path}.{key}" if path else key, found)
    elif isinstance(value, list):
        seen: dict[str, list[str]] = {}
        for index, item in enumerate(value):
            if isinstance(item, dict) and isinstance(item.get("lineageTag"), str):
                seen.setdefault(item["lineageTag"], []).append(
                    str(item.get("name", index)))
        for tag, names in seen.items():
            if len(names) > 1:
                found.append((path, tag, names))
        for index, item in enumerate(value):
            name = item.get("name") if isinstance(item, dict) else None
            label = name if isinstance(name, str) else str(index)
            duplicates(item, f"{path}[{label}]", found)
    return found


def check(template: Path) -> int:
    problems = []
    with zipfile.ZipFile(template) as archive:
        names = set(archive.namelist())
        for part in PARTS:
            if part not in names:
                continue
            for path, tag, dupes in duplicates(load(archive.read(part))):
                problems.append(f"{part}:{path} repeats {tag} on {', '.join(dupes)}")

    print(template.relative_to(REPO).as_posix()
          if REPO in template.resolve().parents else template.name)
    if problems:
        for problem in problems:
            print(f"  FAIL {problem}")
        return 1
    print("  no repeated lineage tag in any collection")
    return 0


def main() -> int:
    if len(sys.argv) > 1:
        templates = [Path(a) for a in sys.argv[1:]]
    else:
        templates = sorted(REPO.glob("*/*.pbit"))
    if not templates:
        print("error: no templates found")
        return 1
    return max(check(t) for t in templates)


if __name__ == "__main__":
    sys.exit(main())
