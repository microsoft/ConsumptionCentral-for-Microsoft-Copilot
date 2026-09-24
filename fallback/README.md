# Fallback: manual exports

Everything here is the **second** choice. Each path now pulls what it can from
an API — see the setup steps in [1. Local CSV](../1.%20Local%20CSV/),
[2. Fabric](../2.%20Fabric/), [3. Viva Direct](../3.%20Viva%20Direct/) or
[4. Power Automate + Dataverse](../4.%20Power%20Automate%20%2B%20Dataverse/).

Use these steps when the API route is not open to you: no admin consent, no
service principal, an air-gapped tenant, or you just want a one-off look.

The files land in the same folder the templates already read, so nothing else
changes.

---

## Copilot Studio — tenant and per-agent

**The API covers this.** Run
[`pull_studio.py`](../1.%20Local%20CSV/pull_studio.py) instead if you can.

To export by hand:

1. [Power Platform admin centre](https://admin.powerplatform.microsoft.com)
2. **Licensing** → **Copilot Studio**
3. **Consumption** tab → **Download**
4. **Agents** tab → **Download**

Save them as `StudioTenantDaily.csv` and `StudioPerAgent.csv`.

Exact file names do not matter — the templates recognise the usual variations.

> The admin centre gives you a **monthly aggregate**. The API gives a daily
> figure. If you want the daily trend to show anything, you need the API.

---

## Copilot Studio — per user

**No API exists for this one.** It is a manual export on every path, including
the automated ones.

1. Power Platform admin centre → **Licensing** → **Copilot Studio**
2. **Users** tab → **Download**

Save as `StudioPerUser.csv`.

Skip it if you do not need the per-user page. Nothing else breaks.

---

## Azure AI Foundry

**The API covers this.** Run
[`pull_azure_ai.py`](../1.%20Local%20CSV/pull_azure_ai.py) instead if you can.

To export by hand:

1. Azure portal → **Cost Management** → **Cost analysis**
2. Filter to your AI services
3. **Export** → **Download as CSV**

Save as `AzureAiSpendDaily.csv`.

The token, deployment-health and reconciliation files have no manual
equivalent — they are built from metrics the portal does not export in one
piece. Without the script those pages stay empty.

---

## GitHub Copilot

1. GitHub → your enterprise or organisation → **Settings** → **Billing**
2. **AI usage report** → **Download**

Save as `GitHubAiUsage.csv`.

`GitHubUserMap.csv` is yours to write — it maps GitHub usernames to people and
cost centres. There is no export for it. The columns are in
[sample-data](../1.%20Local%20CSV/sample-data/GitHubUserMap.csv).

---

## Cowork / Work IQ

1. Viva Insights → **Analysis** → build a query with the Copilot credit metrics
2. **Analysis results** → your query → **Download**

[3. Viva Direct](../3.%20Viva%20Direct/) connects to this live and needs no
download at all.

> Leave the GitHub Copilot credit metric out of the query. It makes the query
> fail in Viva Insights before Power BI is involved.

---

## Org attributes

`entra_org.csv` maps `UserPrincipalName` to `Department`, `Organisation` and
`JobTitle`. Export it from Entra ID, or ask whoever owns your directory.

Only needed for department breakdowns. **[More →](../docs/ORG-DATA.md)**

---

**[Full click-paths, permissions and column detail →](../docs/DATA-SOURCES.md)**
