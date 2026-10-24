# Department breakdowns

**One question: can you split the numbers by team?**

Every credit and cost figure works without this. Org data only adds the
ability to group by department, job title, manager and so on.

---

## The short answer

| You have | Do this |
|---|---|
| Cowork / Work IQ with user identification | Supply a directory CSV as standard unless the actual Viva output includes the required employee attributes. |
| Cowork / Work IQ without user identification | Inspect the output; a query-only setup works only if employee attributes and usable identity keys are returned. |
| GitHub Copilot or Studio as well | **Also supply a directory export.** |
| Azure AI Foundry | Tag your Azure resources. |

**If in doubt, supply the directory export.** It covers everyone, and it
costs one download.

Selecting employee attributes in Viva does not guarantee that the connector returns them.
UPNs, Domain and Population Type are not a substitute for Department or Organisation.
Whether disabling user identification restores the selected HR attributes still needs an
identified/de-identified comparison; do not promise this as a workaround.

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

To keep it current without the download, let [PAX](#exporting-with-pax) write
it on a schedule.

---

## Exporting with PAX

[PAX](https://github.com/microsoft/PAX) can write the directory export on a
schedule, so it never goes stale. `-OnlyUserInfo` reads every user from
Microsoft Entra ID through Microsoft Graph and writes one CSV, without touching
the audit log:

```powershell
pwsh -File .\PAX_Purview_Audit_Log_Processor.ps1 -OnlyUserInfo `
  -OutputPathUserInfo "https://contoso.sharepoint.com/sites/ConsumptionCentral/Shared Documents/Consumption Central/entra_org.csv"
```

`-OutputPathUserInfo` takes a local path too. Point it at `entra_org.csv` at
the top of your `DataFolder` and each run overwrites the last. Without it, PAX
writes `EntraUsers_MAClicensing_<date>_<time>.csv` to `-OutputPath`, or beside
the script. The template finds that name too once it's in `DataFolder`: the
newest copy wins. Signing in and scheduling are covered in PAX's own
documentation.

For the Viva Direct template, the installer's
[No Fabric route](../installer/README.md#no-fabric-sharepoint--pax-route) sets
this up for you: a daily task on a Windows PC runs PAX as its own app and
replaces `entra_org.csv` at the top of the SharePoint folder.

> **Don't add `-Deidentify`.** It replaces names and UPNs with one-way tokens,
> so no row matches your consumption data and every attribute shows as
> *(Not set)*.

**PAX exports every user**, guests and disabled accounts included. A large
tenant's file can pass 100,000 rows, and every refresh reads all of them.

### Which columns are used

The export is wide: 47 columns in PAX v1.11.15. **Viva Direct** uses them like
this:

| PAX column | Becomes |
|---|---|
| `userPrincipalName`, `mail` | The match to consumption, not a grouping |
| `displayName` | User |
| `department`, `jobTitle`, `country` | Department, Job Title, Country |
| `city`, then `officeLocation` | City |
| `employeeOrgData_costCenter` | Cost Center |
| `employeeOrgData_division`, then `companyName` | Business Unit |
| `manager_displayName`, then the manager's id or UPN | Manager |
| `id`, `employeeId`, `onPremisesImmutableId`, `givenName`, `surname`, `employeeHireDate`, `createdDateTime`, `assignedLicenses`, `proxyAddresses_*`, `manager_mail`, `postalCode`, `accountEnabled`, `onPremisesSyncEnabled`, `externalUserState` | Ignored |
| `UserName`, `BusinessAreaLabel`, `CompanyCodeLabel`, `CostCentreLabel`, `CountryofEmployment` | Ignored: copies of the columns above, kept for AI-in-One |
| Anything else, such as `employeeType`, `state` or `usageLocation` | A Group By of its own, once at least 5% of people have a value |

"Then" is per person: someone with no division gets their company name.

The **app** reads the same named columns, without the fallbacks or the extra
Group Bys. It takes the first of each attribute's names that the file has, so
in a file with an `employeeOrgData_division` column, anyone whose division is
blank shows *(Not set)*.

**Local CSV doesn't know PAX's names yet.** It loads the file, but Cost Center
stays empty, Business Unit takes `companyName`, Manager shows the manager's
Entra id, and every other populated column, ids and names included, becomes a
Group By. Before using PAX's file there, rename `employeeOrgData_costCenter` to
`CostCenter`, `employeeOrgData_division` to `Division` and
`manager_displayName` to `Manager`, and delete the columns you don't want.
**Fabric** doesn't need PAX: `Ingest_Org_Graph.ipynb` reads Entra ID itself.

---

## Adding attributes to your Viva query

Viva Insights → your query → **Select spending policy and employee
attributes** → tick what you want.

Then inspect the returned columns and values. If the attributes are absent or blank,
supply a directory CSV with matching identities; the template cannot infer them.

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
