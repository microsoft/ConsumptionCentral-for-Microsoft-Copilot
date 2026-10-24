# Automating the landing step

Consumption Central reads five sources, and they do not automate equally:

| Source | Automated route | Needs a human? |
|---|---|---|
| **Viva consumption** | Certified Power Query connector — a [Dataflow Gen2](../README.md#viva-dataflow) on Fabric, or a direct connection on [3. Viva Direct](../../3.%20Viva%20Direct/) | **No** |
| **GitHub Copilot** | REST API, via [`Ingest_GitHub_API.ipynb`](../notebooks/Ingest_GitHub_API.ipynb) | **No** |
| **Entra org** | Graph PowerShell on a schedule | **No** |
| **Copilot Studio** | None — PPAC is download-only | Yes |
| **Azure AI Foundry** | Cost Management Query + Azure Monitor, via [`Ingest_Azure_AI.ipynb`](../notebooks/Ingest_Azure_AI.ipynb) | **No** |

Of these routes, **Copilot Studio** still needs someone to press export. Azure AI does not.

**The flows on this page are for manually landed exports.** They watch a mailbox or a SharePoint library and write
straight to OneLake, so the ingester picks the file up on its next run. That does not remove the
download; it removes the "save it in the right place" step and the mistakes that come with it.

> **Viva does not need a flow.** It used to, and older notes here said so. The certified connector
> now covers it end to end — use the Dataflow Gen2 route on Fabric. A flow is only worth setting up
> for Viva if you are deliberately working from downloaded CSVs.

## Azure AI: schedule the notebook, not a file flow

Follow the [Azure AI setup](../../docs/ADVANCED-SETUP.md#azure-ingestion-in-fabric) for application
registration, Key Vault, Azure RBAC, the default Lakehouse and notebook configuration.
The notebook obtains an explicit ARM application token; it does **not** assume Fabric
`getToken` supports ARM or that the notebook automatically has a managed identity.
The notebook's execution identity needs secret-read and Lakehouse write permissions separately
from the application's Azure permissions. Validate the scheduled/Notebook activity connection
identity, which can differ from the interactive user.

Schedule a Fabric pipeline **Notebook activity → on success → semantic-model refresh**.
The notebook replaces only its complete-UTC-day window in `azure_ai_spend` and `azure_ai_tokens`,
including legitimately empty results, and keeps older rows. All collection completes before writes,
but the writes are not a single transaction. On any failure, stop downstream refresh and retry the
whole ingestion with bounded backoff; do not run overlapping writers. Verify initial SQL endpoint
visibility before refreshing. Scheduling Power BI refresh alone does not ingest Azure data.

Cost Management also supports scheduled exports to storage, but those need schema transformation
and a separate Monitor metrics load. They are not a drop-in replacement for this notebook.

---

## Use the ValueLens flows

Two working flows already exist and need only their trigger filter and target folder changed:

**[ValueLens → Fabric + Copilot Studio → flows][vl]**

| Flow | Use when |
|---|---|
| `Copilot_Consumption_Email_to_OneLake.json` | The export arrives by **email** |
| `Copilot_Consumption_SharePoint_to_OneLake.json` | You prefer a governed **SharePoint** drop folder |

They write to OneLake with the ADLS Gen2 three-step pattern — `PUT ?resource=file` →
`PATCH ?action=append` → `PATCH ?action=flush` — against audience `https://storage.azure.com/`.

We link rather than fork them: a copy here would drift from the original, and there is no version of
that which ends well for whoever reads it in six months.

---

## What to change per source

Import the flow, then set the parameters. Only two differ per source.

| Source | `TargetFolder` | Email `SubjectFilter` |
|---|---|---|
| Viva consumption | `Files/landing/viva` | `Consumption Dashboard` |
| Copilot Studio | `Files/landing/studio` | `Copilot Usage Dashboard` |
| GitHub AI usage *(if not using the API)* | `Files/landing/github` | `usage report` |
| Entra org | `Files/landing/org` | whatever your export script sends |

The rest stay as documented in the ValueLens README: `OneLakeWorkspace`, `OneLakeLakehouse`,
`TenantId`, `ClientId`, `ClientSecret`.

**`TargetFolder` must match `LANDING` in the matching ingester notebook.** That is the one setting
that silently does nothing if you get it wrong — the flow reports success, the file lands somewhere
the notebook never looks, and the table stays empty.

---

## The one real prerequisite

The HTTP actions authenticate as a service principal, which must be able to **write** to the
workspace's OneLake:

1. Add the app registration (or workspace identity) as **Member or Contributor** on the Fabric
   workspace holding the Lakehouse
2. Put the secret in **Azure Key Vault** and reference it — do not ship a literal `ClientSecret`
3. The tenant setting **"Service principals can use Fabric APIs"** must be on

**Prefer not to use an app secret?** Swap the three `Http` actions for **OneLake / Azure Blob**
connector actions and authenticate interactively. The create/append/flush URIs are identical.

---

## Getting the export to arrive in the first place

A flow can only react to a file that shows up. How each source gets there:

| Source | Reality |
|---|---|
| **Viva consumption** | **No flow needed** — a [Dataflow Gen2](../README.md#viva-dataflow) writes query results straight to the Lakehouse on a schedule. Use a flow only if you are deliberately working from downloaded CSVs. |
| **Copilot Studio** | Manual download — PPAC is download-only. Mail it to the watched mailbox or drop it in the library. |
| **Azure AI Foundry** | Schedule the API notebook above. No download or mailbox/SharePoint flow is needed. |
| **GitHub** | The report is *emailed to you*, so the email flow can catch it with no human step at all. Better still, skip it and use the API notebook. |
| **Entra org** | Schedule the Graph PowerShell snippet in [DATA-SOURCES.md](../../docs/DATA-SOURCES.md) and have it write to the SharePoint library. Fully automatable. |

So realistically: **Viva, GitHub, Entra and Azure AI can be fully hands-off. Copilot Studio
still needs someone to press export** — the flow just removes the "save it in the right place"
step and the mistakes that come with it.

That is still worth having. The failure mode you are protecting against is not someone forgetting to
click download; it is someone downloading it and putting it somewhere the pipeline cannot see.

---

## Re-runs are safe

Re-run behavior is source-specific: some ingesters merge natural keys, while snapshot ingesters
replace their tables. Azure AI replaces only its collection window and keeps older rows.
Do not assume that keeping or pruning landing files is harmless for every ingester; check the
matching notebook's load behavior before deleting source files.

The Studio ingester additionally records a `source_file` column, so if a bad export does land you can
find its rows and remove them.

---

## Reusing the pattern elsewhere

The `PUT → append → flush` mechanism works for **any** export-only Microsoft report. Only the trigger
filter and target folder change. ValueLens documents the generalised version at
[`2. Fabric/flows/README.md`][vlg].

---

[vl]: https://github.com/Keithland89/ValueLens-for-Microsoft-Copilot/tree/main/3.%20Fabric%20Extended/Fabric%20%2B%20Copilot%20Studio/flows
[vlg]: https://github.com/Keithland89/ValueLens-for-Microsoft-Copilot/tree/main/2.%20Fabric/flows

**Related:** [StudioLens][sl] reads the same PPAC exports for agent-level analytics, and its ingester
is where the real export filenames used by our Studio notebook were confirmed.

[sl]: https://github.com/Keithland89/StudioLens-for-Copilot-Studio
