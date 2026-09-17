# Building the templates

The `.pbit` files are produced from the working PBIP project. This is a short manual step — Power BI
Desktop has no command-line template export, so it cannot be scripted.

## Source project

```
ConsumptionCentral-GHCP\Consumption Central - Cowork WorkIQ Studio GHCP.pbip     the CSV variant
ConsumptionCentral-Fabric\Consumption Central - Cowork WorkIQ Studio GHCP.pbip   the Lakehouse variant
```

27 tables, 284 measures, 14 pages. Identical model and report in both — only the partitions and the
source parameters differ.

## Producing `Consumption Central - Local CSV.pbit`

1. Open the `.pbip` in Power BI Desktop and let it refresh.
2. **Reset the seven parameters to shipping defaults** — *Transform data → Manage parameters*. A
   `.pbit` stores parameter *defaults*, so whatever is set here is what every customer sees first.
   This is the step to be careful about: if `DataFolder` still points at your OneDrive, or the rates
   are a customer's real ones, that ships inside the file.

   > **This step was missed once and it broke the template for everyone.** Every parameter shipped
   > as `null`. `VivaPeriodStart` computes `BillingPeriodWeeks - 1`, `null - 1` throws, and because
   > that query feeds the rest, *every* table then reported only "Load was cancelled by an error in
   > loading a previous table" — which reads like a corrupt CSV rather than an empty parameter box.
   > See [#6](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/issues/6).
   > `VivaPeriodStart` now falls back to 4 if the parameter is empty, so the crash cannot recur,
   > but the defaults below are still what a customer should see on opening.
   >
   > Verify before exporting, from the repo root:
   > ```
   > python docs/scripts/check_pbit_defaults.py "1. Local CSV/Consumption Central - Local CSV.pbit"
   > ```

   | Parameter | Ship as |
   |---|---|
   | `DataFolder` | `C:\Consumption Central\Data` — a neutral placeholder |
   | `CreditRate` | `0.01` |
   | `PrepaidCreditRate` | `0.008` |
   | `PrepaidCreditBalance` | `0` |
   | `GitHubBusinessSeatPrice` | `19` |
   | `GitHubEnterpriseSeatPrice` | `39` |
   | `BillingPeriodWeeks` | `4` |

3. Check the **Settings** query still holds `#date(2026, 9, 1)`, `1900`, `3900` for the GitHub
   allowance change — those are constants there, not parameters, so they are easy to forget.
4. **File → Export → Power BI template**.
5. Description:
   > Copilot credit consumption and cost across Cowork/Work IQ, Copilot Studio and GitHub Copilot.
   > Point DataFolder at a folder holding your exports — the files are found by name, so nothing
   > needs renaming and anything you do not have is skipped. See the README for where each export
   > comes from.
6. Save as `1. Local CSV\Consumption Central - Local CSV.pbit`.

## Producing `Consumption Central - Fabric.pbit`

Same model, different source. **The swap is done** — it lives in its own project so both variants
can be maintained side by side:

```
ConsumptionCentral-Fabric\Consumption Central - Cowork WorkIQ Studio GHCP.pbip
```

Every query reads `Sql.Database(FabricSQLEndpoint, LakehouseName)`; no CSV path remains. Verified:
27 tables, 284 measures, 14 pages, opens clean in Desktop.

What changed from the CSV project, if it ever needs redoing:

1. `DataFolder` / `DataFiles` / `GetDataFile` replaced by `FabricSQLEndpoint`, `LakehouseName`,
   `FabricSource` and `GetTable`. `GetTable` wraps the read in `try ... otherwise null` so an absent
   table degrades rather than errors — a missing Lakehouse table *raises*, unlike a missing CSV,
   which returns null.
2. Ten partitions rewritten against the contract in
   [`2. Fabric/docs/DATA-DICTIONARY.md`](../2.%20Fabric/docs/DATA-DICTIONARY.md).
3. `CommercialTerms` and `TermOrDefault` added: an optional one-row `commercial_terms` table
   overrides the commercial parameters per column. Fabric-only — the CSV template has no equivalent.
4. `studio_agent` and `studio_user` filter to the **latest `snapshot_month`**. Those exports are
   month-to-date, so accumulated snapshots must not be summed. The CSV path never had this problem
   because it only ever sees one export.

To export the `.pbit`:

1. Open `ConsumptionCentral-Fabric\...pbip`, confirm `FabricSQLEndpoint` and `LakehouseName` hold shipping
   placeholders (`your-endpoint.datawarehouse.fabric.microsoft.com`, `consumption-central`).
2. **File → Export → Power BI template**, same description as above but pointing at a Lakehouse.
3. Save as `2. Fabric\Consumption Central - Fabric.pbit`.

> Desktop refuses to refresh without a real Lakehouse, and that is fine — a template export does not
> need loaded data. If you *do* want to validate against real tables first, the sample CSVs in
> `1. Local CSV/sample-data/` match the contract and can be uploaded to a Lakehouse's landing folder
> and run through the ingesters.

### Three traps, all of which cost a load cycle here

**Never write TMDL with Python's `utf-8-sig`.** It writes a BOM as well as tolerating one, and
Desktop refuses the whole project: *"Only text with UTF8 encoding without BOM is supported."* It
names only the first offending file, so a scripted rewrite that touched seven produces seven
failures one at a time. `check_tmdl_indent.py` now fails on any BOM under the project root.

**Watch for a trailing comma before `in`.** A rewrite that drops the last `let` step leaves its
comma behind. Brackets still balance and `let`/`in` still match, so every structural check passes
and only Desktop objects. `check_m_syntax.py` now catches it.

**A blank value in an `isKey` column invalidates the entire table.** `Agent Bridge` and
`Studio Environment` are `DISTINCT(UNION(...))` over the Studio facts with the result marked
`isKey`, and a key may not be blank. PPAC leaves `agent_name` and `environment_name` blank for
Power Automate flows — 419 of 448 rows in the sample data — so one blank put both tables into an
invalid state and every visual touching them failed with *"depends on a column that is not in a
valid state"*. Both now filter blanks out of the bridge. The rows stay in the facts and in every
total; they were never selectable in a slicer anyway. This affected **both** templates, since they
read the same exports.

**Keep these as two separate templates.** A single template that branches on a `SourceMode` parameter
is tempting and does not work reliably: Power Query registers every data source in an `if/then/else`
at *parse* time rather than runtime, so the firewall sees the CSV and SQL sources as being combined
in one partition and throws
`Formula.Firewall: ... privacy levels which cannot be used together`. Two files, no branch.

## Editing the report layer of a shipped `.pbit`

A `.pbit` carries a `SecurityBindings` part that signs the report layer, so **a hand-edited report
part is always rejected** — Desktop shows *"This file is corrupted or was created by an unrecognized
version of Power BI Desktop"* and nothing more. Model-only edits (`DataModelSchema`,
`UnappliedChanges`) are not signed and patch fine; that is why `check_model_only.py` exists.

To change anything in the report, round-trip through PBIP so Desktop re-signs on export:

1. `python docs/scripts/pbit_to_pbip.py "3. Viva Direct/Consumption Central - Viva Direct.pbit" --out C:\pbip`
2. Patch the plain PBIR JSON under `C:\pbip\<template>\...Report\`.
3. Open the `.pbip` in Desktop, then **File → Export → Power BI template** back over the repo copy.
4. `python docs/scripts/fix_pbit_defaults.py` — see below.
5. Re-run the checks.

> **Generate the project under a short root such as `C:\pbip`.** Desktop is not long-path aware: past
> 259 characters it reports `Cannot read '<path>'. ... has not been found.` and opens a blank
> *Untitled* window, which is indistinguishable from a corrupt file until you read the Frown log.

### A re-export always nulls the parameters

Exporting from a project with no data cache writes every parameter as `null` — issue
[#6](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/issues/6) all over again.
Desktop also drops the comment blocks stored as a query `description` and trims trailing blank lines
from M. `fix_pbit_defaults.py` repairs all of it, taking the values from the committed template, and
refuses to overwrite any parameter that is not null:

```
python docs/scripts/fix_pbit_defaults.py --dry-run
python docs/scripts/fix_pbit_defaults.py
```

It is a model-only patch, so the freshly signed report layer is left untouched.

### Keep `docs/scripts/*_query_org/` in step with the templates

`fix_viva_query_org.py` repairs the org queries by *replacing* them with the `.m` files under
`docs/scripts/fabric_query_org/` and `docs/scripts/viva_query_org/`. Those files are the intended
state of the query, not a record of it — so anything that edits an org query through a PBIP
round-trip and stops there leaves the `.m` behind, and the next run of the patcher silently reverts
the work. It has happened twice: the ServiceName labelling in
[#27](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/pull/27) and the
`VivaOrgFromPeople` rewrite both shipped in the `.pbit` while the replacement source still held the
older body.

After changing any query named in a `PROFILES` entry, copy the new body back over its `.m` and
confirm every replacement matches its template exactly:

```
python -B docs/scripts/check_viva_query_org.py
```

The patcher compares byte for byte, so a stray trailing newline is enough to fail the anchor with
*unsupported source for &lt;query&gt;*.

### Model-layer repairs

These patch `DataModelSchema` and `UnappliedChanges` in place, so they need no PBIP round-trip. All
take `--dry-run` and all are idempotent:

| Script | Repairs |
|---|---|
| `fix_org_upn_case.py` | Folds the `Org` key to lower case. `Table.Distinct`, `Table.NestedJoin` and `Record.FromList` all compare case-sensitively while the DAX relationship does not, so a tenant whose directory says `AlexW@x` and whose Viva export says `alexw@x` got two `Org` rows for one person and the refresh died on the duplicate key. Only bites when two sources are present at once. |
| `fix_query_body_drift.py` | Resettles the `UnappliedChanges` copy of a query on the schema copy. A Desktop re-export trims trailing blank lines from one and not the other; it refuses to touch anything that differs by more than that. |

`fix_credits_guide_text.py` is *not* one of these. It edits textboxes, so it is a report-layer change
and runs against a PBIP project, then comes back through step 3 above:

```
python docs/scripts/pbit_to_pbip.py "<template>.pbit" --out C:\pbip
python docs/scripts/fix_credits_guide_text.py --pbip C:\pbip
```

## Before you ship either one

- [ ] Open the exported `.pbit` fresh — it should prompt for parameters before touching any data
- [ ] Point it at `sample-data\` and confirm all 14 pages render
- [ ] Check no parameter default contains a real customer path, endpoint or rate
- [ ] Confirm the model has no cached data: templates carry structure only, never rows

## Checks worth running first

The validators used while building this live in the session workspace. They catch, in about a second
each, several classes of problem that otherwise cost a two-and-a-half-minute failed Desktop load:

| Script | Catches |
|---|---|
| `check_m_syntax.py` | Unbalanced brackets, `let`/`in` mismatch, bare `try`, unquoted identifiers like `[@upn]` |
| `check_tmdl_indent.py` | TMDL indentation damage — a `///` block at the wrong depth stops the whole model loading |
| `validate_model.py` | Duplicate measures, DAX reserved words used as VAR names, dangling references |
| `validate_schema.py` | Malformed `visual.json` |
| `validate_layout.py` | Overlapping or off-canvas visuals |
| `validate_narrative.py` | Narrative measures referencing something that no longer exists |
| `audit_template_safety.py` | Hardcoded figures, dates or interpretations in any card or title |

That last one matters most for a template. Run it before every release: a headline that says "usage
grew 19.8% over the last 13 weeks" is simply false for the next customer unless both numbers are
computed from their data.
