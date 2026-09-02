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

This is the one source that can run unattended, so it is worth confirming before anyone builds a
pipeline on it.

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

The part that matters most:

- [ ] Reset `DataFolder` to the neutral placeholder `C:\Consumption Central\Data`
- [ ] Reset the six commercial parameters — `0.01`, `0.008`, `0`, `19`, `39`, `4`
- [ ] Check the Settings query still holds `#date(2026, 9, 1)`, `1900`, `3900`
- [ ] **File → Export → Power BI template**
- [ ] Open the exported `.pbit` fresh, point `DataFolder` at `sample-data/`, confirm all 14 pages render
- [ ] Then hide everything except `PersonServiceCreditsMetrics.csv` and refresh again — Cowork should
      still be right and the other pages should be empty rather than broken

**A `.pbit` stores parameter defaults.** If `DataFolder` still points at your OneDrive, or the rates
are a customer's real ones, that ships with the file. This is the step to be careful about.

---

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
