# 2. Fabric

**Set it up once, then it refreshes itself.** Data lands in a Lakehouse; the report reads it on a
schedule.

Needs Fabric capacity, Premium, or PPU. Only have Power BI Pro?
Use **[1. Local CSV](../1.%20Local%20CSV/)**.

---

## Why bother

The Viva Insights export only reaches back **6 months**. Every week you don't capture is gone.

This path accumulates history in a table that outlives the export window — a year from now you have
a year of trend, not the same rolling six months.

---

## You only need one product

Load Cowork alone and its pages work. Studio only, or GitHub only — same. **Skip the notebooks for
products you don't have.**

---

## Setup

### 1. Create a Lakehouse

Fabric portal → your workspace → **New** → **Lakehouse**.

### 2. Import the notebooks

**Viva does not need one.** It has a certified **Dataflow Gen2** connector that writes query
results straight into your Lakehouse on a schedule — see [The Viva half needs no
notebook](#the-viva-half-needs-no-notebook) below. Set that up instead of
`Ingest_Viva_Consumption`, which exists as a fallback for downloaded CSVs.

For everything else: **[notebooks/](notebooks/)** — one per product. Import the ones you need, set
the workspace and Lakehouse at the top of each, run.

| Notebook | Reads | Writes |
|---|---|---|
| `Ingest_GitHub_API` | GitHub REST API | `github_*` |
| `Ingest_Azure_AI` | Azure Cost Management + Monitor | `azure_ai_spend`, `azure_ai_tokens` |
| `Ingest_CommercialTerms` | Azure Cost Management | `commercial_terms` |
| `Ingest_Studio` | Power Platform exports | `studio_*` |
| `Ingest_Org` | Entra export | `org_attributes` |
| `Ingest_Viva_Consumption` | *Fallback only* — Viva CSV export | `viva_credits_weekly`, `viva_spending_policy` |

**[Where each export comes from →](../docs/DATA-SOURCES.md)**


### 2b. Azure AI Foundry tables *(optional)*

The Foundry page reads two tables. Both are optional — leave them out and the page is simply empty,
which is a supported state, not a failure.

| Table | From | Columns |
|-------|------|---------|
| `azure_ai_spend` | Cost Management daily export | `UsageDate`, `ServiceName`, `Meter`, `ResourceName`, `ResourceGroup`, `Cost`, `UsageQuantity`, `Currency`, `DepartmentTag` |
| `azure_ai_tokens` | Azure Monitor metrics | `Date`, `ResourceName`, `ResourceGroup`, `Deployment`, `Metric`, `Value` |

The simplest route is a scheduled Cost Management export to ADLS, then a shortcut or copy into the
Lakehouse. See [docs/DATA-SOURCES.md](../docs/DATA-SOURCES.md#4-azure-ai-foundry) for the portal path
and the two naming traps that will otherwise cost you an afternoon.

### 3. Get the SQL connection string

Lakehouse → **Settings** → **SQL analytics endpoint** → copy it.

### 4. Open the template

Open **`Consumption Central - Fabric.pbit`** and paste in:

| | |
|---|---|
| **`FabricSQLEndpoint`** | The string you just copied |
| **`LakehouseName`** | Your Lakehouse name |

Everything else has a default.

### 5. Publish and schedule

Publish to your workspace, then set a refresh schedule. **Tuesday morning** works well — after
Viva's weekend refresh.

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

## The Viva half needs no notebook

Viva Insights ships a certified **Dataflow Gen2** connector that writes query results straight into a
Lakehouse on a schedule — no download, no notebook. **This is the preferred route on this path.**

1. Viva Insights → **Analysis** → build a query with the Copilot credit metrics → **Analysis
   results** → your query → the **link icon**. Copy the **Partition identifier** and **Query
   identifier**.
2. Fabric workspace → **New** → **Dataflow Gen2** → **Get data** → search *Viva Insights* under
   **Online Services**.
3. Paste both identifiers. Leave *Query Name* blank. Under **Advanced options** set **Schema Type =
   Pivoted** and **Data Granularity = Row-level data**. Authenticate with an **Organizational
   account**.
4. Set the Lakehouse as the data destination, then schedule the refresh for **Tuesday ~8am PST** —
   after Viva's weekend refresh.

> Leaving *Query Name* blank only works against a **custom query**, which returns a single table.
> Identifiers taken from the Consumption Dashboard's own export point at a multi-table result and
> need a table name supplied, which is why the credit query has to be one you built in Analysis.

> **Also turn on auto-refresh for the query itself**, in Viva Insights → Analysis results. Without
> it the Dataflow refreshes happily against a result that never changes — which looks exactly like
> everything working.

`Ingest_Viva_Consumption` remains for working from downloaded CSVs, or when Dataflow Gen2 capacity
cost is not worth it.

**[Microsoft's guide →](https://learn.microsoft.com/en-us/viva/insights/advanced/analyst/export-query-data-microsoft-fabric)**

---

## Reference

| | |
|---|---|
| [Table contracts](docs/DATA-DICTIONARY.md) | Every table and column the model expects |
| [Automating the landing step](flows/) | Power Automate, if you'd rather not use notebooks |
