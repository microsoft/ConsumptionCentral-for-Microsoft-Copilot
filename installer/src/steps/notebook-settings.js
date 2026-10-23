// @ts-check
/**
 * What the installer writes into each notebook it deploys. Every name written here is one
 * installer-assets.json lists for that notebook (values, expressions, or a patch find), and
 * test/notebook-settings.test.js checks that against the real notebooks for each data-source mode.
 */
import { createHash } from 'node:crypto';
import { secretMode } from '../config.js';
import { statusConfigJson } from '../loads.js';
import { INLINE_SECRET_NOTE, MARKER, pyString } from '../transform/notebook.js';
import { routedSources, routerSignaturesJson, SHAREPOINT_SUBDIR, UPLOAD_DIR, UPLOAD_LOG_TABLE } from '../uploads.js';
import { githubSecretName } from './github.js';

/** @typedef {import('../install.js').Ctx} Ctx */
/** @typedef {import('../catalog.js').NotebookInfo} NotebookInfo */
/** @typedef {import('../config.js').InstallConfig} InstallConfig */
/** @typedef {import('../transform/notebook.js').NotebookSecret} NotebookSecret */

/** Stands in for the client secret when there is no value to write, e.g. in a preview. */
export const SECRET_PLACEHOLDER = '<client secret>';
/** Stands in for the GitHub token in the same way, and in the hash of the notebook that holds it. */
export const TOKEN_PLACEHOLDER = '<GitHub token>';

/** The Azure AI notebook's Key Vault read, as it ships. */
export const AZURE_AI_SECRET_FIND = 'secret = notebookutils.credentials.getSecret(KEY_VAULT_URL, CLIENT_SECRET_NAME)';
/** The Azure AI notebook's extra pay-as-you-go subscriptions, as it ships. */
export const PAYG_FIND = 'PAYG_SUBSCRIPTION_IDS = []';

/**
 * Whether the installer writes the app's tenant, client ID and secret into this notebook.
 * Ingest_Studio uses them only to look up the users the licensing API gives by object ID. With
 * CSV exports its placeholders stay, and it skips the lookup.
 * @param {InstallConfig} config
 * @param {NotebookInfo} nb
 */
export const credentialsFor = (config, nb) => nb.credentials && (nb.key !== 'studioConsumption' || config.dataSources.studioCredits === 'api');

/**
 * Notebooks that hold or read the app's client secret.
 * @param {InstallConfig} config
 * @param {NotebookInfo} nb
 */
export const usesSecret = (config, nb) => credentialsFor(config, nb) || nb.key === 'azureAi';

/**
 * Notebooks that hold or read the GitHub token (Ingest_GitHub_API).
 * @param {NotebookInfo} nb
 */
export const usesGithubToken = (nb) => nb.secret?.kind === 'githubPat';

/** Days into a month before Ingest_CommercialTerms reads the month just ended: Cost Management is still closing it. */
export const RATE_SETTLE_DAYS = 5;

/**
 * The month Ingest_CommercialTerms derives the credit rate from: the last full month, or the one
 * before it while the last is still closing. One clean month, so the rate isn't a blend across a
 * price change.
 * @param {Date} now
 * @returns {{ from: string, to: string }}
 */
export function rateWindow(now) {
  const back = now.getUTCDate() < RATE_SETTLE_DAYS ? 2 : 1;
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const day = (/** @type {number} */ month, /** @type {number} */ d) => new Date(Date.UTC(y, month, d)).toISOString().slice(0, 10);
  return { from: day(m - back, 1), to: day(m - back + 1, 0) };
}

/**
 * ActualCost is what was invoiced. With prepaid credits, usage the pack covers shows as $0 there,
 * which would derive a rate near zero, so a prepaid balance switches to AmortizedCost.
 * @param {InstallConfig} config
 */
export const costType = (config) => ((config.prices?.prepaidCreditBalance ?? 0) > 0 ? 'AmortizedCost' : 'ActualCost');

/**
 * Ingest_GitHub_API's TOKEN: read from Key Vault at run time, or with no Key Vault the token itself.
 * The token is never saved in the install record, so with no Key Vault, rewriting the notebook needs it
 * again (`ctx.pendingGithubToken`); `placeholder` builds the copy whose hash is recorded.
 * @param {Ctx} ctx
 * @param {{ placeholder?: boolean }} [opts]
 * @returns {NotebookSecret}
 */
export function githubTokenSecret(ctx, opts = {}) {
  const { config } = ctx;
  if (secretMode(config) === 'notebook') return { value: (!opts.placeholder && ctx.pendingGithubToken?.value) || TOKEN_PLACEHOLDER };
  return { vaultUri: /** @type {string} */ (config.keyVault.uri), secretName: githubSecretName(config) };
}

/**
 * What the upload router reads, and where. The folders and log table are written too, so the
 * constants in uploads.js are the one source; the asset ships the same defaults for a manual import.
 * @param {InstallConfig} config
 */
export const routerValues = (config) => ({
  DROP_DIR: UPLOAD_DIR,
  SHAREPOINT_DIR: SHAREPOINT_SUBDIR,
  LOG_TABLE: UPLOAD_LOG_TABLE,
  ENABLED_SOURCES: routedSources(config.dataSources).join(','),
  SIGNATURES_JSON: routerSignaturesJson(config.dataSources),
});

/**
 * What the deployed router was built from. A change means it has to be updated.
 * @param {InstallConfig} config
 */
export const routerSignature = (config) => createHash('sha256').update(routerSignaturesJson(config.dataSources)).digest('hex').slice(0, 16);

/**
 * The other subscriptions whose Copilot pay-as-you-go the app can read.
 * @param {InstallConfig} config
 */
export const paygReadable = (config) => (config.consumption?.paygSubscriptions ?? []).filter((p) => p.access);

/**
 * The pay-as-you-go subscriptions in the Azure AI notebook, as stored with the deployed notebook.
 * @param {InstallConfig} config
 */
export const paygIds = (config) => paygReadable(config).map((p) => p.subscriptionId).join(',');

/**
 * @param {import('../config.js').PaygSubscription[]} subs
 * @returns {import('../catalog.js').NotebookPatch}
 */
export function paygPatch(subs) {
  const lines = subs.map((s) => `    ${pyString(s.subscriptionId)},${s.name ? `  # ${s.name.replace(/[\r\n]+/g, ' ')}` : ''}`);
  return { find: PAYG_FIND, replace: ['PAYG_SUBSCRIPTION_IDS = [  # ' + MARKER, ...lines, ']'].join('\n') };
}

/**
 * What the installer changes in one notebook.
 * @param {Ctx} ctx
 * @param {NotebookInfo} nb
 * @param {{ placeholder?: boolean }} [opts]  Placeholders for the secrets, e.g. for a preview or a hash.
 * @returns {import('../transform/notebook.js').NotebookSettings}
 */
export function notebookSettings(ctx, nb, opts = {}) {
  const { config, user } = ctx;
  const f = config.fabric;
  const inline = secretMode(config) === 'notebook';
  const value = (!opts.placeholder && ctx.pendingSecret) || SECRET_PLACEHOLDER;
  /** @type {Record<string, string>} */
  let values = {};
  /** @type {Record<string, string>} */
  const expressions = { ...(nb.expressions ?? {}) };
  /** @type {Record<string, NotebookSecret>} */
  const secrets = {};
  /** @type {import('../catalog.js').NotebookPatch[]} */
  const patches = [];
  switch (nb.key) {
    case 'uploadRouter':
      values = routerValues(config);
      break;
    case 'azureAi':
      values = {
        SUBSCRIPTION_ID: /** @type {string} */ (config.consumption.azureSubscriptionId),
        TENANT_ID: user.tenantId,
        CLIENT_ID: /** @type {string} */ (config.app.appId),
        KEY_VAULT_URL: inline ? '' : /** @type {string} */ (config.keyVault.uri),
        CLIENT_SECRET_NAME: inline ? '' : config.keyVault.secretName,
      };
      if (paygReadable(config).length) patches.push(paygPatch(paygReadable(config)));
      if (inline) patches.push({ find: AZURE_AI_SECRET_FIND, replace: `secret = ${pyString(value)}  # ${INLINE_SECRET_NOTE}` });
      break;
    case 'studioConsumption':
      // The licensing-API flow saves StudioApi*.csv beside the exports; the notebook reads them only when told to.
      if (config.dataSources.studioCredits === 'api') expressions.READ_API_FILES = 'True';
      break;
    case 'githubApi':
      values = { ENTERPRISE: /** @type {string} */ (config.github?.enterprise) };
      secrets.TOKEN = githubTokenSecret(ctx, opts);
      break;
    case 'commercialTerms': {
      const window = rateWindow(ctx.now());
      values = {
        SCOPE: /** @type {string} */ (config.commercialTerms?.scope),
        FROM_DATE: window.from,
        TO_DATE: window.to,
        COST_TYPE: costType(config),
      };
      break;
    }
    case 'refreshModel':
      values = { WORKSPACE_ID: /** @type {string} */ (f.workspaceId), SEMANTIC_MODEL_ID: /** @type {string} */ (config.semanticModel.id) };
      break;
    case 'loadStatus':
      values = { STATUS_JSON: statusConfigJson() };
      break;
    default:
      break;
  }
  return {
    ...(credentialsFor(config, nb)
      ? {
          tenantId: user.tenantId,
          clientId: config.app.appId,
          secret: inline ? { value } : { vaultUri: /** @type {string} */ (config.keyVault.uri), secretName: config.keyVault.secretName },
        }
      : {}),
    parameters: nb.parameters,
    ...(Object.keys(values).length ? { values } : {}),
    ...(Object.keys(expressions).length ? { expressions } : {}),
    ...(Object.keys(secrets).length ? { secrets } : {}),
    ...(patches.length ? { patches } : {}),
    lakehouse: {
      id: /** @type {string} */ (f.lakehouseId),
      name: /** @type {string} */ (f.lakehouseName),
      workspaceId: /** @type {string} */ (f.workspaceId),
    },
  };
}
