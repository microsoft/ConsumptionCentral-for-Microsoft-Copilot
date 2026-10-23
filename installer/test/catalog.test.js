// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appNeeded,
  appWanted,
  ASSET_NOTEBOOKS_DIR,
  DEPLOYED_RUNS,
  MANIFEST_FILE,
  NOTEBOOK_RULES,
  notebooksFor,
  onceNotebooks,
  permissionsFor,
  pipelineNotebooks,
  resolveNotebooks,
  secretWanted,
  USER_READ_ALL,
} from '../src/catalog.js';
import { emptyConfig } from '../src/config.js';
import { appSecretKept, deployedSources, notebookOptions } from '../src/steps/fabric.js';
import { usesSecret } from '../src/steps/notebook-settings.js';
import { DATA_SOURCES, defaultDataSources, routerWanted } from '../src/uploads.js';
import { realSources } from './fakes.js';

/** @typedef {import('../src/uploads.js').DataSourceModes} DataSourceModes */

const { manifest, catalog } = realSources();
/** The defaults, with some sources changed. @param {Partial<DataSourceModes>} [over] @returns {DataSourceModes} */
const ds = (over = {}) => ({ ...defaultDataSources(), ...over });
/** @param {{ key: string }[]} list */
const keys = (list) => list.map((n) => n.key);
/** A copy of installer-assets.json, changed. @param {(m: any) => void} change */
const edited = (change) => {
  const m = structuredClone(manifest);
  change(m);
  return m;
};

/**
 * Every combination of modes the Data sources screen allows.
 * @param {number} [i]
 * @param {Record<string, string>} [acc]
 * @returns {Generator<DataSourceModes>}
 */
function* everyChoice(i = 0, acc = {}) {
  if (i === DATA_SOURCES.length) {
    yield /** @type {DataSourceModes} */ ({ ...acc });
    return;
  }
  for (const mode of DATA_SOURCES[i].modes) yield* everyChoice(i + 1, { ...acc, [DATA_SOURCES[i].id]: mode });
}
const CHOICES = [...everyChoice()];
const EVERY_API = ds({ coworkCredits: 'api', studioCredits: 'api', github: 'api', azureAi: 'api', orgData: 'api', commercialTerms: 'api' });

test('installer-assets.json joins with the rules: the router first, the loads in manifest order, then the refresh and the status record', () => {
  assert.deepEqual(keys(catalog), [
    'uploadRouter',
    'azureAi',
    'studioConsumption',
    'vivaConsumption',
    'github',
    'githubApi',
    'commercialTerms',
    'org',
    'orgGraph',
    'refreshModel',
    'loadStatus',
  ]);
  assert.deepEqual(resolveNotebooks(manifest), catalog);
  const deployable = manifest.notebooks.filter((/** @type {any} */ n) => DEPLOYED_RUNS.includes(n.run)).map((/** @type {any} */ n) => n.key);
  assert.deepEqual(keys(catalog.filter((n) => !n.asset)), deployable);
  // Ingest_Org reads viva_credits_weekly, so the org loads come after the Viva load.
  const order = keys(catalog);
  for (const key of ['org', 'orgGraph']) assert.ok(order.indexOf(key) > order.indexOf('vivaConsumption'), key);
});

test('each notebook is its manifest entry with its rule; the helpers ship with the installer', () => {
  /** @param {import('../src/catalog.js').NotebookInfo} nb */
  const fields = ({ displayName, path, credentials, run, values, expressionNames, patchFinds, secret, reads, writes, landing, loadSummary, exclusiveGroup }) => ({
    displayName,
    path,
    credentials,
    run,
    values,
    expressionNames,
    patchFinds,
    secret,
    reads,
    writes,
    landing,
    loadSummary,
    exclusiveGroup,
  });
  for (const nb of catalog.filter((n) => !n.asset)) {
    const m = manifest.notebooks.find((/** @type {any} */ x) => x.key === nb.key);
    assert.deepEqual(
      fields(nb),
      {
        displayName: m.name,
        path: m.path,
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
      },
      nb.key,
    );
  }
  assert.deepEqual(keys(catalog.filter((n) => n.asset)), ['uploadRouter', 'refreshModel', 'loadStatus']);
  for (const nb of catalog.filter((n) => n.asset)) {
    assert.match(nb.displayName, /^ConsumptionCentral_/);
    assert.deepEqual(fields(nb), {
      displayName: nb.displayName,
      path: `${ASSET_NOTEBOOKS_DIR}/${nb.displayName}.ipynb`,
      credentials: false,
      run: 'pipeline',
      values: [],
      expressionNames: Object.keys(nb.expressions ?? {}),
      patchFinds: [],
      secret: null,
      reads: [],
      writes: [],
      landing: null,
      loadSummary: null,
      exclusiveGroup: null,
    });
  }
  // GitHub from CSV or the API, never both: they share a pipeline activity.
  assert.deepEqual(keys(catalog.filter((n) => n.exclusiveGroup === 'github')), ['github', 'githubApi']);
  // The pipeline passes these, so prepareNotebook tags the cell holding them.
  assert.deepEqual(Object.fromEntries(catalog.filter((n) => n.parameters.length).map((n) => [n.key, n.parameters])), {
    refreshModel: ['WORKSPACE_ID', 'SEMANTIC_MODEL_ID', 'TIMEOUT_MINUTES'],
    loadStatus: ['PIPELINE_RUN_ID', 'PIPELINE_TRIGGER_TIME'],
  });
  assert.deepEqual(keys(catalog.filter((n) => n.semanticModel)), ['refreshModel']);
  // The prices are the model's parameters, so Commercial terms leaves them out of its table.
  const terms = /** @type {import('../src/catalog.js').NotebookInfo} */ (catalog.find((n) => n.key === 'commercialTerms'));
  assert.deepEqual(terms.expressions, { PREPAID_CREDIT_RATE: 'None', PREPAID_CREDIT_BALANCE: 'None', GITHUB_BUSINESS_SEAT: 'None', GITHUB_ENTERPRISE_SEAT: 'None' });
  for (const name of Object.keys(terms.expressions ?? {})) assert.ok(terms.expressionNames.includes(name), name);
});

test('resolveNotebooks throws when installer-assets.json and the rules disagree', () => {
  assert.throws(() => resolveNotebooks(edited((m) => (m.version = 2))), { message: `${MANIFEST_FILE}: version 2 isn't one this installer reads (1).` });
  // A notebook the pipeline runs, or the installer runs once, needs a rule.
  for (const run of DEPLOYED_RUNS) {
    assert.throws(
      () => resolveNotebooks(edited((m) => m.notebooks.push({ key: 'contosoUsage', name: 'Ingest_Contoso_Usage', path: 'contoso.ipynb', run }))),
      { message: `${MANIFEST_FILE} lists notebooks the installer has no rule for: contosoUsage. Add them to NOTEBOOK_RULES in installer/src/catalog.js.` },
      run,
    );
  }
  // A rule needs its entry, and one the installer can deploy.
  assert.throws(() => resolveNotebooks(edited((m) => (m.notebooks = m.notebooks.filter((/** @type {any} */ n) => n.key !== 'orgGraph')))), {
    message: `${MANIFEST_FILE} has no notebook "orgGraph".`,
  });
  assert.throws(() => resolveNotebooks(edited((m) => (m.notebooks.find((/** @type {any} */ n) => n.key === 'github').run = 'interactive'))), {
    message: `${MANIFEST_FILE}: "github" has run "interactive", which the installer can't deploy.`,
  });
});

test('an interactive notebook is never deployed', () => {
  const interactive = manifest.notebooks.filter((/** @type {any} */ n) => n.run === 'interactive');
  assert.deepEqual(interactive.map((/** @type {any} */ n) => n.key), ['studioConsumptionLegacy']);
  for (const n of interactive) {
    assert.ok(!NOTEBOOK_RULES.some((r) => r.key === n.key), n.key);
    assert.ok(!catalog.some((nb) => nb.key === n.key || nb.displayName === n.name), n.key);
  }
  // One with no rule is left out rather than refused.
  const more = edited((m) => m.notebooks.push({ key: 'contosoSignIn', name: 'Ingest_Contoso_SignIn', path: 'contoso.ipynb', run: 'interactive' }));
  assert.deepEqual(keys(resolveNotebooks(more)), keys(catalog));
  assert.ok(catalog.every((n) => DEPLOYED_RUNS.includes(n.run)));
});

test('notebooksFor deploys each notebook for the modes in the design table, for every choice', () => {
  /** @type {Record<string, (d: DataSourceModes, semanticModel: boolean) => boolean>} */
  const deployedWhen = {
    uploadRouter: (d) => routerWanted(d),
    azureAi: (d) => d.azureAi === 'api',
    studioConsumption: (d) => d.studioCredits !== 'skip',
    vivaConsumption: () => true,
    github: (d) => d.github === 'csv',
    githubApi: (d) => d.github === 'api',
    commercialTerms: (d) => d.commercialTerms === 'api',
    org: (d) => d.orgData === 'csv',
    orgGraph: (d) => d.orgData === 'api',
    // Only with the semantic model: there's nothing to refresh without one.
    refreshModel: (_, semanticModel) => semanticModel,
    loadStatus: () => true,
  };
  assert.deepEqual(Object.keys(deployedWhen).sort(), keys(catalog).sort());
  assert.equal(CHOICES.length, DATA_SOURCES.reduce((n, s) => n * s.modes.length, 1));
  for (const choice of CHOICES) {
    for (const semanticModel of [false, true]) {
      const want = keys(catalog.filter((nb) => deployedWhen[nb.key](choice, semanticModel)));
      assert.deepEqual(keys(notebooksFor(catalog, choice, { semanticModel })), want, JSON.stringify({ ...choice, semanticModel }));
    }
  }
});

test('notebooksFor: the defaults, every API, and Cowork task exports alone', () => {
  assert.deepEqual(keys(notebooksFor(catalog, ds())), ['uploadRouter', 'studioConsumption', 'vivaConsumption', 'loadStatus']);
  assert.deepEqual(keys(notebooksFor(catalog, ds(), { semanticModel: true })), ['uploadRouter', 'studioConsumption', 'vivaConsumption', 'refreshModel', 'loadStatus']);
  assert.deepEqual(keys(notebooksFor(catalog, EVERY_API, { semanticModel: true })), [
    'uploadRouter',
    'azureAi',
    'studioConsumption',
    'vivaConsumption',
    'githubApi',
    'commercialTerms',
    'orgGraph',
    'refreshModel',
    'loadStatus',
  ]);
  assert.deepEqual(keys(notebooksFor(catalog, ds({ github: 'csv', orgData: 'csv' }))), ['uploadRouter', 'studioConsumption', 'vivaConsumption', 'github', 'org', 'loadStatus']);
  // The installer lands Cowork task exports itself, so they alone need no router. The Viva load always runs.
  const tasksOnly = ds({ coworkCredits: 'skip', studioCredits: 'skip', coworkTasks: 'csv' });
  assert.deepEqual(keys(notebooksFor(catalog, tasksOnly)), ['vivaConsumption', 'loadStatus']);
  const nothing = /** @type {DataSourceModes} */ (Object.fromEntries(DATA_SOURCES.map((s) => [s.id, 'skip'])));
  assert.deepEqual(keys(notebooksFor(catalog, nothing)), ['vivaConsumption', 'loadStatus']);
});

test('the pipeline runs every deployed notebook but Commercial terms, which the installer runs once', () => {
  assert.deepEqual(keys(pipelineNotebooks(catalog, EVERY_API, { semanticModel: true })), [
    'uploadRouter',
    'azureAi',
    'studioConsumption',
    'vivaConsumption',
    'githubApi',
    'orgGraph',
    'refreshModel',
    'loadStatus',
  ]);
  assert.deepEqual(keys(pipelineNotebooks(catalog, ds())), ['uploadRouter', 'studioConsumption', 'vivaConsumption', 'loadStatus']);
  assert.deepEqual(keys(onceNotebooks(catalog, EVERY_API)), ['commercialTerms']);
  assert.deepEqual(keys(onceNotebooks(catalog, ds())), []);
  for (const choice of CHOICES) {
    const deployed = keys(notebooksFor(catalog, choice, { semanticModel: true }));
    const piped = keys(pipelineNotebooks(catalog, choice, { semanticModel: true }));
    const once = keys(onceNotebooks(catalog, choice));
    assert.deepEqual(once, choice.commercialTerms === 'api' ? ['commercialTerms'] : [], JSON.stringify(choice));
    assert.deepEqual(piped, deployed.filter((k) => !once.includes(k)), JSON.stringify(choice));
  }
});

test('the app registration is wanted only for Studio, Azure AI or org data from their APIs', () => {
  const defaults = ds();
  assert.equal(appWanted(defaults), false, 'the defaults need no app');
  assert.equal(secretWanted(defaults), false);
  assert.deepEqual(permissionsFor(defaults), []);
  for (const choice of CHOICES) {
    const app = choice.studioCredits === 'api' || choice.azureAi === 'api' || choice.orgData === 'api';
    const label = JSON.stringify(choice);
    assert.equal(appWanted(choice), app, label);
    // The GitHub token is kept like the client secret.
    assert.equal(secretWanted(choice), app || choice.github === 'api', label);
    assert.deepEqual(permissionsFor(choice), choice.studioCredits === 'api' || choice.orgData === 'api' ? [USER_READ_ALL] : [], label);
  }
  // The Cowork Dataflow signs in as a person, Commercial terms runs as the installer's user, and GitHub takes a token.
  for (const over of /** @type {Partial<DataSourceModes>[]} */ ([{ coworkCredits: 'api' }, { commercialTerms: 'api' }, { github: 'api' }, { coworkTasks: 'csv' }])) {
    assert.equal(appWanted(ds(over)), false, JSON.stringify(over));
  }
  assert.equal(USER_READ_ALL, 'User.Read.All');
});

test('the app is needed for those sources, or for the semantic model\'s connection', () => {
  assert.equal(appNeeded({ dataSources: ds(), semanticModel: { enabled: false } }), false);
  // Before the Power BI choice is made, the model counts as on, as the plan's default and the setup page have it.
  assert.equal(appNeeded({ dataSources: ds(), semanticModel: {} }), true);
  assert.equal(appNeeded({ dataSources: ds() }), true);
  for (const over of /** @type {Partial<DataSourceModes>[]} */ ([{ studioCredits: 'api' }, { azureAi: 'api' }, { orgData: 'api' }])) {
    assert.equal(appNeeded({ dataSources: ds(over), semanticModel: { enabled: false } }), true, JSON.stringify(over));
  }
  // The model reads the Lakehouse through a connection that signs in as the app, so the default
  // install (the model and reports on) has one, with no Key Vault and no admin consent. The design
  // says the defaults need no app; src counts the model's connection.
  assert.equal(appNeeded({ dataSources: ds(), semanticModel: { enabled: true } }), true);
  assert.equal(secretWanted(ds()), false);
  assert.deepEqual(permissionsFor(ds()), []);
});

test('the app keeps a secret of its own exactly when a deployed notebook reads it, or Key Vault holds it for the sources', () => {
  for (const choice of CHOICES) {
    for (const access of [false, true]) {
      const config = emptyConfig();
      config.dataSources = choice;
      config.consumption.azureSubscriptionId = 'sub-1';
      config.consumption.azureAccess = access;
      const label = JSON.stringify({ ...choice, access });
      config.keyVault.mode = 'notebook';
      const reading = notebooksFor(catalog, deployedSources(config), notebookOptions(config)).some((nb) => usesSecret(config, nb));
      assert.equal(appSecretKept(config), reading, label);
      config.keyVault.mode = 'keyvault';
      assert.equal(appSecretKept(config), appWanted(choice), label);
    }
  }
});
