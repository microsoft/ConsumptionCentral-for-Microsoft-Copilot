// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onceNotebooks, pipelineNotebooks } from '../src/catalog.js';
import { emptyConfig } from '../src/config.js';
import { SESSION_TAG } from '../src/product.js';
import { ensureNotebooks, ensurePipeline, PIPELINE_NAME, pipelineSettings, pipelineSignature } from '../src/steps/fabric.js';
import {
  ACTIVITIES,
  ACTIVITY_LABELS,
  activityRule,
  applySessionTag,
  buildPipeline,
  chain,
  COWORK_DATAFLOW_ACTIVITY,
  COWORK_WRAPPER_ACTIVITY,
  findActivity,
  GITHUB_ACTIVITY,
  PIPELINE_CHANGE,
  PIPELINE_SCHEMA,
  PIPELINE_VERSION,
  REFRESH_ACTIVITY,
  REFRESH_TIMING,
  RETRY_INTERVAL_SECONDS,
  retryPolicy,
  SKIP_COWORK_PARAMETER,
  STATUS_ACTIVITY,
  UPLOAD_ROUTER_ACTIVITY,
  VIVA_ACTIVITY,
} from '../src/transform/pipeline.js';
import { defaultDataSources } from '../src/uploads.js';
import { fakeCtx, fakeFabric, fakeUi, realSources } from './fakes.js';

/** @typedef {import('../src/uploads.js').DataSourceModes} DataSourceModes */
/** @typedef {import('../src/catalog.js').NotebookKey} NotebookKey */

const { catalog } = realSources();
const WS = 'f0000000-0000-0000-0000-000000000000';
/** An ID for every notebook in the catalog. */
const ids = /** @type {Partial<Record<NotebookKey, string>>} */ (Object.fromEntries(catalog.map((nb) => [nb.key, `nb-${nb.key}`])));
/** Every source on, from its API. */
const ALL_API = /** @type {Partial<DataSourceModes>} */ ({ coworkCredits: 'api', studioCredits: 'api', github: 'api', azureAi: 'api', orgData: 'api', commercialTerms: 'api' });

/** The default sources, with some changed. @param {Partial<DataSourceModes>} [more] @returns {DataSourceModes} */
const sources = (more = {}) => ({ ...defaultDataSources(), ...more });
/**
 * @param {Partial<DataSourceModes>} [more]
 * @param {Partial<import('../src/transform/pipeline.js').PipelineSettings>} [settings]
 */
const build = (more = {}, settings = {}) => buildPipeline(catalog, { workspaceId: WS, notebookIds: ids, dataSources: sources(more), ...settings });
/** Everything on: every source from its API, the model and the Cowork Dataflow. */
const everything = () => build(ALL_API, { modelId: 'model-1', coworkDataflowId: 'df-1' });

/** @param {any} doc @returns {string[]} */
const names = (doc) => doc.properties.activities.map((/** @type {any} */ a) => a.name);
/** Each top-level step's waits, as "activity:conditions". @param {any} doc @returns {Record<string, string[]>} */
const deps = (doc) =>
  Object.fromEntries(
    doc.properties.activities.map((/** @type {any} */ a) => [a.name, a.dependsOn.map((/** @type {any} */ d) => `${d.activity}:${d.dependencyConditions.join('|')}`)]),
  );
/** Every activity, nested ones included. @param {any[]} activities @returns {any[]} */
const all = (activities) =>
  activities.flatMap((a) => [a, ...all([...(a.typeProperties?.ifTrueActivities ?? []), ...(a.typeProperties?.ifFalseActivities ?? [])])]);
/** The catalog with only these notebooks, deployed whatever the sources. @param {(nb: import('../src/catalog.js').NotebookInfo) => boolean} keep */
const only = (keep) => catalog.filter(keep).map((nb) => ({ ...nb, when: () => true }));

/* ---------- The chain ---------- */

test('everything on: one chain in catalog order, each step waiting for the one before it to finish', () => {
  const doc = everything();
  assert.deepEqual(names(doc), [
    'Run_Upload_Router',
    'Run_Consumption_Azure_AI',
    'Run_Consumption_Studio',
    'Conditionally_Refresh_Cowork_Credits',
    'Run_Consumption_Viva',
    'Run_Consumption_GitHub',
    'Run_Org_Data',
    'Refresh_Consumption_Model',
    'Record_Load_Status',
  ]);
  assert.deepEqual(deps(doc), {
    Run_Upload_Router: [],
    Run_Consumption_Azure_AI: ['Run_Upload_Router:Completed'],
    Run_Consumption_Studio: ['Run_Consumption_Azure_AI:Completed'],
    Conditionally_Refresh_Cowork_Credits: ['Run_Consumption_Studio:Completed'],
    Run_Consumption_Viva: ['Conditionally_Refresh_Cowork_Credits:Completed'],
    Run_Consumption_GitHub: ['Run_Consumption_Viva:Completed'],
    Run_Org_Data: ['Run_Consumption_GitHub:Completed'],
    [REFRESH_ACTIVITY]: [
      'Run_Consumption_Azure_AI:Succeeded',
      'Run_Consumption_Studio:Succeeded',
      'Run_Consumption_Viva:Succeeded',
      'Run_Consumption_GitHub:Succeeded',
      'Run_Org_Data:Completed',
    ],
    [STATUS_ACTIVITY]: [`${REFRESH_ACTIVITY}:Completed|Skipped`],
  });
  assert.equal(UPLOAD_ROUTER_ACTIVITY, 'Run_Upload_Router');
  assert.equal(VIVA_ACTIVITY, 'Run_Consumption_Viva');
  assert.equal(GITHUB_ACTIVITY, 'Run_Consumption_GitHub');
});

test('the defaults: the router, Studio and Viva, then the status record', () => {
  const doc = build();
  assert.deepEqual(names(doc), ['Run_Upload_Router', 'Run_Consumption_Studio', 'Run_Consumption_Viva', 'Record_Load_Status']);
  assert.deepEqual(deps(doc), {
    Run_Upload_Router: [],
    Run_Consumption_Studio: ['Run_Upload_Router:Completed'],
    Run_Consumption_Viva: ['Run_Consumption_Studio:Completed'],
    Record_Load_Status: ['Run_Consumption_Viva:Completed|Skipped'],
  });
});

test('a source that is switched off is skipped over', () => {
  assert.deepEqual(deps(build({ studioCredits: 'skip', coworkCredits: 'skip' })), {
    Run_Consumption_Viva: [],
    Record_Load_Status: ['Run_Consumption_Viva:Completed|Skipped'],
  });
  assert.deepEqual(deps(build({ azureAi: 'api', studioCredits: 'skip' })), {
    Run_Upload_Router: [],
    Run_Consumption_Azure_AI: ['Run_Upload_Router:Completed'],
    Run_Consumption_Viva: ['Run_Consumption_Azure_AI:Completed'],
    Record_Load_Status: ['Run_Consumption_Viva:Completed|Skipped'],
  });
  assert.deepEqual(names(build({ github: 'csv', orgData: 'csv' })), [
    'Run_Upload_Router',
    'Run_Consumption_Studio',
    'Run_Consumption_Viva',
    'Run_Consumption_GitHub',
    'Run_Org_Data',
    'Record_Load_Status',
  ]);
});

test("each load runs its deployed notebook, says what it does and names the tables it writes", () => {
  const acts = everything().properties.activities;
  for (const nb of pipelineNotebooks(catalog, sources(ALL_API), { semanticModel: true })) {
    if (nb.key === 'refreshModel' || nb.key === 'loadStatus') continue;
    const a = findActivity(acts, activityRule(nb.key).name);
    assert.equal(a.type, 'TridentNotebook', nb.key);
    assert.deepEqual(a.typeProperties, { notebookId: ids[nb.key], workspaceId: WS, parameters: {}, sessionTag: SESSION_TAG }, nb.key);
  }
  const viva = findActivity(acts, VIVA_ACTIVITY);
  assert.equal(viva.description, `${ACTIVITIES.vivaConsumption?.does} Writes viva_credits_weekly, viva_spending_policy and cowork_tasks_weekly.`);
  assert.equal(findActivity(build({ orgData: 'csv' }).properties.activities, 'Run_Org_Data').description, `${ACTIVITIES.org?.does} Writes org_attributes.`);
  assert.equal(findActivity(acts, UPLOAD_ROUTER_ACTIVITY).description, ACTIVITIES.uploadRouter?.does, 'the router writes no tables');
});

test("a source's CSV and API notebooks run under one name, so its load history carries on", () => {
  assert.equal(ACTIVITIES.github?.name, ACTIVITIES.githubApi?.name);
  assert.equal(ACTIVITIES.org?.name, ACTIVITIES.orgGraph?.name);
  const step = (/** @type {Partial<DataSourceModes>} */ more, /** @type {string} */ name) => findActivity(build(more).properties.activities, name);
  assert.equal(step({ github: 'csv' }, GITHUB_ACTIVITY).typeProperties.notebookId, ids.github);
  assert.equal(step({ github: 'api' }, GITHUB_ACTIVITY).typeProperties.notebookId, ids.githubApi);
  assert.equal(step({ orgData: 'csv' }, 'Run_Org_Data').typeProperties.notebookId, ids.org);
  const graph = step({ orgData: 'api' }, 'Run_Org_Data');
  assert.equal(graph.typeProperties.notebookId, ids.orgGraph);
  assert.equal(graph.policy.timeout, '0.01:00:00', 'Entra ID gets the time a large tenant needs');
});

test('two deployed notebooks that would run under one name are an error', () => {
  assert.throws(
    () => buildPipeline(only((nb) => nb.key === 'github' || nb.key === 'githubApi'), { workspaceId: WS, notebookIds: ids, dataSources: sources() }),
    { message: "Two notebooks would run as Run_Consumption_GitHub. They're two ways to load the same source: deploy one of them." },
  );
  assert.throws(
    () => buildPipeline(only((nb) => nb.key === 'org' || nb.key === 'orgGraph'), { workspaceId: WS, notebookIds: ids, dataSources: sources() }),
    /Two notebooks would run as Run_Org_Data\./,
  );
});

test('a notebook with no pipeline step, or one not deployed, is an error', () => {
  assert.throws(() => activityRule('commercialTerms'), {
    message: 'No pipeline step for the "commercialTerms" notebook. Add it to ACTIVITIES in installer/src/transform/pipeline.js.',
  });
  const asLoad = catalog.filter((nb) => nb.key === 'commercialTerms').map((nb) => ({ ...nb, run: /** @type {const} */ ('pipeline') }));
  assert.throws(() => buildPipeline(asLoad, { workspaceId: WS, notebookIds: ids, dataSources: sources({ commercialTerms: 'api' }) }), /No pipeline step for the "commercialTerms" notebook/);

  const { studioConsumption: _, ...noStudio } = ids;
  assert.throws(() => build({}, { notebookIds: noStudio }), { message: 'The Ingest_Studio notebook has not been deployed.' });
  const { refreshModel: __, ...noRefresh } = ids;
  assert.throws(() => build({}, { notebookIds: noRefresh, modelId: 'model-1' }), { message: 'The semantic model refresh notebook has not been deployed.' });
});

test('chain: each step waits for the one before it; the refresh keeps its own waits, and a step after it also runs when it is skipped', () => {
  const steps = [
    { name: 'A', dependsOn: [{ activity: 'X', dependencyConditions: ['Succeeded'] }] },
    { name: REFRESH_ACTIVITY, dependsOn: [{ activity: 'A', dependencyConditions: ['Succeeded'] }] },
    { name: 'B', dependsOn: [] },
  ];
  chain(steps);
  assert.deepEqual(steps.map((s) => s.dependsOn), [
    [],
    [{ activity: 'A', dependencyConditions: ['Succeeded'] }],
    [{ activity: REFRESH_ACTIVITY, dependencyConditions: ['Completed', 'Skipped'] }],
  ]);
});

/**
 * Two top-level activities neither of which waits, even indirectly, for the other, so both could run at once.
 * @param {any} doc
 * @returns {string[] | undefined}
 */
function twoAtOnce(doc) {
  /** @type {Map<string, string[]>} */
  const parents = new Map(doc.properties.activities.map((/** @type {any} */ a) => [a.name, a.dependsOn.map((/** @type {any} */ d) => d.activity)]));
  /** @type {Map<string, Set<string>>} */
  const seen = new Map();
  /** @param {string} name @returns {Set<string>} */
  const upstream = (name) => {
    if (!seen.has(name)) seen.set(name, new Set((parents.get(name) ?? []).flatMap((p) => [p, ...upstream(p)])));
    return /** @type {Set<string>} */ (seen.get(name));
  };
  const steps = [...parents.keys()];
  for (const [i, a] of steps.entries()) {
    const b = steps.slice(i + 1).find((n) => !upstream(a).has(n) && !upstream(n).has(a));
    if (b) return [a, b];
  }
  return undefined;
}

/** Every choice of sources, from their modes in DATA_SOURCES. @returns {DataSourceModes[]} */
function everyChoice() {
  /** @type {Record<string, string[]>} */
  const modes = { coworkCredits: ['api', 'csv', 'skip'], studioCredits: ['api', 'csv', 'skip'], github: ['api', 'csv', 'skip'], azureAi: ['api', 'skip'], orgData: ['api', 'csv', 'skip'], commercialTerms: ['api', 'skip'] };
  /** @type {DataSourceModes[]} */
  let out = [defaultDataSources()];
  for (const [id, list] of Object.entries(modes)) out = out.flatMap((ds) => list.map((m) => /** @type {DataSourceModes} */ ({ ...ds, [id]: m })));
  return out;
}

test('whichever sources are on: one step at a time, every notebook in one session, and the status record last', () => {
  const choices = everyChoice();
  assert.equal(choices.length, 324);
  for (const dataSources of choices) {
    for (const extra of [{}, { modelId: 'model-1' }, { coworkDataflowId: 'df-1' }, { modelId: 'model-1', coworkDataflowId: 'df-1' }]) {
      const doc = buildPipeline(catalog, { workspaceId: WS, notebookIds: ids, dataSources, ...extra });
      const label = JSON.stringify({ dataSources, ...extra });
      const acts = doc.properties.activities;
      assert.equal(twoAtOnce(doc), undefined, label);
      assert.equal(acts.at(-1).name, STATUS_ACTIVITY, label);
      assert.equal(!!findActivity(acts, REFRESH_ACTIVITY), 'modelId' in extra, label);
      assert.equal(!!findActivity(acts, COWORK_WRAPPER_ACTIVITY), 'coworkDataflowId' in extra, label);
      for (const a of all(acts)) {
        if (a.type === 'TridentNotebook') assert.equal(a.typeProperties.sessionTag, SESSION_TAG, `${a.name} ${label}`);
        // The If Condition shows as the Dataflow refresh it runs.
        if (a.name !== COWORK_WRAPPER_ACTIVITY) assert.ok(ACTIVITY_LABELS[a.name], `${a.name} has a plain label`);
      }
      assert.ok(!JSON.stringify(doc).includes(/** @type {string} */ (ids.commercialTerms)), `commercial terms run once, not in the pipeline: ${label}`);
    }
  }
});

/* ---------- The Cowork credits Dataflow ---------- */

test('the Cowork credits Dataflow refreshes just before the Viva load, inside a switch the first load can turn off', () => {
  const doc = build({ coworkCredits: 'api' }, { coworkDataflowId: 'df-1' });
  assert.deepEqual(names(doc), ['Run_Upload_Router', 'Run_Consumption_Studio', COWORK_WRAPPER_ACTIVITY, VIVA_ACTIVITY, STATUS_ACTIVITY]);
  const wrapper = findActivity(doc.properties.activities, COWORK_WRAPPER_ACTIVITY);
  assert.equal(wrapper.type, 'IfCondition');
  assert.equal(wrapper.description, 'Refreshes the Cowork credits Dataflow unless SkipCowork is true. Scheduled runs keep the default, false.');
  assert.deepEqual(wrapper.typeProperties.expression, { value: '@not(pipeline().parameters.SkipCowork)', type: 'Expression' });
  assert.deepEqual(wrapper.typeProperties.ifFalseActivities, []);
  const refresh = findActivity(doc.properties.activities, COWORK_DATAFLOW_ACTIVITY);
  assert.deepEqual(wrapper.typeProperties.ifTrueActivities, [refresh]);
  assert.equal(refresh.type, 'RefreshDataflow');
  assert.deepEqual(refresh.dependsOn, []);
  assert.deepEqual(refresh.typeProperties, { workspaceId: WS, dataflowId: 'df-1', notifyOption: 'NoNotification', dataflowType: 'DataflowFabric' });
  assert.deepEqual(refresh.policy, { timeout: '0.02:00:00', retry: 0, retryIntervalInSeconds: 30, secureOutput: false, secureInput: false });
  assert.equal(SKIP_COWORK_PARAMETER, 'SkipCowork');
  assert.deepEqual(doc.properties.parameters, { SkipCowork: { type: 'Boolean', defaultValue: false } }, 'scheduled runs refresh it');

  const plain = build({ coworkCredits: 'api' });
  assert.equal(findActivity(plain.properties.activities, COWORK_WRAPPER_ACTIVITY), undefined);
  assert.equal(findActivity(plain.properties.activities, COWORK_DATAFLOW_ACTIVITY), undefined);
  assert.deepEqual(plain.properties.parameters, {});
});

test('the Dataflow step and SkipCowork come only with Cowork credits from the API and a Dataflow made for them', () => {
  const config = emptyConfig();
  config.fabric.workspaceId = WS;
  config.fabric.notebooks = { ...ids };
  config.consumption.dataflowId = 'df-1';
  /** @param {'api' | 'csv' | 'skip'} mode */
  const withCowork = (mode) => {
    config.dataSources.coworkCredits = mode;
    return buildPipeline(catalog, pipelineSettings(config));
  };
  for (const mode of /** @type {const} */ (['csv', 'skip'])) {
    const doc = withCowork(mode);
    assert.equal(findActivity(doc.properties.activities, COWORK_WRAPPER_ACTIVITY), undefined, mode);
    assert.deepEqual(doc.properties.parameters, {}, mode);
  }
  const api = withCowork('api');
  assert.equal(findActivity(api.properties.activities, COWORK_DATAFLOW_ACTIVITY).typeProperties.dataflowId, 'df-1');
  assert.deepEqual(Object.keys(api.properties.parameters), [SKIP_COWORK_PARAMETER]);
  delete config.consumption.dataflowId;
  const none = withCowork('api');
  assert.equal(findActivity(none.properties.activities, COWORK_WRAPPER_ACTIVITY), undefined, 'no Dataflow made yet');
  assert.deepEqual(none.properties.parameters, {});
});

test('a Cowork Dataflow with no Viva load to read what it writes is an error', () => {
  assert.throws(
    () => buildPipeline(only((nb) => nb.key === 'studioConsumption'), { workspaceId: WS, notebookIds: ids, dataSources: sources(), coworkDataflowId: 'df-1' }),
    { message: 'The Cowork credits Dataflow needs the Viva load, which reads what it writes.' },
  );
});

/* ---------- The model refresh ---------- */

test('the model refresh waits for every usage load to succeed and for org data to have had its turn, and gets its settings', () => {
  const refresh = findActivity(everything().properties.activities, REFRESH_ACTIVITY);
  assert.equal(refresh.type, 'TridentNotebook');
  assert.equal(refresh.typeProperties.notebookId, ids.refreshModel);
  assert.equal(refresh.typeProperties.workspaceId, WS);
  // The design lists WRITE_MODE 'merge' and CHECK_AUDIT_STATE false too. CC's refresh notebook takes
  // neither (CC has no audit log or processor), so the pipeline passes only these.
  assert.deepEqual(refresh.typeProperties.parameters, {
    WORKSPACE_ID: { value: WS, type: 'string' },
    SEMANTIC_MODEL_ID: { value: 'model-1', type: 'string' },
    TIMEOUT_MINUTES: { value: REFRESH_TIMING.minutes, type: 'int' },
  });
  assert.equal(REFRESH_TIMING.minutes, 170);
  assert.deepEqual(refresh.policy, { timeout: '0.03:00:00', retry: 0, retryIntervalInSeconds: 60, secureOutput: false, secureInput: false });
  assert.equal(refresh.typeProperties.sessionTag, SESSION_TAG);

  assert.deepEqual(deps(build({}, { modelId: 'model-1' }))[REFRESH_ACTIVITY], ['Run_Consumption_Studio:Succeeded', 'Run_Consumption_Viva:Succeeded'], "it doesn't wait for the router");
  assert.deepEqual(deps(build({ orgData: 'csv' }, { modelId: 'model-1', coworkDataflowId: 'df-1' }))[REFRESH_ACTIVITY], [
    'Run_Consumption_Studio:Succeeded',
    'Run_Consumption_Viva:Succeeded',
    'Run_Org_Data:Completed',
  ], 'nor for the Cowork Dataflow, whose table the Viva load reads');
});

test('with no model there is no refresh step', () => {
  const doc = build(ALL_API, { coworkDataflowId: 'df-1' });
  assert.equal(findActivity(doc.properties.activities, REFRESH_ACTIVITY), undefined);
  assert.deepEqual(deps(doc)[STATUS_ACTIVITY], ['Run_Org_Data:Completed|Skipped']);
  assert.doesNotMatch(doc.properties.description, /semantic model/);
});

/* ---------- The status record ---------- */

test('the status record runs last, after every step nothing else waits for, whatever happened to them', () => {
  for (const doc of [everything(), build(), build({ github: 'csv' }, { modelId: 'model-1' })]) {
    const acts = doc.properties.activities;
    const status = findActivity(acts, STATUS_ACTIVITY);
    assert.equal(acts.at(-1), status);
    const others = acts.filter((/** @type {any} */ a) => a.name !== STATUS_ACTIVITY);
    const leaves = others.filter((/** @type {any} */ a) => !others.some((/** @type {any} */ b) => b.dependsOn?.some((/** @type {any} */ d) => d.activity === a.name)));
    assert.ok(leaves.length >= 1);
    assert.deepEqual(status.dependsOn, leaves.map((/** @type {any} */ a) => ({ activity: a.name, dependencyConditions: ['Completed', 'Skipped'] })));
  }
  const status = findActivity(build().properties.activities, STATUS_ACTIVITY);
  assert.equal(status.type, 'TridentNotebook');
  assert.equal(status.typeProperties.notebookId, ids.loadStatus);
  assert.deepEqual(status.typeProperties.parameters, {
    PIPELINE_RUN_ID: { value: { value: '@pipeline().RunId', type: 'Expression' }, type: 'string' },
    PIPELINE_TRIGGER_TIME: { value: { value: '@string(pipeline().TriggerTime)', type: 'Expression' }, type: 'string' },
  });
  assert.deepEqual(status.policy, { timeout: '0.00:20:00', retry: 0, retryIntervalInSeconds: 60, secureOutput: false, secureInput: false });

  const { loadStatus: _, ...without } = ids;
  const old = build({}, { notebookIds: without });
  assert.equal(findActivity(old.properties.activities, STATUS_ACTIVITY), undefined, 'no status notebook, no status step');
  assert.doesNotMatch(old.properties.description, /Record_Load_Status/);
});

/* ---------- Retries and sessions ---------- */

test('retries: every load retries 5 minutes apart; the Dataflow, the refresh and the status record keep their own', () => {
  const acts = everything().properties.activities;
  const policy = (/** @type {string} */ name) => {
    const { retry, retryIntervalInSeconds } = findActivity(acts, name).policy;
    return `${retry}/${retryIntervalInSeconds}`;
  };
  assert.equal(policy('Run_Upload_Router'), '3/300');
  assert.equal(policy('Run_Consumption_Azure_AI'), '2/300', 'an hour-long load');
  assert.equal(policy('Run_Consumption_Studio'), '3/300');
  assert.equal(policy('Run_Consumption_Viva'), '3/300');
  assert.equal(policy('Run_Consumption_GitHub'), '3/300');
  assert.equal(policy('Run_Org_Data'), '2/300', 'Entra ID');
  assert.equal(findActivity(build({ orgData: 'csv' }).properties.activities, 'Run_Org_Data').policy.retry, 3, 'the CSV org load is quick');
  assert.equal(policy(COWORK_DATAFLOW_ACTIVITY), '0/30', 'inside its IfCondition');
  assert.equal(findActivity(acts, COWORK_WRAPPER_ACTIVITY).policy, undefined);
  assert.equal(policy(REFRESH_ACTIVITY), '0/60');
  assert.equal(policy(STATUS_ACTIVITY), '0/60');
  for (const nb of pipelineNotebooks(catalog, sources(ALL_API))) {
    if (nb.key === 'loadStatus') continue;
    const rule = activityRule(nb.key);
    assert.equal(findActivity(acts, rule.name).policy.timeout, rule.timeout, `${rule.name} keeps its timeout`);
  }
  assert.match(everything().properties.description, /retries up to 3 times, 5 minutes apart/);
});

test('retryPolicy: a load that can run for an hour or more retries twice, a shorter one three times', () => {
  const retries = (/** @type {string | undefined} */ timeout) => retryPolicy(timeout).retry;
  assert.equal(retries('0.00:15:00'), 3);
  assert.equal(retries('0.00:59:59'), 3);
  assert.equal(retries('00:30:00'), 3);
  assert.equal(retries('0.01:00:00'), 2);
  assert.equal(retries('1.00:00:00'), 2);
  assert.equal(retries(undefined), 2, 'an unknown timeout counts as long');
  assert.equal(retryPolicy('0.00:15:00').retryIntervalInSeconds, RETRY_INTERVAL_SECONDS);
  assert.equal(RETRY_INTERVAL_SECONDS, 300);
});

test('every notebook shares one Spark session, nested ones too', () => {
  const notebooks = all(everything().properties.activities).filter((a) => a.type === 'TridentNotebook');
  assert.equal(notebooks.length, 8);
  for (const nb of notebooks) assert.equal(nb.typeProperties.sessionTag, SESSION_TAG, nb.name);
  assert.equal(SESSION_TAG, 'consumption_central');
  assert.equal(findActivity(everything().properties.activities, COWORK_DATAFLOW_ACTIVITY).typeProperties.sessionTag, undefined, 'a Dataflow has no Spark session');

  const steps = [
    { name: 'Load', type: 'TridentNotebook', typeProperties: { notebookId: 'a' } },
    {
      name: 'Switch',
      type: 'IfCondition',
      typeProperties: {
        ifTrueActivities: [{ name: 'Inner', type: 'TridentNotebook', typeProperties: { notebookId: 'b' } }],
        ifFalseActivities: [{ name: 'Other', type: 'TridentNotebook', typeProperties: {} }, { name: 'Flow', type: 'RefreshDataflow', typeProperties: {} }],
      },
    },
  ];
  applySessionTag(steps);
  assert.deepEqual(all(steps).filter((a) => a.typeProperties.sessionTag === SESSION_TAG).map((a) => a.name), ['Load', 'Inner', 'Other']);
  assert.equal(findActivity(steps, 'Inner').typeProperties.notebookId, 'b', 'the rest is kept');
  assert.equal(findActivity(steps, 'Nowhere'), undefined);
});

/* ---------- The definition ---------- */

test('the definition: the schema, a description of what this pipeline does, and commercial terms left to run once', () => {
  const doc = everything();
  assert.equal(doc.$schema, PIPELINE_SCHEMA);
  assert.deepEqual(Object.keys(doc.properties), ['description', 'activities', 'annotations', 'parameters']);
  assert.deepEqual(doc.properties.annotations, []);
  assert.equal(PIPELINE_VERSION, 1);

  const text = doc.properties.description;
  assert.match(text, /^Created by the Consumption Central installer\. /);
  assert.match(text, /The loads run one after another rather than all at once/);
  assert.match(text, /high concurrency for pipelines must be on/);
  assert.match(text, /It starts by routing any CSV exports dropped in Files\/consumption_central_uploads/);
  assert.match(text, /The Cowork credits Dataflow refreshes just before the Viva load\. The installer's first load sets SkipCowork=true only when/);
  assert.match(text, /The semantic model refreshes once every usage load has succeeded\./);
  assert.match(text, /Record_Load_Status runs last/);
  assert.match(text, /Run the installer again with "update"/);
  const bare = build({ studioCredits: 'skip', coworkCredits: 'skip' }).properties.description;
  assert.doesNotMatch(bare, /CSV exports|Cowork credits Dataflow|semantic model/);

  assert.equal(ACTIVITIES.commercialTerms, undefined);
  assert.ok(!pipelineNotebooks(catalog, sources(ALL_API), { semanticModel: true }).some((nb) => nb.key === 'commercialTerms'));
  assert.deepEqual(onceNotebooks(catalog, sources(ALL_API)).map((nb) => nb.key), ['commercialTerms']);
});

/* ---------- The deployed pipeline ---------- */

test('pipelineSignature: the notebooks the pipeline runs, then the model and the Cowork Dataflow it refreshes', () => {
  const config = emptyConfig();
  assert.equal(pipelineSignature(config, catalog), 'uploadRouter,studioConsumption,vivaConsumption,loadStatus');

  Object.assign(config.semanticModel, { enabled: true, id: 'model-1' });
  assert.equal(pipelineSignature(config, catalog), 'uploadRouter,studioConsumption,vivaConsumption,loadStatus', 'a model not yet bound to the Lakehouse');
  config.semanticModel.bound = true;
  assert.equal(pipelineSignature(config, catalog), 'uploadRouter,studioConsumption,vivaConsumption,refreshModel,loadStatus;model=model-1');

  config.consumption.dataflowId = 'df-1';
  assert.equal(pipelineSignature(config, catalog), 'uploadRouter,studioConsumption,vivaConsumption,refreshModel,loadStatus;model=model-1', 'Cowork credits from CSV exports');
  config.dataSources.coworkCredits = 'api';
  assert.equal(pipelineSignature(config, catalog), 'uploadRouter,studioConsumption,vivaConsumption,refreshModel,loadStatus;model=model-1;cowork=df-1');

  config.dataSources.azureAi = 'api';
  config.dataSources.commercialTerms = 'api';
  assert.equal(pipelineSignature(config, catalog).split(';')[0], 'uploadRouter,studioConsumption,vivaConsumption,refreshModel,loadStatus', 'Azure AI waits for access; commercial terms run once');
  config.consumption.azureSubscriptionId = 'sub-1';
  config.consumption.azureAccess = true;
  assert.equal(pipelineSignature(config, catalog).split(';')[0], 'uploadRouter,azureAi,studioConsumption,vivaConsumption,refreshModel,loadStatus');
});

test('pipelineSettings: the deployed notebooks and sources, with the model and the Dataflow only once they are in use', () => {
  const config = emptyConfig();
  config.fabric.workspaceId = WS;
  config.fabric.notebooks = { vivaConsumption: 'nb-viva' };
  config.dataSources.azureAi = 'api';
  Object.assign(config.semanticModel, { enabled: true, id: 'model-1' });
  config.consumption.dataflowId = 'df-1';

  const before = pipelineSettings(config);
  assert.equal(before.workspaceId, WS);
  assert.deepEqual(before.notebookIds, { vivaConsumption: 'nb-viva' });
  assert.equal(before.dataSources.azureAi, 'skip', "Azure AI waits until the app can read its subscription");
  assert.equal(config.dataSources.azureAi, 'api', 'the choice is kept');
  assert.equal(before.modelId, undefined, 'the model is not bound yet');
  assert.equal(before.coworkDataflowId, undefined, 'Cowork credits come from CSV exports');

  config.consumption.azureSubscriptionId = 'sub-1';
  config.consumption.azureAccess = true;
  config.semanticModel.bound = true;
  config.dataSources.coworkCredits = 'api';
  const after = pipelineSettings(config);
  assert.deepEqual(after.dataSources, config.dataSources);
  assert.equal(after.modelId, 'model-1');
  assert.equal(after.coworkDataflowId, 'df-1');
});

test('ensurePipeline: created once, left alone on re-run, updated when the sources change', async () => {
  const fabric = fakeFabric();
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  await ensureNotebooks(ctx);
  fabric.calls.length = 0;

  await ensurePipeline(ctx);
  assert.deepEqual(fabric.calls, [`createPipeline ${PIPELINE_NAME}`]);
  assert.equal(PIPELINE_NAME, 'ConsumptionCentral_Pipeline');
  const pipeline = fabric.items.find((i) => i.type === 'DataPipeline');
  assert.equal(config.fabric.pipelineId, pipeline?.id, 'ID found by name when the create returns no body');
  assert.equal(config.fabric.pipelineModules, 'uploadRouter,studioConsumption,vivaConsumption,loadStatus');
  assert.equal(config.fabric.pipelineVersion, PIPELINE_VERSION);
  assert.deepEqual(pipeline?.content, buildPipeline(catalog, pipelineSettings(config)));
  assert.equal(findActivity(pipeline?.content.properties.activities, VIVA_ACTIVITY).typeProperties.notebookId, config.fabric.notebooks.vivaConsumption);
  assert.match(ui.text(), /Created pipeline ConsumptionCentral_Pipeline/);

  fabric.calls.length = 0;
  await ensurePipeline(ctx);
  assert.deepEqual(fabric.calls, []);
  assert.match(ui.text(), /Pipeline ConsumptionCentral_Pipeline is in place/);

  config.dataSources.orgData = 'csv';
  await assert.rejects(ensurePipeline(ctx), { message: 'The Ingest_Org notebook has not been deployed.' });
  assert.deepEqual(fabric.calls, [], 'nothing changes until its notebook is deployed');
  config.dataSources.orgData = 'skip';

  config.dataSources.github = 'csv';
  await ensureNotebooks(ctx);
  fabric.calls.length = 0;
  await ensurePipeline(ctx);
  assert.deepEqual(fabric.calls, [`updatePipeline ${PIPELINE_NAME}`]);
  assert.equal(config.fabric.pipelineModules, 'uploadRouter,studioConsumption,vivaConsumption,github,loadStatus');
  assert.ok(names(pipeline?.content).includes(GITHUB_ACTIVITY));
  assert.match(ui.text(), /replaces the pipeline definition, including any activities you added to it yourself/);
  assert.ok(!ui.text().includes(PIPELINE_CHANGE), 'the version is the same');
});

test('ensurePipeline: rewritten when a deleted notebook comes back with a new ID', async () => {
  const fabric = fakeFabric();
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  await ensureNotebooks(ctx);
  await ensurePipeline(ctx);
  const old = /** @type {string} */ (config.fabric.notebooks.vivaConsumption);
  fabric.items.splice(fabric.items.findIndex((i) => i.id === old), 1);

  await ensureNotebooks(ctx);
  assert.match(ui.text(), /Ingest_Viva_Consumption was deleted\. Deploying it again\./);
  assert.notEqual(config.fabric.notebooks.vivaConsumption, old);
  fabric.calls.length = 0;
  await ensurePipeline(ctx);
  assert.deepEqual(fabric.calls, [`updatePipeline ${PIPELINE_NAME}`]);
  assert.equal(config.fabric.pipelineModules, 'uploadRouter,studioConsumption,vivaConsumption,loadStatus');
  const content = fabric.items.find((i) => i.type === 'DataPipeline')?.content;
  assert.equal(findActivity(content.properties.activities, VIVA_ACTIVITY).typeProperties.notebookId, config.fabric.notebooks.vivaConsumption);
});

test('ensurePipeline: a pipeline someone deleted is created again, without its old schedule', async () => {
  const fabric = fakeFabric();
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  await ensureNotebooks(ctx);
  await ensurePipeline(ctx);
  const old = config.fabric.pipelineId;
  config.fabric.scheduleId = 'schedule-1';
  fabric.items.splice(fabric.items.findIndex((i) => i.id === old), 1);
  fabric.calls.length = 0;

  await ensurePipeline(ctx);
  assert.match(ui.text(), /ConsumptionCentral_Pipeline was deleted\. Creating it again\./);
  assert.deepEqual(fabric.calls, [`createPipeline ${PIPELINE_NAME}`]);
  assert.notEqual(config.fabric.pipelineId, old);
  assert.equal(config.fabric.scheduleId, undefined);
});

test('ensurePipeline: declining an update keeps the old signature, so the next run offers it again', async () => {
  const fabric = fakeFabric();
  const ui = fakeUi({ answers: [false] });
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  await ensureNotebooks(ctx);
  config.fabric.pipelineId = fabric.add('DataPipeline', PIPELINE_NAME, {}).id;
  config.fabric.pipelineName = PIPELINE_NAME;
  config.fabric.pipelineModules = 'studioConsumption,vivaConsumption';
  fabric.calls.length = 0;

  await ensurePipeline(ctx, { force: true });
  assert.deepEqual(ui.asked, [`Update ${PIPELINE_NAME}?`]);
  assert.deepEqual(fabric.calls, []);
  assert.equal(config.fabric.pipelineModules, 'studioConsumption,vivaConsumption');
  assert.equal(config.fabric.pipelineVersion, undefined);
  assert.match(ui.text(), /Left the pipeline as it was\. New or removed sources won't load until it is updated\./);
});

test('ensurePipeline: one an older installer version built is updated, saying what changed', async () => {
  const fabric = fakeFabric();
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  await ensureNotebooks(ctx);
  await ensurePipeline(ctx);
  assert.equal(config.fabric.pipelineVersion, PIPELINE_VERSION);
  assert.ok(!ui.text().includes(PIPELINE_CHANGE), 'a new pipeline needs no explanation');

  delete config.fabric.pipelineVersion;
  fabric.calls.length = 0;
  await ensurePipeline(ctx);
  assert.deepEqual(fabric.calls, [`updatePipeline ${PIPELINE_NAME}`]);
  assert.ok(ui.text().includes(PIPELINE_CHANGE));
  assert.equal(config.fabric.pipelineVersion, PIPELINE_VERSION);

  fabric.calls.length = 0;
  await ensurePipeline(ctx);
  assert.deepEqual(fabric.calls, [], 'nothing to do once it is up to date');
});
