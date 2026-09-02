# Automating the landing step

Consumption Central reads five sources, and they do not automate equally:

| Source | Automated route | Needs a human? |
|---|---|---|
| **Viva consumption** | Certified Power Query connector — a [Dataflow Gen2](../README.md#the-viva-half-needs-no-notebook) on Fabric, or a direct connection on [3. Viva Direct](../../3.%20Viva%20Direct/) | **No** |
| **GitHub Copilot** | REST API, via [`Ingest_GitHub_API.ipynb`](../notebooks/Ingest_GitHub_API.ipynb) | **No** |
| **Entra org** | Graph PowerShell on a schedule | **No** |
| **Copilot Studio** | None — PPAC is download-only | Yes |
| **Azure AI Foundry** | None — Cost Management exports are download-only at the grain we need | Yes |

So the two that still need someone to press export are **Copilot Studio** and **Azure AI Foundry**.

**The flows on this page are for those two.** They watch a mailbox or a SharePoint library and write
straight to OneLake, so the ingester picks the file up on its next run. That does not remove the
download; it removes the "save it in the right place" step and the mistakes that come with it.

> **Viva does not need a flow.** It used to, and older notes here said so. The certified connector
> now covers it end to end — use the Dataflow Gen2 route on Fabric. A flow is only worth setting up
> for Viva if you are deliberately working from downloaded CSVs.

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
| **Viva consumption** | **No flow needed** — a [Dataflow Gen2](../README.md#the-viva-half-needs-no-notebook) writes query results straight to the Lakehouse on a schedule. Use a flow only if you are deliberately working from downloaded CSVs. |
| **Copilot Studio** | Manual download — PPAC is download-only. Mail it to the watched mailbox or drop it in the library. |
| **Azure AI Foundry** | Manual download from Cost Management. Same handling as Studio. |
| **GitHub** | The report is *emailed to you*, so the email flow can catch it with no human step at all. Better still, skip it and use the API notebook. |
| **Entra org** | Schedule the Graph PowerShell snippet in [DATA-SOURCES.md](../../docs/DATA-SOURCES.md) and have it write to the SharePoint library. Fully automatable. |

So realistically: **Viva, GitHub and Entra can be fully hands-off. Copilot Studio and Azure AI
Foundry still need someone to press export** — the flow just removes the "save it in the right
place" step and the mistakes that come with it.

That is still worth having. The failure mode you are protecting against is not someone forgetting to
click download; it is someone downloading it and putting it somewhere the pipeline cannot see.

---

## Re-runs are safe

Every Consumption Central ingester merges on a natural key, so re-landing the same export updates rather than
duplicates. You can leave old files in the landing folder, or prune them — neither changes the
numbers.

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
