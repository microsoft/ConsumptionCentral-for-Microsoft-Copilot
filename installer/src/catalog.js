// @ts-check
/**
 * The installer's rules for each notebook. What the notebooks are (names, paths, the settings they
 * take, the tables they read and write) comes from the dashboard's installer-assets.json, which
 * CONTRIBUTING.md makes the one list to update: resolveNotebooks() joins the two by `key` and
 * throws on any mismatch.
 */
import { ITEM_PREFIX } from './product.js';
import { routerWanted } from './uploads.js';

/** Microsoft Graph's application ID. Same in every tenant. */
export const GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';
export const USER_READ_ALL = 'User.Read.All';

/** The dashboard's list of what the installer deploys, at the repo root. */
export const MANIFEST_FILE = 'installer-assets.json';
/** Helper notebooks that ship with the installer, under installer/. */
export const ASSET_NOTEBOOKS_DIR = 'assets/notebooks';

/**
 * @typedef {'vivaConsumption' | 'studioConsumption' | 'azureAi' | 'github' | 'githubApi' | 'commercialTerms'
 *   | 'org' | 'orgGraph' | 'uploadRouter' | 'refreshModel' | 'loadStatus'} NotebookKey
 */

/** @typedef {import('./uploads.js').DataSourceModes} DataSourceModes */

/**
 * A text change to a notebook's code: `find` must occur exactly once.
 * @typedef {{ find: string, replace: string }} NotebookPatch
 */

/**
 * The installer's side of one notebook.
 * @typedef {object} NotebookRule
 * @property {NotebookKey} key
 * @property {(ds: DataSourceModes) => boolean} when  Deployed for these choices.
 * @property {{ file: string, displayName: string, at: 'first' | 'last' }} [asset]  Ships with the installer rather
 *   than the dashboard. `at`: where it runs relative to the dashboard's notebooks.
 * @property {string[]} [parameters]  Assignments the pipeline overrides; prepareNotebook tags the cell holding
 *   them `parameters`. The dashboard's notebooks take none: a pipeline run passes them no parameters, so
 *   their shipped defaults are safe as they stand.
 * @property {Record<string, string>} [expressions]  Python expressions the installer's copy always has.
 * @property {boolean} [semanticModel]  Only deployed with the semantic model.
 */

/**
 * The dashboard's notebooks run in installer-assets.json's order (CONTRIBUTING.md: "in the order a pipeline
 * should run them"; Ingest_Org reads viva_credits_weekly, so it comes after the Viva load). The router runs
 * before them, the refresh and the status record after.
 * @type {NotebookRule[]}
 */
export const NOTEBOOK_RULES = [
  {
    key: 'uploadRouter',
    when: routerWanted,
    asset: { file: `${ITEM_PREFIX}Upload_Router.ipynb`, displayName: `${ITEM_PREFIX}Upload_Router`, at: 'first' },
  },
  { key: 'azureAi', when: (ds) => ds.azureAi === 'api' },
  { key: 'studioConsumption', when: (ds) => ds.studioCredits !== 'skip' },
  // Always: it writes the Viva tables the model reads, empty until the first export or Dataflow run.
  { key: 'vivaConsumption', when: () => true },
  { key: 'github', when: (ds) => ds.github === 'csv' },
  { key: 'githubApi', when: (ds) => ds.github === 'api' },
  {
    key: 'commercialTerms',
    when: (ds) => ds.commercialTerms === 'api',
    // The model's TermOrDefault takes a commercial_terms column over its parameter. The installer sets
    // these prices as parameters, so the table carries only the derived credit_rate, and changing a price
    // needs no notebook run.
    expressions: { PREPAID_CREDIT_RATE: 'None', PREPAID_CREDIT_BALANCE: 'None', GITHUB_BUSINESS_SEAT: 'None', GITHUB_ENTERPRISE_SEAT: 'None' },
  },
  { key: 'org', when: (ds) => ds.orgData === 'csv' },
  { key: 'orgGraph', when: (ds) => ds.orgData === 'api' },
  {
    key: 'refreshModel',
    when: () => true,
    semanticModel: true,
    asset: { file: `${ITEM_PREFIX}Refresh_Model.ipynb`, displayName: `${ITEM_PREFIX}Refresh_Model`, at: 'last' },
    // The pipeline sets these, so prepareNotebook tags their cell.
    parameters: ['WORKSPACE_ID', 'SEMANTIC_MODEL_ID', 'TIMEOUT_MINUTES'],
  },
  {
    key: 'loadStatus',
    when: () => true,
    asset: { file: `${ITEM_PREFIX}Load_Status.ipynb`, displayName: `${ITEM_PREFIX}Load_Status`, at: 'last' },
    parameters: ['PIPELINE_RUN_ID', 'PIPELINE_TRIGGER_TIME'],
  },
];

/**
 * installer-assets.json's `run` values the installer deploys. `interactive` notebooks need a person
 * signed in (Ingest_Studio_Consumption), so the installer leaves them for the manual setup.
 */
export const DEPLOYED_RUNS = /** @type {const} */ (['pipeline', 'once']);

/**
 * One notebook as the installer deploys it: its rule joined with its installer-assets.json entry.
 * @typedef {object} NotebookInfo
 * @property {NotebookKey} key
 * @property {string} displayName  Item name in the Fabric workspace (the manifest's `name`, or the asset's).
 * @property {string} path  Under the source folder, or under installer/ for an asset.
 * @property {boolean} asset
 * @property {boolean} credentials  The installer sets TENANT_ID, CLIENT_ID and CLIENT_SECRET.
 * @property {'pipeline' | 'once'} run  `once`: the installer runs it after deploying, not the pipeline.
 * @property {string[]} values  Names the installer may write as Python strings.
 * @property {string[]} expressionNames  Names the installer may write as raw Python.
 * @property {string[]} patchFinds  Text the installer may replace.
 * @property {{ kind: 'clientSecret' | 'githubPat', name: string | null } | null} secret
 * @property {string[]} reads
 * @property {string[]} writes
 * @property {string | null} landing
 * @property {string | null} loadSummary
 * @property {string | null} exclusiveGroup
 * @property {string[]} parameters
 * @property {Record<string, string>} [expressions]
 * @property {boolean} semanticModel  Only deployed with the semantic model.
 * @property {(ds: DataSourceModes) => boolean} when
 */

/**
 * Joins the rules with the manifest. Throws when they disagree, so a renamed or added notebook fails
 * a desk test rather than a deployment.
 * @param {any} manifest  installer-assets.json
 * @returns {NotebookInfo[]} In pipeline order.
 */
export function resolveNotebooks(manifest) {
  if (manifest?.version !== 1) throw new Error(`${MANIFEST_FILE}: version ${manifest?.version} isn't one this installer reads (1).`);
  /** @type {Map<string, any>} */
  const byKey = new Map((manifest.notebooks ?? []).map((/** @type {any} */ n) => [n.key, n]));
  const known = new Set(NOTEBOOK_RULES.map((r) => r.key));
  const unknown = [...byKey.values()].filter((n) => DEPLOYED_RUNS.includes(n.run) && !known.has(n.key)).map((n) => n.key);
  if (unknown.length) throw new Error(`${MANIFEST_FILE} lists notebooks the installer has no rule for: ${unknown.join(', ')}. Add them to NOTEBOOK_RULES in installer/src/catalog.js.`);
  const order = [...byKey.keys()];
  const rank = (/** @type {NotebookRule} */ r) => (r.asset?.at === 'first' ? -1 : r.asset?.at === 'last' ? order.length : order.indexOf(r.key));
  // A stable sort, so the two `last` helpers keep their rule order (refresh, then status).
  return [...NOTEBOOK_RULES].sort((a, b) => rank(a) - rank(b)).map((rule) => {
    if (rule.asset) {
      return {
        key: rule.key,
        displayName: rule.asset.displayName,
        path: `${ASSET_NOTEBOOKS_DIR}/${rule.asset.file}`,
        asset: true,
        credentials: false,
        run: 'pipeline',
        values: [],
        expressionNames: Object.keys(rule.expressions ?? {}),
        patchFinds: [],
        secret: null,
        reads: [],
        writes: [],
        landing: null,
        loadSummary: null,
        exclusiveGroup: null,
        parameters: rule.parameters ?? [],
        expressions: rule.expressions,
        semanticModel: !!rule.semanticModel,
        when: rule.when,
      };
    }
    const m = byKey.get(rule.key);
    if (!m) throw new Error(`${MANIFEST_FILE} has no notebook "${rule.key}".`);
    if (!DEPLOYED_RUNS.includes(m.run)) throw new Error(`${MANIFEST_FILE}: "${rule.key}" has run "${m.run}", which the installer can't deploy.`);
    return {
      key: rule.key,
      displayName: m.name,
      path: m.path,
      asset: false,
      credentials: !!m.credentials,
      run: m.run,
      values: m.values ?? [],
      expressionNames: m.expressions ?? [],
      patchFinds: m.patches ?? [],
      secret: m.secret ?? null,
      reads: m.reads ?? [],
      writes: m.writes ?? [],
      landing: m.landing ?? null,
      loadSummary: m.loadSummary ?? null,
      exclusiveGroup: m.exclusiveGroup ?? null,
      parameters: rule.parameters ?? [],
      expressions: rule.expressions,
      semanticModel: !!rule.semanticModel,
      when: rule.when,
    };
  });
}

/**
 * @typedef {object} NotebookOptions
 * @property {boolean} [semanticModel]  The semantic model is deployed, so its refresh notebook is too.
 */

/**
 * Notebooks to deploy for the chosen sources, in pipeline order.
 * @param {NotebookInfo[]} catalog  `ctx.sources.catalog`
 * @param {DataSourceModes} ds
 * @param {NotebookOptions} [opts]
 */
export const notebooksFor = (catalog, ds, opts = {}) => catalog.filter((nb) => nb.when(ds) && (!nb.semanticModel || !!opts.semanticModel));

/** Notebooks the pipeline runs. */
export const pipelineNotebooks = (/** @type {NotebookInfo[]} */ catalog, /** @type {DataSourceModes} */ ds, /** @type {NotebookOptions} */ opts = {}) =>
  notebooksFor(catalog, ds, opts).filter((nb) => nb.run === 'pipeline');

/** Notebooks the installer runs once after deploying (Ingest_CommercialTerms). */
export const onceNotebooks = (/** @type {NotebookInfo[]} */ catalog, /** @type {DataSourceModes} */ ds) =>
  notebooksFor(catalog, ds).filter((nb) => nb.run === 'once');

/**
 * Whether the chosen sources sign in as the app registration, so the notebooks need its client secret.
 * The defaults (Cowork and Studio credits from CSV exports) don't.
 * - Studio from the licensing API: Ingest_Studio looks up user UPNs through Graph.
 * - Azure AI: Ingest_Azure_AI reads Cost Management and Monitor as the app.
 * - Org data from Entra: Ingest_Org_Graph reads users through Graph.
 * @param {DataSourceModes} ds
 */
export const appWanted = (ds) => ds.studioCredits === 'api' || ds.azureAi === 'api' || ds.orgData === 'api';

/**
 * Whether the install needs the app registration at all: for the sources above, or for the semantic
 * model, whose connection to the Lakehouse signs in as the app. The model's secret lives only in that
 * connection, so on its own it needs no Key Vault, no Graph permissions and no admin consent.
 * A model not yet chosen counts as on, as the plan's default and the setup page have it.
 * @param {{ dataSources: DataSourceModes, semanticModel?: { enabled?: boolean } }} config
 */
export const appNeeded = (config) => appWanted(config.dataSources) || config.semanticModel?.enabled !== false;

/**
 * Whether a secret has to be kept (in Key Vault, or in the notebooks if the user chose that): the app's
 * client secret, or the GitHub token.
 * @param {DataSourceModes} ds
 */
export const secretWanted = (ds) => appWanted(ds) || ds.github === 'api';

/**
 * Graph application permissions the app registration needs (admin consent), sorted.
 * @param {DataSourceModes} ds
 * @returns {string[]}
 */
export const permissionsFor = (ds) => (ds.studioCredits === 'api' || ds.orgData === 'api' ? [USER_READ_ALL] : []);
