# Data sources

Everything Consumption Central reads, where it comes from, and what it looks like.

> **You don't need all of it.** Every source below is optional. Bring one product and its pages
> work; the rest come up empty. Skip to the section for whatever you have.

Each section gives the click-path, the role required, the file it produces and its columns. Where
Microsoft or GitHub has published a schema, it is cited. Where they have not, the columns are the
ones observed in a real export and are marked as such — check yours matches before you trust it.

**Verification status is marked throughout.** A plausible-but-wrong click path wastes more of your
time than an honest "check the portal", so anything unconfirmed says so.

## Which sources automate

The single question most people arrive with. Answered once, here:

| Source | Automated route | Still needs a download? |
|---|---|---|
| [Cowork / Work IQ](#1-cowork--work-iq-credits--viva-insights-consumption-dashboard) | Certified Power Query connector — direct on Power BI, Dataflow Gen2 on Fabric | **No** |
| [GitHub Copilot](#3-github-copilot-ai-credits) | REST API | **No** |
| [Entra org attributes](#5-org-attributes--microsoft-entra-optional) | Graph PowerShell on a schedule | **No** |
| [Copilot Studio](#2-copilot-studio-credits) | None — PPAC is download-only | **Yes** |
| [Azure AI Foundry](#4-azure-ai-foundry) | None at the grain used here — see that section | **Yes** |

For the two that need a download, a [Power Automate flow](../2.%20Fabric/flows/) can at least land
the file in the right place for you.

---

## 1. Cowork / Work IQ credits — Viva Insights Consumption Dashboard

The main source. Person × week credit consumption for the usage-based-billing Copilot services.

### Where

| | |
|---|---|
| **Portal** | <https://analysis.insights.cloud.microsoft> |
| **Path** | Insights web app → **Consumption Dashboard** (left nav) → the **download** icon, top right |
| **Role** | Global Administrator, **or** Viva Insights Analyst with global partition access |
| **Licence** | 50+ assigned Viva Insights licences, or 1+ Copilot licence including the Viva Insights service plan |

The export dialog offers **Export by week** or **Export by day**, and then two ways to take the data:

| Button | What it does |
|---|---|
| **Export to CSV** | Downloads a ZIP. This is what path [1](../1.%20Local%20CSV/) uses, and it is the fallback on path [2](../2.%20Fabric/). |
| **Connect data** | Gives a **Partition identifier** and **Query identifier** for a live connection, under either a **Power BI** or a **Microsoft Fabric** tab. Power BI → [path 3](../3.%20Viva%20Direct/); Fabric → a [Dataflow Gen2](../2.%20Fabric/README.md#the-viva-half-needs-no-notebook), which is the **preferred** route on the Fabric path. |

A banner in the dialog says **"Includes user identifiers"** when identifiable export is enabled for
you. That is the quickest way to tell which shape you are about to get.

> The Consumption Dashboard is a preview feature and Microsoft has not yet published a dedicated
> page for its export. The steps above are from the live portal (checked 2026-08-04). The related
> Fabric route is documented at [export-query-data-microsoft-fabric][s1f].

### Identified vs de-identified

This matters, and it changes which files you get.

| Variant | Person column | Extra files |
|---|---|---|
| **Identified** | Real `UserPrincipalName` + `EntraId` | — |
| **De-identified** | Anonymised `PersonId` | `PeopleMetaData.csv`, `PersonPolicyMap.csv` |

De-identified is the **default**. Turning identification on is a **Global Administrator or AI
Administrator** job — either role can do every step ([identification-copilot-analytics][s1g]):

**Microsoft 365 admin center → Settings → Org settings → Viva feature access → Viva Insights**

Create or edit a policy with:

| Field | Value |
|---|---|
| App | **Viva Insights** |
| Feature | **Identifiable Export** |
| Access setting | **On** |
| Applies to | Everyone, or a named group |

Scoping limits: **20 users or groups per policy**, **10 policies per feature**, or one tenant-wide
policy. PowerShell works too — `Add-VivaModuleFeaturePolicy` writes to the same store, so a policy
made either way is visible in both.

*(Documented at [identification-copilot-analytics][s1g], updated 2026-08-03. An earlier version of
this page said the click-path was undocumented and that it required Global Admin — both were wrong.
AI Administrator is sufficient, which is a much smaller ask.)*

**Identifiable export is a public preview that processes personal data.** Read the "Previews" section
of the Data Protection Addendum, and check whether per-person reporting needs works-council consent
in your jurisdiction, before you turn it on. Note also that the **Power BI connector does not enforce
Viva's minimum group size** — if you rely on that threshold, you have to apply it in the report
yourself. Identification is **not available in GCC-High or DoD**. End-user opt-out does *not* apply
to Copilot usage data, which stays at row level either way.

Allow **up to 24 hours** for the policy to take effect, then re-export. Existing exports are not
re-keyed retrospectively — only runs after the policy is live carry the identifiable fields.

### What de-identified actually costs you

**Consumption Central reads both shapes without complaint**, so nothing breaks and no figure is
wrong. But de-identified data cannot be joined to anything keyed on a person, and that is most of
the cross-product value:

| | De-identified | Identified |
|---|---|---|
| Cowork / Work IQ credits and cost | ✅ | ✅ |
| Spending-policy limits and budget pages | ✅ | ✅ |
| **One person's spend across Cowork + Studio + GitHub** | ❌ | ✅ |
| **Department, job title, city, manager breakdowns** | ❌ | ✅ |
| **All Products page as a per-person view** | ❌ | ✅ |

The reason is simply that there is no shared key: Studio arrives keyed on `User_Email`, GitHub on
`Username` (bridged to UPN by `GitHubUserMap.csv`), and your Entra export on `userPrincipalName` —
while a de-identified Viva export carries only a hash.

On the CSV path a de-identified export ships `PersonPolicyMap.csv`, which carries `PersonId`,
`PeopleHistoricalId` **and** `userPrincipalName` on the same row. **Include that file and the join
works** — it is the one bridge that resolves the hash. Without it, Cowork stands alone.

### Grain and history

| Export | Grain | Covers | Freshness |
|---|---|---|---|
| **Weekly** | Week | Previous **5 complete months** plus month-to-date | Activity 2–8 days before export |
| **Daily** | Day | Start of the previous month to the export date | Activity up to 2 days before |

Use **weekly** for Consumption Central. Every Cowork page is built on weekly grain, and the forecast fits its
trend across whatever weeks you load.

There is **no scheduled CSV export and no REST API** — each CSV run is a point-in-time download. But
there *is* a certified **Power Query connector**, so Viva consumption **can** be automated:

- **Power BI** — connect direct from Desktop, refresh on a schedule.
  See [3. Viva Direct](../3.%20Viva%20Direct/).
  ([Learn][pbiconn])
- **Fabric** — a Dataflow Gen2 writes query results straight into a Lakehouse table on a schedule.
  See [The Viva half needs no notebook](../2.%20Fabric/README.md#the-viva-half-needs-no-notebook).
  ([Learn][fabconn])

Either way, **auto-refresh must also be enabled on the query itself** in Viva Insights → Analysis
results. Miss that and the report refreshes happily against a result that never changes.

The distinction that matters: there is no endpoint you can `curl`, but there is a supported
connector, and it removes the download entirely. Nobody needs to remember to press export for Viva.

Accumulating history beyond the 6-month window is still the best reason to move to the
[Fabric path](../2.%20Fabric/) — the connector reaches only as far back as the export does.

[pbiconn]: https://learn.microsoft.com/en-us/viva/insights/advanced/analyst/power-bi-connector
[fabconn]: https://learn.microsoft.com/en-us/viva/insights/advanced/analyst/export-query-data-microsoft-fabric

### Files and columns

The ZIP is named like `ConsumptionDashboard-Weekly-Identified_Aug04_2026_1859Hours.zip`.

**`PersonServiceCreditsMetrics.csv`** — one row per person × service × policy × week.

| Column | Identified | De-identified | Notes |
|---|---|---|---|
| `UserPrincipalName` | ✅ | — | Real UPN |
| `EntraId` | ✅ | — | Entra object ID |
| `PersonId` | — | ✅ | Anonymised, stable across exports |
| `PeopleHistoricalId` | — | ✅ | Joins to `PeopleMetaData.csv` |
| `ServiceId` | ✅ | ✅ | |
| `ServiceName` | ✅ | ✅ | `Cowork` or `Work IQ API` |
| `SpendingPolicyId` | ✅ | ✅ | All-zero GUID = usage outside any policy |
| `MetricDate` | ✅ | ✅ | Week start |
| `Session count` | ✅ | ✅ | |
| `Spending policy limit` | ✅ | ✅ | The policy's monthly pool |
| `Total Copilot Credits used` | ✅ | ✅ | |
| `User limit` | ✅ | ✅ | Per-person cap, if the policy sets one |

**`SpendingPolicyMetadata.csv`** — one row per policy.

| Column | Notes |
|---|---|
| `SpendingPolicyId` | |
| `Name` | Blank on the all-zero GUID row; Consumption Central renders that as "(Unassigned)" |
| `PlanLimit` | Total monthly credit budget for the whole policy |
| `UserLimit` | Optional per-user cap within it |
| `IncludedServices` | e.g. `Cowork;WorkIQ` |

> ⚠️ **No official column-level schema published.** The above is from real exports. If your file
> differs, Consumption Central matches column names case-insensitively and ignoring spaces, dashes and
> underscores, so minor naming changes are absorbed automatically. A genuinely new column is ignored.

### Spending policies

Configured in **M365 admin center → Copilot → Cost Management → Configuration**.

- **PlanLimit** — the monthly credit budget for everyone on the policy. Exhaust it and the whole
  policy loses access for the rest of the billing month, unless additional usage is allowed.
- **UserLimit** — an optional per-person cap, so one heavy user cannot drain the shared pool.

Roles: **Global** or **Billing Administrator** to set billing methods; **AI** or **License
Administrator** to create policies and limits but *not* change the billing method.
([usage-based-billing-manage-copilot-credits][s1c], updated 2026-07-30)

### What "Cowork" is

Cowork is the agentic service inside Microsoft 365 Copilot that carries out multi-step tasks —
sending mail, scheduling, drafting, deep research, scheduled automations.
([cowork][s1d], updated 2026-07-27)

As of August 2026 the two services under usage-based billing are **Cowork** and **Work IQ API**
([usage-based-billing-overview][s1e], updated 2026-07-30). Microsoft has said more will follow, so
treat `ServiceName` as an open list — Consumption Central groups by whatever values it finds.

---

## 2. Copilot Studio credits

### Where

| | |
|---|---|
| **Portal** | <https://admin.powerplatform.microsoft.com> |
| **Path** | **Licensing** → **Products** → **Copilot Studio** → Summary / Environments / Agents tabs |
| **Role** | Power Platform Administrator, or Environment Admin |

([manage-copilot-studio-messages-capacity][s2a], updated 2026-08-04)

> ⚠️ **Export path not documented by Microsoft.** Microsoft documents the *page* — daily consumption
> trend up to 3 months, per-environment breakdowns, per-agent billed vs non-billable credits — but
> not a CSV export from it.
>
> **What is confirmed:** PPAC is a **CSV download** surface for this data. There is no API for the
> per-agent and per-user grain that Consumption Central uses, so this source is manual on every path,
> including Fabric. Look for a **Download** or **Export** control on each tab.
>
> If you cannot find one, skip it — the Studio pages stay empty and the other two products are
> unaffected.

### Files and columns

The exports are named `EntitlementConsumption*_MCSMessages*.csv`, sometimes with a `_30` / `_180`
day-window suffix. Consumption Central matches those names first and falls back to a looser pattern, so a
renamed file still works.

> *(Filenames confirmed against
> [StudioLens](https://github.com/Keithland89/StudioLens-for-Copilot-Studio), which reads the same
> PPAC exports for a different report.)*

| Export | File |
|---|---|
| Tenant daily | `EntitlementConsumptionTenantDetailsReport_MCSMessages*.csv` |
| Per agent | `EntitlementConsumptionTenantPerAgentDetailsReport_MCSMessages*.csv` |
| Per user | `EntitlementConsumptionTenantPerUserDetailsReport_MCSMessages*.csv` |

**Tenant daily** — tenant × environment × day.

`BillingPlan Id`, `BillingPlan Name`, `Environment Id`, `Environment Name`, `Capacity Type`,
`Entitled Quantity`, `Prepaid Consumed Quantity`, `Pay as you go Consumed Quantity`, `Usage Date`

**Per agent** — agent totals. **No date column.**

`Agent Name`, `Agent Id`, `Product`, `AI Feature/Billable Feature`, `Billed credit`,
`Non-billed credit`, `Channel`, `Knowledge Sources`, `Tool Used`, `LLM Model`, `Scenario Name`,
`Environment Id`, `Environment Name`

**Per user** — user × agent totals. **No date column.**

`User Id`, `User Email`, `Agent Id`, `Agent Name`, `Billable credit used`, `Credits used`,
`M365 Copilot Licensed`

> **On the missing dates:** the per-agent and per-user files appear to be period aggregates for the
> current month-to-date, consistent with PPAC's documented "current month-to-date, the last two full
> months" behaviour. Consumption Central therefore treats them as period totals and does **not** plot them on
> a time axis — only the tenant daily file drives Studio trends. This is why the Studio forecast
> extends a daily run rate rather than fitting a growth curve: there is not enough dated history to
> fit one honestly.
>
> The [Fabric path](../2.%20Fabric/) works around this by stamping each load with a snapshot month,
> so running it monthly builds the history the export itself does not carry.

> **Several environments, several files.** A tenant can export per environment rather than once for
> the whole tenant. Drop them all in the same folder — they are unioned, and a `source_file` column
> records which is which.

> **Watch the free-text columns.** `Knowledge Sources`, `Scenario Name` and `Agent Name` can contain
> commas or line breaks. The Fabric ingester parses with `multiLine` and quote-escaping for exactly
> this reason; anything else reading these files should do the same, or one such value will silently
> shift every column after it on that row.

---

## 3. GitHub Copilot AI credits

Fully documented by GitHub — this is the most reliable of the three.

### Where

| | |
|---|---|
| **Portal** | `https://github.com/enterprises/<slug>/settings/billing` |
| **Path** | Enterprise → **Billing &amp; Licensing** → Usage → **AI usage** → **Get usage report** |
| **Role** | Enterprise owner or billing manager (org owners can download but not view per-user in the UI) |

Choose a date range of **up to 31 days**, click **Email me the report**, and GitHub mails a download
link to your primary account email. The link is valid for **24 hours**.
([view-product-license-use][s3a])

### Columns

`date`, `product`, `sku`, `model`, `quantity`, `unit_type`, `applied_cost_per_quantity`,
`gross_amount`, `discount_amount`, `net_amount`, `username`, `organization`, `repository`,
`cost_center_name` ([billing-reports][s3b])

> ⚠️ Real exports also carry `total_monthly_quota`, `aic_quantity` and `aic_gross_amount`, which are
> **not** in the published reference. They are likely newer additions. Consumption Central reads them where
> present and does not fail when they are absent.

### API — yes, and better than expected

There **are** dedicated AI-credit endpoints, separate from the general billing usage endpoint:

```
GET /enterprises/{enterprise}/settings/billing/ai_credit/usage
GET /enterprises/{enterprise}/settings/billing/premium_request/usage
```

Organisation equivalents exist at `/organizations/{org}/settings/billing/...`.

| | |
|---|---|
| **Filters** | `year`, `month`, `day`, `organization`, `user`, `model`, `product`, `cost_center_id` |
| **History** | **24 months** — far beyond the 31-day web report |
| **Returns per item** | `product`, `sku`, `model`, `unitType`, `pricePerUnit`, `grossQuantity`, `grossAmount`, `discountQuantity`, `discountAmount`, `netQuantity`, `netAmount` |
| **Auth** | **Classic PAT only** — fine-grained PATs are *not* supported |
| **Scope** | `read:enterprise` or `manage_billing:copilot`; enterprise admin or billing manager |
| **Rate limit** | 5,000 req/hr (PAT), 15,000 (GitHub App) |

**The one structural catch:** `user` is a *request filter*, not a field on each row. The response tells
you what a user consumed but does not name them. To build a per-developer view you enumerate seats
first, then loop:

```
GET /enterprises/{e}/copilot/billing/seats           → every licensed user
GET .../ai_credit/usage?user={login}&year=Y&month=M  → once per user, tag rows with {login}
```

At 500 developers that is 500 calls a day — comfortably inside the rate limit.

**Three columns the API cannot give you:** `total_monthly_quota`, `aic_quantity` and
`aic_gross_amount` are in the CSV but not in the API schema (they are undocumented in the CSV
reference too). `repository` is also absent from the AI-credit schema. If you need those, the web
download stays necessary.

> ⚠️ **Not the Copilot Metrics API.** `/copilot/metrics/reports/*` is a different family —
> engagement and productivity, not billing. It does expose `ai_credits_used`, but GitHub documents
> that as *"for consumption analysis, not invoicing totals"*. It carries no gross/discount/net
> amounts. Don't build a cost dashboard on it.

> ⚠️ **A different limitation is often misquoted.** The billing docs say the **detailed usage
> report** is *"available only through the GitHub web interface and cannot be obtained via the REST
> API `/usage` endpoint"*. That is about the general metered-billing report and the general
> `/usage` endpoint — **not** about the AI-credit endpoints above. The AI-credit endpoints are the
> programmatic route.

There is **no way to trigger the emailed report programmatically** — no endpoint, no webhook, no
scheduled blob export. Automation means the API route, not the CSV route.

**([billing/usage reference][s3d], [automate usage reporting][s3e], checked 2026-08-04)**

### Seats and the allowance

You also need a seat list, as `GitHubUserMap.csv`:

`username`, `userPrincipalName`, `displayName`, `plan`, `included_credits`

`plan` must read `Copilot Business` or `Copilot Enterprise` — the seat-price measure keys on it.
`userPrincipalName` is what joins a GitHub user to the Entra org file, so department breakdowns
depend on it.

**Included allowances** ([usage-based-billing-for-organizations-and-enterprises][s3c]):

| Plan | Promotional (1 Jun – 1 Sep 2026) | Standard (from 1 Sep 2026) |
|---|---|---|
| Copilot Business | 3,000 | **1,900** |
| Copilot Enterprise | 7,000 | **3,900** |

Four things worth knowing, all confirmed:

- 1 AI credit = **$0.01**
- Credits are **pooled across the enterprise**, not reserved per person. There is no such thing as an
  individual developer being over their limit — only the pool can be over.
- Included credits **do not roll over**; they reset at 00:00 UTC on the 1st.
- **Code completions and next-edit suggestions are never billed** and never appear in this export.
  A developer can be highly active and consume zero credits.

---

## 4. Azure AI Foundry

Two exports, and you can start with just the first. Spend alone gives you cost,
cost per million tokens and the input/output split. The metrics export adds
provisioned-capacity utilisation, which is where the money usually hides.

### Where — spend

| | |
|---|---|
| **Portal** | <https://portal.azure.com> |
| **Path** | **Cost Management** → **Cost analysis** → view as **Table** → **Download** |
| **Role** | Cost Management Reader on the subscription |

Group by **Service name**, **Meter** and **Resource**, set granularity to **Daily**, and pick your date
range. Export as CSV. Or schedule it: **Cost Management** → **Exports** → daily to a storage account.

> ⚠️ **The service is called `Foundry Models`, not "Azure OpenAI".** Filtering on the old name returns
> nothing at all — an empty page that looks exactly like "we have no Foundry spend". Verified against
> live cost data, 2026-08-08.

> ⚠️ **The dimension is `Meter`, not `MeterName`.** The Cost Management UI and the older API reference
> disagree; the export column is `Meter`. Consumption Central accepts either.

> 💡 **Copilot Studio pay-as-you-go shows up here too**, as `Pay As You Go Copilot Credit` under service
> `Microsoft Copilot Studio`, priced at exactly $0.01. That is genuinely useful: the Studio pages compute
> PAYG cost from a rate you typed into a parameter, and this is the invoice. The Foundry page reconciles
> the two. When they disagree, the parameter is wrong — which is otherwise a completely silent error,
> because every figure derived from a wrong rate still looks entirely plausible.

### Columns — `AzureAiSpendDaily.csv`

`UsageDate`, `ServiceName`, `MeterCategory`, `Meter`, `ResourceId`, `ResourceName`, `ResourceGroup`,
`Cost`, `UsageQuantity`, `Currency`, `DepartmentTag`

`DepartmentTag` is optional and comes from an Azure resource tag — whatever you use to attribute
resources to teams. Tag your Foundry resources and the Foundry page can break spend down by department.
Leave it empty and everything else still works.

Model name and token direction are **parsed from `Meter`**, so you do not need to supply them.

<details>
<summary>How the meter name is parsed into <code>Model</code> and <code>TokenDirection</code></summary>

Azure abbreviates the token direction inconsistently between meters, and the abbreviations change
as new models are onboarded. Consumption Central accepts all the spellings seen so far:

| `TokenDirection` | Matched from the meter name |
|---|---|
| `Input` | `input`, `inpt` anywhere; `inp` as a whole word |
| `Output` | `output`, `outpt` anywhere; `opt`, `outp` as whole words |
| `Cached` | `cach` anywhere; `cd`, `cchd` as whole words |
| `Other` | anything else — e.g. `Pay As You Go Copilot Credit`, which is not a token meter |

So `GPT 4.1 Inpt Glbl 1M Tokens` and `5.4 inp Gl 1M Tokens` both resolve to `Input`.

Two rules matter if you are extending this:

- **The short forms match whole words only.** `opt` also sits inside *optimized* and *copilot*, and
  `cd` inside *cdn*, so matching them as substrings would mislabel unrelated meters. The long forms
  are distinctive enough to match anywhere.
- **Cached wins.** A cached meter names the direction too (`GPT 4o Cached Input Tokens`), and cached
  input is priced separately from fresh input, so the cache marker is tested first.

`Model` is whatever precedes the first direction word — `5.4 cd inp Gl 1M Tokens` → `5.4`. A meter
with no direction word keeps its full name as the model, which is what you want for non-token meters.

Hitting a meter spelling that lands in `Other`? Please
[open an issue](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/issues) with the
meter string — the list above is only as good as the exports we have seen.

</details>

### Where — tokens and utilisation *(optional)*

| | |
|---|---|
| **Portal** | Azure Portal → your Azure AI Foundry resource → **Monitoring** → **Metrics** |
| **Role** | Monitoring Reader |

Chart `InputTokens`, `OutputTokens` and `ProvisionedUtilization`, split by **Deployment**, daily, then
**Download to Excel**. Or via CLI:

```bash
az monitor metrics list \
  --resource <resource-id> \
  --metric InputTokens OutputTokens ProvisionedUtilization \
  --interval P1D --start-time 2026-05-01 --end-time 2026-08-01 \
  --output tsv
```

> ⚠️ **Metric names changed, and both sets may be live at once.** Older material says
> `ProcessedPromptTokens`, `GeneratedTokens` and `AzureOpenAIProvisionedManagedUtilizationV2`; the
> current names are `InputTokens`, `OutputTokens` and `ProvisionedUtilization`. Checked against live
> resources, a single account can publish **both** sets simultaneously. Consumption Central accepts
> either, and `pull_azure_ai.py` asks each resource which it actually has.
>
> Requesting a metric a resource does **not** publish returns a well-formed series of **zeros** rather
> than an error — which reads as an idle deployment instead of a wrong name, and is how an hour
> disappears.

> ⚠️ **Partly verified.** The metric names are confirmed: two live AI resources publish **both** the
> current and the older set side by side, which is why the template accepts either. What has *not*
> been seen is this path carrying real token volume — the tenant it was built against has no traffic
> on those deployments, so every call succeeded and returned zero rows. The spend half is fully
> verified against real invoices. If your token columns land differently, please open an issue.

### Columns — `AzureAiTokensDaily.csv`

`Date`, `ResourceName`, `ResourceGroup`, `Deployment`, `Metric`, `Value`

Long format, one row per metric per day. `Metric` holds the metric name; `Value` holds the number.

### What provisioned utilisation is worth

PTU capacity is paid for whether it is used or not, so idle provisioned throughput is the Azure
equivalent of an unassigned GitHub Copilot seat: real money, invisible on a spend chart, and
recoverable. The Foundry page calls it out below 30%.

If you have no provisioned deployment, skip this export. The page says so rather than showing zero.

---

## 5. Org attributes — Microsoft Entra *(optional)*

Without this file every page still works, but you lose department, cost-centre and business-unit
breakdowns. That is most of the chargeback story, so it is worth the effort.

### Where

| | |
|---|---|
| **Portal** | <https://entra.microsoft.com> |
| **Path** | **Microsoft Entra ID** → **Users** → **All users** → **Download users** |
| **Role** | None special — standard users can download the list |

([users-bulk-download][s4a], updated 2026-03-25)

### The catch: not every attribute is standard

| Attribute | Available? |
|---|---|
| `userPrincipalName`, `displayName`, `jobTitle`, `department`, `city`, `country` | ✅ In the standard bulk download |
| `manager` | Standard Entra property, but **not** in the classic download. Use Graph, or the preview download with *Employee org data* selected. |
| `costCenter`, `jobFamily`, `businessUnit` | ❌ **Not standard Entra properties.** Extension attributes, usually populated by an HR sync. Names vary per tenant. |

**Consumption Central does not require any of them.** The org loader recognises a range of spellings, carries
through anything it does not recognise, and creates any expected-but-missing column as empty — so one
absent attribute cannot break the Group By control or any measure that groups by org.

### Getting manager as well

```powershell
Connect-MgGraph -Scopes "User.Read.All"

Get-MgUser -All -Property "userPrincipalName,displayName,department,jobTitle,city,country" -ExpandProperty Manager |
  Select-Object userPrincipalName, displayName, department, jobTitle, city, country,
    @{ N = 'manager'; E = { $_.Manager.AdditionalProperties.userPrincipalName } } |
  Export-Csv -Path "entra_org.csv" -NoTypeInformation -Encoding UTF8
```

For `costCenter` / `jobFamily` / `businessUnit` you need your tenant's own extension attribute names
— ask whoever owns the HR sync, then add them to `-Property` and `Select-Object`. They often live in
`onPremisesExtensionAttributes`.

---

## What happens when something is missing

Consumption Central is built to degrade rather than break:

| Missing | Effect |
|---|---|
| Org file | Pages work; Group By offers fewer attributes; no department breakdown |
| One org column | That attribute disappears from Group By. Nothing else changes. |
| Studio files | Studio pages empty. Cowork and GitHub unaffected. |
| Azure AI spend file | Foundry page empty. Others unaffected. |
| Azure AI tokens file | Foundry cost still works; token and PTU visuals empty. |
| GitHub files | GitHub pages empty. Others unaffected. |
| `PeopleMetaData` / `PersonPolicyMap` | Roster is derived from the metrics file instead — see below |
| Cowork metrics file | Cowork pages empty. This is the one file worth having. |

**On the derived roster.** When the map files are absent — normal for an identified export — the seat
roster is built from the metrics file. That roster can only see people who **consumed something**. A
seat holder with no usage at all has no row in the metrics file and so will not be counted. Seat
counts and allowance totals are therefore **usage-based rather than entitlement-based** on that path.
If you need the full entitled roster, supply the map files from a de-identified export.

---

## Sources

[s1a]: https://learn.microsoft.com/en-us/viva/insights/advanced/admin/manage-settings-copilot-dashboard
[s1b]: https://learn.microsoft.com/en-us/viva/insights/org-team-insights/export-copilot-metrics
[s1c]: https://learn.microsoft.com/en-us/microsoft-365/copilot/usage-based-billing-manage-copilot-credits
[s1d]: https://learn.microsoft.com/en-us/microsoft-365/copilot/cowork/
[s1e]: https://learn.microsoft.com/en-us/microsoft-365/copilot/usage-based-billing-overview-copilot-credits
[s1f]: https://learn.microsoft.com/en-us/viva/insights/advanced/analyst/export-query-data-microsoft-fabric
[s1g]: https://learn.microsoft.com/en-us/viva/insights/identification-copilot-analytics
[s2a]: https://learn.microsoft.com/en-us/power-platform/admin/manage-copilot-studio-messages-capacity
[s3a]: https://docs.github.com/en/billing/how-tos/products/view-productlicense-use
[s3b]: https://docs.github.com/en/billing/reference/billing-reports
[s3c]: https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-organizations-and-enterprises
[s3d]: https://docs.github.com/en/enterprise-cloud@latest/rest/billing/usage
[s3e]: https://docs.github.com/en/enterprise-cloud@latest/billing/tutorials/automate-usage-reporting
[s4a]: https://learn.microsoft.com/en-us/entra/identity/users/users-bulk-download

| # | Source | Checked |
|---|---|---|
| s1a | [Manage Copilot Dashboard settings][s1a] | 2026-08-03 |
| s1b | [Export Copilot metrics][s1b] | 2026-08-03 |
| s1c | [Manage Copilot Credits][s1c] | 2026-07-30 |
| s1d | [Microsoft 365 Copilot Cowork][s1d] | 2026-07-27 |
| s1e | [Usage-based billing overview][s1e] | 2026-07-30 |
| s1f | [Export query data to Microsoft Fabric][s1f] | 2026-03-06 |
| s1g | [Identification in Copilot Analytics][s1g] | 2026-08-03 |
| s2a | [Manage Copilot Studio capacity][s2a] | 2026-08-04 |
| s3a | [View product and license use][s3a] | 2026-08-04 |
| s3b | [Billing reports reference][s3b] | 2026-08-04 |
| s3c | [Usage-based billing for orgs and enterprises][s3c] | 2026-08-04 |
| s3d | [REST billing usage endpoints][s3d] | 2026-08-04 |
| s3e | [Automate usage reporting][s3e] | 2026-08-04 |
| s4a | [Bulk download users][s4a] | 2026-03-25 |

Preview features move. If a click-path here does not match what you see, the portal is right and this
document is stale — please open an issue.

