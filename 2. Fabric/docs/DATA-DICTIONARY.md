# Data dictionary

The Delta table contracts Consumption Central reads, and what each column means.

If you build your own pipeline instead of using the notebooks, match this and the template works
unchanged. The tables are deliberately close to the source exports — renamed to `snake_case` and
typed, but not reshaped — so you can compare a table against the CSV it came from without a
translation step.

**Every table is optional.** A missing table is a supported state: the pages for that product come
up empty and every other page is unaffected. A customer with GitHub Copilot but no Copilot Studio
loads the same template and simply sees no Studio pages populated. Nothing needs commenting out.

Every table also carries **`_loaded_at`** (timestamp), written by the ingester. Not used by the
report; useful when a number looks wrong and you need to know when it arrived. The exceptions are
[`copilot_org_data`](#copilot_org_data) and the [Azure tables](#azure-tables), which are replaced
whole on every run.

---

## `viva_credits_weekly`

Cowork and Work IQ credit consumption. **One row per person × service × policy × week.** Absent it,
the Cowork pages are empty and the rest of the report is unaffected.

| Column | Type | Notes |
|---|---|---|
| `person_id` | string | **Join key.** The real UPN on an identified export, the hashed ID on a de-identified one. |
| `user_principal_name` | string | Identified exports only; null otherwise |
| `entra_id` | string | Identified exports only |
| `people_historical_id` | string | De-identified exports only; joins to the person map |
| `service_id` | string | |
| `service_name` | string | `Cowork` or `Work IQ API`. Treat as an open list — Microsoft is adding services. |
| `spending_policy_id` | string | All-zero GUID = usage recorded outside any policy window |
| `metric_date` | date | Week start |
| `session_count` | int | |
| `spending_policy_limit` | long | The policy's monthly pool, carried inline on every row |
| `credits_used` | double | |
| `user_limit` | long | Per-person cap, where the policy sets one |

**Merge key:** `person_id`, `service_id`, `spending_policy_id`, `metric_date`.

All four are needed. A person can hold rows under two policies in the same week — their own, and the
all-zero GUID for usage outside a policy window — and dropping the policy from the key would collapse
those into one and lose credits.

**Sources.** `Ingest_Viva_Consumption` loads this from the CSV exports in `Files/landing/viva`, from
`viva_credits_dataflow`, or both. `viva_credits_dataflow` is the staging table a Dataflow Gen2 writes
from the live Viva query, with the export's own column names; the report never reads it directly. For
the weeks it covers it replaces the CSV rows, because it is the fresher copy.

---

<a id="cowork_tasks_weekly"></a>

## `cowork_tasks_weekly`

Optional **person x week x category x initiation-type** fact. Independent of `viva_credits_weekly`;
do not union its credits into consumption billing or infer service/policy attributes.
The task page can work when no legacy consumption table exists.

| Column | Type | Notes |
|---|---|---|
| `person_id` | string | Required normalized person key; UPN accepted as fallback when supplied |
| `user_principal_name` | string | Optional; never infer one from anonymous IDs |
| `metric_date` | date | Required week-start date |
| `task_category` | string | Optional open category list; missing maps to `Not supplied` |
| `task_type` | string | Optional initiation type; not completion status |
| `credits_used` | double | Optional fractional credits; null means missing, not zero |
| `task_count` | long | Required finite nonnegative whole reported count |
| `people_historical_id` | string | Optional historical metadata key |
| `organization` | string | Optional historical task organization |
| `function_type` | string | Optional historical function |
| `is_copilot_licensed` | boolean | Optional licence flag |
| `category_key`, `type_key` | string | Lowercase normalized labels used by the notebook merge; model derives these if absent |

**Merge key:** `person_id`, `metric_date`, `category_key`, `type_key`. Inline metadata is enriched
only from the task export's own companion directory. Identical duplicates collapse; conflicting
observations or metadata keys fail before the merge. Missing or empty input never deletes history.
The source notebook preserves fractional precision using the existing double-precision credit
convention rather than rounding to integer credits or fixed four-decimal currency.

See [Cowork task inputs and assumptions](../../docs/COWORK-TASKS.md).

---

## `viva_spending_policy`

Policy names and limits. One row per policy. Optional: without it, policies show as GUIDs but
pricing is unaffected, because the limits already travel inline on the metrics rows.

| Column | Type | Notes |
|---|---|---|
| `spending_policy_id` | string | |
| `name` | string | `(Unassigned)` for the all-zero GUID row, which has no name in the export |
| `plan_limit` | long | Monthly credit budget for the whole policy |
| `user_limit` | long | Optional per-person cap within it |
| `included_services` | string | e.g. `Cowork;WorkIQ` |

**Load:** full replace. Small and slow-moving.

---

## `studio_tenant_daily`

Copilot Studio consumption. One row per environment × billing plan × capacity type × day. **The only
Studio table with a real date**, and so the only one Consumption Central plots over time.

| Column | Type | Notes |
|---|---|---|
| `billing_plan_id` | string | All-zero GUID where no plan applies |
| `billing_plan_name` | string | Often blank |
| `environment_id` | string | |
| `environment_name` | string | |
| `capacity_type` | string | e.g. `MCSMessages` |
| `source_file` | string | Which export the row came from — matters when several environments are exported separately |
| `entitled_quantity` | double | Prepaid entitlement |
| `prepaid_consumed` | double | Drawn from prepaid capacity |
| `payg_consumed` | double | Billed pay-as-you-go |
| `usage_date` | date | Parsed from PPAC's `M/d/yyyy H:mm` |

**Merge key:** `usage_date`, `environment_id`, `billing_plan_id`, `capacity_type`.

> **Licensing API files (optional, off by default).** With `READ_API_FILES = True`, `Ingest_Studio`
> also reads daily files a Power Automate flow saves from the Power Platform licensing API. It keeps
> them in `studio_agent_daily` and `studio_user_daily`, which the report does not read, and rolls
> them up into this table, `studio_agent` and `studio_user` with `source_file = 'ppac-api'`, or
> `'ppac-api-users'` for days summed from the per-user file alone. An export always wins where it
> covers the same day and environment, or the same month for agents and users.

---

## `studio_agent`

Per-agent consumption. **The export carries no date** — it is a month-to-date aggregate — so the
ingester stamps `snapshot_month` and merges on it.

| Column | Type | Notes |
|---|---|---|
| `snapshot_month` | date | Added by the ingester. First of the month the export represents. |
| `agent_name` | string | |
| `agent_id` | string | |
| `product` | string | e.g. `Copilot Studio` |
| `billable_feature` | string | From `AI Feature/Billable Feature` |
| `billed_credit` | double | Chargeable |
| `non_billed_credit` | double | Absorbed by entitlement |
| `channel` | string | e.g. `M365 Copilot` |
| `knowledge_sources` | string | |
| `tool_used` | string | |
| `llm_model` | string | |
| `scenario_name` | string | |
| `environment_id` | string | |
| `environment_name` | string | |
| `source_file` | string | Which export this came from — lineage, useful when several environments export separately |

**Merge key:** `snapshot_month`, `agent_id`, `billable_feature`, `channel`, `environment_id`.

An agent appears once per feature per channel per environment, so all of those belong in the key.

> **`agent_name` and `environment_name` are frequently blank.** Power Automate flows have no agent
> name in PPAC — in the sample dataset 419 of 448 rows are blank. `agent_id` is always populated, so
> nothing is lost, but the agent and environment slicers list only named agents. Those rows still
> count in every total.

> **Read these as cumulative, not incremental.** Two snapshots in the same month show growth to date,
> not new consumption. Consumption Central therefore treats them as period totals and never plots them on a
> time axis — which is also why the Studio forecast extends a daily run rate rather than fitting a
> curve.
>
> **The template reads the LATEST `snapshot_month` only.** Once you have run the ingester twice, an
> agent has a row per snapshot; summing them would multiply that agent's credits by the number of
> months loaded, and each of those rows is already a month-to-date total. The history is kept
> because it is worth having, not because the report adds it up.

---

## `studio_user`

Per-user consumption. Same no-date caveat as `studio_agent`.

| Column | Type | Notes |
|---|---|---|
| `snapshot_month` | date | Added by the ingester |
| `user_id` | string | |
| `user_email` | string | Lowercased. **Joins to `org_attributes.user_principal_name`.** |
| `agent_id` | string | |
| `agent_name` | string | |
| `billable_credit_used` | double | |
| `credits_used` | double | |
| `m365_copilot_licensed` | boolean | Parsed from the export's text |
| `source_file` | string | Lineage |

**Merge key:** `snapshot_month`, `user_id`, `agent_id`.

> **This will not add up to the tenant total, and that is correct.** Agent and environment
> consumption carries no user, so the per-user total is always smaller. Consumption Central computes the gap
> and states it on the page rather than hiding it.

---

## `github_ai_usage`

GitHub Copilot AI credit consumption. Person × day, further split by SKU and model.

| Column | Type | Notes |
|---|---|---|
| `usage_date` | date | UTC |
| `username` | string | GitHub login, lowercased |
| `product` | string | e.g. `copilot` |
| `sku` | string | e.g. `coding_agent_ai_credit` |
| `model` | string | e.g. `claude-sonnet-4` |
| `quantity` | double | |
| `unit_type` | string | e.g. `ai-credits` |
| `applied_cost_per_quantity` | double | $0.01 per credit at publication |
| `gross_amount` | double | Before the included allowance |
| `discount_amount` | double | Absorbed by the allowance |
| `net_amount` | double | **What you actually pay** |
| `total_monthly_quota` | double | CSV only — absent from the API |
| `organization` | string | |
| `repository` | string | CSV only — absent from the AI-credit API |
| `cost_center_name` | string | Where cost centres are configured |

**Merge key:** `usage_date`, `username`, `sku`, `model`, `repository` (CSV) or
`usage_date`, `username`, `sku`, `model` (API — no repository).

> **Code completions never appear here.** They are unlimited on every paid plan and are not billed,
> so a highly active developer can consume zero credits. This table is spend, not activity.

---

## `github_user_map`

GitHub seats. One row per developer. Needed for seat cost, which is usually the larger half of the
GitHub bill.

| Column | Type | Notes |
|---|---|---|
| `username` | string | GitHub login, lowercased. Joins to `github_ai_usage`. |
| `user_principal_name` | string | **Joins to `org_attributes`.** GitHub does not know this — see below. |
| `display_name` | string | |
| `plan` | string | Must read exactly `Copilot Business` or `Copilot Enterprise` |
| `included_credits` | long | Per-seat monthly allowance |

**Load:** full replace. Current state — someone who moved plan should appear once, on the current one.

> **`plan` must match exactly.** The seat-price measure keys on the string, so an unexpected spelling
> silently prices everyone as Business. Both ingesters warn if they see anything else.
>
> **`user_principal_name` is not something GitHub holds.** If your enterprise uses SAML SSO,
> `GET /enterprises/{e}/consumed-licenses` returns `saml_name_id`, which is usually the UPN — the API
> notebook does this automatically. Otherwise maintain a mapping table. Do not guess from the email
> pattern: it is wrong often enough to misattribute cost to the wrong department, which is worse than
> having no department at all.

---

## `org_attributes`

Department, cost centre and so on. One row per person. Optional, but it is what turns consumption
into chargeback.

| Column | Type | Standard Entra? |
|---|---|---|
| `user_principal_name` | string | ✅ **Join key**, lowercased and trimmed |
| `display_name` | string | ✅ |
| `department` | string | ✅ |
| `job_title` | string | ✅ |
| `job_family` | string | ❌ Extension attribute |
| `city` | string | ✅ |
| `country` | string | ✅ |
| `cost_center` | string | ❌ Extension attribute |
| `manager` | string | ⚠️ Standard property, but not in the classic bulk download |
| `business_unit` | string | ❌ Extension attribute |

**Load:** full replace. Current state, not history — someone who changed department should appear
once, in their new one.

> **Any of these may be absent** and the ingester creates them empty rather than failing. One missing
> attribute costs you that one breakdown and nothing else.
>
> **The join is case- and whitespace-sensitive**, so UPNs are lowercased and trimmed on both sides.
> The Org ingester ends with a match-rate check for exactly this reason — empty department
> breakdowns are nearly always a UPN mismatch rather than a modelling problem.
>
> **On a de-identified Viva export the match rate will be 0%**, and that is expected: hashed person
> IDs cannot match real UPNs. Department breakdowns need an identified export.

---

<a id="copilot_org_data"></a>

## `copilot_org_data`

Every user in Microsoft Entra ID, read through Microsoft Graph by
[`Ingest_Org_Graph`](../notebooks/Ingest_Org_Graph.ipynb). One row per user. An alternative to
`org_attributes` that needs no export: the template reads the first of `copilot_org_data` and
`org_attributes` that has rows, in that order, then keeps only the people on the licensed roster
(or every row, if none match).

| Column | Type | Notes |
|---|---|---|
| `PersonId` | string | UPN, as Entra holds it. A user without one fails the run. |
| `PersonId_Normalized` | string | `PersonId` lowercased and trimmed |
| `displayName` | string | |
| `Department` | string | Department breakdowns leave out people without one |
| `JobTitle` | string | |
| `companyName` | string | |
| `officeLocation` | string | |
| `city` | string | |
| `country` | string | |
| `accountEnabled` | string | `True` or `False`. Disabled accounts are kept. |
| `managerUPN` | string | Blank where no manager is set |

**Load:** full replace on every run. A run that finds no users fails rather than emptying the
table, unless `ALLOW_EMPTY_SNAPSHOT = True`.

> The template matches people on any identifier column it recognises (`PersonId`,
> `PersonId_Normalized`, a UPN or an email column), lowercased and trimmed on both sides.

---

## `commercial_terms`

**Optional, and unlike the others it holds no consumption data at all.** One row, one column per
commercial figure. Where a column is present its value overrides the matching template parameter;
where it is absent, or the table does not exist, the parameter is used. So a customer with a
pipeline gets their real numbers without anyone retyping them, and a customer without one is
unaffected.

The reason to bother: **Azure Cost Management knows the rate you actually pay.** Divide cost by
quantity on the Copilot credit meter and you have the negotiated rate rather than the $0.01 list
price. See [COMMERCIAL-TERMS.md](../../docs/COMMERCIAL-TERMS.md).

| Column | Type | Notes |
| --- | --- | --- |
| `credit_rate` | double | Cost per pay-as-you-go credit. Overrides `CreditRate`. |
| `prepaid_credit_rate` | double | Effective cost per pre-purchased credit. Overrides `PrepaidCreditRate`. |
| `prepaid_credit_balance` | double | Credits bought up front. Overrides `PrepaidCreditBalance`. |
| `github_business_seat` | double | Monthly price per Copilot Business seat. Overrides `GitHubBusinessSeatPrice`. |
| `github_enterprise_seat` | double | Monthly price per Copilot Enterprise seat. Overrides `GitHubEnterpriseSeatPrice`. |

Every column is optional; supply only the ones you know. A one-row table with just `credit_rate` is
a perfectly good use of this.

> **More than one row and only the first is read.** This is a settings table, not a history — if you
> want to keep old rates, keep them somewhere else. Re-pricing history against a rate that changed
> mid-period is a bigger question than this template answers.

---

## Azure tables

[`Ingest_Azure_AI`](../notebooks/Ingest_Azure_AI.ipynb) writes these for one subscription. Each run
replaces each table whole with the last `DAYS` complete UTC days (90 by default). `azure_ai_spend`
and `azure_ai_tokens` feed the Foundry figures; their columns are listed in
[Azure ingestion in Fabric](../../docs/ADVANCED-SETUP.md#azure-ingestion-in-fabric). The last three
below are best effort: if a run cannot read their source, it logs a warning and leaves the table as
it was.

### `copilot_payg_spend`

Copilot Studio and Cowork credits billed pay-as-you-go to Azure through Power Platform billing
policies. **One row per day × subscription × meter × service tag × currency**, from Cost Management
for `SUBSCRIPTION_ID` and every subscription in `PAYG_SUBSCRIPTION_IDS`. No template reads it yet.

| Column | Type | Notes |
|---|---|---|
| `UsageDate` | date | UTC |
| `SubscriptionId` | string | The subscription billed |
| `Meter` | string | e.g. `Pay As You Go Copilot Credit` |
| `ServiceTag` | string | Azure's `serviceName` tag: `cowork` on Cowork charges, blank on Copilot Studio |
| `Product` | string | `Copilot Studio` or `Cowork`, from the tag; any other tag value passes through |
| `Cost` | double | In `Currency`; nothing is converted |
| `UsageQuantity` | double | Credits, on the credit meter |
| `Currency` | string | |

Billing can lag usage by a day or more. A duplicate grain or an unexpected tag key fails the run
rather than double counting or guessing the product.

### `azure_deployment_health`

Model deployments and how they ran, for the **Azure: Capacity & Health** page. **One row per
deployment per calendar month.** ARM supplies the inventory and Azure Monitor the telemetry. Past
months list the deployments that reported telemetry; the current month lists every deployment, so an
idle one shows as having no telemetry rather than disappearing.

| Column | Type | Notes |
|---|---|---|
| `SnapshotDate` | date | Last day the row covers: the month end, or the last complete day this month |
| `MetricDate` | date | Month end |
| `SubscriptionName` | string | |
| `SubscriptionId` | string | |
| `ResourceId` | string | The AI account, lowercased |
| `DeploymentId` | string | Same value as `DeploymentName` |
| `DeploymentName` | string | |
| `Application` | string | Tag `Application`, `App`, `Solution`, `Workload` or `Project`, on the deployment or else its account |
| `ModelName` | string | |
| `ModelVersion` | string | |
| `SkuName` | string | e.g. `GlobalStandard`, `ProvisionedManaged` |
| `Region` | string | The account's location |
| `PtuCapacity` | double | Provisioned SKUs only. On Standard SKUs capacity is a rate limit, not PTUs, so this is blank. |
| `MeanUtilizationPct` | double | 0–100, the mean of daily averages. Provisioned only. |
| `PeakUtilizationPct` | double | The highest daily maximum. Provisioned only. |
| `Requests` | double | Month total |
| `ServerErrors5xx` | double | Month total of 5xx responses |
| `Throttles429` | double | Month total of 429 responses |
| `MeanLatencyMs` | double | Weighted by daily requests |

Blank telemetry means none was reported, not zero.

### `azure_solution_spend`

What the whole AI solution costs, for the **Azure: Spend & Consumption** page. **One row per day ×
resource × service × currency**, covering the AI services and every other resource in a resource
group that holds an AI account.

| Column | Type | Notes |
|---|---|---|
| `UsageDate` | date | UTC |
| `SubscriptionName` | string | |
| `SubscriptionId` | string | |
| `ResourceId` | string | Lowercased |
| `ResourceName` | string | |
| `ResourceGroup` | string | |
| `Application` | string | Resource tag `Application`, `App`, `Solution`, `Workload` or `Project` |
| `DepartmentTag` | string | The resource's department tag, as in `azure_ai_spend` |
| `ServiceName` | string | Cost Management service |
| `ServiceCategory` | string | `Model` (Foundry Models, Azure OpenAI), `AI service` (the other AI services) or `Supporting` (anything else in those resource groups) |
| `ActualCost` | double | As billed |
| `AmortizedCost` | double | With reservations and prepurchases spread over their term |
| `Currency` | string | |
| `TotalTokensM` | double | Millions of tokens, from Azure Monitor |
| `PaygTokensM` | double | Millions of tokens billed pay-as-you-go, from the token meters |
| `InputPaygCost`, `OutputPaygCost`, `CachedPaygCost` | double | Pay-as-you-go token cost by direction. `Model` rows only. |
| `Requests` | double | From Azure Monitor |
| `SpeechHours`, `DocumentPages`, `Images` | double | Not collected yet; always blank |
| `AllocationStatus` | string | `Tagged` when `Application` or `DepartmentTag` is set, otherwise `Untagged` |
| `PricingModel` | string | `PAYG`, `Provisioned` or `PAYG + Provisioned`, from the meters billed |
| `BillingScope` | string | `Subscription: <name>` |

`TotalTokensM` and `Requests` sit on one row per resource and day, so they can be summed. Usage with
no cost that day gets a zero-cost `Foundry Models` row to carry it.

### `azure_billing_reconciliation`

Estimated against actual AI spend, for the **Billing: Reconciliation** page. **Two rows per month ×
service × pool × currency**: a `UsageEstimate` (metered quantity × the public Azure Retail Prices
list price) and the `AzureActual` it is compared with. List prices exclude negotiated discounts,
credits and reservations, so some variance is expected under an enterprise agreement.

| Column | Type | Notes |
|---|---|---|
| `Period` | string | `yyyy-MM` |
| `PeriodStart` | date | First day of the month, or of the collection window |
| `PeriodEnd` | date | Last day of the month, or the last complete day collected |
| `Product` | string | Cost Management service, e.g. `Foundry Models` |
| `PoolName` | string | `Foundry Provisioned Pool` for provisioned meters, otherwise `Foundry PAYG Pool` |
| `Representation` | string | `UsageEstimate` or `AzureActual` |
| `Amount` | double | Blank on a `UsageEstimate` row when no meter had a list price |
| `Currency` | string | |
| `Status` | string | The same on both rows: `Reconciled` (within 1%), `Variance within tolerance` (within 5%), `Unexplained variance`, or `Unpriced` |
| `EvidenceType` | string | Where `Amount` came from |
| `Notes` | string | Meters priced, cost left unpriced, and the list-price caveat |

Variance is judged on the priced meters only; cost on meters without a list price is stated in
`Notes` instead.

---

## How they relate

```
org_attributes ──────┬── user_principal_name ──── viva_credits_weekly.person_id
                     │                            (identified exports only)
                     ├── user_principal_name ──── github_user_map.user_principal_name
                     │                                   └── username ── github_ai_usage
                     └── user_principal_name ──── studio_user.user_email

viva_credits_weekly ── spending_policy_id ─────── viva_spending_policy

studio_tenant_daily ── environment_id ─────────── studio_agent.environment_id
studio_agent ───────── agent_id ───────────────── studio_user.agent_id
```

The three products share **no key with each other** — a GitHub login, a Viva person ID and a Studio
user ID are unrelated. They meet only through `org_attributes`, and only when every source carries a
matching UPN. That is why the combined page normalises to a monthly run rate per product rather than
attempting a single per-person total across all three, and why it says so on its face.

Where `copilot_org_data` has rows, it takes the place of `org_attributes` in every join above. The
Azure tables share no key with any of these.
