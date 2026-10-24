// @ts-check
/**
 * Keeps Consumption Central apart from what other products' installers set up. Analytics Hub's
 * installer can load the same consumption data, with its Credit Consumption module, and this
 * installer started as a port of it, so the two are easy to mix up.
 */
import { PRODUCT_NAME, RECORD_PRODUCT } from './product.js';

export const ANALYTICS_HUB_URL = 'https://github.com/microsoft/AnalyticsHub-Dashboard';
/** Analytics Hub's installer keeps its state in this folder of its Lakehouse. */
export const ANALYTICS_HUB_FOLDER = 'Files/valuelens_installer';
/** Items Analytics Hub's installer names this way: its helper notebooks, pipeline and Dataflow, and its audit log notebooks. */
const ANALYTICS_HUB_ITEM = /^(AnalyticsHub_|Copilot_Audit_Log_)/i;
/** Analytics Hub's Credit Consumption module: notebooks that load the data Consumption Central loads. */
const CONSUMPTION_NOTEBOOK = /^Consumption_Ingest_/i;
/** The workspace name Analytics Hub's installer suggests. */
const ANALYTICS_HUB_WORKSPACE = /analytics[\s_-]*hub/i;
/** Workspaces with that name looked in for the Credit Consumption module, at most. */
const MAX_LOOKS = 5;

const ASIDE = `To set up ${PRODUCT_NAME}, move the file aside or pass --config with another path.`;

/**
 * Why an install record can't be used here, or undefined when Consumption Central's installer wrote it.
 * @param {Record<string, any>} raw  The record as read from disk.
 * @param {string} file
 */
export function foreignRecord(raw, file) {
  if (raw.product === RECORD_PRODUCT) return undefined;
  if (raw.product === undefined) {
    return `${file} isn't a ${PRODUCT_NAME} install record: it has no "product" field. Records from Analytics Hub's installer look like this; for that install, use its installer: ${ANALYTICS_HUB_URL}. ${ASIDE}`;
  }
  return `${file} is a "${String(raw.product)}" install record, not a ${PRODUCT_NAME} one. Use the installer that wrote it. ${ASIDE}`;
}

/**
 * What another product's installer left in a workspace.
 * @typedef {object} OtherInstall
 * @property {string[]} items  Items Analytics Hub's installer made.
 * @property {string} [folder]  When no item gave it away: the Lakehouse holding Analytics Hub's installer folder.
 * @property {string[]} consumption  Notebooks that load credit consumption.
 */

/** @param {any[]} items @param {RegExp} pattern @param {string} [type] */
const named = (items, pattern, type) =>
  items
    .filter((i) => (!type || i.type === type) && pattern.test(String(i.displayName ?? '')))
    .map((i) => String(i.displayName))
    .sort();

/**
 * Looks in a workspace for an Analytics Hub install. OneLake is only asked when no item gives it away,
 * and a OneLake failure counts as no folder.
 * @param {Pick<import('./install.js').Apis, 'fabric'> & { oneLake?: import('./clients/onelake.js').OneLakeApi }} api
 * @param {string} workspaceId
 * @returns {Promise<OtherInstall>}
 */
export async function otherInstallIn(api, workspaceId) {
  /** @type {any[]} */
  const items = (await api.fabric.listItems(workspaceId)) ?? [];
  /** @type {OtherInstall} */
  const found = { items: named(items, ANALYTICS_HUB_ITEM), consumption: named(items, CONSUMPTION_NOTEBOOK, 'Notebook') };
  if (found.items.length || !api.oneLake) return found;
  for (const lakehouse of items.filter((i) => i.type === 'Lakehouse')) {
    if (await api.oneLake.exists(workspaceId, lakehouse.id, ANALYTICS_HUB_FOLDER).catch(() => false)) {
      found.folder = String(lakehouse.displayName);
      break;
    }
  }
  return found;
}

/** Whether another product's installer set up the workspace: today, Analytics Hub's. @param {OtherInstall} found */
export const holdsOtherInstall = (found) => found.items.length > 0 || !!found.folder;

/**
 * Whether a workspace's items include an Analytics Hub install: an item its installer named, or one
 * whose description names it. The PAX route checks the Power BI workspace it publishes the report to
 * with this. It may see only the workspace's Power BI items, and no OneLake folders.
 * @param {{ displayName?: string, description?: string }[]} items
 */
export const foreignInstall = (items) =>
  named(items, ANALYTICS_HUB_ITEM).length > 0 || items.some((i) => /\banalytics hub\b/i.test(String(i.description ?? '')));

/** Why the PAX route won't publish to a workspace that holds an Analytics Hub install. @param {string} workspace  Its name. */
export const foreignWorkspaceMessage = (workspace) =>
  `Workspace "${workspace}" holds an Analytics Hub install. ${PRODUCT_NAME} needs a workspace of its own: uninstalling Analytics Hub deletes its whole workspace. Choose another workspace or create a new one. To change that install, use its installer: ${ANALYTICS_HUB_URL}`;

/** "a, b, c and 2 more" @param {string[]} names */
function sample(names) {
  const shown = names.slice(0, 3);
  const more = names.length - shown.length;
  if (more > 0) return `${shown.join(', ')} and ${more} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : (shown[0] ?? '');
}

/** What gave the Analytics Hub install away. @param {OtherInstall} found */
const evidence = (found) =>
  found.items.length ? sample(found.items) : `its installer's folder, ${ANALYTICS_HUB_FOLDER.split('/').pop()}, in Lakehouse "${found.folder}"`;

/**
 * Why Consumption Central won't install in a workspace Analytics Hub's installer set up.
 * @param {string} workspace  Its name.
 * @param {OtherInstall} found
 * @param {string} next  What to do instead.
 */
export const workspaceTaken = (workspace, found, next) =>
  `Workspace "${workspace}" holds an Analytics Hub install (${evidence(found)}). ${PRODUCT_NAME} needs a workspace of its own: uninstalling either one deletes its whole workspace. ${next}`;

/** For the uninstall question, when the workspace also holds an Analytics Hub install. @param {OtherInstall} found */
export const otherInstallGoesToo = (found) => `It also holds an Analytics Hub install (${evidence(found)}), which goes too.`;

/**
 * @param {string} workspace  Its name.
 * @param {string[]} notebooks
 */
export const consumptionLoaded = (workspace, notebooks) =>
  `Workspace "${workspace}" already loads credit consumption, with ${sample(notebooks)}. Analytics Hub's Credit Consumption module adds these notebooks. ${PRODUCT_NAME} loads the same data again, into its own Lakehouse.`;

/**
 * Warns when a workspace with the name Analytics Hub's installer suggests already loads credit
 * consumption. Other workspaces would take a call each to look in, so only the one chosen is.
 * @param {import('./install.js').Ctx} ctx
 * @param {{ id: string, displayName: string }[]} workspaces
 * @returns {Promise<Set<string>>}  The workspaces it warned about.
 */
export async function warnConsumptionLoaded(ctx, workspaces) {
  /** @type {Set<string>} */
  const warned = new Set();
  for (const ws of workspaces.filter((w) => ANALYTICS_HUB_WORKSPACE.test(w.displayName ?? '')).slice(0, MAX_LOOKS)) {
    /** @type {any[] | null} */
    const notebooks = await Promise.resolve()
      .then(() => ctx.api.fabric.listItems(ws.id, 'Notebook'))
      .catch(() => null);
    const loads = named(notebooks ?? [], CONSUMPTION_NOTEBOOK);
    if (!loads.length) continue;
    ctx.ui.warn(consumptionLoaded(ws.displayName, loads));
    warned.add(ws.id);
  }
  return warned;
}
