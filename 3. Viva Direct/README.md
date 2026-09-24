# 3. Viva Direct

**Cowork data with no download.** Connect straight to Viva Insights and let it refresh itself. The
other products and policy names still come from files, which are optional.

---

## Two things to paste

In Viva Insights:

1. **Analysis** → build a query with the Copilot credit metrics → turn on **Auto-refresh**
2. **Analysis results** → your query → the **link icon**
3. Copy the two identifiers

Open **`Consumption Central - Viva Direct.pbit`**, paste them in, click **Load**.

| | |
|---|---|
| **`VivaPartitionId`** | Partition identifier |
| **`VivaQueryId`** | Query identifier |

> **Leave the GitHub Copilot credit metric out of the query.** It makes the query fail in Viva
> Insights before Power BI is involved. Take GitHub usage from the GitHub export instead.

> **Build your own query under Analysis.** The Consumption Dashboard's "Connect data" dialog also
> hands out identifiers, but they point at a multi-table result this template can't request.

---

## Adding the other products *(optional)*

Set **`DataFolder`** to a folder holding whatever you have. Files are found by name, so nothing needs
renaming and anything you don't have is skipped.

**Copilot Studio and Azure pull themselves.** Point both scripts at that same folder:

```bash
python "../1. Local CSV/pull_studio.py"   "C:\Consumption Central\Data"
python "../1. Local CSV/pull_azure_ai.py" "C:\Consumption Central\Data"
```

They use your existing `az login` and write the files this template already reads, so there is
nothing to wire up. Schedule them and the Studio and Azure pages stay current alongside the live
Cowork feed.

The rest are downloads:

| Product | Files it looks for |
|---|---|
| Copilot Studio | `StudioTenantDaily`, `StudioPerAgent` — from `pull_studio.py` |
| Copilot Studio *(per user)* | `StudioPerUser` — **no API**, export by hand |
| GitHub Copilot | `GitHubAiUsage`, `GitHubUserMap` |
| Azure AI Foundry | `AzureAiSpendDaily`, `AzureAiTokensDaily` — from `pull_azure_ai.py` |
| Org attributes | `entra_org.csv` — for department breakdowns |

Leave `DataFolder` blank for consumption-only reporting. Leave pricing parameters at their defaults.

**[Where to get each one →](../docs/DATA-SOURCES.md)** ·
**[No API access? Export by hand →](../fallback/)**

---

## Department breakdowns need a directory CSV

Plan to supply one. Put `entra_org.csv` in your `DataFolder` with `UserPrincipalName` and the
attributes you want to group by — `Department`, `Organisation`, `JobTitle`. The identities must
match the consumption data.

Selecting attributes in the query UI does not guarantee the connector returns them, so check the
actual output before relying on a query-only setup.

**[Detail and edge cases →](../docs/ADVANCED-SETUP.md#org-attributes-on-viva-direct)**

---

## Policy names need one file

The connector gives you the policy **id** and its limits, but not the **name** — so unnamed policies
show as `Policy f1a2bfe2 — name not in export`.

To get the real names: Viva Insights → **Analysis results** → your query → **Download**, then drop
**`M365SpendingPolicyMetaData.csv`** into your `DataFolder`. Nothing else from that ZIP is needed.
The names appear on the next refresh.

---

## If the refresh fails

**`(500) Internal Server Error`** means the connector was asked for a multi-table export without a
table name. Check that `VivaPartitionId` and `VivaQueryId` point at a **custom query** built in
Analysis, not at a Consumption Dashboard export.

**[Connector reference →](../docs/VIVA-CONNECTOR.md)** ·
**[Test procedure →](TEST-PROCEDURE.md)**

---

## Worth knowing

Microsoft ships its own Power BI template from the same dialog, covering Cowork consumption with
first-party support. This is a different proposition: four products in one report, with cost,
optimisation and forecast across all of them. Download both and see which you'd rather have.
