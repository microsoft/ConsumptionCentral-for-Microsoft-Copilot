// @ts-check
/**
 * The installer's two routes: Fabric, where notebooks and a pipeline load a Lakehouse for the
 * report, and no Fabric, where the report reads its sources through its own connectors and a
 * scheduled task on this PC runs PAX for the org file, which it writes to the SharePoint folder
 * that the report and the app read. Ported from the ValueLens installer's target.js (5910a84).
 */
import { permissionsFor } from './catalog.js';
import { PRODUCT } from './product.js';
import { paxHostOf } from './steps/pax/local.js';

/** @typedef {import('./config.js').InstallConfig} InstallConfig */
/** @typedef {'fabric' | 'pax'} Target */

export const TARGETS = /** @type {const} */ (['fabric', 'pax']);

/** What the installer calls each route. */
export const ROUTE_NAMES = Object.freeze({ fabric: 'Fabric', pax: 'No Fabric: SharePoint + PAX' });

/**
 * Graph application permissions the PAX app needs for the org file: the users and licences PAX
 * reads, and write access to the one SharePoint site that an administrator grants (Sites.Selected).
 */
export const PAX_PERMISSIONS = Object.freeze(['Organization.Read.All', 'Sites.Selected', 'User.Read.All']);

/** What PAX's audit mode adds. Consumption Central runs PAX for users only, so it never asks for it. */
export const PAX_AUDIT_PERMISSIONS = Object.freeze(['AuditLogsQuery.Read.All']);

/** What the Agent 365 registry adds. A tenant without CopilotPackages.Read.All yet only loses the registry. */
export const PAX_AGENT365_PERMISSIONS = Object.freeze(['Application.Read.All', 'CopilotPackages.Read.All']);

/** @param {InstallConfig} config */
export const isPax = (config) => config.target === 'pax';

/**
 * Graph application permissions the app registration needs on the record's route, sorted.
 * @param {InstallConfig} config
 * @returns {string[]}
 */
export function requiredPermissions(config) {
  if (!isPax(config)) return permissionsFor(config.dataSources);
  return [
    ...new Set([
      ...PAX_PERMISSIONS,
      ...(PRODUCT.pax.mode === 'audit' ? PAX_AUDIT_PERMISSIONS : []),
      ...(config.pax?.agent365 ? PAX_AGENT365_PERMISSIONS : []),
    ]),
  ].sort();
}

/**
 * Graph application permissions the installer may have given the PAX app for a choice since
 * switched off, such as the Agent 365 file, sorted. None on the Fabric route, which keeps what it has.
 * @param {InstallConfig} config
 * @returns {string[]}
 */
export function retiredPermissions(config) {
  if (!isPax(config)) return [];
  const need = new Set(requiredPermissions(config));
  return [...new Set([...PAX_PERMISSIONS, ...PAX_AUDIT_PERMISSIONS, ...PAX_AGENT365_PERMISSIONS])].filter((p) => !need.has(p)).sort();
}

/**
 * The name a new app registration gets on the record's route.
 * @param {InstallConfig} config
 */
export const appName = (config) => (isPax(config) ? PRODUCT.pax.app : PRODUCT.fabric.app);

/**
 * The route an install has started on, which can't change without uninstalling first.
 * @param {InstallConfig} config
 * @returns {Target | undefined}
 */
export function settledRoute(config) {
  const f = config.fabric;
  if (f.lakehouseId || f.pipelineId || Object.keys(f.notebooks ?? {}).length) return 'fabric';
  if (config.pax?.task || config.pax?.credentialTarget || config.sharePoint) return 'pax';
  return undefined;
}

/**
 * Why this machine can't run the PAX route, or undefined when it can.
 * @param {{ platform: NodeJS.Platform | string, cloudShell: boolean }} host
 */
export function paxHostProblem(host) {
  if (host.cloudShell) {
    return `The ${ROUTE_NAMES.pax} route runs a daily task on a Windows PC, so it can't be set up from Azure Cloud Shell. Run the installer on the Windows PC that will run the task.`;
  }
  if (host.platform !== 'win32') {
    return `The ${ROUTE_NAMES.pax} route runs a daily task with Windows Task Scheduler, so it needs a Windows PC. Run the installer on the Windows PC that will run the task, or choose the Fabric route.`;
  }
  return undefined;
}

/**
 * Holds a command to the route its install record started on, without asking. install asks
 * instead (askTarget); prereqs may look at either route, since it changes nothing.
 * @param {import('./install.js').Ctx} ctx
 */
export function holdTarget(ctx) {
  const settled = settledRoute(ctx.config);
  if (!settled) return;
  if (ctx.targetChosen && ctx.config.target !== settled) {
    throw new Error(`This install record is for the ${ROUTE_NAMES[settled]} route, so --target ${ctx.config.target} doesn't apply to it. Leave out --target, or pass --config with the other route's install record.`);
  }
  ctx.config.target = settled;
}

/**
 * Asks which route to set up, unless the record or --target has settled it. A record that has
 * started on one route stays on it.
 * @param {import('./install.js').Ctx} ctx
 */
export async function askTarget(ctx) {
  const { config, ui } = ctx;
  const settled = settledRoute(config);
  if (settled) {
    if (ctx.targetChosen && config.target !== settled) {
      throw new Error(`This install record is for the ${ROUTE_NAMES[settled]} route. Uninstall it first to change route, or pass --config with a new file name to set up a second copy.`);
    }
    config.target = settled;
  } else if (!ctx.targetChosen) {
    ui.heading('Where it runs');
    config.target = await ui.select(
      `Where should ${PRODUCT.name} run?`,
      [
        {
          name: ROUTE_NAMES.fabric,
          value: 'fabric',
          description: 'Notebooks and a pipeline in a Fabric workspace load the data into a Lakehouse each day, for the report. Needs a Fabric capacity (F2 or larger, or a trial).',
        },
        {
          name: ROUTE_NAMES.pax,
          value: 'pax',
          description:
            'The report reads the exports in a SharePoint folder and Viva Insights directly, and a daily task on this Windows PC runs PAX for the org file. The app reads the same folder. Needs Power BI Pro and PowerShell 7.2 or later.',
        },
      ],
      /** @type {Target} */ (config.target ?? 'fabric'),
    );
  }
  if (isPax(config)) {
    const problem = paxHostProblem(paxHostOf(ctx));
    if (problem) throw new Error(problem);
  }
  ctx.save();
  return config.target;
}
