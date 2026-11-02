"""Add the chargeback model to the three current templates.

Chargeback charges each cost centre (or department) for its people's Cowork
credits. The capacity pack is shared pro rata: across the whole tenant, the
period's prepaid credits are divided by all credits used, and every cost
centre is charged that share of its credits at the prepaid rate and the rest
at the pay-as-you-go rate. The charges then add up to Cowork Total Cost. The
rates are the templates' own (Cowork Prepaid Rate Value and Cowork PAYG Rate
Value), the same ones the Cost page uses. The app's Chargeback view
(app/src/metrics/chargeback.ts) works the same way.

What this changes, in DataModelSchema and, for the queries, UnappliedChanges:

* SpendingPolicy loads four optional billing columns from the spending policy
  file: CostCentre, Department, BillingOwner and ChargeCode. Their headers are
  matched ignoring case, spaces, "_" and "-", and CostCenter reads as
  CostCentre. A file without them still loads. A blank CostCentre or
  Department becomes "(Not assigned)"; a blank BillingOwner or ChargeCode
  stays blank.
    - Local CSV reads them from SpendingPolicyMetadata.csv.
    - Fabric reads cost_centre, department, billing_owner and charge_code
      from viva_spending_policy, which Ingest_Viva_Consumption.ipynb writes.
    - Viva Direct reads them from the policy file through VivaPolicyLookup:
      the connector has no policy table, so the file is the only source.
* SpendingPolicy gains those four columns.
* CoworkBilling gains eight measures in the Chargeback folder, and the three
  existing chargeback measures get descriptions saying what they measure.

Every edit moves only from the exact text the templates shipped with, so
anything edited since fails the run, as does anything else that moves. Every
other ZIP member keeps its raw bytes - the report layer is signed by
SecurityBindings. Running it twice changes nothing. The archived templates
are left alone.

    python docs/scripts/fix_chargeback.py --dry-run
    python docs/scripts/fix_chargeback.py
    python docs/scripts/fix_chargeback.py --check   # exit 1 if a template is stale

The report page is a separate step: docs/scripts/chargeback/apply.py adds it
to a PBIP project, then Desktop exports the .pbit (see docs/BUILD.md). A
Desktop re-export drops descriptions; run this again afterwards to restore
them.
"""

import argparse
import copy
import os
import sys
import uuid
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fix_pbit_defaults import layout_for  # noqa: E402
from fix_refresh_time_cuts import (  # noqa: E402
    OWNED, SCHEMA, UNAPPLIED, joined, lines, one, owned_mask_pending, replace_snippets, sync_last_loaded,
    validate)
from fix_viva_query_org import Package, PatchError, require  # noqa: E402,F401 - PatchError is re-exported

REPO = Path(__file__).resolve().parents[2]

LOCAL, FABRIC, VIVA = "Local CSV", "Fabric", "Viva Direct"
TEMPLATES = {
    LOCAL: REPO / "1. Local CSV" / "Consumption Central - Local CSV.pbit",
    FABRIC: REPO / "2. Fabric" / "Consumption Central - Fabric.pbit",
    VIVA: REPO / "3. Viva Direct" / "Consumption Central - Viva Direct.pbit",
}

NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/chargeback")
NOT_ASSIGNED = "(Not assigned)"
POLICY = "SpendingPolicy"
LOOKUP = "VivaPolicyLookup"
COWORK = "CoworkBilling"
FOLDER = "Chargeback"


def tag(name):
    return str(uuid.uuid5(NAMESPACE, name))


# ---------------------------------------------------------------------------
# SpendingPolicy columns
# ---------------------------------------------------------------------------

BILLING = {
    "CostCentre": ("cost_centre", "The cost centre this spending policy's credits are charged to, from the optional "
                   "CostCentre column of the spending policy file. (Not assigned) when it is blank or missing."),
    "Department": ("department", "The department this spending policy's credits are charged to, from the optional "
                   "Department column of the spending policy file. (Not assigned) when it is blank or missing."),
    "BillingOwner": ("billing_owner", "Who approves this spending policy's charge, from the optional BillingOwner "
                     "column of the spending policy file."),
    "ChargeCode": ("charge_code", "The code a finance system books this spending policy's charge to, from the "
                   "optional ChargeCode column of the spending policy file."),
}
LABELLED = ("CostCentre", "Department")


def column(name):
    return {"name": name, "description": BILLING[name][1], "dataType": "string", "sourceColumn": name,
            "lineageTag": tag(f"{POLICY}.{name}"), "summarizeBy": "none"}


COLUMNS = [column(name) for name in BILLING]


# ---------------------------------------------------------------------------
# Measures
# ---------------------------------------------------------------------------

def measure(name, description, expression, fmt):
    return {"name": name, "description": lines(description), "expression": lines(expression), "formatString": fmt,
            "displayFolder": FOLDER, "lineageTag": tag(f"measure.{name}")}


CREDITS, MONEY, SHARE = "#,0", "\\$#,0.00", "0.0%"

MEASURES = [
    measure(
        "Chargeback Prepaid Share %",
        "The tenant's prepaid share for the period: prepaid credits used divided by all credits used, across "
        "every person whatever the policy, org or Group By filters. Each cost centre is charged this share of "
        "its credits at the prepaid rate.",
        "\n".join((
            "// Tenant-wide, so every cost centre is charged at the same blended rate and the",
            "// charges add up to Cowork Total Cost. The period and the Cowork/WorkIQ toggle",
            "// still apply.",
            "VAR Used =",
            "    CALCULATE(",
            "        [Cowork Total Credits Used],",
            "        REMOVEFILTERS( 'SpendingPolicy' ),",
            "        REMOVEFILTERS( 'Org' ),",
            "        REMOVEFILTERS( 'Group By' ),",
            "        REMOVEFILTERS( 'CoworkBilling' )",
            "    )",
            "RETURN",
            "    DIVIDE( MIN( Used, [Cowork Prepaid Balance] ), Used )",
        )),
        SHARE),
    measure(
        "Allocated Credits",
        "Credits used in the period by the people in scope, each charged to their own spending policy for the "
        "whole period.",
        "\n".join((
            "// A person's weeks under an earlier policy follow them to their current one",
            "// (CoworkBilling[SpendingPolicyId]), so the cost centres add up to the tenant",
            "// total, as in the app's Chargeback view.",
            "VAR People = VALUES( 'CoworkBilling'[UserPrincipalName] )",
            "RETURN",
            "    IF( NOT ISEMPTY( People ),",
            "        CALCULATE(",
            "            [Cowork Total Credits Used],",
            "            REMOVEFILTERS( 'SpendingPolicy' ),",
            "            TREATAS( People, 'CoworkBilling'[UserPrincipalName] )",
            "        )",
            "    )",
        )),
        CREDITS),
    measure(
        "Allocated Prepaid Credits",
        "The prepaid part of Allocated Credits: its share of the capacity pack, pro rata.",
        "[Allocated Credits] * [Chargeback Prepaid Share %]",
        CREDITS),
    measure(
        "Allocated PAYG Credits",
        "The pay-as-you-go part of Allocated Credits: what the capacity pack did not cover.",
        "[Allocated Credits] - [Allocated Prepaid Credits]",
        CREDITS),
    measure(
        "Allocated Prepaid Cost",
        "Allocated Prepaid Credits at the prepaid rate.",
        "[Allocated Prepaid Credits] * [Cowork Prepaid Rate Value]",
        MONEY),
    measure(
        "Allocated PAYG Cost",
        "Allocated PAYG Credits at the pay-as-you-go rate.",
        "[Allocated PAYG Credits] * [Cowork PAYG Rate Value]",
        MONEY),
    measure(
        "Allocated Cost",
        "What to charge back: the prepaid share at the prepaid rate plus the rest at the pay-as-you-go rate. "
        "Its total over every cost centre is Cowork Total Cost. Use it rather than Cowork Total Cost by cost "
        "centre, which would give every cost centre the whole capacity pack.",
        "[Allocated Prepaid Cost] + [Allocated PAYG Cost]",
        MONEY),
    measure(
        "Allocated Cost Share %",
        "This row's share of the Allocated Cost of everything selected.",
        "DIVIDE( [Allocated Cost], CALCULATE( [Allocated Cost], ALLSELECTED( 'SpendingPolicy' ) ) )",
        SHARE),
]
AFTER = "Chargeback per User $"

# Existing measures whose names say "chargeback" but mean something else: (name, description).
DESCRIPTIONS = {
    "Chargeback $": "List-price cost: credits used at the pay-as-you-go rate, ignoring any capacity pack. "
                    "For what to charge each cost centre, use Allocated Cost.",
    "Chargeback": "Overage only: the cost of credits used above each person's allowance (Over Limit $). "
                  "For what to charge each cost centre, use Allocated Cost.",
    "Chargeback %": "Overage as a share of allowance: credits used above each person's allowance divided by "
                    "the allowance.",
}


# ---------------------------------------------------------------------------
# Queries: name -> [(shipped text, new text)], per template
# ---------------------------------------------------------------------------

WANTED = '"SpendingPolicyId", "Name", "PlanLimit", "UserLimit", "IncludedServices"'
EMPTY_OLD = ('#table(type table [#"SpendingPolicyId" = text, #"Policy Name" = text, #"PlanLimit" = Int64.Type, '
             '#"UserLimit" = Int64.Type, #"IncludedServices" = text], {})')
EMPTY_NEW = EMPTY_OLD.replace('#"IncludedServices" = text]', '#"IncludedServices" = text, '
                              + ", ".join(f'#"{c}" = text' for c in BILLING) + "]")


def billing_name(indent, var):
    """An M function mapping a header to its billing column name, or leaving it alone."""
    return "\n".join((
        f"{indent}(n as text) as text =>",
        f"{indent}\tlet k = Text.Lower(Text.Remove(n, {{\" \", \"_\", \"-\"}}))",
        f"{indent}\tin if k = \"costcentre\" or k = \"costcenter\" then \"CostCentre\"",
        f"{indent}\telse if k = \"department\" then \"Department\"",
        f"{indent}\telse if k = \"billingowner\" then \"BillingOwner\"",
        f"{indent}\telse if k = \"chargecode\" then \"ChargeCode\"",
        f"{indent}\telse n{var}",
    ))


def billing_values(indent):
    """TransformColumns entries: trimmed text, "(Not assigned)" or null when blank."""
    def entry(name):
        blank = f'"{NOT_ASSIGNED}"' if name in LABELLED else "null"
        return (f'{indent}{{"{name}", each if _ = null or Text.Trim(Text.From(_)) = "" then {blank} '
                f'else Text.Trim(Text.From(_)), type text}}')
    return ",\n".join(entry(name) for name in BILLING)


HEADER_NOTE = (
    "// The billing columns are optional. Their headers are matched ignoring case,",
    "// spaces, \"_\" and \"-\", and CostCenter reads as CostCentre.",
)

LOCAL_POLICY = [
    (EMPTY_OLD, EMPTY_NEW),
    ("\n".join((
        '\t\tSource = Csv.Document(Bin, [Delimiter=",", Columns=5, Encoding=65001, QuoteStyle=QuoteStyle.Csv]),',
        "\t\tHeaders = Table.PromoteHeaders(Source, [PromoteAllScalars=true]),",
    )), "\n".join((
        '\t\tSource = Csv.Document(Bin, [Delimiter=",", Encoding=65001, QuoteStyle=QuoteStyle.Csv]),',
        "\t\tPromoted = Table.PromoteHeaders(Source, [PromoteAllScalars=true]),",
        *(f"\t\t{note}" for note in HEADER_NOTE),
        "\t\t// A file without them, such as a fresh Viva export, still loads.",
        "\t\tBilling = Table.TransformColumnNames(Promoted,",
        billing_name("\t\t\t", "),"),
        f"\t\tHeaders = Table.SelectColumns(Billing, {{{WANTED},",
        "\t\t\t" + ", ".join(f'"{c}"' for c in BILLING) + "}, MissingField.UseNull),",
    ))),
    ("\n".join((
        "\t\tNamed = Table.TransformColumns(Headers, {",
        '\t\t\t{"Name", each if _ = null or _ = "" then "(Unassigned)" else _, type text}',
        "\t\t}),",
    )), "\n".join((
        "\t\tNamed = Table.TransformColumns(Headers, {",
        '\t\t\t{"Name", each if _ = null or _ = "" then "(Unassigned)" else _, type text},',
        billing_values("\t\t\t"),
        "\t\t}),",
    ))),
]

FABRIC_POLICY = [
    (EMPTY_OLD, EMPTY_NEW),
    ('{"spending_policy_id", "name", "plan_limit", "user_limit", "included_services"}, MissingField.UseNull)',
     '{"spending_policy_id", "name", "plan_limit", "user_limit", "included_services", '
     + ", ".join(f'"{source}"' for source, _ in BILLING.values()) + "}, MissingField.UseNull)"),
    ('{"included_services", "IncludedServices"}}),',
     '{"included_services", "IncludedServices"}, '
     + ", ".join(f'{{"{source}", "{name}"}}' for name, (source, _) in BILLING.items()) + "}),"),
    ('\t\tTyped = Table.TransformColumnTypes(Renamed, {{"PlanLimit", Int64.Type}, {"UserLimit", Int64.Type}})',
     "\n".join((
         "\t\t\t\t// The billing columns are optional; a blank cost centre or department is \"(Not assigned)\".",
         "\t\t\t\tBilled = Table.TransformColumns(Renamed, {",
         billing_values("\t\t\t\t\t"),
         "\t\t\t\t}),",
         '\t\tTyped = Table.TransformColumnTypes(Billed, {{"PlanLimit", Int64.Type}, {"UserLimit", Int64.Type}})',
     ))),
]

VIVA_LOOKUP = [
    ("\n".join((
        "\tEmpty = #table(type table [SpendingPolicyId = text, Name = text,",
        "\t\t\tPlanLimit = Int64.Type, UserLimit = Int64.Type,",
        "\t\t\tIncludedServices = text], {}),",
    )), "\n".join((
        "\tEmpty = #table(type table [SpendingPolicyId = text, Name = text,",
        "\t\t\tPlanLimit = Int64.Type, UserLimit = Int64.Type,",
        "\t\t\tIncludedServices = text, CostCentre = text, Department = text,",
        "\t\t\tBillingOwner = text, ChargeCode = text], {}),",
        "\t// The optional billing columns. Only the file carries them.",
        "\tBilling = {" + ", ".join(f'"{c}"' for c in BILLING) + "},",
    ))),
    ("\t\t\t\t\tHdr = Table.PromoteHeaders(Src, [PromoteAllScalars=true]),",
     "\n".join((
         "\t\t\t\t\tPromoted = Table.PromoteHeaders(Src, [PromoteAllScalars=true]),",
         *(f"\t\t\t\t\t{note}" for note in HEADER_NOTE),
         "\t\t\t\t\tHdr = Table.TransformColumnNames(Promoted,",
         billing_name("\t\t\t\t\t\t", "),"),
     ))),
    ('\t\t\t\t\t\t\t"UserLimit", "IncludedServices"}, Hdr, (t, c) =>',
     '\t\t\t\t\t\t\t"UserLimit", "IncludedServices"} & Billing, Hdr, (t, c) =>'),
    ('\t\t\t\t\t\t\t"PlanLimit", "UserLimit", "IncludedServices"})',
     '\t\t\t\t\t\t\t"PlanLimit", "UserLimit", "IncludedServices"} & Billing)'),
    ("\n".join((
        '\t\t\t\t\t{"Svc2", "IncludedServices"}})',
        "\t\t\tin",
        "\t\t\t\tTable.TransformColumnTypes(Renamed, {",
    )), "\n".join((
        '\t\t\t\t\t{"Svc2", "IncludedServices"}}),',
        "\t\t\t\tBilled = List.Accumulate(Billing, Renamed, (t, c) =>",
        "\t\t\t\t\tTable.AddColumn(t, c, each Lookup([SpendingPolicyId], c), type text))",
        "\t\t\tin",
        "\t\t\t\tTable.TransformColumnTypes(Billed, {",
    ))),
]

VIVA_POLICY = [
    ('\tWanted = {"SpendingPolicyId","Policy Name","PlanLimit","UserLimit","IncludedServices"},',
     '\tWanted = {"SpendingPolicyId","Policy Name","PlanLimit","UserLimit","IncludedServices",'
     + ",".join(f'"{c}"' for c in BILLING) + "},"),
    ("\n".join((
        '\t\t{"IncludedServices", type text}',
        "\t}),",
        '\tFilled = Table.ReplaceValue(Typed, null, 0, Replacer.ReplaceValue, {"PlanLimit","UserLimit"})',
        "in",
        "\tFilled",
    )), "\n".join((
        '\t\t{"IncludedServices", type text},',
        "\t\t" + ",".join(f'{{"{c}", type text}}' for c in BILLING),
        "\t}),",
        '\tFilled = Table.ReplaceValue(Typed, null, 0, Replacer.ReplaceValue, {"PlanLimit","UserLimit"}),',
        "\t// A blank cost centre or department is \"(Not assigned)\".",
        "\tBilled = Table.TransformColumns(Filled, {",
        billing_values("\t\t"),
        "\t})",
        "in",
        "\tBilled",
    ))),
]

QUERIES = {
    LOCAL: {POLICY: LOCAL_POLICY},
    FABRIC: {POLICY: FABRIC_POLICY},
    VIVA: {POLICY: VIVA_POLICY, LOOKUP: VIVA_LOOKUP},
}


# ---------------------------------------------------------------------------
# Model edits: each returns the labels it changed
# ---------------------------------------------------------------------------


def query_source(model, name):
    """The record holding a query's M: a table's single M partition, or a shared expression."""
    tables = [t for t in model["tables"] if t["name"] == name]
    if tables:
        partitions = tables[0].get("partitions", [])
        require(len(partitions) == 1 and partitions[0]["source"].get("type") == "m",
                f"{name} is not a single-partition M table")
        return partitions[0]["source"], "expression"
    return one(model.get("expressions", []), name, f"{SCHEMA} expressions"), "expression"


def edit_queries_model(model, queries):
    changed = []
    for name, edits in queries.items():
        record, field = query_source(model, name)
        old = joined(record[field])
        new = replace_snippets(name, old, edits)
        if new != old:
            record[field] = lines(new)
            changed.append(name)
    return changed


def edit_queries_pending(pending, queries):
    changed, rewritten = [], {}
    for name, edits in queries.items():
        query = one(pending["queries"], name, f"{UNAPPLIED} queries")
        old = joined(query["text"])
        new = replace_snippets(name, old, edits)
        if new != old:
            query["text"] = new.split("\n") if isinstance(query["text"], list) else new
            rewritten[name] = (old, new)
            changed.append(name)
    if rewritten:
        for query in pending["queries"]:
            sync_last_loaded(query, rewritten)
    return changed


def with_description(record, description):
    """The record with a description placed after its name, every other key kept in order."""
    moved = {"name": record["name"], "description": description}
    moved.update((k, v) for k, v in record.items() if k not in ("name", "description"))
    record.clear()
    record.update(moved)


def keep_or_restore(record, spec, label):
    """An existing record must match the spec. A description a Desktop re-export dropped comes back."""
    restored = False
    for key, value in spec.items():
        if joined(record.get(key)) == joined(value):
            continue
        require(key == "description" and key not in record, f"{label} {key} has changed; review it before patching")
        with_description(record, value)
        restored = True
    return restored


def add_records(records, specs, after, label):
    """Add each spec after `after` (in order), or check the one already there; return the labels changed."""
    changed = []
    position = records.index(one(records, after, label)) + 1
    for spec in specs:
        hits = [r for r in records if r.get("name") == spec["name"]]
        require(len(hits) <= 1, f"{label}: {spec['name']!r} appears {len(hits)} times")
        if hits:
            if keep_or_restore(hits[0], spec, f"{label}[{spec['name']}]"):
                changed.append(f"{label}[{spec['name']}] description restored")
            position = records.index(hits[0]) + 1
            continue
        require(all(r.get("lineageTag") != spec["lineageTag"] for r in records),
                f"{label}: lineage tag of {spec['name']!r} already in use")
        records.insert(position, copy.deepcopy(spec))
        position += 1
        changed.append(f"{label}[{spec['name']}] added")
    return changed


def edit_descriptions(cowork):
    changed = []
    for name, description in DESCRIPTIONS.items():
        record = one(cowork["measures"], name, COWORK)
        if joined(record.get("description")) == description:
            continue
        require("description" not in record, f"{COWORK}[{name}] description has changed; review it before patching")
        with_description(record, lines(description))
        changed.append(f"{COWORK}[{name}] description")
    return changed


def edit_model(document, queries):
    model = document["model"]
    changed = edit_queries_model(model, queries)
    policy = one(model["tables"], POLICY, f"{SCHEMA} tables")
    changed += add_records(policy["columns"], COLUMNS, "IncludedServices", POLICY)
    cowork = one(model["tables"], COWORK, f"{SCHEMA} tables")
    changed += add_records(cowork["measures"], MEASURES, AFTER, COWORK)
    changed += edit_descriptions(cowork)
    return changed


def owned_mask_model(document, queries):
    """The model with this script's fields blanked out: everything else must not move."""
    result = copy.deepcopy(document)
    model = result["model"]
    for name in queries:
        record, field = query_source(model, name)
        record[field] = OWNED
    policy = one(model["tables"], POLICY, "tables")
    policy["columns"] = [c for c in policy["columns"] if c["name"] not in BILLING]
    cowork = one(model["tables"], COWORK, "tables")
    added = {m["name"] for m in MEASURES}
    cowork["measures"] = [m for m in cowork["measures"] if m["name"] not in added]
    for m in cowork["measures"]:
        if m["name"] in DESCRIPTIONS:
            m.pop("description", None)
    return result


# ---------------------------------------------------------------------------
# Archive
# ---------------------------------------------------------------------------


def build(raw, variant):
    """Return (bytes, changes) for one template. One with nothing to change comes back as raw."""
    package = Package(raw)
    # layout_for re-encodes each part byte for byte before handing it over, so an edit
    # cannot quietly change the BOM, the indentation or the line endings.
    model, encode_model = layout_for(package.contents[SCHEMA], SCHEMA)
    pending, encode_pending = layout_for(package.contents[UNAPPLIED], UNAPPLIED)
    queries = QUERIES[variant]
    for name in queries:
        # Both copies take the same edit, so they only end in step if they start in step.
        record, field = query_source(model["model"], name)
        require(joined(one(pending["queries"], name, f"{UNAPPLIED} queries")["text"]) == joined(record[field]),
                f"{name}: the {UNAPPLIED} copy differs from the model; run fix_query_body_drift.py first")

    changes, updates = [], {}
    before = copy.deepcopy(model)
    edits = edit_model(model, queries)
    if edits:
        require(owned_mask_model(before, queries) == owned_mask_model(model, queries),
                f"{SCHEMA}: a field outside the chargeback model changed")
        updates[SCHEMA] = encode_model(model)
        changes += [f"{SCHEMA} {edit}" for edit in edits]

    before = copy.deepcopy(pending)
    edits = edit_queries_pending(pending, queries)
    if edits:
        require(owned_mask_pending(before, queries) == owned_mask_pending(pending, queries),
                f"{UNAPPLIED}: a field outside the chargeback queries changed")
        updates[UNAPPLIED] = encode_pending(pending)
        changes += [f"{UNAPPLIED} {edit}" for edit in edits]

    if not updates:
        return raw, changes
    candidate = package.rebuild(updates)
    validate(package, candidate, updates, model, pending)
    return candidate, changes


def publish(path, raw, candidate):
    """Write through a scratch file, and only over the bytes the patch was built from."""
    scratch = path.with_name(f".fix-chargeback-{uuid.uuid4().hex}.pbit")
    owned = False
    try:
        with scratch.open("xb") as stream:
            owned = True
            stream.write(candidate)
            stream.flush()
            os.fsync(stream.fileno())
        require(scratch.read_bytes() == candidate, "scratch write verification failed")
        require(path.read_bytes() == raw, f"{path.name} changed during the patch; refusing to publish")
        os.replace(scratch, path)
        owned = False
    finally:
        if owned:
            scratch.unlink()


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="validate and report without writing")
    mode.add_argument("--check", action="store_true", help="exit 1 if any template still needs a change")
    args = parser.parse_args(argv)

    stale = failed = 0
    for variant, path in TEMPLATES.items():
        print(variant)
        try:
            require(path.is_file(), f"missing template: {path}")
            raw = path.read_bytes()
            candidate, changes = build(raw, variant)
            if not changes:
                print("  already applied; left byte for byte unchanged")
                continue
            stale += 1
            for change in changes:
                print(f"  {change}")
            if not (args.dry_run or args.check):
                publish(path, raw, candidate)
                print("  validated patch written")
        except (ValueError, KeyError, TypeError, zipfile.BadZipFile) as error:
            print(f"  FAILED: {error}", file=sys.stderr)
            failed += 1
    would = "would be " if args.dry_run or args.check else ""
    print(f"\n{stale} template(s) {would}patched" + (f", {failed} failed" if failed else ""))
    return 1 if failed or (args.check and stale) else 0


if __name__ == "__main__":
    sys.exit(main())
