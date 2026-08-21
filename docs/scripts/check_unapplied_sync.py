"""Compare the query list in DataModelSchema against UnappliedChanges.

A .pbit carries the queries TWICE: once as model expressions/partitions in
DataModelSchema, and again in an UnappliedChanges part holding the whole
query document. Desktop reads both while restoring mashup state and builds
a dictionary across them in InitializePersistedModelingState. A name in one
but not the other, or twice in either, throws "An item with the same key
has already been added", and Desktop reports the template as corrupted or
encrypted with nothing to say why.

An earlier session already established that UnappliedChanges is a normal
export artefact rather than a pending-changes flag - see
check_unapplied.py. What that did not cover, and what this adds, is that
ADDING a query to the model without adding it here breaks the file.

Calculated tables are excluded. A DAX calculated table has no mashup query,
so it correctly never appears in UnappliedChanges. Consumption Central's own
model is built entirely from Power Query and so has none, but the check is
used against other templates in the family - GitHubCopilotPanel has two -
where the unfiltered comparison reports failures on a perfectly good file.
The test is on the partition source type rather than a name list, so a
calculated table added here later needs no change to this script.
"""
import json
import sys
import zipfile
from collections import Counter
from pathlib import Path


def decode(raw):
    if raw[:2] == b"\xff\xfe":
        return raw.decode("utf-16")
    if raw[:3] == b"\xef\xbb\xbf":
        return raw.decode("utf-8-sig")
    if len(raw) > 1 and raw[1] == 0:
        return raw.decode("utf-16-le")
    return raw.decode("utf-8")


def mashup_backed(table):
    """True when at least one partition is a Power Query partition.

    A calculated table's partitions are type "calculated"; a calculation
    group uses "calculationGroup". Neither has a mashup query behind it.
    """
    return any(p.get("source", {}).get("type") == "m"
               for p in table.get("partitions", []))


def main():
    rc = 0
    for arg in sys.argv[1:]:
        p = Path(arg)
        with zipfile.ZipFile(p) as z:
            if "UnappliedChanges" not in z.namelist():
                print(f"{p.name}: no UnappliedChanges part")
                continue
            model = json.loads(decode(z.read("DataModelSchema")))["model"]
            unapplied = json.loads(decode(z.read("UnappliedChanges")))

        tables = model.get("tables", [])
        calculated = [t["name"] for t in tables if not mashup_backed(t)]
        model_names = ([e["name"] for e in model.get("expressions", [])]
                       + [t["name"] for t in tables if mashup_backed(t)])
        uq = [q["name"] for q in unapplied.get("queries", [])]

        print(p.name)
        print(f"  model objects {len(model_names)}   "
              f"unapplied queries {len(uq)}")
        if calculated:
            print(f"  calculated, no M query expected: {', '.join(calculated)}")

        problems = 0
        for n, c in Counter(uq).items():
            if c > 1:
                print(f"  DUPLICATE in UnappliedChanges: {n} x{c}")
                problems += 1

        only_model = sorted(set(model_names) - set(uq))
        only_un = sorted(set(uq) - set(model_names))
        if only_model:
            print(f"  in the model, MISSING from UnappliedChanges "
                  f"({len(only_model)}): {', '.join(only_model)}")
            problems += len(only_model)
        if only_un:
            print(f"  in UnappliedChanges, missing from the model "
                  f"({len(only_un)}): {', '.join(only_un)}")
            problems += len(only_un)

        if not problems:
            print("  the two lists agree")
        rc |= 1 if problems else 0
    return rc


if __name__ == "__main__":
    sys.exit(main())
