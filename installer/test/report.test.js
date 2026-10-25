// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { emptyConfig } from '../src/config.js';
import { applyPowerBiChoice, blockedSettings, planReview, POWER_BI_SETTINGS, powerBiChoice, reserveNames } from '../src/steps/plan.js';
import { deployReport, ensureReports, reportsOn, reportsWanted, reportUrl } from '../src/steps/report.js';
import { PBIR_SCHEMA, pbir, readTemplateReport, reportDefinition, reportSignature } from '../src/transform/report.js';
import { readZipEntries, readZipEntry } from '../src/transform/zip.js';
import { fakeCtx, fakeFabric, fakeUi, httpError, realSources } from './fakes.js';

/** @param {any} item @param {string} path */
const part = (item, path) => item.content.parts.find((/** @type {any} */ p) => p.path === path);
/** @param {any} item @param {string} path */
const partJson = (item, path) => JSON.parse(Buffer.from(part(item, path).payload, 'base64').toString('utf8'));

/** @param {{ answers?: any[], config?: any }} [o] */
function setup(o = {}) {
  const fabric = fakeFabric();
  const ui = fakeUi({ answers: o.answers });
  const config = o.config ?? emptyConfig();
  config.semanticModel.enabled = true;
  config.semanticModel.reports = true;
  const made = fakeCtx({ ui: ui.ui, fabric: fabric.api, config });
  const model = fabric.add('SemanticModel', 'Consumption Central Model', null);
  config.semanticModel.id = model.id;
  return { ...made, fabric, ui, model };
}

/**
 * A zip of stored entries.
 * @param {Record<string, string>} files
 */
function storedZip(files) {
  /** @type {Buffer[]} */
  const locals = [];
  /** @type {Buffer[]} */
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dirBuf, end]);
}

test("the Fabric template's report is PBIR: its definition and static resources, sorted", () => {
  const parts = readTemplateReport(readFileSync(/** @type {string} */ (realSources().modelFile)));
  const paths = parts.map((p) => p.path);
  assert.ok(paths.includes('definition/report.json'));
  assert.ok(paths.includes('definition/version.json'));
  assert.ok(paths.some((p) => p.startsWith('definition/pages/')));
  assert.ok(paths.every((p) => p.startsWith('definition/') || p.startsWith('StaticResources/')), paths.join(', '));
  assert.deepEqual(paths, [...paths].sort(), 'sorted, so the signature is stable');
  for (const p of parts.filter((x) => x.path.endsWith('.json'))) JSON.parse(p.data.toString('utf8'));
});

test("a template's report leaves out Desktop's copy of the AppSource visuals and everything else outside its definition", () => {
  const pbit = storedZip({
    'DataModelSchema': '{}',
    'Report/StaticResources/RegisteredResources/logo.png': 'png',
    'Report/definition/report.json': '{}',
    'Report/CustomVisuals/Tornado/package.json': '{}',
    'Report/Layout': '{}',
    'Report/definition/version.json': '{}',
  });
  assert.deepEqual(readTemplateReport(pbit).map((p) => p.path), ['StaticResources/RegisteredResources/logo.png', 'definition/report.json', 'definition/version.json']);
});

test('reportDefinition binds the report to the model by id, and the signature ignores the model', () => {
  const parts = readTemplateReport(readFileSync(/** @type {string} */ (realSources().modelFile)));
  const def = reportDefinition(parts, 'model-9');
  assert.equal(def.parts[0].path, 'definition.pbir');
  assert.deepEqual(JSON.parse(Buffer.from(def.parts[0].payload, 'base64').toString('utf8')), pbir('model-9'));
  assert.equal(pbir('x').$schema, PBIR_SCHEMA);
  assert.equal(pbir('x').datasetReference.byConnection.connectionString, 'semanticmodelid=x');
  assert.ok(def.parts.every((p) => p.payloadType === 'InlineBase64'));
  assert.equal(def.parts.length, parts.length + 1);

  const sig = reportSignature(parts);
  assert.equal(sig, reportSignature(parts.map((p) => ({ ...p }))));
  const changed = parts.map((p) => (p.path === 'definition/report.json' ? { ...p, data: Buffer.concat([p.data, Buffer.from(' ')]) } : p));
  assert.notEqual(reportSignature(changed), sig);
});

test('a template without a PBIR report is an error', () => {
  assert.throws(() => readTemplateReport(readFileSync(/** @type {string} */ (realSources().modelFile)).subarray(0, 0)), /zip|central directory|file/i);
  assert.throws(() => readTemplateReport(storedZip({ 'Report/Layout': '{}' })), /no report in the PBIR format/);
});

test('reportsWanted: the Consumption Central report, on the semantic model, only when chosen with it', () => {
  const t = setup();
  const wanted = reportsWanted(t.ctx);
  assert.deepEqual(wanted.map((w) => w.name), ['Consumption Central']);
  assert.equal(wanted[0].model, t.config.semanticModel);
  assert.equal(wanted[0].file, t.ctx.sources.modelFile);

  t.config.semanticModel.reports = undefined;
  assert.equal(reportsOn(t.config), false, 'records from before the choice publish nothing');
  assert.deepEqual(reportsWanted(t.ctx), []);
  t.config.semanticModel.reports = true;
  t.config.semanticModel.enabled = false;
  assert.deepEqual(reportsWanted(t.ctx), []);
});

test('deployReport: publishes on the model, then leaves it alone', async () => {
  const t = setup();
  const [w] = reportsWanted(t.ctx);
  await deployReport(t.ctx, w);
  const item = t.fabric.items.find((i) => i.type === 'Report');
  assert.ok(item);
  assert.equal(item.displayName, 'Consumption Central');
  assert.equal(partJson(item, 'definition.pbir').datasetReference.byConnection.connectionString, `semanticmodelid=${t.model.id}`);
  assert.ok(part(item, 'definition/report.json'));
  const r = t.config.semanticModel.report;
  assert.equal(r?.id, item.id);
  assert.equal(r?.modelId, t.model.id);
  assert.ok(r?.signature);
  assert.equal(t.saves(), 3, "the name being created, Fabric's operation for it, then the report");

  await deployReport(t.ctx, w);
  assert.deepEqual(t.fabric.calls, ['createReport Consumption Central']);
  assert.match(t.ui.text(), /The Consumption Central report is in place/);
  assert.equal(reportUrl('ws-1', 'r-1'), 'https://app.powerbi.com/groups/ws-1/reports/r-1');
  assert.equal(reportUrl('ws-1', 'r-1', 'tenant-1'), 'https://app.powerbi.com/groups/ws-1/reports/r-1?ctid=tenant-1', 'opens in the install\'s tenant');
});

test('deployReport: a same-name report that is not ours is left alone', async () => {
  const t = setup();
  const theirs = t.fabric.add('Report', 'Consumption Central', 'theirs');
  await deployReport(t.ctx, reportsWanted(t.ctx)[0]);
  assert.equal(theirs.content, 'theirs');
  assert.equal(t.config.semanticModel.report?.name, 'Consumption Central 2');
  assert.deepEqual(t.fabric.calls, ['createReport Consumption Central 2']);
});

test('deployReport: a new template asks before replacing edits; no keeps them', async () => {
  const t = setup({ answers: [false, true] });
  const [w] = reportsWanted(t.ctx);
  await deployReport(t.ctx, w);
  const r = /** @type {import('../src/config.js').ReportConfig} */ (t.config.semanticModel.report);
  const published = r.signature;

  r.signature = 'older';
  await deployReport(t.ctx, w);
  assert.deepEqual(t.fabric.calls, ['createReport Consumption Central']);
  assert.equal(r.signature, 'older', 'still out of date, so the next update asks again');
  assert.match(t.ui.text(), /Save a copy/);
  assert.match(t.ui.asked.join('\n'), /new version of the Consumption Central report/);

  await deployReport(t.ctx, w);
  assert.deepEqual(t.fabric.calls.slice(1), ['updateReport Consumption Central']);
  assert.equal(r.signature, published);
});

test('deployReport: a redeployed model is picked up without asking; a deleted report is published again', async () => {
  const t = setup();
  const [w] = reportsWanted(t.ctx);
  await deployReport(t.ctx, w);
  const r = /** @type {import('../src/config.js').ReportConfig} */ (t.config.semanticModel.report);

  const model = t.fabric.add('SemanticModel', 'Consumption Central Model 2', null);
  t.config.semanticModel.id = model.id;
  await deployReport(t.ctx, w);
  assert.deepEqual(t.fabric.calls.slice(1), ['updateReport Consumption Central']);
  assert.equal(r.modelId, model.id);
  const item = t.fabric.items.find((i) => i.id === r.id);
  assert.equal(partJson(item, 'definition.pbir').datasetReference.byConnection.connectionString, `semanticmodelid=${model.id}`);
  assert.equal(t.ui.asked.length, 0);

  t.fabric.items.splice(t.fabric.items.indexOf(/** @type {any} */ (item)), 1);
  await deployReport(t.ctx, w);
  assert.match(t.ui.text(), /The Consumption Central report was deleted/);
  assert.deepEqual(t.fabric.calls.slice(2), ['createReport Consumption Central']);
  assert.notEqual(r.id, item?.id);
});

test('ensureReports: a report that fails is reported, and the install carries on', async () => {
  const t = setup();
  t.fabric.failures.createReport = [httpError(400, 'The definition is not valid.')];
  assert.equal(await ensureReports(t.ctx), false);
  assert.deepEqual(t.fabric.calls, ['createReport Consumption Central']);
  assert.match(t.ui.text(), /The Consumption Central report wasn't published: .*not valid/);
  assert.match(t.ui.text(), /then run ".*update"/);
  assert.equal(t.config.semanticModel.report?.id, undefined);

  assert.equal(await ensureReports(t.ctx), true, 'the next run publishes it');
  assert.ok(t.config.semanticModel.report?.id);
});

test('ensureReports: a model that is not deployed is skipped', async () => {
  const t = setup();
  delete t.config.semanticModel.id;
  assert.equal(await ensureReports(t.ctx), true, 'a skipped report is not a failure');
  assert.deepEqual(t.fabric.calls, []);
  assert.match(t.ui.text(), /Skipped the Consumption Central report: Consumption Central Model isn't deployed/);
});

test('plan: report names are reserved and listed for review', async () => {
  const t = setup();
  t.fabric.add('Report', 'Consumption Central', null);
  await reserveNames(t.ctx);
  assert.equal(t.config.semanticModel.report?.name, 'Consumption Central 2');
  const review = planReview(t.ctx);
  assert.deepEqual(
    review.creates.filter((i) => i.kind === 'Report').map((i) => [i.name, i.isNew]),
    [['Consumption Central 2', true]],
  );
  assert.equal(review.runsOn[0].what, 'Notebooks, pipeline, semantic model, report');
});

test("the Fabric template's report uses built-in visuals only, so the Power BI SDK visuals setting isn't asked for", () => {
  const pbit = readFileSync(/** @type {string} */ (realSources().modelFile));
  const report = JSON.parse(readZipEntry(pbit, 'Report/definition/report.json').toString('utf8').replace(/^\uFEFF/, ''));
  const hint = 'A custom visual needs the tenant setting "Allow visuals created using the Power BI SDK": add it to POWER_BI_SETTINGS with reports: true, as Analytics Hub does';
  assert.deepEqual(report.publicCustomVisuals ?? [], [], hint);
  assert.deepEqual((report.resourcePackages ?? []).filter((/** @type {any} */ r) => r.type === 'CustomVisual'), [], hint);
  assert.deepEqual([...readZipEntries(pbit, 'Report/CustomVisuals/').keys()], [], hint);
  assert.deepEqual(POWER_BI_SETTINGS.filter((s) => s.reports), []);
  assert.deepEqual(blockedSettings({ CustomVisualsTenant: { enabled: false } }, { reports: true }), []);
});

test('the Power BI choice: reports are offered by default, even to older installs, and each choice sets the record', () => {
  const config = emptyConfig();
  assert.equal(powerBiChoice(config), 'reports');
  config.semanticModel.enabled = true;
  assert.equal(powerBiChoice(config), 'reports', 'an install from before the choice gets the reports offered');
  config.semanticModel.reports = false;
  assert.equal(powerBiChoice(config), 'model');
  config.semanticModel.enabled = false;
  assert.equal(powerBiChoice(config), 'none');

  for (const [choice, model, reports] of /** @type {const} */ ([
    ['reports', true, true],
    ['model', true, false],
    ['none', false, false],
  ])) {
    applyPowerBiChoice(config, choice);
    assert.deepEqual([config.semanticModel.enabled, config.semanticModel.reports], [model, reports], choice);
    assert.equal(powerBiChoice(config), choice);
  }
});