# Install

The installer sets up the [Fabric option](../2.%20Fabric/README.md) in your tenant: a workspace,
Lakehouse, notebooks, a pipeline on a schedule, the semantic model and the report. It loads the
first data, then you check it worked. To set it up by hand instead, follow the
[Fabric guide](../2.%20Fabric/README.md). The other options in the [README](../README.md) need no
installer.

Check [Before you start](../installer/README.md#before-you-start) first. Then start the installer
one of these ways. They all run the same installer and ask the same questions.

| Your PC | Start with |
|---|---|
| Windows 10 or 11 | [The PowerShell one-liner](#from-powershell) |
| Windows, and you'd rather download a program | [The exe](#run-it) |
| Windows, with a Node.js your IT team has approved | [IT-approved Node.js](#it-approved-nodejs) |
| Locked down, or not Windows | [Azure Cloud Shell](#locked-down-tenant--azure-cloud-shell) |
| Nothing can run locally, and no Cloud Shell | Your IT team deploys it, for example with Intune or Configuration Manager, or you run it from an approved admin workstation |
| A clone of this repo, with Node.js | [Without the exe](#without-the-exe) |

If your organisation's policy blocks a route, don't work around it. Use another route, or ask
your IT team.

When it finishes: [Check it worked](#check-it-worked).

## Run it

1. Start the installer. Paste this into PowerShell (see [From PowerShell](#from-powershell)):

   ```powershell
   irm https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/releases/download/consumption-central-installer-v0.1.0/install.ps1 | iex
   ```

   Or [download the exe](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/releases/download/consumption-central-installer-v0.1.0/ConsumptionCentralInstaller.exe)
   and open it. Both links get version 0.1.0. The installer says when there's a newer version and
   gives its command, and the
   [installer releases](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/releases?q=consumption-central-installer-v)
   list them all. To check the exe, see [Check the download](#check-the-download). If your
   organisation blocks either, use another route in the table above.
2. The first time, it takes a moment to unpack. Then it opens in your browser. Keep its window
   open while you use the page, and keep the PC awake and plugged in until it finishes. If you
   close the page, go back to that window and press **Enter** to open it again.
3. Choose **Set up Consumption Central** and sign in.
4. Answer the questions:
   1. **Data sources.** Each source has a card: connected (through an API, a flow or a Dataflow),
      **Upload CSV** or **Skip**. **Copilot Cowork and Work IQ credits** and **Copilot Studio
      credits** default to **Upload CSV**; the rest are skipped until you choose otherwise. A CSV
      card says where to export the file, and you can pick the exports to upload now. A source
      that needs more to work asks for it next, such as the Power Platform environment for the
      Studio flow or the Viva Insights query for the Cowork Dataflow. See
      [Data sources and exports](../installer/README.md#data-sources-and-exports).
   2. **Change the advanced settings?** **No** (the default) takes the defaults that suit most
      organisations, such as a daily run at 02:00 UTC and the first load as soon as setup
      finishes. See [Advanced settings](../installer/README.md#advanced-settings).
   3. **Capacity and workspace.** A new workspace is named `Consumption Central` and its
      Lakehouse `ConsumptionCentral`, or the next free name. A trial or small capacity works; on
      a large tenant, a larger capacity loads and refreshes faster. An existing install keeps its
      names.
   4. **App registration:** create one, use your own (it's checked first), or let an admin
      register it. See [If you can't register apps](../installer/README.md#if-you-cant-register-apps).
      The semantic model's connection to the Lakehouse signs in as the app, so even a CSV-only
      install with the model has one.
   5. **Where the secrets go**, when a notebook needs the app's client secret or the GitHub
      token: in the notebooks by default, with nothing in Azure. Or a Key Vault you create or
      pick; if you can't write to it, a vault admin can add the secret. See
      [Where the secrets go](../installer/README.md#where-the-secrets-go).
5. Check the plan and approve it. Nothing is created until you do. The plan shows every setting,
   including the defaults, and a **Costs** list of what's billed (the Fabric capacity, Power
   Automate Premium for the Studio flow, Azure Key Vault), with links to the pricing pages. The
   installer stops Windows going to sleep while it runs.
6. Wait for it to finish. It shows each step as it goes. The first load usually takes under an
   hour, longer on a trial or small capacity. Copilot Studio credits from the flow arrive after
   its first run, and Cowork credits from the Dataflow after you sign in to it: see
   [After it finishes](#after-it-finishes).
7. When it finishes, open the link to the report.

**Want to change an answer?** Choose **Back**, on any question or on the plan. It opens the
previous question with your answer filled in, and the questions after it are asked again. If you
go back to the client secret, leave the box empty to keep the one you pasted. If you go back
further, you'll be asked for it again.

It keeps your answers in `Documents\Consumption Central`, in an install record named
`consumption-central-setup.json`. Keep that folder. To run the pipeline, check status, update, or
repair the set-up later, start the installer again the same way. **Manage Consumption Central**
shows the record's full path. If OneDrive syncs your Documents folder, the record follows you to
your other PCs. The record holds no secrets.

**The workspace has gone?** After you sign in, the installer checks that the record's workspace
still exists. If Fabric says it doesn't, or the record is for another tenant, the home page says
so. Choose **Start fresh** to set up again. The old record is kept beside the new one, renamed
with the date and time, such as `consumption-central-setup.20260507-090302.json`. Or choose
**Keep this record** to carry on with it. In the terminal, `install` asks whether to start fresh.
If Fabric can't be reached, or you can't read the workspace, nothing changes.

**Using a workspace that already has things in it?** The installer never changes anything it
didn't create. If one of its names is taken, its own item gets the next free name, such as
`ConsumptionCentral_Pipeline_2` or `Consumption Central 2`. The plan shows the names before you
approve it.

**Item names.** A new install names its items after Consumption Central: the
`Consumption Central` report on `Consumption Central Model`, `ConsumptionCentral_Pipeline`, the
`ConsumptionCentral_Cowork_Credits` Dataflow, the `Consumption Central SQL …` connection and the
`Consumption Central (Fabric)` app registration. The notebooks keep the names they have in
[`2. Fabric/notebooks`](../2.%20Fabric/notebooks), such as `Ingest_Studio`, plus
`ConsumptionCentral_Upload_Router`, `ConsumptionCentral_Refresh_Model` and
`ConsumptionCentral_Load_Status`.

## Check it worked

1. **Read the Done page.** It lists what's left, as cards: who does each step and a message to
   send. See [After it finishes](#after-it-finishes).
2. **Check what loaded.** After the first run, each source has a card: loaded, failed, skipped,
   to do or still running. A failed card says why and what to do. The same is in the Lakehouse
   table `dbo.load_log`. See [Load status and reruns](../installer/README.md#load-status-and-reruns).
3. **Check status.** Open the installer again and choose **Check status** (`status`): recent runs,
   each source in the latest run, model refreshes, secret and token expiry, and the last data
   check. It changes nothing.
4. **Check the data.** **Check the data** (`check`) asks the semantic model how many rows each
   source gave it and the dates they cover, and how many people in the org data have a
   department, without running the pipeline.
5. **Open the report.** Open the link the installer gives you. Pages for sources you skipped stay
   empty.

Something failed? Choose **Rerun failed loads** (`rerun-failed`), or see
[Load status and reruns](../installer/README.md#load-status-and-reruns).

### After it finishes

- **What's left comes first.** The Done page (and the end of the terminal output) starts with
  "N steps left": a card for each thing still to do, in order, with who does it, why, a link and
  the steps. For a step another admin does, the card has a message to copy and send:
  - **Share the report with the viewer group**, if you chose **Later** when asked.
  - **Replace the GitHub token**, when it has expired or expires within 30 days.
  - **Sign in to the Power Automate flow**, for you or a Power Platform administrator.
  - **Sign in to the Dataflow** `ConsumptionCentral_Cowork_Credits`, when Cowork credits come from
    Viva Insights. Until then the first load skips it and scheduled runs fail at that step.
    That's expected: everything else loads. Then choose **Load Cowork now** (`load-cowork`).
  - **Ask a Viva Insights analyst for the Cowork credits query** (optional), when Cowork credits
    come from the CSV export.
- **Admin consent.** If you couldn't grant it, send the link the installer gives you to a Global
  Administrator or Privileged Role Administrator. They select **Grant admin consent**. Then open
  the installer again and choose **Run now**.
- **Share the report.** The installer creates **Consumption Central Viewers** (or uses a group you
  name) with you as owner, and gives it **Build** on the semantic model. Then:
  1. **Once:** share the report with the group. Straight after the report is published, the
     installer asks you to, with a link to it: choose **…** > **Manage permissions** >
     **Add user**, enter the group and choose **Grant**. Choose **I've shared it** and it isn't
     asked again. Choose **Later** and it's a card on the Done page, and **Repair or change** asks
     again.
  2. **To give someone access:** add them to the group in
     [My Groups](https://myaccount.microsoft.com/groups). You can also run `access`
     (**Manage access** in the browser).

  Keep viewers off workspace roles: a Viewer can read the notebooks, and with no Key Vault the
  secrets are in them. See [Power BI report and viewers](../installer/README.md#power-bi-report-and-viewers).
- **Your own reports.** Connect Power BI Desktop to `Consumption Central Model`, or use
  **Save a copy** on the published report.
- **Someone else takes over the pipeline?** The notebooks run as the person who last changed the
  pipeline, or the schedule's owner. Give them Contributor on the workspace first, and Key Vault
  Secrets User on the vault if the secrets are in one.
- **Secrets expire.** A client secret kept in the notebooks lasts 90 days by default, and each
  install, **Repair or change** and `update` replaces it. **Check status** shows when each secret
  and the GitHub token expire. Replace them with **Create new secrets** (`rotate-secret`) and
  **Replace the GitHub token** (`github-token`).

## Check the download

Each [installer release](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/releases?q=consumption-central-installer-v)
lists the exe's SHA-256, which is also in `ConsumptionCentralInstaller.exe.sha256`. To check your
copy, run this in PowerShell, in the folder you downloaded it to:

```powershell
(Get-FileHash .\ConsumptionCentralInstaller.exe -Algorithm SHA256).Hash
```

It should match, ignoring capitals. If it doesn't, delete the file and download it again.
`install.ps1` checks the zip's SHA-256 for you the same way.

A matching hash confirms the file is the one in the release. It doesn't confirm who published
it: the exe and `install.ps1` aren't code-signed yet. On a PC your organisation doesn't manage,
Edge may say the exe isn't commonly downloaded, and Windows SmartScreen may say it protected your
PC. On a managed PC, if policy blocks the exe, use the [PowerShell one-liner](#from-powershell) or
another route in the table at the top, or ask your IT team.

## From PowerShell

Paste this into PowerShell (Windows PowerShell 5.1 or PowerShell 7). It runs the same installer
as the exe, with the same browser steps:

```powershell
irm https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/releases/download/consumption-central-installer-v0.1.0/install.ps1 | iex
```

It downloads `ConsumptionCentralInstaller.zip` from that release (Node.js, the installer, the
notebooks and the report template), checks its SHA-256 against the one written into
`install.ps1`, unpacks it under `%LOCALAPPDATA%\ConsumptionCentral` and opens the installer in
your browser. It needs no admin rights, installs nothing system-wide and changes no settings. Run
a newer release's command to move to it; it removes the old version.

- **Later commands.** It leaves a command behind for the version it unpacked, for example
  `& $env:LOCALAPPDATA\ConsumptionCentral\consumption-central.cmd status`. With no arguments it
  opens the browser steps.
- **Always a fixed version.** Each command is pinned to its release, and each release's notes give
  its own. The installer checks for a newer full release when it starts and shows that release's
  command; it never updates itself. If a release's zip has since been removed, its command says
  so, links to the
  [installer releases](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/releases?q=consumption-central-installer-v)
  to pick another, and stops. It doesn't switch versions on its own.
- **Download and run.** To keep the files, download `install.ps1` and
  `ConsumptionCentralInstaller.zip` from the release and, where your execution policy allows
  scripts, run `.\install.ps1 -ZipPath .\ConsumptionCentralInstaller.zip`. Anything after the
  options goes to the installer, for example
  `... -ZipPath .\ConsumptionCentralInstaller.zip status`.
- **If policy blocks it.** If execution policy, endpoint protection or another control blocks
  `irm | iex` or the script, don't work around it. Use another route in the table at the top, or
  ask your IT team.
- **Behind a proxy.** It uses the system proxy. To name one, signed in as you, run
  `$env:CONSUMPTION_CENTRAL_PROXY = 'http://proxy:8080'` first. If the proxy blocks GitHub's
  download host, download the zip in a browser and set `$env:CONSUMPTION_CENTRAL_ZIP` to its path,
  or use `-ZipPath`.
- **Constrained Language Mode** works: the launcher only uses commands allowed there. It skips
  keeping the PC awake, so keep it plugged in and awake yourself.
- **Remove it** with `.\install.ps1 -Uninstall` (from the download-and-run steps above), or by
  deleting `%LOCALAPPDATA%\ConsumptionCentral`. That doesn't touch what's in your tenant, or your
  install record in `Documents\Consumption Central`. To remove what's in your tenant, use
  **Uninstall** in the installer first.

AppLocker or Windows Defender Application Control rules that block programs under your profile
stop the unpacked `node.exe`, as they stop the exe. The launcher and the exe spot this and say
what to do instead of showing the raw error. If your IT team has approved a Node.js install, for
example from Company Portal, use [IT-approved Node.js](#it-approved-nodejs). Otherwise use
[Azure Cloud Shell](#locked-down-tenant--azure-cloud-shell), or ask your IT team.

## IT-approved Node.js

If your organisation has installed an approved Node.js (22.13 or later on 22.x, or 24.x; x64),
the PowerShell launcher can run the installer with it instead of the `node.exe` in the zip:

```powershell
$env:CONSUMPTION_CENTRAL_USE_INSTALLED_NODE = '1'; irm https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/releases/download/consumption-central-installer-v0.1.0/install.ps1 | iex
```

Or, from the [download-and-run](#from-powershell) files,
`.\install.ps1 -ZipPath .\ConsumptionCentralInstaller.zip -UseInstalledNode`.

- **Which Node.js.** The `node` on your PATH. It stops if that's missing, too old or not x64.
- **What's still downloaded.** The same zip, checked the same way and unpacked to
  `%LOCALAPPDATA%\ConsumptionCentral`: the installer's JavaScript, the notebooks and the report
  template. The zip's `node.exe` is unpacked but not run. The installer has no native add-ons, so
  nothing else runs from your profile.
- **Same install.** It uses the same folders and the same install record as the other Windows
  routes, so you can switch routes without a second install. The command it leaves behind,
  `consumption-central.cmd`, keeps using the approved Node.js, and the update command the
  installer shows keeps the setting.

## Locked-down tenant / Azure Cloud Shell

If your PC can't run the exe or the PowerShell command (AppLocker, WDAC, or no local PowerShell at
all), run the installer in [Azure Cloud Shell](https://shell.azure.com) instead. Nothing runs on
your PC: the installer runs in Cloud Shell and asks its questions in the terminal. Choose
**PowerShell** in Cloud Shell and paste the same command:

```powershell
irm https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/releases/download/consumption-central-installer-v0.1.0/install.ps1 | iex
```

In Cloud Shell, `install.ps1` doesn't download the Windows zip. It fetches the release's source
from GitHub at the commit written into `install.ps1`, checks it got that commit, and installs the
installer's packages with `npm ci` from the lockfile. If Cloud Shell's Node.js is older than 22.13,
it downloads the Node.js version the release was built with from nodejs.org and checks its SHA-256
against the list nodejs.org publishes. It all goes in `~/.consumption-central`. The first run
takes a minute or two.

- **Options.** To pass options or a command, run
  `& ([scriptblock]::Create((irm https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/releases/download/consumption-central-installer-v0.1.0/install.ps1))) --use-az status`.
  In Bash, run
  `pwsh -c "irm https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/releases/download/consumption-central-installer-v0.1.0/install.ps1 | iex"`.
- **Later commands.** It leaves `~/.consumption-central/consumption-central` behind, which works
  from Bash or PowerShell, for example `~/.consumption-central/consumption-central status`. To
  update, run a newer release's command.
- **Terminal only.** Cloud Shell can't open the installer's page in your browser, so `--ui` isn't
  available. The terminal asks the same questions.
- **Signing in.** By default the installer signs you in with a code: it shows a code and a link,
  and you sign in on any device. The tokens stay in memory, so each run asks again. Cloud Shell's
  own sign-in, which the Azure CLI uses until you sign it in, can't get tokens for some of the APIs
  the installer uses. To use `--use-az`, first run `az login --use-device-code`. The installer
  checks the Azure CLI can reach every API it uses before it changes anything, and says which it
  couldn't. The Azure CLI stays signed in between Cloud Shell sessions.
- **If Conditional Access blocks sign-in with a code**, Cloud Shell can't run the installer:
  both ways of signing in use a code there. Ask whoever manages Conditional Access, or run the
  installer on a PC that's allowed.
- **Keep the install record.** It's in `~/consumption-central/consumption-central-setup.json`.
  Your home folder is kept between sessions only if Cloud Shell has a storage account (it then has
  `~/clouddrive`); `install.ps1` warns if it doesn't, and so may a tenant policy that changes new
  storage accounts so Cloud Shell can't mount them. Without the record, running the installer
  again sets up a second copy, so in that case download it before you close Cloud Shell: choose
  **Manage files** > **Download** and enter
  `consumption-central/consumption-central-setup.json`. The installer reminds you at the end of
  each run. In a new session, upload it with **Manage files** > **Upload** and run the installer
  again: it moves the uploaded record from your home folder to where it looks. To carry on from a
  PC later, put the record in `Documents\Consumption Central`.
- **Idle timeout.** Cloud Shell ends a session after 20 minutes without input. If that stops the
  installer, run the same command again: it reuses what's in the install record, skips finished
  steps and doesn't create a second app. `--no-wait` saves waiting for the first load.
- **Remove it** with
  `& ([scriptblock]::Create((irm https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/releases/download/consumption-central-installer-v0.1.0/install.ps1))) -Uninstall`,
  or by deleting `~/.consumption-central`. Your install record stays.

`install.ps1` spots Cloud Shell from the environment variables it sets. To force it either way,
set `$env:CONSUMPTION_CENTRAL_CLOUD_SHELL` to `1` or `0` first. Cloud Shell is the PowerShell
launcher's only Linux target; on other Linux or macOS machines, use
[Without the exe](#without-the-exe).

## Without the exe

If you can't run the exe, run the installer from a clone of this repo with Node.js 22.13 or later:

```text
cd "installer"
npm install
npx consumption-central-installer --ui
```

Leave out `--ui` to answer the questions in the terminal. Other commands: `run`, `rerun-failed`,
`load-cowork`, `check`, `refresh`, `status`, `update`, `rotate-secret`, `github-token`, `access`,
`upload`, `uninstall`, `prereqs` and `preview`. Add `--help` for options. The exe takes the same
commands, for example `ConsumptionCentralInstaller.exe status`. `install --yes` keeps the secrets
in the notebooks for a new install; read
[the trade-off](../installer/README.md#where-the-secrets-go) first, and add `--key-vault` to use
Key Vault instead. `--secret-days <n>` sets how long the client secret in the notebooks lasts.
