// @ts-check
/**
 * Builds the Consumption Central pipeline from the notebooks deployed for the chosen sources. There is
 * no template: the dashboard's installer-assets.json says which notebooks there are and in what order,
 * the catalog says which ones these choices deploy, and this file says how each one runs.
 *
 * One chain, run the way Analytics Hub runs its second lane: a trial or small capacity can start only a
 * few notebooks at once and turns the rest away, so each load starts when the one before it has
 * finished, whether it succeeded or failed.
 */
import { pipelineNotebooks } from '../catalog.js';
import { PRODUCT_NAME, SESSION_TAG, UPLOAD_DIR } from '../product.js';

export { SESSION_TAG };

/** @typedef {import('../catalog.js').NotebookKey} NotebookKey */
/** @typedef {import('../catalog.js').NotebookInfo} NotebookInfo */

/**
 * How one notebook runs in the pipeline.
 * @typedef {object} ActivityRule
 * @property {string} name  A source's CSV and API notebooks share one, so its rows in dbo.load_log carry
 *   on when someone switches between them.
 * @property {string} label  Plain name, for the installer's load cards and dbo.load_log.
 * @property {string} timeout  d.hh:mm:ss
 * @property {string} does  What it does. The description adds the tables it writes, from installer-assets.json.
 * @property {'Succeeded' | 'Completed' | null} refreshAfter  How the model refresh waits for it. A usage load
 *   must succeed, so a failed collection never shows up as an empty page. Org data only has to have had its
 *   turn: the model falls back to the Viva Insights attributes. null: the refresh doesn't wait for it.
 */

/** @type {Partial<Record<NotebookKey, ActivityRule>>} */
export const ACTIVITIES = {
  uploadRouter: {
    name: 'Run_Upload_Router',
    label: 'Uploaded CSV exports',
    timeout: '0.00:30:00',
    does: `Moves each CSV export dropped in ${UPLOAD_DIR} to the folder its load reads, recognised by its headers. Does nothing when the folder is empty.`,
    refreshAfter: null,
  },
  azureAi: {
    name: 'Run_Consumption_Azure_AI',
    label: 'Azure AI spend',
    timeout: '0.01:00:00',
    does: "Reads Azure AI spend from Cost Management and token use from Azure Monitor for one subscription, plus Copilot pay-as-you-go from each billing policy's subscription.",
    refreshAfter: 'Succeeded',
  },
  studioConsumption: {
    name: 'Run_Consumption_Studio',
    label: 'Copilot Studio credits',
    timeout: '0.00:30:00',
    does: "Loads the Copilot Studio exports in Files/landing/studio, and the licensing flow's daily files when the flow is connected.",
    refreshAfter: 'Succeeded',
  },
  vivaConsumption: {
    name: 'Run_Consumption_Viva',
    label: 'Cowork and Work IQ credits',
    timeout: '0.00:30:00',
    does: "Merges the Viva Insights exports in Files/landing/viva (credits, spending policies and Cowork task pairs), and the Cowork credits Dataflow's table when there is one. Viva keeps six months, so the history builds up here.",
    refreshAfter: 'Succeeded',
  },
  github: {
    name: 'Run_Consumption_GitHub',
    label: 'GitHub Copilot',
    timeout: '0.00:30:00',
    does: 'Loads the GitHub AI usage report and seat map uploaded to Files/landing/github.',
    refreshAfter: 'Succeeded',
  },
  githubApi: {
    name: 'Run_Consumption_GitHub',
    label: 'GitHub Copilot',
    timeout: '0.00:30:00',
    does: "Reads the enterprise's Copilot seats and AI credit usage from the GitHub API.",
    refreshAfter: 'Succeeded',
  },
  org: {
    name: 'Run_Org_Data',
    label: 'Org data',
    timeout: '0.00:30:00',
    does: "Works out each person's org attributes from the Viva Insights credits, with any CSV overrides in Files/landing/org.",
    refreshAfter: 'Completed',
  },
  orgGraph: {
    name: 'Run_Org_Data',
    label: 'Org data',
    // No tenant sizes here, so it gets the time Analytics Hub gives a large tenant's Entra ID load.
    timeout: '0.01:00:00',
    does: 'Reads users and their managers from Microsoft Graph.',
    refreshAfter: 'Completed',
  },
};

/** The installer's helper notebooks that aren't loads: the pipeline adds them itself. */
const NOT_LOADS = new Set(['refreshModel', 'loadStatus']);

export const UPLOAD_ROUTER_ACTIVITY = /** @type {ActivityRule} */ (ACTIVITIES.uploadRouter).name;
/** The Viva load, which reads what the Cowork Dataflow wrote. */
export const VIVA_ACTIVITY = /** @type {ActivityRule} */ (ACTIVITIES.vivaConsumption).name;
/** The GitHub load, from uploads or the API: the step that fails once the GitHub token expires. */
export const GITHUB_ACTIVITY = /** @type {ActivityRule} */ (ACTIVITIES.githubApi).name;
export const REFRESH_ACTIVITY = 'Refresh_Consumption_Model';
export const COWORK_DATAFLOW_ACTIVITY = 'Refresh_Cowork_Credits';
/** Runs the Cowork Dataflow refresh unless the run sets SkipCowork. */
export const COWORK_WRAPPER_ACTIVITY = 'Conditionally_Refresh_Cowork_Credits';
/**
 * Leaves the Cowork Dataflow out of one run. Defaults to false, so scheduled runs always refresh it
 * and fail loudly until someone signs in; only the installer's first load sets it, when the
 * Dataflow's connections aren't signed in yet.
 */
export const SKIP_COWORK_PARAMETER = 'SkipCowork';
/** Last step: records each load's outcome in dbo.load_log and fails the run when a load failed. */
export const STATUS_ACTIVITY = 'Record_Load_Status';

/** Plain names for the pipeline's steps, by activity name. */
export const ACTIVITY_LABELS = /** @type {Record<string, string>} */ ({
  ...Object.fromEntries(Object.values(ACTIVITIES).map((a) => [a.name, a.label])),
  [COWORK_DATAFLOW_ACTIVITY]: 'Cowork credits (Viva Insights Dataflow)',
  [REFRESH_ACTIVITY]: 'Semantic model refresh',
  [STATUS_ACTIVITY]: 'Load status record',
});

/** Analytics Hub's standard refresh: the notebook gives up a little before the activity times out. */
export const REFRESH_TIMING = { timeout: '0.03:00:00', minutes: 170 };

export const PIPELINE_SCHEMA = 'https://developer.microsoft.com/json-schemas/fabric/item/pipeline/definition/pipeline/1.0.0/schema.json';

/** Bump when the pipeline's layout changes, so re-running the installer updates a pipeline an older version built. */
export const PIPELINE_VERSION = 1;
/** What this version changed, for people whose pipeline an older version built. */
export const PIPELINE_CHANGE = 'This version rebuilds the pipeline from the notebooks your sources need. Your data and settings are kept.';

/**
 * @typedef {object} PipelineSettings
 * @property {string} workspaceId
 * @property {Partial<Record<NotebookKey, string>>} notebookIds  Item IDs of the deployed notebooks.
 * @property {import('../uploads.js').DataSourceModes} dataSources
 * @property {string} [modelId]  Adds a step that refreshes this model once the usage loads have succeeded.
 * @property {string} [coworkDataflowId]  Refreshes this Dataflow, which reads Cowork credits from Viva
 *   Insights, just before the Viva load.
 */

/** Seconds between retries: long enough for a busy capacity to free up. */
export const RETRY_INTERVAL_SECONDS = 300;

/**
 * A load that runs for up to an hour or more retries twice; a shorter one three times.
 * @param {string | undefined} timeout  Activity timeout, as d.hh:mm:ss.
 */
export function retryPolicy(timeout) {
  const m = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})$/.exec(timeout ?? '');
  const long = !m || Number(m[1] ?? 0) > 0 || Number(m[2]) >= 1;
  return { retry: long ? 2 : 3, retryIntervalInSeconds: RETRY_INTERVAL_SECONDS };
}

/** "a, b and c" @param {string[]} items */
const joinList = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/**
 * The rule for a load the pipeline runs.
 * @param {NotebookKey} key
 */
export function activityRule(key) {
  const rule = ACTIVITIES[key];
  if (!rule) throw new Error(`No pipeline step for the "${key}" notebook. Add it to ACTIVITIES in installer/src/transform/pipeline.js.`);
  return rule;
}

/**
 * @param {PipelineSettings} settings
 * @param {NotebookInfo} nb
 */
function loadActivity(settings, nb) {
  const rule = activityRule(nb.key);
  const notebookId = settings.notebookIds[nb.key];
  if (!notebookId) throw new Error(`The ${nb.displayName} notebook has not been deployed.`);
  return {
    name: rule.name,
    description: nb.writes.length ? `${rule.does} Writes ${joinList(nb.writes)}.` : rule.does,
    type: 'TridentNotebook',
    dependsOn: [],
    policy: { timeout: rule.timeout, ...retryPolicy(rule.timeout), secureOutput: false, secureInput: false },
    typeProperties: { notebookId, workspaceId: settings.workspaceId, parameters: {} },
  };
}

/**
 * Refreshes the Cowork credits Dataflow just before the Viva load reads its table. It doesn't retry: a
 * refresh that fails, such as when the Viva Insights sign-in has lapsed, leaves the last table in place,
 * and the Viva load still runs because the chain waits on Completed. It sits inside an If Condition on
 * SkipCowork, so the installer's first load can leave it out while its connections aren't signed in;
 * scheduled runs keep the default, false, and always refresh it.
 * @param {PipelineSettings} settings
 */
function coworkDataflowActivity(settings) {
  const refresh = {
    name: COWORK_DATAFLOW_ACTIVITY,
    description: 'Refreshes the Dataflow that reads Cowork credits from the Viva Insights query into viva_credits_dataflow.',
    type: 'RefreshDataflow',
    dependsOn: [],
    policy: { timeout: '0.02:00:00', retry: 0, retryIntervalInSeconds: 30, secureOutput: false, secureInput: false },
    typeProperties: {
      workspaceId: settings.workspaceId,
      dataflowId: settings.coworkDataflowId,
      notifyOption: 'NoNotification',
      dataflowType: 'DataflowFabric',
    },
  };
  return {
    name: COWORK_WRAPPER_ACTIVITY,
    description: `Refreshes the Cowork credits Dataflow unless ${SKIP_COWORK_PARAMETER} is true. Scheduled runs keep the default, false.`,
    type: 'IfCondition',
    dependsOn: [],
    typeProperties: {
      expression: { value: `@not(pipeline().parameters.${SKIP_COWORK_PARAMETER})`, type: 'Expression' },
      ifTrueActivities: [refresh],
      ifFalseActivities: [],
    },
  };
}

/**
 * Runs the Refresh Model notebook once every usage load has succeeded and org data has had its turn,
 * so the model never reads a half-loaded Lakehouse.
 * @param {any[]} activities  The loads.
 * @param {PipelineSettings} settings
 */
function refreshActivity(activities, settings) {
  const notebookId = settings.notebookIds.refreshModel;
  if (!notebookId) throw new Error('The semantic model refresh notebook has not been deployed.');
  const after = new Map(Object.values(ACTIVITIES).map((a) => [a.name, a.refreshAfter]));
  /** @type {{ activity: string, dependencyConditions: string[] }[]} */
  const dependsOn = [];
  for (const a of activities) {
    const condition = after.get(a.name);
    if (condition) dependsOn.push({ activity: a.name, dependencyConditions: [condition] });
  }
  return {
    name: REFRESH_ACTIVITY,
    description: 'Refreshes the semantic model once every usage load has succeeded.',
    type: 'TridentNotebook',
    dependsOn,
    policy: { timeout: REFRESH_TIMING.timeout, retry: 0, retryIntervalInSeconds: 60, secureOutput: false, secureInput: false },
    typeProperties: {
      notebookId,
      workspaceId: settings.workspaceId,
      parameters: {
        WORKSPACE_ID: { value: settings.workspaceId, type: 'string' },
        SEMANTIC_MODEL_ID: { value: settings.modelId, type: 'string' },
        TIMEOUT_MINUTES: { value: REFRESH_TIMING.minutes, type: 'int' },
      },
    },
  };
}

/** Steps that keep their own conditions. Each already waits for the steps it needs. */
const OWN_CONDITIONS = new Set([REFRESH_ACTIVITY]);

/**
 * Chains the steps in order. Each waits for the one before it to finish, whether it succeeded or failed.
 * The model refresh keeps its own conditions, and a step after it also runs when it is skipped.
 * @param {any[]} activities
 */
export function chain(activities) {
  /** @type {{ activity: string, dependencyConditions: string[] } | undefined} */
  let after;
  for (const activity of activities) {
    const own = OWN_CONDITIONS.has(activity.name);
    if (!own) activity.dependsOn = after ? [after] : [];
    after = { activity: activity.name, dependencyConditions: own ? ['Completed', 'Skipped'] : ['Completed'] };
  }
}

/**
 * The status step waits for every activity nothing else waits for, whether it succeeded, failed or was
 * skipped. Being the only last step, its result is the run's result.
 * @param {any[]} activities
 * @param {PipelineSettings} settings
 */
function statusActivity(activities, settings) {
  const waitedOn = new Set(activities.flatMap((a) => (a.dependsOn ?? []).map((/** @type {any} */ d) => d.activity)));
  return {
    name: STATUS_ACTIVITY,
    description: 'Records how each load went in dbo.load_log, in plain words, and fails the run when a load failed so the failure is visible in the run history.',
    type: 'TridentNotebook',
    dependsOn: activities
      .filter((a) => !waitedOn.has(a.name))
      .map((a) => ({ activity: a.name, dependencyConditions: ['Completed', 'Skipped'] })),
    policy: { timeout: '0.00:20:00', retry: 0, retryIntervalInSeconds: 60, secureOutput: false, secureInput: false },
    typeProperties: {
      notebookId: settings.notebookIds.loadStatus,
      workspaceId: settings.workspaceId,
      parameters: {
        PIPELINE_RUN_ID: { value: { value: '@pipeline().RunId', type: 'Expression' }, type: 'string' },
        PIPELINE_TRIGGER_TIME: { value: { value: '@string(pipeline().TriggerTime)', type: 'Expression' }, type: 'string' },
      },
    },
  };
}

/**
 * @param {any[]} activities
 * @returns {Generator<any>}
 */
function* notebookActivities(activities) {
  for (const a of activities) {
    if (a.type === 'TridentNotebook') yield a;
    yield* notebookActivities([...(a.typeProperties?.ifTrueActivities ?? []), ...(a.typeProperties?.ifFalseActivities ?? [])]);
  }
}

/**
 * Every notebook joins one high-concurrency session. Fabric starts a new session for the sixth
 * notebook, or when the Lakehouse or Spark settings differ.
 * @param {any[]} activities
 */
export function applySessionTag(activities) {
  for (const a of notebookActivities(activities)) a.typeProperties = { ...a.typeProperties, sessionTag: SESSION_TAG };
}

/**
 * @param {PipelineSettings} settings
 * @param {{ router: boolean, status: boolean }} has
 */
function describe(settings, has) {
  return [
    `Created by the ${PRODUCT_NAME} installer.`,
    "The loads run one after another rather than all at once, so a trial or small capacity isn't overloaded; a load that fails doesn't stop the next.",
    "Every notebook shares one Spark session (high concurrency for pipelines must be on in the workspace's Spark settings).",
    has.router ? `It starts by routing any CSV exports dropped in ${UPLOAD_DIR} to the loads that read them.` : '',
    settings.coworkDataflowId
      ? `The Cowork credits Dataflow refreshes just before the Viva load. The installer's first load sets ${SKIP_COWORK_PARAMETER}=true only when the Dataflow isn't signed in yet; scheduled runs keep it false.`
      : '',
    settings.modelId ? 'The semantic model refreshes once every usage load has succeeded.' : '',
    has.status ? `${STATUS_ACTIVITY} runs last: it writes each load's outcome to dbo.load_log and fails the run if any load failed.` : '',
    `Each load retries up to 3 times, ${RETRY_INTERVAL_SECONDS / 60} minutes apart.`,
    'Run the installer again with "update" to pick up new notebook and pipeline versions.',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * The pipeline definition (pipeline-content.json) for the chosen sources.
 * @param {NotebookInfo[]} catalog  `ctx.sources.catalog`
 * @param {PipelineSettings} settings
 */
export function buildPipeline(catalog, settings) {
  /** @type {any[]} */
  const activities = [];
  for (const nb of pipelineNotebooks(catalog, settings.dataSources, { semanticModel: !!settings.modelId })) {
    if (NOT_LOADS.has(nb.key)) continue;
    if (nb.key === 'vivaConsumption' && settings.coworkDataflowId) activities.push(coworkDataflowActivity(settings));
    activities.push(loadActivity(settings, nb));
  }
  if (settings.coworkDataflowId && !activities.some((a) => a.name === COWORK_WRAPPER_ACTIVITY)) {
    throw new Error('The Cowork credits Dataflow needs the Viva load, which reads what it writes.');
  }
  const names = activities.map((a) => a.name);
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice) throw new Error(`Two notebooks would run as ${twice}. They're two ways to load the same source: deploy one of them.`);

  if (settings.modelId) activities.push(refreshActivity(activities, settings));
  chain(activities);
  const status = !!settings.notebookIds.loadStatus;
  if (status) activities.push(statusActivity(activities, settings));
  applySessionTag(activities);

  /** @type {Record<string, { type: string, defaultValue: unknown }>} */
  const parameters = {};
  if (settings.coworkDataflowId) parameters[SKIP_COWORK_PARAMETER] = { type: 'Boolean', defaultValue: false };
  return {
    $schema: PIPELINE_SCHEMA,
    properties: {
      description: describe(settings, { router: names.includes(UPLOAD_ROUTER_ACTIVITY), status }),
      activities,
      annotations: [],
      parameters,
    },
  };
}

/**
 * Depth-first search, including activities nested in IfCondition branches.
 * @param {any[]} activities
 * @param {string} name
 * @returns {any}
 */
export function findActivity(activities, name) {
  for (const a of activities) {
    if (a.name === name) return a;
    const nested = [...(a.typeProperties?.ifTrueActivities ?? []), ...(a.typeProperties?.ifFalseActivities ?? [])];
    const hit = nested.length ? findActivity(nested, name) : undefined;
    if (hit) return hit;
  }
  return undefined;
}
