// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askAdvanced, asksAdvanced } from '../src/steps/advanced.js';
import { capacityLabel, defaultsToNoVault, plan } from '../src/steps/plan.js';
import { fakeArm, fakeCtx, fakeFabric, fakeUi } from './fakes.js';

const PRE = /** @type {any} */ ({
  subscriptions: [{ subscriptionId: 'sub-1', displayName: 'Sub' }],
  canConsent: true,
  canCreateApps: true,
  capacities: [{ id: 'cap-1', displayName: 'F64', sku: 'F64', region: 'UK South', state: 'Active' }],
  tenantSettings: [],
});

/** The questions behind Advanced settings, which a default install doesn't ask. */
const ADVANCED_QUESTIONS = [
  'Deploy the semantic model?',
  'Who can view Consumption Central?',
  'Who should people ask for access? (email)',
  'Prices',
  'Lakehouse name',
  'How often should the pipeline run?',
  'Run the first load as soon as setup finishes?',
];

/**
 * fakeUi, also answering forms: each field's default, or the value given for it.
 * @param {Parameters<typeof fakeUi>[0]} [opts]
 * @param {Record<string, string>} [values]
 */
function formUi(opts, values = {}) {
  // fakeUi doesn't answer forms, and a plan with Advanced settings asks for the prices in one.
  const t = fakeUi(opts);
  /** @type {any} */ (t.ui).form = async (/** @type {string} */ message, /** @type {{ id: string, default: string }[]} */ fields) => {
    t.asked.push(message);
    return { ...Object.fromEntries(fields.map((f) => [f.id, f.default])), ...values };
  };
  return t;
}

test('advanced: one question, No by default, and asked about outside the plan', async () => {
  const { ui, asked, text } = fakeUi();
  const { ctx } = fakeCtx({ ui });
  assert.equal(asksAdvanced(ctx), true, 'commands with no Advanced question still ask');
  await askAdvanced(ctx, 'the schedule');
  assert.deepEqual(asked, ['Change the advanced settings?']);
  assert.match(text(), /Choose Yes to change the schedule/);
  assert.equal(ctx.advanced, false);
  assert.equal(asksAdvanced(ctx), false);

  const yes = fakeCtx({ ui: fakeUi({ answers: [true] }).ui });
  await askAdvanced(yes.ctx, 'x');
  assert.equal(asksAdvanced(yes.ctx), true);

  const quiet = fakeCtx({ ui: fakeUi({ yes: true }).ui });
  await askAdvanced(quiet.ctx, 'x');
  assert.equal(quiet.ctx.advanced, false, '--yes takes the defaults');
});

test('advanced: a Fabric plan with No asks only the essentials and keeps the defaults', async () => {
  const { ui, asked, text } = formUi();
  const { ctx, config } = fakeCtx({ ui, fabric: fakeFabric().api });
  delete config.fabric.lakehouseId;
  delete config.fabric.lakehouseName;
  await plan(ctx, PRE);
  assert.ok(asked.includes('Change the advanced settings?'));
  assert.ok(asked.includes('Which capacity should run it?'));
  for (const q of ADVANCED_QUESTIONS) assert.ok(!asked.some((a) => a.startsWith(q)), `didn't ask "${q}"`);
  assert.match(text(), /Choose Yes to change the model and report, who can view, your prices, the Lakehouse name/);
  assert.equal(config.semanticModel.enabled, true, 'the model and report are on');
  assert.equal(config.semanticModel.reports, true);
  assert.equal(config.prices, undefined, 'the template\'s prices');
  assert.equal(config.fabric.lakehouseName, 'ConsumptionCentral', 'a new install suggests the new name');
  assert.equal(config.schedule.frequency, 'daily');
  assert.equal(ctx.runFirstLoad, true);
  assert.equal(config.access?.groupName, 'Consumption Central Viewers');
});

test('plan: a new install suggests Consumption Central names and says what capacity suits', async () => {
  const t = formUi();
  const fabric = fakeFabric().api;
  const { ctx, config } = fakeCtx({ ui: t.ui, fabric: { ...fabric, listWorkspaces: async () => [{ id: 'ws-x', type: 'Workspace', displayName: 'Other' }] } });
  delete config.fabric.workspaceId;
  delete config.fabric.workspaceName;
  delete config.fabric.lakehouseId;
  delete config.fabric.lakehouseName;
  await plan(ctx, PRE);
  assert.equal(config.fabric.workspaceName, 'Consumption Central');
  assert.equal(config.fabric.lakehouseName, 'ConsumptionCentral');
  assert.match(t.text(), /A trial or small capacity works; on a large tenant, a larger capacity loads and refreshes faster\./);
});

test('plan: an existing record keeps its names', async () => {
  const { ui } = formUi();
  const { ctx, config } = fakeCtx({ ui, fabric: fakeFabric().api });
  delete config.fabric.lakehouseId;
  config.fabric.lakehouseName = 'ValueLens';
  await plan(ctx, PRE);
  assert.equal(config.fabric.lakehouseName, 'ValueLens');
});

test('plan: a new Fabric install keeps the secret in the notebooks by default; Key Vault is a choice', async () => {
  const fresh = (/** @type {any} */ u, /** @type {any} */ extra = {}) => {
    const t = fakeCtx({ ui: u.ui, fabric: fakeFabric().api, arm: fakeArm().api, ...extra });
    t.config.keyVault = { secretName: 'consumption-central-client-secret' };
    // Org data from Entra ID: the notebooks sign in as the app, so there is a client secret to keep.
    t.config.dataSources.orgData = 'api';
    return t;
  };
  const u = formUi();
  const t = fresh(u);
  assert.equal(defaultsToNoVault(t.ctx), true);
  await plan(t.ctx, PRE);
  assert.equal(t.config.keyVault.mode, 'notebook');
  assert.ok(u.asked.includes('Where should the client secret go?'));
  assert.ok(u.asked.includes('Keep the client secret in the notebooks, with no Key Vault?'));
  assert.ok(!u.asked.includes('Azure subscription'));
  assert.match(u.text(), /Anyone with a role in the workspace, Viewer included/);

  const quiet = fresh(formUi({ yes: true }));
  await plan(quiet.ctx, PRE);
  assert.equal(quiet.config.keyVault.mode, 'notebook', '--yes takes the default');

  const v = formUi();
  const select = v.ui.select;
  v.ui.select = /** @type {any} */ (async (/** @type {string} */ m, /** @type {any[]} */ ch, /** @type {any} */ d) => (m === 'Where should the client secret go?' ? (v.asked.push(m), 'keyvault') : select(m, ch, d)));
  const kv = fresh(v);
  await plan(kv.ctx, PRE).catch(() => {});
  assert.ok(v.asked.includes('Azure subscription'), 'Key Vault goes to the vault questions');
  assert.notEqual(kv.config.keyVault.mode, 'notebook');

  // --key-vault, flows that read the secret from the vault, or a vault already chosen skip the default.
  const flagged = fresh(fakeUi());
  flagged.ctx.useKeyVault = true;
  assert.equal(defaultsToNoVault(flagged.ctx), false);
  const flows = fresh(fakeUi());
  flows.config.uploads.flowIdentity = 'app';
  assert.equal(defaultsToNoVault(flows.ctx), false);
  const chosen = fresh(fakeUi());
  chosen.config.keyVault.name = 'kv-test';
  assert.equal(defaultsToNoVault(chosen.ctx), false);
});

test('capacityLabel: the SKU and region when Fabric gives them', () => {
  assert.equal(capacityLabel({ id: 'c', displayName: 'Prod', sku: 'F64', region: 'UK South' }), 'Prod (F64, UK South)');
  assert.equal(capacityLabel({ id: 'c', displayName: 'Trial', sku: 'FT1' }), 'Trial (FT1)');
  assert.equal(capacityLabel({ id: 'c', displayName: 'Bare' }), 'Bare');
});

test('advanced: a Fabric plan with Yes asks the settings behind it, the first load last', async () => {
  const { ui, asked } = formUi({ yesTo: ['Change the advanced settings?'] });
  const { ctx, config } = fakeCtx({ ui, fabric: fakeFabric().api });
  delete config.fabric.lakehouseId;
  delete config.fabric.lakehouseName;
  await plan(ctx, PRE);
  for (const q of ADVANCED_QUESTIONS) assert.ok(asked.some((a) => a.startsWith(q)), `asked "${q}"`);
  assert.equal(asked.at(-1), 'Run the first load as soon as setup finishes?');
  assert.equal(config.prices, undefined, 'prices left at the template\'s are not saved');
});

test('advanced: prices are asked only behind Yes and with the model, and only those that differ from the template are saved', async () => {
  const yes = formUi({ yesTo: ['Change the advanced settings?'] }, { creditRate: '0.012' });
  const a = fakeCtx({ ui: yes.ui, fabric: fakeFabric().api });
  await plan(a.ctx, PRE);
  assert.ok(yes.asked.includes('Prices'));
  assert.deepEqual(a.config.prices, { creditRate: 0.012 });

  const no = formUi();
  const b = fakeCtx({ ui: no.ui, fabric: fakeFabric().api });
  b.config.prices = { creditRate: 0.012 };
  await plan(b.ctx, PRE);
  assert.ok(!no.asked.includes('Prices'));
  assert.deepEqual(b.config.prices, { creditRate: 0.012 }, 'a saved price is kept');

  const off = formUi({ yesTo: ['Change the advanced settings?'] });
  const c = fakeCtx({ ui: off.ui, fabric: fakeFabric().api });
  c.config.semanticModel.enabled = false;
  await plan(c.ctx, PRE);
  assert.ok(off.asked.includes('Deploy the semantic model?'));
  assert.ok(!off.asked.includes('Prices'), 'no model, nothing to price');
});
