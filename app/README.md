# Consumption Central app (preview)

The Consumption Central Power BI report as an app: the same measures and DAX definitions, with the 24 report pages in six tabs.

It runs in the browser. It reads your CSV exports locally, and no data is sent anywhere.

## Get the app

| Option | What you do | Best for |
|---|---|---|
| **Deploy it for your organisation** *(preview)* | Deploy it once as a Copilot Managed App with the `ms` command line, then share it. See [Deploy](#as-a-copilot-managed-app). | Teams. Viewers open it at [managedapps.cloud.microsoft](https://managedapps.cloud.microsoft) and need Power Apps Premium or Copilot Credits. |
| **Open it on your PC** | Open [`download/Consumption-Central-App.html`](download/Consumption-Central-App.html), choose **Download raw file**, then open the downloaded file in Edge or Chrome. | Trying it, or one person looking at the numbers. Works offline, with no deploy and no licence. |

Neither option needs a Power BI licence. Only the person deploying needs Node.js and Git.

The app opens with a labelled synthetic sample. Choose **Change data** and drop in your CSV exports (see [Data](#data)). The downloaded page is self-contained: the code, styles and sample are all inside it, and it makes no network calls.

On Microsoft Fabric, you can host the app as a [Fabric App](#as-a-fabric-app-alternative) instead, or get Consumption Central through [Analytics Hub for Microsoft Copilot](https://github.com/microsoft/AnalyticsHub-Dashboard).

## Deploy

Most people need only [Commands](#commands), after an admin turns on the [admin settings](#admin-settings). The main README's [Manual](../README.md#the-app) steps start here. The recommended host is a Copilot Managed App. A [Fabric App](#as-a-fabric-app-alternative) is the alternative.

### As a Copilot Managed App

*Preview.* Copilot Managed Runtime hosts the app in your tenant. Viewers open it from [managedapps.cloud.microsoft](https://managedapps.cloud.microsoft) with their work account. The app uses no connectors and stores nothing. It reads only the CSV files each viewer chooses, in that viewer's browser.

#### Admin settings

A Global Administrator or Power Platform Administrator turns on two settings once. Both are in the [Power Platform admin center](https://admin.powerplatform.microsoft.com) under **Copilot** › **Settings** › **Managed apps**, and both are off by default. Turn each one on for the environment group or environment you deploy to. Unless your organisation has set up its own environment routing, each maker deploys to a personal developer environment in the default environment group. If a group has a published rule for one of these settings, that rule overrides the setting on the group's environments, so change it on the group.

| Setting | Why the app needs it |
|---|---|
| **Allow app creation with the Copilot Managed Runtime command line interface (CLI)** | You create and deploy the app with the `ms` CLI. |
| **External artifacts in managed apps** | The CLI builds the app on your PC and uploads the result (`--repo none`), instead of building it in a platform-managed repo. |

Microsoft's guide: [governance settings for Copilot Managed Runtime](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/apps/governance).

#### Licensing

- **Deploying needs no licence.** The CLI creates, builds and deploys without one.
- **Everyone who opens the app needs a Power Apps Premium licence or Copilot Credits.** That includes you. The Power Apps rights included with Microsoft 365 or Dynamics 365 don't count, and sharing the app doesn't license anyone. No Microsoft 365 Copilot licence is needed.
- **Copilot Credits:** launching the app counts as an API call, at 0.1 credits each. Before people without Power Apps Premium can open it, an admin sets this up in the [Microsoft 365 admin center](https://admin.microsoft.com):
  1. Turn on usage-based billing for Copilot Credits.
  2. Create a spending policy for managed applications that includes the viewers or their groups.
  3. Set credit allocations and per-user limits as needed.

Microsoft's guide: [Copilot Managed Runtime licensing FAQ](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/apps/licensing-faq).

#### Commands

You need [Node.js](https://nodejs.org) 24.11 or later and [Git](https://git-scm.com/downloads). Run the commands one at a time: pasting them all at once can feed later lines to an earlier prompt. If PowerShell says running scripts is disabled, use Command Prompt. The `ms` CLI (`@microsoft/managed-apps-cli`) is pinned in [`package.json`](package.json), so `npm ci` installs the tested version.

Get the code:

```
git clone https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot.git
cd ConsumptionCentral-for-Microsoft-Copilot/app
```

Then:

```
npm ci
npx ms auth login
npx ms app init -n "Consumption Central" --repo none -b ./dist -S "npm run build"
npx ms app deploy
npx ms app share alex@example.com,finance-team@example.com
```

1. `npm ci` installs the app's dependencies, including the CLI.
2. `npx ms auth login` opens a browser to sign in. On a machine without a browser, add `--device-code` and enter the code it shows on another device.
3. `npx ms app init` creates the app and writes `ms.config.json`, which holds your tenant's app and environment IDs. `--repo none` means you build the app yourself and upload the result. To use a specific environment, or if init times out looking one up, add `-e` followed by the environment ID.
4. `npx ms app deploy` runs `npm run build` and uploads `dist/`. It waits until the deployment finishes.
5. `npx ms app share` gives people access to open the app. Replace the example addresses with your viewers' work emails or group emails, separated by commas. Entra object IDs work too. To share with your whole organisation instead, run `npx ms app share link create`. It creates a link that gives anyone in your organisation who opens it the Microsoft App Reader role on the app.

Viewers open [managedapps.cloud.microsoft](https://managedapps.cloud.microsoft), choose **Consumption Central**, then choose **Change data** and drop in their CSV exports (see [Data](#data)).

`ms.config.json` is gitignored because it's specific to your tenant. Keep it: later deploys use it to update the same app.

> **Copilot Code can run these steps for you.** Ask it to deploy this repo's `app` folder with the `ms` command line. Don't ask Cowork, Copilot Studio or Copilot Code to *create* the app: they'd build a new app from your prompt, not this one.

#### Update

From this `app` folder:

```
git pull
npm ci
npx ms app deploy
```

#### Troubleshooting

| Problem | Fix |
|---|---|
| `npm` or `npx` won't run in PowerShell ("running scripts is disabled on this system") | Run the same commands in Command Prompt. |
| The CLI won't create the app | An admin turns on **Allow app creation with the Copilot Managed Runtime command line interface (CLI)** (see [Admin settings](#admin-settings)). |
| `npx ms app deploy` fails and tells you to contact an administrator | An admin turns on **External artifacts in managed apps** (see [Admin settings](#admin-settings)). |
| `npx ms app init` times out looking up your environment | Add `-e` followed by the environment ID, from the environment's page in the Power Platform admin center. |
| `npx ms app share` is refused | An admin checks the group's **Sharing** rule in the Microsoft 365 admin center, under **Apps** › **Settings** › **Environment groups**. |
| A viewer you shared it with can't open the app | They need Power Apps Premium or Copilot Credits (see [Licensing](#licensing)). Sharing alone isn't enough. |
| `npx ms` complains about the Node.js version | Install Node.js 24.11 or later. To check your version, run `node --version`. |

<a id="as-a-fabric-app-in-a-fabric-workspace"></a>

### As a Fabric App *(alternative)*

Use this if you'd rather host the same app in a Fabric workspace. You need a workspace on Fabric capacity (F2 or larger, or a trial; *My workspace* won't work) and the **Fabric Apps (preview)** tenant setting turned on. The project config is [`rayfin/rayfin.yml`](rayfin/rayfin.yml). The app keeps no server-side data, so only auth and static hosting are on.

```powershell
npm ci
npx rayfin up --dry-run
npx rayfin up --tenant <tenant-id> --workspace-id <workspace-id> -y
```

It prints the item's portal link. People need access to the item (share it, or give them a workspace role) to open it. To update, run `npx rayfin up` again. The deploy state it writes (`rayfin/.deployments.json`, `rayfin/.env`) is gitignored.

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

The Guide's **About this app** section lists the presentation changes from Power BI. For example, treemaps, funnels and donuts become ranked bars. The values are unchanged.

## Develop

```powershell
npm install
npm run dev         # local dev server
npm run lint
npm run build       # type-check and build to dist/ (Managed App and Fabric App hosting)
npm run build:file  # build the single-file download to download/Consumption-Central-App.html
```

`download/Consumption-Central-App.html` is committed so people can download it. Whenever you change the app or the sample, run `npm run build:file` and commit the result. The single-file build inlines the code and styles, and embeds the sample CSVs listed in `public/sample/manifest.json`, gzipped.

If Git converts line endings in your checkout (`core.autocrlf=true`, the Git for Windows default), run `npm run prepare-sample` before `npm run build:file`. It rewrites the sample with the line endings the committed page was built from. Otherwise every embedded sample file gains a carriage return and the download changes even when the app hasn't.

The code is organised like this:
- `src/data/`: CSV loading and header detection.
- `src/metrics/`: the DAX port, one file per product.
- `src/ui/`: the design kit.
- `src/pages/`: the tabs.

The design system is in [DESIGN.md](DESIGN.md) and the product brief is in [PRODUCT.md](PRODUCT.md).
