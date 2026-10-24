// @ts-check
/**
 * Wires the clients together and runs each command.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { checkTokens, createCredential, createTokenProvider, decodeJwt } from './auth.js';
import { notebooksFor, onceNotebooks, permissionsFor, secretWanted } from './catalog.js';
import { armApi, keyVaultApi } from './clients/azure.js';
import { connectionsApi, POWERAPPS_URL } from './clients/connections.js';
import { dataverseApi, dataverseScope, DISCOVERY_URL, discoveryApi, orgUrl } from './clients/dataverse.js';
import { FLOW_URL, flowApi } from './clients/flow.js';
import { fabricApi, scheduleBody } from './clients/fabric.js';
import { githubApi } from './clients/github.js';
import { CONSENT_ROLES, graphApi } from './clients/graph.js';
import { ONELAKE_URL, oneLakeApi } from './clients/onelake.js';
import { powerBiApi } from './clients/powerbi.js';
import { POWER_PLATFORM_URL, powerPlatformApi } from './clients/powerplatform.js';
import { saveConfig, secretMode } from './config.js';
import { createClient, defaultSleep } from './http.js';
import { commandLine } from './launch.js';
import { priceParameters } from './prices.js';
import { ENV, LAKEHOUSE_NAME, PRODUCT_NAME, RECORD_FILE } from './product.js';
import { ensureGithubToken, ensureIdentity, newSecret, notebookSecretDays } from './steps/identity.js';
import { COWORK_DATAFLOW_NAME, consumptionSummary, ensureAzureAiAccess, ensureCoworkDataflow, ensureLandingFolders } from './steps/consumption.js';
import { coworkDataflowDefinition, isVivaId } from './transform/dataflow.js';
import {
  appSecretKept,
  deployedSources,
  describeSchedule,
  ensureLakehouse,
  ensureNotebooks,
  ensurePipeline,
  ensureSparkSettings,
  ensureSchedule,
  ensureVaultEndpoint,
  ensureWorkspace,
  modelDeployed,
  notebookOptions,
  pipelineSettings,
  PIPELINE_NAME,
} from './steps/fabric.js';
import { notebookSettings } from './steps/notebook-settings.js';
import { ensureModelConnection, ensureSemanticModel, modelUrl, pendingReloads, refreshModel, rotateModelSecret, settleReloads, verifyModel } from './steps/model.js';
import { confirmPlan, plan, preflight } from './steps/plan.js';
import { checkPrereqs } from './prereqs.js';
import { ensureReports, reportsOn, reportsSummary } from './steps/report.js';
import { dataSourcesSummary, ensureUploads, uploadCommand } from './steps/data-sources.js';
import { ensureFlows, FLOW_FILES, flowDefinitions, flowsSummary, flowsWanted, offerStudioRun } from './steps/flows.js';
import { routerWanted } from './uploads.js';
import { checkData, chooseLoad, coworkSkipForFirstLoad, runDataCheck, runOnceNotebooks, runPipeline, status, TERMINAL } from './steps/run.js';
import { loadCoworkNow, rerunFailed } from './steps/rerun.js';
import { prepareNotebook, serialiseNotebook } from './transform/notebook.js';
import { buildModel, loadTemplateModel } from './transform/model.js';
import { buildPipeline } from './transform/pipeline.js';
import { c } from './ui.js';
import { fabricUninstall } from './steps/fabric-uninstall.js';
import { accessCommand, ensureViewerGroup, grantModelAccess, myGroupsUrl, shareReport, shareReportPending } from './steps/access.js';
import { askGithubToken, githubSecretName, tokenLine, TOKENS_URL } from './steps/github.js';
import { nextSteps, stepsLeftTitle } from './steps/next-steps.js';
import { reviewSetup } from './setup.js';

/**
 * @typedef {object} Apis
 * @property {import('./clients/fabric.js').FabricApi} fabric
 * @property {import('./clients/graph.js').GraphApi} graph
 * @property {import('./clients/azure.js').ArmApi} arm
 * @property {import('./clients/azure.js').KeyVaultApi} keyVault
 * @property {import('./clients/onelake.js').OneLakeApi} oneLake
 * @property {import('./clients/powerbi.js').PowerBiApi} powerBi
 * @property {import('./clients/dataverse.js').DiscoveryApi} discovery
 * @property {import('./clients/powerplatform.js').PowerPlatformApi} powerPlatform
 * @property {import('./clients/flow.js').FlowApi} flow
 * @property {import('./clients/connections.js').ConnectionsApi} [connections]  Power Platform connections, for signing the flows in.
 * @property {(url: string) => import('./clients/dataverse.js').DataverseApi} dataverse  A Dataverse environment, by org URL.
 * @property {(token: string) => import('./clients/github.js').GithubApi} github  GitHub, with a token the user gave. A factory, so memoApi leaves it alone and each check is live.
 *
 * @typedef {{ id: string, upn: string, tenantId: string, displayName?: string }} User
 *
 * @typedef {object} Ctx
 * @property {import('./ui.js').Ui} ui
 * @property {import('./config.js').InstallConfig} config
 * @property {string} file
 * @property {() => void} save  Writes the install record.
 * @property {Apis} api
 * @property {User} user
 * @property {import('./sources.js').Sources} sources
 * @property {(ms: number) => Promise<void>} sleep
 * @property {() => Date} now
 * @property {string} [pendingSecret]  A secret the user pasted, held in memory until it is in Key Vault or the notebooks.
 * @property {import('./steps/github.js').PendingToken} [pendingGithubToken]  A GitHub token the user gave, held in memory until it's in Key Vault or Ingest_GitHub_API.
 * @property {boolean} [secretInNotebook]  --no-key-vault (or --secret-in-notebook): keep the secret in the notebooks instead of Key Vault.
 * @property {boolean} [useKeyVault]  --key-vault: keep the secret in Key Vault, not the notebooks (the default for a new Fabric install).
 * @property {boolean} [allowModelReset]  --allow-model-reset: when Fabric can't update a model and keep its data, clear it and reload it without asking. --yes alone never does.
 * @property {Apis} [liveApi]  While the plan's answers can be rewound, the clients without the cache, for checks the user repeats.
 * @property {boolean} [runFirstLoad]
 * @property {boolean} [advanced]  The plan's "Change the advanced settings?" answer. With false, those settings keep their saved value or default.
 * @property {{ sp: any, roles: { id: string, value: string }[] }} [graphRoles]
 * @property {Set<string>} [handoffShown]  The vault admin hand-offs already shown this run: 'secret', 'githubToken'.
 * @property {import('./staging.js').PendingUpload[]} [pendingUploads]  Exports to upload to the drop folder during the install.
 * @property {string[]} [csvFiles]  Exports named with --csv.
 * @property {string} [configFile]  The install record's path.
 * @property {(resource: import('./auth.js').Resource) => Promise<string>} [getToken]  The signed-in user's tokens, for tools the installer runs.
 * @property {string} [setupSection] Open this settings category directly after a failure.
 * @property {boolean} [setupRetry] Revalidate saved choices without reopening every question.
 * @property {boolean} [targetChosen]  --target was given, so the route isn't asked about.
 * @property {number} [reloadHistoryDays]  Repair or change on the PAX route's audit mode: reload this many days of history after setup. Never in the install record.
 * @property {import('./steps/pax/local.js').PaxHost} [paxHost]  This machine, for the PAX route's local steps.
 * @property {import('./managed-app/flow.js').AppDeps} [appDeps]  What the app step runs the `ms` CLI with, and where. Tests pass fakes.
 * @property {string} [environmentId]  --environment-id: the Power Platform environment for the app.
 */

/**
 * Signs in once and builds a client for each API.
 * @param {{ tenantId?: string, method?: 'browser' | 'device-code' | 'azure-cli', ui: import('./ui.js').Ui, debug?: (m: string) => void, checkTokens?: boolean }} opts
 *   checkTokens: get a token for every API first, so a sign-in that can't reach one fails before anything changes.
 * @returns {Promise<{ api: Apis, user: User, getToken: (resource: import('./auth.js').Resource) => Promise<string> }>}
 */
export async function connect(opts) {
  const credential = createCredential({ tenantId: opts.tenantId, method: opts.method, print: (m) => opts.ui.line(m) });
  const getToken = createTokenProvider(credential, { debug: opts.debug });
  /**
   * @param {string} baseUrl
   * @param {import('./auth.js').Resource} resource
   */
  const client = (baseUrl, resource) => createClient({ baseUrl, getToken: () => getToken(resource), debug: opts.debug });
  /** @type {Apis} */
  const api = {
    fabric: fabricApi(client('https://api.fabric.microsoft.com/v1', 'fabric')),
    graph: graphApi(client('https://graph.microsoft.com/v1.0', 'graph')),
    arm: armApi(client('https://management.azure.com', 'arm')),
    keyVault: keyVaultApi(client('https://vault.azure.net', 'keyVault')),
    oneLake: oneLakeApi(client(ONELAKE_URL, 'storage')),
    powerBi: powerBiApi(client('https://api.powerbi.com/v1.0/myorg', 'powerbi')),
    discovery: discoveryApi(client(DISCOVERY_URL, 'discovery')),
    powerPlatform: powerPlatformApi(client(POWER_PLATFORM_URL, 'powerPlatform')),
    flow: flowApi(client(FLOW_URL, 'flow')),
    connections: connectionsApi(client(POWERAPPS_URL, 'powerApps')),
    dataverse: (url) => dataverseApi(client(`${orgUrl(url)}/api/data/v9.2`, dataverseScope(url)), url),
    github: (token) => githubApi(token, { debug: opts.debug }),
  };
  if (opts.checkTokens) await checkTokens(getToken);
  const claims = decodeJwt(await getToken('graph'));
  const me = await api.graph.me();
  return { api, user: { id: me.id, upn: me.userPrincipalName, displayName: me.displayName, tenantId: claims.tid }, getToken };
}

/**
 * @param {{ ui: import('./ui.js').Ui, config: import('./config.js').InstallConfig, file: string, api: Apis, user: User, sources: import('./sources.js').Sources, sleep?: (ms: number) => Promise<void>, now?: () => Date, getToken?: (resource: import('./auth.js').Resource) => Promise<string> }} o
 * @returns {Ctx}
 */
export function createCtx(o) {
  if (o.config.tenantId && o.user.tenantId && o.config.tenantId !== o.user.tenantId) {
    throw new Error(`The install record is for tenant ${o.config.tenantId}, but you signed in to ${o.user.tenantId}. Use --tenant ${o.config.tenantId}.`);
  }
  o.config.tenantId = o.user.tenantId;
  return {
    ui: o.ui,
    config: o.config,
    file: o.file,
    save: () => saveConfig(o.file, o.config),
    api: o.api,
    user: o.user,
    sources: o.sources,
    sleep: o.sleep ?? defaultSleep,
    now: o.now ?? (() => new Date()),
    configFile: o.file,
    ...(o.getToken ? { getToken: o.getToken } : {}),
  };
}

/** @param {Ctx} ctx */
async function canConsent(ctx) {
  const roles = await ctx.api.graph.myDirectoryRoles().catch(() => []);
  return roles.some((r) => r.roleTemplateId in CONSENT_ROLES);
}

/**
 * The same clients, except that a call made again with the same arguments gets the first call's
 * answer. Going back runs the plan's questions again from the start: this keeps that quick, and
 * keeps the lists the same as the first time. A call that fails isn't kept.
 * @param {Apis} api
 * @returns {Apis}
 */
export function memoApi(api) {
  /** @type {Map<string, Promise<unknown>>} */
  const seen = new Map();
  const copy = (/** @type {unknown} */ v) => {
    try {
      return structuredClone(v);
    } catch {
      return v;
    }
  };
  /** @param {string} client @param {string} name @param {unknown[]} args */
  const keyOf = (client, name, args) => {
    if (args.some((a) => typeof a === 'function')) return undefined;
    try {
      return `${client}.${name}(${JSON.stringify(args)})`;
    } catch {
      return undefined;
    }
  };
  /** @param {string} client @param {object} target */
  const wrap = (client, target) =>
    new Proxy(target, {
      get(t, name, receiver) {
        const fn = Reflect.get(t, name, receiver);
        if (typeof fn !== 'function' || typeof name !== 'string') return fn;
        return (/** @type {unknown[]} */ ...args) => {
          const key = keyOf(client, name, args);
          if (key === undefined) return fn.apply(t, args);
          let p = seen.get(key);
          if (!p) {
            const result = fn.apply(t, args);
            if (!result || typeof result.then !== 'function') return result;
            const mine = Promise.resolve(result);
            seen.set(key, mine);
            mine.catch(() => {
              if (seen.get(key) === mine) seen.delete(key);
            });
            p = mine;
          }
          return p.then(copy);
        };
      },
    });
  return /** @type {Apis} */ (Object.fromEntries(Object.entries(api).map(([client, v]) => [client, v && typeof v === 'object' ? wrap(client, v) : v])));
}

/**
 * Runs the questions in `fn`, and runs them again from the start each time the user goes back.
 * The web UI gives the earlier answers again by itself, so it stops at the question before the
 * one the user was on. The config and the answers kept on `ctx` are put back first, and the API
 * calls are reused. The terminal can't go back, so there `fn` just runs.
 * @template T
 * @param {Ctx} ctx
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function rewindable(ctx, fn) {
  const ui = /** @type {{ begin?: () => void, end?: () => void }} */ (/** @type {unknown} */ (ctx.ui));
  if (!ui.begin || !ui.end) return fn();
  // save() writes this object, so it's put back in place rather than replaced.
  const config = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (ctx.config));
  const snapshot = structuredClone(config);
  const { pendingSecret, pendingGithubToken, runFirstLoad, pendingUploads } = ctx;
  const real = ctx.api;
  ctx.api = memoApi(real);
  ctx.liveApi = real;
  ui.begin();
  try {
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (/** @type {Error | undefined} */ (err)?.name !== 'GoBack') throw err;
        for (const key of Object.keys(config)) delete config[key];
        Object.assign(config, structuredClone(snapshot));
        ctx.pendingSecret = pendingSecret;
        ctx.pendingGithubToken = pendingGithubToken;
        ctx.runFirstLoad = runFirstLoad;
        ctx.pendingUploads = pendingUploads;
      }
    }
  } finally {
    ctx.api = real;
    delete ctx.liveApi;
    ui.end();
  }
}

/**
 * Full set-up, or a repair when the install record already has IDs.
 * @param {Ctx} ctx
 * @param {{ wait: boolean }} opts
 * @returns {Promise<boolean>} false when a step failed and the install carried on, or the first load or model refresh it
 *   waited for didn't leave a working model.
 */
export async function install(ctx, opts) {
  const { ui, config } = ctx;
  let go;
  /** @type {import('./steps/plan.js').Preflight | undefined} */
  let pre;
  if (ui.web) {
    go = await reviewSetup(ctx);
    if (go) pre = await preflight(ctx);
  }
  else {
    pre = await preflight(ctx);
    const checked = pre;
    go = await rewindable(ctx, async () => {
      await plan(ctx, checked);
      ctx.save();
      return confirmPlan(ctx, checked);
    });
  }
  if (!go) {
    ui.warn('Stopped before changing anything. Your answers are saved for next time.');
    return true;
  }

  const sm = config.semanticModel;
  const withModel = !!sm.enabled;
  const withUploads = routerWanted(config.dataSources) || !!ctx.pendingUploads?.length || flowsWanted(config).length > 0;
  const withReports = reportsOn(config);
  const withAccess = withModel && !!config.access;
  const withTerms = onceNotebooks(ctx.sources.catalog, deployedSources(config)).length > 0;
  const titles = [
    'App registration and secrets',
    'Workspace and Lakehouse',
    ...(withModel ? ['Semantic model'] : []),
    'Consumption sources',
    ...(withReports ? ['Power BI report'] : []),
    ...(withUploads ? ['Data uploads'] : []),
    'Notebooks, pipeline and schedule',
    ...(withAccess ? ['Viewer access'] : []),
    ...(withTerms ? ['Commercial terms'] : []),
    ...(ctx.runFirstLoad ? ['First load'] : withModel ? ['Model refresh'] : []),
  ];
  let n = 0;
  const step = (/** @type {string} */ title) => ui.step(++n, titles.length, title);

  step('App registration and secrets');
  // What the first load has to wait for: admin consent, the GitHub token, or a vault admin.
  const waitFor = await ensureIdentity(ctx, { canConsent: !!pre?.canConsent });
  step('Workspace and Lakehouse');
  await ensureWorkspace(ctx);
  await ensureLakehouse(ctx);
  const vaultReachable = await ensureVaultEndpoint(ctx);
  if (withModel) {
    step('Semantic model');
    await ensureSemanticModel(ctx);
    await ensureModelConnection(ctx);
  }
  step('Consumption sources');
  await consumptionSteps(ctx);
  // A step that fails and lets the install carry on leaves it partly set up. One that only warns doesn't.
  let stepsOk = true;
  if (withReports) {
    step('Power BI report');
    stepsOk = (await ensureReports(ctx)) && stepsOk;
  }
  if (withUploads) {
    step('Data uploads');
    stepsOk = (await ensureUploads(ctx)) && stepsOk;
    await ensureFlows(ctx);
  }
  step('Notebooks, pipeline and schedule');
  // With no Key Vault, each install or repair gives the notebooks a new client secret.
  await ensureNotebooks(ctx, { rotate: true });
  await ensureSparkSettings(ctx);
  await ensurePipeline(ctx);
  await ensureSchedule(ctx);
  if (withAccess) {
    step('Viewer access');
    if (await ensureViewerGroup(ctx)) await grantModelAccess(ctx, fabricViewerModels(config));
    // Before the first load, which can take hours, so viewers can open the report while it runs.
    if (shareReportPending(config)) await shareReport(ctx);
  }

  // A Studio flow that's on but hasn't loaded its six months yet: run it now, before the pipeline.
  if (withUploads) await offerStudioRun(ctx, { pipelineNext: !!ctx.runFirstLoad && !waitFor && vaultReachable, quietWhenOff: true });

  if (withTerms) {
    step('Commercial terms');
    // It runs as you and needs no app secret, so it doesn't wait for consent or a token. Until it
    // completes, the model prices credits at the rates set in the installer: it only warns.
    await runOnceNotebooks(ctx);
  }

  let ok = true;
  // The pipeline refreshes the model as its last step. When it can't, a model owed a reload is refreshed on its own.
  /** @type {import('./steps/model.js').LoadState} */
  let load = 'none';
  if (ctx.runFirstLoad) {
    step('First load');
    if (waitFor) {
      ui.warn(`Skipped until ${waitFor}. Then run: ${commandLine('run')}`);
    } else if (!vaultReachable) {
      ui.warn(`Skipped until the private endpoint to ${config.keyVault.name} is approved. Then run: ${commandLine('run')}`);
    } else {
      if (modelDeployed(config)) ui.note(`The pipeline refreshes ${sm.name} as its last step.`);
      const skipCowork = await coworkSkipForFirstLoad(ctx);
      const result = await runPipeline(ctx, { wait: opts.wait, first: true, skipCowork });
      load = loadState(result);
      if (result.status === 'Completed') {
        // A run completes even when a load in it failed.
        if (result.counted?.length) stepsOk = false;
        if ((await runDataCheck(ctx)) === false) stepsOk = false;
        if (modelDeployed(config)) ok = (await verifyModel(ctx)).ok;
      }
      if (opts.wait && config.firstRun?.status !== 'Completed') ok = false;
    }
  } else if (withModel) {
    step('Model refresh');
    ok = await restoreModels(ctx, { wait: opts.wait });
    load = 'refreshed';
  }
  const reloads = await settleReloads(ctx, { wait: opts.wait, load, reachable: fabricReachable(config) });
  if (!reloads.ok) notFinished(ctx, 'install');
  ok = reloads.ok && ok && stepsOk;
  await summary(ctx, { ok, pending: reloads.pending });
  return ok;
}

/**
 * How far a pipeline run got with reloading the model it refreshes as its last step.
 * @param {import('./steps/run.js').RunResult} result
 * @returns {import('./steps/model.js').LoadState}
 */
export function loadState(result) {
  if (result.status === 'Completed') return 'done';
  // Failed, cancelled and the like: it won't refresh it.
  if (TERMINAL.has(/** @type {string} */ (result.status))) return 'none';
  // Started and not waited for, or another run is going: either refreshes it when it finishes.
  return 'running';
}

/**
 * Azure AI access, the landing folders and the Cowork credits Dataflow.
 * @param {Ctx} ctx
 */
async function consumptionSteps(ctx) {
  if (ctx.config.dataSources.azureAi === 'api') await ensureAzureAiAccess(ctx);
  else ctx.ui.note('Azure AI is left out.');
  await ensureLandingFolders(ctx);
  await ensureCoworkDataflow(ctx);
}

/**
 * The deployed model that reads the Lakehouse, if there is one.
 * @param {import('./config.js').InstallConfig} config
 * @returns {import('./config.js').ModelConfig[]}
 */
function deployedModels(config) {
  return modelDeployed(config) ? [config.semanticModel] : [];
}

/** @param {string[]} names */
const joinNames = (names) => (names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/**
 * The model the viewer group needs Build on, once it exists, bound to its connection or not yet.
 * @param {import('./config.js').InstallConfig} config
 * @returns {import('./steps/access.js').ModelRef[]}
 */
export function fabricViewerModels(config) {
  const ws = config.fabric.workspaceId;
  const sm = config.semanticModel;
  if (!ws || !sm.enabled || !sm.id) return [];
  return [{ workspaceId: ws, datasetId: sm.id, name: sm.name }];
}

/**
 * Refreshes the model, when it reads the Lakehouse.
 * @param {Ctx} ctx
 * @param {{ wait?: boolean }} opts
 * @returns {Promise<{ ok: boolean, status?: string }>}
 */
async function refreshModels(ctx, opts) {
  if (modelDeployed(ctx.config)) return refreshModel(ctx, opts);
  ctx.ui.warn(`Skipped: ${ctx.config.semanticModel.name} isn't connected to the Lakehouse yet.`);
  return { ok: false };
}

/**
 * Refreshes the model and, when it waits, checks the model answers queries. Not waiting, it's
 * enough that the refresh started; a model owed a reload is settled after (see settleReloads).
 * @param {Ctx} ctx
 * @param {{ wait: boolean }} opts
 * @returns {Promise<boolean>}
 */
async function restoreModels(ctx, opts) {
  const refreshed = await refreshModels(ctx, { wait: opts.wait });
  if (!refreshed.ok) return !opts.wait;
  return opts.wait ? (await verifyModel(ctx)).ok : true;
}

/**
 * Whether a refresh can reach a Fabric model: deployed and reading the Lakehouse.
 * @param {import('./config.js').InstallConfig} config
 */
function fabricReachable(config) {
  const ids = new Set(deployedModels(config).map((m) => m.id));
  return (/** @type {import('./config.js').ModelConfig} */ m) => ids.has(m.id);
}

/**
 * Pushes the notebooks, pipeline and model from this checkout over the deployed ones.
 * @param {Ctx} ctx
 * @param {{ wait?: boolean }} [opts]
 */
export async function update(ctx, opts = {}) {
  const { ui, config } = ctx;
  if (!config.fabric.workspaceId || !config.fabric.lakehouseId) throw new Error('Nothing is installed yet. Run the installer first.');
  const sm = config.semanticModel;
  ui.heading(`Updating ${PRODUCT_NAME}`);
  ui.note(`From ${ctx.sources.dir}`);
  await ensureIdentity(ctx, { canConsent: await canConsent(ctx) });
  await ensureWorkspace(ctx);
  await ensureLakehouse(ctx);
  await ensureVaultEndpoint(ctx);
  if (sm.enabled) {
    await ensureSemanticModel(ctx, { force: true });
    await ensureModelConnection(ctx);
  }
  await consumptionSteps(ctx);
  // As in install: a step that fails and lets the update carry on leaves it unfinished.
  let stepsOk = true;
  if (reportsOn(config)) stepsOk = (await ensureReports(ctx)) && stepsOk;
  if (routerWanted(config.dataSources)) stepsOk = (await ensureUploads(ctx)) && stepsOk;
  await ensureFlows(ctx);
  await ensureNotebooks(ctx, { force: true });
  await ensureSparkSettings(ctx);
  await ensurePipeline(ctx, { force: true });
  await ensureSchedule(ctx);
  // The credit rate is read again for the last full month. Only warns, as in install.
  await runOnceNotebooks(ctx, { force: true, again: 'update' });
  return finishUpdate(ctx, { ...opts, failed: !stepsOk });
}

/**
 * The end of an update: refreshes the model so it loads its data with the new definition. "Up to
 * date" only once a model owed a reload has finished reloading and no step failed; not waiting, the
 * refresh started is success, but said as such.
 * @param {Ctx} ctx
 * @param {{ wait?: boolean, failed?: boolean }} [opts]  failed: a step before this failed, and the update carried on.
 * @returns {Promise<boolean>}
 */
export async function finishUpdate(ctx, opts = {}) {
  const { ui, config } = ctx;
  const wait = opts.wait ?? true;
  let ok = true;
  if (modelDeployed(config)) {
    ui.note('The model refreshes now, to load its data with the new definition.');
    const refreshed = await refreshModels(ctx, { wait });
    if (!refreshed.ok) ok = false;
    else if (wait && !(await verifyModel(ctx)).ok) return false;
  }
  const reloads = await settleReloads(ctx, { wait, load: modelDeployed(config) ? 'refreshed' : 'none', reachable: fabricReachable(config) });
  if (!ok || !reloads.ok) {
    notFinished(ctx, 'update');
    return false;
  }
  if (opts.failed) {
    ui.fail(`The update isn't finished: a step above failed. Fix what it says, then run "${commandLine('update')}" again.`);
    if (reloads.pending.length) ui.warn(reloadingNote(reloads.pending));
    return false;
  }
  if (reloads.pending.length) {
    ui.ok(`Updated. ${reloadingNote(reloads.pending)}`);
    return true;
  }
  ui.ok('Up to date. The next scheduled run uses the new versions.');
  return true;
}

/** @param {string[]} names */
function reloadingNote(names) {
  return `${joinNames(names)} ${names.length === 1 ? 'is' : 'are'} still reloading: reports on ${names.length === 1 ? 'it' : 'them'} can show no data or miss new columns until that finishes. Check with "${commandLine('status')}".`;
}

/** @param {Ctx} ctx @param {'install' | 'update'} what */
function notFinished(ctx, what) {
  const cleared = pendingReloads(ctx.config).filter((m) => m.reload?.cleared).map((m) => m.name);
  if (cleared.length) ctx.ui.warn(`${joinNames(cleared)} ${cleared.length === 1 ? 'has' : 'have'} no data until a refresh finishes.`);
  ctx.ui.fail(`The ${what} isn't finished: the model wasn't reloaded. Fix the problem above, then run "${commandLine('refresh')}", or "${commandLine(what)}" again.`);
}

/**
 * Starts the pipeline: the first load until one has loaded the data, then the usual run.
 * @param {Ctx} ctx
 * @param {{ wait: boolean }} opts
 */
export async function run(ctx, opts) {
  await offerStudioRun(ctx, { pipelineNext: true });
  const load = await chooseLoad(ctx, opts);
  const result = await runPipeline(ctx, { ...load, skipCowork: !!load.first && (await coworkSkipForFirstLoad(ctx)) });
  if (result.status === 'Completed') await runDataCheck(ctx);
  return result;
}

export { status };

/**
 * Refreshes the semantic model now.
 * @param {Ctx} ctx
 * @param {{ wait: boolean }} opts
 */
export async function refresh(ctx, opts) {
  if (!ctx.config.semanticModel.id) throw new Error('There is no semantic model yet. Run the installer and choose to deploy it.');
  return refreshModel(ctx, opts);
}

/**
 * Prints what the signed-in user has and lacks for an install. Changes nothing.
 * @param {Ctx} ctx
 */
export async function showPrereqs(ctx) {
  ctx.ui.heading('Prerequisites');
  ctx.ui.ok(`Signed in as ${ctx.user.upn} (tenant ${ctx.user.tenantId})`);
  const items = await checkPrereqs(ctx);
  ctx.ui.prereqs(items);
  return items;
}

/**
 * Runs one command against a signed-in context.
 * @param {Ctx} ctx
 * @param {string} command
 * @param {{ wait: boolean, files?: string[], run?: boolean }} opts
 * @returns {Promise<boolean>} false when a run or refresh it waited for didn't succeed.
 */
export async function runCommand(ctx, command, opts) {
  switch (command) {
    case 'install':
      return install(ctx, opts);
    case 'update':
      return (await update(ctx, opts)) !== false;
    case 'run': {
      const result = await run(ctx, opts);
      return !opts.wait || !!result.ok;
    }
    case 'rerun-failed':
      return !(await rerunFailed(ctx)).failed.length;
    case 'load-cowork':
      return !(await loadCoworkNow(ctx)).failed.length;
    case 'check':
      return checkData(ctx);
    case 'refresh': {
      const result = await refresh(ctx, opts);
      return !opts.wait || result.ok;
    }
    case 'status':
      await status(ctx);
      return true;
    case 'rotate-secret':
      await rotateSecret(ctx);
      return true;
    case 'github-token':
      await githubToken(ctx);
      return true;
    case 'uninstall':
      await fabricUninstall(ctx);
      return true;
    case 'upload':
      return uploadCommand(ctx, { files: opts.files ?? [], run: opts.run, wait: opts.wait }, (c2, o) => run(c2, o));
    case 'prereqs':
      await showPrereqs(ctx);
      return true;
    case 'access':
      await accessCommand(ctx, fabricViewerModels(ctx.config));
      return true;
    default:
      throw new Error(`Unknown command "${command}".`);
  }
}

/**
 * Gives the app, and the model's connection, new client secrets. An install that keeps no secret
 * of the app's own (appSecretKept) has one only in the connection, so then only that one is replaced.
 * @param {Ctx} ctx
 */
export async function rotateSecret(ctx) {
  const { ui, config } = ctx;
  const mode = secretMode(config);
  const sm = config.semanticModel;
  const withApp = appSecretKept(config);
  const appSecret = withApp && (mode === 'notebook' ? !!config.fabric.workspaceId : !!config.keyVault.uri);
  if (!config.app.appId || !(appSecret || sm.connectionId)) throw new Error('Nothing is installed yet. Run the installer first.');
  ui.heading('New client secret');
  ui.info(`App: ${config.app.displayName ?? config.app.appId}`);
  if (!appSecret) {
    ui.info(`Connection: ${sm.connectionName}, used by ${sm.name}`);
    ui.note('No notebook reads the app\'s secret, so only the connection\'s is replaced. The old one is removed from the app.');
    if (!(await ui.confirm('Create a new secret and replace the connection\'s?', true))) return;
    await rotateModelSecret(ctx);
    return;
  }
  if (mode === 'notebook') ui.info('Secret: in the notebooks (no Key Vault)');
  else ui.info(`Key Vault: ${config.keyVault.name}, secret ${config.keyVault.secretName}`);
  if (sm.connectionId) ui.info(`Connection: ${sm.connectionName}, used by ${sm.name}`);
  if (mode === 'notebook') {
    ui.note(
      config.app.existing
        ? 'You paste the new secret, and the notebooks are rewritten with it. Then delete the old one from the app\'s Certificates & secrets page.'
        : `A new secret, valid for ${notebookSecretDays(config)} days, is written into the notebooks, then the old one is removed from the app, so copies of it in run snapshots, exports or Git stop working.`,
    );
    if (!(await ui.confirm(`Create a new secret and rewrite the notebooks${sm.connectionId ? ', and replace the connection\'s' : ''}?`, true))) return;
    await ensureNotebooks(ctx, { force: true });
    if (sm.connectionId) await rotateModelSecret(ctx);
    ui.note('Anyone with a role in the workspace can read the secret in the notebooks. Key Vault avoids that: run the installer again and choose Use Key Vault instead.');
    return;
  }
  if (mode === 'keyvault-admin') {
    if (!(await ui.confirm(`Show the steps for a vault admin to replace the secret in ${config.keyVault.name}${sm.connectionId ? ', and replace the connection\'s' : ''}?`, true))) return;
  } else {
    ui.note('The notebooks\' old secret keeps working until it expires. Delete it from the app\'s Certificates & secrets page once a run has succeeded.');
    if (!(await ui.confirm(`Create new secrets and replace the one in Key Vault${sm.connectionId ? ' and the connection\'s' : ''}?`, true))) return;
  }
  await newSecret(ctx);
  if (sm.connectionId) await rotateModelSecret(ctx);
}

/**
 * github-token: puts a new GitHub token in place, e.g. before the old one expires. In Key Vault the
 * secret gets a new version; with no Key Vault, Ingest_GitHub_API is written again with it.
 * @param {Ctx} ctx
 */
export async function githubToken(ctx) {
  const { ui, config } = ctx;
  const gh = config.github;
  if (config.dataSources.github !== 'api' || !gh?.enterprise) {
    throw new Error('This install doesn\'t read GitHub from the API, so it has no GitHub token. Choose "From the API" for GitHub in the setup first.');
  }
  const mode = secretMode(config);
  if (mode === 'notebook' ? !config.fabric.notebooks.githubApi : !config.keyVault.uri) throw new Error('Nothing is installed yet. Run the installer first.');
  ui.heading('New GitHub token');
  ui.info(`Enterprise: ${gh.enterprise}`);
  ui.info(mode === 'notebook' ? 'Token: in Ingest_GitHub_API (no Key Vault)' : `Key Vault: ${config.keyVault.name}, secret ${githubSecretName(config)}`);
  if (gh.tokenExpires) ui.info(`The current one expires ${gh.tokenExpires.slice(0, 10)}.`);
  // Whether there's an old token to revoke afterwards: a first one may never have been set.
  const had = !!gh.tokenSetAt;
  if (mode === 'keyvault-admin') {
    // A vault admin sets it: the hand-off shows them how.
    await ensureGithubToken(ctx, { replace: true });
    return;
  }
  const token = await askGithubToken(ctx);
  if (!token) throw new Error(`The new GitHub token is needed. Run without --yes, or set ${ENV.GITHUB_TOKEN}.`);
  ctx.pendingGithubToken = token;
  if (mode === 'notebook') await ensureNotebooks(ctx, { only: ['githubApi'] });
  else await ensureGithubToken(ctx, { replace: true });
  if (had) ui.note(`Revoke the old token at ${TOKENS_URL} once GitHub data has loaded with the new one.`);
}

/**
 * Who can read the secrets the scheduled runs use, and what to do before they expire.
 * @param {import('./config.js').InstallConfig} config
 * @returns {string[]}  The lines of one next step; empty when the install keeps no secret.
 */
function secretNote(config) {
  const ds = config.dataSources;
  const sm = config.semanticModel;
  const withApp = appSecretKept(config);
  const withToken = ds.github === 'api';
  const inNotebooks = secretMode(config) === 'notebook';
  if (inNotebooks && (withApp || withToken)) {
    const what = joinNames([...(withApp ? ['client secret'] : []), ...(withToken ? ['GitHub token'] : [])]);
    const expiresOn = config.app.secretExpires ? ` on ${config.app.secretExpires.slice(0, 10)}` : '';
    return [
      `Anyone with a role in the workspace can read the ${what} in the notebooks.`,
      ...(withApp ? [`Repair or run "${commandLine('rotate-secret')}" before the secret expires${expiresOn}.`] : []),
    ];
  }
  if (!inNotebooks && secretWanted(ds)) {
    return [
      'Scheduled runs read Key Vault as you, the schedule\'s owner. Anyone who takes over the pipeline',
      'needs "get" on its secrets and Contributor on the workspace.',
    ];
  }
  if (sm.enabled && sm.connectionId) {
    const expiresOn = sm.secretExpires ? ` on ${sm.secretExpires.slice(0, 10)}` : '';
    return [`The model reads the Lakehouse with its connection's secret. Run "${commandLine('rotate-secret')}" before it expires${expiresOn}.`];
  }
  return [];
}

/**
 * Prints where everything is and what to do next.
 * @param {Ctx} ctx
 * @param {{ ok?: boolean, pending?: string[] }} [opts]  ok false when a step above failed, so the heading doesn't say it is all set up;
 *   pending: models still reloading after their update.
 */
export async function summary(ctx, opts = {}) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  const ws = /** @type {string} */ (f.workspaceId);
  const lhId = /** @type {string} */ (f.lakehouseId);
  const lakehouse = await api.fabric.getLakehouse(ws, lhId).catch(() => null);
  const sql = lakehouse?.properties?.sqlEndpointProperties;

  if (opts.ok === false) {
    ui.heading(`${PRODUCT_NAME} is partly set up`);
    ui.warn('A step above didn\'t finish. Fix what it says, then run the installer again: it picks up where it stopped.');
    if (opts.pending?.length) ui.warn(reloadingNote(opts.pending));
  } else if (opts.pending?.length) {
    ui.heading(`${PRODUCT_NAME} is set up, still reloading`);
    ui.warn(reloadingNote(opts.pending));
  } else {
    ui.heading(`${PRODUCT_NAME} is set up`);
  }
  const left = nextSteps(config, ctx.user, { now: ctx.now() });
  if (left.length) ui.nextSteps(stepsLeftTitle(left), left);
  ui.info(`Workspace:  ${f.workspaceName}  ${c.dim(`https://app.fabric.microsoft.com/groups/${ws}`)}`);
  ui.info(`Lakehouse:  ${f.lakehouseName}`);
  ui.info(`Pipeline:   ${f.pipelineName ?? PIPELINE_NAME}, ${describeSchedule(config.schedule)}`);
  const mode = secretMode(config);
  if (appSecretKept(config)) {
    const expires = config.app.secretExpires ? `, expires ${config.app.secretExpires.slice(0, 10)}` : '';
    if (mode === 'notebook') ui.info(`Secret:     in the notebooks${expires}  ${c.dim('No Key Vault: anyone with a role in the workspace can read it. Each install, repair or update replaces it.')}`);
    else ui.info(`Secret:     ${config.keyVault.name} / ${config.keyVault.secretName}${expires}${mode === 'keyvault-admin' ? c.dim('  Added by a vault admin.') : ''}`);
  }
  const token = tokenLine(config);
  if (token) ui.info(token);
  if (config.keyVault.private) ui.info(`            ${c.dim('Private vault, reached through a managed private endpoint. Spark sessions take a few minutes longer to start.')}`);

  const sm = config.semanticModel;
  const secrets = secretNote(config);
  if (sm.enabled && sm.id) {
    ui.info(`Model:      ${sm.name}  ${c.dim(modelUrl(ws, sm.id))}`);
    if (sm.connectionName) ui.info(`            ${c.dim(`Reads the Lakehouse through "${sm.connectionName}"${sm.secretExpires ? `, whose secret expires ${sm.secretExpires.slice(0, 10)}` : ''}.`)}`);
    reportsSummary(ctx);

    const group = config.access?.groupId ? config.access : undefined;
    ui.heading('Next steps');
    let n = 1;
    if (group) {
      ui.info(`1. Give people access by adding them to "${group.groupName}": run "${commandLine('access')}",`);
      ui.info(`   or open ${myGroupsUrl(/** @type {string} */ (group.groupId))}. The group already has Build on the model. Keep viewers off workspace roles.`);
      if (shareReportPending(config)) ui.info(`   Until the report is shared with the group (the step above), its members get "no access" on it.`);
      else if (!reportsOn(config)) ui.info(`   Share the reports you publish with "${group.groupName}" too.`);
    } else {
      const shared = reportsOn(config) ? 'report' : 'reports you publish';
      ui.info(`1. Share the ${shared}: in the workspace, choose … (More options) > Manage permissions > Add user, and add people or a group.`);
      ui.info(`   They also need Build on ${sm.name} (its Manage permissions page). Keep viewers off workspace roles.`);
    }
    if (secrets.length) {
      ui.info(`${++n}. ${secrets[0]}`);
      for (const line of secrets.slice(1)) ui.info(`   ${line}`);
    }
    ui.info(`${++n}. Keep ${c.bold(RECORD_FILE)}. It holds no secrets; re-run the installer with it to change or repair the set-up.`);
    consumptionSummary(ctx);
    dataSourcesSummary(ctx);
    flowsSummary(ctx);
    return;
  }

  ui.heading('Connect Power BI');
  ui.info(`${c.bold(basename(ctx.sources.modelFile))}, with these parameters (the rest keep their defaults):`);
  /** @type {Record<string, string>} */
  const params = {
    FabricSQLEndpoint: sql?.connectionString ?? c.dim('still provisioning; copy it from the Lakehouse\'s SQL analytics endpoint settings'),
    LakehouseName: /** @type {string} */ (f.lakehouseName),
    ...Object.fromEntries(Object.entries(priceParameters(config.prices)).map(([k, v]) => [k, String(v)])),
  };
  const width = Math.max(...Object.keys(params).map((k) => k.length)) + 3;
  for (const [k, v] of Object.entries(params)) ui.info(`  ${`${k}:`.padEnd(width)}${v}`);

  ui.heading('Next steps');
  ui.info('1. Open the template in Power BI Desktop with the values above, then publish it to this workspace.');
  ui.info('2. Add a semantic model refresh to the end of the pipeline so the report updates after each load,');
  ui.info('   or re-run the installer and let it deploy the semantic model, which adds one for you.');
  ui.note('   See step 5, "Publish and schedule", in 2. Fabric/README.md.');
  let n = 2;
  if (secrets.length) {
    ui.info(`${++n}. ${secrets[0]}`);
    for (const line of secrets.slice(1)) ui.info(`   ${line}`);
  }
  ui.info(`${++n}. Keep ${c.bold(RECORD_FILE)}. It holds no secrets; re-run the installer with it to change or repair the set-up.`);
  consumptionSummary(ctx);
  dataSourcesSummary(ctx);
  flowsSummary(ctx);
}

/**
 * Writes what the installer would deploy, with placeholder IDs where none are known. No sign-in.
 * @param {{ ui: import('./ui.js').Ui, config: import('./config.js').InstallConfig, sources: import('./sources.js').Sources, outDir: string, now?: Date }} o
 */
export function preview(o) {
  const { ui, config, sources } = o;
  const out = resolve(o.outDir);
  const fake = (/** @type {number} */ n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  const ds = config.dataSources;
  const f = config.fabric;
  const sm = config.semanticModel;
  const cc = config.consumption;
  const withModel = sm.enabled !== false && !!sources.modelFile;
  const withDataflow = ds.coworkCredits === 'api' && isVivaId(cc.vivaPartition) && isVivaId(cc.vivaQuery);
  /** @type {Ctx} */
  const ctx = /** @type {any} */ ({
    now: () => o.now ?? new Date(),
    user: { tenantId: config.tenantId ?? fake(0) },
    sources,
    config: {
      ...config,
      app: { ...config.app, appId: config.app.appId ?? fake(1) },
      keyVault: { ...config.keyVault, uri: config.keyVault.uri ?? `https://${config.keyVault.name ?? 'your-vault'}.vault.azure.net/` },
      fabric: {
        ...f,
        workspaceId: f.workspaceId ?? fake(2),
        lakehouseId: f.lakehouseId ?? fake(3),
        lakehouseName: f.lakehouseName ?? LAKEHOUSE_NAME,
        notebooks: { ...f.notebooks },
      },
      semanticModel: withModel ? { ...sm, enabled: true, id: sm.id ?? fake(4), bound: true } : { ...sm, enabled: false },
      consumption: { ...cc, azureAccess: !!cc.azureSubscriptionId, ...(withDataflow ? { dataflowId: cc.dataflowId ?? fake(7) } : {}) },
      ...(ds.github === 'api' ? { github: { ...config.github, enterprise: config.github?.enterprise ?? 'your-enterprise' } } : {}),
      ...(ds.commercialTerms === 'api' ? { commercialTerms: { ...config.commercialTerms, scope: config.commercialTerms?.scope ?? `/subscriptions/${fake(6)}` } } : {}),
    },
  });

  mkdirSync(join(out, 'notebooks'), { recursive: true });
  let n = 10;
  for (const nb of notebooksFor(sources.catalog, deployedSources(ctx.config), notebookOptions(ctx.config))) {
    const prepared = prepareNotebook(sources.notebooks[nb.key], notebookSettings(ctx, nb, { placeholder: true }));
    writeFileSync(join(out, 'notebooks', `${nb.displayName}.ipynb`), serialiseNotebook(prepared), 'utf8');
    ctx.config.fabric.notebooks[nb.key] = ctx.config.fabric.notebooks[nb.key] ?? fake(n++);
  }
  const pipeline = buildPipeline(sources.catalog, pipelineSettings(ctx.config));
  writeFileSync(join(out, 'pipeline-content.json'), `${JSON.stringify(pipeline, null, 2)}\n`, 'utf8');
  if (withDataflow) {
    const df = coworkDataflowDefinition(cc.dataflowName ?? COWORK_DATAFLOW_NAME, {
      partitionId: /** @type {string} */ (cc.vivaPartition),
      queryId: /** @type {string} */ (cc.vivaQuery),
      workspaceId: /** @type {string} */ (ctx.config.fabric.workspaceId),
      lakehouseId: /** @type {string} */ (ctx.config.fabric.lakehouseId),
    });
    mkdirSync(join(out, 'dataflow'), { recursive: true });
    for (const p of df.parts) writeFileSync(join(out, 'dataflow', p.path), Buffer.from(p.payload, 'base64'));
  }
  const flows = flowsWanted(config);
  if (flows.length) {
    const defs = flowDefinitions({ ...ctx.config, app: { ...ctx.config.app, appId: ctx.config.app.appId ?? fake(8) } }, config.tenantId ?? fake(9));
    mkdirSync(join(out, 'flows'), { recursive: true });
    for (const kind of flows) writeFileSync(join(out, 'flows', FLOW_FILES[kind]), `${JSON.stringify(defs[kind].definition, null, 2)}\n`, 'utf8');
  }
  writeFileSync(join(out, 'schedule.json'), `${JSON.stringify(scheduleBody(config.schedule, o.now), null, 2)}\n`, 'utf8');
  const permissions = permissionsFor(ds);
  writeFileSync(
    join(out, 'graph-permissions.txt'),
    `Microsoft Graph application permissions for the app registration:\n${permissions.length ? permissions.map((p) => `  ${p}\n`).join('') : '  none\n'}`,
    'utf8',
  );
  if (withModel) {
    const bim = buildModel(loadTemplateModel(sources.modelFile), {
      server: sm.server ?? 'your-endpoint.datawarehouse.fabric.microsoft.com',
      database: /** @type {string} */ (ctx.config.fabric.lakehouseName),
      prices: priceParameters(config.prices),
    });
    writeFileSync(join(out, 'model.bim'), `${JSON.stringify(bim, null, 2)}\n`, 'utf8');
  }

  ui.heading('Preview written');
  ui.info(out);
  ui.note(`Notebooks, pipeline-content.json, schedule.json${withModel ? ', model.bim' : ''} and graph-permissions.txt, with placeholder IDs where none are known yet.`);
}
