# Department breakdowns

**One question: can you split the numbers by team?**

Every credit and cost figure works without this. Org data only adds the
ability to group by department, job title, manager and so on.

---

## The short answer

| You have | Do this |
|---|---|
| Only Cowork / Work IQ | Add org attributes to your Viva query. Nothing else needed. |
| GitHub Copilot or Studio as well | **Also supply a directory export.** |
| Azure AI Foundry | Tag your Azure resources. |

**If in doubt, supply the directory export.** It covers everyone, and it
costs one download.

---

## Why the directory export matters

The Viva Insights export describes **people who used Cowork**. It joins
`PeopleMetaData` to the usage rows on `PeopleHistoricalId`, so someone who
never touched Cowork appears in neither.

That's fine if Cowork is all you have. But:

> Someone who used **only GitHub Copilot** never appears in the Viva export,
> so Viva can't tell you their department.

The template handles this by **combining both sources**, not choosing between
them:

| Source | Covers | Role |
|---|---|---|
| **Directory export** | Everyone in your tenant | The base |
| **Viva query** | People who used Cowork | Enriches on top |

Where both describe the same person, **Viva wins per attribute** — its
attributes travelled with the usage data, so they always describe the right
people. Where Viva is silent, the directory fills in.

*Tested with a deliberate gap: 50 people in the Viva export, 219 GitHub-only
users. All 269 got departments.*

---

## Getting the directory export

Microsoft Entra admin centre → **Users** → **Download users**.

Give it to the template:

| Path | Parameter |
|---|---|
| Local CSV | drop the file in your data folder |
| Viva Direct | drop the file in your `DataFolder` |
| Fabric | run `Ingest_Org.ipynb` |

Column names are matched flexibly — `department`, `Department` and
`organization` all work.

---

## Adding attributes to your Viva query

Viva Insights → your query → **Select spending policy and employee
attributes** → tick what you want.

Worth doing even if you supply a directory export: these attributes are
guaranteed to match the people in the usage data.

---

## Azure AI Foundry is different

Cost Management is **resource-grained** — there is no person in the data at
all. No org file changes that.

The only route is **tagging Azure resources** with a department. Note that
tags are not inherited from resource group or subscription, and enabling
inheritance is not retrospective, so untagged spend is common. The Foundry
page says what share cannot be attributed rather than hiding it.

---

## What can never be split by team

| | Why |
|---|---|
| Copilot Studio **per-agent** | The export is per agent, with no person |
| Copilot Studio **tenant** | Per environment and billing plan |
| Azure AI Foundry | Per Azure resource |

These carry tenant totals whatever org data you load. That's the shape of the
export, not a gap in the template.

---

## Nothing loaded?

Group By falls back to **usage intensity** — light, moderate, heavy, power
users. Every credit and cost figure is still correct; you just can't split
them organisationally.
