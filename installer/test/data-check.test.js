// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notebooksFor } from '../src/catalog.js';
import { HttpError } from '../src/http.js';
import { finishUpdate, refresh, runCommand } from '../src/install.js';
import { commandLine } from '../src/launch.js';
import { deployedSources, modelDeployed, notebookOptions, pipelineSettings } from '../src/steps/fabric.js';
import { countModelRows, DATA_CHECK_TABLES, dataCheckQuery, MODEL_PROBE, refreshModel, verifyModel } from '../src/steps/model.js';
import { checkData, DATA_CHECK_FILE, LOW_DEPARTMENT_COVERAGE, loadedBy, printDataCheck, runDataCheck, status } from '../src/steps/run.js';
import { loadTemplateModel } from '../src/transform/model.js';
import { buildPipeline, findActivity, REFRESH_ACTIVITY, STATUS_ACTIVITY } from '../src/transform/pipeline.js';
import { DATA_SOURCE_IDS } from '../src/uploads.js';
import { fakeCtx, fakePowerBi, fakeUi, httpError, realSources } from './fakes.js';

/** @typedef {Partial<import('../src/config.js').SemanticModelConfig>} ModelState */

/** @type {[string, ModelState][]} The models the installer leaves alone. setup() starts from a deployed one. */
const NOT_DEPLOYED = [
  ['switched off', { enabled: false }],
  ['not made yet', { id: undefined, bound: false }],
  ['not connected to the Lakehouse', { bound: false }],
];
/** @type {[string, ModelState][]} */
const EVERY_STATE = [['deployed', {}], ...NOT_DEPLOYED];

const UPLOAD_NOTE = `    Upload its export with "${commandLine('upload <file> --run')}".`;

/** @param {string[]} l */
const lines = (...l) => l.map((s) => `${s}\n`).join('');

/** @param {string} source */
const check = (source) => /** @type {import('../src/steps/model.js').DataCheck} */ (DATA_CHECK_TABLES.find((c) => c.source === source));

/** What Power BI gives for a DAX query that returns one row. @param {Record<string, unknown>} row */
const answer = (row) => ({ results: [{ tables: [{ rows: [row] }] }] });

/** Power BI turning down a DAX query, such as one naming a table the model lacks. @param {string} detail */
const daxError = (detail) =>
  new HttpError('Bad Request', {
    status: 400,
    method: 'POST',
    url: 'https://api.powerbi.com/v1.0/myorg/groups/ws-1/datasets/model-1/executeQueries',
    body: {
      error: {
        code: 'DatasetExecuteQueriesError',
        'pbi.error': { code: 'DatasetExecuteQueriesError', details: [{ code: 'DetailsMessage', detail: { type: 1, value: detail } }, { code: 'AnalysisServicesErrorCode', detail: { type: 1, value: '3241803789' } }] },
      },
    },
  });

/** OneLake files kept in memory, by workspace, Lakehouse and path. */
function fakeLake() {
  /** @type {Map<string, string>} */
  const files = new Map();
  return {
    files,
    /** @param {string} ws @param {string} lh @param {string} path @param {Uint8Array} data */
    writeFile: async (ws, lh, path, data) => {
      files.set(`${ws}/${lh}/${path}`, new TextDecoder().decode(data));
    },
    /** @param {string} ws @param {string} lh @param {string} path */
    readJson: async (ws, lh, path) => {
      const text = files.get(`${ws}/${lh}/${path}`);
      return text === undefined ? null : JSON.parse(text);
    },
  };
}

/**
 * A deployed model over the default sources (Cowork and Studio credits from CSV), and a Power BI
 * that records each DAX query.
 * @param {{ model?: ModelState, sources?: Partial<import('../src/uploads.js').DataSourceModes>, oneLake?: any, fabric?: any }} [o]
 */
function setup(o = {}) {
  const t = fakeUi();
  const pbi = fakePowerBi();
  /** @type {string[]} */
  const queries = [];
  const execute = pbi.api.executeQueries;
  pbi.api.executeQueries = async (ws, id, query) => {
    queries.push(query);
    return execute(ws, id, query);
  };
  const { ctx, config } = fakeCtx({ ui: t.ui, powerBi: pbi.api, oneLake: o.oneLake, fabric: o.fabric });
  Object.assign(config.semanticModel, { enabled: true, id: 'model-1', bound: true }, o.model);
  Object.assign(config.dataSources, o.sources);
  return { ctx, config, pbi, queries, text: t.text };
}

test('the data check counts tables and columns the Fabric template has, for every source but commercial terms', () => {
  const template = loadTemplateModel(realSources().modelFile);
  const table = (/** @type {string} */ name) => template.model.tables.find((t) => t.name === name);
  assert.deepEqual(
    DATA_CHECK_TABLES.map((c) => c.source),
    DATA_SOURCE_IDS.filter((id) => id !== 'commercialTerms'),
  );
  for (const c of DATA_CHECK_TABLES) {
    const t = table(c.table);
    assert.ok(t, `the template has no '${c.table}' table`);
    assert.equal(t.partitions?.[0]?.source?.type, 'm', `${c.table} is loaded from the Lakehouse`);
    const column = (/** @type {string} */ name) => t.columns?.find((/** @type {any} */ col) => col.name === name);
    if (c.date) assert.equal(column(c.date)?.dataType, 'dateTime', `${c.table}[${c.date}]`);
    if (c.filled) assert.equal(column(c.filled)?.dataType, 'string', `${c.table}[${c.filled}]`);
  }
  assert.match(MODEL_PROBE, /COUNTROWS\('Date'\)/);
  assert.equal(table('Date')?.partitions?.[0]?.source?.type, 'calculated', 'the probe counts a calculated table');
});

test('dataCheckQuery asks for every count in one row, quoting names as DAX needs', () => {
  assert.equal(
    dataCheckQuery([check('studioCredits'), check('orgData')]),
    lines(
      'EVALUATE ROW(',
      `  "studioCredits", COUNTROWS('Credit Consumption (Tenant)'),`,
      `  "studioCreditsFrom", MIN('Credit Consumption (Tenant)'[Usage_Date]),`,
      `  "studioCreditsTo", MAX('Credit Consumption (Tenant)'[Usage_Date]),`,
      `  "orgData", COUNTROWS('Org'),`,
      `  "orgDataFilled", COUNTROWS(FILTER('Org', LEN('Org'[Department]) > 0))`,
    ) + ')',
  );
  assert.equal(
    dataCheckQuery([{ source: 'github', table: "Contoso's GitHub Usage", date: 'Usage Date [UTC]' }]),
    lines(
      'EVALUATE ROW(',
      `  "github", COUNTROWS('Contoso''s GitHub Usage'),`,
      `  "githubFrom", MIN('Contoso''s GitHub Usage'[Usage Date [UTC]]]),`,
      `  "githubTo", MAX('Contoso''s GitHub Usage'[Usage Date [UTC]]])`,
    ) + ')',
  );
});

test('countModelRows counts the rows, dates and departments of each source in use, in one query', async () => {
  const t = setup({ sources: { coworkCredits: 'api', github: 'api', orgData: 'api', commercialTerms: 'api' } });
  t.pbi.answers.push(
    answer({
      '[coworkCredits]': 1200,
      '[coworkCreditsFrom]': '2026-03-02T00:00:00',
      '[coworkCreditsTo]': '2026-05-25T00:00:00',
      '[github]': 310,
      '[githubFrom]': '2026-04-01T00:00:00',
      '[githubTo]': '2026-05-31T00:00:00',
      '[orgData]': 1200,
      '[orgDataFilled]': 1100,
    }),
  );
  assert.deepEqual(await countModelRows(t.ctx), {
    tables: {
      coworkCredits: { table: 'CreditsWeekly', rows: 1200, from: '2026-03-02', to: '2026-05-25' },
      studioCredits: { table: 'Credit Consumption (Tenant)', rows: 0, from: null, to: null },
      github: { table: 'GitHub Usage', rows: 310, from: '2026-04-01', to: '2026-05-31' },
      orgData: { table: 'Org', rows: 1200, filled: 1100 },
    },
  });
  assert.deepEqual(t.queries, [dataCheckQuery(['coworkCredits', 'studioCredits', 'github', 'orgData'].map(check))]);
  assert.deepEqual(t.pbi.calls, ['executeQueries model-1']);
  assert.equal(t.text(), '');
});

test('countModelRows asks nothing of a model that is off, not made or not connected, or when no source it counts is in use', async () => {
  for (const [state, model] of NOT_DEPLOYED) {
    const t = setup({ model });
    assert.deepEqual(await countModelRows(t.ctx), { skipped: true }, state);
    assert.deepEqual(t.pbi.calls, [], state);
    assert.equal(t.text(), '', state);
  }
  const t = setup({ sources: { coworkCredits: 'skip', studioCredits: 'skip', commercialTerms: 'api' } });
  assert.deepEqual(await countModelRows(t.ctx), { skipped: true });
  assert.deepEqual(t.pbi.calls, []);
});

test('countModelRows gives the reason a query failed, and only warns when the model can\'t be asked', async () => {
  /** @param {{ err?: Error, res?: any }} o */
  const counted = async (o) => {
    const t = setup();
    if (o.err) t.pbi.failures.executeQueries = [o.err];
    if (o.res) t.pbi.answers.push(o.res);
    return { result: await countModelRows(t.ctx), text: t.text() };
  };
  const detail = "Query (2, 23) Cannot find table 'CreditsWeekly'.";
  assert.deepEqual(await counted({ err: daxError(detail) }), { result: { error: detail }, text: '' });
  assert.deepEqual(await counted({ err: httpError(400, 'Bad Request') }), { result: { error: 'Bad Request' }, text: '' });
  assert.deepEqual(await counted({ err: daxError('x'.repeat(700)) }), { result: { error: 'x'.repeat(600) }, text: '' });
  assert.deepEqual(await counted({ res: { results: [{ error: { code: 'QueryError', message: 'The syntax for ROW is incorrect.' } }] } }), {
    result: { error: 'The syntax for ROW is incorrect.' },
    text: '',
  });
  assert.deepEqual(await counted({ res: { results: [{ error: { code: 'QueryError' } }] } }), { result: { error: '{"code":"QueryError"}' }, text: '' });
  assert.deepEqual(await counted({ res: { results: [{ tables: [{ rows: [] }] }] } }), { result: { error: 'The query returned no rows.' }, text: '' });

  for (const err of [httpError(500, 'Internal Server Error'), new Error('fetch failed')]) {
    assert.deepEqual(await counted({ err }), {
      result: { skipped: true },
      text: lines(`  ! Couldn't query Consumption Central Model for the data check (${err.message}).`),
    });
  }
  for (const s of [401, 403]) {
    assert.deepEqual(await counted({ err: httpError(s, 'Forbidden') }), {
      result: { skipped: true },
      text: lines(
        "  ! Couldn't query Consumption Central Model for the data check (Forbidden).",
        '    The tenant setting "Semantic model Execute Queries REST API" may be off. Open a report page to see the data.',
      ),
    });
  }
});

test('the data check saves what it found under the installer folder in OneLake, where status reads it back', async () => {
  const lake = fakeLake();
  const fabric = { listJobs: async () => [] };
  const t = setup({ oneLake: lake, fabric, sources: { github: 'csv' } });
  t.config.fabric.pipelineId = 'pipeline-1';
  t.pbi.answers.push(
    answer({
      '[coworkCredits]': 1200,
      '[coworkCreditsFrom]': '2026-03-02T00:00:00',
      '[coworkCreditsTo]': '2026-05-25T00:00:00',
      '[studioCredits]': 845,
      '[studioCreditsFrom]': '2025-12-01T00:00:00',
      '[studioCreditsTo]': '2026-05-31T00:00:00',
      '[github]': 0,
    }),
  );
  const summary = await runDataCheck(t.ctx);
  assert.deepEqual(summary, {
    checkedAt: '2026-06-01T12:00:00.000Z',
    tables: {
      coworkCredits: { table: 'CreditsWeekly', rows: 1200, from: '2026-03-02', to: '2026-05-25' },
      studioCredits: { table: 'Credit Consumption (Tenant)', rows: 845, from: '2025-12-01', to: '2026-05-31' },
      github: { table: 'GitHub Usage', rows: 0, from: null, to: null },
    },
  });
  assert.equal(DATA_CHECK_FILE, 'Files/consumption_central_installer/data_check.json');
  assert.deepEqual([...lake.files.keys()], [`ws-1/lh-1/${DATA_CHECK_FILE}`]);
  assert.equal(lake.files.get(`ws-1/lh-1/${DATA_CHECK_FILE}`), `${JSON.stringify(summary, null, 2)}\n`);
  const printed = lines(
    '  ✓ Copilot Cowork and Work IQ credits: 1,200 rows in the model, 2026-03-02 to 2026-05-25',
    '  ✓ Copilot Studio credits: 845 rows in the model, 2025-12-01 to 2026-05-31',
    '  ! GitHub Copilot: no rows in the model yet',
    UPLOAD_NOTE,
  );
  assert.equal(t.text(), printed);

  // Another PC has the install record and the Lakehouse.
  const other = fakeUi();
  const { ctx } = fakeCtx({ ui: other.ui, config: structuredClone(t.config), oneLake: lake, fabric, powerBi: t.pbi.api });
  await status(ctx);
  assert.ok(other.text().endsWith(`\nLast data check (2026-06-01 12:00 UTC)\n${printed}`), other.text());
});

test('a data check whose query fails says how to try again, and saves nothing', async () => {
  const lake = fakeLake();
  const t = setup({ oneLake: lake });
  t.pbi.failures.executeQueries = [daxError("Query (3, 14) Cannot find table 'CreditsWeekly'.")];
  assert.equal(await runDataCheck(t.ctx), false);
  assert.equal(lake.files.size, 0);
  assert.equal(
    t.text(),
    lines(
      '  ✗ Data check: the query on Consumption Central Model failed',
      "    Query (3, 14) Cannot find table 'CreditsWeekly'.",
      `    Run "${commandLine('check')}" to try it again.`,
    ),
  );
});

test('a data check that can\'t ask the model only warns, and one with no model to ask says nothing', async () => {
  const lake = fakeLake();
  const busy = setup({ oneLake: lake });
  busy.pbi.failures.executeQueries = [httpError(503, 'Service Unavailable')];
  assert.equal(await runDataCheck(busy.ctx), null);
  assert.equal(busy.text(), lines("  ! Couldn't query Consumption Central Model for the data check (Service Unavailable)."));
  for (const [state, model] of NOT_DEPLOYED) {
    const t = setup({ oneLake: lake, model });
    assert.equal(await runDataCheck(t.ctx), null, state);
    assert.equal(t.text(), '', state);
    assert.deepEqual(t.pbi.calls, [], state);
  }
  assert.equal(lake.files.size, 0);
});

test('a data check that can\'t save its result still prints it', async () => {
  const row = { '[coworkCredits]': 12, '[studioCredits]': 34 };
  const refused = setup({ oneLake: { writeFile: async () => Promise.reject(httpError(403, 'Forbidden')) } });
  refused.pbi.answers.push(answer(row));
  const summary = await runDataCheck(refused.ctx);
  assert.deepEqual(Object.keys(summary.tables), ['coworkCredits', 'studioCredits']);
  assert.equal(refused.text(), lines('  ✓ Copilot Cowork and Work IQ credits: 12 rows in the model', '  ✓ Copilot Studio credits: 34 rows in the model'));

  const noLake = setup();
  noLake.pbi.answers.push(answer(row));
  assert.deepEqual(await runDataCheck(noLake.ctx), summary);
  assert.equal(noLake.text(), refused.text());
});

test('printDataCheck says what each source gave the model, and how to load one that gave nothing', () => {
  const t = setup({ sources: { coworkCredits: 'api', github: 'api', azureAi: 'api' } });
  t.config.firstRun = { status: 'Completed', coworkSkipped: true };
  printDataCheck(t.ctx, {
    checkedAt: '2026-06-01T12:00:00.000Z',
    tables: {
      coworkCredits: { table: 'CreditsWeekly', rows: 0, from: null, to: null },
      studioCredits: { table: 'Credit Consumption (Tenant)', rows: 0, from: null, to: null },
      github: { table: 'GitHub Usage', rows: 0, from: null, to: null },
      azureAi: { table: 'AzureAiSpend', rows: 12345, from: '2026-03-01', to: '2026-05-31' },
    },
  });
  assert.equal(
    t.text(),
    lines(
      '  ! Copilot Cowork and Work IQ credits: no rows in the model yet',
      '    They load once the Cowork Dataflow is signed in: see the next step.',
      '  ! Copilot Studio credits: no rows in the model yet',
      UPLOAD_NOTE,
      '  ! GitHub Copilot: no rows in the model yet',
      '  ✓ Azure AI Foundry and Azure OpenAI: 12,345 rows in the model, 2026-03-01 to 2026-05-31',
    ),
  );
});

test('printDataCheck points to the Cowork sign-in only when the first load left Cowork out', () => {
  const empty = { tables: { coworkCredits: { table: 'CreditsWeekly', rows: 0, from: null, to: null } } };
  const csv = setup({ sources: { coworkCredits: 'csv' } });
  csv.config.firstRun = { status: 'Completed', coworkSkipped: true };
  printDataCheck(csv.ctx, empty);
  assert.equal(csv.text(), lines('  ! Copilot Cowork and Work IQ credits: no rows in the model yet', UPLOAD_NOTE));

  const signedIn = setup({ sources: { coworkCredits: 'api' } });
  signedIn.config.firstRun = { status: 'Completed' };
  printDataCheck(signedIn.ctx, empty);
  assert.equal(signedIn.text(), lines('  ! Copilot Cowork and Work IQ credits: no rows in the model yet'));
});

test('printDataCheck shows a date range only when it has both ends, and names a source it doesn\'t know by its key', () => {
  const t = setup();
  printDataCheck(t.ctx, {
    tables: {
      studioCredits: { rows: 5, from: '2026-05-01T00:00:00', to: '2026-05-31T00:00:00' },
      github: { rows: 1500, from: '2026-05-01', to: null },
      chatCredits: { rows: 7 },
    },
  });
  assert.equal(
    t.text(),
    lines('  ✓ Copilot Studio credits: 5 rows in the model, 2026-05-01 to 2026-05-31', '  ✓ GitHub Copilot: 1,500 rows in the model', '  ✓ chatCredits: 7 rows in the model'),
  );

  const none = setup();
  printDataCheck(none.ctx, null);
  printDataCheck(none.ctx, {});
  assert.equal(none.text(), '');
});

test('printDataCheck says how many people have a department, and how to fill the gaps when under 80% do', () => {
  assert.equal(LOW_DEPARTMENT_COVERAGE, 0.8);
  const org = (/** @type {number | null | undefined} */ filled, rows = 1200) => ({ tables: { orgData: { table: 'Org', rows, filled } } });

  const enough = setup({ sources: { orgData: 'api' } });
  printDataCheck(enough.ctx, org(960));
  assert.equal(enough.text(), lines('  ✓ Org data: 1,200 rows in the model', '  ✓ Org data: 960 of 1,200 people have a department'));

  const csv = setup({ sources: { orgData: 'csv' } });
  printDataCheck(csv.ctx, org(959));
  assert.equal(
    csv.text(),
    lines(
      '  ✓ Org data: 1,200 rows in the model',
      '  ! Org data: 959 of 1,200 people have a department',
      '    Views by department leave out everyone without one.',
      '    Fill in the Department column in the org data file, then upload it again.',
    ),
  );

  const entra = setup({ sources: { orgData: 'api' } });
  printDataCheck(entra.ctx, org(0));
  assert.equal(
    entra.text(),
    lines(
      '  ✓ Org data: 1,200 rows in the model',
      '  ! Org data: 0 of 1,200 people have a department',
      '    Views by department leave out everyone without one.',
      '    Fill in Department on users in Microsoft Entra ID (or the HR system that feeds it). The next pipeline run picks it up.',
    ),
  );

  const uncounted = setup({ sources: { orgData: 'api' } });
  printDataCheck(uncounted.ctx, org(0, 0));
  printDataCheck(uncounted.ctx, org(undefined));
  printDataCheck(uncounted.ctx, org(null));
  assert.equal(uncounted.text(), lines('  ! Org data: no rows in the model yet', '  ✓ Org data: 1,200 rows in the model', '  ✓ Org data: 1,200 rows in the model'));
});

test('check makes sure the model answers queries, then counts what each source gave it', async () => {
  const lake = fakeLake();
  const t = setup({ oneLake: lake, sources: { orgData: 'api' } });
  t.pbi.answers.push(answer({ '[CalendarDays]': 120 }), answer({ '[coworkCredits]': 1200, '[studioCredits]': 845, '[orgData]': 1200, '[orgDataFilled]': 1200 }));
  assert.equal(await runCommand(t.ctx, 'check', { wait: true }), true);
  assert.deepEqual(t.queries, [MODEL_PROBE, dataCheckQuery(['coworkCredits', 'studioCredits', 'orgData'].map(check))]);
  assert.equal(
    t.text(),
    lines(
      '  ✓ Consumption Central Model answers queries (its Date table has 120 days)',
      '  ✓ Copilot Cowork and Work IQ credits: 1,200 rows in the model',
      '  ✓ Copilot Studio credits: 845 rows in the model',
      '  ✓ Org data: 1,200 rows in the model',
      '  ✓ Org data: 1,200 of 1,200 people have a department',
    ),
  );
  assert.deepEqual([...lake.files.keys()], [`ws-1/lh-1/${DATA_CHECK_FILE}`]);
});

test('check fails when the model has no dates or the count fails, and only warns when it can\'t count', async () => {
  const empty = setup();
  empty.pbi.answers.push(answer({ '[CalendarDays]': 0 }));
  assert.equal(await checkData(empty.ctx), false);
  assert.deepEqual(empty.queries, [MODEL_PROBE], 'nothing is counted once the probe fails');
  assert.match(empty.text(), /✗ Consumption Central Model refreshed, but its Date table is empty, so report pages will fail/);

  const failed = setup();
  failed.pbi.failures.executeQueries = /** @type {Error[]} */ ([undefined, daxError("Query (2, 23) Cannot find table 'CreditsWeekly'.")]);
  assert.equal(await checkData(failed.ctx), false);
  assert.equal(failed.queries.length, 2);
  assert.match(failed.text(), /✗ Data check: the query on Consumption Central Model failed\n {4}Query \(2, 23\) Cannot find table 'CreditsWeekly'\.\n/);

  const unknown = setup();
  unknown.pbi.failures.executeQueries = /** @type {Error[]} */ ([undefined, httpError(500, 'Internal Server Error')]);
  assert.equal(await checkData(unknown.ctx), true);
  assert.match(unknown.text(), /! Couldn't query Consumption Central Model for the data check \(Internal Server Error\)\./);
  assert.doesNotMatch(unknown.text(), /✗/);
});

test('check needs a deployed model, and asks nothing of one that is off, not made or not connected', async () => {
  for (const [state, model] of NOT_DEPLOYED) {
    const t = setup({ model });
    const message = 'There is no semantic model yet. Run the installer first.';
    await assert.rejects(checkData(t.ctx), { message }, state);
    await assert.rejects(runCommand(t.ctx, 'check', { wait: true }), { message }, state);
    assert.deepEqual(t.pbi.calls, [], state);
  }
});

test('only a model that is switched on, made and connected gets the refresh notebook and the pipeline step that refreshes it', () => {
  const { catalog } = realSources();
  const notebookIds = Object.fromEntries(catalog.map((nb) => [nb.key, `nb-${nb.key}`]));
  for (const [state, model] of EVERY_STATE) {
    const { config } = setup({ model });
    config.fabric.notebooks = notebookIds;
    const deployed = state === 'deployed';
    assert.equal(modelDeployed(config), deployed, state);
    assert.deepEqual(notebookOptions(config), { semanticModel: deployed }, state);
    assert.equal(notebooksFor(catalog, deployedSources(config), notebookOptions(config)).some((nb) => nb.key === 'refreshModel'), deployed, state);
    const settings = pipelineSettings(config);
    assert.equal(settings.modelId, deployed ? 'model-1' : undefined, state);
    const acts = buildPipeline(catalog, settings).properties.activities;
    assert.equal(findActivity(acts, REFRESH_ACTIVITY)?.typeProperties.parameters.SEMANTIC_MODEL_ID.value, deployed ? 'model-1' : undefined, state);
    assert.ok(findActivity(acts, STATUS_ACTIVITY), state);
  }
});

test('an update refreshes and checks the model only when it is deployed', async () => {
  const deployed = setup();
  assert.equal(await finishUpdate(deployed.ctx), true);
  assert.deepEqual(deployed.pbi.calls, ['refresh model-1 full', 'getRefresh request-1', 'executeQueries model-1']);
  assert.deepEqual(deployed.queries, [MODEL_PROBE]);
  assert.match(deployed.text(), /The model refreshes now, to load its data with the new definition\./);

  for (const [state, model] of NOT_DEPLOYED) {
    const t = setup({ model });
    assert.equal(await finishUpdate(t.ctx), true, state);
    assert.deepEqual(await verifyModel(t.ctx), { ok: true, skipped: true }, state);
    assert.deepEqual(t.pbi.calls, [], state);
    assert.doesNotMatch(t.text(), /refreshes now/, state);
    assert.match(t.text(), /Up to date\. The next scheduled run uses the new versions\./, state);
  }
});

test('refresh needs a model that was made, and only warns about one not connected to the Lakehouse', async () => {
  const unmade = setup({ model: { id: undefined, bound: false } });
  await assert.rejects(refresh(unmade.ctx, { wait: true }), { message: 'There is no semantic model yet. Run the installer and choose to deploy it.' });
  await assert.rejects(refreshModel(unmade.ctx), { message: 'There is no semantic model yet. Run the installer first.' });

  const unbound = setup({ model: { bound: false } });
  assert.equal(await runCommand(unbound.ctx, 'refresh', { wait: true }), false);
  assert.equal(unbound.text(), lines("  ! Consumption Central Model isn't connected to the Lakehouse yet, so it can't refresh. Run the installer again to connect it."));
  assert.deepEqual([...unmade.pbi.calls, ...unbound.pbi.calls], []);
});

test('a run loaded the data when its model refresh succeeded or, with no model deployed, when every step but the status record did', () => {
  const runs = (/** @type {Record<string, string>} */ statuses) => new Map(Object.entries(statuses).map(([activityName, s]) => [activityName, { activityName, status: s }]));
  const loads = { Run_Consumption_Viva: 'Succeeded', Run_Consumption_Studio: 'Succeeded' };

  const { config } = setup();
  assert.equal(loadedBy(config, runs({ ...loads, [REFRESH_ACTIVITY]: 'Succeeded', [STATUS_ACTIVITY]: 'Failed' })), true);
  assert.equal(loadedBy(config, runs({ ...loads, [REFRESH_ACTIVITY]: 'Failed', [STATUS_ACTIVITY]: 'Succeeded' })), false);
  assert.equal(loadedBy(config, runs(loads)), false, 'the refresh never ran');

  for (const [state, model] of NOT_DEPLOYED) {
    const other = setup({ model }).config;
    assert.equal(loadedBy(other, runs({ ...loads, [STATUS_ACTIVITY]: 'Failed' })), true, state);
    assert.equal(loadedBy(other, runs({ ...loads, Run_Consumption_Studio: 'Failed' })), false, state);
    assert.equal(loadedBy(other, runs({ [STATUS_ACTIVITY]: 'Succeeded' })), false, `${state}: nothing loaded`);
  }
});

test('status suggests a data check after a completed run only when the model is deployed', async () => {
  const jobs = [{ id: 'job-1', status: 'Completed', startTimeUtc: '2026-06-01T10:00:00', endTimeUtc: '2026-06-01T10:40:00', invokeType: 'Scheduled' }];
  const fabric = { listJobs: async () => structuredClone(jobs), queryActivityRuns: async () => [] };
  const suggestion = `\nData check\n    It hasn't run yet. Run "${commandLine('check')}" to see what the pipeline loaded.\n`;
  for (const [state, model] of EVERY_STATE) {
    const t = setup({ model, fabric, oneLake: fakeLake() });
    t.config.fabric.pipelineId = 'pipeline-1';
    await status(t.ctx);
    assert.equal(t.text().includes(suggestion), state === 'deployed', state);
  }
});
