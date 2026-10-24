// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notebooksFor } from '../src/catalog.js';
import { emptyConfig } from '../src/config.js';
import { runCommand } from '../src/install.js';
import { commandLine } from '../src/launch.js';
import { PRODUCT_NAME } from '../src/product.js';
import { ensureLakehouse, ensureNotebooks, ensurePipeline, ensureSchedule, freeName } from '../src/steps/fabric.js';
import { ensureConsent } from '../src/steps/identity.js';
import { connectionName } from '../src/steps/model.js';
import { usesSecret } from '../src/steps/notebook-settings.js';
import { APP_NAME, lakehouseNameFrom, planReview, reserveNames, validateNewLakehouseName } from '../src/steps/plan.js';
import {
  BUSY_RETRIES,
  BUSY_WAIT_MS,
  capacityBusy,
  chooseLoad,
  DATA_CHECK_FILE,
  FIRST_LOAD_ESTIMATE,
  firstRunStatus,
  historyLoaded,
  NETWORK_LOSSES,
  printDataCheck,
  ranSince,
  runDataCheck,
  runOnceNotebooks,
  runPipeline,
  status,
  waitForJob,
} from '../src/steps/run.js';
import { PIPELINE_CHANGE, PIPELINE_VERSION, REFRESH_ACTIVITY } from '../src/transform/pipeline.js';
import { fakeCtx, fakeFabric, fakeGraph as fakeGraphApi, fakePowerBi, fakeUi, httpError, realSources } from './fakes.js';

const { catalog } = realSources();
const defaultNotebooks = notebooksFor(catalog, emptyConfig().dataSources);

/** The model, deployed and reading the Lakehouse. */
const DEPLOYED_MODEL = { enabled: true, id: 'model-1', bound: true };

test('notebooks: first run creates, a re-run changes nothing, update pushes content', async () => {
  assert.deepEqual(
    defaultNotebooks.map((nb) => nb.displayName),
    ['ConsumptionCentral_Upload_Router', 'Ingest_Studio', 'Ingest_Viva_Consumption', 'ConsumptionCentral_Load_Status'],
  );
  const fabric = fakeFabric();
  const { ctx, config } = fakeCtx({ fabric: fabric.api });

  await ensureNotebooks(ctx);
  assert.deepEqual(
    fabric.calls,
    defaultNotebooks.map((nb) => `createNotebook ${nb.displayName}`),
  );
  for (const nb of defaultNotebooks) assert.ok(config.fabric.notebooks[nb.key], `${nb.key} is recorded`);
  for (const item of fabric.items) {
    assert.match(item.content, /"default_lakehouse": "lh-1"/, `${item.displayName} is attached to the Lakehouse`);
    assert.doesNotMatch(item.content, /"default_lakehouse": "00000000/);
  }

  fabric.calls.length = 0;
  await ensureNotebooks(ctx);
  assert.deepEqual(fabric.calls, [], 'nothing to do on a re-run');

  await ensureNotebooks(ctx, { force: true });
  assert.deepEqual(
    fabric.calls,
    defaultNotebooks.map((nb) => `updateNotebook ${nb.displayName}`),
  );
});

test('notebooks: a re-run from a newer release pushes changed notebooks', async () => {
  const fabric = fakeFabric();
  const { ctx, config } = fakeCtx({ fabric: fabric.api });
  config.dataSources.orgData = 'api';
  await ensureNotebooks(ctx);
  const all = notebooksFor(catalog, config.dataSources);
  assert.ok(all.some((nb) => usesSecret(config, nb)), 'the org data load reads the secret from Key Vault, so it is hashed too');
  assert.deepEqual(Object.keys(config.fabric.notebookHashes ?? {}).sort(), all.map((nb) => nb.key).sort());
  const org = fabric.items.find((i) => i.displayName === 'Ingest_Org_Graph');
  assert.match(org?.content, /notebookutils\.credentials\.getSecret\('https:\/\/kv-test\.vault\.azure\.net\/', 'consumption-central-client-secret'\)/);
  assert.match(org?.content, /tenant-1/);

  delete config.fabric.notebookHashes;
  fabric.calls.length = 0;
  await ensureNotebooks(ctx);
  assert.deepEqual(fabric.calls, all.map((nb) => `updateNotebook ${nb.displayName}`), 'a record from an older installer');

  fabric.calls.length = 0;
  /** @type {any} */ (config.fabric.notebookHashes)[all[0].key] = 'older';
  await ensureNotebooks(ctx);
  assert.deepEqual(fabric.calls, [`updateNotebook ${all[0].displayName}`]);

  fabric.calls.length = 0;
  await ensureNotebooks(ctx);
  assert.deepEqual(fabric.calls, [], 'the same version is left in place');
});

test('notebooks: with the secret in the notebooks, only those without it are hashed', async () => {
  const fabric = fakeFabric();
  const graph = fakeGraphApi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, graph: graph.api });
  config.dataSources.orgData = 'api';
  config.keyVault = { secretName: 'consumption-central-client-secret', mode: 'notebook' };
  await ensureNotebooks(ctx);
  const all = notebooksFor(catalog, config.dataSources);
  const plain = all.filter((nb) => !usesSecret(config, nb));
  assert.ok(plain.length > 0 && plain.length < all.length);
  assert.deepEqual(Object.keys(config.fabric.notebookHashes ?? {}).sort(), plain.map((nb) => nb.key).sort());
  assert.match(fabric.items.find((i) => i.displayName === 'Ingest_Org_Graph')?.content, /CLIENT_SECRET = 'secret-1'/);
  assert.doesNotMatch(JSON.stringify(config), /secret-1/);

  delete config.fabric.notebookHashes;
  fabric.calls.length = 0;
  graph.calls.length = 0;
  await ensureNotebooks(ctx);
  assert.deepEqual(fabric.calls, plain.map((nb) => `updateNotebook ${nb.displayName}`));
  assert.deepEqual(graph.calls, [], 'no new secret is made');
});

test('notebooks: a deleted one is deployed again; one with the same name that is not ours is left alone', async () => {
  const fabric = fakeFabric();
  const mine = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: mine.ui });
  await ensureNotebooks(ctx);

  const gone = fabric.items.findIndex((i) => i.displayName === 'ConsumptionCentral_Load_Status');
  fabric.items.splice(gone, 1);
  fabric.calls.length = 0;
  await ensureNotebooks(ctx);
  assert.deepEqual(fabric.calls, ['createNotebook ConsumptionCentral_Load_Status']);
  assert.ok(config.fabric.notebooks.loadStatus);
  assert.match(mine.text(), /ConsumptionCentral_Load_Status was deleted\. Deploying it again\./);

  const other = fakeFabric();
  const theirs = other.add('Notebook', 'Ingest_Viva_Consumption', 'theirs');
  const ui = fakeUi();
  const shared = fakeCtx({ fabric: other.api, ui: ui.ui });
  await ensureNotebooks(shared.ctx);
  assert.deepEqual(ui.asked, [], 'never asks to replace it');
  assert.notEqual(shared.config.fabric.notebooks.vivaConsumption, theirs.id);
  assert.equal(theirs.content, 'theirs');
  assert.equal(theirs.displayName, 'Ingest_Viva_Consumption');
  assert.ok(other.calls.includes('createNotebook Ingest_Viva_Consumption_2'));
  assert.ok(!other.calls.some((c) => c.startsWith('updateNotebook')));
  assert.equal(shared.config.fabric.notebookNames?.vivaConsumption, 'Ingest_Viva_Consumption_2');
  assert.match(ui.text(), /"Ingest_Viva_Consumption" is already in the workspace and isn't from this install/);

  other.calls.length = 0;
  await ensureNotebooks(shared.ctx, { force: true });
  assert.ok(other.calls.includes('updateNotebook Ingest_Viva_Consumption_2'));
  assert.ok(!other.calls.includes('updateNotebook Ingest_Viva_Consumption'));
});

test('freeName: numbers a clash, with a space for names that have spaces', () => {
  assert.equal(freeName('ConsumptionCentral', []), 'ConsumptionCentral');
  assert.equal(freeName('ConsumptionCentral', ['consumptioncentral']), 'ConsumptionCentral_2');
  assert.equal(freeName('ConsumptionCentral', ['ConsumptionCentral', 'ConsumptionCentral_2']), 'ConsumptionCentral_3');
  assert.equal(freeName('Consumption Central Model', ['Consumption Central Model']), 'Consumption Central Model 2');
});

test('plan: a new Lakehouse needs a name no Lakehouse in the workspace has', () => {
  const check = validateNewLakehouseName(['ConsumptionCentral']);
  assert.match(String(check(' consumptioncentral ')), /already a Lakehouse called consumptioncentral here\. Consumption Central only writes to a Lakehouse it creates/);
  assert.equal(check('ConsumptionCentral_2'), true);
  assert.match(String(check('2bad')), /Start with a letter/);
});

test('plan: spaces and hyphens in a Lakehouse name become underscores', () => {
  assert.equal(lakehouseNameFrom('My Lakehouse'), 'My_Lakehouse');
  assert.equal(lakehouseNameFrom(' my-lake  house '), 'my_lake_house');
  assert.equal(validateNewLakehouseName([])('My Lakehouse'), true);
  const check = validateNewLakehouseName(['My_Lakehouse']);
  assert.match(String(check('my lakehouse')), /already a Lakehouse called my_lakehouse here/);
  assert.match(String(check('My Lake!')), /only letters, numbers and underscores/);
});

test('plan: new items get names nothing in the workspace has; a name someone chose stays', async () => {
  const fabric = fakeFabric();
  fabric.add('Notebook', 'Ingest_Viva_Consumption', null);
  fabric.add('DataPipeline', 'ConsumptionCentral_Pipeline', null);
  fabric.add('SemanticModel', 'Consumption Central Model', null);
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  config.semanticModel.enabled = true;

  await reserveNames(ctx);
  assert.equal(fabric.calls.length, 0, 'planning changes nothing');
  assert.equal(config.fabric.notebookNames?.vivaConsumption, 'Ingest_Viva_Consumption_2');
  assert.equal(config.fabric.notebookNames?.studioConsumption, 'Ingest_Studio');
  assert.equal(config.fabric.pipelineName, 'ConsumptionCentral_Pipeline_2');
  assert.equal(config.semanticModel.name, 'Consumption Central Model 2');
  assert.match(ui.text(), /already has "Ingest_Viva_Consumption", "ConsumptionCentral_Pipeline", "Consumption Central Model", not from this install/);
  const review = planReview(ctx);
  assert.match(String(review.creates.find((i) => i.kind === 'Notebooks')?.detail), /Ingest_Viva_Consumption_2/);
  assert.equal(review.creates.find((i) => i.kind === 'Pipeline')?.name, 'ConsumptionCentral_Pipeline_2');

  fabric.items.length = 0;
  config.semanticModel.name = 'Contoso Model';
  await reserveNames(ctx);
  assert.equal(config.fabric.notebookNames?.vivaConsumption, 'Ingest_Viva_Consumption', 'back to the usual name once it is free');
  assert.equal(config.fabric.pipelineName, 'ConsumptionCentral_Pipeline');
  assert.equal(config.semanticModel.name, 'Contoso Model');

  await ensureNotebooks(ctx);
  assert.ok(fabric.calls.includes('createNotebook Ingest_Viva_Consumption'));
});

test('planReview: lists what adds to the bill with pricing links and no prices', () => {
  const { ctx, config } = fakeCtx();
  const what = () => (planReview(ctx).costs ?? []).map((x) => x.what);
  assert.deepEqual(what(), ['Fabric capacity'], 'uploads alone need no app, so no vault');
  config.dataSources.orgData = 'api';
  assert.deepEqual(what(), ['Fabric capacity', 'Azure Key Vault'], 'the app secret goes in a vault');
  config.dataSources.studioCredits = 'api';
  assert.deepEqual(what(), ['Fabric capacity', 'Power Automate Premium', 'Azure Key Vault'], 'flows need Premium');
  for (const x of planReview(ctx).costs ?? []) {
    assert.match(x.url, /^https:\/\//);
    assert.doesNotMatch(`${x.what} ${x.detail}`, /[$£€]\s?\d/, 'no hard-coded prices');
  }
  const t = fakeUi();
  t.ui.review(planReview(ctx));
  assert.match(t.text(), /Costs: +Fabric capacity https:\/\/azure\.microsoft\.com\/pricing\/details\/microsoft-fabric\/\n +Power Automate Premium https:\/\/www\.microsoft\.com\/power-platform\/products\/power-automate\/pricing/);

  config.keyVault.mode = 'notebook';
  assert.ok(!what().includes('Azure Key Vault'), 'no vault when the secret is in the notebooks');
});

test('lakehouse: never writes to one it did not create', async () => {
  const fabric = fakeFabric();
  const theirs = fabric.add('Lakehouse', 'ConsumptionCentral', null);
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  delete config.fabric.lakehouseId;
  delete config.fabric.lakehouseName;
  await ensureLakehouse(ctx);
  assert.deepEqual(fabric.calls, ['createLakehouse ConsumptionCentral_2']);
  assert.notEqual(config.fabric.lakehouseId, theirs.id);
  assert.equal(config.fabric.lakehouseName, 'ConsumptionCentral_2');
  assert.match(ui.text(), /"ConsumptionCentral" is already in the workspace/);
});

test('pipeline: one with the same name that is not ours is left alone', async () => {
  const fabric = fakeFabric();
  const theirs = fabric.add('DataPipeline', 'ConsumptionCentral_Pipeline', 'theirs');
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  await ensureNotebooks(ctx);
  fabric.calls.length = 0;
  await ensurePipeline(ctx);
  assert.deepEqual(ui.asked, []);
  assert.deepEqual(fabric.calls, ['createPipeline ConsumptionCentral_Pipeline_2']);
  assert.equal(theirs.content, 'theirs');
  assert.notEqual(config.fabric.pipelineId, theirs.id);
  assert.equal(config.fabric.pipelineName, 'ConsumptionCentral_Pipeline_2');
});

test('names: new installs use Consumption Central names; a record without names keeps the names its items have', async () => {
  const config = emptyConfig();
  assert.equal(config.semanticModel.name, 'Consumption Central Model');
  assert.equal(APP_NAME, 'Consumption Central (Fabric)');
  assert.equal(connectionName('12345678-aaaa'), 'Consumption Central SQL 12345678');

  const fabric = fakeFabric();
  const ui = fakeUi();
  const old = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  await ensureNotebooks(old.ctx);
  const record = /** @type {string} */ (old.config.fabric.notebooks.loadStatus);
  const item = fabric.items.find((i) => i.id === record);
  if (item) item.displayName = 'Contoso_Load_Status';
  old.config.fabric.notebookNames = {};
  old.config.fabric.pipelineId = fabric.add('DataPipeline', 'Contoso_Pipeline', {}).id;
  delete old.config.fabric.pipelineName;
  fabric.calls.length = 0;
  await ensureNotebooks(old.ctx, { force: true });
  await ensurePipeline(old.ctx);
  assert.equal(old.config.fabric.notebookNames.loadStatus, 'Contoso_Load_Status');
  assert.equal(old.config.fabric.pipelineName, 'Contoso_Pipeline');
  assert.ok(fabric.calls.includes('updateNotebook Contoso_Load_Status'));
  assert.ok(fabric.calls.includes('updatePipeline Contoso_Pipeline'));
  assert.ok(!fabric.calls.some((c) => c.startsWith('create')), 'nothing is created under the new names');
});

test('pipeline: created once, left alone on re-run, updated when the sources change', async () => {
  const fabric = fakeFabric();
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  await ensureNotebooks(ctx);
  fabric.calls.length = 0;

  await ensurePipeline(ctx);
  assert.deepEqual(fabric.calls, ['createPipeline ConsumptionCentral_Pipeline']);
  const pipeline = fabric.items.find((i) => i.type === 'DataPipeline');
  assert.equal(config.fabric.pipelineId, pipeline?.id, 'ID found by name when the create returns no body');
  assert.equal(config.fabric.pipelineModules, 'uploadRouter,studioConsumption,vivaConsumption,loadStatus');
  const json = JSON.stringify(pipeline?.content);
  assert.doesNotMatch(json, /REPLACE_WITH_/);
  assert.match(json, new RegExp(config.fabric.notebooks.studioConsumption ?? 'missing'));

  fabric.calls.length = 0;
  await ensurePipeline(ctx);
  assert.deepEqual(fabric.calls, []);

  config.dataSources.studioCredits = 'skip';
  await ensurePipeline(ctx);
  assert.deepEqual(fabric.calls, ['updatePipeline ConsumptionCentral_Pipeline']);
  assert.equal(config.fabric.pipelineModules, 'uploadRouter,vivaConsumption,loadStatus');
  assert.match(ui.text(), /replaces the pipeline definition/);
});

test('pipeline: rewritten when a deleted notebook comes back with a new ID', async () => {
  const fabric = fakeFabric();
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  await ensureNotebooks(ctx);
  await ensurePipeline(ctx);
  const old = /** @type {string} */ (config.fabric.notebooks.studioConsumption);
  fabric.items.splice(fabric.items.findIndex((i) => i.id === old), 1);

  await ensureNotebooks(ctx);
  assert.notEqual(config.fabric.notebooks.studioConsumption, old);
  fabric.calls.length = 0;
  await ensurePipeline(ctx);
  assert.deepEqual(fabric.calls, ['updatePipeline ConsumptionCentral_Pipeline']);
  assert.equal(config.fabric.pipelineModules, 'uploadRouter,studioConsumption,vivaConsumption,loadStatus');
});

test('pipeline: declining an update keeps the old module signature', async () => {
  const fabric = fakeFabric();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: fakeUi({ answers: [false] }).ui });
  await ensureNotebooks(ctx);
  config.fabric.pipelineId = fabric.add('DataPipeline', 'ConsumptionCentral_Pipeline', {}).id;
  config.fabric.pipelineName = 'ConsumptionCentral_Pipeline';
  config.fabric.pipelineModules = 'uploadRouter';
  fabric.calls.length = 0;

  await ensurePipeline(ctx, { force: true });
  assert.deepEqual(fabric.calls, []);
  assert.equal(config.fabric.pipelineModules, 'uploadRouter');
  assert.equal(config.fabric.pipelineVersion, undefined, 'so the next run offers the update again');
});

test('pipeline: one an older installer built is updated, saying what changed', async () => {
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
  assert.deepEqual(fabric.calls, ['updatePipeline ConsumptionCentral_Pipeline']);
  assert.ok(ui.text().includes(PIPELINE_CHANGE));
  assert.equal(config.fabric.pipelineVersion, PIPELINE_VERSION);

  fabric.calls.length = 0;
  await ensurePipeline(ctx);
  assert.deepEqual(fabric.calls, [], 'nothing to do once it is up to date');
});

test('schedule: created, unchanged on re-run, updated when the time changes, adopted if one exists', async () => {
  const fabric = fakeFabric();
  const { ctx, config } = fakeCtx({ fabric: fabric.api });
  config.fabric.pipelineId = 'pipe-1';

  await ensureSchedule(ctx);
  assert.deepEqual(fabric.calls, ['createSchedule']);
  assert.equal(config.fabric.scheduleId, fabric.schedules[0].id);
  assert.equal(fabric.schedules[0].configuration.startDateTime, '2026-06-02T00:00:00');

  await ensureSchedule(ctx);
  assert.deepEqual(fabric.calls, ['createSchedule']);

  config.schedule = { frequency: 'weekly', time: '05:00', weekday: 'Monday', timeZone: 'UTC' };
  await ensureSchedule(ctx);
  assert.deepEqual(fabric.calls, ['createSchedule', 'updateSchedule']);
  assert.deepEqual(fabric.schedules[0].configuration.weekdays, ['Monday']);

  const other = fakeFabric();
  other.schedules.push({ id: 'theirs', enabled: true, configuration: { type: 'Daily', times: ['09:00'] } });
  const adopt = fakeCtx({ fabric: other.api });
  adopt.config.fabric.pipelineId = 'pipe-2';
  await ensureSchedule(adopt.ctx);
  assert.deepEqual(other.calls, []);
  assert.equal(adopt.config.fabric.scheduleId, 'theirs');
});

/**
 * @param {string[]} have  App role IDs already assigned.
 * @param {{ revoke?: (assignmentId: string) => void }} [o]  Runs before an assignment is removed, and can throw.
 */
function fakeGraph(have, o = {}) {
  /** @type {string[]} */
  const granted = [];
  /** @type {string[]} App role IDs whose assignment was removed. */
  const revoked = [];
  const graphSp = {
    id: 'graph-sp',
    appRoles: [
      { id: 'r-audit', value: 'AuditLogsQuery.Read.All' },
      { id: 'r-reports', value: 'Reports.Read.All' },
      { id: 'r-users', value: 'User.Read.All' },
      { id: 'r-org', value: 'Organization.Read.All' },
      { id: 'r-sites', value: 'Sites.Selected' },
      { id: 'r-apps', value: 'Application.Read.All' },
      { id: 'r-packages', value: 'CopilotPackages.Read.All' },
    ],
  };
  const api = {
    graphServicePrincipal: async () => graphSp,
    appRoleAssignments: async () =>
      [...have, ...granted].filter((appRoleId) => !revoked.includes(appRoleId)).map((appRoleId) => ({ id: `a-${appRoleId}`, resourceId: 'graph-sp', appRoleId })),
    /** @param {string} _r @param {string} _p @param {string} role */
    grantAppRole: async (_r, _p, role) => {
      granted.push(role);
    },
    /** @param {string} resourceId @param {string} assignmentId */
    revokeAppRole: async (resourceId, assignmentId) => {
      assert.equal(resourceId, 'graph-sp');
      o.revoke?.(assignmentId);
      revoked.push(assignmentId.replace(/^a-/, ''));
    },
  };
  return { api, granted, revoked };
}

/**
 * A PAX install's context, with an app the installer made.
 * @param {any} graph
 * @param {import('../src/ui.js').Ui} [ui]
 */
function paxConsentCtx(graph, ui) {
  const made = fakeCtx({ graph, ui });
  made.config.target = 'pax';
  return made;
}

test('consent: an admin grants only what the chosen sources need', async () => {
  const graph = fakeGraph(['r-audit']);
  const { ctx, config } = fakeCtx({ graph: graph.api });
  config.dataSources.orgData = 'api';
  assert.equal(await ensureConsent(ctx, { canConsent: true }), true);
  assert.deepEqual(graph.granted, ['r-users']);

  const ui = fakeUi();
  const again = fakeCtx({ graph: graph.api, ui: ui.ui });
  again.config.dataSources.orgData = 'api';
  assert.equal(await ensureConsent(again.ctx, { canConsent: true }), true);
  assert.deepEqual(graph.granted, ['r-users']);
  assert.match(ui.text(), /Admin consent is in place \(User\.Read\.All\)/);
});

test('consent: without admin rights the user gets a link, and can check again', async () => {
  const graph = fakeGraph([]);
  const quiet = fakeUi({ yes: true });
  const unattended = fakeCtx({ graph: graph.api, ui: quiet.ui });
  unattended.config.dataSources.orgData = 'api';
  assert.equal(await ensureConsent(unattended.ctx, { canConsent: false }), false);
  assert.match(quiet.text(), /needs to approve: User\.Read\.All/);
  assert.match(quiet.text(), /CallAnAPI\/appId\/app-1/);
  assert.match(quiet.text(), /login\.microsoftonline\.com\/tenant-1\/adminconsent\?client_id=app-1/);
  assert.deepEqual(graph.granted, []);

  const ui = fakeUi();
  /** @type {any} */ (ui.ui).select = async () => {
    // An admin approves in the portal while the installer waits.
    graph.granted.push('r-users');
    return 'check';
  };
  const { ctx, config } = fakeCtx({ graph: graph.api, ui: ui.ui });
  config.dataSources.orgData = 'api';
  assert.equal(await ensureConsent(ctx, { canConsent: false }), true);
  assert.match(ui.text(), /needs to approve/);
  assert.match(ui.text(), /Admin consent is in place/);

  const skip = fakeCtx({ graph: fakeGraph([]).api, ui: fakeUi({ answers: ['skip'] }).ui });
  skip.config.dataSources.orgData = 'api';
  assert.equal(await ensureConsent(skip.ctx, { canConsent: false }), false);
});

// Consumption Central's Fabric route needs one Graph permission at most, so the PAX route's app,
// which needs three, shows an admin granting only the ones missing.
test('consent: an admin grants only what is missing', async () => {
  const graph = fakeGraph(['r-users']);
  const { ctx } = paxConsentCtx(graph.api);
  assert.equal(await ensureConsent(ctx, { canConsent: true }), true);
  assert.deepEqual(graph.granted, ['r-org', 'r-sites']);

  const ui = fakeUi();
  const again = paxConsentCtx(graph.api, ui.ui);
  assert.equal(await ensureConsent(again.ctx, { canConsent: true }), true);
  assert.deepEqual(graph.granted, ['r-org', 'r-sites']);
  assert.deepEqual(graph.revoked, []);
  assert.match(ui.text(), /Admin consent is in place \(Organization\.Read\.All, Sites\.Selected, User\.Read\.All\)/);
});

test('consent: an app the installer made loses the consent for permissions it no longer uses', async () => {
  // On the PAX route, Application.Read.All and CopilotPackages.Read.All are for the Agent 365 file and
  // AuditLogsQuery.Read.All is for PAX's audit mode; Consumption Central runs PAX for the org file only.
  const used = ['r-org', 'r-sites', 'r-users'];
  const tookBack = (/** @type {string} */ names, /** @type {string} */ them) => `Took back admin consent for ${names}, as ${PRODUCT_NAME} no longer uses ${them}`;

  const graph = fakeGraph([...used, 'r-apps', 'r-packages']);
  const ui = fakeUi();
  assert.equal(await ensureConsent(paxConsentCtx(graph.api, ui.ui).ctx, { canConsent: true }), true);
  assert.deepEqual(graph.revoked, ['r-apps', 'r-packages']);
  assert.deepEqual(graph.granted, []);
  assert.ok(ui.text().includes(tookBack('Application.Read.All, CopilotPackages.Read.All', 'them')), ui.text());
  assert.match(ui.text(), /Admin consent is in place/);
  assert.doesNotMatch(ui.text(), /still has admin consent/);

  // Missing roles are still granted in the same run.
  const both = fakeGraph(['r-users', 'r-audit']);
  const mixed = fakeUi();
  assert.equal(await ensureConsent(paxConsentCtx(both.api, mixed.ui).ctx, { canConsent: true }), true);
  assert.deepEqual(both.revoked, ['r-audit']);
  assert.deepEqual(both.granted, ['r-org', 'r-sites']);
  assert.ok(mixed.text().includes(tookBack('AuditLogsQuery.Read.All', 'it')), mixed.text());

  // An app the user brought keeps what it has.
  const theirs = fakeGraph([...used, 'r-packages']);
  const brought = paxConsentCtx(theirs.api, fakeUi().ui);
  brought.config.app.existing = true;
  assert.equal(await ensureConsent(brought.ctx, { canConsent: true }), true);
  assert.deepEqual(theirs.revoked, []);

  // So does the Fabric route's app: Consumption Central's Fabric route has no choice that drops a permission.
  const fabric = fakeGraph(['r-users', 'r-audit', 'r-reports']);
  const fabricUi = fakeUi();
  const onFabric = fakeCtx({ graph: fabric.api, ui: fabricUi.ui });
  onFabric.config.dataSources.orgData = 'api';
  assert.equal(await ensureConsent(onFabric.ctx, { canConsent: true }), true);
  assert.deepEqual(fabric.revoked, []);
  assert.doesNotMatch(fabricUi.text(), /Took back|still has admin consent/);

  // Without the rights to, it says what's left and where an admin removes it.
  const stays = fakeGraph([...used, 'r-packages']);
  const told = fakeUi();
  assert.equal(await ensureConsent(paxConsentCtx(stays.api, told.ui).ctx, { canConsent: false }), true);
  assert.deepEqual(stays.revoked, []);
  assert.ok(told.text().includes(`The app still has admin consent for CopilotPackages.Read.All, which ${PRODUCT_NAME} no longer uses.`), told.text());
  assert.match(told.text(), /CallAnAPI\/appId\/app-1/);

  // An assignment already gone counts as taken back; another refusal is left with the link.
  const gone = fakeGraph([...used, 'r-packages'], { revoke: () => { throw httpError(404); } });
  const goneUi = fakeUi();
  assert.equal(await ensureConsent(paxConsentCtx(gone.api, goneUi.ui).ctx, { canConsent: true }), true);
  assert.ok(goneUi.text().includes(tookBack('CopilotPackages.Read.All', 'it')), goneUi.text());
  assert.doesNotMatch(goneUi.text(), /still has admin consent/);

  const refused = fakeGraph([...used, 'r-apps', 'r-packages'], { revoke: (id) => { if (id === 'a-r-apps') throw httpError(403, 'Forbidden'); } });
  const refusedUi = fakeUi();
  assert.equal(await ensureConsent(paxConsentCtx(refused.api, refusedUi.ui).ctx, { canConsent: true }), true);
  assert.deepEqual(refused.revoked, ['r-packages']);
  assert.ok(refusedUi.text().includes(tookBack('CopilotPackages.Read.All', 'it')), refusedUi.text());
  assert.ok(refusedUi.text().includes(`The app still has admin consent for Application.Read.All, which ${PRODUCT_NAME} no longer uses.`), refusedUi.text());
  assert.match(refusedUi.text(), /CallAnAPI\/appId\/app-1/);

  // Anything that isn't Graph refusing is a bug, and stops the run.
  const broken = fakeGraph([...used, 'r-packages'], { revoke: () => { throw new TypeError('boom'); } });
  await assert.rejects(ensureConsent(paxConsentCtx(broken.api, fakeUi().ui).ctx, { canConsent: true }), /boom/);
});

test('waitForJob polls until the job ends', async () => {
  const fabric = fakeFabric();
  fabric.jobs.push({ status: 'NotStarted' }, { status: 'InProgress' }, { status: 'Completed' });
  const { ctx, sleeps } = fakeCtx({ fabric: fabric.api });
  const job = await waitForJob(ctx, 'https://x/jobs/instances/j', 'Pipeline', { pollMs: 5 });
  assert.equal(job.status, 'Completed');
  assert.deepEqual(sleeps, [5, 5]);
});

test('waitForJob keeps watching through a network blip, and gives up on other errors', async () => {
  const fabric = fakeFabric();
  fabric.jobs.push({ status: 'InProgress' }, { status: 'Completed' });
  const getJob = fabric.api.getJob;
  let blips = 2;
  fabric.api.getJob = async () => {
    if (blips-- > 0) throw new Error("HTTPSConnectionPool: Failed to resolve 'login.microsoftonline.com' ([Errno 11001] getaddrinfo failed)");
    return getJob();
  };
  const { ctx, sleeps } = fakeCtx({ fabric: fabric.api });
  const job = await waitForJob(ctx, 'https://x/jobs/instances/j', 'Pipeline', { pollMs: 5 });
  assert.equal(job.status, 'Completed');
  assert.deepEqual(sleeps, [5, 5, 5]);

  fabric.api.getJob = async () => {
    throw new Error('GET /jobs returned 404');
  };
  await assert.rejects(waitForJob(ctx, 'https://x/jobs/instances/j', 'Pipeline', { pollMs: 5 }), /returned 404/);

  fabric.api.getJob = async () => {
    throw new Error('fetch failed');
  };
  sleeps.length = 0;
  await assert.rejects(waitForJob(ctx, 'https://x/jobs/instances/j', 'Pipeline', { pollMs: 5 }), /Lost the connection while watching the pipeline\. It carries on in Fabric/);
  assert.equal(sleeps.length, NETWORK_LOSSES);
});

/** What Fabric says when a trial capacity can't start another notebook. */
const BUSY =
  "Notebook execution failed at Notebook service with http status code - '430', please check the Run logs on Notebook, additional details - 'Error name - Exception, Error value - Failed to create Livy session for executing notebook. Error: [TooManyRequestsForCapacity] This spark job can't be run because you have hit a spark compute or API rate limit.'";

/**
 * An activity run, as Fabric lists it.
 * @param {string} activityName
 * @param {string} status
 * @param {string} [activityRunStart]
 * @param {any} [more]
 */
const activity = (activityName, status, activityRunStart = '2026-06-01T12:00:00Z', more = {}) => ({
  activityName,
  activityType: activityName.startsWith('Conditionally_') ? 'IfCondition' : 'TridentNotebook',
  status,
  activityRunStart,
  ...more,
});

test('the first load records the job and reports each load', async () => {
  const fabric = fakeFabric();
  fabric.jobs.push({ status: 'InProgress' }, { status: 'Completed', startTimeUtc: '2026-06-01T12:00:00', endTimeUtc: '2026-06-01T12:21:30' });
  fabric.activityRuns['job-1'] = [activity('Run_Upload_Router', 'Succeeded'), activity('Run_Consumption_Studio', 'Succeeded'), activity('Run_Consumption_Viva', 'Succeeded')];
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  config.fabric.pipelineId = 'pipe-1';

  const result = await runPipeline(ctx, { wait: true, first: true });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'Completed');
  assert.deepEqual(fabric.calls, ['runJob Pipeline'], 'the first load runs the pipeline as scheduled runs do');
  assert.equal(config.firstRun?.jobId, result.jobId);
  assert.equal(config.firstRun?.startedAt, '2026-06-01T12:00:00.000Z');
  assert.equal(config.firstRun?.status, 'Completed');
  assert.ok(config.firstRun?.finishedAt);
  const text = ui.text();
  assert.match(text, /✓ Started the first load/);
  assert.ok(text.includes(FIRST_LOAD_ESTIMATE));
  assert.match(text, /Pipeline finished in 21m 30s/);
  assert.match(text, /✓ Uploaded CSV exports\n/);
  assert.match(text, /✓ Copilot Studio credits\n/);
  assert.match(text, /✓ Cowork and Work IQ credits\n/);
});

test('a first load that leaves the Cowork Dataflow out says so to the pipeline and in its record', async () => {
  const fabric = fakeFabric();
  fabric.jobs.push({ status: 'Completed' });
  const { ctx, config } = fakeCtx({ fabric: fabric.api });
  config.fabric.pipelineId = 'pipe-1';

  await runPipeline(ctx, { wait: true, first: true, skipCowork: true });
  assert.deepEqual(fabric.calls, ['runJob Pipeline {"parameters":{"SkipCowork":true}}']);
  assert.equal(config.firstRun?.coworkSkipped, true);

  await runPipeline(ctx, { wait: false });
  assert.equal(fabric.calls.at(-1), 'runJob Pipeline', 'other runs refresh it');
});

test('a failed run says why; --no-wait returns straight away', async () => {
  const fabric = fakeFabric();
  fabric.jobs.push({ status: 'Failed', failureReason: { errorCode: 'X', message: 'AADSTS7000215: Invalid client secret' } });
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  config.fabric.pipelineId = 'pipe-1';
  const failed = await runPipeline(ctx, { wait: true });
  assert.equal(failed.ok, false);
  assert.match(ui.text(), /Pipeline failed/);
  assert.match(ui.text(), /Invalid client secret/);
  assert.equal(config.firstRun, undefined);

  const later = await runPipeline(ctx, { wait: false });
  assert.equal(later.status, 'NotStarted');
  assert.equal(fabric.calls.at(-1), 'runJob Pipeline');
});

test('capacityBusy spots a busy capacity, and nothing else', () => {
  assert.equal(capacityBusy({ errorCode: '430' }), true);
  assert.equal(capacityBusy({ errorCode: 'RequestExecutionFailed', message: BUSY }), true);
  assert.equal(capacityBusy({ message: 'TooManyRequestsForCapacity' }), true);
  assert.equal(capacityBusy({ message: 'HTTP status code: 430' }), true);
  assert.equal(capacityBusy({ message: 'Read 430 rows' }), false);
  assert.equal(capacityBusy({ errorCode: '4301', message: 'code 4301' }), false);
  assert.equal(capacityBusy({ errorCode: 'X', message: 'AADSTS7000215: Invalid client secret' }), false);
  assert.equal(capacityBusy(null), false);
});

test('a run that completed with a failed load says which, and still checks the data', async () => {
  const fabric = fakeFabric();
  fabric.jobs.push({ status: 'Completed', startTimeUtc: '2026-06-01T12:00:00', endTimeUtc: '2026-06-01T12:30:00' });
  fabric.activityRuns['job-1'] = [
    activity('Run_Upload_Router', 'Succeeded'),
    activity('Conditionally_Refresh_Cowork_Credits', 'Succeeded', '2026-06-01T12:01:00Z'),
    activity('Run_Org_Data', 'Failed', '2026-06-01T12:05:05Z', { error: { errorCode: '2011', message: 'Forbidden' } }),
    activity(REFRESH_ACTIVITY, 'Succeeded', '2026-06-01T12:20:00Z'),
  ];
  const powerBi = fakePowerBi();
  powerBi.answers.push({
    results: [
      {
        tables: [
          {
            rows: [
              {
                '[coworkCredits]': 0,
                '[studioCredits]': 1250,
                '[studioCreditsFrom]': '2026-03-01T00:00:00',
                '[studioCreditsTo]': '2026-05-31T00:00:00',
                '[orgData]': 1200,
                '[orgDataFilled]': 1150,
              },
            ],
          },
        ],
      },
    ],
  });
  /** @type {string[]} */
  const writes = [];
  const oneLake = {
    /** @param {string} ws @param {string} lh @param {string} path */
    writeFile: async (ws, lh, path) => {
      writes.push(`${ws}/${lh}/${path}`);
    },
  };
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, powerBi: powerBi.api, oneLake, ui: ui.ui });
  config.fabric.pipelineId = 'pipe-1';
  config.fabric.pipelineName = 'ConsumptionCentral_Pipeline';
  config.dataSources.orgData = 'api';
  Object.assign(config.semanticModel, DEPLOYED_MODEL);
  config.firstRun = { jobId: 'job-0', status: 'Completed' };

  assert.equal(await runCommand(ctx, 'run', { wait: true }), false);
  const text = ui.text();
  assert.match(text, /✓ Pipeline finished in 30m/);
  assert.match(text, /✗ Org data: failed/);
  assert.match(text, /couldn't sign in/);
  assert.match(text, /then run "consumption-central-installer rerun-failed"\./);
  assert.doesNotMatch(text, /Conditionally/);
  assert.deepEqual(fabric.calls, ['runJob Pipeline']);
  assert.deepEqual(powerBi.calls, ['executeQueries model-1'], 'the data check still runs');
  assert.deepEqual(writes, [`ws-1/lh-1/${DATA_CHECK_FILE}`]);
  assert.match(text, /✓ Copilot Studio credits: 1,250 rows in the model, 2026-03-01 to 2026-05-31/);
  assert.match(text, /! Copilot Cowork and Work IQ credits: no rows in the model yet/);
  assert.match(text, /✓ Org data: 1,150 of 1,200 people have a department/);
});

test('a run a busy capacity turned away says to wait and run it again', async () => {
  const fabric = fakeFabric();
  fabric.jobs.push({ status: 'Failed', failureReason: { errorCode: 'RequestExecutionFailed', message: BUSY } });
  fabric.activityRuns['job-1'] = [
    activity('Run_Consumption_Studio', 'Failed', '2026-06-01T12:00:00Z', { error: { errorCode: '430', message: BUSY } }),
    activity('Run_Upload_Router', 'Succeeded'),
  ];
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  config.fabric.pipelineId = 'pipe-1';

  const result = await runPipeline(ctx, { wait: true });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, ['Run_Consumption_Studio']);
  const text = ui.text();
  assert.match(text, /✗ Copilot Studio credits: failed/);
  assert.match(text, /capacity was too busy to start it\.\n.*Nothing is lost\. Run "consumption-central-installer rerun-failed" once the capacity is quieter/);
  assert.equal(text.split('too busy').length, 2, 'said once');
  assert.match(text, /✓ Uploaded CSV exports/);
});

test("run doesn't start a second run while one is going, but ignores one stuck for over a day", async () => {
  const fabric = fakeFabric();
  fabric.jobList.push({ id: 'j-running', status: 'InProgress', startTimeUtc: '2026-06-01T11:30:00' });
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  config.fabric.pipelineId = 'pipe-1';

  const result = await runPipeline(ctx, { wait: true, first: true });
  assert.deepEqual(result, { jobId: 'j-running', status: 'InProgress', ok: false, started: false });
  assert.deepEqual(fabric.calls, []);
  assert.equal(config.firstRun, undefined);
  assert.match(ui.text(), /already running, so this didn't start another/);

  fabric.jobList[0].startTimeUtc = '2026-05-30T11:30:00';
  fabric.jobs.push({ status: 'Completed' });
  assert.equal((await runPipeline(ctx, { wait: true })).ok, true);
  assert.deepEqual(fabric.calls, ['runJob Pipeline']);
});

test('run starts the first load until a run has loaded the data, then runs as usual', async () => {
  const fabric = fakeFabric();
  const { ctx, config } = fakeCtx({ fabric: fabric.api });
  config.fabric.pipelineId = 'pipe-1';
  const wait = { wait: true };

  assert.deepEqual(await chooseLoad(ctx, wait), { wait: true, first: true }, 'nothing has run yet');

  config.firstRun = { jobId: 'job-9', status: 'Completed' };
  assert.deepEqual(await chooseLoad(ctx, wait), { wait: true });

  // A failed load means the first load didn't load the data.
  config.firstRun = { jobId: 'job-8', status: 'Failed' };
  fabric.activityRuns['job-8'] = [activity('Run_Upload_Router', 'Succeeded'), activity('Run_Consumption_Studio', 'Failed')];
  assert.deepEqual(await chooseLoad(ctx, wait), { wait: true, first: true });

  // One where only the status record failed did.
  config.firstRun = { jobId: 'job-9', status: 'Failed' };
  fabric.activityRuns['job-9'] = [activity('Run_Upload_Router', 'Succeeded'), activity('Run_Consumption_Studio', 'Succeeded'), activity('Record_Load_Status', 'Failed')];
  assert.deepEqual(await chooseLoad(ctx, wait), { wait: true });
  assert.equal(config.firstRun?.status, 'Completed', 'and is marked so');

  // With the model deployed, its refresh must have succeeded too.
  config.firstRun = { jobId: 'job-9', status: 'Failed' };
  Object.assign(config.semanticModel, DEPLOYED_MODEL);
  assert.equal(await historyLoaded(ctx), false);
  assert.deepEqual(await chooseLoad(ctx, wait), { wait: true, first: true }, 'the model refresh is missing');
  fabric.activityRuns['job-9'].push(activity(REFRESH_ACTIVITY, 'Succeeded'));
  assert.equal(await historyLoaded(ctx), true);

  // A record without a first load counts any completed run.
  delete config.firstRun;
  assert.equal(await historyLoaded(ctx), false);
  fabric.jobList.push({ id: 'old', status: 'Completed' });
  assert.equal(await historyLoaded(ctx), true);
});

test("run starts the first load again when the last one didn't load the data", async () => {
  const fabric = fakeFabric();
  fabric.jobs.push({ status: 'Completed' });
  fabric.activityRuns['job-0'] = [activity('Run_Consumption_Studio', 'Failed', undefined, { error: { errorCode: '430', message: BUSY } })];
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  config.fabric.pipelineId = 'pipe-1';
  config.firstRun = { jobId: 'job-0', status: 'Failed' };

  await runCommand(ctx, 'run', { wait: true });
  assert.deepEqual(fabric.calls, ['runJob Pipeline']);
  assert.match(ui.text(), /Started the first load/);
  assert.match(ui.text(), /usually takes under an hour/);
  assert.equal(config.firstRun?.jobId, 'job-1');
  assert.equal(config.firstRun?.status, 'Incomplete', 'job-1 has no proof the data loaded');
});

test('a first load whose job completed but whose loads did not all succeed is recorded as Incomplete, not Completed', async () => {
  const fabric = fakeFabric();
  fabric.jobs.push({ status: 'Completed' });
  fabric.activityRuns['job-1'] = [
    activity('Run_Consumption_Studio', 'Failed', undefined, { error: { errorCode: '430', message: BUSY } }),
    activity('Run_Upload_Router', 'Succeeded'),
  ];
  const { ctx, config } = fakeCtx({ fabric: fabric.api });
  config.fabric.pipelineId = 'pipe-1';

  const result = await runPipeline(ctx, { wait: true, first: true });
  assert.equal(result.status, 'Completed');
  assert.equal(result.ok, false);
  assert.equal(config.firstRun?.status, 'Incomplete');
  assert.deepEqual(await chooseLoad(ctx, { wait: true }), { wait: true, first: true }, 'the next run offers the first load again');

  // Once a rerun of its failed loads succeeds, the same job proves the data loaded.
  fabric.activityRuns['job-1'] = [activity('Run_Consumption_Studio', 'Succeeded'), activity('Run_Upload_Router', 'Succeeded')];
  assert.equal(await historyLoaded(ctx), true);
  assert.equal(config.firstRun?.status, 'Completed');
});

test('status records a finished first load as Completed only when its loads prove it', async () => {
  const fabric = fakeFabric();
  fabric.jobList.push({ id: 'job-7', status: 'Completed', startTimeUtc: '2026-06-01T12:00:00', endTimeUtc: '2026-06-01T12:30:00' });
  fabric.activityRuns['job-7'] = [activity('Run_Consumption_Studio', 'Failed')];
  const { ctx, config } = fakeCtx({ fabric: fabric.api, oneLake: { readJson: async () => null } });
  config.fabric.pipelineId = 'pipe-1';
  config.firstRun = { jobId: 'job-7', status: 'InProgress' };

  await status(ctx);
  assert.equal(config.firstRun?.status, 'Incomplete');

  assert.equal(firstRunStatus(config, 'Completed', null), 'Incomplete');
  assert.equal(firstRunStatus(config, 'Failed', null), 'Failed');
  const loaded = new Map([
    ['Run_Upload_Router', activity('Run_Upload_Router', 'Succeeded')],
    ['Run_Consumption_Studio', activity('Run_Consumption_Studio', 'Succeeded')],
  ]);
  assert.equal(firstRunStatus(config, 'Completed', loaded), 'Completed');
});

test('status names the loads that failed in the latest run, unless a retry covered them', async () => {
  const fabric = fakeFabric();
  fabric.jobList.push(
    { id: 'j-1', status: 'Completed', startTimeUtc: '2026-06-01T02:00:00', endTimeUtc: '2026-06-01T02:40:00', invokeType: 'Scheduled' },
    { id: 'j-2', status: 'Completed', startTimeUtc: '2026-06-02T02:00:00', endTimeUtc: '2026-06-02T02:40:00', invokeType: 'Scheduled' },
  );
  const busy = { errorCode: '430', message: BUSY };
  fabric.activityRuns['j-1'] = [activity('Run_Org_Data', 'Failed')];
  fabric.activityRuns['j-2'] = [
    // Fabric lists a retried load's attempts in any order; the last one counts.
    activity('Run_Consumption_Studio', 'Succeeded', '2026-06-02T02:06:00Z'),
    activity('Run_Consumption_Studio', 'Failed', '2026-06-02T02:00:05Z', { error: busy }),
    activity('Conditionally_Refresh_Cowork_Credits', 'Succeeded', '2026-06-02T02:07:00Z'),
    activity('Run_Consumption_Viva', 'Failed', '2026-06-02T02:12:05Z', { error: busy }),
  ];
  const run = async () => {
    const ui = fakeUi();
    const { ctx, config } = fakeCtx({ fabric: fabric.api, oneLake: { readJson: async () => null }, ui: ui.ui });
    config.fabric.pipelineId = 'pipe-1';
    await status(ctx);
    return ui.text();
  };

  let text = await run();
  assert.match(text, /Latest run, by source/);
  assert.match(text, /✗ Cowork and Work IQ credits: failed/);
  assert.match(text, /✓ Copilot Studio credits \(2 attempts\)/, 'its retry worked');
  assert.doesNotMatch(text, /Org data/, 'that was an earlier run');
  assert.doesNotMatch(text, /Conditionally/);
  assert.match(text, /capacity was too busy to start it/);

  fabric.activityRuns['j-2'][0].status = 'Failed';
  text = await run();
  assert.match(text, /✗ Copilot Studio credits: failed \(2 attempts\)/);
});

test('data check asks the model how many rows each chosen source gave it, and saves what it found', async () => {
  const powerBi = fakePowerBi();
  powerBi.answers.push({
    results: [
      {
        tables: [
          {
            rows: [
              {
                '[coworkCredits]': 48211,
                '[coworkCreditsFrom]': '2026-03-03T00:00:00',
                '[coworkCreditsTo]': '2026-05-31T00:00:00',
                '[studioCredits]': 1250,
                '[studioCreditsFrom]': '2026-03-01T00:00:00',
                '[studioCreditsTo]': '2026-05-31T00:00:00',
                '[github]': 0,
              },
            ],
          },
        ],
      },
    ],
  });
  /** @type {{ path: string, json: any }[]} */
  const writes = [];
  const oneLake = {
    /** @param {string} ws @param {string} lh @param {string} path @param {Uint8Array} data */
    writeFile: async (ws, lh, path, data) => {
      writes.push({ path: `${ws}/${lh}/${path}`, json: JSON.parse(new TextDecoder().decode(data)) });
    },
  };
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ powerBi: powerBi.api, oneLake, ui: ui.ui });
  config.dataSources.github = 'csv';
  Object.assign(config.semanticModel, DEPLOYED_MODEL);

  const summary = await runDataCheck(ctx);
  assert.deepEqual(powerBi.calls, ['executeQueries model-1']);
  assert.deepEqual(Object.keys(summary.tables), ['coworkCredits', 'studioCredits', 'github'], 'the chosen sources, in the order the check reports them');
  assert.deepEqual(summary.tables.studioCredits, { table: 'Credit Consumption (Tenant)', rows: 1250, from: '2026-03-01', to: '2026-05-31' });
  assert.equal(summary.checkedAt, '2026-06-01T12:00:00.000Z');
  assert.deepEqual(writes.map((w) => w.path), [`ws-1/lh-1/${DATA_CHECK_FILE}`]);
  assert.deepEqual(writes[0].json, summary);
  const text = ui.text();
  assert.match(text, /✓ Copilot Cowork and Work IQ credits: 48,211 rows in the model, 2026-03-03 to 2026-05-31/);
  assert.match(text, /✓ Copilot Studio credits: 1,250 rows in the model, 2026-03-01 to 2026-05-31/);
  assert.match(text, /! GitHub Copilot: no rows in the model yet/);
  assert.match(text, /Upload its export with "consumption-central-installer upload <file> --run"\./);
});

test('data check: a failed query is a failure that says how to run it again; a model it cannot ask only warns', async () => {
  const run = async (/** @type {(p: ReturnType<typeof fakePowerBi>) => void} */ script, deployed = true) => {
    const powerBi = fakePowerBi();
    script(powerBi);
    const ui = fakeUi();
    const t = fakeCtx({ powerBi: powerBi.api, oneLake: { writeFile: async () => {} }, ui: ui.ui });
    if (deployed) Object.assign(t.config.semanticModel, DEPLOYED_MODEL);
    return { result: await runDataCheck(t.ctx), text: ui.text(), calls: powerBi.calls };
  };

  const failed = await run((p) => p.answers.push({ results: [{ error: { message: "Column 'MetricDate' in table 'CreditsWeekly' cannot be found." } }] }));
  assert.equal(failed.result, false);
  assert.match(failed.text, /✗ Data check: the query on Consumption Central Model failed/);
  assert.match(failed.text, /Column 'MetricDate' in table 'CreditsWeekly' cannot be found/);
  assert.match(failed.text, /Run "consumption-central-installer check" to try it again\./);

  const rejected = await run((p) => (p.failures.executeQueries = [httpError(400, 'Bad request')]));
  assert.equal(rejected.result, false, 'a query the model rejects failed too');
  assert.match(rejected.text, /Bad request/);

  const empty = await run((p) => p.answers.push({ results: [{ tables: [{ rows: [] }] }] }));
  assert.equal(empty.result, false);
  assert.match(empty.text, /The query returned no rows\./);

  const off = await run((p) => (p.failures.executeQueries = [httpError(401, 'Unauthorized')]));
  assert.equal(off.result, null);
  assert.match(off.text, /! Couldn't query Consumption Central Model for the data check \(Unauthorized\)\./);
  assert.match(off.text, /"Semantic model Execute Queries REST API" may be off/);
  assert.doesNotMatch(off.text, /✗/);

  const missing = await run(() => {}, false);
  assert.equal(missing.result, null);
  assert.deepEqual(missing.calls, [], 'no model, nothing to ask');
  assert.equal(missing.text, '');
});

test('check asks a deployed model a test question, then what each source gave it, without running the pipeline', async () => {
  const fabric = fakeFabric();
  const powerBi = fakePowerBi();
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, powerBi: powerBi.api, oneLake: { writeFile: async () => {} }, ui: ui.ui });
  await assert.rejects(runCommand(ctx, 'check', { wait: true }), /There is no semantic model yet\. Run the installer first\./);
  assert.deepEqual(powerBi.calls, []);

  Object.assign(config.semanticModel, DEPLOYED_MODEL);
  powerBi.answers.push({ results: [{ tables: [{ rows: [{ '[CalendarDays]': 90 }] }] }] }, { results: [{ tables: [{ rows: [{ '[coworkCredits]': 5, '[studioCredits]': 7 }] }] }] });
  assert.equal(await runCommand(ctx, 'check', { wait: true }), true);
  assert.deepEqual(powerBi.calls, ['executeQueries model-1', 'executeQueries model-1']);
  assert.deepEqual(fabric.calls, [], 'the pipeline is left alone');
  assert.match(ui.text(), /✓ Consumption Central Model answers queries \(its Date table has 90 days\)/);
  assert.match(ui.text(), /✓ Copilot Studio credits: 7 rows in the model\n/);

  powerBi.calls.length = 0;
  powerBi.answers.push({ results: [{ error: { message: "The syntax for 'LastDate' is incorrect." } }] });
  assert.equal(await runCommand(ctx, 'check', { wait: true }), false);
  assert.match(ui.text(), /a test query failed, so report pages will fail/);
  assert.deepEqual(powerBi.calls, ['executeQueries model-1'], 'no data check on a model that fails its test question');
});

test('the commercial terms notebook waits and tries again while the capacity is busy, and runs again only when asked', async () => {
  const fabric = fakeFabric();
  const busy = { status: 'Failed', failureReason: { errorCode: 'RequestExecutionFailed', message: BUSY } };
  fabric.jobs.push(busy, { status: 'Completed' });
  const ui = fakeUi();
  const { ctx, config, sleeps } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  config.dataSources.commercialTerms = 'api';
  config.fabric.notebooks.commercialTerms = 'nb-terms';
  config.commercialTerms = { scope: '/providers/Microsoft.Billing/billingAccounts/contoso-ba' };

  assert.equal(await runOnceNotebooks(ctx), true);
  assert.deepEqual(fabric.calls, ['runJob RunNotebook', 'runJob RunNotebook']);
  assert.ok(sleeps.includes(BUSY_WAIT_MS));
  let text = ui.text();
  assert.match(text, /Ingest_CommercialTerms reads the credit rate you pay from Cost Management for \/providers\/Microsoft\.Billing\/billingAccounts\/contoso-ba\./);
  assert.match(text, /! Fabric's capacity is too busy to start Ingest_CommercialTerms\. Trying again in 5 minutes\./);
  assert.match(text, /✓ Ingest_CommercialTerms finished/);
  assert.equal(config.commercialTerms?.status, 'Completed');
  assert.equal(config.commercialTerms?.ranAt, '2026-06-01T12:00:00.000Z');

  fabric.calls.length = 0;
  assert.equal(await runOnceNotebooks(ctx), true);
  assert.deepEqual(fabric.calls, [], 'it has read the rate');
  assert.match(ui.text(), /✓ Ingest_CommercialTerms read the credit rate from \/providers\/Microsoft\.Billing\/billingAccounts\/contoso-ba on 2026-06-01/);

  fabric.jobs.push({ status: 'Completed' });
  assert.equal(await runOnceNotebooks(ctx, { force: true }), true);
  assert.deepEqual(fabric.calls, ['runJob RunNotebook']);

  const denied = fakeFabric();
  denied.jobs.push({ status: 'Failed', failureReason: { errorCode: 'NotebookFailed', message: "AuthorizationFailed: no authorization to perform action 'Microsoft.CostManagement/query/read'" } });
  const ui2 = fakeUi();
  const d = fakeCtx({ fabric: denied.api, ui: ui2.ui });
  d.config.dataSources.commercialTerms = 'api';
  d.config.fabric.notebooks.commercialTerms = 'nb-terms';
  d.config.commercialTerms = { scope: '/providers/Microsoft.Billing/billingAccounts/contoso-ba', scopeName: 'Contoso billing account' };
  assert.equal(await runOnceNotebooks(d.ctx), false);
  assert.equal(denied.calls.length, 1, 'only a busy capacity is tried again');
  text = ui2.text();
  assert.match(text, /! Ingest_CommercialTerms failed/);
  assert.doesNotMatch(text, /✗/, 'it only warns: the install still counts as set up');
  assert.match(text, /AuthorizationFailed/);
  assert.match(text, /you need Cost Management Reader on Contoso billing account\. Run the installer again to retry\./);
});

test('the commercial terms notebook, still turned away after the retries, says the capacity was busy instead of showing the raw error', async () => {
  const fabric = fakeFabric();
  for (let i = 0; i <= BUSY_RETRIES; i++) fabric.jobs.push({ status: 'Failed', failureReason: { errorCode: 'RequestExecutionFailed', message: BUSY } });
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  config.dataSources.commercialTerms = 'api';
  config.fabric.notebooks.commercialTerms = 'nb-terms';

  assert.equal(await runOnceNotebooks(ctx), false, 'still busy after the retries');
  assert.equal(fabric.calls.length, BUSY_RETRIES + 1);
  assert.equal(config.commercialTerms?.status, 'Failed', 'so the next install runs it again');
  const text = ui.text();
  assert.match(text, /! Ingest_CommercialTerms failed/);
  assert.match(text, /Fabric's capacity was too busy to start a notebook\. Nothing is lost\./);
  assert.ok(text.includes(`Wait a few minutes, then run "${commandLine('install')}" again.`));
  assert.match(text, /Until it completes, the model prices credits at the rates set in the installer, or the template's\./);
  assert.doesNotMatch(text, /Livy session/, 'the raw error is left out when the reason is a busy capacity');
  assert.doesNotMatch(text, /Cost Management Reader/, 'a busy capacity is not a missing role');

  const later = fakeFabric();
  for (let i = 0; i <= BUSY_RETRIES; i++) later.jobs.push({ status: 'Failed', failureReason: { errorCode: 'RequestExecutionFailed', message: BUSY } });
  const ui2 = fakeUi();
  const u = fakeCtx({ fabric: later.api, ui: ui2.ui });
  u.config.dataSources.commercialTerms = 'api';
  u.config.fabric.notebooks.commercialTerms = 'nb-terms';
  assert.equal(await runOnceNotebooks(u.ctx, { force: true, again: 'update' }), false);
  assert.ok(ui2.text().includes(`Wait a few minutes, then run "${commandLine('update')}" again.`), 'update suggests update');
});

test('ranSince: a run that ended after the check makes it out of date', () => {
  const at = '2026-06-01T12:30:00+00:00';
  const run = (/** @type {string} */ status, /** @type {string} */ end) => ({ status, endTimeUtc: end });
  assert.equal(ranSince([run('Completed', '2026-06-02T02:20:00')], at), true);
  assert.equal(ranSince([run('Failed', '2026-06-02T02:20:00')], at), true);
  assert.equal(ranSince([run('Completed', '2026-06-01T12:00:00')], at), false, 'the run the check followed');
  assert.equal(ranSince([run('InProgress', '')], at), false);
  assert.equal(ranSince([run('Completed', '2026-06-02T02:20:00')], undefined), false);
});

test('status says when the last data check is out of date, or has never run', async () => {
  const fabric = fakeFabric();
  /** @type {any[]} */
  let jobs = [{ id: 'j-1', status: 'Completed', startTimeUtc: '2026-06-02T02:00:00', endTimeUtc: '2026-06-02T02:20:00', invokeType: 'Scheduled' }];
  /** @type {any} */ (fabric.api).listJobs = async () => jobs;
  /** @type {any} */
  let saved = { checkedAt: '2026-06-01T12:30:00.000Z', tables: { studioCredits: { table: 'Credit Consumption (Tenant)', rows: 0, from: null, to: null } } };
  const oneLake = { readJson: async () => saved ?? Promise.reject(new Error('404')) };
  const run = async () => {
    const ui = fakeUi();
    const { ctx, config } = fakeCtx({ fabric: fabric.api, powerBi: fakePowerBi().api, oneLake, ui: ui.ui });
    config.fabric.pipelineId = 'pipe-1';
    Object.assign(config.semanticModel, DEPLOYED_MODEL);
    await status(ctx);
    return ui.text();
  };

  let text = await run();
  assert.match(text, /Last data check \(2026-06-01 12:30 UTC\)/);
  assert.match(text, /! The pipeline has run since this check, so these results may be out of date/);
  assert.match(text, /Run "consumption-central-installer check" to check the data again/);
  assert.match(text, /! Copilot Studio credits: no rows in the model yet/);

  saved = { ...saved, checkedAt: '2026-06-02T02:40:00.000Z' };
  text = await run();
  assert.match(text, /Last data check \(2026-06-02 02:40 UTC\)/);
  assert.doesNotMatch(text, /out of date/);

  saved = null;
  text = await run();
  assert.match(text, /It hasn't run yet. Run "consumption-central-installer check"/);

  jobs = [];
  text = await run();
  assert.match(text, /No runs yet\./);
  assert.doesNotMatch(text, /Data check|hasn't run/, 'nothing to check before the pipeline has loaded anything');
});

test('printDataCheck says which sources have no rows yet, and how to load them', () => {
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ ui: ui.ui });
  config.dataSources.coworkCredits = 'api';
  config.dataSources.github = 'csv';
  config.firstRun = { jobId: 'job-1', status: 'Completed', coworkSkipped: true };
  printDataCheck(ctx, { tables: { coworkCredits: { rows: 0 }, github: { rows: 0, from: null, to: null } } });
  const text = ui.text();
  assert.match(text, /! Copilot Cowork and Work IQ credits: no rows in the model yet\n +They load once the Cowork Dataflow is signed in: see the next step\./);
  assert.match(text, /! GitHub Copilot: no rows in the model yet\n +Upload its export with "consumption-central-installer upload <file> --run"\./);

  const later = fakeUi();
  const t = fakeCtx({ ui: later.ui });
  t.config.dataSources.coworkCredits = 'api';
  printDataCheck(t.ctx, { tables: { coworkCredits: { rows: 0 } } });
  assert.match(later.text(), /! Copilot Cowork and Work IQ credits: no rows in the model yet/);
  assert.doesNotMatch(later.text(), /signed in|Upload its export/, 'the Dataflow was in the run, so there is no next step to name');
});

test('printDataCheck reports how many people in the org data have a department', () => {
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ ui: ui.ui });
  config.dataSources.orgData = 'api';
  printDataCheck(ctx, { tables: { orgData: { table: 'Org', rows: 1200, filled: 1150 } } });
  assert.match(ui.text(), /✓ Org data: 1,200 rows in the model\n/);
  assert.match(ui.text(), /✓ Org data: 1,150 of 1,200 people have a department/);
  assert.doesNotMatch(ui.text(), /Microsoft Entra ID/);

  const low = fakeUi();
  const api = fakeCtx({ ui: low.ui });
  api.config.dataSources.orgData = 'api';
  printDataCheck(api.ctx, { tables: { orgData: { rows: 1200, filled: 300 } } });
  assert.match(low.text(), /! Org data: 300 of 1,200 people have a department/);
  assert.match(low.text(), /Views by department leave out everyone without one\./);
  assert.match(low.text(), /Fill in Department on users in Microsoft Entra ID/);

  const file = fakeUi();
  const csv = fakeCtx({ ui: file.ui });
  csv.config.dataSources.orgData = 'csv';
  printDataCheck(csv.ctx, { tables: { orgData: { rows: 1200, filled: 300 } } });
  assert.match(file.text(), /Fill in the Department column in the org data file, then upload it again\./);
  assert.doesNotMatch(file.text(), /Microsoft Entra ID/);

  const old = fakeUi();
  printDataCheck(fakeCtx({ ui: old.ui }).ctx, { tables: { orgData: { rows: 1200 } } });
  assert.match(old.text(), /✓ Org data: 1,200 rows in the model/);
  assert.doesNotMatch(old.text(), /have a department/, 'a summary without the count says nothing');
});
