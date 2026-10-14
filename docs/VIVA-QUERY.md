# Running the Viva Insights query

Paths **[2. Fabric](../2.%20Fabric/)** and **[3. Viva Direct](../3.%20Viva%20Direct/)** read Cowork /
Work IQ credits straight from a Viva Insights **consumption query**. You build it once, turn on
auto-refresh, and hand its two identifiers to the template. This page is the whole procedure.

**[1. Local CSV](../1.%20Local%20CSV/)** doesn't need a query: it reads the Consumption Dashboard's
CSV export instead. See [Data sources](DATA-SOURCES.md#1-cowork--work-iq-credits--viva-insights-consumption-dashboard).

> **Build the query under Create analysis, not from the Consumption Dashboard.** The dashboard's
> **Connect data** dialog also hands out identifiers, but they point at a multi-table result these
> templates can't request, and the refresh fails with a `(500)` error.

---

## Before you start

| | |
|---|---|
| **Role** | Viva Insights **Insights Analyst** |
| **Licence** | As for the [Consumption Dashboard](DATA-SOURCES.md#where) |
| **Per-person views** *(optional)* | Turn on [Viva identification](../README.md#viva-identification) **before** you run the query. It takes up to 24 hours, and results produced before then are not re-keyed |

---

## 1. Create the query

Viva Insights web app (<https://analysis.insights.cloud.microsoft>) → **Create analysis** →
**Create custom query** → **Consumption query**.

Under **Query setup**:

| Setting | Set to | Why |
|---|---|---|
| **Name** | Something findable, e.g. `ConsumptionCentral_Weekly` | You'll look for it in **Analysis results** |
| **Time period** | The longest **rolling** period offered, not a custom date range | A fixed range never moves forward, so auto-refresh has nothing new to fetch |
| **Auto-Refresh** | **On** | Without it the connector reads the same result forever |
| **More settings → Group by** | **Week** *(the default)* | Every Cowork page is built on weekly grain |

## 2. Keep the preselected metrics

The consumption query adds four metrics for you. **Keep all four**:

- Total Copilot Credits used
- Session count
- User limit
- Spending policy limit

> **Don't add a GitHub Copilot credit metric** if your tenant offers one. It makes the query fail in
> Viva Insights. Take GitHub usage from the [GitHub export](DATA-SOURCES.md#3-github-copilot-ai-credits)
> instead. [Detail →](VIVA-CONNECTOR.md#the-github-copilot-credit-metric-breaks-the-query)

## 3. Leave the population unfiltered

Add **no conditions**. Filtering by organisation or service here makes the report's totals disagree
with your bill. Filter in the report instead.

## 4. Add the attributes you want to group by *(optional)*

**Select attributes** → tick the employee attributes you want as Group By options (for example
Organization, Function, Level, Region) → **Add to query**.

Ticking them doesn't guarantee the connector returns them. Check the output after the first run;
if they're missing or blank, supply a directory CSV.
[Department breakdowns →](ORG-DATA.md)

## 5. Run it

Select **Run**, top right. The query appears in **Analysis results** as **Running**, then
**Success**. Nothing can connect to it until it reaches **Success**.

## 6. Copy the two identifiers

**Analysis results** → your query → the **link icon** → copy:

| Viva calls it | You'll paste it as |
|---|---|
| **Partition identifier** | `VivaPartitionId` (Viva Direct) / *Partition Identifier* (Fabric Dataflow) |
| **Query identifier** | `VivaQueryId` (Viva Direct) / *Query Identifiers* (Fabric Dataflow) |

## 7. Give them to your path

| Path | Where they go |
|---|---|
| **3. Viva Direct** | Open the `.pbit`, paste into `VivaPartitionId` and `VivaQueryId`, **Load**. [Steps →](../3.%20Viva%20Direct/README.md#two-things-to-paste) |
| **2. Fabric** | A Dataflow Gen2 with the Viva Insights connector, writing to the Lakehouse. [Steps →](../2.%20Fabric/README.md#viva-dataflow) |

Wherever you paste them: leave **Query Name** and **Table name** blank, set **Schema Type =
Pivoted** and **Data Granularity = Row-level data**, and sign in with an **Organizational account**.

**Policy names** don't come through the connector. On Viva Direct, download the query's ZIP from
**Analysis results** and drop `M365SpendingPolicyMetaData.csv` into your `DataFolder`.
[Why →](VIVA-CONNECTOR.md#the-csv-export-and-the-connector-are-not-the-same-surface)

---

## Keeping it running

- **Viva refreshes over the weekend.** Schedule the Power BI or Dataflow refresh for **Tuesday
  morning** (around 8am PST), after the query has picked up the new week.
- **Only the analyst who ran the query can edit, rename or delete it.** If they leave or lose the
  role, someone else **clones** it, runs the clone with auto-refresh on, and the template gets the
  clone's identifiers.
- **After changing a query**, check the link icon again and update the identifiers if they differ.
- **Using Privileged Identity Management?** The Insights Analyst role may need re-elevating, and the
  connection's credentials refreshing, before scheduled refreshes succeed.

---

## If it goes wrong

| What you see | Cause | Fix |
|---|---|---|
| No link icon | The query hasn't reached **Success** | Wait, or rerun it from **More options** |
| Status **Failed** | Usually a GitHub Copilot credit metric in the query | Remove it and rerun |
| `(500) Internal Server Error` on refresh | Identifiers from the Consumption Dashboard's **Connect data** dialog | Use a consumption query from **Create analysis** |
| Refresh succeeds but the latest week never appears | Auto-refresh is off, or the time period is a fixed range | Turn on **Auto-refresh** in **Analysis results**; use a rolling period |
| `PersonId` hashes, no UPNs | Identification is off, or the query ran before it took effect | Turn it on, wait up to 24 hours, rerun the query |
| No department or organisation options | Attributes not selected, or not returned | Select them (step 4) or add `entra_org.csv`. [Detail →](ORG-DATA.md) |
| Policies show as `Policy f1a2bfe2 — name not in export` | The connector doesn't serve policy names | Add `M365SpendingPolicyMetaData.csv` (step 7) |

**[Connector reference →](VIVA-CONNECTOR.md)** ·
**[Microsoft: Create a custom consumption query ↗](https://learn.microsoft.com/en-us/viva/insights/advanced/analyst/ai-cost-query)** ·
**[Microsoft: Analysis results ↗](https://learn.microsoft.com/en-us/viva/insights/advanced/analyst/query-results)**
