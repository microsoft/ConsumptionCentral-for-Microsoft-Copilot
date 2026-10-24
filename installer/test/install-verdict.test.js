// @ts-check
/**
 * The install's verdict. A step that fails (✗) and lets the install carry on leaves it partly set up; one that only
 * warns, or recovers when it's tried again, doesn't.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, saveConfig } from '../src/config.js';
import { createCtx, install, update } from '../src/install.js';
import { THE_APP } from '../src/managed-app/flow.js';
import { COWORK_DATAFLOW_ACTIVITY } from '../src/transform/pipeline.js';
import { fakeAzureGraph, fakeFabric, fakePowerBi, fakeUi, httpError, realSources } from './fakes.js';

const forbidden = async () => {
  throw new Error('Forbidden');
};

/** The org data load. The model refresh runs whether or not it loads, so the first load still completes. */
const ORG_DATA = 'Run_Org_Data';
/** A load the source turned away. */
const refused = { status: 'Failed', error: { errorCode: '403', message: 'Forbidden' } };
/** A load Fabric didn't start because the capacity was busy. */
const turnedAway = { status: 'Failed', error: { errorCode: 'TooManyRequestsForCapacity', message: 'The capacity is too busy.' } };
/** How the Cowork Dataflow's refresh fails until someone signs in to its connections. */
const unsigned = { status: 'Failed', error: { errorCode: 'JobInstanceFailed', message: 'Job instance failed without detail error' } };

/**
 * @typedef {object} Run
 * @property {boolean} [report]  Publishing the report fails.
 * @property {'works' | 'fails'} [upload]  An org data file to upload, and how its upload goes.
 * @property {boolean} [noDropFolder]  The drop folder can't be made.
 * @property {Error} [query]  The data check's query fails with this.
 * @property {boolean} [cowork]  Cowork credits come from the Dataflow, which the install makes. Fabric lists its
 *   connections, so the first load refreshes it too.
 * @property {Record<string, { status: string, error?: object }[]>} [loads]  Loads that don't simply succeed: each one's
 *   attempts in the pipeline run, in order. The run itself completes.
 * @property {boolean} [app]  The installer has a build of the app, and a managed apps CLI that records each call.
 */

/**
 * A new Fabric install, run to the end through the real install record, waiting on the first load.
 * @param {import('node:test').TestContext} t
 * @param {Run} [o]
 */
async function runInstall(t, o = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-verdict-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'consumption-central-setup.json');
  const config = loadConfig(file).config;
  config.target = 'fabric';
  config.tenantId = 'tenant-1';
  Object.assign(config.fabric, { workspaceId: 'ws-1', workspaceName: 'Analytics', lakehouseId: 'lh-1', lakehouseName: 'ConsumptionCentral' });
  Object.assign(config.app, { appId: 'app-1', objectId: 'obj-1', servicePrincipalId: 'sp-1' });
  config.keyVault.mode = 'notebook';
  config.semanticModel.enabled = true;
  config.dataSources.orgData = 'csv';
  if (o.cowork) {
    config.dataSources.coworkCredits = 'api';
    Object.assign(config.consumption, { vivaPartition: '11111111-1111-4111-8111-111111111111', vivaQuery: '22222222-2222-4222-8222-222222222222' });
  }
  /** @type {string[]} */
  const csvFiles = [];
  if (o.upload) {
    const csv = join(dir, o.upload === 'fails' ? 'broken-org.csv' : 'org.csv');
    writeFileSync(csv, 'UserPrincipalName,Department\nana@contoso.com,Finance\n');
    csvFiles.push(csv);
  }
  saveConfig(file, config);

  const fabric = fakeFabric();
  if (o.report) fabric.failures.createReport = [new Error('Report publish failed')];
  if (o.cowork) fabric.dataflowConnections.push([{ path: 'VivaInsights', kind: 'VivaInsights' }, { path: 'Lakehouse', kind: 'Lakehouse' }]);
  fabric.api.getJob = /** @type {any} */ (async () => ({ id: 'job-1', status: 'Completed', startTimeUtc: '2026-06-01T12:01:00Z', endTimeUtc: '2026-06-01T14:00:00Z' }));
  const loads = Object.entries(o.loads ?? {});
  const scripted = new Set(loads.map(([name]) => name));
  const failing = new Set(loads.filter(([, attempts]) => attempts.at(-1)?.status !== 'Succeeded').map(([name]) => name));
  fabric.api.queryActivityRuns = async () => [
    ...(fabric.items.find((i) => i.type === 'DataPipeline')?.content.properties.activities ?? [])
      .filter((/** @type {any} */ a) => !scripted.has(a.name))
      .map((/** @type {any} */ a) => ({
        activityName: a.name,
        // An If fails with the load in it.
        status: [...(a.typeProperties?.ifTrueActivities ?? []), ...(a.typeProperties?.ifFalseActivities ?? [])].some((/** @type {{ name: string }} */ i) => failing.has(i.name))
          ? 'Failed'
          : 'Succeeded',
        activityRunStart: '2026-06-01T12:01:00Z',
      })),
    ...loads.flatMap(([activityName, attempts]) => attempts.map((a, i) => ({ activityName, activityRunStart: `2026-06-01T12:0${i + 2}:00Z`, ...a }))),
  ];
  const graph = fakeAzureGraph();
  graph.applications.push({ id: 'obj-1', appId: 'app-1', displayName: 'Consumption Central' });
  const powerBi = fakePowerBi();
  // The data check is the first query after the load; the model's probe follows it.
  if (o.query) powerBi.failures.executeQueries = [o.query];
  const ui = fakeUi();
  /** @type {string[][]} */
  const appCalls = [];
  const appDist = join(dir, 'app-dist');
  if (o.app) {
    mkdirSync(appDist);
    writeFileSync(join(appDist, 'index.html'), '<!doctype html><title>Consumption Central</title>');
  }
  let sleeps = 0;
  const ctx = createCtx({
    ui: ui.ui,
    config,
    file,
    api: /** @type {any} */ ({
      fabric: { ...fabric.api, tenantSettings: forbidden },
      graph: {
        ...graph.api,
        myDirectoryRoles: async () => [],
        usersCanRegisterApps: async () => true,
        ensureRequiredAccess: async () => false,
        findGroupByName: async (/** @type {string} */ name) => ({ id: 'group-1', displayName: name }),
        getGroup: async (/** @type {string} */ id) => ({ id, displayName: 'Consumption Central Viewers' }),
        appRoleAssignments: async () => (await graph.api.graphServicePrincipal()).appRoles.map((r) => ({ resourceId: 'graph-sp', appRoleId: r.id })),
      },
      powerBi: { ...powerBi.api, datasetUsers: async () => [], addDatasetUser: async () => null },
      arm: { listSubscriptions: async () => [] },
      keyVault: {},
      oneLake: {
        readJson: async () => null,
        readText: async () => null,
        createDirectory: async () => {
          if (o.noDropFolder) throw new Error('403 Forbidden');
        },
        writeFile: async (/** @type {string} */ ws, /** @type {string} */ lh, /** @type {string} */ path) => {
          if (path.includes('broken')) throw new Error('403 Forbidden');
        },
      },
      discovery: {},
      powerPlatform: { billingPolicies: async () => [] },
    }),
    user: { id: 'user-1', upn: 'admin@contoso.com', tenantId: 'tenant-1' },
    sources: o.app ? { ...realSources(), appDist } : realSources(),
    sleep: async () => {
      if (++sleeps > 300) throw new Error('The install is stuck waiting.');
    },
    now: () => new Date('2026-06-01T12:00:00Z'),
  });
  if (o.app) {
    ctx.appDeps = {
      run: async (args) => {
        appCalls.push([...args]);
        return { ok: false, exitCode: 1, data: undefined, error: 'The Fabric route has no app step.', stdout: '', stderr: '' };
      },
      nodeVersion: 'v24.11.0',
      distDir: appDist,
    };
  }
  ctx.runFirstLoad = true;
  ctx.csvFiles = csvFiles;
  const ok = await install(ctx, { wait: true });
  const text = ui.text();
  assert.equal(config.firstRun?.status, 'Completed', 'the data loaded, whatever else failed');
  if (o.cowork) {
    assert.match(text, /✓ Created Dataflow /);
    assert.doesNotMatch(text, /left out of this first load/, 'the run refreshed the Dataflow');
  }
  return { ok, text, ctx, ui, fabric, config, appCalls };
}

/** @param {{ ok: boolean, text: string }} run */
function setUp({ ok, text }) {
  assert.equal(ok, true);
  assert.match(text, /Consumption Central is set up/);
  assert.doesNotMatch(text, /partly set up/);
}

/** @param {{ ok: boolean, text: string }} run */
function partlySetUp({ ok, text }) {
  assert.equal(ok, false);
  assert.match(text, /Consumption Central is partly set up/);
  assert.match(text, /A step above didn't finish\. Fix what it says, then run the installer again/);
  assert.doesNotMatch(text, /Consumption Central is set up/);
}

test('install: a report that fails to publish leaves it partly set up', async (t) => {
  const run = await runInstall(t, { report: true });
  assert.match(run.text, /The Consumption Central report wasn't published: Report publish failed/);
  partlySetUp(run);
});

test("install: an export that fails to upload leaves it partly set up; a drop folder it couldn't make only warns", async (t) => {
  const run = await runInstall(t, { upload: 'fails' });
  assert.match(run.text, /✗ Couldn't upload broken-org\.csv: 403 Forbidden/);
  assert.match(run.text, /yourself, or run ".*upload <file>" again\./);
  partlySetUp(run);

  const warned = await runInstall(t, { upload: 'works', noDropFolder: true });
  assert.match(warned.text, /! Couldn't make .+ \(403 Forbidden\)/);
  assert.match(warned.text, /✓ Uploaded org\.csv \(Org data\)/);
  assert.doesNotMatch(warned.text, /✗/);
  setUp(warned);
});

test("install: a data check query that fails leaves it partly set up; one the model can't be asked only warns", async (t) => {
  const run = await runInstall(t, { query: httpError(400, "The table 'CreditsWeekly' cannot be found.") });
  assert.match(run.text, /✗ Data check: the query on Consumption Central Model failed/);
  assert.match(run.text, /The table 'CreditsWeekly' cannot be found\./);
  assert.match(run.text, /Run ".*check" to try it again\./);
  assert.match(run.text, /✓ Consumption Central Model answers queries/);
  partlySetUp(run);

  const warned = await runInstall(t, { query: httpError(500, 'Internal Server Error') });
  assert.match(warned.text, /! Couldn't query Consumption Central Model for the data check \(Internal Server Error\)\./);
  assert.doesNotMatch(warned.text, /✗/);
  setUp(warned);
});

test('install: a load that fails in a run that completes leaves it partly set up', async (t) => {
  const run = await runInstall(t, { loads: { [ORG_DATA]: [refused] } });
  assert.match(run.text, /✗ Org data: failed/);
  assert.match(run.text, /then run ".*rerun-failed"\./);
  partlySetUp(run);
});

test("install: a load that failed on a busy capacity counts; one that loads when it's tried again doesn't", async (t) => {
  const run = await runInstall(t, { loads: { [ORG_DATA]: [turnedAway] } });
  assert.match(run.text, /✗ Org data: failed/);
  assert.match(run.text, /Fabric's capacity was too busy to start it\./);
  partlySetUp(run);

  const retried = await runInstall(t, { loads: { [ORG_DATA]: [refused, { status: 'Succeeded' }] } });
  assert.match(retried.text, /✓ Org data \(2 attempts\)/);
  assert.doesNotMatch(retried.text, /✗ Org data/);
  setUp(retried);
});

test("install: the Cowork Dataflow failing while its sign-in is still to do doesn't count; failing on a busy capacity does", async (t) => {
  const run = await runInstall(t, { cowork: true, loads: { [COWORK_DATAFLOW_ACTIVITY]: [unsigned] } });
  assert.match(run.text, /✗ Cowork credits \(Viva Insights Dataflow\): failed/);
  assert.match(run.text, /To do: sign in to the Cowork Dataflow/);
  setUp(run);

  const busy = await runInstall(t, { cowork: true, loads: { [COWORK_DATAFLOW_ACTIVITY]: [turnedAway] } });
  assert.match(busy.text, /✗ Cowork credits \(Viva Insights Dataflow\): failed/);
  assert.match(busy.text, /Fabric's capacity was too busy to start it\./);
  assert.doesNotMatch(busy.text, /To do: sign in to the Cowork Dataflow/);
  partlySetUp(busy);
});

test('update: a step that fails leaves it not finished, never "Up to date"', async (t) => {
  const run = await runInstall(t);
  setUp(run);
  let from = run.ui.text().length;
  const since = () => run.ui.text().slice(from);
  assert.equal(await update(run.ctx, { wait: true }), true);
  assert.match(since(), /Up to date/);

  from = run.ui.text().length;
  /** @type {import('../src/config.js').ReportConfig} */ (run.config.semanticModel.report).signature = 'from an older version';
  run.fabric.failures.updateReport = [new Error('Report update failed')];
  assert.equal(await update(run.ctx, { wait: true }), false);
  assert.match(since(), /✗ The Consumption Central report wasn't published: Report update failed/);
  assert.match(since(), /✗ The update isn't finished: a step above failed\. Fix what it says, then run ".*update" again\./);
  assert.doesNotMatch(since(), /Up to date|Updated\./);
});

test('CC: install: the Fabric route stays report-only: neither its install nor its update runs the app step, even with a build of the app', async (t) => {
  const run = await runInstall(t, { app: true });
  setUp(run);
  assert.match(run.text, /\[\d+\/\d+\] Power BI report/);
  assert.doesNotMatch(run.text, /\[\d+\/\d+\] The app\b/);
  assert.ok(!run.text.includes(THE_APP), run.text);
  const from = run.ui.text().length;
  assert.equal(await update(run.ctx, { wait: true }), true);
  assert.ok(!run.ui.text().slice(from).includes(THE_APP), run.ui.text().slice(from));
  assert.deepEqual(run.appCalls, [], 'the managed apps CLI never ran');
  assert.equal(run.config.managedApp, undefined, 'the record keeps no app');
});
