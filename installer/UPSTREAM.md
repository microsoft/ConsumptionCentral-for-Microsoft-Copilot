# Where the installer comes from

The installer is ported from the Analytics Hub installer in [microsoft/AnalyticsHub-Dashboard](https://github.com/microsoft/AnalyticsHub-Dashboard), at commit [`1af87db`](https://github.com/microsoft/AnalyticsHub-Dashboard/tree/1af87db/installer). It keeps that installer's code and the way it works for people, so fixes made there can be brought here. This file records what was ported, what changed, and which Analytics Hub changes to follow.

## How the port was made

The pull request that added `installer/` built it in steps, so each change from Analytics Hub shows as a diff:

1. **Copy.** The Analytics Hub files the installer keeps, with their tests, unchanged.
2. **Drop.** The parts Consumption Central doesn't use (see [Dropped](#file-map)).
3. **Names.** Everything that names the product moves to `src/product.js`: the exe, the npm package and command, the install record and its `product` field, the release tag prefix and the titles people see.
4. **Consumption Central.** Everything after that.

To bring an Analytics Hub change across, diff it against `1af87db`, then apply it to the files the [file map](#file-map) lists as verbatim, renamed or adapted.

## What changed for Consumption Central

- **One model, on its own.** Analytics Hub deploys its consumption model only alongside ValueLens's model. Here Consumption Central's model stands alone. It's deployed from `2. Fabric/Consumption Central - Fabric.pbit`, and reads the Lakehouse through its own cloud connection, signed in as the app registration.
- **What to deploy comes from the repo.** `installer-assets.json`, at the repo root, lists the templates and notebooks, and the settings the installer may write into each notebook. `src/catalog.js` joins it with the installer's rules for each notebook, and throws on any mismatch.
- **Sources.** Each source offers its API, its CSV exports, or nothing. GitHub (`src/steps/github.js`, which checks the token with `src/clients/github.js`) and the commercial terms (`src/prices.js`, written into the model's price parameters) are new.
- **The pipeline** is built from the notebooks the chosen sources need. The loads run one after another, the way Analytics Hub runs its second lane, because a trial or small capacity turns concurrent notebooks away. Each load is retried. The model refresh waits for the usage loads to succeed, and the last step records each load in `dbo.load_log`.
- **Cowork task exports skip the router.** A Cowork task export and its `PeopleMetaData.csv` go straight to `Files/landing/viva/cowork_tasks`, where `Ingest_Viva_Consumption` reads the pair. Other exports go to the router's drop folder, as in Analytics Hub. Files given together are checked as a set first: two exports of a kind that replaces itself are refused, and so is a `PeopleMetaData.csv` on its own. The people file uploads first, and a task export whose people file fails is held back. `src/uploads.js` marks these kinds with the `refuse` policy, which Analytics Hub doesn't have.
- **Helper notebooks.** The upload router, load status and model refresh notebooks come from Analytics Hub's `fabric/notebooks/`, and their tests from its `tests/`.
- **Viewers.** The viewer group gets Build on the semantic model, and no workspace role: workspace viewers can read notebook code, and the notebooks can hold a client secret or a GitHub token. The installer asks once for the report to be shared with the group by hand, in the AI in One installer's words. "Later" leaves a card on the Done page, and Repair asks again.
- **Where the app's secret goes.** With the CSV defaults, no notebook needs the app's client secret, so it's only in the model's connection. The home page, the prerequisite list and the Key Vault check say the notebooks or Key Vault hold it only for sources read by API, and `rotate-secret` then replaces only the connection's. Analytics Hub always has API sources, so it never meets this case.
- **Prerequisites** are Consumption Central's. For the Copilot Studio flow, they check for an environment you can make flows in, and for a Power Platform, Billing or Global Administrator to sign in to its licensing connection. The checks only Agent Evaluator, the Azure route, the Teams app or ValueLens's sources needed are gone.
- **Release links.** The update check and every install one-liner use a release pinned to its version, not GitHub's "Latest" release. This repo's dashboard releases take "Latest", so a `releases/latest` link would find no installer.
- **Other products' installs.** The installer won't read an install record another product's installer wrote. It refuses a workspace Analytics Hub's installer set up, which it knows by Analytics Hub's item names or its installer's folder, and uninstall says when a workspace also holds such an install, then defaults to No. It warns when a workspace already loads consumption data with Analytics Hub's Credit Consumption module, so the same data isn't loaded twice. The workspace checks know only Analytics Hub's markers so far; the ValueLens and AI in One installers' can be added once those ship. `src/other-installs.js` holds the checks.

### Kept as they were

- `src/transform/payg.js` keeps Analytics Hub's `valuelens:payg:` seed for the lineage IDs it generates. Changing it would only churn the lineage tags.
- `src/clients/dataverse.js` keeps the application user calls that only Agent Evaluator used, so the file stays close to Analytics Hub's. The flows step uses the client to create the flows.
- The tests keep Analytics Hub's fixture names, such as a Lakehouse called `ValueLens`, so its test changes port as they are. `test/product.test.js` checks that no such name is left in what the installer shows, writes or deploys.

## File map

Paths are relative to `installer/`. A path that starts with `/` is relative to the root of the Analytics Hub repo. The map describes the port as it first merged; later changes are in git history.

<!-- filemap:start -->

**Verbatim (19).** Unchanged from 1af87db: `bin/consumption-central-installer.js` (was `bin/valuelens-install.js`), `jsconfig.json`, `packaging/public-registry.js`, `packaging/registry.js`, `src/clients/connections.js`, `src/clients/flow.js`, `src/clients/powerbi.js`, `src/clients/powerplatform.js`, `src/http.js`, `src/steps/advanced.js`, `src/steps/secrets.js`, `src/transform/dataflow.js`, `src/transform/report.js`, `src/transform/zip.js`, `src/web/icon.svg`, `test/dataverse.test.js`, `test/fixtures/dax_reserved_names.txt` (was `/tests/fixtures/dax_reserved_names.txt`), `test/launcher-check.cs`, `test/launcher.test.js`.

**Renamed (8).** Changed only by the names in `src/product.js`: `.gitignore`, `package-lock.json`, `packaging/finish-exe.js`, `packaging/launcher/Launcher.cs`, `packaging/launcher/app.manifest`, `src/web/index.html`, `test/setup-page.test.js`, `test/vault.test.js`.

**Adapted (86).** Changed for Consumption Central: `README.md`, `assets/notebooks/ConsumptionCentral_Load_Status.ipynb` (was `/fabric/notebooks/AnalyticsHub_Load_Status.ipynb`), `assets/notebooks/ConsumptionCentral_Refresh_Model.ipynb` (was `/fabric/notebooks/ValueLens_Refresh_Model.ipynb`), `assets/notebooks/ConsumptionCentral_Upload_Router.ipynb` (was `/fabric/notebooks/AnalyticsHub_Upload_Router.ipynb`), `package.json`, `packaging/build-exe.js`, `packaging/launcher/install.ps1`, `packaging/payload.js`, `packaging/script.js`, `packaging/signing.js`, `src/auth.js`, `src/catalog.js`, `src/cli.js`, `src/clients/azure.js`, `src/clients/dataverse.js`, `src/clients/fabric.js`, `src/clients/graph.js`, `src/clients/onelake.js`, `src/config.js`, `src/install.js`, `src/launch.js`, `src/loads.js`, `src/prereqs.js`, `src/server.js`, `src/setup.js`, `src/sources.js`, `src/staging.js`, `src/steps/access.js`, `src/steps/consumption.js`, `src/steps/data-sources.js`, `src/steps/fabric-uninstall.js`, `src/steps/fabric.js`, `src/steps/flows.js`, `src/steps/identity.js`, `src/steps/model.js`, `src/steps/next-steps.js`, `src/steps/plan.js`, `src/steps/report.js`, `src/steps/rerun.js`, `src/steps/run.js`, `src/transform/flows.js`, `src/transform/model.js`, `src/transform/notebook.js`, `src/transform/payg.js`, `src/transform/pipeline.js`, `src/ui.js`, `src/update-check.js`, `src/uploads.js`, `src/web-session.js`, `src/web-ui.js`, `src/web/app.css`, `src/web/app.js`, `test/access.test.js`, `test/advanced.test.js`, `test/consumption.test.js`, `test/cowork-load.test.js`, `test/cowork.test.js`, `test/fabric-uninstall.test.js`, `test/fakes.js`, `test/fallbacks.test.js`, `test/flows.test.js`, `test/helpers.test.js`, `test/http.test.js`, `test/install-verdict.test.js`, `test/loads.test.js`, `test/model-reset.test.js`, `test/model-step.test.js`, `test/model.test.js`, `test/next-steps.test.js`, `test/notebook.test.js`, `test/packaging.test.js`, `test/pipeline.test.js`, `test/prereqs.test.js`, `test/python/test_load_status.py` (was `/tests/test_load_status.py`), `test/python/test_refresh_model.py` (was `/tests/test_refresh_model.py`), `test/python/test_upload_router.py` (was `/tests/test_upload_router.py`), `test/record.test.js`, `test/report.test.js`, `test/script.test.js`, `test/setup.test.js`, `test/signing.test.js`, `test/steps.test.js`, `test/update-check.test.js`, `test/uploads.test.js`, `test/viewer-group.test.js`, `test/web.test.js`.

**New (20).** `src/clients/github.js`, `src/node-version.js`, `src/other-installs.js`, `src/prices.js`, `src/product.js`, `src/steps/github.js`, `src/steps/notebook-settings.js`, `test/catalog.test.js`, `test/cli.test.js`, `test/data-check.test.js`, `test/docs.test.js`, `test/github.test.js`, `test/install.test.js`, `test/notebook-settings.test.js`, `test/other-installs.test.js`, `test/plan-cc.test.js`, `test/prices.test.js`, `test/product.test.js`, `test/run-once.test.js`, `test/web-session.test.js`.

**Dropped (54).**

- **The Azure route:** `src/azure/main.arm.json`, `src/steps/azure/ask.js`, `src/steps/azure/index.js`, `src/steps/azure/least-privilege.js`, `src/steps/azure/regions.js`, `test/arm-expressions.js`, `test/arm-template.test.js`, `test/ask-references.test.js`, `test/azure-ask.test.js`, `test/azure-by-hand.test.js`, `test/azure-capacity.test.js`, `test/azure-regions.test.js`, `test/azure-sizing.test.js`, `test/azure-uninstall.test.js`, `test/azure.test.js`, `test/least-privilege.test.js`.
- **The Teams catalog:** `src/azure/teams.js`, `src/azure/teams/build-package.mjs`, `src/azure/teams/color.png`, `src/azure/teams/manifest.template.json`, `src/azure/teams/outline.png`, `src/steps/azure/teams-catalog.js`, `test/fixtures/MicrosoftTeams.v1.17.schema.json`, `test/teams-catalog.test.js`, `test/teams-manifest.test.js`.
- **Agent Evaluator:** `src/steps/agent-evaluator.js`, `src/steps/azure/agent-evaluator.js`, `test/agent-evaluator.test.js`, `test/azure-agent-evaluator.test.js`.
- **ValueLens's modules and model:** `src/currency.js`, `src/seats.js`, `src/steps/data-agent.js`, `src/steps/org-access.js`, `src/steps/resource-graph.js`, `src/transform/access.js`, `src/transform/data-agent.js`, `src/transform/defender.js`, `src/transform/load-log.js`, `src/transform/m365.js`, `src/transform/resource-graph.js`, `test/access-model.test.js`, `test/access-pipeline.test.js`, `test/currency.test.js`, `test/data-agent.test.js`, `test/defender.test.js`, `test/filter-columns.test.js`, `test/history.test.js`, `test/load-log.test.js`, `test/m365.test.js`, `test/org-access.test.js`, `test/resource-graph.test.js`, `test/seats.test.js`. These are M365, Defender, Resource Graph, the data agent, org access and its row-level security, seats, the model's Load Log and Evaluator Status tables, the Value page's currency, the app's filter profiles and the audit history reload.
- **The Fabric App (Rayfin) step:** `src/steps/app.js`. Its Node.js version check moved to `src/node-version.js`.
- **The signing job:** `packaging/sign-installer.azure-pipelines.yml`. It signs with ESRP from an internal Azure DevOps pipeline, which needs onboarding. `packaging/signing.js` is kept, so the job can follow.

<!-- filemap:end -->

## Analytics Hub changes to follow

These were open or planned in Analytics Hub when the port was made.

**Follow:**

- [AnalyticsHub-Dashboard#169](https://github.com/microsoft/AnalyticsHub-Dashboard/pull/169), "Installer: check audit ingestion up front, and sign in to Viva Insights first". Take the Viva Insights sign-in order and the prerequisite framework. Its audit ingestion check is for ValueLens, so leave that out.
- [AnalyticsHub-Dashboard#170](https://github.com/microsoft/AnalyticsHub-Dashboard/pull/170), "Installer: run the prerequisite checks inside install and update".
- [AnalyticsHub-Dashboard#181](https://github.com/microsoft/AnalyticsHub-Dashboard/pull/181), "Installer: size for the number of people, and ask in the main flow", for the Fabric route.
- From Analytics Hub's planned 0.6.9 self-serve changes: the hand-off status (S1), checking "Create workspaces" first (S3), an honest first-load timeline (S5a), the flow prerequisites up front (S6), and a hand-off pack split by admin (S7).

**Skip,** because they only change the Azure route: [AnalyticsHub-Dashboard#182](https://github.com/microsoft/AnalyticsHub-Dashboard/pull/182), "Azure: scoped delegation in the Share panel no longer fails with 503", and 0.6.9's S2, S4, S5b and S5c.

**Already here:** AnalyticsHub-Dashboard#167, #168, #171 and #173 to #180 are in `1af87db`. The model refresh-time cuts from #175 and #176 also came to this repo's templates, with [#50](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/pull/50).

## Changes to offer back to Analytics Hub

- **No "Latest" release.** Analytics Hub's update check and one-liners rely on GitHub's "Latest" release, which a dashboard release can take. Here the update check lists the releases and takes the newest installer tag, and the links name their release: `src/update-check.js`, `src/launch.js`, `packaging/script.js` and `packaging/launcher/install.ps1`.
- **The "still reloading" finish.** Analytics Hub's `install.js` prints "Analytics Hub is set up, still reloading", but the browser page's `DONE_HEADINGS` doesn't list it, so the page doesn't move to Done when a model is still reloading. It's fixed here in `src/web/app.js`, and `test/web.test.js` now checks the list both ways.

## The No Fabric route

The No Fabric route (PAX and SharePoint) is ported from the ValueLens installer in a later pull request, which records the ValueLens commit here.
