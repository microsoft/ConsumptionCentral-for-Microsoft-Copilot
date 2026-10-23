# 3. Viva Direct

**Cowork data with no download.** Connect straight to Viva Insights and let it refresh itself. The
other products and policy names still come from files, which are optional.

---

## Two things to paste

In Viva Insights:

1. **Create analysis** → **Create custom query** → **Consumption query** → turn on
   **Auto-refresh** → **Run**
2. **Analysis results** → your query → the **link icon**
3. Copy the two identifiers

**[Step-by-step: building and running the query →](../docs/VIVA-QUERY.md)**

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

Set **`DataFolder`** to a folder holding whatever exports you have. Files are found by name, so
nothing needs renaming and anything you don't have is skipped.

| Product | Files it looks for |
|---|---|
| Copilot Studio | `StudioTenantDaily`, `StudioPerAgent`, `StudioPerUser` |
| GitHub Copilot | `GitHubAiUsage`, `GitHubUserMap` |
| Azure AI Foundry | `AzureAiSpendDaily`, `AzureAiTokensDaily` |
| Org attributes | `entra_org.csv` — for department breakdowns |

Leave `DataFolder` blank for consumption-only reporting. Leave pricing parameters at their defaults.

**[Where to get each one →](../docs/DATA-SOURCES.md)** ·
**[Automating the Azure files →](../docs/ADVANCED-SETUP.md#automating-azure-collection)**

---

## Reading the files from SharePoint *(optional)*

One query, **`SourceFiles`**, lists every file the template reads. As shipped it reads a local
`DataFolder`. Swap in the SharePoint form and the same files come from a SharePoint folder instead,
so nothing reads a local file and a report published to the Power BI service can refresh on its own.

1. **Transform data** → select **`SourceFiles`** → **Advanced Editor**
2. Replace its text with the contents of [`SourceFiles.SharePoint.m`](SourceFiles.SharePoint.m) → **Done**
3. **Manage Parameters** → set the two below → **Close & Apply**
4. When asked, sign in to the site with an **Organizational account**. If asked for a privacy level,
   choose **Organizational**.

| | |
|---|---|
| **`SharePointSiteUrl`** | The site, such as `https://contoso.sharepoint.com/sites/ConsumptionCentral`. No library, folder or page. |
| **`DataFolder`** | The folder, such as `https://contoso.sharepoint.com/sites/ConsumptionCentral/Shared Documents/Consumption Central` |

`DataFolder` also takes the address bar while you're viewing the folder, encoded or not, or a path
inside the site such as `Shared Documents/Consumption Central`. `/` and `\` both work, and a trailing
slash makes no difference. It refuses a local or network path, and a sharing link
(`https://…/:f:/s/…`): open the link and copy the address bar instead.

Files are still found by name, in the folder or any subfolder. Put `entra_org.csv` at the top of the
folder: when two files match, the one nearer the top wins, then the newer.

**Give it a site of its own.** `SharePoint.Files` lists every file in the site before keeping the
ones under `DataFolder`, so a busy site refreshes slowly.
[`SourceFiles.SharePoint.Contents.m`](SourceFiles.SharePoint.Contents.m) opens the folder by name
instead and should be faster, but hasn't been tested on a live site yet. If it reports *found no
folder with this name*, go back to the supported form.

If an address is wrong, the file-based pages come back blank, the task page says
`Task folder unavailable`, and the Viva pages still refresh. Select **`SourceFiles`** in Transform
data to see why.

---

## Department breakdowns need a directory CSV

Plan to supply one. Put `entra_org.csv` in your `DataFolder` with `UserPrincipalName` and the
attributes you want to group by — `Department`, `Organisation`, `JobTitle`. The identities must
match the consumption data.

Selecting attributes in the query UI does not guarantee the connector returns them, so check the
actual output before relying on a query-only setup.

[PAX](https://github.com/microsoft/PAX) can write this file on a schedule, straight into a local or
SharePoint `DataFolder`.

**[Detail and edge cases →](../docs/ADVANCED-SETUP.md#org-attributes-on-viva-direct)** ·
**[Exporting it with PAX →](../docs/ORG-DATA.md#exporting-with-pax)**

---

## Policy names need one file

The connector gives you the policy **id** and its limits, but not the **name** — so unnamed policies
show as `Policy f1a2bfe2 — name not in export`.

To get the real names: Viva Insights → **Analysis results** → your query → **Download**, then drop
**`M365SpendingPolicyMetaData.csv`** into your `DataFolder`. Nothing else from that ZIP is needed.
The names appear on the next refresh.

---

## Optional Cowork task breakdown

Keep the existing Viva custom query for consumption. To populate **2.1. Cowork: Tasks**, use the
optional `DataFolder` CSV route with `CoworkWeeklyMetrics.csv` and its matching `PeopleMetaData.csv`
in one export subfolder. No additional query ID is required or assumed to expose task categories.
Without the task file, the new page is blank and the existing query/pages are unchanged.

An inaccessible optional folder displays `Task folder unavailable; check DataFolder and folder access.`
on the task page without failing connector-only refreshes. Errors reading a discovered task file
still fail refresh, as do Viva connector failures.
See [supported fields, empty states and provisional value assumptions](../docs/COWORK-TASKS.md).

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
