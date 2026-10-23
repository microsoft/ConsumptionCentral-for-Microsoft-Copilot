# Advanced setup

Detail moved out of the setup guides so those stay short. You only need this if you are
**automating collection** or **troubleshooting org attributes**. A first-time setup does not.

- [Automating Azure collection (Local CSV and Viva Direct)](#automating-azure-collection)
- [Azure ingestion in Fabric](#azure-ingestion-in-fabric)
- [Org attributes on Viva Direct](#org-attributes-on-viva-direct)
- [Offline regression and rebuild](#offline-regression-and-rebuild)

---

## Automating Azure collection

Applies to **1. Local CSV** and to **Viva Direct's optional Azure pages**. The collector does not
run inside Power BI — schedule it first, then refresh the semantic model only on success.

### 1. Prepare a runner and read-only Azure access

Install a supported Python 3 and
[Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) on a machine that can
reach Azure and write to the report's `DataFolder`. The collector uses only the Python standard
library and Azure CLI.

For the first interactive run, use `az login --tenant <tenant-id>`, then select the subscription
with `az account set --subscription <subscription-id>`.

Grant the collecting identity:

| Role | Scope |
|---|---|
| **Cost Management Reader** | Subscription |
| **Monitoring Reader** | The AI resources |
| **Reader** | Subscription — covers resource, tag and deployment discovery |

Billing-agreement charge visibility may require an additional administrator setting; see
[Cost Management access](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/assign-access-acm-data).

For unattended runs, authenticate **as the scheduled job's identity**, not your personal
interactive login. Prefer `az login --identity` on an Azure host with a configured managed
identity, or a properly secured
[service-principal certificate login](https://learn.microsoft.com/en-us/cli/azure/authenticate-azure-cli-service-principal).
Do not put secrets in a task's arguments, notebook, source control or logs. Personal cached logins
can expire or require MFA and are not a reliable unattended design.

### 2. Run once and inspect the outputs

From the repository root, after authentication:

```powershell
python ".\1. Local CSV\pull_azure_ai.py" "C:\Consumption Central\Data" --subscription "<subscription-id>" --days 7
if ($LASTEXITCODE -ne 0) { throw "Azure collection failed; do not refresh Power BI." }
```

`--days` accepts 1–90 complete UTC days before today (default 90). After accepting the first short
run, choose the desired rolling window. `python pull_azure_ai.py <folder>` still works; without
`--subscription` it uses the current Azure CLI account subscription. Run with `--help` for the full
command reference.

Keep the folder dedicated to the selected subscription. Do not mix sample Azure files, old renamed
copies, or output from another subscription into the same folder.

| File | Shipped template usage |
|---|---|
| `AzureAiSpendDaily.csv` | Resource/meter daily cost and billing quantities |
| `AzureAiTokensDaily.csv` | Daily Monitor token/request/utilisation metrics |
| `AzureAiDeployments.csv` | Inventory export only; **not loaded** by the shipped templates |

Use the canonical names. Both Local CSV and Viva Direct find the first eligible file by filename
pattern, folder depth and modification date; these two Azure readers do not union every matching
file. Put the current outputs directly in `DataFolder`.

Then set `DataFolder`, refresh in Desktop, and compare the selected dates and currency with Azure.
Follow the [acceptance checks](TESTING.md#azure-automation-acceptance) and read the
[shipped model's unit, currency and service limitations](DATA-SOURCES.md#important-limits-of-the-shipped-azure-page)
before treating cost-per-million as a reconciled billing metric.

### 3. Schedule collection, then report refresh

Use Windows Task Scheduler or your existing job runner. Configure a daily job under the identity
tested above; use absolute executable/script/output paths, an explicit subscription, and a
non-overlap policy. Authenticate in that run context before launching the collector.

**Collection failure must block downstream report refresh**, not masquerade as an empty source.
Record exit status and output freshness, and configure bounded retry/backoff for transient
failures. The collector retries recognised transient CLI failures four times with 2/4/8-second
backoff. Azure CLI does not reliably expose `Retry-After` to it, so a longer throttle fails the
job — configure bounded runner-level retries with a longer delay rather than restarting
immediately. Authentication and validation errors are not retried.

The output files form one collection batch. Avoid refresh while files are being published:
per-file replacement is not a transaction across the whole batch. After any interrupted
publication, rerun collection successfully before refreshing. All queries must succeed before
publication begins. A successful empty result writes headers rather than retaining stale rows.
Real numeric zero metrics are kept; missing telemetry is not converted to zero.

Power BI Desktop does not provide unattended refresh of an open local report. For Power BI Service,
publish the model and configure an
[on-premises data gateway](https://learn.microsoft.com/en-us/power-bi/connect-data/service-gateway-onprem)
on an always-on machine that can access the **same folder path**, with data-source credentials the
gateway identity can use. A OneDrive-synced local folder is still a local filesystem source, not a
cloud connection. Viva Direct additionally needs its separate Viva cloud credentials.

Trigger semantic-model refresh after successful collection using your orchestrator, or allow
adequate time between separate schedules and monitor both jobs. Clock ordering alone is not a
success dependency.

---

## Azure ingestion in Fabric

`Ingest_Azure_AI.ipynb` writes six tables without manual exports: Foundry spend and tokens, Copilot
pay-as-you-go, and the three tables behind the Azure pages. It reads one subscription (plus any
pay-as-you-go subscriptions you list) and overwrites a rolling window of **1–90 complete UTC days**
(`DAYS = 90` by default) rather than accumulating an archive. Keep these tables dedicated to that
subscription — independent runs for different subscriptions would replace each other's data.

| Table | From | Columns |
|---|---|---|
| `azure_ai_spend` | Cost Management Query API | `UsageDate`, `ServiceName`, `MeterCategory`, `Meter`, `ResourceId`, `ResourceName`, `ResourceGroup`, `Cost`, `UsageQuantity`, `Currency`, `DepartmentTag` |
| `azure_ai_tokens` | Azure Monitor metrics | `Date`, `ResourceName`, `ResourceGroup`, `Deployment`, `Metric`, `Value` |
| `copilot_payg_spend` | Cost Management Query API, for `SUBSCRIPTION_ID` and `PAYG_SUBSCRIPTION_IDS` | `UsageDate`, `SubscriptionId`, `Meter`, `ServiceTag`, `Product`, `Cost`, `UsageQuantity`, `Currency` |
| `azure_deployment_health` | ARM inventory and Azure Monitor metrics | One row per deployment per month |
| `azure_solution_spend` | Cost Management Query API, ARM and Azure Monitor | Daily actual and amortized cost by resource and service |
| `azure_billing_reconciliation` | Cost Management Query API and the public Azure Retail Prices API | Monthly usage estimate against actual cost |

Columns for the last four are in the [data dictionary](../2.%20Fabric/docs/DATA-DICTIONARY.md#azure-tables).

The shipped Fabric template reads every table except `copilot_payg_spend` as **`dbo` tables**, not
views, through `Sql.Database(FabricSQLEndpoint, LakehouseName)`. From `azure_ai_spend` it derives
model and token direction from `Meter`; `ResourceId` and `MeterCategory` are not retained in the
model. Missing tables are an optional, supported state; connection and authentication failures
still need fixing.

### Authentication and permissions

The notebook does **not** run as a managed identity automatically. Microsoft's
[NotebookUtils credentials documentation](https://learn.microsoft.com/en-us/fabric/data-engineering/notebookutils/notebookutils-credentials)
lists `storage`, `pbi`, `keyvault` and `kusto` audiences, **not ARM**. Do not rely on
`notebookutils.credentials.getToken("https://management.azure.com/")`, a `pbi` token for ARM, or an
implicit `DefaultAzureCredential` chain in Fabric.

It uses an explicit Entra application's **client-credentials** token with scope
`https://management.azure.com/.default`, renewed before expiry. No additional authentication
package is required.

1. **Register an Entra application** in the subscription's tenant. Store its client secret **value**
   in Azure Key Vault; never paste it into notebook code, parameters, logs or source control.
   Assign **Cost Management Reader** at subscription scope, **Monitoring Reader** on the AI
   accounts, and **Reader** at subscription scope for inventory/tag discovery. Also assign Cost
   Management Reader on each subscription you list in `PAYG_SUBSCRIPTION_IDS`. Cost visibility also
   depends on the billing agreement's charge policies, including EA **AO view charges** or MCA
   **Azure charges**; see
   [Cost Management access](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/assign-access-acm-data).
2. **Give the notebook execution identity** permission to read that Key Vault secret (Key Vault
   Secrets User with Azure RBAC, or secret **Get** under access policies). It separately needs
   permission to run the notebook and write to the Lakehouse — workspace Contributor is common. The
   ARM application and the execution identity are distinct: roles on one do not grant the other's
   access.
3. **Import the notebook**, attach the intended Lakehouse as its default, and set `SUBSCRIPTION_ID`,
   `TENANT_ID`, `CLIENT_ID`, `KEY_VAULT_URL`, `CLIENT_SECRET_NAME` and `DAYS`. Power Platform
   billing policies can charge Copilot Studio and Cowork pay-as-you-go to other subscriptions; list
   those in `PAYG_SUBSCRIPTION_IDS` (empty by default, which reads `SUBSCRIPTION_ID` only). Leave the
   shipped table names unchanged. Ensure Fabric can reach Key Vault, Entra login, ARM and, for
   reconciliation, the Azure Retail Prices API (`prices.azure.com`, called without credentials)
   under your network policy, and rotate the stored credential before expiry.
4. **Run interactively once, then validate the actual scheduled identity.**
   [Fabric documents](https://learn.microsoft.com/en-us/fabric/data-engineering/how-to-use-notebook)
   interactive runs under the current user, notebook schedules under the schedule creator/last
   updater, and default pipeline runs under the pipeline's last modifying user. A
   [Notebook activity connection](https://learn.microsoft.com/en-us/fabric/data-factory/notebook-activity)
   can explicitly select another supported identity, including a configured workspace identity.
   Verify secret retrieval and Lakehouse writes in the selected run context, not just your
   interactive session.

### Collection and refresh behaviour

- Cost queries follow every continuation URL using POST with the same body and each page's column
  metadata, using at most two aggregation/grouping clauses. Missing aggregations, malformed rows and
  duplicate daily grains fail instead of becoming zero spend. Currencies remain separate.
- Monitor queries use only the shipped metric families. Counters request `Total`, provisioned
  utilisation requests `Average`. One name per equivalent family is preferred (new before legacy);
  `TotalTokens` is used only if neither input nor output is available. `TotalCalls` is not used on
  OpenAI-kind accounts.
- Queries use daily UTC buckets in at most 30-day windows. Where available the deployment dimension
  is requested; otherwise `Deployment` stays blank for resource-level data. Unexpected dimension
  splits, changed time grains, duplicate points or reaching the series limit fail visibly.
- Numeric zero points are retained. Null or missing telemetry is omitted, not converted to zero.
  HTTP, authentication and per-metric errors propagate. A successful empty collection replaces old
  rows with empty, explicitly typed tables.
- For spend, tokens and pay-as-you-go, all reads and validation finish before writes begin. Those
  three Delta overwrites are individually atomic, **not a cross-table transaction** — a later write
  failing can leave a mixed snapshot. Retry the whole notebook and gate report refresh on
  whole-run success. ARM throttling and transient 502/503/504 responses retry up to five attempts,
  honouring `Retry-After`. Delays over 300 seconds defer the job with an error. Configure bounded
  pipeline retries and avoid overlapping runs. Costs can arrive late or be revised; later
  rolling-window runs pick up those changes.
- `azure_deployment_health`, `azure_solution_spend` and `azure_billing_reconciliation` are written
  afterwards, **best effort**. A failed account, deployment or metric call is logged as a `WARNING`
  and skipped, and a table whose source fails entirely is left as it was, so a successful run can
  leave one of them stale: check the run output for `WARNING` lines. Reconciliation prices usage at
  public list prices, which exclude negotiated discounts, credits and reservations, so some variance
  against actual cost is expected.

A Cost Management export to storage is another automated source, but needs transformation to this
schema and does not contain Azure Monitor metrics.

---

## Org attributes on Viva Direct

**Check the returned columns, not just the query settings.** With user identification enabled, do
not assume Department, Organisation or other HR fields will be returned alongside UPNs. Use the
separate directory CSV as the standard setup unless the required values are confirmed in the actual
output. Domain and Population Type alone do not provide department breakdowns.

Without user identification, selected employee attributes may be available from Viva. This is not
yet verified as a general rule: compare the identified and de-identified outputs before relying on a
query-only setup. Do not change identification or privacy settings solely as a workaround without
confirming that the resulting identity and reporting behaviour is suitable.

**Organisation is separate from Department.** Both `Organisation` and `Organization` map to the
**Organisation** grouping; selecting both keeps both attributes. Custom employee attributes are
retained too.

A query-only setup needs no org file **only when the source supplies the attributes and resolvable
identities**. A `PersonId`, Entra/AAD object id or `PeopleHistoricalId` can identify a person; it
cannot manufacture missing HR attributes. Identity keys are trimmed and case-normalised. Repeated
rows are reconciled before calculating usage intensity; conflicting explicit person ids produce a
`VivaIdentityConflict` refresh error rather than silently double-counting. An identity-free
consumption row produces `VivaMissingIdentity`.

People with no org values remain in **Usage Intensity (Cowork)**. For a populated attribute, missing
values appear as **(Not set)**. Attributes populated for less than 5% of the combined population are
hidden unless none clear that threshold. Buckets describe the loaded billing period snapshot;
changing a report period does not recalculate their membership.

### Supplying the directory CSV

Drop a directory export from the Microsoft Entra admin centre (**Users → Download users**) into your
`DataFolder`. Where both sources describe a person, the directory wins per nonblank attribute and
Viva fills its gaps. A shared UPN or person/object identifier is required to match a file to
consumption; the template cannot infer a link between unrelated identifiers.

See [org data](ORG-DATA.md) for the full picture.

---

## Offline regression and rebuild

From the repository root, using Python 3.12 and no additional packages:

```powershell
python -B docs\scripts\check_viva_query_org.py
python -B docs\scripts\fix_viva_query_org.py --dry-run
```

The shipped Viva template already contains the fix. The patcher can also reproduce it from the
`ee6927c` Viva template; running without `--dry-run` writes it back. It refuses unknown source
versions. Editable M sources live beside it in `docs\scripts\viva_query_org`. Only `DataModelSchema`
and `UnappliedChanges` change. This export has **no DataMashup part**; a package containing one is
rejected, not partially patched.

These checks cover package and source contracts plus synthetic Python fixtures — **not** execution
of M or DAX. Complete the query-only refresh checks in
[TEST-PROCEDURE.md](../3.%20Viva%20Direct/TEST-PROCEDURE.md) before distributing a tenant-validated
build.
