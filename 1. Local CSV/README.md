# 1. Local CSV

**The quickest way to see it working.** Download your exports, put them in a folder, open the
template.

Works with Power BI Pro — no Fabric capacity needed. Bring whichever products you have; missing ones
just leave their pages empty.

---

## Three steps

### 1. Make a folder

Anywhere. `C:\Consumption Central\Data` is fine.

### 2. Put your data in it

Two of the four pull themselves. Run these and they write straight into the
folder:

```bash
python pull_studio.py   "C:\Consumption Central\Data"
python pull_azure_ai.py "C:\Consumption Central\Data"
```

Both use your existing `az login` — neither asks for a secret.

The other two are downloads:

| Product | Where to get it |
|---|---|
| **Cowork / Work IQ** | Viva Insights → Analysis → build a query → download CSV |
| **GitHub Copilot** | GitHub → Billing → AI usage report |

File names don't have to match exactly — the template recognises the usual
variations.

**[Full click-paths and permissions →](../docs/DATA-SOURCES.md)** ·
**[No API access? Export by hand →](../fallback/)**

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

## Next steps

- **Schedule the two pullers** so the folder stays current without you.
  **[How →](../docs/ADVANCED-SETUP.md#automating-azure-collection)**
- **Want the Studio per-user page?** That one has no API. Export it by hand —
  **[steps →](../fallback/#copilot-studio--per-user)**
- **Outgrown a folder?** **[2. Fabric](../2.%20Fabric/)** collects straight into Lakehouse tables and
  keeps history beyond Viva's 6-month export window.
