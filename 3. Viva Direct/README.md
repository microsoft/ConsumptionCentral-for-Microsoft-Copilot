# 3. Viva Direct

**No files at all.** Connect straight to Viva Insights and let it refresh itself.

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

**Leave everything else blank.** The prompt lists more boxes than you need — the rest are for
Copilot Studio, GitHub and Azure AI, which are optional.

---

## Only the custom query is supported

The connector can read two shapes, but this template targets the **custom query** you build in
Analysis. That is the shape that auto-refreshes, and it returns a single table — so no table name is
ever sent, and there is no parameter to get wrong.

A Consumption Dashboard export is multi-table and needs its export name supplied with the request.
The dialog never shows you that name, so the parameter was unanswerable in practice and has been
removed. If you have only a Dashboard export, build a custom query instead.

**[Full connector reference →](../docs/VIVA-CONNECTOR.md)**

---

## Department breakdowns

**Add them to your Viva query.** Under *"Select spending policy and employee attributes"*, tick
Department, Job title, Manager — whatever you want to slice by. They flow through automatically.

That's easier and more reliable than supplying a separate file, because the attributes always match
the people in the data.

<details>
<summary>If you can't change the query</summary>

Drop a directory export from the Microsoft Entra admin centre (Users → Download users) into your
`DataFolder`. It's a fallback: Viva's own attributes are always used first when present.

**[More on org data →](../docs/ORG-DATA.md)**

</details>

---

## Adding the other products

Optional. Set **`DataFolder`** to a folder holding whatever exports you have and drop the files in —
they're found by name, so nothing needs renaming and anything you don't have is skipped.

| Product | Files it looks for |
|---|---|
| Copilot Studio | `StudioTenantDaily`, `StudioPerAgent`, `StudioPerUser` |
| GitHub Copilot | `GitHubAiUsage`, `GitHubUserMap` |
| Azure AI Foundry | `AzureAiSpendDaily`, `AzureAiTokensDaily` |
| Org attributes | `entra` / `orgdata` / `users` — only if you can't add them to the Viva query |

Leave `DataFolder` alone if all you have is Cowork. The connector covers it and those pages simply
stay empty, which is a supported state.

> Azure AI Foundry files live in `DataFolder` alongside everything else. The separate
> `AzureAiSpendCsvPath` / `AzureAiTokensCsvPath` parameters have been removed — one product having
> its own path parameters while the other three were found by name was inconsistent, and the folder
> lookup already handles them.

**[Where to get each one →](../docs/DATA-SOURCES.md)**

---

## If the refresh fails

**`(500) Internal Server Error`** means the connector was asked for a multi-table export without a
table name. This template only issues single-table custom-query requests, so if you see it, check
that `VivaPartitionId` and `VivaQueryId` point at a **custom query** built in Analysis rather than at
a Consumption Dashboard export.

**[Connector detail and what was tested →](../docs/VIVA-CONNECTOR.md)**

---

## Worth knowing

Microsoft ships its own Power BI template from the same dialog. It covers Cowork consumption with
first-party support.

This is a different proposition: four products in one report, with cost, optimisation and forecast
across all of them. Download both and see which you'd rather have.
