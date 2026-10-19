# 1. Local CSV

**The quickest way to see it working.** Download your exports, put them in a folder, open the
template.

Works with Power BI Pro — no Fabric capacity needed. Bring whichever products you have; missing ones
just leave their pages empty.

---

## Three steps

### 1. Make a folder

Anywhere. `C:\Consumption Central\Data` is fine.

### 2. Put your exports in it

| Product | Where to get it |
|---|---|
| **Cowork / Work IQ** | Viva Insights → Analysis → build a query → download CSV |
| **Copilot Studio** | Power Platform admin centre → Licensing → Copilot Studio |
| **GitHub Copilot** | GitHub → Billing → AI usage report |
| **Azure AI Foundry** | Azure Cost Analysis → export, or run [`pull_azure_ai.py`](pull_azure_ai.py) |

File names don't have to match exactly — the template recognises the usual variations.

**[Full click-paths and permissions →](../docs/DATA-SOURCES.md)**

### 3. Open the template

Open **`Consumption Central - Local CSV.pbit`**, paste your folder path into `DataFolder`, click
**Load**.

That's it.

---

## Try it with sample data first

The **[sample-data](sample-data/)** folder holds a synthetic dataset covering all four products.
Point `DataFolder` at it and the whole report fills in — no exports needed.

---

## Parameters

| | |
|---|---|
| **`DataFolder`** | Your folder path — the only one that matters |
| Everything else | Has a sensible default. Leave it |

<details>
<summary>The optional ones, if your pricing differs</summary>

| | Default | Change it when |
|---|---|---|
| `CreditRate` | $0.01 | Your agreement isn't list price |
| `PrepaidCreditRate` | $0.008 | You bought credits up front |
| `PrepaidCreditBalance` | 0 | You have a prepaid balance |
| `GitHubBusinessSeatPrice` | $19 | Your GitHub pricing differs |
| `GitHubEnterpriseSeatPrice` | $39 | As above |
| `BillingPeriodWeeks` | 4 | Your billing period isn't monthly |

**[Where to find your real rates →](../docs/COMMERCIAL-TERMS.md)**

</details>

---

## Department breakdowns

If your Viva query includes department or job title, they appear automatically. If it doesn't, add
them to the query in Viva Insights and re-run — easier than supplying a separate file.

**[More on org data →](../docs/ORG-DATA.md)**

---

## Optional task categories

Add `CoworkWeeklyMetrics.csv` and its own `PeopleMetaData.csv` in a separate export subfolder
beneath `DataFolder`. The new **2.1. Cowork: Tasks** page works with task-only data, while older
exports without tasks still work. Do not replace the legacy metrics or their metadata companion.
See [task fields, empty states and editable value assumptions](../docs/COWORK-TASKS.md).

## Next steps

- **Automate the Azure export** — schedule [`pull_azure_ai.py`](pull_azure_ai.py) instead of
  downloading by hand. **[How →](../docs/ADVANCED-SETUP.md#automating-azure-collection)**
- **Outgrown a folder?** **[2. Fabric](../2.%20Fabric/)** collects straight into Lakehouse tables and
  keeps history beyond Viva's 6-month export window.
