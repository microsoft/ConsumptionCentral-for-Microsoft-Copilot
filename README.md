<div align="center">

# 💳 Consumption Central

### *for Microsoft Copilot* — an app and a Power BI report for **Copilot credit consumption and cost**

All reports and guides can be found on the [Analytics Hub](https://microsoft.github.io/Analytics-Hub/).

**What you're consuming · what it costs · where to trim · what next year looks like**

![Consumption Central](Images/ConsumptionCentral-Preview.gif)

</div>

Consumption Central covers Copilot spend across **Cowork/Work IQ**, **Copilot Studio**,
**GitHub Copilot** and **Azure AI Foundry**: consumption, cost, optimisation and forecast per
product, plus a combined overview. **No product is required. One is enough.** Load whatever you
have; the rest stays empty and nothing breaks.

---

<a id="the-app"></a><a id="app-edition"></a>

## Start here: the app *(preview)*

The app has the same measures, charts and tables as the Power BI report, using the same DAX
definitions, in six simpler tabs. You deploy it once as a Copilot Managed App, and people open it at
[managedapps.cloud.microsoft](https://managedapps.cloud.microsoft). Each viewer chooses their own CSV
exports, and everything is calculated in their browser. No data leaves it.

> **Just looking?** Open [`app/download/Consumption-Central-App.html`](app/download/Consumption-Central-App.html),
> choose **Download raw file** and open it in Edge or Chrome. It starts on a synthetic sample, works
> offline, and needs no deploy and no licence.

### Before you start *(an admin, once)*

- **Two settings.** In the [Power Platform admin center](https://admin.powerplatform.microsoft.com),
  **Copilot › Settings › Managed apps**, turn on **Allow app creation with the Copilot Managed Runtime
  command line interface (CLI)** and **External artifacts in managed apps** for the environment group
  you deploy to (usually the default group). Both are off by default. [Details →](app/README.md#admin-settings)
- **Licences.** Everyone who opens the app needs **Power Apps Premium** or **Copilot Credits**. The
  Power Apps rights included with Microsoft 365 don't count. Deploying needs no licence.
  [Details →](app/README.md#licensing)

### Deploy

1. Install [Node.js](https://nodejs.org) 24.11 or later and [Git](https://git-scm.com/downloads), then
   open Command Prompt (Terminal on a Mac). PowerShell works too, unless it says running scripts is
   disabled.
2. Get the code and install the app's tools, including the `ms` command line:
   ```
   git clone https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot.git
   cd ConsumptionCentral-for-Microsoft-Copilot/app
   npm ci
   ```
3. Sign in with your work account. On a PC with no browser, add `--device-code`.
   ```
   npx ms auth login
   ```
4. Create the app in your tenant. If it times out looking up your environment, add `-e` followed by
   your environment ID.
   ```
   npx ms app init -n "Consumption Central" --repo none -b ./dist -S "npm run build"
   ```
5. Build and deploy it:
   ```
   npx ms app deploy
   ```
6. Share it. Replace the examples with your viewers' work or group emails, separated by commas.
   ```
   npx ms app share alex@example.com,finance-team@example.com
   ```
7. Viewers open [managedapps.cloud.microsoft](https://managedapps.cloud.microsoft), choose
   **Consumption Central**, then **Change data**, and drop in their CSV exports
   ([which ones](#where-your-data-comes-from)).

To update it later, run `git pull`, `npm ci` and `npx ms app deploy` in the `app` folder. Stuck? See
[troubleshooting](app/README.md#troubleshooting).

> **Copilot Code can run these steps for you.** Ask it to deploy this repo's `app` folder with the
> `ms` command line. Don't ask Cowork, Copilot Studio or Copilot Code to *create* the app: they'd
> build a new app from your prompt, not this one.

---

## Where your data comes from

The app and the report read the same exports. **[docs/DATA-SOURCES.md](docs/DATA-SOURCES.md)** has
the click-paths and permissions for every one. The app takes the [Local CSV](1.%20Local%20CSV/)
exports under any file name, because it recognises each file from its columns.

**Try it first with sample data.** Every path ships with a synthetic dataset. Point the template at
**[1. Local CSV/sample-data](1.%20Local%20CSV/sample-data/)** and the whole report fills in. The app
opens on a sample built from the same files. No exports, no real data.

<a id="viva-identification"></a>

### Turn on Viva identification *(only if you want per-person or department views)*

Viva Insights ships Copilot data de-identified, so it can't be joined to your other sources until
this is on. Cowork totals are correct either way.

A **Global Administrator** or **AI Administrator**, about two minutes:

1. [Microsoft 365 admin center](https://admin.cloud.microsoft/?#/viva/featureAccessManagement) →
   **Settings → Viva → Feature access management**
2. **Create a policy** — App **Viva Insights**, Feature **Identification**
3. Access **On**, applied to everyone or a named analyst group
4. Allow **up to 24 hours**, then re-run your export

**[Full steps and the two query names →](docs/DATA-SOURCES.md#identified-vs-de-identified)**

> This processes personal data. Check whether per-person reporting needs works-council consent or
> employee notification where you operate — your organisation is the data controller, not Microsoft.
> The connector does **not** enforce Viva's minimum group size, so apply any privacy threshold in
> the report yourself.

---

## The Power BI report

Prefer Power BI? The report covers the same products from a Power BI template (`.pbit`). Both videos
play here in the page, with no download.

**Demo — what the report covers, page by page** *(1m 51s)*

https://github.com/user-attachments/assets/702d94f7-74fc-43ad-a259-d00695f76a9c

**Setup guide — getting your own data in, every source, start to finish** *(10m 49s)*

https://github.com/user-attachments/assets/480af64f-53ab-4f4c-b5d2-6f35546fdcfb

Where a video differs from the written instructions, follow the written ones.

| Path | Best when | Setup time |
|---|---|---|
| **[1. Local CSV](1.%20Local%20CSV/)** | You want to see it working today | ~10 minutes |
| **[2. Fabric](2.%20Fabric/)** | You want it refreshing weekly on its own | An afternoon |
| **[3. Viva Direct](3.%20Viva%20Direct/)** | You want Cowork data with no files at all | ~10 minutes |

Not sure? Start with **Local CSV**. Each folder has the exact steps. They all end the same way: open
the `.pbit`, fill in one or two parameters, click **Load**. Almost every parameter has a sensible
default. Two are worth thinking about:

| | |
|---|---|
| **Where your data is** | A folder path, a Lakehouse name, or two IDs from Viva ([how to get them](docs/VIVA-QUERY.md)) — depends on your path |
| **What a credit costs you** | List price is **$0.01**. Change it only if your agreement differs |

---

<a id="fabric-app"></a>

## The Fabric App *(alternative)*

On Microsoft Fabric already? Host the same app in a Fabric workspace as a Fabric App, instead of a
Copilot Managed App ([steps](app/README.md#as-a-fabric-app-in-a-fabric-workspace)), or have the
report refresh on Fabric with the [2. Fabric](2.%20Fabric/) path.

> **Also see [Analytics Hub for Microsoft Copilot](https://github.com/microsoft/AnalyticsHub-Dashboard):**
> one installer sets up an app on Microsoft Fabric or Azure that shows Copilot and agent adoption,
> value, consumption and governance in one place. It includes Consumption Central as its optional
> *Credit consumption* add-on.

---

## Archived

- **[Power Automate + Dataverse](archive/4.%20Power%20Automate%20%2B%20Dataverse/README.md)**, which
  was path 4. Flows you already run keep working, but the route is unsupported and gets no fixes.
- **[Previous template versions](archive/README.md)**.

---

## Documentation

| | |
|---|---|
| **[How to read the dashboard](docs/INTERPRETING.md)** | **What every page and figure means — start here if a number looks odd** |
| [Where the data comes from](docs/DATA-SOURCES.md) | Click-paths and permissions for every export |
| [Running the Viva Insights query](docs/VIVA-QUERY.md) | Building, running and refreshing the query paths 2 and 3 connect to |
| [Department breakdowns](docs/ORG-DATA.md) | How org attributes get in |
| [Rates and pricing](docs/COMMERCIAL-TERMS.md) | What to set and where to find it |
| [Every measure explained](docs/MEASURES.md) | Reference |
| [Advanced setup](docs/ADVANCED-SETUP.md) | Scheduling, service principals, gateway refresh |
| [The app](app/README.md) | Deploy, admin settings, licensing, tabs, data detection and development |

---

## Support

Not supported through Microsoft support channels — **[open an issue](../../issues)** instead.

Built and tested end to end against live tenant data on all three paths. The sample dataset is
synthetic; no customer data is in this repo. If you schedule the Azure collectors, complete the
[Azure acceptance procedure](docs/TESTING.md#azure-automation-acceptance) in your own environment.

<details>
<summary><strong>Usage &amp; compliance</strong></summary>

This template helps you understand your own Copilot consumption and cost. Microsoft has no
visibility into the data you load, nor control over how the template is used. You are responsible
for ensuring your use complies with applicable law, including data privacy and employment law.
Microsoft disclaims all liability arising from use of this template.

Several underlying exports are **in preview**, and the identifiable variant of the Viva Insights
export processes personal data. Review the "Previews" section of the Microsoft Products and Services
Data Protection Addendum before enabling it, and consult your works council or privacy office where
per-person reporting requires it.

</details>

---

## Contributing

Issues and pull requests welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of
Microsoft trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks/usage/general).
Use of third-party trademarks or logos is subject to those third-parties' policies.
