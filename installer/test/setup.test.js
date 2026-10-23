// @ts-check
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { archiveConfig, emptyConfig, loadConfig, removeFile, saveConfig } from '../src/config.js';
import { restoreSetupDraft, reviewSetup, SETUP_SECTIONS, setupCategories, setupRecovery } from '../src/setup.js';
import { checkStaged, stageUpload, releaseStaged } from '../src/staging.js';
import { parseForm } from '../src/ui.js';
import { createWebUi } from '../src/web-ui.js';
import { HttpError } from '../src/http.js';
import { fakeArm, fakeAzureGraph, fakeCtx, fakeFabric, fakePowerBi } from './fakes.js';

/** @param {import('node:test').TestContext} t */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'installer-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const arm = fakeArm();
  const fabric = fakeFabric();
  const graph = fakeAzureGraph();
  const powerBi = fakePowerBi();
  const ui = createWebUi();
  const config = emptyConfig();
  config.tenantId = 'tenant-1';
  config.fabric.capacityId = 'cap-f';
  config.setup = { completed: setupCategories(config).map((cat) => cat.id), runFirstLoad: false };
  const { ctx } = fakeCtx({ config, ui, arm: arm.api, fabric: fabric.api, graph: {
      ...graph.api, myDirectoryRoles: async () => [], usersCanRegisterApps: async () => true,
    }, powerBi: powerBi.api });
  ctx.file = join(dir, 'record.json');
  ctx.save = () => saveConfig(ctx.file, config);
  ctx.save();
  return { ctx, config, ui, arm, fabric, graph, powerBi, draft: `${ctx.file}.draft.json` };
}

/** @param {import('../src/install.js').Ctx} ctx */
const pendingTokens = (ctx) => (ctx.pendingUploads ?? []).map((file) => file.token);

/**
 * Answer on the next tick so createWebUi has finished registering the open question.
 * @param {ReturnType<typeof createWebUi>} ui
 * @param {(event: import('../src/web-ui.js').UiEvent) => unknown} reply
 */
function respond(ui, reply) {
  /** @type {string[]} */
  const asked = [];
  ui.subscribe((e) => {
    if (e.type !== 'prompt') return;
    asked.push(e.message);
    setImmediate(() => {
      const value = reply(e);
      const result = ui.answer(e.id, value);
      assert.equal(result.ok, true, `${e.message}: ${result.error}`);
    });
  });
  return asked;
}

test('settings forms validate types, options, disabled choices and each field on the server', () => {
  const fields = [
    { id: 'region', label: 'Region', default: 'a', choices: [{ name: 'A', value: 'a' }, { name: 'B', value: 'b', disabled: true }] },
    { id: 'name', label: 'Name', default: '', validate: (/** @type {string} */ v) => v.trim() ? /** @type {const} */ (true) : 'Required' },
  ];
  assert.match(parseForm([], fields).error ?? '', /Fill in/);
  assert.match(parseForm({ region: 'b', name: 'ok' }, fields).error ?? '', /Region/);
  assert.match(parseForm({ region: 'a', name: '' }, fields).error ?? '', /Required/);
  assert.match(parseForm({ region: 1, name: 'ok' }, fields).error ?? '', /Region/);
  assert.deepEqual(parseForm({ region: 'a', name: 'ok', extra: 'ignored' }, fields).value, { region: 'a', name: 'ok' });
  assert.match(parseForm({ region: 'changed' }, [{ id: 'region', label: 'Region', default: 'original', readOnly: 'Already deployed' }]).error ?? '', /Already deployed/);
});

test('web settings and forms expose no validators, reject invalid values and support category cancellation', async () => {
  const ui = createWebUi();
  const settings = ui.settings([{ id: 'placement', title: 'Placement', summary: 'UK South', complete: true }], { changes: [] });
  let event = ui.history().at(-1);
  assert.equal(ui.answer(event?.id, 'arbitrary').ok, false);
  ui.answer(event?.id, 'placement');
  assert.equal(await settings, 'placement');
  ui.beginSection();
  const form = ui.form('Placement', [{ id: 'region', label: 'Region', default: 'uk', validate: (v) => v ? true : 'Required' }]);
  event = ui.history().at(-1);
  assert.equal(event?.settingsBack, true);
  assert.equal('validate' in event?.fields[0], false);
  assert.equal(ui.answer(event?.id, { region: '' }).ok, false);
  assert.equal(ui.cancelSection(), true);
  await assert.rejects(form, { name: 'SettingsCancelled' });
  ui.endSection();
  assert.equal(ui.cancelSection(), false);
});

test('structured failure recovery recognises region, model, policy and unknown failures', () => {
  const config = emptyConfig();
  const error = new HttpError('SQL capacity is locked', { method: 'POST', url: 'https://management.azure.com', status: 409,
    body: { error: { code: 'RegionDoesNotAllowProvisioning', message: 'SQL capacity is locked' } } });
  const region = setupRecovery(new Error('SQL region failed', { cause: error }), config);
  assert.equal(region.section, 'placement');
  assert.match(region.code ?? '', /RegionDoesNotAllowProvisioning/);
  assert.equal(setupRecovery(new Error('CognitiveServices deployment InsufficientQuota'), config).section, 'placement');
  assert.equal(setupRecovery(new Error('RequestDisallowedByPolicy'), config).section, 'identity');
  assert.equal(setupRecovery(new Error('Unknown failure'), config).section, undefined);
});

test('a saved draft resumes without overwriting the deployed record; cancel restores the whole category', async (t) => {
  const { ctx, config, ui, draft } = fixture(t);
  const original = readFileSync(ctx.file, 'utf8');
  let visits = 0;
  respond(ui, (e) => {
    if (e.kind === 'settings') return visits++ ? 'close' : 'schedule';
    if (e.kind === 'form') return { frequency: 'weekly', weekday: 'Friday', time: '05:00' };
    if (e.kind === 'select' || e.kind === 'confirm') return e.default;
    throw new Error(`Unexpected question: ${e.message}`);
  });
  assert.equal(await reviewSetup(ctx), false);
  assert.equal(config.schedule.frequency, 'weekly');
  assert.equal(readFileSync(ctx.file, 'utf8'), original);
  assert.equal(loadConfig(draft).config.schedule.time, '05:00');

  const resumed = createWebUi();
  ctx.ui = resumed;
  let restored = false;
  respond(resumed, (e) => {
    if (e.kind === 'settings') {
      if (restored) return 'close';
      restored = true;
      assert.match(e.categories.find((/** @type {any} */ c) => c.id === 'schedule').summary, /weekly/);
      return 'schedule';
    }
    if (e.kind === 'form') return null;
    if (e.kind === 'select') return e.default;
    throw new Error(`Unexpected question: ${e.message}`);
  });
  await reviewSetup(ctx);
  assert.equal(config.schedule.time, '05:00');
  assert.ok(existsSync(draft));
});

test('a validation failure keeps the overview open and refreshes availability for the next retry', async (t) => {
  const { ctx, ui, fabric } = fixture(t);
  ctx.setupRetry = true;
  const listCapacities = fabric.api.listCapacities;
  let gone = true;
  let checks = 0;
  fabric.api.listCapacities = async () => {
    checks++;
    // Until the retry, the chosen capacity isn't one the user can use.
    return (await listCapacities()).map((cap) => (gone && cap.id === 'cap-f' ? { ...cap, id: 'cap-other' } : cap));
  };
  let visits = 0;
  respond(ui, (e) => {
    if (e.kind === 'settings') {
      assert.match(e.notice, /capacity is no longer active/);
      visits++;
      gone = false;
      return 'deploy';
    }
    if (e.kind === 'confirm' && e.message === 'Go ahead?') return true;
    throw new Error(`Unrelated question: ${e.message}`);
  });
  assert.equal(await reviewSetup(ctx), true);
  assert.equal(visits, 1);
  assert.ok(checks >= 2);
});

test('fresh setup refuses deployment until required categories have been reviewed', async (t) => {
  const { ctx, config, ui } = fixture(t);
  delete config.fabric.lakehouseId;
  delete config.setup;
  ctx.setupRetry = true;
  respond(ui, (e) => {
    assert.equal(e.kind, 'settings');
    assert.match(e.notice, /Review these categories first/);
    return 'close';
  });
  assert.equal(await reviewSetup(ctx), false);
});

test('newer deployment IDs are never overwritten by an older draft; conflict resolution archives it', async (t) => {
  const { ctx, config, ui, draft } = fixture(t);
  respond(ui, () => 'close');
  await reviewSetup(ctx);
  config.fabric.workspaceId = 'new-workspace-from-terminal';
  config.fabric.lakehouseId = 'new-lakehouse-from-terminal';
  ctx.save();
  assert.equal(restoreSetupDraft(ctx), false);
  assert.equal(config.fabric.workspaceId, 'new-workspace-from-terminal');
  const conflictUi = createWebUi();
  ctx.ui = conflictUi;
  respond(conflictUi, (e) => {
    if (e.kind === 'select') {
      assert.match(e.message, /install record changed/);
      return 0;
    }
    return 'close';
  });
  await reviewSetup(ctx);
  assert.equal(config.fabric.lakehouseId, 'new-lakehouse-from-terminal');
  assert.ok(existsSync(draft), 'a new draft uses the latest deployment state');
});

test('selected uploads survive Save and close, and missing staged files explicitly require reselection', async (t) => {
  const { ctx, config, ui } = fixture(t);
  config.target = 'fabric';
  config.dataSources.orgData = 'csv';
  const upload = stageUpload('org.csv', new TextEncoder().encode('UserPrincipalName,Department\na@contoso.com,Sales\n'));
  t.after(() => releaseStaged(upload.token));
  const staged = checkStaged(upload.token, config.dataSources);
  assert.ok(staged.ok);
  ctx.pendingUploads = [staged.file];
  respond(ui, () => 'close');
  await reviewSetup(ctx);
  ctx.pendingUploads = undefined;
  const resumeUi = createWebUi();
  ctx.ui = resumeUi;
  respond(resumeUi, () => 'close');
  await reviewSetup(ctx);
  assert.deepEqual(pendingTokens(ctx), [upload.token]);
  releaseStaged(upload.token);
  ctx.pendingUploads = undefined;
  const missingUi = createWebUi();
  ctx.ui = missingUi;
  respond(missingUi, (e) => {
    assert.match(e.notice, /org.csv.*select them again/);
    assert.equal(e.categories.find((/** @type {any} */ c) => c.id === 'data').complete, false);
    return 'close';
  });
  await reviewSetup(ctx);
});

const locked = () => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });

test('draft delete and archive retry while a synced folder holds the file, and give up without throwing', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'installer-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'record.json.draft.json');
  let tries = 0;
  /** @type {number[]} */
  const waits = [];
  const wait = (/** @type {number} */ ms) => { waits.push(ms); };
  assert.equal(removeFile(file, { unlink: () => { if (++tries < 3) throw locked(); }, wait }), true);
  assert.equal(tries, 3);
  assert.equal(removeFile(file, { unlink: () => { throw locked(); }, wait, tries: 4 }), false);
  assert.equal(removeFile(file), true, 'a file that is already gone is removed');
  assert.throws(() => removeFile(file, { unlink: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } }), /EIO/);
  tries = 0;
  /** @type {string[]} */
  const moved = [];
  const to = archiveConfig(file, new Date(2026, 0, 2, 3, 4, 5), { rename: (_from, dest) => { if (++tries < 2) throw locked(); moved.push(dest); }, wait });
  assert.deepEqual(moved, [to]);
  assert.match(to, /record\.json\.draft\.20260102-030405\.json$/);
});

test('a locked draft after approval does not block the next deployment with a false record conflict', async (t) => {
  const { ctx, ui, draft } = fixture(t);
  ctx.setupRetry = true;
  const realUnlink = fs.unlinkSync;
  const lockDraft = t.mock.method(fs, 'unlinkSync', (/** @type {fs.PathLike} */ path) => {
    if (String(path) === draft) throw locked();
    return realUnlink(path);
  });
  syncBuiltinESMExports();
  t.after(() => { lockDraft.mock.restore(); syncBuiltinESMExports(); });
  respond(ui, (e) => {
    if (e.kind === 'confirm' && e.message === 'Go ahead?') return true;
    throw new Error(`Unexpected question: ${e.message}`);
  });
  assert.equal(await reviewSetup(ctx), true);
  assert.equal(existsSync(draft), true, 'the locked draft stays behind');
  assert.equal(loadConfig(draft).config.setup?.approved, true);
  lockDraft.mock.restore();
  syncBuiltinESMExports();

  const nextUi = createWebUi();
  ctx.ui = nextUi;
  ctx.setupRetry = true;
  respond(nextUi, (e) => {
    if (e.kind === 'confirm' && e.message === 'Go ahead?') return true;
    throw new Error(`Unexpected question: ${e.message}`);
  });
  assert.equal(await reviewSetup(ctx), true, 'no "install record changed" loop and no conflict prompt');
  assert.equal(existsSync(draft), false);
});

/** A new session (fresh ctx) on the same install record, as the next repair would start. @param {ReturnType<typeof fixture>} f */
function reopen(f) {
  const config = loadConfig(f.ctx.file).config;
  const ui = createWebUi();
  const { ctx } = fakeCtx({ config, ui, arm: f.arm.api, fabric: f.fabric.api, graph: f.ctx.api.graph, powerBi: f.powerBi.api });
  ctx.file = f.ctx.file;
  ctx.save = () => saveConfig(ctx.file, config);
  respond(ui, (e) => {
    if (e.kind === 'settings') return 'close';
    throw new Error(`Unexpected question: ${e.message}`);
  });
  return { ctx, config };
}

test('an approved deployment keeps its first-load choice out of the install record', async (t) => {
  const f = fixture(t);
  f.ctx.setupRetry = true;
  f.ctx.runFirstLoad = false;
  respond(f.ui, (e) => {
    if (e.kind === 'confirm' && e.message === 'Go ahead?') return true;
    throw new Error(`Unexpected question: ${e.message}`);
  });
  assert.equal(await reviewSetup(f.ctx), true);
  assert.equal(f.ctx.runFirstLoad, false, 'this deployment still skips the first load');
  const saved = loadConfig(f.ctx.file).config.setup;
  assert.ok(saved);
  assert.equal('runFirstLoad' in saved, false);

  const next = reopen(f);
  assert.equal(await reviewSetup(next.ctx), false);
  assert.equal(next.ctx.runFirstLoad, true, 'a later session decides from the first run, which never completed');
});

test('a new session ignores a first-load choice an install record saved earlier', async (t) => {
  const f = fixture(t);
  f.config.target = 'fabric';
  f.config.firstRun = { status: 'Completed' };
  f.config.setup = { completed: setupCategories(f.config).map((cat) => cat.id), runFirstLoad: true };
  f.ctx.save();
  const done = reopen(f);
  await reviewSetup(done.ctx);
  assert.equal(done.ctx.runFirstLoad, false, 'the first load already completed');
  assert.equal(loadConfig(`${f.ctx.file}.draft.json`).config.setup?.runFirstLoad, false, 'the draft keeps this session\'s answer');

  rmSync(`${f.ctx.file}.draft.json`);
  f.config.firstRun = { status: 'Incomplete' };
  delete f.config.setup;
  f.ctx.save();
  const incomplete = reopen(f);
  await reviewSetup(incomplete.ctx);
  assert.equal(incomplete.ctx.runFirstLoad, true, 'a record from before browser setup still finishes its first load');
});

test('setupCategories has one category per setup section, summarised from the record', () => {
  const config = emptyConfig();
  config.semanticModel.enabled = false;
  config.semanticModel.reports = false;
  const off = setupCategories(config);
  assert.deepEqual(off.map((c) => c.id), SETUP_SECTIONS);
  assert.deepEqual(off.map((c) => c.title), [
    'Data sources', 'Fabric placement', 'Power BI', 'Viewer access', 'Identity and secrets', 'Data source connections', 'Power Automate flow', 'Schedule and first load',
  ]);
  assert.ok(off.every((c) => c.complete === false));
  const summaries = (/** @type {ReturnType<typeof setupCategories>} */ cats) => Object.fromEntries(cats.map((c) => [c.id, c.summary]));
  const before = summaries(off);
  assert.match(before.data, /^Copilot Cowork and Work IQ credits: Upload CSV; .*; Org data: Skip; Credit rate from Azure Cost Management: Skip$/);
  assert.deepEqual({ ...before, data: undefined }, {
    data: undefined,
    placement: 'Choose workspace; capacity: not set',
    powerbi: 'Semantic model: off; reports: off',
    access: 'Choose who can view',
    identity: 'No app registration or secret needed',
    sources: 'Nothing to connect',
    governance: 'Flows: none',
    schedule: 'daily, 02:00 UTC',
  });

  Object.assign(config.dataSources, { coworkCredits: 'api', studioCredits: 'api', github: 'api', azureAi: 'api', orgData: 'api', commercialTerms: 'api' });
  config.semanticModel.enabled = true;
  delete config.semanticModel.reports;
  Object.assign(config.fabric, { workspaceName: 'Consumption Central', capacityId: 'cap-1' });
  config.access = { groupName: 'Consumption Central Viewers' };
  config.app.displayName = 'Consumption Central (Fabric)';
  config.keyVault.name = 'kv-contoso';
  Object.assign(config.consumption, { azureSubscriptionName: 'Contoso AI', vivaQuery: 'q-1' });
  config.github = { enterprise: 'contoso' };
  config.commercialTerms = { scope: '/subscriptions/00000000-0000-0000-0000-000000000001', scopeName: 'Contoso billing' };
  config.prices = { creditRate: 0.012 };
  config.uploads.flowEnvironment = { url: 'https://contoso.crm.dynamics.com', name: 'Contoso' };
  config.schedule = { ...config.schedule, frequency: 'weekly', time: '05:00' };
  config.setup = { completed: ['data', 'schedule'] };
  const on = setupCategories(config);
  assert.deepEqual({ ...summaries(on), data: undefined }, {
    data: undefined,
    placement: 'Consumption Central; capacity: cap-1',
    powerbi: 'Semantic model: on; reports: on',
    access: 'Consumption Central Viewers',
    identity: 'Consumption Central (Fabric); kv-contoso',
    sources: 'Azure AI: Contoso AI; Cowork: Viva Insights query q-1; GitHub: contoso; Credit rate: Contoso billing; Prices: CreditRate 0.012',
    governance: 'Flows: Contoso',
    schedule: 'weekly, 05:00 UTC',
  });
  assert.deepEqual(on.filter((c) => c.complete).map((c) => c.id), ['data', 'schedule']);

  config.keyVault.mode = 'notebook';
  assert.equal(summaries(setupCategories(config)).identity, 'Consumption Central (Fabric); secrets in the notebooks');
  // Only the model's connection signs in as the app: no secret to keep.
  Object.assign(config.dataSources, { coworkCredits: 'csv', studioCredits: 'csv', github: 'skip', azureAi: 'skip', orgData: 'skip', commercialTerms: 'skip' });
  assert.equal(summaries(setupCategories(config)).identity, 'Consumption Central (Fabric)');
  assert.equal(summaries(setupCategories(config)).sources, 'Prices: CreditRate 0.012');

  // A new record, before the Power BI choice: the model is on, so its connection needs the app.
  const fresh = summaries(setupCategories(emptyConfig()));
  assert.equal(fresh.powerbi, 'Semantic model: on; reports: on');
  assert.equal(fresh.identity, 'App registration');
});

/**
 * Edits one section in the browser, then saves and closes. Returns the sections still marked done.
 * @param {ReturnType<typeof fixture>} f
 * @param {string} section
 * @param {(e: any) => unknown} answer
 */
async function editSection(f, section, answer) {
  let visits = 0;
  respond(f.ui, (e) => {
    if (e.kind === 'settings') return visits++ ? 'close' : section;
    return answer(e);
  });
  assert.equal(await reviewSetup(f.ctx), false);
  return new Set(f.config.setup?.completed);
}

test('a data change that needs the app asks the identity section again, with the connections and flows', async (t) => {
  const f = fixture(t);
  const done = await editSection(f, 'data', (e) => {
    if (e.kind === 'sources') return { modes: { orgData: 'api' }, uploads: [] };
    throw new Error(`Unexpected question: ${e.message}`);
  });
  assert.equal(f.config.dataSources.orgData, 'api');
  for (const id of ['identity', 'sources', 'governance']) assert.ok(!done.has(id), `${id} is asked again`);
  for (const id of ['data', 'placement', 'powerbi', 'access', 'schedule']) assert.ok(done.has(id), `${id} stays done`);
});

test('a data change that needs no app or secret keeps the identity section', async (t) => {
  const f = fixture(t);
  const done = await editSection(f, 'data', (e) => {
    if (e.kind === 'sources') return { modes: { github: 'csv' }, uploads: [] };
    throw new Error(`Unexpected question: ${e.message}`);
  });
  assert.equal(f.config.dataSources.github, 'csv');
  for (const id of ['sources', 'governance']) assert.ok(!done.has(id), `${id} is asked again`);
  for (const id of ['data', 'identity', 'placement', 'powerbi', 'access', 'schedule']) assert.ok(done.has(id), `${id} stays done`);
});

test('turning the model off asks viewer access, the connections and the identity section again', async (t) => {
  const f = fixture(t);
  f.config.semanticModel.enabled = true;
  f.ctx.save();
  const done = await editSection(f, 'powerbi', (e) => {
    if (e.kind === 'select' && e.message === 'Deploy the semantic model?') return e.choices.findIndex((/** @type {any} */ c) => c.name === 'Neither');
    throw new Error(`Unexpected question: ${e.message}`);
  });
  assert.equal(f.config.semanticModel.enabled, false);
  for (const id of ['access', 'sources', 'identity']) assert.ok(!done.has(id), `${id} is asked again`);
  for (const id of ['data', 'powerbi', 'placement', 'governance', 'schedule']) assert.ok(done.has(id), `${id} stays done`);
});

test('restoreSetupDraft resumes, in place, only a draft of this tenant made from the current record', (t) => {
  const { ctx, config, draft } = fixture(t);
  assert.equal(restoreSetupDraft(ctx), true, 'no draft, nothing to restore');

  const revision = createHash('sha256').update(readFileSync(ctx.file)).digest('hex');
  const write = (/** @type {(d: any) => void} */ edit) => {
    const d = structuredClone(config);
    d.schedule.frequency = 'weekly';
    d.setup = { completed: ['schedule'], runFirstLoad: false, baseRevision: revision };
    edit(d);
    saveConfig(draft, d);
  };

  write((d) => { d.setup.baseRevision = 'older'; });
  assert.equal(restoreSetupDraft(ctx), false, 'the record changed after the draft was saved');
  assert.equal(config.schedule.frequency, 'daily');

  write((d) => { d.tenantId = 'tenant-2'; });
  assert.throws(() => restoreSetupDraft(ctx), { message: 'The saved setup draft belongs to a different tenant. Sign in to that tenant to resume it.' });

  write((d) => { d.setup.approved = true; });
  assert.equal(restoreSetupDraft(ctx), true);
  assert.equal(existsSync(draft), false, 'an approved draft is already in the record');
  assert.equal(config.schedule.frequency, 'daily');

  write(() => {});
  ctx.runFirstLoad = true;
  assert.equal(restoreSetupDraft(ctx), true);
  assert.equal(ctx.config, config, 'the same object, so everything holding it sees the draft');
  assert.equal(config.schedule.frequency, 'weekly');
  assert.deepEqual(config.setup?.completed, ['schedule']);
  assert.equal(ctx.runFirstLoad, false, 'the draft\'s first-load answer');
  assert.ok(existsSync(draft), 'the draft stays until it is approved');
});
