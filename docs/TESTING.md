# What we can test now

Three things are worth verifying before this goes public. Two you can do tonight; one needs a
GitHub PAT.

Record results in the tables and open an issue — including the negative results, which are just as
useful.

---

## Test 1 — Does the Viva connector work in your tenant? *(10 min)*

**The big one.** The connection is confirmed to exist — Viva Insights publishes a Partition and
Query identifier for exactly this. What is unproven is whether a given tenant can use it: our first
attempt returned **access forbidden**, which looks like the Analyst role or connector access rather
than anything in the connection itself.

Full procedure: **[3. Viva Direct/TEST-PROCEDURE.md](../3.%20Viva%20Direct/TEST-PROCEDURE.md)**

The short version:

1. <https://analysis.insights.cloud.microsoft> → **Analysis** → build a query with the Copilot credit
   metrics → **Analysis results** → your query → the **link icon** → copy both identifiers
2. Power BI Desktop → **Get Data** → **Online Services** → **Viva Insights**
3. Paste both. Leave **Query Name** blank. Advanced: **Pivoted** + **Row-level data**,
   connectivity **Import**
4. **Stop at the Navigator preview and read the column list.** Do not load yet.

| You see | Verdict |
|---|---|
| `ServiceName`, `SpendingPolicyId`, `MetricDate`, a credits column | ✅ It works |
| Access forbidden | ⚠️ Permission — check the Analyst role, then retry |
| Only `Meeting_hours`, `Email_hours`, `Focus_hours` | ❌ Wrong query — you have connected to an Analyst Workbench result |

If it works, load it and check the grain — `rows` should be roughly `people × dates`. If `rows`
equals `people`, the Advanced settings didn't take and you have an aggregate.

Also worth noting: **how far back does it go?** The file export gives five complete months plus
month-to-date. If the connector reaches further, that weakens the case for the Fabric path
considerably.

**A model is already wired for this** at `ConsumptionCentral-VivaDirect` — two parameters, `VivaPartitionId`
and `VivaQueryId`. Once access is sorted, paste and refresh.

---

## Test 2 — Does the GitHub AI-credit API work in your enterprise? *(15 min)*

This source can run unattended, as can Azure collection and the Viva connector. Confirm
its tenant-specific behavior before building a pipeline on it.

### Get a token

GitHub → **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)**

> ⚠️ **Classic, not fine-grained.** The billing endpoints reject fine-grained tokens.

Scope: **`manage_billing:copilot`** or **`read:enterprise`**. You need to be an enterprise admin or
billing manager.

### Run the checks

Replace `YOUR-ENTERPRISE` and `YOUR_TOKEN`, then run in PowerShell:

```powershell
$ent = "YOUR-ENTERPRISE"
$h = @{ Authorization = "Bearer YOUR_TOKEN"
        Accept        = "application/vnd.github+json"
        "X-GitHub-Api-Version" = "2022-11-28" }

# 1 - can we see seats?
$seats = Invoke-RestMethod "https://api.github.com/enterprises/$ent/copilot/billing/seats?per_page=100" -Headers $h
"seats visible : $($seats.total_seats)"

# 2 - does the AI credit endpoint exist and answer?
$now = Get-Date
$u = Invoke-RestMethod ("https://api.github.com/enterprises/$ent/settings/billing/ai_credit/usage" +
                        "?year=$($now.Year)&month=$($now.Month)") -Headers $h
"usage items   : $($u.usageItems.Count)"
$u.usageItems | Select-Object -First 5 product, sku, model, grossAmount, discountAmount, netAmount | Format-Table

# 3 - does the per-user filter work? (this is the one the pipeline depends on)
$who = $seats.seats[0].assignee.login
$pu = Invoke-RestMethod ("https://api.github.com/enterprises/$ent/settings/billing/ai_credit/usage" +
                         "?user=$who&year=$($now.Year)&month=$($now.Month)") -Headers $h
"rows for $who : $($pu.usageItems.Count)"

# 4 - how far back does it really go?
$old = $now.AddMonths(-23)
try {
  $h24 = Invoke-RestMethod ("https://api.github.com/enterprises/$ent/settings/billing/ai_credit/usage" +
                            "?year=$($old.Year)&month=$($old.Month)") -Headers $h
  "23 months back: $($h24.usageItems.Count) items"
} catch { "23 months back: $($_.Exception.Response.StatusCode.value__)" }
```

| Check | Expected | Yours |
|---|---|---|
| Seats visible | a number > 0 | |
| AI credit endpoint answers | 200, items returned | |
| **`model` present on items** | e.g. `claude-sonnet-4` | |
| **Per-user filter works** | returns that user's rows | |
| 24-month history | items or an empty 200, not 404 | |

**If check 3 fails**, the per-user loop in `Ingest_GitHub_API.ipynb` won't work and the notebook
needs rethinking — please say so.

### Then the notebook

Import `2. Fabric/notebooks/Ingest_GitHub_API.ipynb`, put the PAT in Key Vault, set `ENTERPRISE`,
and run with `BACKFILL_MONTHS = 1` first. Check the summary cell at the end: `net_billable` should be
well below `gross` if the pooled allowance is absorbing most consumption, which is the normal state.

---

## Test 3 — Does the template still build? *(10 min)*

Before anything ships, produce the `.pbit` and open it clean.

Steps: **[docs/BUILD.md](BUILD.md)**

---

## Azure automation acceptance

The saved PBIT readers accept the canonical spend/metrics output schemas on all three paths.
Offline code/schema checks do not prove that Azure permissions, available metrics, Fabric
execution identity, SQL synchronization or gateway refresh work in a particular tenant.

From the repository root, run the offline checks before tenant acceptance:

```powershell
python ".\docs\scripts\check_azure_template_contract.py"
python ".\docs\scripts\test_azure_notebook_requests.py"
python ".\1. Local CSV\test_pull_azure_ai.py"
```

1. Start with one subscription and a short window of complete UTC days. Run under the
   intended scheduled identity, not just your interactive account. Verify subscription,
   billing charge visibility, resource inventory, tags and deployment-read permissions.
2. Confirm collection exits successfully and both outputs have the documented headers/types.
   For Fabric, verify `dbo.azure_ai_spend` and `dbo.azure_ai_tokens` are readable through the
   SQL analytics endpoint; notebook success alone is insufficient for first-time readiness.
3. Compare spend with Azure Cost Analysis for exactly the same dates, **ActualCost** basis,
   service filter and currency. Record differences caused by billing latency or adjustments.
   Do not compare the Foundry card with all-service spend: it filters to `Foundry Models`.
4. Use a deployment with known activity and compare daily input/output/request counters and
   average utilisation with Azure Monitor. Check one equivalent metric family, not both
   current and legacy aliases. Verify deployment names where supported and preserve real
   zero utilisation. Missing telemetry must remain missing.
5. Inspect billing units before using `[Foundry Tokens (M)]` or cost-per-million. Do not use
   those figures with provisioned-hour quantities, mixed units or mixed currencies.
   `[Total Tokens]` requires the model's input/output metric families; a standalone
   `TotalTokens` row does not populate it.
6. Refresh each template you intend to deploy. Local CSV and Viva Direct need `DataFolder`;
   Service refresh also needs gateway filesystem access. Fabric needs its SQL endpoint,
   Lakehouse database and appropriate credentials. Confirm values, dates and currency in
   the report rather than treating the absence of an error as success.
7. In an isolated test output folder/Lakehouse, simulate denied access or a failed API call.
   Require a failed collection and blocked downstream refresh, not a successful empty/stale
   report. Then test a genuinely successful empty collection so prior rows do not linger.
8. Test a second run, retained zeros, schedule identity and output freshness. Avoid overlapping
   writers and refresh during publication. After a partial batch write, rerun the whole
   collection before refreshing. Record the scheduled run and Service refresh outcomes.

The current automation does not populate whole-solution spend, expanded deployment-health,
or billing-reconciliation prototype feeds. The deployment inventory CSV is not a shipped
template input. No template rebuild is needed solely to read the canonical existing outputs.

The part that matters most:

- [ ] Reset `DataFolder` to the neutral placeholder `C:\Consumption Central\Data`
- [ ] Reset the six commercial parameters — `0.01`, `0.008`, `0`, `19`, `39`, `4`
- [ ] Check the Settings query still holds `#date(2026, 9, 1)`, `1900`, `3900`
- [ ] **File → Export → Power BI template**
- [ ] Open the exported `.pbit` fresh, point `DataFolder` at `sample-data/`, confirm every report page renders
- [ ] Then hide everything except `PersonServiceCreditsMetrics.csv` and refresh again — Cowork should
      still be right and the other pages should be empty rather than broken

**A `.pbit` stores parameter defaults.** If `DataFolder` still points at your OneDrive, or the rates
are a customer's real ones, that ships with the file. This is the step to be careful about.

---

## Cowork task verification

Offline checks run without cloud access:

```powershell
python docs\scripts\test_cowork_tasks.py
python docs\scripts\test_fabric_ingestion.py
```

They execute the actual Python task normalizer, check notebook synchronization, verify optional
Dataverse schema extraction, and apply model changes in memory while preserving legacy definitions.
They **do not execute Power Query, DAX or a native SQL/Dataverse connector**.

For actual Power Query execution, expand a separate Local CSV test project and run
`docs\scripts\cowork_tasks\prepare_validation.py <test.pbip>`. Refresh it in Desktop: every row in
`Cowork Task Regression` must pass, and the task page must agree with the
[independent synthetic totals](../1.%20Local%20CSV/sample-data/cowork-tasks/README.md).
This project uses only synthetic data and must not be exported as a deliverable.
The query forces every `Passed` value before returning its table: false, null or error values
must fail the query, rather than loading an assertion error as a blank Boolean cell.

The preparation step includes 30 normalizer checks and 11 compatibility checks using the actual
legacy lookup and generated dimension/calendar queries. These cover relocated/standalone legacy
metadata, task companion isolation, case-only people labels, mixed-weekday all-history coverage,
empty calendars and simulated folder permission denial.

Use `--with-file-cases` to add nine native file-adapter assertions (50 checks in total).
The preparation step creates new synthetic folders beside the project and embeds the actual
`FileInput.m` adapter, covering absent, zero-byte, header-only, partial, malformed, task-only,
combined and unavailable-folder inputs. Existing fixture folders are never overwritten.
For a full-project refresh and rendered-page check, prepare a **new, closed** project with
`--case legacy-only`, `task-only`, `zero-byte`, `header-only`, `partial` or `malformed`.
The selected case becomes that project's DataFolder; these runs also include the file assertions.
The `malformed` project must visibly fail its task refresh with `CoworkTasks.InvalidExport`.
A passing assertion that catches an expected error does not replace that full-refresh failure check.

| Required case | Model/refresh acceptance | Page acceptance |
|---|---|---|
| Representative new export, kept private | Counts/credits match source; historical join does not fan out; no legacy facts fabricated | Category/type/week filters work; estimates visibly provisional |
| Synthetic task-only export | 10 tasks, 38 credits, 70% valuation coverage; expected three scenario results | Cards, category share, weekly trend and matrix agree |
| Legacy identified or de-identified export without task data | Existing totals/filters unchanged; refresh succeeds | `Task categories not supplied`; task numbers blank |
| Legacy and task exports in separate subfolders | Each uses its own metadata; no cross-fact addition | Independent periods and organizations |
| Absent, zero-byte, header-only or empty optional table | Typed empty fact; no required new file | Correct absent versus supplied-empty message |
| Missing credits, category, type or metadata | Counts retained; null credits not zero; no dropped rows | Coverage note, `Not supplied`, blank unsafe ratios/cost |
| Unknown/future category and measured zeros | Observations retained; unmapped estimate blank; zero denominator safe | Unmapped categories visible; zero not confused with absence |
| Filtered empty selection | All numeric task measures blank | `No tasks match these filters` |
| Invalid date/count/credits/licence; conflicting task or metadata key | Sanitized actionable error, no silent fallback | Refresh failure visible, not an empty-data success |
| Inaccessible optional task folder | Viva connector-only refresh still succeeds; task numbers blank | `Task folder unavailable; check DataFolder and folder access.` |
| Unreadable discovered task/companion file or connector auth/transport failure | Genuine failure surfaces | No misleading “not supplied” state |
| Re-import/backfill in Fabric | Same natural keys upsert; no duplicate task credits | Historical task totals unchanged by repeat imports |
| Fresh exported PBIT for all four variants | Opens, refreshes, neutral defaults, no cache or test table | Every page/navigation works; Typical selected; no numeric hourly value selected |
| Hourly single-select | `(Blank)` keeps monetary estimate blank; explicit zero means zero; one numeric rate at a time | First load is blank; changing rate replaces it, returning to `(Blank)` removes the estimate |
| Mixed weekdays and case-only task people labels | All history includes every row; one people dimension row per normalized key | No duplicate-key refresh failure or lost earliest week |

Native Fabric and Dataverse refresh requires an authorized read-only endpoint. Synthetic navigation
tests or model-file checks are useful but must not be reported as connector validation. Record any
unavailable native acceptance gate explicitly; do not mark an artifact fully verified on that basis.

### Task-category implementation verification record

The following evidence was collected on 19 October 2026. This records completed checks, not a
claim that every acceptance gate above passed.

| Check | Observed result |
|---|---|
| Native combined synthetic refresh | Task totals, all three effort scenarios, explicit hourly-value selection, task filters and existing Cowork / Work IQ totals agreed with independent expectations |
| Native legacy-only refresh | Existing billing totals remained unchanged; Tasks displayed `Task categories not supplied` with blank numeric results |
| Native Power Query assertions | All 35 normalizer and file-adapter assertions passed, including missing, empty, partial, malformed and unavailable-folder cases |
| Fresh exported Local CSV PBIT | Combined and task-only inputs loaded successfully; task-only showed 10 tasks, 38 credits and 70% valuation coverage without creating legacy billing facts |
| Page appearance and order | Tasks rendered immediately after Cowork Cost, using the incumbent Cowork visual treatment; Typical selected and hourly value unselected |
| Four rebuilt template packages | Data-free, neutral defaults, task contracts, strict model/staged-query agreement and lineage checks passed; legacy measure expressions, partitions and column bindings were preserved |
| Fabric and Viva export construction | Dedicated offline copies applied and exported in Desktop; real connector expressions were restored in both model parts without modifying the native report/security parts |
| Dataverse construction | Derived from the rebuilt Fabric export; generated schema and flow-package contracts passed |
| Offline regression suites | 162 repository tests completed successfully with one skipped; 56 local Azure collector tests passed |
| PBIR validator | Converter projects retained 98 existing errors and 28 warnings; comparison with the untouched baseline found no new diagnostics, so this is not a clean-validator claim |
| Private representative input | Native refresh completed and Tasks populated. All five displayed last-four-week metrics matched independent source calculations: task count, credits, credits/task, expert-equivalent hours and valuation coverage. Unique task and historical metadata keys were checked locally. Exact all-history native aggregate comparison remains pending |
| Full-project partial input | Final Local CSV PBIT loaded two synthetic tasks with `Not supplied` dimensions; missing credits, ratios, costs and estimates remained blank, with explicit coverage disclosure |
| Full-project supplied-empty inputs | Header-only and zero-byte inputs rendered `Task export contains no rows` with blank task metrics and retained legacy billing. Zero-byte Apply completed with the pending-query banner cleared |
| Full-project malformed input | Native Apply visibly failed with `Expected a nonnegative finite number` for the deliberately invalid credits value; the error was not swallowed as missing data. A valid private input subsequently refreshed successfully |
| Fresh Fabric, Dataverse and Viva native acceptance | All reached their native parameter dialogs with neutral defaults. This is opening/default evidence, not a successful model refresh. Viva requires real partition/query IDs; no live Fabric, Dataverse or Viva endpoint refresh was performed |

Desktop-control timeouts prevented the exact all-history native aggregate comparison. The
review handoff explicitly retains that check and the separately authorized live endpoint refreshes
as outstanding; this is not a claim of complete native acceptance across every variant.
No private input, private verification results or populated model cache is included in the
shipped templates.

### Compatibility follow-up verification record

The nine review follow-ups were checked on 19-21 October 2026. This record is
separate from the initial implementation evidence above.

| Check | Observed result |
|---|---|
| Native template construction | All four variants, including Dataverse, were independently exported from their dedicated offline projects in Desktop. Local CSV was exported on 20 October; Fabric, Viva Direct and Dataverse on 21 October |
| Source/default restoration | Each native original was preserved. Its own matching reference restored only `DataModelSchema` and `UnappliedChanges`; every other package member, including Report and SecurityBindings, remained byte-identical to that native export |
| Final shipped packages | All four Cowork contracts and documented defaults passed. ZIP integrity, absence of cached DataModel/test tables/offline markers/build paths, Azure contracts and lineage checks passed |
| Native compatibility assertions | My Copilot's read-only native run on 19 October reported 50 assertions, `Failures = BLANK` (zero matching rows), and no rows from a separate failing-row query. The tested implementation and synthetic fixtures were unchanged; this run was retained as attributed evidence, not rerun |
| Native Apply/save | The synthetic regression project and Local CSV offline export project were independently observed applying and saving successfully on 20 October, with their pending-query banners cleared |
| Fresh final cloud templates | Fabric, Viva Direct and Dataverse each reached their native parameter dialog with neutral defaults in distinct instances on 21 October. Each was canceled without loading or connecting to an endpoint |
| Fresh final Local CSV template | The neutral parameter dialog opened, then the combined synthetic fixture completed refresh and loaded the report. This populated validation instance was not saved over a deliverable |
| Hourly interaction gate | The previously observed synthetic default `(Blank)`/blank-money state is retained. Numeric replacement, explicit zero and return-to-Blank interaction checks remain pending: native page-navigation clicks had no observable effect, screenshot fallback timed out, and the keyboard fallback rejected a stale target. UI activity was paused for a bounded manual check |
| Offline regression suites | 166 repository tests completed successfully with one skipped; 56 local Azure collector tests passed. The Dataverse schema check was up to date, eight notebooks parsed, and 157 internal documentation links resolved |
| PBIR validator comparison | Updated converter output retained 98 existing errors and 28 warnings versus 98 errors and 29 warnings in the untouched baseline; no new diagnostics, not a clean-validator claim |

Only synthetic inputs were used for this follow-up. Live Fabric, Dataverse and Viva
connector refreshes require separate authorization and were not run. The exact
all-history aggregate comparison remains out of scope; earlier private-input
evidence above was not rerun or copied into the deliverables. The hourly interaction
gate must be completed before the review-ready handoff.

## Things we know we cannot test here

| | Why |
|---|---|
| The Consumption Dashboard export click-path | Needs a tenant with the preview enabled; Microsoft has published no doc page |
| The VFAM control for identifiable export | Not documented; needs someone with admin access to look |
| Where the Studio CSVs download from | Confirmed CSV-only, but the exact button is undocumented |

All three are marked ⚠️ in [DATA-SOURCES.md](DATA-SOURCES.md). If you find any of them while
clicking around, that is a one-line PR that saves the next person an afternoon.

---

## After the tests

| Result | Do |
|---|---|
| Viva connector works | Build the path-3 `.pbit`, rewrite that README as instructions |
| Viva connector doesn't | Delete the folder, note it in the root README so nobody retries |
| GitHub API works | Mark the notebook verified; it becomes the recommended GitHub route |
| GitHub API doesn't | Fall back to the CSV ingester, document why |
| Template builds clean | Flip the repo public |
