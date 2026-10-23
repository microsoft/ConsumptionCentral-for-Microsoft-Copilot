// @ts-check
/**
 * Keeping Consumption Central apart from Analytics Hub's installer, which can load the same consumption data
 * and which this installer was ported from: its install record, and a workspace it set up.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { emptyConfig, loadConfig } from '../src/config.js';
import { ANALYTICS_HUB_FOLDER, ANALYTICS_HUB_URL, foreignRecord, holdsOtherInstall, otherInstallIn, warnConsumptionLoaded } from '../src/other-installs.js';
import { fabricUninstall } from '../src/steps/fabric-uninstall.js';
import { ensureWorkspace } from '../src/steps/fabric.js';
import { plan } from '../src/steps/plan.js';
import { fakeCtx, fakeUi, httpError } from './fakes.js';

const PRE = /** @type {any} */ ({
  subscriptions: [],
  canConsent: true,
  canCreateApps: true,
  capacities: [{ id: 'cap-1', displayName: 'F64', sku: 'F64', region: 'UK South', state: 'Active' }],
  tenantSettings: [],
});

/** What Analytics Hub's installer leaves in its workspace, with its Credit Consumption module. */
const ANALYTICS_HUB_ITEMS = [
  { type: 'Lakehouse', displayName: 'ValueLens' },
  { type: 'DataPipeline', displayName: 'AnalyticsHub_Pipeline' },
  { type: 'Notebook', displayName: 'Copilot_Audit_Log_Ingest' },
  { type: 'Notebook', displayName: 'Consumption_Ingest_Studio' },
  { type: 'Notebook', displayName: 'Consumption_Ingest_Viva' },
];

/**
 * Fabric with workspaces and the items in them. listItems lists every item when no type is given, as Fabric does.
 * @param {Record<string, { name: string, items?: { type: string, displayName: string }[] }>} spaces
 */
function fabricWith(spaces) {
  /** @type {string[]} */
  const calls = [];
  const api = {
    listWorkspaces: async () => Object.entries(spaces).map(([id, s]) => ({ id, type: 'Workspace', displayName: s.name })),
    /** @param {string} ws @param {string} [type] */
    listItems: async (ws, type) => {
      calls.push(`listItems ${ws}${type ? ` ${type}` : ''}`);
      const items = (spaces[ws]?.items ?? []).map((i, n) => ({ id: `${ws}-${n}`, ...i }));
      return type ? items.filter((i) => i.type === type) : items;
    },
    /** @param {string} id */
    getWorkspace: async (id) => ({ id, displayName: spaces[id]?.name ?? id, capacityId: 'cap-1' }),
    listPrivateEndpoints: async () => [],
    /** @param {string} ws */
    deleteWorkspace: async (ws) => {
      calls.push(`deleteWorkspace ${ws}`);
      return null;
    },
  };
  return { api, calls };
}

/** @param {(dir: string) => void | Promise<void>} fn */
async function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-other-installs-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('install record: only one Consumption Central\'s installer wrote is read', async () => {
  await inTempDir((dir) => {
    const ours = join(dir, 'consumption-central-setup.json');
    writeFileSync(ours, JSON.stringify(emptyConfig()));
    assert.equal(loadConfig(ours).config.product, 'consumption-central');

    // Analytics Hub's installer writes the same record version, with no product field.
    const { product: _, ...analyticsHub } = emptyConfig();
    const theirs = join(dir, 'valuelens-install.json');
    writeFileSync(theirs, JSON.stringify(analyticsHub));
    assert.throws(() => loadConfig(theirs), (/** @type {Error} */ err) => {
      assert.match(err.message, /valuelens-install\.json isn't a Consumption Central install record: it has no "product" field\./);
      assert.ok(err.message.includes(ANALYTICS_HUB_URL));
      assert.match(err.message, /To set up Consumption Central, move the file aside or pass --config with another path\.$/);
      return true;
    });

    const other = join(dir, 'vlcc-setup.json');
    writeFileSync(other, JSON.stringify({ ...emptyConfig(), product: 'vlcc' }));
    assert.throws(() => loadConfig(other), /vlcc-setup\.json is a "vlcc" install record, not a Consumption Central one\. Use the installer that wrote it\./);

    for (const text of ['[]', 'null', '"x"', '1']) {
      const odd = join(dir, 'odd.json');
      writeFileSync(odd, text);
      assert.throws(() => loadConfig(odd), /odd\.json isn't an install record\./, text);
    }
  });
  assert.equal(foreignRecord({ product: 'consumption-central' }, 'f.json'), undefined);
});

test('otherInstallIn: Analytics Hub\'s items give its install away; OneLake is asked only when they don\'t', async () => {
  const fabric = fabricWith({ ah: { name: 'Analytics Hub', items: ANALYTICS_HUB_ITEMS } });
  /** @type {string[]} */
  const looked = [];
  const oneLake = /** @type {any} */ ({
    exists: async (/** @type {string} */ ws, /** @type {string} */ lh, /** @type {string} */ path) => {
      looked.push(`${ws} ${lh} ${path}`);
      return true;
    },
  });
  const found = await otherInstallIn({ fabric: /** @type {any} */ (fabric.api), oneLake }, 'ah');
  assert.deepEqual(found, {
    items: ['AnalyticsHub_Pipeline', 'Copilot_Audit_Log_Ingest'],
    consumption: ['Consumption_Ingest_Studio', 'Consumption_Ingest_Viva'],
  });
  assert.equal(holdsOtherInstall(found), true);
  assert.deepEqual(fabric.calls, ['listItems ah'], 'one call lists every item');
  assert.deepEqual(looked, []);

  // Items renamed by hand: its installer's folder in a Lakehouse still gives it away.
  const renamed = fabricWith({ ws: { name: 'Renamed', items: [{ type: 'Lakehouse', displayName: 'Data' }, { type: 'Lakehouse', displayName: 'More' }] } });
  const inFirst = await otherInstallIn({ fabric: /** @type {any} */ (renamed.api), oneLake }, 'ws');
  assert.deepEqual(inFirst, { items: [], consumption: [], folder: 'Data' });
  assert.deepEqual(looked, [`ws ws-0 ${ANALYTICS_HUB_FOLDER}`], 'stops at the first Lakehouse that has it');
  assert.equal(holdsOtherInstall(inFirst), true);

  const failing = /** @type {any} */ ({ exists: async () => Promise.reject(httpError(403, 'Forbidden')) });
  const unreadable = await otherInstallIn({ fabric: /** @type {any} */ (renamed.api), oneLake: failing }, 'ws');
  assert.equal(holdsOtherInstall(unreadable), false, 'a OneLake failure counts as no folder');
  const noOneLake = await otherInstallIn({ fabric: /** @type {any} */ (renamed.api) }, 'ws');
  assert.equal(holdsOtherInstall(noOneLake), false);
});

test('warnConsumptionLoaded: looks only in workspaces named the way Analytics Hub\'s installer suggests, at most five', async () => {
  /** @type {Record<string, { name: string, items?: { type: string, displayName: string }[] }>} */
  const spaces = {
    ah: { name: 'Analytics Hub', items: ANALYTICS_HUB_ITEMS },
    sales: { name: 'Sales', items: [{ type: 'Notebook', displayName: 'Consumption_Ingest_Studio' }] },
    empty: { name: 'analytics_hub test' },
  };
  for (let i = 0; i < 6; i++) spaces[`more-${i}`] = { name: `AnalyticsHub ${i}` };
  const fabric = fabricWith(spaces);
  const ui = fakeUi();
  const { ctx } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  const warned = await warnConsumptionLoaded(ctx, await fabric.api.listWorkspaces());
  assert.deepEqual([...warned], ['ah']);
  assert.match(
    ui.text(),
    /Workspace "Analytics Hub" already loads credit consumption, with Consumption_Ingest_Studio and Consumption_Ingest_Viva\. Analytics Hub's Credit Consumption module adds these notebooks\. Consumption Central loads the same data again, into its own Lakehouse\./,
  );
  assert.deepEqual(fabric.calls, ['listItems ah Notebook', 'listItems empty Notebook', 'listItems more-0 Notebook', 'listItems more-1 Notebook', 'listItems more-2 Notebook']);

  const broken = fabricWith({ ah: { name: 'Analytics Hub' } });
  broken.api.listItems = async () => Promise.reject(httpError(403, 'Forbidden'));
  const b = fakeCtx({ fabric: broken.api });
  assert.deepEqual([...(await warnConsumptionLoaded(b.ctx, await broken.api.listWorkspaces()))], [], 'a workspace it can\'t look in is skipped');
});

test('plan: a workspace Analytics Hub\'s installer set up is refused and the question asked again', async () => {
  const fabric = fabricWith({
    ah: { name: 'Analytics Hub', items: ANALYTICS_HUB_ITEMS },
    fin: { name: 'Finance BI', items: [{ type: 'Notebook', displayName: 'Consumption_Ingest_Viva' }] },
  });
  const t = fakeUi({ answers: ['cap-1', 'ah', 'fin'] });
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: t.ui });
  delete config.fabric.workspaceId;
  delete config.fabric.workspaceName;
  delete config.fabric.lakehouseId;
  delete config.fabric.lakehouseName;
  await plan(ctx, PRE, 'placement');
  assert.equal(config.fabric.workspaceId, 'fin');
  assert.equal(config.fabric.workspaceName, 'Finance BI');
  assert.deepEqual(t.asked.filter((q) => q === 'Workspace'), ['Workspace', 'Workspace']);
  const text = t.text();
  assert.match(
    text,
    /Workspace "Analytics Hub" holds an Analytics Hub install \(AnalyticsHub_Pipeline and Copilot_Audit_Log_Ingest\)\. Consumption Central needs a workspace of its own: uninstalling either one deletes its whole workspace\. Choose another workspace, or create a new one\./,
  );
  assert.match(text, /Workspace "Finance BI" already loads credit consumption, with Consumption_Ingest_Viva\./, 'the one chosen is looked in, whatever its name');

  // A workspace already warned about isn't warned about twice.
  const copy = fabricWith({ ahc: { name: 'Analytics Hub copy', items: [{ type: 'Notebook', displayName: 'Consumption_Ingest_Studio' }] } });
  const u = fakeUi({ answers: ['cap-1', 'ahc'] });
  const c = fakeCtx({ fabric: copy.api, ui: u.ui });
  delete c.config.fabric.workspaceId;
  delete c.config.fabric.lakehouseId;
  await plan(c.ctx, PRE, 'placement');
  assert.equal(c.config.fabric.workspaceId, 'ahc');
  assert.equal(u.text().match(/already loads credit consumption/g)?.length, 1);
  assert.doesNotMatch(u.text(), /holds an Analytics Hub install/, 'its notebooks alone aren\'t an install');
});

test('ensureWorkspace: refuses a workspace the record names that holds an Analytics Hub install, before anything goes in it', async () => {
  const fabric = fabricWith({ ah: { name: 'Analytics Hub', items: ANALYTICS_HUB_ITEMS } });
  const { ctx, config } = fakeCtx({ fabric: fabric.api });
  config.fabric.workspaceId = 'ah';
  config.fabric.capacityId = 'cap-1';
  delete config.fabric.lakehouseId;
  await assert.rejects(
    ensureWorkspace(ctx),
    /Workspace "Analytics Hub" holds an Analytics Hub install \(AnalyticsHub_Pipeline and Copilot_Audit_Log_Ingest\)\. .* Remove "workspaceId" from the install record, then run the installer again to choose another\./,
  );

  // With the Lakehouse in the record, the install is already there: no look.
  config.fabric.lakehouseId = 'lh-1';
  fabric.calls.length = 0;
  await ensureWorkspace(ctx);
  assert.deepEqual(fabric.calls, []);

  // A workspace it can't look in doesn't stop the install.
  const broken = fabricWith({ ws: { name: 'Mine' } });
  broken.api.listItems = async () => Promise.reject(httpError(500, 'Internal'));
  const b = fakeCtx({ fabric: broken.api });
  b.config.fabric.workspaceId = 'ws';
  b.config.fabric.capacityId = 'cap-1';
  delete b.config.fabric.lakehouseId;
  await ensureWorkspace(b.ctx);
  assert.equal(b.config.fabric.workspaceName, 'Mine');
});

test('uninstall: a workspace that also holds an Analytics Hub install says so, and No is the default', async () => {
  const fabric = fabricWith({ 'ws-1': { name: 'Shared', items: ANALYTICS_HUB_ITEMS } });
  const ui = fakeUi({ yes: true });
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  config.fabric.createdWorkspace = true;
  config.fabric.workspaceName = 'Shared';
  assert.equal(await fabricUninstall(ctx), false, '--yes takes the default');
  assert.deepEqual(ui.asked, [
    'Delete workspace "Shared" and everything in it, including the Lakehouse data? It also holds an Analytics Hub install (AnalyticsHub_Pipeline and Copilot_Audit_Log_Ingest), which goes too.',
  ]);
  assert.ok(!fabric.calls.includes('deleteWorkspace ws-1'));
  assert.match(ui.text(), /Left workspace "Shared" alone\./);

  const sure = fabricWith({ 'ws-1': { name: 'Shared', items: ANALYTICS_HUB_ITEMS } });
  const s = fakeCtx({ fabric: sure.api, ui: fakeUi({ answers: [true] }).ui });
  s.config.fabric.createdWorkspace = true;
  assert.equal(await fabricUninstall(s.ctx), true, 'Yes still deletes it');
  assert.ok(sure.calls.includes('deleteWorkspace ws-1'));

  // A workspace of its own keeps the usual question and default.
  const own = fabricWith({ 'ws-1': { name: 'Consumption Central', items: [{ type: 'Lakehouse', displayName: 'ConsumptionCentral' }] } });
  const o = fakeUi({ yes: true });
  const oc = fakeCtx({ fabric: own.api, ui: o.ui });
  oc.config.fabric.createdWorkspace = true;
  assert.equal(await fabricUninstall(oc.ctx), true);
  assert.deepEqual(o.asked, ['Delete workspace "ws-1" and everything in it, including the Lakehouse data?']);
});
