# 2. Fabric

**Set it up once, then it refreshes itself.** Data lands in a Lakehouse; the report reads it on a
schedule. It also accumulates history beyond Viva's 6-month export window.

Needs a workspace on a capacity that supports Fabric notebooks and Lakehouses (for example Fabric F
capacity or an eligible trial) — **PPU alone is not Fabric capacity**. Only have Power BI Pro? Use
**[1. Local CSV](../1.%20Local%20CSV/)**.

Bring whichever products you have; skip the notebooks for the ones you don't.

---

## Five steps

### 1. Create a Lakehouse

Fabric portal → your workspace → **New** → **Lakehouse**.

<a id="viva-dataflow"></a>

### 2. Set up Viva *(no notebook needed)*

Viva Insights ships a certified **Dataflow Gen2** connector that writes query results straight into
your Lakehouse on a schedule. This is the preferred route.

1. Viva Insights → **Create analysis** → **Create custom query** → **Consumption query**, with
   **Auto-refresh** on → **Run** → **Analysis results** → your query → the **link icon**. Copy the
   **Partition identifier** and **Query identifier**.
   **[Step-by-step →](../docs/VIVA-QUERY.md)**
2. Fabric workspace → **New** → **Dataflow Gen2** → **Get data** → search *Viva Insights* under
   **Online Services**.
3. Paste both identifiers. Leave *Query Name* blank. Under **Advanced options** set **Schema Type =
   Pivoted** and **Data Granularity = Row-level data**. Authenticate with an **Organizational
   account**.
4. Set the Lakehouse as the destination and name the table `viva_credits_weekly`. Keep the person
   identifiers, metric columns and employee attributes. Schedule the refresh for **Tuesday ~8am
   PST**, after Viva's weekend refresh.

> **To keep more than six months**, name the table `viva_credits_dataflow` instead and schedule
> `Ingest_Viva_Consumption` after the Dataflow. The notebook merges that table into
> `viva_credits_weekly`: the Dataflow's rows replace the weeks they cover, and older weeks stay, so
> history keeps accruing past the query's window. CSV exports in `Files/landing/viva/` can fill in
> weeks before the query's window.

> Leaving *Query Name* blank only works against a **custom query** you built in Analysis. The
> Consumption Dashboard's own export is multi-table and needs a table name supplied.

> **Also turn on auto-refresh for the query itself** in Viva Insights → Analysis results. Without it
> the Dataflow refreshes happily against a result that never changes.

**[Microsoft's guide →](https://learn.microsoft.com/en-us/viva/insights/advanced/analyst/export-query-data-microsoft-fabric)**

### 3. Import the notebooks for your other products

**[notebooks/](notebooks/)** — one per product. Import the ones you need, set the workspace and
Lakehouse at the top of each, run.

| Notebook | Reads | Writes |
|---|---|---|
| `Ingest_GitHub_API` | GitHub REST API | `github_*` |
| `Ingest_GitHub` | The emailed GitHub usage CSV, from `Files/landing/github/` | `github_*`. Use this or `Ingest_GitHub_API`, not both. |
| `Ingest_Azure_AI` | Azure Cost Management + Monitor | `azure_ai_spend`, `azure_ai_tokens`, `copilot_payg_spend`; best effort, `azure_deployment_health`, `azure_solution_spend`, `azure_billing_reconciliation` |
| `Ingest_CommercialTerms` | Azure Cost Management | `commercial_terms` |
| `Ingest_Studio` | Power Platform exports, and optionally files saved from the licensing API | `studio_*` |
| `Ingest_Org` | Viva attributes, optionally enriched by an Entra export | `org_attributes` |
| `Ingest_Org_Graph` | Microsoft Entra ID, through Microsoft Graph | `copilot_org_data` |
| `Ingest_Viva_Consumption` | Legacy Viva CSV fallback, the Dataflow's `viva_credits_dataflow` table, and optional Cowork task export | `viva_credits_weekly`, `viva_spending_policy`, `cowork_tasks_weekly` |

`Ingest_Studio` is the supported way to load Copilot Studio data. Use it. It can also read daily
per-agent and per-user files that a Power Automate flow saves from the Power Platform licensing API
(`StudioApi*.csv`, in `Files/landing/studio/`). That's off by default (`READ_API_FILES = False`),
and no flow in this repository saves those files yet.

There is also an `Ingest_Studio_Consumption` notebook in that folder which reads
the Power Platform licensing API instead of the export. **A scheduled Fabric
refresh cannot authenticate to that API at all** — the permission it needs
exists only as a delegated one, so there is no way to run it unattended here.
It is kept for interactive use only; see [experimental/](../experimental/README.md).

The one route that ran the licensing API on a schedule was
[Power Automate + Dataverse](../archive/4.%20Power%20Automate%20%2B%20Dataverse/README.md), where the
flow signs in as its admin owner and that delegated sign-in is available. That route is now archived
and unsupported.

`Ingest_Azure_AI` needs an Entra app registration and Key Vault secret before it will run —
**[setup →](../docs/ADVANCED-SETUP.md#azure-ingestion-in-fabric)**. Leave it out and the Foundry page
is simply empty, which is supported. It also records Copilot Studio and Cowork pay-as-you-go billed
to `SUBSCRIPTION_ID` in `copilot_payg_spend`; list any other subscriptions your Power Platform
billing policies use in `PAYG_SUBSCRIPTION_IDS`. The template doesn't read that table yet.

`Ingest_Org_Graph` needs an app registration with the Microsoft Graph `User.Read.All` application
permission, admin-consented — see [Department breakdowns](#department-breakdowns).

**[Where each export comes from →](../docs/DATA-SOURCES.md)**

### 4. Open the template

Lakehouse → **Settings** → **SQL analytics endpoint** → copy the connection string.

Open **`Consumption Central - Fabric.pbit`** and paste in:

| | |
|---|---|
| **`FabricSQLEndpoint`** | The string you just copied |
| **`LakehouseName`** | Your Lakehouse name |

Everything else has a default.

### 5. Publish and schedule

Publish to your workspace, then schedule **ingestion before semantic-model refresh** — refresh only
on ingestion **success**, and never on failure or while a writer is running. A Power BI refresh
alone does not call Azure or run notebooks.

**Tuesday morning** works well for Viva, after its weekend refresh. Azure can run daily on its own
schedule.

---

## Try it with sample data first

**[seed_sample_data.py](seed_sample_data.py)** loads the synthetic dataset straight into your
Lakehouse — no exports, no waiting.

```
pip install pandas deltalake requests
az login --tenant <your-tenant>
python seed_sample_data.py --workspace <guid> --lakehouse <guid>
```

Both GUIDs are in the Fabric portal URL with the Lakehouse open. It only touches the Consumption
Central tables.

---

## Department breakdowns

**Automatic by default.** The template derives employee attributes from `viva_credits_weekly` — no
separate org file or `org_attributes` table is required. Just include the employee attributes in
the Viva query and keep them when landing the data.

`Ingest_Org` is optional: run it to materialise the organisation table for reuse, or to apply a
separate Entra export.

`Ingest_Org_Graph` is the unattended route when the Viva query carries few attributes, or none. It
reads every user in Microsoft Entra ID through Microsoft Graph into `copilot_org_data`: department,
job title, company, location and manager. The template prefers that table over `org_attributes`,
keeps only the people on the licensed roster, and lets Viva's attributes fill any gaps. It needs an
app registration with the `User.Read.All` application permission, admin-consented; keep its client
secret in Key Vault.

---

## Optional Cowork tasks

Place each `CoworkWeeklyMetrics.csv` and its matching `PeopleMetaData.csv` in a separate subfolder
under `Files/landing/viva/`, then run `Ingest_Viva_Consumption`. Task-only exports are supported;
task counts/credits upsert separately and never become additional billing consumption. If the
optional table is absent, existing reports still refresh and the task page explains the empty state.
Only task files and companions are discovered recursively, excluding directories starting with
`_` or `.`. Legacy `PersonServiceCreditsMetrics` and `SpendingPolicyMetadata` CSVs must remain
at the landing folder's top level; existing dated or `old/` subfolders are not ingested as billing.

The existing Viva connector/Dataflow route remains supported for consumption. It is not assumed
to produce this separate task export automatically. See the [task guide](../docs/COWORK-TASKS.md)
and [table contract](docs/DATA-DICTIONARY.md#cowork_tasks_weekly).

## Reference

| | |
|---|---|
| [Table contracts](docs/DATA-DICTIONARY.md) | Every table and column the model expects |
| [Advanced setup](../docs/ADVANCED-SETUP.md) | Azure notebook auth, collection behaviour, scheduling |
| [Automating the landing step](flows/) | Power Automate, if you'd rather not use notebooks |
| [Installer asset manifest](../CONTRIBUTING.md#installer-asset-manifest) | What the installer deploys from this folder, and the settings it edits in each notebook |
