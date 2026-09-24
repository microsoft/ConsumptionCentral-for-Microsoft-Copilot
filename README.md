<div align="center">

# 💳 Consumption Central

### *for Microsoft Copilot* — one Power BI template for **Copilot credit consumption and cost**

[![Built by Microsoft](https://img.shields.io/badge/BUILT_BY-MICROSOFT-4F73B8?style=for-the-badge&labelColor=1F1F1F)](https://microsoft.com)
[![Power BI Template](https://img.shields.io/badge/POWER_BI-TEMPLATE-F2C811?style=for-the-badge&logo=powerbi&logoColor=black&labelColor=1F1F1F)](https://powerbi.microsoft.com)

**What you're consuming · what it costs · where to trim · what next year looks like**

![Consumption Central](Images/ConsumptionCentral-Preview.gif)

</div>

## What it is

A Power BI report covering Copilot spend across **Cowork/Work IQ**, **Copilot Studio**,
**GitHub Copilot** and **Azure AI Foundry** — fifteen pages: consumption, cost, optimisation and
forecast per product, plus a combined overview.

**No product is required. One is enough.** Load whatever you have; the other pages stay empty and
nothing breaks.

---

## Setup

### 1. Pick a path

| Path | Best when | Setup time |
|---|---|---|
| **[1. Local CSV](1.%20Local%20CSV/)** | You want to see it working today | ~10 minutes |
| **[2. Fabric](2.%20Fabric/)** | You want it refreshing weekly on its own | An afternoon |
| **[3. Viva Direct](3.%20Viva%20Direct/)** | You want Cowork data with no files at all | ~10 minutes |
| **[4. Power Automate + Dataverse](4.%20Power%20Automate%20%2B%20Dataverse/)** | You want automatic refresh and have no Fabric | An afternoon |

Not sure? Start with **Local CSV**.

<a id="viva-identification"></a>

### 2. Turn on Viva identification *(only if you want per-person or department views)*

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

### 3. Follow your path's guide

Each folder has the exact steps. They all end the same way: open the `.pbit`, fill in one or two
parameters, click **Load**.

---

## Try it first with sample data

Every path ships with a synthetic dataset — point the template at
**[1. Local CSV/sample-data](1.%20Local%20CSV/sample-data/)** and the whole report fills in. No
exports, no real data.

---

## What you'll be asked for

Almost every parameter has a sensible default. Two are worth thinking about:

| | |
|---|---|
| **Where your data is** | A folder path, a Lakehouse name, or two IDs from Viva — depends on your path |
| **What a credit costs you** | List price is **$0.01**. Change it only if your agreement differs |

---

## Watch instead

Both play inline here, no download.

- **Demo** *(1m 51s)* — a tour of the fifteen pages.
  https://github.com/user-attachments/assets/702d94f7-74fc-43ad-a259-d00695f76a9c
- **Setup guide** *(10m 49s)* — every data source, start to finish.
  https://github.com/user-attachments/assets/480af64f-53ab-4f4c-b5d2-6f35546fdcfb

Where a video differs from these written instructions, follow the written ones.

---

## Documentation

| | |
|---|---|
| **[How to read the dashboard](docs/INTERPRETING.md)** | **What every page and figure means — start here if a number looks odd** |
| [Where the data comes from](docs/DATA-SOURCES.md) | Click-paths and permissions for every export |
| [Manual export fallback](fallback/) | When the API route isn't open to you |
| [Department breakdowns](docs/ORG-DATA.md) | How org attributes get in |
| [Rates and pricing](docs/COMMERCIAL-TERMS.md) | What to set and where to find it |
| [Every measure explained](docs/MEASURES.md) | Reference |
| [Advanced setup](docs/ADVANCED-SETUP.md) | Scheduling, service principals, gateway refresh |

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
