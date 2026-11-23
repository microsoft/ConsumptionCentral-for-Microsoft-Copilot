"""Repair unsupported coverage claims and tenant-only empty states in Studio measures.

Technical measure/table names remain stable for existing visual bindings.
Only targeted measures and their matching disconnected action axis change.
"""
import argparse
import copy
import hashlib

from fix_limit_and_token_measures import TEMPLATES, measure, publish
from fix_pbit_defaults import layout_for
from fix_refresh_time_cuts import joined
from fix_viva_query_org import Package, require

TENANT = "Credit Consumption (Tenant)"
AGENT = "Credit Consumption (Agent)"
HASHES = {
    (AGENT, "Agent Action"): "a4f59ba41ae388f56c219d4719f27ba1fc26cc029fc842a02a32f56ad19c1d04",
    (TENANT, "Studio Forecast Note"): "16fd27c42f917b129cc7622b6f4b0af1074a084dae3dafbedce0f0be2be1effd",
    (TENANT, "Studio Forecast Summary"): "af79c4ac952d91561ec224aaa7ac5cb89fb437cf62a464c26ed63b48f8e544d9",
    (TENANT, "Studio Headline"): "9e2fad6276a4478459e1ae5334488fae34af045017099d80713e14119ed3fdb3",
}
CORRECTED_HASHES = {
    (AGENT, "Agent Action"): "ce0b83d0a14a086da13a92eaa60545402ff00e48249fc42202819a20233a2b7d",
    (TENANT, "Studio Forecast Note"): "61704a4dae4167ae75342d6ce838a582f9f1f2205141ef9a45e88bacf177e813",
    (TENANT, "Studio Forecast Summary"): "e7da4028a00994cf6e3089d087fcd203e33b85cc39b8de68e3a47ff57ebdf946",
    (TENANT, "Studio Headline"): "41e2f2a17ace2d506eaacfbecbc00f5d7ad6e00999d958c39f9d245f83c347d7",
}
ACTION = '''VAR Consumed = [Studio Consumed Credits (Agent)]
VAR Billed = [Total Billed Credits]
VAR Ratio = DIVIDE(Billed, Consumed)
VAR Share = [Agent Credit Share %]
RETURN SWITCH(
    TRUE(),
    ISBLANK(Consumed) || Consumed = 0, "5. No consumption reported",
    Share >= 0.25 && Ratio >= 0.5, "1. Review - high share, mostly billed",
    Ratio >= 0.75, "2. Investigate - high billed share",
    Share >= 0.25, "3. Monitor - high share, lower billed ratio",
    "4. Monitor - lower share, lower billed ratio"
)'''
EMPTY = '''IF(
    COUNTROWS('Credit Consumption (Agent)') > 0 || COUNTROWS('Credit Consumption (User)') > 0,
    "Resource or user credits are present, but dated tenant history is unavailable in this selection.",
    "No dated tenant history in this selection; resource and user views are separate."
)'''
DESCRIPTION = "Share of resource credits reported as non-billed. The source does not establish entitlement, prepaid coverage or the reason for non-billing."
ACTION_LABELS = {
    "1. Review - high volume, mostly billed": "1. Review - high share, mostly billed",
    "2. Investigate - almost all billed": "2. Investigate - high billed share",
    "3. Monitor - high volume, well covered": "3. Monitor - high share, lower billed ratio",
    "4. Healthy - low volume, no action needed": "4. Monitor - lower share, lower billed ratio",
    "5. Unused - retire or promote": "5. No consumption reported",
}


def repaired(table_name, name, source):
    if (table_name, name) == (AGENT, "Agent Action"):
        return ACTION
    if name == "Studio Forecast Note":
        return source.replace('"No Studio data loaded."', EMPTY)
    if name == "Studio Forecast Summary":
        return source.replace('"No Studio consumption in the current selection."', EMPTY)
    return source.replace('"No Studio consumption in this selection."', EMPTY).replace(
        '\n            & IF( Ent > 0, "", " That environment holds no entitlement, so its usage bills directly." )', "")


def build(raw):
    package = Package(raw)
    document, encode = layout_for(package.contents["DataModelSchema"], "schema")
    original = copy.deepcopy(document)
    changes = []
    group = next(t for t in document["model"]["tables"] if t["name"] == "Agent Action Group")
    axis = group["partitions"][0]["source"]
    axis_text = joined(axis["expression"])
    axis_changed = False
    for old, new in ACTION_LABELS.items():
        if f'"{new}"' in axis_text:
            require(f'"{old}"' not in axis_text, "Duplicate action axis label")
            continue
        require(axis_text.count(f'"{old}"') == 1, "Action axis changed; review before patching")
        axis_text = axis_text.replace(f'"{old}"', f'"{new}"')
        axis_changed = True
    if axis_changed:
        axis["expression"] = axis_text.split("\n")
    for key, digest in HASHES.items():
        target = measure(document["model"], *key)
        source = joined(target["expression"])
        current_hash = hashlib.sha256(source.encode()).hexdigest()
        if current_hash == CORRECTED_HASHES[key]:
            continue
        require(current_hash == digest, f"{key} changed; review before patching")
        target["expression"] = repaired(*key, source)
        changes.append(key)
    target = measure(document["model"], AGENT, "Non-Billed Credit Share %")
    if joined(target.get("description")) != DESCRIPTION:
        require("non-billed" in joined(target.get("description")).lower(), "Non-billed description has changed")
        target["description"] = DESCRIPTION
        changes.append((AGENT, "Non-Billed Credit Share %"))
    if not changes and not axis_changed:
        return raw, []
    masked = copy.deepcopy(document)
    if axis_changed:
        before_group = next(t for t in original["model"]["tables"] if t["name"] == "Agent Action Group")
        masked_group = next(t for t in masked["model"]["tables"] if t["name"] == "Agent Action Group")
        masked_group["partitions"][0]["source"]["expression"] = before_group["partitions"][0]["source"]["expression"]
    for key in changes:
        before = measure(original["model"], *key)
        after = measure(masked["model"], *key)
        after["expression"] = before["expression"]
        if "description" in before:
            after["description"] = before["description"]
        else:
            after.pop("description", None)
    require(masked == original, "An unrelated model field changed")
    if axis_changed:
        changes.append(("Agent Action Group", "Action axis"))
    return package.rebuild({"DataModelSchema": encode(document)}), changes


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    candidates = [(p, p.read_bytes()) for p in TEMPLATES]
    candidates = [(p, raw, *build(raw)) for p, raw in candidates]
    for p, raw, candidate, changes in candidates:
        print(f"{p.parent.name}: {'needs resource wording' if changes else 'ok'}")
        if changes and not (args.check or args.dry_run):
            publish(p, raw, candidate)
    return int(args.check and any(c[3] for c in candidates))


if __name__ == "__main__":
    raise SystemExit(main())
