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

1. Viva Insights → **Analysis** → build a query with the Copilot credit metrics → **Analysis
   results** → your query → the **link icon**. Copy the **Partition identifier** and **Query
   identifier**.
2. Fabric workspace → **New** → **Dataflow Gen2** → **Get data** → search *Viva Insights* under
   **Online Services**.
3. Paste both identifiers. Leave *Query Name* blank. Under **Advanced options** set **Schema Type =
   Pivoted** and **Data Granularity = Row-level data**. Authenticate with an **Organizational
   account**.
4. Set the Lakehouse as the destination and name the table `viva_credits_weekly`. Keep the person
   identifiers, metric columns and employee attributes. Schedule the refresh for **Tuesday ~8am
   PST**, after Viva's weekend refresh.

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
| `Ingest_Azure_AI` | Azure Cost Management + Monitor | `azure_ai_spend`, `azure_ai_tokens` |
| `Ingest_CommercialTerms` | Azure Cost Management | `commercial_terms` |
| `Ingest_Studio_Consumption` | Power Platform licensing API | `studio_consumption_*` |
| `Ingest_Studio` | *Fallback only* — Power Platform exports | `studio_*` |
| `Ingest_Org` | Viva attributes, optionally enriched by an Entra export | `org_attributes` |
| `Ingest_Viva_Consumption` | *Fallback only* — Viva CSV export | `viva_credits_weekly`, `viva_spending_policy` |

> **Use `Ingest_Studio_Consumption` for Copilot Studio.** It reads the licensing API, so there is
> nothing to download, and it gets a **daily** figure the admin-centre export does not have.
> `Ingest_Studio` is still there for the per-user file, which has no API, and for tenants where the
> API is not open. The two write different tables, so running both is fine.

`Ingest_Azure_AI` needs an Entra app registration and Key Vault secret before it will run —
**[setup →](../docs/ADVANCED-SETUP.md#azure-ingestion-in-fabric)**. Leave it out and the Foundry page
is simply empty, which is supported.

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

---

## Reference

| | |
|---|---|
| [Table contracts](docs/DATA-DICTIONARY.md) | Every table and column the model expects |
| [Advanced setup](../docs/ADVANCED-SETUP.md) | Azure notebook auth, collection behaviour, scheduling |
| [Automating the landing step](flows/) | Power Automate, if you'd rather not use notebooks |
