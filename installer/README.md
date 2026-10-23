# Consumption Central installer

Sets up the [Fabric option](../2.%20Fabric/README.md) of Consumption Central in your tenant, loads
the first data and checks it. This page is the reference. To get going, follow
[Install](../docs/INSTALL.md) → [Check it worked](../docs/INSTALL.md#check-it-worked).

It's a port of the [Analytics Hub](https://github.com/microsoft/AnalyticsHub-Dashboard) installer,
cut down to Consumption Central's sources: the same sign-in, questions, plan, repair, update,
uninstall and exe. [UPSTREAM.md](UPSTREAM.md) records the commit it was ported from.

## Editing setup and recovering from failures

The browser installer opens **Review and fix setup**, with a summary card for each category.
Choose **Edit settings** on just the category you need: data sources, Fabric placement, Power BI,
viewer access, identity and secrets, data source connections, the Power Automate flow, or schedule
and first load. **Back to settings** cancels the open category without changing its saved
choices; **Save and close** keeps your draft for next time.

After a failed deployment, use **Edit all settings**, the suggested category, or
**Retry saved configuration** straight from the error screen. You don't need to go back to the
home page or answer unrelated questions again. Earlier attempts stay under
**Previous attempts in this session**. **Review and deploy** runs the checks again and shows the
plan, access grants and costs before you approve another attempt.

Answers you haven't approved yet are saved beside the install record as
`consumption-central-setup.json.draft.json`. The record of what's deployed is kept separately
until you approve the plan. Neither file holds secrets: a pasted secret stays in memory only, so
you may need to paste it again after closing the installer. If another command has changed the
install record since the draft was saved, setup asks you to keep the latest deployed IDs and
archive the older draft, or stop without changing either file. **Start fresh** archives both the
record and its draft; it doesn't delete anything in your tenant.

Terminal setup and `--yes` ask the questions in order, or take the defaults. Mentions of
**Advanced settings** below are for the terminal; in the browser, open the matching category.

## Before you start

Once you sign in, the **Prerequisites** panel (`prereqs` in the terminal) checks most of this,
and changes nothing.

| You need | For | Without it |
|---|---|---|
| An active Fabric capacity, F2 or larger, or a trial, that you can assign workspaces to | The workspace, Lakehouse, notebooks and pipeline | Start a Fabric trial, or ask a capacity admin |
| Power BI Pro or Premium Per User | Publishing and sharing the semantic model and report | Ask your licence admin |
| A way to register an app in Entra: Application Administrator, Cloud Application Administrator, users allowed to register apps, or an app you already have | The app registration the notebooks and the model's connection sign in as | [If you can't register apps](#if-you-cant-register-apps) |
| Global Administrator or Privileged Role Administrator | Admin consent for the app's Microsoft Graph permissions (only with org data from Entra ID or Copilot Studio credits from the API) | The installer gives you a link to send to one |
| The Fabric tenant setting **Service principals can call Fabric public APIs** | The model's connection signs in as the app, so the model can't refresh without it | A Fabric administrator turns it on. You only need that role if the setting is off |

Only for some sources or choices:

| You need | For |
|---|---|
| An Azure subscription where you're Owner, or Contributor and User Access Administrator | A new Key Vault, and the roles that let the app read [Azure AI](#azure-ai) costs |
| Power Automate Premium, rights to make flows in a Power Platform environment, and a Power Platform, Billing or Global administrator to sign in to its licensing connection | The [Copilot Studio credits flow](#copilot-studio-credits-flow) |
| The Viva Insights **Insights Analyst** role, or an analyst who creates the query | The [Cowork credits Dataflow](#cowork-credits-dataflow) |
| A GitHub enterprise owner or billing manager to make the token | [GitHub Copilot from the API](#github-token) |
| Cost Management Reader on a billing scope | The [credit rate from Azure Cost Management](#credit-rate-from-azure-cost-management) |

### Where the secrets go

Some notebooks need a secret: the app registration's client secret (Copilot Studio credits from
the API, Azure AI, org data from Entra ID) and the GitHub token (GitHub from the API). The
semantic model's connection needs the app's client secret too, but that one lives only in the
connection. The installer asks once, **Where should the client secret go?** (or the GitHub token,
or both):

| Option | You need | Use it when |
|---|---|---|
| **No Key Vault: keep secrets in the notebooks** (the default) | Nothing in Azure: no subscription and no vault | You want the quickest set-up, have no Azure subscription, or can't create or write to a vault. Anyone with a role in the workspace can read the secrets. |
| **Azure Key Vault**, written by the installer | Contributor to create a vault, or write access to an existing one | You want workspace roles not to expose the secrets. Or run `install --key-vault`. |
| **A vault admin will add the secret for me** | Read access to the vault: Key Vault Secrets User, or secret Get and List on an access policy | You want Key Vault but can't write to the vault and can't create one. Offered when the installer finds you can't write. |

Installs that already keep a secret in Key Vault carry on using it.

**A vault admin adds the secret.** The installer shows the vault, the secret name and one Azure
Cloud Shell command for the admin. For the client secret, the command creates a new secret on the
app and stores it in the vault in one step, so nobody, the installer included, sees its value. If
you don't have read access yet and can't give it to yourself, the command gives it to you as well.
Then answer **Has the admin added it?** with **Yes, carry on**, or stop and run the installer
again once it's there. Your answers are kept. Read access is all the notebooks need: they read the
secret with `notebookutils` as the person the run uses.

**No Key Vault: keep secrets in the notebooks.** Take it at the question, or run
`install --no-key-vault`. The installer states the trade-off and asks you to confirm (with
`--yes`, the default is taken):

- **Anyone with a role in the workspace can read the secrets**, Viewer included, and so can anyone
  a notebook is shared with. The client secret can read what the app's permissions allow until it
  expires, and the GitHub token can do whatever its scopes allow. Key Vault avoids that: the
  notebooks read the secrets from the vault at run time, so a workspace role doesn't expose them.
- They're copied into notebook run snapshots, exports and deployment pipelines.
- There's no vault audit log of who read them, and no vault network rules.

To limit that, the installer:

- Gives the client secret a short life: **90 days** by default. Change it with `--secret-days <n>`
  (1 to 730), or under [Advanced settings](#advanced-settings).
- Replaces the client secret on every install, **Repair or change** and `update`: it writes a new
  one into the notebooks, then removes the old one from the app. If the rewrite stops part-way,
  the old secret is kept until the next run finishes.
- Won't write a secret into a workspace connected to Git, so it never reaches source control.
  Disconnect Git under **Workspace settings** > **Git integration**, or choose Key Vault.
- Never writes a secret to the install record or the logs. `consumption-central-setup.json`
  holds only the client secret's ID and expiry date.

If you brought your own app, the installer can't make its secrets, so it doesn't replace yours:
paste a new one with **Create new secrets** (`rotate-secret`). To move to Key Vault later, run the
installer again and choose Key Vault. It rewrites the notebooks to read the secrets from the vault.

### If you can't register apps

Choose **An admin will register the app for me** at the app registration question. Before
anything is created, the installer writes `consumption-central-admin-pack.md` next to the install
record. It holds an Azure Cloud Shell script and the same steps for the portal. An admin uses it
to:

1. Register the app, with the Microsoft Graph application permissions your sources need.
2. Grant admin consent.
3. Create a client secret. If you chose **A vault admin will add the secret for me**, the secret
   goes straight into the vault. Otherwise the admin sends it to you through a secure channel.

They send you back the client ID. Run the installer again, enter it, and paste the secret if
you're asked. The installer then checks the app as below.

**Using an app you already have?** The installer checks it before anything is created: that the
app and its service principal exist, and that every Graph application permission you need is on it
with admin consent. It lists anything missing with the link to the app's API permissions page.
Once an admin has fixed it, choose **Check again**. Or carry on anyway: data the missing
permissions cover won't load until they're fixed.

## Advanced settings

After the data sources, the installer asks **Change the advanced settings?** With **No** (the
default, and what `--yes` answers) it uses what you chose last time, or else the defaults below.
With **Yes** it asks about each one as it comes. To change one later, choose **Repair or change**.

| Setting | Default |
|---|---|
| [Power BI](#power-bi-report-and-viewers) | The semantic model and the Consumption Central report. Or the model only, or neither. |
| [Who can view](#power-bi-report-and-viewers) | A new **Consumption Central Viewers** group, with you as owner. You're who people ask for access. **Manage access** changes it later. |
| [Prices](#prices) | The report template's: pay-as-you-go 0.01 USD a credit, prepaid 0.008, no prepaid credits bought, GitHub Copilot Business 19 and Enterprise 39 USD a seat a month, a 4-week billing period. |
| Lakehouse name | `ConsumptionCentral`, or the next free name. |
| A new Key Vault's resource group, region and name, and the secret's name | `rg-consumption-central`, the capacity's region, `consumption-central-` and random characters, and the default secret name. |
| Days before a client secret kept in the notebooks expires | 90 (1 to 730). Or `--secret-days <n>`. |
| Schedule | Daily at 02:00 UTC. Or weekly, on the day and at the time (UTC) you choose. |
| Run the first load as soon as setup finishes | Yes. |

## Data sources and exports

On the **Data sources** screen each source has a card. Choose how it arrives: connected, **Upload
CSV**, or **Skip**. A skipped source leaves its tables empty and its pages blank. Nothing fails. To
turn one on later, choose **Repair or change**.

| Source | Connected | Upload CSV: where to export it | Default | Fills |
|---|---|---|---|---|
| Copilot Cowork and Work IQ credits | **Connected (Dataflow)**: a [Dataflow Gen2](#cowork-credits-dataflow) reads your Viva Insights query. Spending policies are still an upload | Viva Insights > Copilot Consumption Dashboard > **Export**. Upload `PersonServiceCreditsMetrics.csv` and `SpendingPolicyMetadata.csv` from the ZIP | Upload CSV | Pages 1–4 (Cowork) |
| Cowork task categories | | Viva Insights: the Cowork weekly metrics export, `CoworkWeeklyMetrics.csv` with its `PeopleMetaData.csv`. See [Cowork tasks](../docs/COWORK-TASKS.md) | Skip | 2.1. Cowork: Tasks |
| Copilot Studio credits | **Connected (Power Automate flow)**: a [daily flow](#copilot-studio-credits-flow) reads the Power Platform licensing API | Power Platform admin center > **Licensing** > **Products** > **Copilot Studio**. Download the Summary, Environments and Agents exports (`EntitlementConsumption*_MCSMessages*.csv`) | Upload CSV | Pages 5–8 (Studio) |
| GitHub Copilot | **Connected (GitHub API)**, with a [GitHub token](#github-token) | GitHub: your enterprise > **Billing and licensing** > **Usage** > **AI usage** > **Get usage report**. The seat map is a CSV of username, UPN, display name and plan | Skip | Pages 11–14 (GHCP) |
| Azure AI Foundry and Azure OpenAI | [From Azure](#azure-ai), with the app registration | | Skip | Pages 9–10.1 (Azure) |
| Org data | **Connected (Microsoft Entra ID)**: read from Microsoft Graph each day | Microsoft Entra admin center > **Users** > **All users** > **Download users**, or any CSV with a UPN or email column and your org columns | Skip | Department and other org filters. Without it, departments come from Viva Insights |
| Credit rate from Azure Cost Management | [Read once](#credit-rate-from-azure-cost-management), as you | | Skip | The credit rate the report prices with, instead of the one you type in |

**Adding exports.** Every export goes to one folder in the Lakehouse,
`Files/consumption_central_uploads`. Drop files there as downloaded: no renaming and no
subfolders. Each pipeline run starts by recognising each file from its column headers, handing it
to the notebook that loads it, and moving it to `_processed`. A file it doesn't recognise, or one
for a skipped source, goes to `_unrecognised`; the reason is in the
`consumption_central_upload_log` table. Ways to add a file:

- **In the installer.** Choose **Upload exports**, pick files on the Data sources screen, or run
  `upload <file.csv> --run` to upload and load it now.
- **In Fabric.** Open the Lakehouse, choose **…** next to the folder, then **Upload** >
  **Upload files**.
- **[OneLake File Explorer](https://learn.microsoft.com/fabric/onelake/onelake-file-explorer)**,
  which shows the folder in Windows Explorer.

The installer uploads files up to 200 MB. Use Fabric or OneLake File Explorer for bigger ones.
Your account needs Contributor or Member on the workspace to write there.

**A SharePoint or OneDrive folder instead (optional).** In the Lakehouse, open
`consumption_central_uploads`, choose **New shortcut** > **OneDrive (SharePoint)**, pick your
folder and name the shortcut `sharepoint`. Files there are read where they are, loaded once each,
and left in place. Shortcuts need the Fabric tenant setting for OneDrive and SharePoint shortcuts.
Without it, use the Lakehouse folder.

### Copilot Studio credits flow

With Copilot Studio credits set to **Connected (Power Automate flow)**, the installer creates the
flow `Consumption Central - Copilot Studio credits` in the Power Platform environment you pick,
**turned off**, then helps you sign in to it and turns it on. Each day, an hour before the
pipeline, it reads credits by environment, agent and user, and the tenant's entitlement, from the
Power Platform licensing API. Its first run loads about six months; later runs restate the last
ten days. The environment's DLP policy must allow *HTTP with Microsoft Entra ID (preauthorized)*,
and people with access to the environment can see the flow.

It needs Power Automate Premium: whoever signs in to its HTTP with Microsoft Entra ID connections,
and you as its owner.

**The installer signs it in with you.** Straight after it creates the flow, it:

1. Makes the two connections the flow needs, with their URLs filled in, named
   `Consumption Central - Power Platform API` and `Consumption Central - OneLake`. It reuses ones of
   the same name that are signed in to already.
2. Gives one sign-in link for each, and says who signs in. If a link opens nothing, your browser
   blocked the pop-up: allow pop-ups for `make.powerautomate.com` and `login.microsoftonline.com`.
3. Waits while you sign in. Choose **I've signed in, check now**, or **Do this later**. `--yes`
   doesn't wait.
4. Once they're signed in to, points the flow at them and turns it on. Run `update` to finish this
   later.

To finish it by hand: open the flow in Power Automate and sign in to its connections. For the
Power Platform API, the Base Resource URL and Resource URI are `https://api.powerplatform.com`;
sign in as a Power Platform, Billing or Global administrator. For OneLake, the Base Resource URL is
`https://onelake.dfs.fabric.microsoft.com` and the Resource URI `https://storage.azure.com`; sign
in as someone with Contributor or higher on the workspace. Save, then turn it on.

**Load the Studio credits now.** The flow loads its first six months on its first run, which is
otherwise the next day. Once it's on, choose **Run** in Power Automate. Or use `run`, or **Repair
or change**: when the flow is on and hasn't loaded them yet (there's no
`Files/consumption_central_flows/studio_backfill_done` in the Lakehouse), the installer offers to
run it as you, and waits for it so the pipeline that follows picks up its files. `--yes` never
runs it.

The flow writes to the drop folder as the person who signed in to the OneLake connection, so
there's no secret. (With `--flow-identity app` it writes as the app registration instead, with
its secret from Key Vault; the vault must allow public network access.) The Fabric tenant setting **Users can access data stored in OneLake with apps
external to Fabric** must be on (it is by default). **Keep it running:** sign in with a dedicated
admin account rather than your own, add a co-owner, and sign in again if the account's password
is reset or the flow hasn't run for about 90 days.

If the flow can't be created (no environment, or no maker rights), the installer writes it to a
file beside your answers in `Documents\Consumption Central`. Create a cloud flow and paste the
file's `definition` in. **Repair or change** updates the flow and keeps the connections you signed
in to. Exports are still accepted alongside the flow: for a month an export covers, its figures
win.

### Cowork credits Dataflow

Choose **Connected (Dataflow)** where you can. A Viva Insights analyst creates the query first: in
Viva Insights > **Create analysis** > **Create custom query** > **Consumption query**, they keep
the preselected credit metrics, turn on **Auto-refresh** and run it. In **Analysis results**, the
link icon copies its partition and query IDs. Step by step: [the Viva query](../docs/VIVA-QUERY.md).
The installer fills in the partition ID with your tenant ID, which is usually right. If you don't
have the query ID yet, leave the partition blank to use the CSV export until then, and add the IDs
with **Repair or change**.

With the IDs, the installer creates the Dataflow Gen2 `ConsumptionCentral_Cowork_Credits`, which
loads the query into `viva_credits_dataflow`, and the pipeline refreshes it before the Viva load.
Its connections need signing in once, and the installer can't do that for you:

1. Open the Dataflow from the link on the **Done** page or at the end of the install.
2. It shows **Configure connection** twice, once for each thing it connects to: the Viva Insights
   source (the VivaInsights query) and the Lakehouse destination.
3. On each one, choose **Configure connection**, sign in, then **Connect**.
4. Choose **Save**, then wait until the Dataflow shows it has finished publishing.
5. Choose **Load Cowork now**, or run `load-cowork`. It waits for publishing to finish, refreshes
   the Dataflow, then runs the Viva load and the model refresh and says how many rows it loaded.

If the Dataflow isn't signed in yet when the first load starts, the installer leaves it out of that
run (the pipeline's `SkipCowork` parameter), so the other loads aren't marked as failed, and the
**Done** page has a card with these steps. Scheduled runs never skip it: until someone signs in,
they fail at `Refresh_Cowork_Credits`. Fabric also adds **DataflowsStagingLakehouse** and
**DataflowsStagingWarehouse** to the workspace for the Dataflow; leave them in place. The spending
policies still come from the `SpendingPolicyMetadata.csv` export, and exports can fill weeks
before the query.

### Cowork task categories

A `CoworkWeeklyMetrics.csv` export is read with the `PeopleMetaData.csv` that came with it, so
the two arrive together: run `upload` with both files, or put both in
`Files/landing/viva/cowork_tasks/` as `CoworkWeeklyMetrics.csv` and `PeopleMetaData.csv`,
replacing the ones there. A new pair replaces the last, and the weeks it held stay loaded. See
[Cowork tasks](../docs/COWORK-TASKS.md).

### GitHub token

With GitHub Copilot set to **Connected (GitHub API)**, `Ingest_GitHub_API` reads your
enterprise's Copilot billing each day. The installer asks for the enterprise slug (as in
`github.com/enterprises/<slug>`, or `--github-enterprise <slug>`) and, once you approve the plan,
for a token:

- A **classic** personal access token with the scope `read:enterprise` or
  `manage_billing:copilot`, made by an owner or billing manager of the enterprise. Fine-grained
  (`github_pat_…`) tokens are refused, because GitHub's billing endpoints take only classic ones.
- The installer checks it against the enterprise's Copilot seats and AI credit usage before it
  saves it.
- It goes in Key Vault (as `consumption-central-github-pat`) or, with no Key Vault, in
  `Ingest_GitHub_API`. See [Where the secrets go](#where-the-secrets-go).
- Before it expires, replace it with **Replace the GitHub token** (`github-token`). The **Done**
  page has a card from 30 days before. Once it expires, the GitHub load fails.
- To pass it without the question, set `$env:CONSUMPTION_CENTRAL_GITHUB_TOKEN` first.

### Credit rate from Azure Cost Management

With this source on, `Ingest_CommercialTerms` works out your effective Copilot credit rate from
last month's Azure charges, and the report uses it instead of the price you type in. The installer
asks which billing scope to read: the subscriptions that billing policies charge Copilot
pay-as-you-go to come first, or a billing account or billing profile (`--billing-scope <id>`).

It runs once after setup, **as you**, so your account needs Cost Management Reader (or a billing
reader role) on that scope. The installer doesn't grant it. It runs again when you change the
scope and on `update`. Run `Ingest_CommercialTerms` again from the workspace when your price
changes.

### Azure AI

With Azure AI Foundry and Azure OpenAI on, `Ingest_Azure_AI` reads Azure AI spend by day,
resource and model from Azure Cost Management for one subscription, and Copilot pay-as-you-go
billed to Azure from each billing policy's subscription. It signs in as the app registration,
which needs **Reader**, **Cost Management Reader** and **Monitoring Reader** on the subscription.
The installer gives them when you can assign Azure roles; otherwise it says what to ask for.

## Power BI report and viewers

The installer publishes the `Consumption Central` report to the workspace from
[the Fabric template](../2.%20Fabric/), already connected to `Consumption Central Model`, so
nobody has to open Power BI Desktop. Pages for sources you skip stay empty rather than failing. To
leave the report out, choose **Semantic model only** for Power BI under
[Advanced settings](#advanced-settings). With **Neither**, publish the template yourself.

The model's connection to the Lakehouse signs in as the app registration with its own client
secret, so the model needs the tenant setting **Service principals can call Fabric public APIs**.
If you're a Fabric administrator, the installer checks it.

**Viewers.** The installer creates **Consumption Central Viewers** (or uses a group you name) and
gives it **Build** on the semantic model. It doesn't give the group a workspace role: a Viewer can
read the notebooks, and with no Key Vault the secrets are in them. Power BI has no API to share a
report, so straight after it's published the installer asks you to share it with the group once:
open the report, choose **…** > **Manage permissions** > **Add user**, enter the group and choose
**Grant**. Choose **I've shared it** and it isn't asked again. Choose **Later** and it's a card on
the **Done** page, and **Repair or change** asks again. Until it's shared, people in the group get
"no access". After that, give people access by adding them to the group, or with **Manage access**
(`access`).

### Prices

The report prices credits and seats with six model parameters. The installer reads their defaults
from the template and asks for yours under [Advanced settings](#advanced-settings):

| Question | Parameter | Template default |
|---|---|---|
| Pay-as-you-go price per Copilot credit (USD) | `CreditRate` | 0.01 |
| Prepaid price per Copilot credit (USD) | `PrepaidCreditRate` | 0.008 |
| Prepaid Copilot credits bought (0 for none) | `PrepaidCreditBalance` | 0 |
| GitHub Copilot Business seat, per month (USD) | `GitHubBusinessSeatPrice` | 19 |
| GitHub Copilot Enterprise seat, per month (USD) | `GitHubEnterpriseSeatPrice` | 39 |
| Billing period, in weeks | `BillingPeriodWeeks` | 4 |

Only prices that differ from the template's are saved, so a later template's defaults still apply
to the rest. See [Commercial terms](../docs/COMMERCIAL-TERMS.md).

**Editing the report.** A new installer version may bring a new version of the report.
**Update** and **Repair or change** then ask before replacing it, because that replaces edits made
in Power BI. To keep your edits, use **File** > **Save a copy** in Power BI first and edit the copy.

## Load status and reruns

**The pipeline.** `ConsumptionCentral_Pipeline` runs `ConsumptionCentral_Upload_Router` first,
then the load notebooks for the sources you chose, the Cowork Dataflow before the Viva load, then
`Refresh_Consumption_Model`, and last `Record_Load_Status`.

**One Spark session.** The notebooks share one Spark session instead of each starting its own.
This keeps a small capacity from being too busy to start them. The installer turns on the
workspace setting it needs: *High concurrency for pipeline running multiple notebooks*. That needs
the workspace **Admin** role. If you're a Member, it warns you, and the notebooks start their own
sessions. A workspace admin can turn it on under **Workspace settings** > **Data
Engineering/Science** > **Spark settings** > **High concurrency**.

**What loaded.** After a run, the installer shows a card for each source: loaded, failed, skipped,
to do, or still running. A failed card says why in plain words, such as *Fabric's capacity was too
busy to start it*, and what to do about it. The last step writes the same thing to the Lakehouse
table `dbo.load_log`, one row per source per run. If any load failed, that step fails too, so the
run shows as failed in Fabric and in its alert emails.

**Rerun only what failed.** Choose **Rerun failed loads**, or run `rerun-failed`. It runs the
failed loads again, then the steps that depend on them, and refreshes the model. Loads that worked
aren't run again, unless they read what a rerun step writes: when the Cowork Dataflow reruns, so
does the Viva load. If the capacity is still busy, it waits five minutes and tries again, twice. It
won't start while a pipeline run is still going.

### When an update has to clear a model's data

`update`, and `install` or **Repair or change** run from a newer version, update the semantic model
in place and keep its data. Some changes, such as new columns, can't keep it: Fabric then turns the
update down and changes nothing. The installer names the model, says the report shows no data
until it's reloaded from the Lakehouse (which isn't changed), and asks before clearing it. Answer
no, and the run stops with the model unchanged.

`--yes` alone never clears a model's data: the run stops instead. For an unattended run that may
clear it, add `--allow-model-reset`. In the browser, the page asks.

After the model's definition changes, the installer reloads it, and only says it's done once a
whole-model refresh it requested after the change has finished cleanly. Until then the install
record notes that the model is owed a reload, so if the run stops or fails, the next `install`,
`update` or **Repair or change** reloads it, even with nothing else to change. If that reload
fails, `update` and `install` end as failed. Run `refresh`, or run the same command again.

## Commands

Run them as `npx consumption-central-installer <command>` from this folder, as
`ConsumptionCentralInstaller.exe <command>`, or with the command the PowerShell launcher leaves
behind. With no command, the browser steps open.

| Command | Does |
|---|---|
| `install` | Set up, or repair or change the set-up. `--ui` opens the browser steps |
| `run` | Run the pipeline, wait for it, then check the data. `--no-wait` only starts it |
| `rerun-failed` | Run again only the loads that failed in the latest run, and what depends on them |
| `load-cowork` | Once the Cowork Dataflow is signed in: refresh it, load the Viva credits and refresh the model |
| `check` | Run the data check again, without the pipeline |
| `refresh` | Refresh the semantic model from the Lakehouse |
| `status` | Recent runs, model refreshes, secret and token expiry, and the last data check. Changes nothing |
| `update` | Push the notebooks, pipeline, model and report from this installer version to Fabric |
| `rotate-secret` | Replace the app's client secret, and the model connection's |
| `github-token` | Replace the GitHub token |
| `access` | Who can view: the viewer group, its members and owners, its Build on the model, and the report share |
| `upload <files…>` | Upload exports to the drop folder. `--run` loads them now |
| `uninstall` | Delete the workspace and everything in it |
| `prereqs` | Check your roles, licences, capacity and Azure access. Changes nothing |
| `preview` | Write what would be deployed to a folder, without signing in |

| To | Run |
|---|---|
| Choose sources without the questions | `install --data studioCredits=csv,github=api --yes` |
| Upload exports during the install | `install --data coworkCredits=csv --csv PersonServiceCreditsMetrics.csv` |
| Read Copilot Studio credits with the flow | `install --data studioCredits=api --flow-environment https://contoso.crm.dynamics.com` |
| Read Cowork credits with a Dataflow | `install --data coworkCredits=api --viva-partition <id> --viva-query <id>` |
| Read GitHub Copilot from the API | `install --data github=api --github-enterprise <slug>` |
| Read the credit rate from a billing scope | `install --data commercialTerms=api --billing-scope /subscriptions/<id>` |
| Keep the secrets in Key Vault | `install --key-vault` |
| Sign in with the Azure CLI, or with a code | `--use-az`, or `--device-code` |

Source IDs for `--data`: `coworkCredits`, `coworkTasks`, `studioCredits`, `github`, `azureAi`,
`orgData`, `commercialTerms`. Modes: `api`, `csv` or `skip` (`coworkTasks` takes `csv` or `skip`;
`azureAi` and `commercialTerms` take `api` or `skip`). Without `--flow-environment`, the installer
asks which environment to use. Add `--help` for every option.

`uninstall` asks before it deletes the workspace. If the installer didn't create the workspace,
the answer defaults to no. It deletes the workspace's managed private endpoints first, because
Fabric won't delete a workspace that still has them, then the model's connection. It leaves the
app registration, the Key Vault and any Power Automate flow alone, and says so.

## Develop and test

Needs Node.js 22.13 or later. From this folder:

```text
npm ci
npm test
npm run typecheck
python -m unittest discover -s test/python -p "test_*.py"
```

`npm test` runs the Node tests, `typecheck` checks the JSDoc types, and the Python tests cover the
notebooks that ship with the installer (`assets/`). The installer reads the notebooks and the
template from this repo through [`installer-assets.json`](../installer-assets.json); `--source
<folder>` points it at another checkout.

`npm run build:exe` builds `ConsumptionCentralInstaller.exe`, `ConsumptionCentralInstaller.zip`
and `install.ps1` in `dist-exe`, on Windows with the .NET Framework C# compiler that ships with it.
The [installer workflow](../.github/workflows/installer.yml) runs the tests on Windows and Linux
and builds the exe.

## Releases

Installer releases are tagged `consumption-central-installer-v<version>`, the version in
`package.json`. GitHub's **Latest** release is left to report releases, so nothing here relies on
it. The installer's update check lists the releases and takes the newest published
`consumption-central-installer-v*`, and every command it shows is pinned to a release. The current
one is:

```powershell
irm https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/releases/download/consumption-central-installer-v0.1.0/install.ps1 | iex
```

All installer releases:
[releases?q=consumption-central-installer-v](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/releases?q=consumption-central-installer-v).

To release, bump the version in `package.json` and in the commands in this README and
[Install](../docs/INSTALL.md) (a test checks they match), merge, then push the tag. The
[installer workflow](../.github/workflows/installer.yml) builds the exe and drafts the release with
it. Publish the draft by hand with **Set as the latest release** unticked; the workflow warns if an
installer release became Latest anyway.
