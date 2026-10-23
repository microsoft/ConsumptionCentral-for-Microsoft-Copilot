// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError } from '../src/http.js';
import {
  classifyFailure,
  conditionMet,
  failedCards,
  fillRerun,
  LOAD_LABELS,
  loadCards,
  loadLabel,
  loadWarnings,
  REASONS,
  RERUN,
  statusConfigJson,
  STATUS_TABLES,
  WARNINGS,
} from '../src/loads.js';
import { ensureSparkSettings } from '../src/steps/fabric.js';
import { notebookSettings } from '../src/steps/notebook-settings.js';
import { BUSY_RETRIES, BUSY_WAIT_MS, dependencyOrder, evaluate, rerunFailed, rerunSteps, runParameters } from '../src/steps/rerun.js';
import {
  ACTIVITY_LABELS,
  buildPipeline,
  COWORK_DATAFLOW_ACTIVITY,
  COWORK_WRAPPER_ACTIVITY,
  REFRESH_ACTIVITY,
  SKIP_COWORK_PARAMETER,
  STATUS_ACTIVITY,
} from '../src/transform/pipeline.js';
import { createUi } from '../src/ui.js';
import { defaultDataSources } from '../src/uploads.js';
import { fakeCtx, fakeFabric, fakeUi, realSources } from './fakes.js';

/** @typedef {import('../src/uploads.js').DataSourceModes} DataSourceModes */
/** @typedef {import('../src/catalog.js').NotebookKey} NotebookKey */

const { catalog } = realSources();
const WS = 'ws-1';
/** An ID for every notebook in the catalog. */
const ids = /** @type {Partial<Record<NotebookKey, string>>} */ (Object.fromEntries(catalog.map((nb) => [nb.key, `nb-${nb.key}`])));
/** Every source on, from its API. */
const ALL_API = /** @type {Partial<DataSourceModes>} */ ({ coworkCredits: 'api', studioCredits: 'api', github: 'api', azureAi: 'api', orgData: 'api', commercialTerms: 'api' });

/**
 * The pipeline for the default sources with some changed, refreshing the model.
 * @param {Partial<DataSourceModes>} [more]
 * @param {Partial<import('../src/transform/pipeline.js').PipelineSettings>} [settings]
 */
const build = (more = {}, settings = {}) =>
  buildPipeline(catalog, { workspaceId: WS, notebookIds: ids, dataSources: { ...defaultDataSources(), ...more }, modelId: 'model-1', ...settings });
/** Every source from its API, with the model and the Cowork Dataflow. */
const everything = () => build(ALL_API, { coworkDataflowId: 'df-1' });

const ROUTER = 'Run_Upload_Router';
const AZURE = 'Run_Consumption_Azure_AI';
const STUDIO = 'Run_Consumption_Studio';
const VIVA = 'Run_Consumption_Viva';
const GITHUB = 'Run_Consumption_GitHub';
const ORG = 'Run_Org_Data';

/** Every activity, nested ones included. @param {any[]} activities @returns {any[]} */
const all = (activities) =>
  activities.flatMap((a) => [a, ...all([...(a.typeProperties?.ifTrueActivities ?? []), ...(a.typeProperties?.ifFalseActivities ?? [])])]);

/**
 * The last attempt of each activity, as activityRuns returns them: every step succeeded but these.
 * 'absent': it never started.
 * @param {any[]} activities
 * @param {Record<string, string | [string, any]>} [changed]
 */
function runsOf(activities, changed = {}) {
  /** @type {Map<string, any>} */
  const runs = new Map();
  for (const a of all(activities)) {
    const s = changed[a.name] ?? 'Succeeded';
    if (s === 'absent') continue;
    const [status, error] = Array.isArray(s) ? s : [s, undefined];
    runs.set(a.name, { activityName: a.name, activityType: a.type, status, error, attempts: 1 });
  }
  return runs;
}

const BUSY = { errorCode: 'RequestExecutionFailed', message: 'Failed to create Livy session. Error: [TooManyRequestsForCapacity] You have hit a spark compute limit.' };

/* ---------- Labels and the status notebook ---------- */

test('labels: every step gets the plain name the pipeline gives it', () => {
  assert.equal(LOAD_LABELS, ACTIVITY_LABELS);
  for (const a of all(everything().properties.activities)) {
    // The If shows as the Dataflow refresh inside it, so it needs no name of its own.
    if (a.name === COWORK_WRAPPER_ACTIVITY) continue;
    assert.ok(ACTIVITY_LABELS[a.name], a.name);
    assert.equal(loadLabel(a.name), ACTIVITY_LABELS[a.name]);
  }
  assert.equal(loadLabel(VIVA), 'Cowork and Work IQ credits');
  assert.equal(loadLabel(COWORK_DATAFLOW_ACTIVITY), 'Cowork credits (Viva Insights Dataflow)');
  assert.equal(loadLabel(REFRESH_ACTIVITY), 'Semantic model refresh');
  assert.equal(loadLabel('Run_Partner_Usage'), 'Partner Usage', 'a step it has no name for reads from its activity name');
  assert.equal(loadLabel('Run_PartnerUsage'), 'Partner Usage');
});

test('the status notebook gets the labels, reasons and warnings, without the fixes', () => {
  const nb = catalog.find((n) => n.key === 'loadStatus');
  assert.ok(nb);
  assert.equal(nb.run, 'pipeline');
  assert.deepEqual(nb.parameters, ['PIPELINE_RUN_ID', 'PIPELINE_TRIGGER_TIME']);
  const { ctx } = fakeCtx({ fabric: fakeFabric().api });
  assert.equal(notebookSettings(ctx, nb).values?.STATUS_JSON, statusConfigJson());
  const json = JSON.parse(statusConfigJson());
  assert.deepEqual(json.labels, ACTIVITY_LABELS);
  assert.equal(json.reasons.length, REASONS.length);
  assert.ok(json.reasons.every((/** @type {any} */ r) => r.kind && r.pattern && r.text && !('fix' in r)));
  assert.ok(json.warnings.every((/** @type {any} */ w) => w.kind && w.text && !('fix' in w)));
});

test('nothing is left of the Analytics Hub loads: no status tables and no Agent 365 step', () => {
  assert.deepEqual(STATUS_TABLES, []);
  const json = statusConfigJson();
  assert.deepEqual(JSON.parse(json).statusTables, []);
  assert.doesNotMatch(json, /agent ?365|audit log|licensed users|resource graph/i);
  assert.doesNotMatch(JSON.stringify([REASONS, WARNINGS]), /agent ?365|PERMISSIONS\.md/i);
  for (const a of all(everything().properties.activities)) assert.doesNotMatch(a.name, /Agent365|Audit|Licensed|Resource_Graph/i);
});

/* ---------- Cards ---------- */

test('classifyFailure names the usual reasons in plain words', () => {
  assert.equal(classifyFailure({ errorCode: '430', message: 'x' }).kind, 'capacity');
  assert.equal(classifyFailure(BUSY).kind, 'capacity');
  assert.equal(classifyFailure({ message: 'AADSTS7000215: Invalid client secret' }).kind, 'signIn');
  assert.equal(classifyFailure({ errorCode: '2011', message: 'Forbidden' }).kind, 'signIn');
  assert.equal(classifyFailure({ message: 'The activity timed out' }).kind, 'timeout');
  const lag = classifyFailure({ errorCode: '2011', message: "RuntimeError: The refresh ended as Failed. Table 'viva_credits_weekly' is not in database" }, REFRESH_ACTIVITY);
  assert.equal(lag.kind, 'notSynced');
  assert.ok(lag.fix.includes(RERUN));
  const missing = classifyFailure({ message: 'AnalysisException: [PATH_NOT_FOUND] Path does not exist: Files/landing/studio' }, STUDIO);
  assert.equal(missing.kind, 'noData');
  assert.match(missing.fix, /Upload the export on the Data sources screen, or set the source to Skip/);
  const other = classifyFailure({ message: 'KeyError: tenant\n  at line 3' });
  assert.equal(other.kind, 'other');
  assert.equal(other.text, 'It stopped with an error: KeyError: tenant');
  assert.equal(classifyFailure(null).text, 'It stopped without saying why.');
  assert.ok(other.fix.includes(RERUN));
});

test('conditionMet follows Fabric dependency rules', () => {
  assert.equal(conditionMet('Succeeded', ['Succeeded']), true);
  assert.equal(conditionMet('Failed', ['Succeeded']), false);
  assert.equal(conditionMet('Failed', ['Completed']), true);
  assert.equal(conditionMet(undefined, ['Completed']), false);
  assert.equal(conditionMet(undefined, ['Completed', 'Skipped']), true);
  assert.equal(conditionMet('TimedOut', ['Failed']), true);
});

test('loadCards: one card per source in pipeline order, a failed load with why, and the refresh that waited for it as skipped', () => {
  const acts = everything().properties.activities;
  const runs = runsOf(acts, { [STUDIO]: ['Failed', BUSY], [REFRESH_ACTIVITY]: 'absent', [STATUS_ACTIVITY]: 'Failed' });
  const cards = loadCards(runs, acts);
  assert.deepEqual(cards.map((c) => c.activity), [ROUTER, AZURE, STUDIO, COWORK_DATAFLOW_ACTIVITY, VIVA, GITHUB, ORG, REFRESH_ACTIVITY]);
  const by = Object.fromEntries(cards.map((c) => [c.activity, c]));
  assert.equal(by[STUDIO].name, 'Copilot Studio credits');
  assert.equal(by[STUDIO].state, 'failed');
  assert.equal(by[STUDIO].kind, 'capacity');
  assert.equal(by[COWORK_DATAFLOW_ACTIVITY].state, 'ok', 'the Dataflow shows, not the If around it');
  assert.equal(by[VIVA].state, 'ok', 'each load waits only for the one before it to finish');
  assert.equal(by[REFRESH_ACTIVITY].state, 'skipped');
  assert.equal(by[REFRESH_ACTIVITY].reason, "It didn't run, because it waits for: Copilot Studio credits.");
  assert.deepEqual(by[REFRESH_ACTIVITY].fix, [`It runs again once those succeed: ${RERUN}.`]);
  assert.deepEqual(failedCards(cards).map((c) => c.activity), [STUDIO]);
});

test('loadCards: without the definition only what ran shows, and never an If step', () => {
  const acts = everything().properties.activities;
  const cards = loadCards(runsOf(acts, { [STUDIO]: 'absent', [REFRESH_ACTIVITY]: 'absent' }));
  assert.deepEqual(cards.map((c) => c.activity), [ROUTER, AZURE, COWORK_DATAFLOW_ACTIVITY, VIVA, GITHUB, ORG]);
  assert.ok(cards.every((c) => c.state === 'ok'));
  assert.deepEqual(loadCards(null), []);
});

test('fillRerun capitalises the instruction at the start of a sentence', () => {
  assert.equal(fillRerun(`${RERUN}. Or wait.`, 'run "x rerun-failed"'), 'Run "x rerun-failed". Or wait.');
  assert.equal(fillRerun(`Fix it. ${RERUN}.`, 'run it'), 'Fix it. Run it.');
  assert.equal(fillRerun(`Fix it, then ${RERUN}.`, 'run it'), 'Fix it, then run it.');
});

/* ---------- Rerun ---------- */

test('evaluate reads the expressions the pipeline uses', () => {
  const p = { [SKIP_COWORK_PARAMETER]: false, Mode: 'Backfill', Days: 90 };
  assert.equal(evaluate(`@not(pipeline().parameters.${SKIP_COWORK_PARAMETER})`, p), true);
  assert.equal(evaluate('@pipeline().parameters.SkipCowork', p), false);
  assert.equal(evaluate("@equals(pipeline().parameters.Mode, 'backfill')", p), true);
  assert.equal(evaluate("@if(equals(pipeline().parameters.Mode,'incremental'), 1, pipeline().parameters.Days)", p), 90);
  assert.equal(evaluate('@and(true, not(false))', p), true);
  assert.equal(evaluate('@or(false, false)', p), false);
  assert.equal(evaluate("@string('it''s')", p), "it's");
  assert.throws(() => evaluate('@pipeline().RunId', p), /can't fill in pipeline\(\)\.RunId/);
  assert.throws(() => evaluate('@pipeline().parameters.Nope', p), /no parameter Nope/);
  assert.throws(() => evaluate('@concat(1)', p), /can't evaluate concat/);
});

test("a rerun can fill in every expression in the pipeline but the status step's, which it never runs", () => {
  const doc = everything();
  const params = runParameters(doc);
  /** @type {string[]} */
  const found = [];
  for (const a of all(doc.properties.activities)) {
    const values = [a.typeProperties?.expression, ...Object.values(a.typeProperties?.parameters ?? {}).map((/** @type {any} */ p) => p.value)];
    for (const v of values) {
      const text = v?.type === 'Expression' ? String(v.value) : typeof v === 'string' && v.startsWith('@') ? v : undefined;
      if (!text) continue;
      found.push(text);
      if (a.name === STATUS_ACTIVITY) assert.throws(() => evaluate(text, params), /can't fill in pipeline\(\)\./);
      else assert.doesNotThrow(() => evaluate(text, params), `${a.name}: ${text}`);
    }
  }
  assert.deepEqual(found, [`@not(pipeline().parameters.${SKIP_COWORK_PARAMETER})`, '@pipeline().RunId', '@string(pipeline().TriggerTime)']);
});

test('dependencyOrder puts each step after what it waits for', () => {
  const order = dependencyOrder([
    { name: 'c', dependsOn: [{ activity: 'b' }] },
    { name: 'b', dependsOn: [{ activity: 'a' }] },
    { name: 'a' },
  ]).map((a) => a.name);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('rerunSteps reruns the failed load and the model refresh that waited for it, but not what worked', async () => {
  const doc = everything();
  const acts = doc.properties.activities;
  const runs = runsOf(acts, { [STUDIO]: ['Failed', BUSY], [REFRESH_ACTIVITY]: 'absent', [STATUS_ACTIVITY]: 'Failed' });
  /** @type {string[]} */
  const ran = [];
  /** @type {Record<string, any>} */
  const given = {};
  const result = await rerunSteps(acts, runs, runParameters(doc), async (a, parameters) => {
    ran.push(a.name);
    given[a.name] = parameters;
    return { status: 'Succeeded' };
  });
  assert.deepEqual(ran, [STUDIO, REFRESH_ACTIVITY]);
  assert.deepEqual(result.reran, ran);
  assert.deepEqual(given[STUDIO], {}, 'the loads take no parameters');
  assert.deepEqual(given[REFRESH_ACTIVITY], {
    WORKSPACE_ID: { value: WS, type: 'string' },
    SEMANTIC_MODEL_ID: { value: 'model-1', type: 'string' },
    TIMEOUT_MINUTES: { value: 170, type: 'int' },
  });
  assert.equal(result.runs.get(STUDIO).status, 'Succeeded');
  assert.equal(result.runs.get(STATUS_ACTIVITY).status, 'Failed', 'the status record is left as the run had it');
});

test("rerunSteps: a load that fails again doesn't hold up the next one, but the refresh waits for every usage load", async () => {
  const doc = build(ALL_API);
  const acts = doc.properties.activities;
  const runs = runsOf(acts, { [STUDIO]: ['Failed', BUSY], [VIVA]: ['Failed', { message: 'boom' }], [REFRESH_ACTIVITY]: 'absent' });
  /** @type {string[]} */
  const ran = [];
  const result = await rerunSteps(acts, runs, runParameters(doc), async (a) => {
    ran.push(a.name);
    return a.name === STUDIO ? { status: 'Failed', error: BUSY } : { status: 'Succeeded' };
  });
  assert.deepEqual(ran, [STUDIO, VIVA]);
  assert.equal(result.runs.get(STUDIO).status, 'Failed');
  assert.equal(result.runs.get(VIVA).status, 'Succeeded');
  assert.equal(result.runs.get(REFRESH_ACTIVITY).status, 'Skipped');
});

test('runParameters: a rerun takes the pipeline defaults, so it refreshes the Cowork Dataflow even if the first load left it out', () => {
  assert.deepEqual(runParameters(everything()), { [SKIP_COWORK_PARAMETER]: false });
  assert.deepEqual(runParameters(build()), {});
  assert.deepEqual(runParameters(undefined), {});
});

/** One activity run, as Fabric's queryActivityRuns returns it. */
const activityRun = (/** @type {string} */ activityName, status = 'Succeeded', /** @type {any} */ error = undefined) => ({
  activityName,
  activityType: 'TridentNotebook',
  status,
  activityRunStart: '2026-06-01T02:00:00Z',
  error,
});

/** A workspace whose latest pipeline run didn't load the Copilot Studio credits, so the model wasn't refreshed. */
function failedRun() {
  const fabric = fakeFabric();
  const ui = fakeUi();
  const { ctx, config, sleeps } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  const pipe = fabric.add('DataPipeline', 'ConsumptionCentral_Pipeline', build());
  config.fabric.pipelineId = pipe.id;
  config.semanticModel = { ...config.semanticModel, enabled: true, id: 'model-1', bound: true };
  fabric.jobList.push({ id: 'j-1', status: 'Failed', startTimeUtc: '2026-06-01T02:00:00', endTimeUtc: '2026-06-01T03:00:00' });
  fabric.activityRuns['j-1'] = [
    activityRun(ROUTER),
    activityRun(STUDIO, 'Failed', BUSY),
    activityRun(VIVA),
    activityRun(STATUS_ACTIVITY, 'Failed', { message: '1 load(s) failed: Copilot Studio credits. See dbo.load_log for why.' }),
  ];
  // A test that starts more jobs than it planned for fails instead of polling forever.
  const getJob = fabric.api.getJob;
  fabric.api.getJob = async () => {
    if (!fabric.jobs.length) throw new Error('no job status left in the fake');
    return getJob();
  };
  return { fabric, ui, ctx, config, sleeps };
}

test('rerun-failed: a busy capacity is waited out, then the model is refreshed and the first load counts as done', async () => {
  const { fabric, ui, ctx, config, sleeps } = failedRun();
  config.firstRun = { jobId: 'j-1', status: 'Incomplete' };
  // Studio: busy, then loads. The model refresh works first time.
  fabric.jobs.push({ status: 'Failed', failureReason: BUSY }, { status: 'Completed' }, { status: 'Completed' });
  const result = await rerunFailed(ctx);
  assert.deepEqual(result, { reran: [STUDIO, REFRESH_ACTIVITY], failed: [] });
  assert.ok(sleeps.includes(BUSY_WAIT_MS));
  const text = ui.text();
  assert.match(text, /Rerunning what didn't load in the run from 2026-06-01 02:00 UTC/);
  assert.match(text, /Copilot Studio credits: Fabric's capacity is busy\. Trying again in 5 minutes/);
  assert.match(text, /Copilot Studio credits: loaded/);
  assert.match(text, /Semantic model refresh: loaded/);
  assert.match(text, /Now, by source/);
  const runs = fabric.calls.filter((c) => c.startsWith('runJob'));
  assert.equal(runs.length, 3, 'one extra start for the busy retry');
  assert.equal(runs[0], 'runJob RunNotebook {"parameters":{}}');
  assert.match(runs[2], /^runJob RunNotebook .*"SEMANTIC_MODEL_ID":\{"value":"model-1","type":"string"\}/, 'the refresh notebook gets the parameters the pipeline gives it');
  assert.equal(config.firstRun?.status, 'Completed');
});

test('rerun-failed gives up after the busy retries, says so, and leaves the refresh for later', async () => {
  const { fabric, ui, ctx } = failedRun();
  for (let i = 0; i <= BUSY_RETRIES; i++) fabric.jobs.push({ status: 'Failed', failureReason: BUSY });
  const result = await rerunFailed(ctx);
  assert.deepEqual(result, { reran: [STUDIO], failed: [STUDIO] });
  assert.match(ui.text(), /Copilot Studio credits: failed/);
  assert.equal(fabric.calls.filter((c) => c.startsWith('runJob')).length, BUSY_RETRIES + 1);
});

test("rerun-failed doesn't run anything while the pipeline is running", async () => {
  const { fabric, ui, ctx } = failedRun();
  fabric.jobList.push({ id: 'j-2', status: 'InProgress', startTimeUtc: '2026-06-01T11:30:00' });
  assert.deepEqual(await rerunFailed(ctx), { reran: [], failed: [] });
  assert.deepEqual(fabric.calls, []);
  assert.match(ui.text(), /pipeline is running/);
});

test('rerun-failed: nothing to rerun after a run that worked or before the first run, and no pipeline is an error', async () => {
  const { fabric, ui, ctx, config } = failedRun();
  fabric.jobList[0].status = 'Completed';
  fabric.activityRuns['j-1'] = [ROUTER, STUDIO, VIVA, REFRESH_ACTIVITY, STATUS_ACTIVITY].map((name) => activityRun(name));
  assert.deepEqual(await rerunFailed(ctx), { reran: [], failed: [] });
  assert.match(ui.text(), /Nothing to rerun: every load in the latest run worked, or was switched off/);

  fabric.jobList.length = 0;
  assert.deepEqual(await rerunFailed(ctx), { reran: [], failed: [] });
  assert.match(ui.text(), /The pipeline hasn't run yet/);
  assert.deepEqual(fabric.calls, []);

  delete config.fabric.pipelineId;
  await assert.rejects(rerunFailed(ctx), /There is no pipeline yet\. Run the installer first\./);
});

/* ---------- Shared Spark session ---------- */

test('ensureSparkSettings turns on high concurrency for pipelines once', async () => {
  const fabric = fakeFabric();
  const ui = fakeUi();
  const { ctx } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  await ensureSparkSettings(ctx);
  assert.deepEqual(fabric.calls, ['updateSparkSettings {"highConcurrency":{"notebookPipelineRunEnabled":true}}']);
  assert.equal(fabric.spark.highConcurrency.notebookInteractiveRunEnabled, true, 'other settings are left alone');
  await ensureSparkSettings(ctx);
  assert.equal(fabric.calls.length, 1, 'already on');
  assert.match(ui.text(), /share one Spark session/);
});

test('ensureSparkSettings only warns when it may not change the setting', async () => {
  const fabric = fakeFabric();
  fabric.failures.updateSparkSettings = [new HttpError('Forbidden', { status: 403, method: 'PATCH', url: '/spark/settings' })];
  const ui = fakeUi();
  const { ctx } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  await ensureSparkSettings(ctx);
  assert.match(ui.text(), /needs the workspace Admin role/);
  assert.match(ui.text(), /High concurrency/);
});

/* ---------- Warnings from the status notebook ---------- */

const WARNED = { warnings: { [AZURE]: { kind: 'forbidden', reason: "It ran, but wasn't allowed to read 1 of the 2 pay-as-you-go subscriptions." } } };

test("loadWarnings: reads the status notebook's exit value, or its error when a load failed, and nothing else", () => {
  assert.deepEqual(loadWarnings({ status: 'Succeeded', output: { result: { exitValue: JSON.stringify(WARNED) } } }), WARNED.warnings);
  const failed = { status: 'Failed', error: { message: `1 load(s) failed: Copilot Studio credits. See dbo.load_log for why.\nload_warnings=${JSON.stringify(WARNED)}` } };
  assert.deepEqual(loadWarnings(failed), WARNED.warnings);
  assert.deepEqual(loadWarnings({ status: 'Failed', error: { message: '1 load(s) failed.' } }), {});
  assert.deepEqual(loadWarnings({ output: { result: { exitValue: 'not json' } } }), {});
  assert.deepEqual(loadWarnings(undefined), {});
});

test('loadCards: a load the status notebook flagged is a warning with its reason and fix; a failed one stays failed', () => {
  const acts = build(ALL_API).properties.activities;
  const runs = runsOf(acts);
  runs.get(STATUS_ACTIVITY).output = { result: { exitValue: JSON.stringify(WARNED) } };
  const cards = loadCards(runs, acts);
  const azure = cards.find((c) => c.activity === AZURE);
  assert.equal(azure?.state, 'warning');
  assert.equal(azure?.kind, 'forbidden');
  assert.match(azure?.reason ?? '', /pay-as-you-go subscriptions/);
  assert.match(azure?.fix[0] ?? '', /Data sources and exports/);
  assert.equal(cards.find((c) => c.activity === STUDIO)?.state, 'ok');
  assert.deepEqual(failedCards(cards), [], 'a warning is not a failure, so rerun-failed leaves it alone');

  const failedRuns = runsOf(acts, { [AZURE]: ['Failed', { message: 'boom' }] });
  failedRuns.get(STATUS_ACTIVITY).output = { result: { exitValue: JSON.stringify(WARNED) } };
  assert.equal(loadCards(failedRuns, acts).find((c) => c.activity === AZURE)?.state, 'failed');
});

test('terminal: a warning shows amber, with its reason', () => {
  /** @type {string[]} */
  const out = [];
  createUi({ write: (s) => out.push(s) }).loads([
    { activity: AZURE, name: 'Azure AI spend', state: 'warning', reason: "It ran, but wasn't allowed to read 1 of the 2 pay-as-you-go subscriptions.", fix: ['Give it the role.'] },
  ]);
  const text = out.join('');
  assert.match(text, /! Azure AI spend: loaded with a warning/);
  assert.match(text, /wasn't allowed to read 1 of the 2 pay-as-you-go subscriptions/);
});

test('warnings: every kind has a plain text and a fix, and the notebook gets them', () => {
  const json = JSON.parse(statusConfigJson());
  assert.deepEqual(json.statusTables, STATUS_TABLES);
  assert.deepEqual(json.warnings.map((/** @type {any} */ w) => w.kind), ['forbidden', 'unlicensed', 'other', 'empty']);
  assert.deepEqual(json.warnings.map((/** @type {any} */ w) => w.all), [false, false, false, true]);
  for (const w of WARNINGS) assert.ok(w.text.includes('{items}') && w.fix, w.kind);
});
