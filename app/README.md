# Consumption Central: App Edition

A Copilot Managed App version of the Consumption Central Power BI report. It shows the same measures, charts and tables as the report, using the same DAX definitions. The layout is simpler: the 24 report pages become six tabs with short sub-views.

Everything runs in the browser. The app reads your CSV exports locally and calculates every metric on the page, and no data is sent anywhere.

## Tabs

| Tab | Views | Power BI pages it replaces |
|---|---|---|
| Overview | — | 0. Overall: Combined |
| Cowork & Work IQ | Consumption, Cost, Tasks, Optimization, Forecast | 1. Cowork: Consumption, 2. Cowork: Cost, 2.1. Cowork: Tasks, 3. Cowork: Optimization, 4. Cowork: Forecast |
| Copilot Studio | Consumption, Cost, Optimization, Forecast | 5–8. Studio: Consumption, Cost, Optimization, Forecast |
| GitHub Copilot | Consumption, Cost, Optimization, Forecast | 11–14. GHCP: Consumption, Cost, Optimization, Forecast |
| Azure AI Foundry | Spend, Capacity & health, Reconciliation | 9. Azure: Spend & Consumption, 10. Azure: Capacity & Health, 10.1. Billing: Reconciliation |
| Guide | Start here, How to read, Cowork, Studio, GitHub, Azure, Glossary | Start here, How to read this, the four product "How to read" pages, Glossary |

How the controls work:
- The toolbar filters match each Power BI page's slicers, such as period, service, spending policy, agent, cost centre, model, subscription and billing pool. They apply to the tab you are on.
- Each metric has an info button that shows its glossary definition.
- Report parameters live under **Rates** in the header: credit rates, the prepaid pack balance, GitHub seat prices, included credits and the allowance change date.

The Guide's **About this app edition** section lists the presentation changes from Power BI. For example, treemaps, funnels and donuts become ranked bars. The values are unchanged.

## Data

Click **Change data** in the header and drop in any of the Local CSV path's exports (see [`1. Local CSV`](../1.%20Local%20CSV/) and [docs/DATA-SOURCES.md](../docs/DATA-SOURCES.md)). The app works out each file's type from its column headers, so the file names don't matter.

| Source | Example file | Detected by |
|---|---|---|
| Cowork credits | `PersonServiceCreditsMetrics.csv` | `Total Copilot Credits used`, or `MetricDate` + `ServiceName` |
| Cowork tasks | `CoworkWeeklyMetrics.csv` | `Total Cowork tasks`, or `TaskCategory` + `MetricDate` |
| People metadata | `PeopleMetaData.csv`, `CoworkTaskPeopleMetaData.csv` | `PeopleHistoricalId` without `PersonId` |
| Spending policies | `SpendingPolicyMetadata.csv` | `SpendingPolicyId` + `PlanLimit` |
| Person–policy map | `PersonPolicyMap.csv` | `PersonId` + `SpendingPolicyId` |
| Copilot Studio tenant | `StudioTenantDaily.csv` | `Prepaid Consumed Quantity` or `Entitled Quantity` |
| Copilot Studio agents | `StudioPerAgent.csv` | `Billed credit` or `Non-billed credit` |
| Copilot Studio users | `StudioPerUser.csv` | `Billable credit(s) used` |
| GitHub AI usage | `GitHubAiUsage.csv` | `username` + `gross_amount` |
| GitHub user map | `GitHubUserMap.csv` | `username` + `plan` |
| Azure AI spend | `AzureAiSpendDaily.csv` | `MeterCategory` + `Cost`, or `UsageDate` + `Cost` + `ServiceName` |
| Azure solution spend | `AzureSolutionSpend.csv` | `ServiceCategory` + `ActualCost` |
| Azure deployment health | `AzureDeploymentHealth.csv` | `DeploymentId` + `PtuCapacity` |
| Azure billing reconciliation | `AzureBillingReconciliation.csv` | `Representation` + `PoolName` |
| Entra org attributes | `entra_org.csv` | A UPN or email column, plus department, job title, cost centre or country |

No source is required, and one is enough. Sources you don't supply show as "Not supplied" in the dialog, and their measures show a dash. Day-first dates are detected automatically.

A synthetic sample in `public/sample/` loads on first open and is clearly labelled as sample data. To rebuild it, run `npm run prepare-sample`. The script copies the synthetic files from `1. Local CSV/sample-data` and generates a synthetic Cowork task export for the same fictional people. In the sample, all Cowork credit usage sits in one department, as a single-department pilot. This matches the Power BI sample.

## Develop

```powershell
npm install
npm run dev       # local dev server
npm run lint
npm run build     # type-check and build to dist/
```

The code is organised like this:
- `src/data/`: CSV loading and header detection.
- `src/metrics/`: the DAX port, one file per product.
- `src/ui/`: the design kit.
- `src/pages/`: the tabs.

The design system is in [DESIGN.md](DESIGN.md) and the product brief is in [PRODUCT.md](PRODUCT.md).

## Deploy

The same build runs in two hosts. Pick one.

### As a Fabric App in a Fabric workspace

You need a workspace on Fabric capacity (F2 or larger, or a trial; *My workspace* won't work) and the **Fabric Apps (preview)** tenant setting turned on. The project config is [`rayfin/rayfin.yml`](rayfin/rayfin.yml). The app keeps no server-side data, so only auth and static hosting are on.

```powershell
npx rayfin up --dry-run
npx rayfin up --tenant <tenant-id> --workspace-id <workspace-id> -y
```

It prints the item's portal link. People need access to the item (share it, or give them a workspace role) to open it. To update, run `npx rayfin up` again. The deploy state it writes (`rayfin/.deployments.json`, `rayfin/.env`) is gitignored.

### As a Copilot Managed App

You need the `ms` CLI, signed in to the target tenant. `ms app init` writes `ms.config.json` with your tenant's app and environment IDs. The file is gitignored, so each deployer runs it once.

```powershell
ms app init -n "Consumption Central" --repo none -b ./dist -S "npm run build"   # add -e <environment-id> if environment lookup times out
ms app deploy
```
