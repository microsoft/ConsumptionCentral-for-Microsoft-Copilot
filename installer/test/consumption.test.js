// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notebooksFor } from '../src/catalog.js';
import { ROLES } from '../src/clients/azure.js';
import { emptyConfig } from '../src/config.js';
import { APP_REGISTRATION, LAKEHOUSE_NAME, SECRET_NAME } from '../src/product.js';
import {
  COWORK_DATAFLOW_NAME,
  consumptionSummary,
  coworkSignInSteps,
  DATAFLOW_GUIDE,
  ensureAzureAiAccess,
  ensureLandingFolders,
  landingFolders,
  planConsumption,
  policiesBySubscription,
  STAGING_ITEMS_NOTE,
} from '../src/steps/consumption.js';
import { azureAiOn, deployedSources, ensureNotebooks, pipelineSignature } from '../src/steps/fabric.js';
import { notebookSettings, PAYG_FIND } from '../src/steps/notebook-settings.js';
import { MARKER, prepareNotebook, cellText } from '../src/transform/notebook.js';
import { addCopilotPaygSpend, PAYG_SOURCE_TABLE, PAYG_TABLE } from '../src/transform/payg.js';
import { GITHUB_DIR, ORG_DIR, STUDIO_DIR, UPLOAD_DIR, VIVA_DIR } from '../src/uploads.js';
import { fakeCtx, fakeFabric, fakeUi, httpError, realSources } from './fakes.js';

const SUB = '11111111-0000-0000-0000-000000000000';
/** A subscription that only a billing policy charges. */
const PAYG = '4b7e2d10-0000-0000-0000-000000000000';
/** A billing policy's subscription the signed-in user can't see. */
const HIDDEN = '7d31c5a2-0000-0000-0000-000000000000';
/** @param {string} sub @param {string} name */
const policy = (sub, name) => ({ id: `bp-${name}`, name, billingInstrument: { subscriptionId: sub, resourceGroup: 'rg-billing' } });

/** @param {string} text @param {string} part */
const has = (text, part) => assert.ok(text.includes(part), `"${part}" is missing from:\n${text}`);

/** Resource Manager: role assignments and AI accounts per subscription. */
function fakeArm() {
  /** @type {string[]} */
  const calls = [];
  /** @type {Record<string, Error[]>} */
  const failures = {};
  /** @type {Record<string, number>} */
  const aiAccounts = {};
  const api = {
    /** @param {string} scope @param {string} roleId @param {string} principalId @param {string} type */
    assignRole: async (scope, roleId, principalId, type) => {
      calls.push(`assignRole ${scope} ${roleId} ${principalId} ${type}`);
      const err = failures.assignRole?.shift();
      if (err) throw err;
      return true;
    },
    /** @param {string} sub */
    listAiAccounts: async (sub) => {
      calls.push(`listAiAccounts ${sub}`);
      if (!(sub in aiAccounts)) throw httpError(403, 'Forbidden');
      return Array.from({ length: aiAccounts[sub] }, (_, i) => ({ id: `ai-${i}` }));
    },
  };
  return { api, calls, failures, aiAccounts };
}

/** OneLake folders. */
function fakeOneLake() {
  /** @type {string[]} */
  const dirs = [];
  /** @type {Error[]} */
  const failures = [];
  const api = {
    /** @param {string} _ws @param {string} _lh @param {string} path */
    createDirectory: async (_ws, _lh, path) => {
      const err = failures.shift();
      if (err) throw err;
      if (dirs.includes(path)) return false;
      dirs.push(path);
      return true;
    },
    readJson: async () => null,
  };
  return { api, dirs, failures };
}

/** @param {{ answers?: any[], yes?: boolean, policies?: any[] | Error }} [o] */
function setup(o = {}) {
  const fabric = fakeFabric();
  const arm = fakeArm();
  const oneLake = fakeOneLake();
  const ui = fakeUi({ answers: o.answers, yes: o.yes });
  const config = emptyConfig();
  config.dataSources.azureAi = 'api';
  config.app.displayName = APP_REGISTRATION;
  config.fabric.lakehouseName = LAKEHOUSE_NAME;
  const policies = o.policies;
  const powerPlatform = {
    billingPolicies: async () => {
      if (policies instanceof Error) throw policies;
      return policies ?? [];
    },
  };
  const made = fakeCtx({ ui: ui.ui, fabric: fabric.api, arm: arm.api, oneLake: oneLake.api, powerPlatform, config });
  return { ...made, fabric, arm, oneLake, ui };
}

/** The Azure AI notebook as the installer deploys it. */
const azureAi = () => /** @type {import('../src/catalog.js').NotebookInfo} */ (realSources().catalog.find((n) => n.key === 'azureAi'));

test('notebooks and signature: Azure AI is deployed only once the app can read its subscription', () => {
  const { catalog } = realSources();
  const config = emptyConfig();
  config.dataSources.azureAi = 'api';
  const keys = () => notebooksFor(catalog, deployedSources(config)).map((n) => n.key);
  assert.ok(!keys().includes('azureAi'), 'no subscription chosen yet');

  config.consumption.azureSubscriptionId = SUB;
  assert.equal(azureAiOn(config), false, 'not until the app has the roles');
  assert.equal(deployedSources(config).azureAi, 'skip');
  assert.equal(config.dataSources.azureAi, 'api', 'the choice itself stays');
  assert.ok(!keys().includes('azureAi'));
  assert.equal(pipelineSignature(config, catalog), 'uploadRouter,studioConsumption,vivaConsumption,loadStatus');

  config.consumption.azureAccess = true;
  assert.equal(azureAiOn(config), true);
  assert.equal(deployedSources(config), config.dataSources);
  assert.ok(keys().includes('azureAi'));
  assert.equal(pipelineSignature(config, catalog), 'uploadRouter,azureAi,studioConsumption,vivaConsumption,loadStatus');

  config.dataSources.azureAi = 'skip';
  assert.equal(azureAiOn(config), false, 'Skip wins over access given before');
  assert.ok(!keys().includes('azureAi'));
});

test('Azure AI notebook: subscription, tenant, app and Key Vault secret are filled in', () => {
  const t = setup();
  Object.assign(t.config.consumption, { azureSubscriptionId: SUB, azureAccess: true });
  const nb = prepareNotebook(realSources().notebooks.azureAi, notebookSettings(t.ctx, azureAi()));
  const all = nb.cells.map(cellText).join('\n');
  assert.match(all, new RegExp(`^SUBSCRIPTION_ID = '${SUB}'`, 'm'));
  assert.match(all, /^TENANT_ID = 'tenant-1'/m);
  assert.match(all, /^CLIENT_ID = 'app-1'/m);
  assert.match(all, /^KEY_VAULT_URL = 'https:\/\/kv-test\.vault\.azure\.net\/'/m);
  assert.match(all, new RegExp(`^CLIENT_SECRET_NAME = '${SECRET_NAME}'`, 'm'));
  assert.equal(nb.metadata.dependencies.lakehouse.default_lakehouse, 'lh-1');
});

test('plan: Azure AI is asked about, under its heading, only when it isn\'t Skip', async () => {
  const subs = [{ subscriptionId: SUB, displayName: 'AI' }];
  const skipped = setup();
  skipped.config.dataSources.azureAi = 'skip';
  await planConsumption(skipped.ctx, /** @type {any} */ ({ subscriptions: subs }));
  assert.equal(skipped.ui.text(), '', 'no heading, nothing said');
  assert.deepEqual(skipped.ui.asked, []);
  assert.deepEqual(skipped.arm.calls, []);

  const asked = setup();
  asked.arm.aiAccounts[SUB] = 1;
  await planConsumption(asked.ctx, /** @type {any} */ ({ subscriptions: subs }));
  assert.match(asked.ui.text(), /^\nAzure AI\n {4}Looking for Azure AI resources in your subscriptions\.\n/);
  assert.equal(asked.ui.asked.length, 1);
  assert.equal(asked.config.consumption.azureSubscriptionId, SUB);

  const none = setup();
  await planConsumption(none.ctx, /** @type {any} */ ({ subscriptions: [] }));
  assert.match(none.ui.text(), /^Azure AI$/m);
  assert.match(none.ui.text(), /No Azure subscription to read Azure AI costs from, so Azure AI is left out\./);
  assert.equal(none.config.dataSources.azureAi, 'skip');
  assert.deepEqual(none.ui.asked, []);

  const chosen = setup();
  Object.assign(chosen.config.consumption, { azureSubscriptionId: SUB, azureSubscriptionName: 'AI' });
  await planConsumption(chosen.ctx, /** @type {any} */ ({ subscriptions: [] }));
  assert.match(chosen.ui.text(), /✓ Azure AI: AI$/m, 'a subscription chosen before stays when none can be listed');
  assert.equal(chosen.config.dataSources.azureAi, 'api');
});

test('plan: picks the subscription with AI resources; "leave out" is remembered; a change resets access', async () => {
  const subs = [
    { subscriptionId: 'sub-a', displayName: 'Dev' },
    { subscriptionId: SUB, displayName: 'AI' },
  ];
  const t = setup();
  t.arm.aiAccounts['sub-a'] = 0;
  t.arm.aiAccounts[SUB] = 4;
  await planConsumption(t.ctx, /** @type {any} */ ({ subscriptions: subs }));
  assert.equal(t.config.consumption.azureSubscriptionId, SUB);
  assert.equal(t.config.consumption.azureSubscriptionName, 'AI');

  t.config.consumption.azureAccess = true;
  await planConsumption(t.ctx, /** @type {any} */ ({ subscriptions: subs }));
  assert.equal(t.config.consumption.azureAccess, true, 'same answer keeps access');

  const left = setup({ answers: [''] });
  left.arm.aiAccounts[SUB] = 4;
  await planConsumption(left.ctx, /** @type {any} */ ({ subscriptions: subs }));
  assert.equal(left.config.consumption.azureSubscriptionId, '');
  assert.equal(left.config.dataSources.azureAi, 'skip', 'leaving it out sets the Data sources card to Skip');

  const skipped = setup();
  Object.assign(skipped.config.consumption, { azureSubscriptionId: SUB, azureAccess: true, paygSubscriptions: [{ subscriptionId: PAYG, policies: ['Studio'] }] });
  skipped.config.dataSources.azureAi = 'skip';
  await planConsumption(skipped.ctx, /** @type {any} */ ({ subscriptions: subs }));
  assert.deepEqual(skipped.arm.calls, [], 'Skip on the Data sources screen asks nothing');
  assert.equal(skipped.config.consumption.azureSubscriptionId, '');
  assert.equal(skipped.config.consumption.azureAccess, false);
  assert.deepEqual(skipped.config.consumption.paygSubscriptions, []);
  const again = setup();
  again.config.consumption = left.config.consumption;
  again.arm.aiAccounts[SUB] = 4;
  await planConsumption(again.ctx, /** @type {any} */ ({ subscriptions: subs }));
  assert.equal(again.config.consumption.azureSubscriptionId, '', 'the default is what was chosen before');

  const moved = setup({ answers: ['sub-a'] });
  Object.assign(moved.config.consumption, { azureSubscriptionId: SUB, azureAccess: true });
  await planConsumption(moved.ctx, /** @type {any} */ ({ subscriptions: subs }));
  assert.equal(moved.config.consumption.azureAccess, false);

  const many = setup();
  await planConsumption(many.ctx, /** @type {any} */ ({ subscriptions: Array.from({ length: 30 }, (_, i) => ({ subscriptionId: `s-${i}`, displayName: `S${i}` })) }));
  assert.deepEqual(many.arm.calls, [], 'too many subscriptions to search');
  assert.equal(many.config.consumption.azureSubscriptionId, '');
});

test('Azure access: the app gets three read roles once; without rights the user can leave Azure AI out', async () => {
  const t = setup();
  t.config.consumption.azureSubscriptionId = SUB;
  assert.equal(await ensureAzureAiAccess(t.ctx), true);
  assert.deepEqual(t.arm.calls, [ROLES.reader, ROLES.costManagementReader, ROLES.monitoringReader].map((r) => `assignRole /subscriptions/${SUB} ${r} sp-1 ServicePrincipal`));
  assert.equal(t.config.consumption.azureAccess, true);
  assert.equal(await ensureAzureAiAccess(t.ctx), true);
  assert.equal(t.arm.calls.length, 3, 'nothing to do on a re-run');

  const denied = setup();
  denied.config.consumption.azureSubscriptionId = SUB;
  denied.arm.failures.assignRole = [httpError(403, 'AuthorizationFailed')];
  assert.equal(await ensureAzureAiAccess(denied.ctx), false);
  assert.equal(denied.config.consumption.azureAccess, undefined);
  assert.match(denied.ui.text(), /Reader, Cost Management Reader, Monitoring Reader/);
  assert.match(denied.ui.text(), /app-1/);

  const granted = setup({ answers: [true] });
  granted.config.consumption.azureSubscriptionId = SUB;
  granted.arm.failures.assignRole = [httpError(403, 'AuthorizationFailed')];
  assert.equal(await ensureAzureAiAccess(granted.ctx), true);
  assert.equal(granted.config.consumption.azureAccess, true);

  const broken = setup();
  broken.config.consumption.azureSubscriptionId = SUB;
  broken.arm.failures.assignRole = [httpError(500, 'Boom')];
  await assert.rejects(ensureAzureAiAccess(broken.ctx), /Boom/);

  const none = setup();
  assert.equal(await ensureAzureAiAccess(none.ctx), false);
  assert.deepEqual(none.arm.calls, []);
});

test('billing policies: grouped by subscription, case-insensitively; one with no Azure subscription is skipped', () => {
  const byName = policiesBySubscription(/** @type {any} */ ([policy(PAYG.toUpperCase(), 'Studio'), policy(PAYG, 'Cowork'), { id: 'bp-x', billingInstrument: {} }, { id: 'bp-y' }]));
  assert.deepEqual([...byName], [[PAYG, ['Studio', 'Cowork']]]);
  assert.deepEqual([...policiesBySubscription(/** @type {any} */ ([{ id: 'bp-z', billingInstrument: { subscriptionId: SUB } }]))], [[SUB, ['bp-z']]], 'the ID when a policy has no name');
});

test('plan: billing policies add their subscriptions for pay-as-you-go; access given before is kept', async () => {
  const subs = [
    { subscriptionId: SUB, displayName: 'AI' },
    { subscriptionId: PAYG, displayName: 'Studio billing' },
  ];
  const t = setup({ policies: [policy(PAYG.toUpperCase(), 'Studio'), policy(PAYG, 'Cowork'), policy(SUB, 'Main'), policy(HIDDEN, 'Elsewhere')] });
  t.arm.aiAccounts[SUB] = 2;
  t.arm.aiAccounts[PAYG] = 0;
  /** @type {string[]} */
  const labels = [];
  const select = t.ctx.ui.select;
  t.ctx.ui.select = async (message, choices, def) => {
    labels.push(...choices.map((ch) => String(ch.name)));
    return select(message, choices, def);
  };
  await planConsumption(t.ctx, /** @type {any} */ ({ subscriptions: subs }));
  assert.equal(t.config.consumption.azureSubscriptionId, SUB, 'Azure AI resources still pick the subscription');
  assert.deepEqual(labels.slice(0, 2), [`AI (${SUB}, 2 AI resources, 1 billing policy)`, `Studio billing (${PAYG}, 0 AI resources, 2 billing policies)`]);
  assert.deepEqual(t.config.consumption.paygSubscriptions, [
    { subscriptionId: PAYG, name: 'Studio billing', policies: ['Studio', 'Cowork'] },
    { subscriptionId: HIDDEN, name: undefined, policies: ['Elsewhere'] },
  ]);
  assert.match(t.ui.text(), new RegExp(`also reads Copilot pay-as-you-go from Studio billing and ${HIDDEN}`));

  const extra = /** @type {import('../src/config.js').PaygSubscription[]} */ (t.config.consumption.paygSubscriptions);
  extra[0].access = true;
  await planConsumption(t.ctx, /** @type {any} */ ({ subscriptions: subs }));
  assert.equal(t.config.consumption.paygSubscriptions?.[0].access, true, 'a re-run keeps the role');
  assert.equal(t.config.consumption.paygSubscriptions?.[1].access, undefined);

  const paygOnly = setup({ policies: [policy(PAYG, 'Studio')] });
  paygOnly.arm.aiAccounts[SUB] = 0;
  paygOnly.arm.aiAccounts[PAYG] = 0;
  await planConsumption(paygOnly.ctx, /** @type {any} */ ({ subscriptions: subs }));
  assert.equal(paygOnly.config.consumption.azureSubscriptionId, PAYG, 'with no AI resources, the billed subscription is the default');
  assert.deepEqual(paygOnly.config.consumption.paygSubscriptions, [], 'it is read as the main subscription');

  const left = setup({ answers: [''], policies: [policy(PAYG, 'Studio')] });
  left.arm.aiAccounts[SUB] = 1;
  await planConsumption(left.ctx, /** @type {any} */ ({ subscriptions: subs }));
  assert.match(left.ui.text(), /pay-as-you-go billed in Azure is left out too/);
});

test('plan: unreadable billing policies only cost the extra subscriptions', async () => {
  const subs = [
    { subscriptionId: SUB, displayName: 'AI' },
    { subscriptionId: PAYG, displayName: 'Studio billing' },
  ];
  const t = setup({ answers: [PAYG], policies: httpError(403, 'Forbidden') });
  t.config.consumption.paygSubscriptions = [
    { subscriptionId: PAYG, policies: ['Studio'], access: true },
    { subscriptionId: HIDDEN, policies: ['Elsewhere'], access: true },
  ];
  await planConsumption(t.ctx, /** @type {any} */ ({ subscriptions: subs }));
  assert.equal(t.config.consumption.azureSubscriptionId, PAYG);
  assert.match(t.ui.text(), /Couldn't read Power Platform billing policies \(Forbidden\)/);
  assert.deepEqual(t.config.consumption.paygSubscriptions, [{ subscriptionId: HIDDEN, policies: ['Elsewhere'], access: true }], 'the ones found before stay, less the main one');
});

test('pay-as-you-go access: Cost Management Reader on each other subscription; one the user can\'t grant is left out', async () => {
  /** @param {ReturnType<typeof setup>} t */
  const billed = (t) => {
    t.config.consumption.azureSubscriptionId = SUB;
    t.config.consumption.paygSubscriptions = [
      { subscriptionId: PAYG, name: 'Studio billing', policies: ['Studio'] },
      { subscriptionId: HIDDEN, policies: ['Elsewhere'] },
    ];
    return /** @type {import('../src/config.js').PaygSubscription[]} */ (t.config.consumption.paygSubscriptions);
  };
  const t = setup();
  const extra = billed(t);
  t.arm.failures.assignRole = /** @type {any} */ ([null, null, null, null, httpError(404, 'SubscriptionNotFound')]);
  assert.equal(await ensureAzureAiAccess(t.ctx), true, 'Azure AI runs without them');
  assert.deepEqual(t.arm.calls.slice(3), [PAYG, HIDDEN].map((s) => `assignRole /subscriptions/${s} ${ROLES.costManagementReader} sp-1 ServicePrincipal`));
  assert.equal(extra[0].access, true);
  assert.equal(extra[1].access, undefined);
  has(t.ui.text(), `Gave ${APP_REGISTRATION} Cost Management Reader on Studio billing`);
  assert.match(t.ui.text(), new RegExp(`can't assign Azure roles in ${HIDDEN}`));

  t.arm.calls.length = 0;
  assert.equal(await ensureAzureAiAccess(t.ctx), true);
  assert.deepEqual(t.arm.calls, [`assignRole /subscriptions/${HIDDEN} ${ROLES.costManagementReader} sp-1 ServicePrincipal`], 'only the one still missing is tried again');
  assert.equal(extra[1].access, true);

  const granted = setup({ answers: [true] });
  const told = billed(granted);
  granted.config.consumption.azureAccess = true;
  granted.arm.failures.assignRole = [httpError(403, 'AuthorizationFailed')];
  await ensureAzureAiAccess(granted.ctx);
  assert.equal(told[0].access, true, '"It already has this role"');

  const broken = setup();
  billed(broken);
  broken.config.consumption.azureAccess = true;
  broken.arm.failures.assignRole = [httpError(500, 'Boom')];
  await assert.rejects(ensureAzureAiAccess(broken.ctx), /Boom/);
});

test('Azure AI notebook: the readable pay-as-you-go subscriptions are listed; it is pushed again when they change', async () => {
  const t = setup();
  Object.assign(t.config.consumption, { azureSubscriptionId: SUB, azureAccess: true });
  const info = azureAi();
  const plain = prepareNotebook(realSources().notebooks.azureAi, notebookSettings(t.ctx, info)).cells.map(cellText).join('\n');
  assert.ok(plain.includes(PAYG_FIND), 'left as it ships');

  t.config.consumption.paygSubscriptions = [
    { subscriptionId: PAYG, name: 'Studio\nbilling', policies: ['Studio'], access: true },
    { subscriptionId: HIDDEN, policies: ['Elsewhere'] },
  ];
  const all = prepareNotebook(realSources().notebooks.azureAi, notebookSettings(t.ctx, info)).cells.map(cellText).join('\n');
  assert.ok(all.includes(`PAYG_SUBSCRIPTION_IDS = [  # ${MARKER}\n    '${PAYG}',  # Studio billing\n]`), 'only the ones the app can read');
  assert.ok(!all.includes(HIDDEN));

  const fresh = setup();
  Object.assign(fresh.config.consumption, { azureSubscriptionId: SUB, azureAccess: true });
  await ensureNotebooks(fresh.ctx);
  assert.ok(fresh.fabric.calls.includes(`createNotebook ${info.displayName}`));
  assert.equal(fresh.config.consumption.deployedPayg, '');
  fresh.fabric.calls.length = 0;
  await ensureNotebooks(fresh.ctx);
  assert.deepEqual(fresh.fabric.calls, [], 'nothing to do on a re-run');

  fresh.config.consumption.paygSubscriptions = [{ subscriptionId: HIDDEN, policies: ['Elsewhere'] }];
  await ensureNotebooks(fresh.ctx);
  assert.deepEqual(fresh.fabric.calls, [], 'not until the app can read it');
  /** @type {any} */ (fresh.config.consumption.paygSubscriptions)[0].access = true;
  await ensureNotebooks(fresh.ctx);
  assert.deepEqual(fresh.fabric.calls, [`updateNotebook ${info.displayName}`]);
  assert.equal(fresh.config.consumption.deployedPayg, HIDDEN);
});

test('pay-as-you-go table: added empty-safe to the semantic model, once', () => {
  const model = /** @type {any} */ ({ tables: [{ name: 'Date', columns: [] }], expressions: [{ name: 'GetTable', expression: '' }] });
  addCopilotPaygSpend(model);
  addCopilotPaygSpend(model);
  const tables = model.tables.filter((/** @type {any} */ t) => t.name === PAYG_TABLE);
  assert.equal(tables.length, 1);
  const m = tables[0].partitions[0].source.expression.join('\n');
  assert.match(m, new RegExp(`Raw = GetTable\\("${PAYG_SOURCE_TABLE}"\\)`));
  assert.match(m, /if Raw = null then #table\(Columns, \{\}\) else Raw/);
  assert.deepEqual(tables[0].columns.map((/** @type {any} */ c) => c.name), ['UsageDate', 'SubscriptionId', 'Meter', 'ServiceTag', 'Product', 'Cost', 'UsageQuantity', 'Currency']);
  assert.deepEqual(model.relationships.map((/** @type {any} */ r) => `${r.fromTable}[${r.fromColumn}] ${r.toTable}[${r.toColumn}]`), [`${PAYG_TABLE}[UsageDate] Date[Date]`]);

  const noDate = /** @type {any} */ ({ tables: [], expressions: [{ name: 'GetTable', expression: '' }] });
  addCopilotPaygSpend(noDate);
  assert.equal(noDate.relationships, undefined);
  assert.throws(() => addCopilotPaygSpend(/** @type {any} */ ({ tables: [] })), /no "GetTable" function/);
});

test('landing folders: one for each deployed notebook that reads files', () => {
  const t = setup();
  const ds = t.config.dataSources;
  assert.deepEqual(landingFolders(t.ctx), [STUDIO_DIR, VIVA_DIR], 'the Studio and Cowork exports by default');

  Object.assign(ds, { github: 'csv', orgData: 'csv' });
  assert.deepEqual(landingFolders(t.ctx), [STUDIO_DIR, VIVA_DIR, GITHUB_DIR, ORG_DIR]);

  Object.assign(ds, { studioCredits: 'api', coworkCredits: 'api', github: 'api', orgData: 'api', commercialTerms: 'api' });
  Object.assign(t.config.consumption, { azureSubscriptionId: SUB, azureAccess: true });
  assert.deepEqual(landingFolders(t.ctx), [STUDIO_DIR, VIVA_DIR], 'the Studio flow writes into its folder; the other API loads read none');

  ds.studioCredits = 'skip';
  assert.deepEqual(landingFolders(t.ctx), [VIVA_DIR], 'the Viva load is always deployed');
});

test('landing folders: all made, existing ones left alone, a failure only warns', async () => {
  const t = setup();
  Object.assign(t.config.dataSources, { github: 'csv', orgData: 'csv' });
  await ensureLandingFolders(t.ctx);
  assert.deepEqual(t.oneLake.dirs, [STUDIO_DIR, VIVA_DIR, GITHUB_DIR, ORG_DIR]);
  assert.equal(t.config.consumption.landing, true);
  has(t.ui.text(), `✓ Landing folders ${STUDIO_DIR}, ${VIVA_DIR}, ${GITHUB_DIR} and ${ORG_DIR} are in ${LAKEHOUSE_NAME}`);
  await ensureLandingFolders(t.ctx);
  assert.equal(t.oneLake.dirs.length, 4);

  const failed = setup();
  failed.oneLake.failures.push(httpError(403, 'Forbidden'));
  await ensureLandingFolders(failed.ctx);
  assert.equal(failed.config.consumption.landing, undefined);
  has(failed.ui.text(), `! Couldn't make the landing folders in ${LAKEHOUSE_NAME} (Forbidden).`);
  has(failed.ui.text(), `Make ${STUDIO_DIR} and ${VIVA_DIR} yourself`);
  assert.match(failed.ui.text(), /New subfolder/);
});

test('summary: Azure AI status and the Studio and Cowork upload steps', () => {
  const t = setup();
  Object.assign(t.config.consumption, { azureSubscriptionId: SUB, azureSubscriptionName: 'AI' });
  Object.assign(t.config.dataSources, { studioCredits: 'csv', coworkCredits: 'csv' });
  consumptionSummary(t.ctx);
  const text = t.ui.text();
  assert.match(text, /^Consumption sources$/m);
  has(text, `Azure AI:   left out until ${APP_REGISTRATION} has Reader, Cost Management Reader, Monitoring Reader on AI`);
  assert.match(text, /Copilot Studio credits {2}\(upload the exports\)/);
  has(text, `Drop them in ${LAKEHOUSE_NAME} > ${UPLOAD_DIR}. Each export counts as the month it is loaded in.`);
  assert.match(text, /Cowork credits {2}\(upload the export\)/);
  has(text, `Drop it in ${LAKEHOUSE_NAME} > ${UPLOAD_DIR}.`);
  assert.match(text, /choose Connected \(Dataflow\)/);
  assert.doesNotMatch(text, /PAYG:/, 'not while Azure AI is off');
  assert.doesNotMatch(text, /datasets\//, 'no model of its own to link to');

  const left = setup();
  left.config.dataSources.azureAi = 'skip';
  consumptionSummary(left.ctx);
  assert.match(left.ui.text(), /Azure AI: {3}left out$/m);

  const flowing = setup();
  Object.assign(flowing.config.dataSources, { studioCredits: 'api', coworkCredits: 'api' });
  flowing.config.consumption.dataflowId = 'df-1';
  consumptionSummary(flowing.ctx);
  const ft = flowing.ui.text();
  assert.match(ft, /a daily flow reads the licensing API/);
  assert.match(ft, /Sign in to the flow and turn it on/);
  has(ft, `Optional: drop the Power Platform admin center exports in ${UPLOAD_DIR}.`);
  assert.doesNotMatch(ft, /download the EntitlementConsumption/);
  has(ft, `Cowork credits  (Dataflow ${COWORK_DATAFLOW_NAME}, refreshed by the pipeline)`);
  const steps = coworkSignInSteps(flowing.config);
  steps.forEach((step, i) => has(ft, `  ${i + 1}. ${step}`));
  has(ft, 'Until then, each scheduled pipeline run notes that the refresh failed.');
  has(ft, `  ${steps.length + 1}. Keep the Viva Insights query on Auto-refresh.`);
  has(ft, `Guide: ${DATAFLOW_GUIDE}`);
  has(ft, STAGING_ITEMS_NOTE);
  assert.doesNotMatch(ft, /upload the export\)|choose Connected/);

  const skipped = setup();
  Object.assign(skipped.config.dataSources, { studioCredits: 'skip', coworkCredits: 'skip' });
  consumptionSummary(skipped.ctx);
  assert.doesNotMatch(skipped.ui.text(), /Copilot Studio credits|Cowork credits/);

  const on = setup();
  Object.assign(on.config.consumption, {
    azureSubscriptionId: SUB,
    azureSubscriptionName: 'AI',
    azureAccess: true,
    paygSubscriptions: [
      { subscriptionId: PAYG, name: 'Studio billing', policies: ['Studio'], access: true },
      { subscriptionId: HIDDEN, policies: ['Elsewhere'] },
    ],
  });
  consumptionSummary(on.ctx);
  assert.match(on.ui.text(), /Azure AI: {3}AI, read on every run/);
  assert.match(on.ui.text(), /PAYG: +Copilot Studio and Cowork pay-as-you-go billed to AI and Studio billing/);
  has(on.ui.text(), `not ${HIDDEN} until ${APP_REGISTRATION} has Cost Management Reader there`);
});
