// @ts-check
/**
 * Ingest_CommercialTerms isn't in the pipeline: the installer runs it once, as a job, after deploying it and before
 * the first pipeline run, and again on update for the new last full month. Also ranSince, which says whether a
 * pipeline run ended after the data check.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyConfig } from '../src/config.js';
import { createCtx, install, update } from '../src/install.js';
import { commandLine } from '../src/launch.js';
import { ranSince, runOnceNotebooks } from '../src/steps/run.js';
import { mNumberParameter } from '../src/transform/model.js';
import { cellText } from '../src/transform/notebook.js';
import { fakeAzureGraph, fakeCtx, fakeFabric, fakePowerBi, fakeUi, realSources } from './fakes.js';

const TERMS = 'Ingest_CommercialTerms';
/** A billing account: the plan lists only subscriptions, so it keeps no name for it. */
const SCOPE = '/providers/Microsoft.Billing/billingAccounts/contoso-ba';
/** The rate set in the installer's advanced settings. */
const PRICES = { creditRate: 0.009 };
/** A run Cost Management turned away: the signed-in user can't read costs at the scope. */
const denied = { status: 'Failed', failureReason: { errorCode: 'NotebookFailed', message: "AuthorizationFailed: no authorization to perform action 'Microsoft.CostManagement/query/read'" } };
const completed = () => ({ id: 'job-1', status: 'Completed', startTimeUtc: '2026-06-10T12:01:00Z', endTimeUtc: '2026-06-10T12:20:00Z' });

const forbidden = async () => {
  throw new Error('Forbidden');
};

/**
 * A new Fabric install with Commercial terms read from the API and a credit rate of its own, run to the end and
 * waiting on the first load.
 * @param {{ terms?: any[] }} [o]  terms: how runs of Ingest_CommercialTerms end, in order; after those, Completed.
 */
async function runInstall(o = {}) {
  const config = emptyConfig();
  config.target = 'fabric';
  config.tenantId = 'tenant-1';
  Object.assign(config.fabric, { workspaceId: 'ws-1', workspaceName: 'Analytics', lakehouseId: 'lh-1', lakehouseName: 'ConsumptionCentral' });
  Object.assign(config.app, { appId: 'app-1', objectId: 'obj-1', servicePrincipalId: 'sp-1' });
  config.keyVault.mode = 'notebook';
  config.semanticModel.enabled = true;
  config.prices = { ...PRICES };
  config.dataSources.commercialTerms = 'api';
  config.commercialTerms = { scope: SCOPE };

  const fabric = fakeFabric();
  const terms = [...(o.terms ?? [])];
  /** Each job started: what it ran, and the prices when it started. @type {{ item: string, type: string, prices: any }[]} */
  const runs = [];
  const runJob = fabric.api.runJob;
  fabric.api.runJob = async (ws, id, jobType, data) => {
    runs.push({ item: id, type: jobType, prices: structuredClone(config.prices) });
    return runJob(ws, id, jobType, data);
  };
  fabric.api.getJob = /** @type {any} */ (
    async (/** @type {string} */ url) => (url.includes(`/items/${config.fabric.notebooks.commercialTerms}/`) && terms.length ? terms.shift() : completed())
  );
  fabric.api.queryActivityRuns = async () =>
    (fabric.items.find((i) => i.type === 'DataPipeline')?.content.properties.activities ?? []).map((/** @type {any} */ a) => ({
      activityName: a.name,
      status: 'Succeeded',
      activityRunStart: '2026-06-10T12:21:00Z',
    }));
  const graph = fakeAzureGraph();
  graph.applications.push({ id: 'obj-1', appId: 'app-1', displayName: 'Consumption Central' });
  const powerBi = fakePowerBi();
  const ui = fakeUi();
  let sleeps = 0;
  const ctx = createCtx({
    ui: ui.ui,
    config,
    file: 'consumption-central-setup.json',
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
      oneLake: { readJson: async () => null, readText: async () => null, createDirectory: async () => {}, writeFile: async () => {} },
      discovery: {},
      powerPlatform: { billingPolicies: async () => [] },
    }),
    user: { id: 'user-1', upn: 'admin@contoso.com', tenantId: 'tenant-1' },
    sources: realSources(),
    sleep: async () => {
      if (++sleeps > 300) throw new Error('The install is stuck waiting.');
    },
    now: () => new Date('2026-06-10T12:00:00Z'),
  });
  // The install record stays in memory.
  ctx.save = () => {};
  ctx.runFirstLoad = true;
  ctx.csvFiles = [];
  const ok = await install(ctx, { wait: true });
  assert.equal(config.firstRun?.status, 'Completed', 'the data loaded, whatever the credit rate did');
  return { ok, ctx, ui, fabric, config, runs, terms };
}

/**
 * The values the deployed Ingest_CommercialTerms reads.
 * @param {ReturnType<typeof fakeFabric>} fabric
 */
function termsValues(fabric) {
  const nb = fabric.items.find((i) => i.type === 'Notebook' && i.displayName === TERMS);
  const text = JSON.parse(String(nb?.content)).cells.map(cellText).join('\n');
  const value = (/** @type {string} */ name) => new RegExp(`^${name}\\s*=\\s*'([^']*)'`, 'm').exec(text)?.[1];
  return { SCOPE: value('SCOPE'), FROM_DATE: value('FROM_DATE'), TO_DATE: value('TO_DATE') };
}

/**
 * The credit rate the deployed model prices usage with when no rate has been read.
 * @param {ReturnType<typeof fakeFabric>} fabric
 */
function modelCreditRate(fabric) {
  const item = fabric.items.find((i) => i.type === 'SemanticModel');
  const bim = JSON.parse(Buffer.from(item?.content.parts.find((/** @type {any} */ p) => p.path === 'model.bim').payload, 'base64').toString('utf8'));
  return mNumberParameter(bim.model, 'CreditRate');
}

/**
 * One install step's output, from its heading to the next step's.
 * @param {string} text
 * @param {string} title
 */
function step(text, title) {
  return text.split(/\n(?=\[\d+\/\d+\] )/).find((s) => new RegExp(`^\\[\\d+\\/\\d+\\] ${title}\\n`).test(s)) ?? '';
}

/**
 * Commercial terms read from the API, with its notebook deployed as nb-terms.
 * @param {{ jobs?: any[], terms?: import('../src/config.js').CommercialTermsConfig }} [o]
 */
function deployed(o = {}) {
  const fabric = fakeFabric();
  fabric.jobs.push(...(o.jobs ?? []));
  /** @type {string[][]} */
  const started = [];
  const runJob = fabric.api.runJob;
  fabric.api.runJob = async (ws, id, jobType, data) => {
    started.push([ws, id, jobType]);
    return runJob(ws, id, jobType, data);
  };
  const ui = fakeUi();
  const t = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  t.config.dataSources.commercialTerms = 'api';
  t.config.fabric.notebooks.commercialTerms = 'nb-terms';
  if (o.terms) t.config.commercialTerms = o.terms;
  return { ...t, fabric, ui, started };
}

test('install: Ingest_CommercialTerms runs once as a job, after it is deployed and before the first pipeline run', async () => {
  const { ok, ui, fabric, config, runs } = await runInstall();
  assert.equal(ok, true);
  const at = (/** @type {string} */ call) => fabric.calls.findIndex((c) => c.startsWith(call));
  assert.ok(at(`createNotebook ${TERMS}`) >= 0, 'deployed with the other notebooks');
  assert.ok(at(`createNotebook ${TERMS}`) < at('createPipeline '));
  assert.ok(at('createSchedule') < at('runJob RunNotebook'), 'after the pipeline and its schedule');
  assert.ok(at('runJob RunNotebook') < at('runJob Pipeline'), 'before the first load');
  assert.deepEqual(
    runs.map((r) => [r.type, r.item]),
    [
      ['RunNotebook', config.fabric.notebooks.commercialTerms],
      ['Pipeline', config.fabric.pipelineId],
    ],
  );
  assert.deepEqual(termsValues(fabric), { SCOPE, FROM_DATE: '2026-05-01', TO_DATE: '2026-05-31' }, 'the last full month');
  assert.deepEqual(config.commercialTerms, { scope: SCOPE, status: 'Completed', ranAt: '2026-06-10T12:00:00.000Z' });

  const text = ui.text();
  const steps = [...text.matchAll(/^\[\d+\/\d+\] (.+)$/gm)].map((m) => m[1]);
  assert.ok(steps.indexOf('Notebooks, pipeline and schedule') < steps.indexOf('Commercial terms'));
  assert.equal(steps.indexOf('Commercial terms'), steps.indexOf('First load') - 1, 'the step just before the first load');
  const terms = step(text, 'Commercial terms');
  assert.ok(terms.includes(`\n    Ingest_CommercialTerms reads the credit rate you pay from Cost Management for ${SCOPE}.\n`));
  assert.ok(terms.includes('  ✓ Ingest_CommercialTerms finished in 19m 00s\n'));
  assert.match(text, /Consumption Central is set up/);
});

test('install: a commercial terms run that fails names the role and the scope; the prices stand and the first load still runs', async () => {
  const { ok, ui, fabric, config, runs } = await runInstall({ terms: [denied] });
  assert.deepEqual(
    runs.map((r) => r.type),
    ['RunNotebook', 'Pipeline'],
    'tried once: only a busy capacity is tried again',
  );
  const ran = fabric.calls.indexOf('runJob RunNotebook');
  assert.ok(ran < fabric.calls.findIndex((c) => c.startsWith('runJob Pipeline')));
  assert.deepEqual(runs[0].prices, PRICES);
  assert.deepEqual(config.prices, PRICES, 'the prices stand');
  assert.equal(modelCreditRate(fabric), PRICES.creditRate, 'the model keeps pricing credits at the installer rate');
  assert.deepEqual(
    fabric.calls.slice(ran).filter((c) => /SemanticModel/.test(c)),
    [],
    'the model is left as it was',
  );
  assert.equal(config.commercialTerms?.status, 'Failed');
  const text = ui.text();
  const terms = step(text, 'Commercial terms');
  assert.ok(terms.includes('  ! Ingest_CommercialTerms failed\n'), 'a warning: the install carries on and counts as set up');
  assert.ok(terms.includes("\n    AuthorizationFailed: no authorization to perform action 'Microsoft.CostManagement/query/read'\n"));
  assert.ok(
    terms.includes(
      `\n    Until it completes, the model prices credits at the rates set in the installer, or the template's. It runs as you, so you need Cost Management Reader on ${SCOPE}. Run the installer again to retry.\n`,
    ),
  );
  assert.equal(ok, true, 'it only warns');
  assert.match(text, /Consumption Central is set up/);
  assert.doesNotMatch(text, /partly set up|✗/);
});

test('update: Ingest_CommercialTerms runs again each time, for the last full month once that month has settled', async () => {
  const run = await runInstall();
  const { ctx, ui, fabric, config, runs, terms } = run;
  let from = ui.text().length;
  const since = () => ui.text().slice(from);
  const reset = () => {
    fabric.calls.length = 0;
    runs.length = 0;
    from = ui.text().length;
  };

  // Early in July, June is still closing, so it reads May again; it still runs, as on every update.
  reset();
  ctx.now = () => new Date('2026-07-03T09:00:00Z');
  assert.equal(await update(ctx, { wait: true }), true);
  assert.deepEqual(termsValues(fabric), { SCOPE, FROM_DATE: '2026-05-01', TO_DATE: '2026-05-31' });
  assert.deepEqual(
    runs.map((r) => r.type),
    ['RunNotebook'],
  );
  assert.equal(config.commercialTerms?.ranAt, '2026-07-03T09:00:00.000Z');

  reset();
  ctx.now = () => new Date('2026-07-10T12:00:00Z');
  assert.equal(await update(ctx, { wait: true }), true);
  assert.deepEqual(termsValues(fabric), { SCOPE, FROM_DATE: '2026-06-01', TO_DATE: '2026-06-30' }, 'the new last full month');
  assert.ok(fabric.calls.indexOf(`updateNotebook ${TERMS}`) >= 0);
  assert.ok(fabric.calls.indexOf(`updateNotebook ${TERMS}`) < fabric.calls.indexOf('runJob RunNotebook'), 'rewritten, then run');
  assert.deepEqual(
    runs.map((r) => [r.type, r.item]),
    [['RunNotebook', config.fabric.notebooks.commercialTerms]],
  );
  assert.deepEqual(config.commercialTerms, { scope: SCOPE, status: 'Completed', ranAt: '2026-07-10T12:00:00.000Z' });
  assert.match(since(), /✓ Ingest_CommercialTerms finished/);
  assert.doesNotMatch(since(), /read the credit rate from/, 'run again, though it completed before');
  assert.match(since(), /Up to date/);

  // A run that fails on update only warns too.
  reset();
  terms.push(denied);
  assert.equal(await update(ctx, { wait: true }), true);
  assert.equal(config.commercialTerms?.status, 'Failed');
  assert.ok(since().includes('  ! Ingest_CommercialTerms failed\n'));
  assert.match(since(), /you need Cost Management Reader on \/providers\/Microsoft\.Billing\/billingAccounts\/contoso-ba\. Run the installer again to retry\./);
  assert.doesNotMatch(since(), /✗/);
  assert.match(since(), /Up to date/);
});

test('runOnceNotebooks: nothing runs unless Commercial terms is read from the API and its notebook is deployed', async () => {
  for (const change of [
    (/** @type {import('../src/config.js').InstallConfig} */ c) => (c.dataSources.commercialTerms = 'skip'),
    (/** @type {import('../src/config.js').InstallConfig} */ c) => delete c.fabric.notebooks.commercialTerms,
    (/** @type {import('../src/config.js').InstallConfig} */ c) => delete c.fabric.workspaceId,
  ]) {
    const t = deployed();
    change(t.config);
    assert.equal(await runOnceNotebooks(t.ctx, { force: true }), true);
    assert.deepEqual(t.fabric.calls, []);
    assert.equal(t.config.commercialTerms, undefined);
    assert.equal(t.ui.text(), '');
  }
});

test('runOnceNotebooks: runs the deployed notebook under the name it was given, and says where it reads the rate', async () => {
  const t = deployed({ jobs: [{ status: 'Completed', startTimeUtc: '2026-06-01T12:01:00', endTimeUtc: '2026-06-01T12:04:30' }], terms: { scope: SCOPE } });
  /** @type {Partial<Record<import('../src/catalog.js').NotebookKey, string>>} */ (t.config.fabric.notebookNames = { commercialTerms: 'Ingest_CommercialTerms 2' });
  assert.equal(await runOnceNotebooks(t.ctx), true);
  assert.deepEqual(t.started, [['ws-1', 'nb-terms', 'RunNotebook']]);
  assert.deepEqual(t.config.commercialTerms, { scope: SCOPE, status: 'Completed', ranAt: '2026-06-01T12:00:00.000Z' });
  assert.ok(t.saves() > 0, 'the record is saved');
  const text = t.ui.text();
  assert.ok(text.startsWith(`    Ingest_CommercialTerms 2 reads the credit rate you pay from Cost Management for ${SCOPE}.\n`));
  assert.ok(text.endsWith('  ✓ Ingest_CommercialTerms 2 finished in 3m 30s\n'));

  // No scope saved yet: the notes still say what to give the role on.
  const none = deployed({ jobs: [denied] });
  assert.equal(await runOnceNotebooks(none.ctx), false);
  const notes = none.ui.text();
  assert.match(notes, /Ingest_CommercialTerms reads the credit rate you pay from Cost Management for the billing scope\./);
  assert.match(notes, /you need Cost Management Reader on the billing scope\. Run the installer again to retry\./);
});

test('runOnceNotebooks: a run that failed, was cancelled or is still going runs again next time; the prices stand', async () => {
  const prices = { creditRate: 0.01, prepaidCreditRate: 0.008, prepaidCreditBalance: 0 };
  const t = deployed({ jobs: [denied], terms: { scope: SCOPE, scopeName: 'Contoso billing account' } });
  t.config.prices = structuredClone(prices);
  assert.equal(await runOnceNotebooks(t.ctx), false);
  assert.deepEqual(t.config.prices, prices);
  assert.deepEqual(t.config.commercialTerms, { scope: SCOPE, scopeName: 'Contoso billing account', status: 'Failed', ranAt: '2026-06-01T12:00:00.000Z' });

  t.fabric.jobs.push({ status: 'Completed' });
  assert.equal(await runOnceNotebooks(t.ctx), true, 'run again without being asked');
  assert.equal(t.started.length, 2);
  assert.equal(t.config.commercialTerms?.status, 'Completed');

  const cancelled = deployed({ jobs: [{ status: 'Cancelled' }], terms: { scope: SCOPE } });
  assert.equal(await runOnceNotebooks(cancelled.ctx), false);
  assert.match(cancelled.ui.text(), /! Ingest_CommercialTerms ended with status Cancelled\n/);
  assert.match(cancelled.ui.text(), /you need Cost Management Reader on \/providers\/Microsoft\.Billing\/billingAccounts\/contoso-ba\./);
  assert.equal(cancelled.config.commercialTerms?.status, 'Cancelled');
  assert.equal(cancelled.config.commercialTerms?.ranAt, '2026-06-01T12:00:00.000Z');

  // Still going when the wait ends: it hasn't finished, so no time is kept.
  const going = deployed({ jobs: [{ status: 'InProgress' }], terms: { scope: SCOPE } });
  assert.equal(await runOnceNotebooks(going.ctx, { timeoutMs: -1 }), false);
  assert.ok(going.ui.text().includes(`! Ingest_CommercialTerms is still running (InProgress). Check later with "${commandLine('status')}".\n`));
  assert.deepEqual(going.config.commercialTerms, { scope: SCOPE, status: 'InProgress' });
  going.fabric.jobs.push({ status: 'Completed' });
  assert.equal(await runOnceNotebooks(going.ctx), true);
  assert.equal(going.started.length, 2);
});

test('a commercial terms run that fails is shown as a warning, since the install still counts as set up', async () => {
  const t = deployed({ jobs: [denied], terms: { scope: SCOPE } });
  assert.equal(await runOnceNotebooks(t.ctx), false);
  const text = t.ui.text();
  assert.match(text, /! Ingest_CommercialTerms failed/);
  assert.doesNotMatch(text, /✗/);
});

test('ranSince: reads zone-less Fabric times as UTC; only a completed or failed run that ended after the check counts', () => {
  const at = '2026-06-01T12:30:00.000Z';
  assert.equal(ranSince([{ status: 'Completed', endTimeUtc: '2026-06-01T12:45:00' }], at), true, 'zone-less: 12:45 UTC');
  assert.equal(ranSince([{ status: 'Completed', endTimeUtc: '2026-06-01T13:15:00+01:00' }], at), false, 'with a zone: 12:15 UTC');
  assert.equal(ranSince([{ status: 'Completed', endTimeUtc: '2026-06-01T12:30:00Z' }], at), false, 'ended as the check ran');
  assert.equal(ranSince([{ status: 'Cancelled', endTimeUtc: '2026-06-02T02:20:00' }], at), false);
  assert.equal(ranSince([{ status: 'Completed' }], at), false, 'no end time');
  assert.equal(ranSince([], at), false);
  assert.equal(ranSince([{ status: 'Completed', endTimeUtc: '2026-06-02T02:20:00' }], 'not a date'), false);
  const runs = [
    { status: 'Completed', endTimeUtc: '2026-05-31T02:20:00' },
    { status: 'InProgress' },
    { status: 'Failed', endTimeUtc: '2026-06-01T12:31:00' },
  ];
  assert.equal(ranSince(runs, at), true, 'any of several');
});
