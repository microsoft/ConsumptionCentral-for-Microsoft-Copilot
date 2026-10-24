// @ts-check
/**
 * Checks the tenant, then asks every question up front so the rest of the
 * install can run unattended.
 */
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { appNeeded, appWanted, notebooksFor, permissionsFor, secretWanted } from '../catalog.js';
import { allowsAction, armLocation, validateVaultName } from '../clients/azure.js';
import { APP_ROLES, CONSENT_ROLES } from '../clients/graph.js';
import { HttpError } from '../http.js';
import { inCloudShell } from '../launch.js';
import { consumptionLoaded, holdsOtherInstall, otherInstallIn, warnConsumptionLoaded, workspaceTaken } from '../other-installs.js';
import { askPrices, describePrices } from '../prices.js';
import { APP_REGISTRATION, ENV, KEY_VAULT_PREFIX, LAKEHOUSE_NAME, PRODUCT_NAME, RESOURCE_GROUP, WORKSPACE_NAME } from '../product.js';
import { isPax } from '../target.js';
import { loadTemplateModel } from '../transform/model.js';
import { c, listJoin } from '../ui.js';
import { flowIdentity, MODEL_NAME, secretMode } from '../config.js';
import { AZURE_AI_ROLES, COWORK_DATAFLOW_NAME, planConsumption, planCowork } from './consumption.js';
import { FLOW_NAMES, flowsSkipped, flowsWanted, planFlows } from './flows.js';
import { adminPack, canWriteSecrets, checkExistingApp, keptSecrets, MAX_SECRET_DAYS, NOTEBOOK_SECRET_DAYS, notebookSecretDays, reportAppCheck, ResumeLater, writeAdminPack } from './identity.js';
import { askAdvanced, asksAdvanced } from './advanced.js';
import { describeSchedule, displayNames, freeName, modelKey, PIPELINE_NAME, stoppedRunItem } from './fabric.js';
import { GITHUB_TOKEN_SCOPES, githubSecretName, tokenWhere } from './github.js';
import { connectionName, MODEL_UPDATE_NOTE } from './model.js';
import { reportsWanted } from './report.js';
import { planDataSources } from './data-sources.js';
import { accessReview, planAccess } from './access.js';
import { COWORK_TASKS_DIR, DATA_SOURCES, describeSources, exportModesOf, routerWanted, UPLOAD_DIR } from '../uploads.js';

/** @typedef {import('../install.js').Ctx} Ctx */

export const APP_NAME = APP_REGISTRATION;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @param {string} v */
export const isGuid = (v) => GUID.test(v.trim());

/** Fabric item names for a Lakehouse: letter first, then letters, digits, underscores. @param {string} v */
export function validateLakehouseName(v) {
  if (v.length > 123) return 'Use 123 characters or fewer.';
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(v) ? true : 'Start with a letter, then use only letters, numbers and underscores. That\'s a Fabric rule for Lakehouse names.';
}

/**
 * The name to give the Lakehouse. Fabric won't take spaces or hyphens, so they become underscores.
 * @param {string} v
 */
export const lakehouseNameFrom = (v) => v.trim().replace(/[\s-]+/g, '_');

/**
 * A valid Lakehouse name that no Lakehouse in the workspace has: the install only writes to one it creates.
 * @param {string[]} taken  Lakehouse names already in the workspace.
 */
export const validateNewLakehouseName = (taken) => (/** @type {string} */ v) => {
  const name = lakehouseNameFrom(v);
  const ok = validateLakehouseName(name);
  if (ok !== true) return ok;
  return taken.some((t) => t.toLowerCase() === name.toLowerCase())
    ? `There's already a Lakehouse called ${name} here. Consumption Central only writes to a Lakehouse it creates, so choose another name.`
    : true;
};

/** @param {string} v */
export function validateTime(v) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v);
  return m ? true : 'Use 24-hour HH:MM, e.g. 02:00.';
}

/** @param {Ctx} ctx */
export async function editSchedule(ctx) {
  const schedule = ctx.config.schedule;
  const values = await ctx.ui.form('Schedule', [
    { id: 'frequency', label: 'Frequency', default: schedule.frequency, choices: [{ name: 'Daily', value: 'daily' }, { name: 'Weekly', value: 'weekly' }] },
    { id: 'weekday', label: 'Day (weekly schedules only)', default: schedule.weekday, choices: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d) => ({ name: d, value: d })) },
    { id: 'time', label: `Time (${schedule.timeZone}, 24-hour)`, default: schedule.time, validate: validateTime },
  ]);
  if (!values) throw Object.assign(new Error('Changes cancelled'), { name: 'SettingsCancelled' });
  schedule.frequency = /** @type {'daily' | 'weekly'} */ (values.frequency);
  schedule.weekday = values.weekday;
  schedule.time = values.time;
}

/**
 * Premium Per User (PP), Embedded (A) and EM capacities can't host Fabric items.
 * @param {{ sku?: string }} capacity
 */
export const runsFabric = (capacity) => !/^(PP|A|EM)\d/i.test(String(capacity.sku ?? ''));

/**
 * @typedef {object} Preflight
 * @property {any[]} capacities  Active capacities the user can use.
 * @property {any[]} subscriptions  Enabled Azure subscriptions.
 * @property {string[]} roles  Directory role names.
 * @property {boolean} canConsent
 * @property {boolean | undefined} canCreateApps  undefined when the policy can't be read.
 * @property {Record<string, { enabled?: boolean, delegateToCapacity?: boolean }>} [tenantSettings]  Only for Fabric administrators.
 * @property {number} [seats]  Assigned Microsoft 365 Copilot seats; undefined when they can't be read. Only the PAX route reads them.
 */

/**
 * Tenant settings the semantic model and the reports rely on, and what breaks without them.
 * The report uses built-in visuals only, so it needs no setting for Power BI SDK visuals
 * (report.test.js checks the template).
 * @type {{ name: string, title: string, effect: string, reports?: boolean }[]}
 */
export const POWER_BI_SETTINGS = [
  {
    name: 'ServicePrincipalAccessPermissionAPIs',
    title: 'Service principals can call Fabric public APIs',
    effect: 'The model\'s connection signs in as the app registration, so the model can\'t refresh without it.',
  },
];

/**
 * Settings that look switched off. A setting delegated to capacity admins may still be on there.
 * @param {Preflight['tenantSettings']} settings
 * @param {{ reports?: boolean }} opts
 */
export function blockedSettings(settings, opts) {
  if (!settings) return [];
  return POWER_BI_SETTINGS.filter(
    (s) => (opts.reports || !s.reports) && settings[s.name]?.enabled === false && !settings[s.name]?.delegateToCapacity,
  );
}

/**
 * @param {Ctx} ctx
 * @returns {Promise<Preflight>}
 */
export async function preflight(ctx) {
  const { ui, api, user } = ctx;
  ui.heading('Checking your tenant');
  ui.ok(`Signed in as ${user.upn} (tenant ${user.tenantId})`);

  const roles = await api.graph.myDirectoryRoles().catch(() => []);
  const roleIds = new Set(roles.map((r) => r.roleTemplateId));
  const canConsent = Object.keys(CONSENT_ROLES).some((id) => roleIds.has(id));
  const appAdmin = Object.keys(APP_ROLES).some((id) => roleIds.has(id));
  /** @type {boolean | undefined} */
  let canCreateApps = canConsent || appAdmin ? true : undefined;
  if (canCreateApps === undefined) canCreateApps = await api.graph.usersCanRegisterApps().catch(() => undefined);

  if (canConsent) ui.ok(`You can grant admin consent (${roles.filter((r) => CONSENT_ROLES[/** @type {keyof typeof CONSENT_ROLES} */ (r.roleTemplateId)]).map((r) => r.displayName).join(', ')})`);
  else ui.warn('You can\'t grant admin consent for Microsoft Graph. If your choices need it, the installer gives you a link for a Global Administrator or Privileged Role Administrator to approve.');
  if (!ctx.config.app.appId && canCreateApps === false) {
    ui.warn('Users in this tenant can\'t register apps and you have no app admin role. Choose "Use an app registration I already have", or get an admin pack for an admin to register it.');
  }

  const capacities = (await api.fabric.listCapacities()).filter((cap) => cap.state === 'Active' && runsFabric(cap));
  if (!capacities.length) {
    ui.fail('No active Fabric capacity you can use.');
    throw new Error('Start a Fabric trial, or ask a capacity admin to make you a contributor on an F2 or larger capacity, then run the installer again.');
  }
  ui.ok(`${capacities.length} active Fabric ${capacities.length === 1 ? 'capacity' : 'capacities'}`);

  /** @type {any[]} */
  let subscriptions = [];
  try {
    subscriptions = (await api.arm.listSubscriptions()).filter((s) => s.state === 'Enabled');
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
  }
  if (!subscriptions.length && secretWanted(ctx.config.dataSources) && !ctx.config.keyVault.uri && secretMode(ctx.config) !== 'notebook') {
    const kept = keptSecrets(ctx.config);
    const what = listJoin(kept);
    if (ctx.useKeyVault) {
      ui.fail('No Azure subscription you can use, so no Key Vault.');
      throw new Error(`--key-vault needs an Azure subscription in this tenant. Ask for Contributor on one, or leave out --key-vault to keep ${what} in the notebooks.`);
    }
    // A Fabric install doesn't need one: the secrets can go in the notebooks instead of Key Vault.
    ui.info(`No Azure subscription you can use, so no Key Vault: ${what} ${kept.length > 1 ? 'go' : 'goes'} in the notebooks.`);
    if (ui.yes && !ctx.secretInNotebook && !defaultsToNoVault(ctx)) {
      throw new Error(
        `With no Azure subscription there's no Key Vault for ${what}. Add --no-key-vault to keep ${kept.length > 1 ? 'them' : 'it'} in the notebooks, where anyone with a role in the workspace can read ${kept.length > 1 ? 'them' : 'it'}, or ask for Contributor on a subscription.`,
      );
    }
  }
  if (subscriptions.length) ui.ok(`${subscriptions.length} Azure ${subscriptions.length === 1 ? 'subscription' : 'subscriptions'}`);

  /** @type {Preflight['tenantSettings']} */
  let tenantSettings;
  try {
    tenantSettings = Object.fromEntries((await api.fabric.tenantSettings()).map((s) => [s.settingName, s]));
  } catch {
    // Only Fabric administrators can read them.
  }

  return { capacities, subscriptions, roles: roles.map((r) => r.displayName), canConsent, canCreateApps, tenantSettings };
}

/**
 * The Power BI choice to offer first. The reports are on unless switched off, so re-running an
 * older install offers the reports too.
 * @param {import('../config.js').InstallConfig} config
 * @returns {'reports' | 'model' | 'none'}
 */
export function powerBiChoice(config) {
  if (config.semanticModel.enabled === false) return 'none';
  const reports = config.semanticModel.reports !== false;
  return reports ? 'reports' : 'model';
}

/**
 * @param {import('../config.js').InstallConfig} config
 * @param {string} choice
 */
export function applyPowerBiChoice(config, choice) {
  config.semanticModel.enabled = choice !== 'none';
  config.semanticModel.reports = choice === 'reports';
}

/**
 * The semantic model, and the report on top of it.
 * @param {Ctx} ctx
 * @param {Preflight} pre
 */
async function planPowerBi(ctx, pre) {
  const { ui, config, sources } = ctx;
  const sm = config.semanticModel;
  ui.heading('Power BI');
  const choice = !asksAdvanced(ctx)
    ? powerBiChoice(config)
    : await ui.select(
    'Deploy the semantic model?',
    [
      { name: 'Semantic model and Power BI report (recommended)', value: 'reports', description: 'The Consumption Central report, published to the workspace and ready to share.' },
      { name: 'Semantic model only', value: 'model', description: 'Build your own reports on it in Power BI.' },
      { name: 'Neither', value: 'none', description: `You publish "${basename(sources.modelFile)}" yourself.` },
    ],
    powerBiChoice(config),
  );
  applyPowerBiChoice(config, choice);
  if (!sm.enabled) return;
  for (const s of blockedSettings(pre.tenantSettings, { reports: !!sm.reports })) {
    ui.warn(`The tenant setting "${s.title}" is off. ${s.effect}`);
    ui.note('A Fabric administrator can switch it on in the admin portal, under Tenant settings.');
  }
}

/**
 * The GitHub enterprise slug, as in github.com/enterprises/<slug>.
 * @param {string} v
 */
export function validateEnterprise(v) {
  return /^[a-z0-9][a-z0-9-]*$/i.test(v.trim()) ? true : 'The slug from github.com/enterprises/<slug>: letters, digits and hyphens.';
}

/**
 * GitHub from the API: which enterprise Ingest_GitHub_API reads. Its token is asked for once the plan
 * is confirmed, and goes in Key Vault or, with no Key Vault, in the notebook.
 * @param {Ctx} ctx
 */
export async function planGithub(ctx) {
  const { ui, config } = ctx;
  if (config.dataSources.github !== 'api') return;
  ui.heading('GitHub');
  const gh = (config.github ??= {});
  if (ui.yes && !gh.enterprise) {
    throw new Error('Reading GitHub Copilot from the API needs your enterprise. Add --github-enterprise <slug>, as in github.com/enterprises/<slug>, or run without --yes.');
  }
  const enterprise = (await ui.input('GitHub enterprise slug, as in github.com/enterprises/<slug>', { default: gh.enterprise ?? '', validate: validateEnterprise })).trim();
  if (gh.enterprise && enterprise.toLowerCase() !== gh.enterprise.toLowerCase()) {
    // The token's owner may not manage the new enterprise's billing, so a new one is asked for.
    delete gh.tokenSetAt;
    delete gh.tokenExpires;
  }
  gh.enterprise = enterprise;
  if (!gh.tokenSetAt) {
    ui.note(
      `Once you go ahead, the installer asks for a classic personal access token with scope ${GITHUB_TOKEN_SCOPES}, made by an owner or billing manager of ${enterprise}.${ui.web ? '' : ` Or set ${ENV.GITHUB_TOKEN} before you start.`}`,
    );
  }
}

/** A billing account, a billing profile, or a subscription: the scopes Ingest_CommercialTerms reads. */
const BILLING_SCOPE = /^\/(providers\/Microsoft\.Billing\/billingAccounts\/[^/\s]+(\/billingProfiles\/[^/\s]+)?|subscriptions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** @param {string} v */
export const billingScopeFrom = (v) => v.trim().replace(/\/+$/, '');

/** @param {string} v */
export function validateBillingScope(v) {
  return BILLING_SCOPE.test(billingScopeFrom(v))
    ? true
    : 'A subscription (/subscriptions/<id>), a billing account (/providers/Microsoft.Billing/billingAccounts/<id>) or a billing profile (…/billingAccounts/<id>/billingProfiles/<id>).';
}

const OTHER_SCOPE = 'other';

/**
 * The credit rate from Azure Cost Management: which billing scope Ingest_CommercialTerms reads. The
 * subscriptions billing policies charge Copilot pay-as-you-go to come first.
 * @param {Ctx} ctx
 * @param {Pick<Preflight, 'subscriptions'>} pre
 */
export async function planCommercialTerms(ctx, pre) {
  const { ui, config } = ctx;
  if (config.dataSources.commercialTerms !== 'api') return;
  ui.heading('Credit rate');
  const ct = (config.commercialTerms ??= {});
  const cc = config.consumption;
  /** @type {{ name: string, value: string, description?: string }[]} */
  const choices = [];
  /** @type {Map<string, string>} */
  const names = new Map();
  /** @param {string} id @param {string | undefined} name @param {string} [description] */
  const add = (id, name, description) => {
    const scope = `/subscriptions/${id}`;
    if (names.has(scope.toLowerCase())) return;
    names.set(scope.toLowerCase(), name ?? id);
    choices.push({ name: `${name ?? id} (${scope})`, value: scope, ...(description ? { description } : {}) });
  };
  for (const p of cc.paygSubscriptions ?? []) add(p.subscriptionId, p.name, 'A billing policy charges Copilot pay-as-you-go here.');
  if (cc.azureSubscriptionId) add(cc.azureSubscriptionId, cc.azureSubscriptionName, 'The Azure AI subscription.');
  for (const s of pre.subscriptions) add(s.subscriptionId, s.displayName);
  choices.push({ name: 'A billing account or billing profile', value: OTHER_SCOPE, description: 'Its ID, from Cost Management + Billing > Billing scopes > Properties.' });

  const saved = ct.scope ? billingScopeFrom(ct.scope) : undefined;
  if (ui.yes && !saved) {
    throw new Error('Reading the credit rate needs a billing scope. Add --billing-scope with a subscription, billing account or billing profile ID, or run without --yes.');
  }
  const listed = saved && names.has(saved.toLowerCase()) ? choices.find((ch) => ch.value.toLowerCase() === saved.toLowerCase())?.value : undefined;
  const choice = await ui.select(
    'Which billing scope should it read the credit rate from? Copilot credits are charged to the subscription a billing policy names.',
    choices,
    listed ?? (saved ? OTHER_SCOPE : choices[0].value),
  );
  const scope =
    choice === OTHER_SCOPE
      ? billingScopeFrom(await ui.input('Billing scope ID', { default: saved && !listed ? saved : '', validate: validateBillingScope }))
      : choice;
  if (!saved || scope.toLowerCase() !== saved.toLowerCase()) {
    // A new scope is read again after setup.
    delete ct.ranAt;
    delete ct.status;
  }
  ct.scope = scope;
  const name = names.get(scope.toLowerCase());
  if (name) ct.scopeName = name;
  else delete ct.scopeName;
  ui.note(
    `Ingest_CommercialTerms runs once after setup, as you, so you need Cost Management Reader (or a billing reader role) on ${name ?? scope}. The installer doesn't grant it. The report then uses the rate it finds instead of the pay-as-you-go price.`,
  );
}

/**
 * @param {Ctx} ctx
 * @param {Preflight} pre
 * @param {string} [section]
 */
export async function plan(ctx, pre, section) {
  const { ui, config, api } = ctx;
  const advanced = () => !!section || asksAdvanced(ctx);
  const editing = (/** @type {string} */ id) => !section || section === id;

  if (editing('data')) {
    await planDataSources(ctx);
    if (!section) await askAdvanced(
      ctx,
      'the model and report, who can view, your prices, the Lakehouse name, the new Key Vault\'s details, the schedule and the first load',
    );
  }
  if (editing('governance')) {
    await planFlows(ctx);
  }

  if (editing('powerbi')) {
    await planPowerBi(ctx, pre);
  }
  if (editing('access')) {
    if (config.semanticModel.enabled) await planAccess(ctx);
  }
  if (editing('sources')) {
    await planConsumption(ctx, pre);
    await planCowork(ctx);
    await planGithub(ctx);
    await planCommercialTerms(ctx, pre);
    if (config.semanticModel.enabled && advanced()) await askPrices(ctx, loadTemplateModel(ctx.sources.modelFile));
  }

  const currentCapacity = () => pre.capacities.find((cap) => cap.id === config.fabric.capacityId);
  if (editing('placement')) {
    ui.heading('Fabric');
    ui.note(CAPACITY_HINT);
    const capacityChoices = pre.capacities.map((cap) => ({ name: capacityLabel(cap), value: cap.id }));
    config.fabric.capacityId = await ui.select(
      'Which capacity should run it?',
      capacityChoices,
      pre.capacities.some((cap) => cap.id === config.fabric.capacityId) ? config.fabric.capacityId : pre.capacities[0].id,
    );
    if (config.fabric.workspaceId) {
      ui.ok(`Workspace: ${config.fabric.workspaceName ?? config.fabric.workspaceId}`);
    } else {
      const workspaces = (await api.fabric.listWorkspaces()).filter((w) => w.type === 'Workspace');
      const warned = await warnConsumptionLoaded(ctx, workspaces);
      let choice = '';
      for (;;) {
        choice = await ui.select(
          'Workspace',
          [{ name: 'Create a new workspace', value: '' }, ...workspaces.map((w) => ({ name: `Use "${w.displayName}"`, value: w.id }))],
          '',
        );
        if (!choice) break;
        const name = workspaces.find((w) => w.id === choice)?.displayName ?? choice;
        const found = await otherInstallIn(api, choice).catch(() => null);
        if (found && holdsOtherInstall(found)) {
          ui.warn(workspaceTaken(name, found, 'Choose another workspace, or create a new one.'));
          continue;
        }
        if (found?.consumption.length && !warned.has(choice)) ui.warn(consumptionLoaded(name, found.consumption));
        break;
      }
      if (choice) {
        config.fabric.workspaceId = choice;
        config.fabric.workspaceName = workspaces.find((w) => w.id === choice)?.displayName;
      } else {
        const taken = new Set(workspaces.map((w) => w.displayName.toLowerCase()));
        config.fabric.workspaceName = await ui.input('New workspace name', {
          default: config.fabric.workspaceName ?? uniqueName(DEFAULT_WORKSPACE_NAME, taken),
          validate: (v) => (!v.trim() ? 'Required' : taken.has(v.trim().toLowerCase()) ? 'A workspace with that name exists.' : true),
        });
      }
    }
    if (!config.fabric.lakehouseId) {
      const ws = config.fabric.workspaceId;
      const lakehouses = ws ? await api.fabric.listItems(ws, 'Lakehouse') : [];
      const resumed = stoppedRunItem(config.fabric, 'Lakehouse', lakehouses);
      const taken = displayNames(lakehouses);
      if (resumed) config.fabric.lakehouseName = String(resumed.displayName);
      else {
        const suggested = freeName(config.fabric.lakehouseName ?? DEFAULT_LAKEHOUSE_NAME, taken);
        const typed = advanced() ? await ui.input('Lakehouse name', { default: suggested, validate: validateNewLakehouseName(taken) }) : suggested;
        config.fabric.lakehouseName = lakehouseNameFrom(typed);
        if (config.fabric.lakehouseName !== typed.trim()) ui.note(`Fabric doesn't allow spaces or hyphens in Lakehouse names, so it'll be called ${config.fabric.lakehouseName}.`);
      }
    }
    await reserveNames(ctx);
  }

  if (editing('identity')) {
    const capacity = currentCapacity();
    const location = capacity ? armLocation(capacity.region) : 'westeurope';
    const ds = config.dataSources;
    // The notebooks sign in as the app; with only CSV exports, just the model's connection does.
    const forNotebooks = appWanted(ds);
    /** Ask for the secret of an app the user brought, once the Key Vault section says where it goes. */
    let askSecret = false;
    let packWanted = false;
    if (!appNeeded(config) && !secretWanted(ds)) {
      ui.heading('App registration');
      ui.ok('These choices need no app registration or secret');
    }
    if (appNeeded(config)) {
      ui.heading('App registration');
      if (config.app.appId) {
        ui.ok(`Using ${config.app.displayName ?? 'app'} (${config.app.appId})`);
        askSecret = forNotebooks && !!section && !!config.app.existing && !config.keyVault.secretSetAt && !ctx.pendingSecret;
      } else {
        const blocked = pre.canCreateApps === false || (forNotebooks && permissionsFor(ds).length > 0 && !pre.canConsent) || !!config.app.adminPack;
        const mode = await ui.select(
          forNotebooks
            ? 'The notebooks and the semantic model\'s connection sign in as an app.'
            : 'The semantic model\'s connection signs in as an app, so the model refreshes without you.',
          [
            { name: `Create "${APP_NAME}" (recommended)`, value: 'new' },
            { name: 'Use an app registration I already have', value: 'existing' },
            ...(blocked
              ? [{ name: 'An admin will register the app for me', value: 'admin', description: 'You get an admin pack: a Cloud Shell script and portal steps for an admin, who sends you back the client ID.' }]
              : []),
          ],
          config.app.adminPack || (pre.canCreateApps === false && !ui.yes) ? 'admin' : 'new',
        );
        if (mode === 'existing') {
          config.app.existing = true;
          await askAppId(ctx, pre);
          askSecret = forNotebooks;
        } else if (mode === 'admin') {
          config.app.existing = true;
          packWanted = true;
        } else {
          config.app.existing = false;
        }
      }
    }

    if (secretWanted(ds)) {
      const kept = keptSecrets(config);
      const what = listJoin(kept);
      const many = kept.length > 1;
      const them = many ? 'them' : 'it';
      ui.heading(`Key Vault for ${what}`);
      if (config.keyVault.uri) {
        ui.ok(`Using ${config.keyVault.name} (${config.keyVault.uri})`);
      } else if (secretMode(config) === 'notebook' && !ctx.secretInNotebook && !ui.yes) {
        const keep = await ui.select(
          `Last time you chose no Key Vault: ${what} ${many ? 'are' : 'is'} in the notebooks.`,
          [
            { name: 'Keep in the notebooks', value: 'keep', description: `No Key Vault. Anyone with a role in the workspace can read ${them}.` },
            { name: 'Use Key Vault instead', value: 'vault', description: `The notebooks read ${them} from the vault at run time, so workspace roles don't expose ${them}.` },
          ],
          'keep',
        );
        if (keep === 'vault') {
          delete config.keyVault.mode;
          // The secrets were in the notebooks, not a vault: the new vault needs them written.
          delete config.keyVault.secretSetAt;
          delete config.keyVault.handoff;
          if (config.github) {
            delete config.github.tokenSetAt;
            delete config.github.tokenExpires;
          }
          await planKeyVault(ctx, pre, location);
        }
      } else if (secretMode(config) === 'notebook') {
        ui.info(`No Key Vault: ${what} ${many ? 'are' : 'is'} in the notebooks, where anyone with a role in the workspace can read ${them}.`);
      } else if (defaultsToNoVault(ctx)) {
        await chooseSecretHome(ctx, pre, location);
      } else {
        await planKeyVault(ctx, pre, location);
      }
    }
    if (forNotebooks && secretMode(config) === 'notebook' && !config.app.existing && advanced()) {
      const days = await ui.input(`Days before the client secret expires (1 to ${MAX_SECRET_DAYS}). Each install, repair or update replaces it.`, {
        default: String(notebookSecretDays(config)),
        validate: (v) => (/^\d+$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= MAX_SECRET_DAYS ? true : `A whole number from 1 to ${MAX_SECRET_DAYS}.`),
      });
      if (Number(days) === NOTEBOOK_SECRET_DAYS) delete config.app.secretDays;
      else config.app.secretDays = Number(days);
    }
    const skipped = flowsSkipped(config);
    if (skipped.length) ui.note(`${skipped.join(' and ')} won't be set up: --flow-identity app reads the client secret from Key Vault. Run install --flow-identity user to have them sign in to OneLake instead.`);

    if (packWanted) askSecret = (await planAdminPack(ctx, pre)) && forNotebooks;
    if (askSecret && secretMode(config) !== 'keyvault-admin') {
      ctx.pendingSecret = await ui.secret(
        secretMode(config) === 'notebook'
          ? 'Client secret value (not the secret ID). It is written into the notebooks.'
          : 'Client secret value (not the secret ID). It goes straight to Key Vault.',
      );
    }
  }

  if (editing('schedule')) {
    if (section && ui.web) await editSchedule(ctx);
    else if (advanced()) {
      ui.heading('Schedule');
      const freq = await ui.select(
        'How often should the pipeline run?',
        [
          { name: 'Daily (recommended)', value: 'daily' },
          { name: 'Weekly', value: 'weekly' },
        ],
        config.schedule.frequency,
      );
      config.schedule.frequency = /** @type {'daily' | 'weekly'} */ (freq);
      if (freq === 'weekly') {
        config.schedule.weekday = await ui.select(
          'Which day?',
          ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d) => ({ name: d, value: d })),
          config.schedule.weekday,
        );
      }
      config.schedule.time = await ui.input(`Time (${config.schedule.timeZone}, 24-hour)`, { default: config.schedule.time, validate: validateTime });
    }

    ctx.runFirstLoad = config.firstRun?.status === 'Completed' ? false : !advanced() || (await ui.confirm('Run the first load as soon as setup finishes?', true));
  }
}

/**
 * Where the secrets go: a new vault, one the user has, or no vault (the notebooks).
 * A vault the user can't write secrets to can still be used: a vault admin adds them.
 * No vault is recommended when the user can't create a vault or write to the one they chose.
 * @param {Ctx} ctx
 * @param {Preflight} pre
 * @param {string} location
 */
export async function planKeyVault(ctx, pre, location) {
  const { ui, config, api } = ctx;
  const kv = config.keyVault;
  const kept = keptSecrets(config);
  const what = listJoin(kept);
  const them = kept.length > 1 ? 'them' : 'it';
  const forNotebooks = appWanted(config.dataSources);
  if (ctx.secretInNotebook && (await confirmNotebookMode(ctx))) return;
  if (!pre.subscriptions.length) {
    ui.info(`With no Azure subscription, there's nowhere to create a Key Vault for ${what}.`);
    if (await confirmNotebookMode(ctx)) return;
    throw new Error('Key Vault needs an Azure subscription in this tenant. Ask for Contributor on one, or run the installer again and choose no Key Vault.');
  }
  kv.subscriptionId = await ui.select(
    'Azure subscription',
    pre.subscriptions.map((s) => ({ name: `${s.displayName} (${s.subscriptionId})`, value: s.subscriptionId })),
    pre.subscriptions.some((s) => s.subscriptionId === kv.subscriptionId) ? kv.subscriptionId : pre.subscriptions[0].subscriptionId,
  );
  const subscriptionId = /** @type {string} */ (kv.subscriptionId);

  const vaults = await api.arm.listVaults(subscriptionId).catch(() => []);
  let askGroup = asksAdvanced(ctx);
  for (;;) {
    const choice = await ui.select(
      'Vault',
      [
        { name: 'Create a new Key Vault', value: '' },
        ...vaults.map((v) => ({ name: `Use "${v.name}" (${v.location})`, value: v.id })),
        { name: NO_VAULT_NAME, value: NOTEBOOK, description: NO_VAULT_DESCRIPTION },
      ],
      kv.existing && vaults.some((v) => v.id === kv.id) ? /** @type {string} */ (kv.id) : '',
    );
    if (choice === NOTEBOOK) {
      if (await confirmNotebookMode(ctx)) return;
      continue;
    }
    delete kv.mode;
    if (choice) {
      const v = vaults.find((x) => x.id === choice);
      kv.existing = true;
      kv.id = v.id;
      kv.name = v.name;
      kv.resourceGroup = v.id.split('/')[4];
      kv.location = v.location;
      if (!(await canWriteSecrets(ctx, v))) {
        ui.warn(
          `You can't write secrets to ${v.name}: that needs Key Vault Secrets Officer${v.properties?.enableRbacAuthorization ? '' : ' or an access policy with secret set'}, and you can't give it to yourself.`,
        );
        const how = await ui.select(
          `How should ${what} get there?`,
          [
            { name: `${NO_VAULT_NAME} (recommended)`, value: NOTEBOOK, description: NO_VAULT_DESCRIPTION },
            { name: `A vault admin will add ${them} for me`, value: 'keyvault-admin', description: `You get the exact steps to send them. You only need to read ${them}.` },
            { name: 'Pick another vault', value: 'other' },
          ],
          // With --yes, no vault takes --no-key-vault, so the vault admin is the answer that needs no flag.
          ui.yes ? 'keyvault-admin' : NOTEBOOK,
        );
        if (how === 'other') continue;
        if (how === NOTEBOOK) {
          if (await confirmNotebookMode(ctx)) return;
          continue;
        }
        kv.mode = 'keyvault-admin';
        ui.note(
          forNotebooks
            ? `Once the app registration exists, the installer shows the steps to send the vault admin, then carries on when you say ${kept.length > 1 ? 'they are' : 'it is'} there.`
            : 'The installer shows the steps to send the vault admin, then carries on when you say the token is there.',
        );
      }
    } else {
      kv.existing = false;
      await askResourceGroup(ctx, subscriptionId, askGroup);
      // Contributor on just the resource group is enough for the vault, so roles are checked where it goes.
      const group = await api.arm.getResourceGroup(subscriptionId, /** @type {string} */ (kv.resourceGroup)).catch(() => null);
      const scope = group ? `/subscriptions/${subscriptionId}/resourceGroups/${kv.resourceGroup}` : `/subscriptions/${subscriptionId}`;
      const perms = await api.arm.permissions(scope).catch(() => null);
      // Unknown permissions aren't a no: the vault step reports a real failure.
      if (perms && !allowsAction(perms, 'Microsoft.KeyVault/vaults/write')) {
        ui.warn(`You can't create a Key Vault in ${group ? kv.resourceGroup : 'this subscription'}: that needs Contributor there.`);
        const how = await ui.select(
          `Where should ${what} go?`,
          [
            { name: `${NO_VAULT_NAME} (recommended)`, value: NOTEBOOK, description: NO_VAULT_DESCRIPTION },
            { name: 'Pick a vault or resource group', value: 'other' },
          ],
          NOTEBOOK,
        );
        if (how === NOTEBOOK && (await confirmNotebookMode(ctx))) return;
        if (ui.yes) throw new Error(`You can't create a Key Vault in ${group ? kv.resourceGroup : 'this subscription'}. Add --no-key-vault to keep ${what} in the notebooks, or ask for Contributor there.`);
        askGroup = true;
        continue;
      }
      kv.location = asksAdvanced(ctx) ? await ui.input('Azure region', { default: kv.location ?? location }) : kv.location ?? location;
      const suggested = kv.name ?? `${KEY_VAULT_PREFIX}${randomBytes(2).toString('hex')}`;
      kv.name = asksAdvanced(ctx) ? await ui.input('Vault name (globally unique)', { default: suggested, validate: validateVaultName }) : suggested;
      const available = await api.arm.checkVaultName(subscriptionId, kv.name);
      if (!available.nameAvailable) throw new Error(`Key Vault name "${kv.name}" is taken: ${available.message ?? 'choose another'}.`);
      kv.rbac = !!perms && allowsAction(perms, 'Microsoft.Authorization/roleAssignments/write');
      if (!kv.rbac) ui.note('You can\'t assign Azure roles here, so the vault will use access policies instead of Azure RBAC.');
    }
    if (kv.mode !== 'keyvault-admin') delete kv.handoff;
    break;
  }
  if (asksAdvanced(ctx) && forNotebooks) kv.secretName = await ui.input('Secret name', { default: kv.secretName, validate: (v) => (/^[0-9a-zA-Z-]{1,127}$/.test(v) ? true : 'Letters, digits and hyphens only.') });
}

const NOTEBOOK = 'notebook';
const NO_VAULT_NAME = 'No Key Vault: keep secrets in the notebooks';
const NO_VAULT_DESCRIPTION = 'Nothing in Azure. Anyone with a role in the workspace can read them; Key Vault avoids that.';

/**
 * Whether the secret's home is still open and no Key Vault is the default: a new Fabric install
 * that hasn't picked a vault, without --key-vault or flows that read the secret from the vault.
 * @param {Ctx} ctx
 */
export function defaultsToNoVault(ctx) {
  const { config } = ctx;
  const kv = config.keyVault;
  if (ctx.useKeyVault || flowIdentity(config) === 'app') return false;
  return !kv.uri && !kv.mode && !kv.name && !kv.id && !kv.subscriptionId;
}

/**
 * A new install: no Key Vault by default, or Key Vault.
 * @param {Ctx} ctx
 * @param {Preflight} pre
 * @param {string} location
 */
async function chooseSecretHome(ctx, pre, location) {
  const { ui, config } = ctx;
  const kept = keptSecrets(config);
  const where = ctx.secretInNotebook
    ? NOTEBOOK
    : await ui.select(
        `Where should ${listJoin(kept)} go?`,
        [
          { name: `${NO_VAULT_NAME} (default)`, value: NOTEBOOK, description: NO_VAULT_DESCRIPTION },
          {
            name: 'Azure Key Vault',
            value: 'keyvault',
            description: `Needs an Azure subscription where you can create or use a vault. The notebooks read ${kept.length > 1 ? 'them' : 'it'} at run time, so workspace roles don't expose ${kept.length > 1 ? 'them' : 'it'}.`,
          },
        ],
        NOTEBOOK,
      );
  if (where === NOTEBOOK && (await confirmNotebookMode(ctx, true))) return;
  await planKeyVault(ctx, pre, location);
}

/**
 * The resource group for a new vault. Someone with Contributor on a resource group but not the
 * subscription can't create groups, so they're asked for one that exists.
 * @param {Ctx} ctx
 * @param {string} subscriptionId
 * @param {boolean} [askFirst]  Ask even when the saved or default group would do.
 */
async function askResourceGroup(ctx, subscriptionId, askFirst = asksAdvanced(ctx)) {
  const { ui, config, api } = ctx;
  const kv = config.keyVault;
  for (let ask = askFirst; ; ask = true) {
    const name = kv.resourceGroup ?? RESOURCE_GROUP;
    kv.resourceGroup = (ask ? await ui.input('Resource group (created if missing)', { default: name }) : name).trim();
    if (await api.arm.getResourceGroup(subscriptionId, kv.resourceGroup).catch(() => null)) return;
    const perms = await api.arm.permissions(`/subscriptions/${subscriptionId}`).catch(() => null);
    if (!perms || allowsAction(perms, 'Microsoft.Resources/subscriptions/resourceGroups/write')) return;
    ui.warn(`There's no resource group called ${kv.resourceGroup} that you can see, and you can't create one in this subscription. Give the name of one you have Contributor on.`);
    if (ui.yes) return;
  }
}

/**
 * Shows what no Key Vault means, then asks. Returns true when the user agrees.
 * With --yes, --no-key-vault (or --secret-in-notebook) is the agreement, or no Key Vault being the default.
 * @param {Ctx} ctx
 * @param {boolean} [byDefault]  No Key Vault is the default here, so --yes takes it.
 */
async function confirmNotebookMode(ctx, byDefault = false) {
  const { ui, config } = ctx;
  const kept = keptSecrets(config);
  const what = listJoin(kept);
  const forNotebooks = appWanted(config.dataSources);
  const github = config.dataSources.github === 'api';
  ui.warn(`No Key Vault: ${what} ${kept.length > 1 ? 'are' : 'is'} written into the notebooks as plain text.`);
  ui.info(`  - Anyone with a role in the workspace, Viewer included, or anyone a notebook is shared with, can read ${kept.length > 1 ? 'them' : 'it'}.`);
  if (forNotebooks) ui.info('  - The client secret signs in as the app, which reads your tenant\'s data.');
  if (github) ui.info('  - The GitHub token can do whatever its scopes allow in your enterprise (it reads Copilot billing).');
  ui.info('  - Notebook run snapshots, exports and deployment pipelines copy them. The installer won\'t write them');
  ui.info('    into a workspace that is connected to Git.');
  if (forNotebooks) ui.info(`  - The client secret lasts ${notebookSecretDays(config)} days. Each install, repair or update replaces it and removes the old one.`);
  ui.info('Key Vault avoids this: the notebooks read secrets from the vault at run time, so a workspace role doesn\'t expose them.');
  const ok = ui.yes ? !!ctx.secretInNotebook || byDefault : await ui.confirm(`Keep ${what} in the notebooks, with no Key Vault?`, true);
  if (ui.yes && !ok) ui.note('With --yes, add --no-key-vault to choose this.');
  if (!ok) return false;
  config.keyVault.mode = 'notebook';
  delete config.keyVault.handoff;
  return true;
}

/** The audit history a PAX first load can pull, and how long each takes. */
export const HISTORY_CHOICES = [
  { name: '30 days (quickest; you can load more later)', value: 30 },
  { name: '90 days (a few hours; longer on a large tenant)', value: 90 },
  { name: '180 days (the most the audit log keeps by default; many hours)', value: 180 },
];

/**
 * Repair or change, once the history has loaded: offers to reload more of it after setup. Only
 * more than is loaded is offered. The answer goes on `ctx.reloadHistoryDays`; the install record
 * keeps the old number until the reload has started.
 * @param {Ctx} ctx
 * @param {(days: number) => string} describe  Each reload choice's description.
 */
export async function askMoreHistory(ctx, describe) {
  const { ui, config } = ctx;
  delete ctx.reloadHistoryDays;
  const current = config.history?.days ?? 0;
  const more = HISTORY_CHOICES.filter((ch) => ch.value > current);
  if (!more.length) {
    ui.ok(`Audit history: ${current} days loaded, the most the installer loads`);
    return;
  }
  const days = await ui.select(
    `Load more audit history? ${current} days are loaded now.`,
    [
      { name: `Keep ${current} days (the usual runs carry on from here)`, value: 0 },
      ...more.map((ch) => ({
        name: `Reload ${ch.value} days after setup`,
        value: ch.value,
        description: describe(ch.value),
      })),
    ],
    0,
  );
  if (days) ctx.reloadHistoryDays = days;
}

/** @param {number} days */
export const reloadLine = (days) => `Reload ${days} days of history after setup`;

/**
 * Asks for the client ID of an app the user brought, and checks it has what the install needs
 * before anything is created.
 * @param {Ctx} ctx
 * @param {Pick<Preflight, 'canConsent'>} pre
 */
export async function askAppId(ctx, pre) {
  const { ui, config } = ctx;
  for (;;) {
    config.app.appId = (
      await ui.input('Application (client) ID', { default: config.app.appId, validate: (v) => (isGuid(v) ? true : 'Paste the GUID from the app\'s Overview page.') })
    ).trim();
    for (;;) {
      const check = await checkExistingApp(ctx, ctx.liveApi ?? ctx.api);
      if (check.displayName) config.app.displayName = check.displayName;
      if (reportAppCheck(ctx, check, pre)) return;
      if (ui.yes) {
        if (!check.found) throw new Error(`No app registration with ID ${config.app.appId} in this tenant.`);
        ui.warn('Carrying on. Data the missing permissions cover won\'t load until an admin fixes them.');
        return;
      }
      const next = await ui.select(
        'What next?',
        [
          { name: 'Check again', value: 'again', description: 'Once an admin has fixed it.' },
          { name: 'Enter a different client ID', value: 'other' },
          ...(check.found ? [{ name: 'Carry on anyway', value: 'go', description: 'Data the missing permissions cover won\'t load until they\'re fixed.' }] : []),
        ],
        'again',
      );
      if (next === 'go') {
        ui.warn('Carrying on with the app as it is.');
        return;
      }
      if (next === 'other') break;
    }
  }
}

/**
 * Writes the admin pack for someone who can't register apps or grant consent, then waits for
 * the client ID. Returns true when the user still needs to paste the secret.
 * @param {Ctx} ctx
 * @param {Pick<Preflight, 'canConsent'>} pre
 */
export async function planAdminPack(ctx, pre) {
  const { ui, config } = ctx;
  const kv = config.keyVault;
  const file = writeAdminPack(ctx);
  config.app.adminPack = file;
  ui.heading('Admin pack');
  ui.warn('An admin needs to register the app. Send them this file:');
  ui.info(file);
  ui.info('Or they can run this in Azure Cloud Shell (Bash):');
  for (const line of adminPack(ctx).script) ui.info(`  ${line}`);
  ctx.save();
  if (ui.yes) throw new ResumeLater('Stopped until an admin has registered the app. Once they send you its client ID, run the installer again without --yes.');
  const next = await ui.select(
    'Has the admin sent you the client ID?',
    [
      { name: 'Yes, enter it now', value: 'go' },
      { name: 'Stop and resume later', value: 'stop', description: 'Your answers are saved. Run the installer again once you have it.' },
    ],
    'go',
  );
  if (next === 'stop') throw new ResumeLater(`Stopped until an admin has registered the app. Send them ${file}, then run the installer again.`);
  await askAppId(ctx, pre);
  // The PAX refresh signs in with a secret kept on this PC, so the user always pastes it.
  if (isPax(config)) return true;
  // Only the model's connection signs in as the app: it gets a secret of its own when it's set up.
  if (!appWanted(config.dataSources)) return false;
  if (secretMode(config) === 'keyvault-admin' && kv.name) {
    if (await ui.confirm(`Did the admin's script also put the client secret in ${kv.name}?`, true)) {
      kv.handoff = { ...kv.handoff, confirmedAt: ctx.now().toISOString() };
      kv.secretSetAt = kv.handoff.confirmedAt;
    }
    return false;
  }
  return true;
}

/**
 * @param {string} base
 * @param {Set<string>} taken  Lower-case names.
 */
export function uniqueName(base, taken) {
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/** Names a new install suggests. Existing installs keep the names in their record. */
export const DEFAULT_WORKSPACE_NAME = WORKSPACE_NAME;
/** Fabric Lakehouse names can't have spaces. */
export const DEFAULT_LAKEHOUSE_NAME = LAKEHOUSE_NAME;

export const CAPACITY_HINT = 'A trial or small capacity works; on a large tenant, a larger capacity loads and refreshes faster.';

/**
 * A capacity as a choice: its name, then the SKU and region when Fabric gives them.
 * @param {{ displayName?: string, id: string, sku?: string, region?: string }} cap
 */
export function capacityLabel(cap) {
  const about = [cap.sku, cap.region].filter(Boolean).join(', ');
  return `${cap.displayName ?? cap.id}${about ? ` (${about})` : ''}`;
}

/**
 * The name to start from: the default when `name` is the default or a numbered copy of it,
 * otherwise `name`, which someone chose.
 * @param {string | undefined} name
 * @param {string} base
 */
const startFrom = (name, base) => (!name || new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ _]\\d+$`, 'i').test(name) ? base : name);

/**
 * Picks names for the Fabric items the install will create that no item already in the
 * workspace has, so the install never touches anything it didn't create.
 * @param {Ctx} ctx
 */
export async function reserveNames(ctx) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  const sm = config.semanticModel;
  const ws = f.workspaceId;
  const list = async (/** @type {string} */ type) => (ws ? /** @type {any[]} */ (await api.fabric.listItems(ws, type)) : []);
  const [notebookItems, pipelineItems, modelItems, reportItems] = await Promise.all([
    list('Notebook'),
    list('DataPipeline'),
    list('SemanticModel'),
    list('Report'),
  ]);
  const [notebookNames, pipelineNames, modelNames, reportNames] = [notebookItems, pipelineItems, modelItems, reportItems].map(displayNames);
  /** @type {string[]} */
  const renamed = [];
  /**
   * Keeps the name of an item a run that stopped part-way created, so it's used again, not renamed.
   * @param {string} key @param {any[]} items @param {string} wanted @param {string[]} taken
   */
  const pick = (key, items, wanted, taken) => {
    const resumed = stoppedRunItem(f, key, items);
    if (resumed) return String(resumed.displayName);
    const name = freeName(wanted, taken);
    if (name !== wanted) renamed.push(wanted);
    taken.push(name);
    return name;
  };

  // Every notebook the sources may deploy, Azure AI's included before its access is in place.
  const notebooks = notebooksFor(ctx.sources.catalog, config.dataSources, { semanticModel: !!sm.enabled });
  f.notebookNames ??= {};
  for (const nb of notebooks) {
    if (!f.notebooks[nb.key]) f.notebookNames[nb.key] = pick(`Notebook:${nb.key}`, notebookItems, startFrom(f.notebookNames[nb.key], nb.displayName), notebookNames);
  }
  if (!f.pipelineId) f.pipelineName = pick('DataPipeline', pipelineItems, startFrom(f.pipelineName, PIPELINE_NAME), pipelineNames);
  if (sm.enabled && !sm.id) sm.name = pick(`SemanticModel:${modelKey(config, sm)}`, modelItems, startFrom(sm.name, MODEL_NAME), modelNames);
  for (const w of reportsWanted(ctx)) {
    if (!w.model.report?.id) w.model.report = { ...w.model.report, name: pick(`Report:${modelKey(config, w.model)}`, reportItems, startFrom(w.model.report?.name, w.name), reportNames) };
  }

  if (renamed.length) {
    ui.note(
      `The workspace already has ${renamed.map((n) => `"${n}"`).join(', ')}, not from this install. They're left as they are; Consumption Central's own items get the names shown in the plan.`,
    );
  }
}

/**
 * @typedef {{ kind: string, name: string, detail?: string, isNew: boolean }} ReviewItem
 * @typedef {{ who: string, what: string, where: string, detail?: string }} ReviewGrant
 * @typedef {{ what: string, where: string, detail?: string }} ReviewRun
 * @typedef {{ what: string, detail?: string, url: string }} ReviewCost
 * @typedef {{ creates: ReviewItem[], grants: ReviewGrant[], runsOn: ReviewRun[], costs?: ReviewCost[] }} PlanReview
 */

export const PRICING = {
  fabric: 'https://azure.microsoft.com/pricing/details/microsoft-fabric/',
  powerAutomate: 'https://www.microsoft.com/power-platform/products/power-automate/pricing',
  keyVault: 'https://azure.microsoft.com/pricing/details/key-vault/',
  powerBiPro: 'https://www.microsoft.com/power-platform/products/power-bi/pricing',
};

/**
 * What the install adds to the bill, each with where its prices are. No prices here: they change
 * and differ by region and agreement.
 * @param {import('../config.js').InstallConfig} config
 * @returns {ReviewCost[]}
 */
export function planCosts(config) {
  /** @type {ReviewCost[]} */
  const costs = [];
  costs.push({ what: 'Fabric capacity', detail: 'Runs the notebooks, pipeline and reports. Billed by capacity size; a trial capacity is free while it lasts.', url: PRICING.fabric });
  if (flowsWanted(config).length) costs.push({ what: 'Power Automate Premium', detail: 'A licence for whoever signs in to the flows.', url: PRICING.powerAutomate });
  if (secretWanted(config.dataSources) && secretMode(config) !== 'notebook') {
    costs.push({ what: 'Azure Key Vault', detail: `Holds ${listJoin(keptSecrets(config))}. Billed to your Azure subscription.`, url: PRICING.keyVault });
  }
  return costs;
}

/**
 * What the plan creates, who it gives access to what, and where it runs: the record a
 * reviewer reads before saying go ahead.
 * @param {Ctx} ctx
 * @param {Pick<Preflight, 'capacities' | 'subscriptions' | 'canConsent'>} [pre]
 * @returns {PlanReview}
 */
export function planReview(ctx, pre) {
  const { config, user } = ctx;
  const f = config.fabric;
  const kv = config.keyVault;
  const sm = config.semanticModel;
  const cc = config.consumption;
  const ds = config.dataSources;
  const ct = config.commercialTerms;
  const appName = config.app.appId ? config.app.displayName ?? config.app.appId : APP_NAME;
  const forNotebooks = appWanted(ds);
  const withAzureAi = ds.azureAi === 'api' && !!cc.azureSubscriptionId;
  const notebooks = notebooksFor(ctx.sources.catalog, ds, { semanticModel: !!sm.enabled });
  const kept = keptSecrets(config);
  const them = kept.length > 1 ? 'them' : 'it';

  const mode = secretMode(config);
  const vault = secretWanted(ds) && mode !== 'notebook';
  /** @type {ReviewItem[]} */
  const creates = [];
  if (appNeeded(config)) {
    const yours = config.app.existing ? 'Yours. ' : '';
    creates.push({
      kind: 'App registration',
      name: appName,
      isNew: !config.app.appId,
      detail:
        config.app.adminPack && !config.app.appId
          ? 'An admin registers it from the admin pack and sends you its client ID.'
          : !forNotebooks
            ? `${yours}Signs in for the semantic model's connection only, with a client secret only the connection holds. No Graph permissions.`
            : mode === 'notebook'
              ? config.app.existing
                ? 'Yours. A client secret you paste is written into the notebooks; no Key Vault.'
                : `Its client secret is written into the notebooks, lasts ${notebookSecretDays(config)} days and is replaced on each install, repair or update. No Key Vault.`
              : mode === 'keyvault-admin'
                ? `${yours}A vault admin adds its client secret to Key Vault.`
                : config.app.existing
                  ? 'Yours. A client secret you paste goes straight to Key Vault.'
                  : 'The notebooks sign in as it, with a client secret kept in Key Vault.',
    });
  }
  if (secretWanted(ds) && mode === 'notebook') {
    creates.push({
      kind: kept.length > 1 ? 'Secrets' : forNotebooks ? 'Client secret' : 'GitHub token',
      name: 'In the notebooks (no Key Vault)',
      // Every install, repair or update writes a fresh client secret.
      isNew: forNotebooks || !config.github?.tokenSetAt,
      detail: `Anyone with a role in the workspace, Viewer included, can read ${them}; also in run snapshots, exports and deployment pipelines. Key Vault avoids that.`,
    });
  } else if (vault) {
    const held = [...(forNotebooks ? [`the secret "${kv.secretName}"`] : []), ...(ds.github === 'api' ? [`the GitHub token "${githubSecretName(config)}"`] : [])];
    creates.push({
      kind: 'Key Vault',
      name: kv.name ?? 'Not chosen',
      isNew: !kv.existing && !kv.uri,
      detail: [
        kv.existing || kv.uri ? undefined : `In resource group ${kv.resourceGroup}, ${kv.location}, using ${kv.rbac ? 'Azure RBAC' : 'access policies'}.`,
        `Holds ${listJoin(held)}.`,
        mode === 'keyvault-admin' ? `A vault admin adds ${them}; you get their steps.` : undefined,
      ]
        .filter(Boolean)
        .join(' '),
    });
  }
  creates.push(
    { kind: 'Workspace', name: f.workspaceName ?? f.workspaceId ?? 'Not chosen', isNew: !f.workspaceId },
    { kind: 'Lakehouse', name: f.lakehouseName ?? DEFAULT_LAKEHOUSE_NAME, isNew: !f.lakehouseId },
    {
      kind: 'Notebooks',
      name: `${notebooks.length} notebook${notebooks.length === 1 ? '' : 's'}`,
      isNew: notebooks.some((nb) => !f.notebooks[nb.key]),
      detail: notebooks.map((nb) => f.notebookNames?.[nb.key] ?? nb.displayName).join(', '),
    },
    { kind: 'Pipeline', name: f.pipelineName ?? PIPELINE_NAME, isNew: !f.pipelineId, detail: `Runs the notebooks ${describeSchedule(config.schedule)}.` },
  );
  if (routerWanted(config.dataSources)) {
    const n = ctx.pendingUploads?.length ?? 0;
    creates.push({
      kind: 'Folder',
      name: UPLOAD_DIR,
      isNew: !config.uploads.folders,
      detail: `Drop exports here; each run loads them.${n ? ` ${n} file${n === 1 ? '' : 's'} uploaded now.` : ''}`,
    });
  }
  if (ds.coworkCredits === 'api') {
    creates.push({ kind: 'Dataflow Gen2', name: cc.dataflowName ?? COWORK_DATAFLOW_NAME, isNew: !cc.dataflowId, detail: 'Reads Cowork credits from your Viva Insights query before each Viva load.' });
  }
  const env = config.uploads.flowEnvironment;
  for (const kind of flowsWanted(config)) {
    creates.push({
      kind: 'Power Automate flow',
      name: FLOW_NAMES[kind],
      isNew: !config.uploads.flowIds?.[kind],
      detail: env ? `In ${env.name ?? env.url}, turned off. The installer helps you sign in to its connections, then turns it on.` : 'Written to a file to import.',
    });
  }
  if (sm.enabled) {
    creates.push({ kind: 'Semantic model', name: sm.name, isNew: !sm.id, ...(sm.id ? { detail: MODEL_UPDATE_NOTE } : {}) });
    creates.push({
      kind: 'Connection',
      name: sm.connectionName ?? (f.workspaceId ? connectionName(f.workspaceId) : `${PRODUCT_NAME} SQL connection`),
      isNew: !sm.connectionId,
      detail: forNotebooks
        ? 'Lets the model read the Lakehouse, with a second client secret that only the connection holds.'
        : 'Lets the model read the Lakehouse as the app, with a client secret that only the connection holds.',
    });
    for (const w of reportsWanted(ctx)) {
      creates.push({ kind: 'Report', name: w.model.report?.name ?? w.name, isNew: !w.model.report?.id, detail: `From its Power BI template, reading ${w.model.name}.` });
    }
  }
  const access = sm.enabled ? accessReview(config, `Semantic model ${sm.name} in workspace ${f.workspaceName ?? f.workspaceId}`) : { creates: [], grants: [] };
  creates.push(...access.creates);

  const appWho = `${appName} (app)`;
  /** @type {ReviewGrant[]} */
  const grants = [];
  const perms = permissionsFor(ds);
  if (forNotebooks && perms.length) {
    grants.push({
      who: appWho,
      what: `Microsoft Graph application permissions: ${perms.join(', ')}`,
      where: 'Your tenant, through admin consent',
      detail: pre && !pre.canConsent ? 'You can\'t grant it yourself. You get a link for a Global Administrator or Privileged Role Administrator to approve.' : undefined,
    });
  }
  if (secretWanted(ds) && !kv.uri && mode === 'keyvault-admin') {
    grants.push({
      who: `${user.upn} (you)`,
      what: kv.rbac === false ? 'An access policy with secret get and list' : 'Key Vault Secrets User, or an access policy with secret get and list if the vault doesn\'t use Azure RBAC',
      where: `Key Vault ${kv.name}`,
      detail: `Read only, so scheduled runs can read ${them}. Only when you don't have it already; if you can't give it to yourself, the vault admin's steps include it.`,
    });
  } else if (secretWanted(ds) && !kv.uri && mode === 'keyvault') {
    grants.push({
      who: `${user.upn} (you)`,
      what: kv.existing
        ? 'Key Vault Secrets Officer, or an access policy with secret get, list and set if the vault doesn\'t use Azure RBAC'
        : kv.rbac === false
          ? 'An access policy with secret get, list and set'
          : `Key Vault Secrets Officer, so you can write ${listJoin(kept)}`,
      where: `Key Vault ${kv.name}`,
      detail: kv.existing ? 'Only when you don\'t have it already.' : undefined,
    });
  }
  if (sm.enabled) grants.push({ who: appWho, what: 'Viewer', where: `Workspace ${f.workspaceName ?? f.workspaceId}`, detail: 'So the semantic model can read the Lakehouse.' });
  grants.push(...access.grants);
  const flows = flowsWanted(config);
  if (flows.length && flowIdentity(config) === 'app') {
    grants.push({ who: appWho, what: 'Contributor', where: `Workspace ${f.workspaceName ?? f.workspaceId}`, detail: 'So the Power Automate flows can save files to the drop folder.' });
  } else if (flows.length) {
    grants.push({
      who: 'Whoever signs in to the flows\' OneLake connection',
      what: 'Contributor or higher',
      where: `Workspace ${f.workspaceName ?? f.workspaceId}`,
      detail: 'Not granted by the installer. You have it already; give it to anyone else who signs in.',
    });
  }
  if (withAzureAi && !cc.azureAccess) {
    grants.push({ who: appWho, what: AZURE_AI_ROLES.map((r) => r.name).join(', '), where: `Azure subscription ${cc.azureSubscriptionName ?? cc.azureSubscriptionId}`, detail: 'So the notebook can read Azure AI usage and cost.' });
  }

  const capacity = pre?.capacities.find((cap) => cap.id === f.capacityId);
  const subscription = pre?.subscriptions.find((s) => s.subscriptionId === kv.subscriptionId);
  const scheduled = [...(vault ? [`reads ${listJoin(kept)} from Key Vault`] : []), ...(sm.enabled ? ['refreshes the model'] : [])].join(' and ');
  /** @type {ReviewRun[]} */
  const runsOn = [
    {
      what: sm.enabled ? `Notebooks, pipeline, semantic model${reportsWanted(ctx).length ? ', report' : ''}` : 'Notebooks and pipeline',
      where: capacity ? `Fabric capacity ${capacity.displayName} (${capacity.sku}, ${capacity.region})` : `Fabric capacity ${f.capacityId ?? 'not chosen'}`,
    },
    ...(vault ? [{ what: 'Key Vault', where: `Azure subscription ${subscription?.displayName ?? kv.subscriptionId ?? 'already chosen'}`, detail: 'Standard tier.' }] : []),
    {
      what: 'Scheduled runs',
      where: `${describeSchedule(config.schedule)}, as ${user.upn}`,
      detail: scheduled ? `The schedule's owner ${scheduled}.` : undefined,
    },
  ];
  if (ctx.runFirstLoad) runsOn.push({ what: 'First load', where: 'Straight after setup' });
  if (ds.commercialTerms === 'api' && !ct?.ranAt) {
    runsOn.push({
      what: 'Credit rate',
      where: `Once, after setup, as ${user.upn}`,
      detail: `Reads ${ct?.scopeName ?? ct?.scope ?? 'the billing scope you chose'}; needs Cost Management Reader there.`,
    });
  }
  return { creates, grants, runsOn, costs: planCosts(config) };
}

/**
 * Prints the plan and asks to go ahead.
 * @param {Ctx} ctx
 * @param {Preflight} [pre]
 */
export async function confirmPlan(ctx, pre) {
  const { ui, config } = ctx;
  const ds = config.dataSources;
  const pad = ' '.repeat('Data:        '.length);
  const [first, ...rest] = describeSources(ds);
  ui.heading('Ready to set up');
  ui.info(`Data:        ${first ?? ''}`);
  for (const line of rest) ui.info(`${pad}${line}`);
  const exports = DATA_SOURCES.filter((s) => exportModesOf(s).includes(ds[s.id])).map((s) => s.label);
  // A Cowork task export lands where the Viva load reads it, not in the drop folder.
  const where = routerWanted(ds) ? `dropped in ${UPLOAD_DIR}${ds.coworkTasks === 'csv' ? `, Cowork tasks in ${COWORK_TASKS_DIR}` : ''}` : `in ${COWORK_TASKS_DIR}`;
  if (exports.length) ui.info(`Exports:     ${exports.join(', ')} ${c.dim(`(${where})`)}`);
  const uploads = ctx.pendingUploads ?? [];
  if (uploads.length) ui.info(`Uploading:   ${uploads.map((u) => u.name).join(', ')}`);
  ui.info(`Workspace:   ${config.fabric.workspaceName ?? config.fabric.workspaceId} ${config.fabric.workspaceId ? '' : c.dim('(new)')}`.trimEnd());
  ui.info(`Lakehouse:   ${config.fabric.lakehouseName}`);
  if (appNeeded(config)) ui.info(`App:         ${config.app.appId ? config.app.appId : `${APP_NAME} ${c.dim('(new)')}`}`);
  if (secretWanted(ds)) {
    const kept = keptSecrets(config);
    const kvMode = secretMode(config);
    if (kvMode === 'notebook') {
      const days = appWanted(ds) ? `; the client secret lasts ${notebookSecretDays(config)} days` : '';
      ui.info(`Secrets:     ${listJoin(kept)} in the notebooks ${c.dim(`(no Key Vault: anyone with a role in the workspace can read ${kept.length > 1 ? 'them' : 'it'}${days})`)}`);
    } else if (kvMode === 'keyvault-admin') ui.info(`Key Vault:   ${config.keyVault.name} ${c.dim(`(a vault admin adds ${listJoin(kept)})`)}`);
    else ui.info(`Key Vault:   ${config.keyVault.name} ${config.keyVault.existing || config.keyVault.uri ? '' : c.dim(`(new, ${config.keyVault.rbac ? 'Azure RBAC' : 'access policies'})`)}`.trimEnd());
  }
  ui.info(`Schedule:    ${config.schedule.frequency === 'weekly' ? `${config.schedule.weekday}s` : 'Daily'} at ${config.schedule.time} ${config.schedule.timeZone}`);
  if (config.semanticModel.enabled) {
    ui.info(`Power BI:    ${config.semanticModel.name} ${config.semanticModel.id ? '' : c.dim('(new)')}`.trimEnd());
    const reports = reportsWanted(ctx).map((w) => `${w.model.report?.name ?? w.name} ${w.model.report?.id ? '' : c.dim('(new)')}`.trimEnd());
    if (reports.length) ui.info(`Reports:     ${reports.join(', ')}`);
    ui.info(`Prices:      ${describePrices(config.prices)}`);
  }
  if (ds.azureAi === 'api') {
    const cc = config.consumption;
    ui.info(`Azure AI:    ${cc.azureSubscriptionId ? `${cc.azureSubscriptionName ?? cc.azureSubscriptionId}${cc.azureAccess ? '' : c.dim(' (the app gets Reader, Cost Management Reader and Monitoring Reader)')}` : c.dim('left out')}`);
  }
  if (ds.github === 'api' && config.github?.enterprise) {
    const gh = config.github;
    const where = tokenWhere(config);
    const token = gh.tokenSetAt
      ? `token ${where.startsWith('in ') ? where : `in ${where}`}`
      : secretMode(config) === 'keyvault-admin'
        ? 'the vault admin adds the token'
        : 'token asked for once you go ahead';
    ui.info(`GitHub:      ${gh.enterprise} ${c.dim(`(${token})`)}`);
  }
  if (ds.commercialTerms === 'api' && config.commercialTerms?.scope) {
    const ct = config.commercialTerms;
    ui.info(`Credit rate: ${ct.scopeName ?? ct.scope}${ct.ranAt ? '' : ` ${c.dim('(read once, after setup)')}`}`);
  }
  if (ctx.runFirstLoad) ui.info('First load:  straight after setup');
  ui.review(planReview(ctx, pre));
  ui.note(keepAwake());
  return ui.confirm('Go ahead?', true);
}

/** Said before Go ahead: a PC that sleeps stops the setup part way. */
export const KEEP_AWAKE = 'Keep this PC plugged in and awake until setup finishes.';
/** The same in Azure Cloud Shell, where closing the tab ends the session. */
export const KEEP_CLOUD_SHELL_OPEN = 'Keep this Cloud Shell tab open until setup finishes.';
/** @param {NodeJS.ProcessEnv} [env] */
export const keepAwake = (env = process.env) => (inCloudShell(env) ? KEEP_CLOUD_SHELL_OPEN : KEEP_AWAKE);
