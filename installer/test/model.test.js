// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { notebooksFor } from '../src/catalog.js';
import { emptyConfig } from '../src/config.js';
import { modelDeployed, pipelineSignature } from '../src/steps/fabric.js';
import { notebookSettings } from '../src/steps/notebook-settings.js';
import { buildModel, datasourcePath, decodeText, loadTemplateModel, mNumber, mNumberParameter, mParameter, mString, readTemplateModel, setMNumberParameter, setMParameter } from '../src/transform/model.js';
import { prepareNotebook } from '../src/transform/notebook.js';
import { PAYG_TABLE } from '../src/transform/payg.js';
import { buildPipeline, findActivity, REFRESH_ACTIVITY, REFRESH_TIMING, STATUS_ACTIVITY } from '../src/transform/pipeline.js';
import { listZip, readZipEntry } from '../src/transform/zip.js';
import { defaultDataSources } from '../src/uploads.js';
import { fakeCtx, realSources } from './fakes.js';

/**
 * A minimal zip with one stored and one deflated entry per file.
 * @param {Record<string, { data: Buffer, deflate?: boolean }>} files
 */
function makeZip(files) {
  /** @type {Buffer[]} */
  const locals = [];
  /** @type {Buffer[]} */
  const central = [];
  let offset = 0;
  for (const [name, { data, deflate }] of Object.entries(files)) {
    const body = deflate ? deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(deflate ? 8 : 0, 10);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += 30 + nameBuf.length + body.length;
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

const MODEL_FILE = /** @type {string} */ (realSources().modelFile);
const template = loadTemplateModel(MODEL_FILE);
const settings = { server: 'abc.datawarehouse.fabric.microsoft.com', database: 'ConsumptionCentral' };

test('zip: stored and deflated entries read back; a missing entry or non-zip fails', () => {
  const text = Buffer.from('hello '.repeat(200));
  const zip = makeZip({ 'a.txt': { data: Buffer.from('plain') }, 'b/c.json': { data: text, deflate: true } });
  assert.deepEqual([...listZip(zip).keys()], ['a.txt', 'b/c.json']);
  assert.equal(readZipEntry(zip, 'a.txt').toString(), 'plain');
  assert.equal(readZipEntry(zip, 'b/c.json').toString(), text.toString());
  assert.throws(() => readZipEntry(zip, 'nope'), /has no nope/);
  assert.throws(() => listZip(Buffer.alloc(40)), /Not a zip file/);
});

test('decodeText handles UTF-16 and UTF-8, with or without a byte-order mark', () => {
  const s = '{"model":"é"}';
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')])), s);
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s, 'utf8')])), s);
  assert.equal(decodeText(Buffer.from(s, 'utf16le')), s);
  assert.equal(decodeText(Buffer.from(s, 'utf8')), s);
});

test('readTemplateModel takes the model from DataModelSchema and drops its name', () => {
  const schema = { name: 'abc-123', compatibilityLevel: 1600, model: { tables: [{ name: 'T' }] } };
  const pbit = makeZip({ DataModelSchema: { data: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(schema), 'utf16le')]), deflate: true } });
  const bim = readTemplateModel(pbit);
  assert.deepEqual(bim, { compatibilityLevel: 1600, model: { tables: [{ name: 'T' }] } });
  assert.throws(() => readTemplateModel(makeZip({ DataModelSchema: { data: Buffer.from('{"model":{}}') } })), /no data model/);
});

test('the real template: source parameters filled in, the pay-as-you-go table added, prices left as they are, the template untouched', () => {
  const before = JSON.stringify(template);
  const bim = buildModel(template, settings);
  assert.equal(JSON.stringify(template), before);
  assert.equal(mParameter(bim.model, 'FabricSQLEndpoint'), settings.server);
  assert.equal(mParameter(bim.model, 'LakehouseName'), 'ConsumptionCentral');
  const endpoint = bim.model.expressions?.find((e) => e.name === 'FabricSQLEndpoint');
  assert.match(String(endpoint?.expression), /^"abc\.datawarehouse\.fabric\.microsoft\.com" meta \[IsParameterQuery=true/);
  assert.equal(/** @type {any} */ (bim).name, undefined);
  assert.ok(bim.compatibilityLevel >= 1600);
  assert.ok(bim.model.tables.some((t) => t.name === PAYG_TABLE));
  assert.ok(!template.model.tables.some((t) => t.name === PAYG_TABLE), 'the installer adds it; the template has no such table');
  for (const name of ['CreditRate', 'BillingPeriodWeeks']) {
    assert.equal(typeof mNumberParameter(template.model, name), 'number', name);
    assert.equal(mNumberParameter(bim.model, name), mNumberParameter(template.model, name), name);
  }
});

test('M parameters: quotes are escaped; a missing or non-parameter query fails', () => {
  assert.equal(mString('a "b"'), '"a ""b"""');
  const model = { tables: [], expressions: [{ name: 'P', expression: 'null meta [IsParameterQuery=true]' }, { name: 'Q', expression: 'let x = 1 in x' }] };
  setMParameter(model, 'P', 'say "hi"');
  assert.equal(mParameter(model, 'P'), 'say "hi"');
  assert.throws(() => setMParameter(model, 'Missing', 'x'), /no "Missing" parameter/);
  assert.throws(() => setMParameter(model, 'Q', 'x'), /not a parameter/);
  assert.equal(datasourcePath('s.example', 'db'), 's.example;db');
});

test('M number parameters keep their meta record; a text, missing or non-parameter query, or a value Power Query cannot read, fails', () => {
  const meta = ' meta [IsParameterQuery=true, Type="Number", IsParameterQueryRequired=true]';
  const model = {
    tables: [],
    expressions: [
      { name: 'N', expression: `0.01${meta}` },
      { name: 'T', expression: '"x" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]' },
      { name: 'Q', expression: 'let x = 1 in x' },
    ],
  };
  setMNumberParameter(model, 'N', 0.025);
  assert.equal(model.expressions[0].expression, `0.025${meta}`);
  assert.equal(mNumberParameter(model, 'N'), 0.025);
  assert.equal(mNumberParameter(model, 'T'), undefined);
  assert.equal(mNumberParameter(model, 'Missing'), undefined);
  assert.throws(() => setMNumberParameter(model, 'Missing', 1), /no "Missing" parameter/);
  assert.throws(() => setMNumberParameter(model, 'Q', 1), /"Q" is not a parameter/);
  assert.throws(() => setMNumberParameter(model, 'T', 1), /"T" is not a Number parameter/);
  assert.throws(() => setMNumberParameter(model, 'N', Number.NaN), /NaN is not a number Power Query can read/);
  assert.throws(() => mNumber(Number.POSITIVE_INFINITY), /Infinity is not a number Power Query can read/);
  assert.equal(mNumberParameter(model, 'N'), 0.025, 'a failed set leaves the value');

  const priced = buildModel(template, { ...settings, prices: { CreditRate: 0.02 } });
  assert.equal(mNumberParameter(priced.model, 'CreditRate'), 0.02);
  assert.equal(mNumberParameter(priced.model, 'PrepaidCreditRate'), mNumberParameter(template.model, 'PrepaidCreditRate'), 'the rest keep the template values');
  assert.throws(() => buildModel(template, { ...settings, prices: { NoSuchRate: 1 } }), /no "NoSuchRate" parameter/);
});

const WS = 'f0000000-0000-0000-0000-000000000000';
const { catalog } = realSources();
/** @type {import('../src/uploads.js').DataSourceModes} */
const sources = { ...defaultDataSources(), github: 'csv', orgData: 'csv' };
const ids = Object.fromEntries(catalog.map((nb) => [nb.key, `nb-${nb.key}`]));
/** @param {{ source: string | string[] }} cell */
const cellText = (cell) => (Array.isArray(cell.source) ? cell.source.join('') : cell.source);

test('pipeline: with a model, the refresh waits for the usage loads to succeed and for org data, and the status step runs after it', () => {
  const doc = buildPipeline(catalog, { workspaceId: WS, notebookIds: ids, dataSources: sources, modelId: 'model-1' });
  const acts = doc.properties.activities;
  assert.deepEqual(acts.slice(-2).map((a) => a.name), [REFRESH_ACTIVITY, STATUS_ACTIVITY]);
  const refresh = findActivity(acts, REFRESH_ACTIVITY);
  assert.deepEqual(refresh.dependsOn, [
    { activity: 'Run_Consumption_Studio', dependencyConditions: ['Succeeded'] },
    { activity: 'Run_Consumption_Viva', dependencyConditions: ['Succeeded'] },
    { activity: 'Run_Consumption_GitHub', dependencyConditions: ['Succeeded'] },
    { activity: 'Run_Org_Data', dependencyConditions: ['Completed'] },
  ]);
  assert.equal(refresh.typeProperties.notebookId, 'nb-refreshModel');
  assert.deepEqual(refresh.typeProperties.parameters, {
    WORKSPACE_ID: { value: WS, type: 'string' },
    SEMANTIC_MODEL_ID: { value: 'model-1', type: 'string' },
    TIMEOUT_MINUTES: { value: 170, type: 'int' },
  });
  const [days, hms] = String(refresh.policy.timeout).split('.');
  const [hours, minutes] = hms.split(':').map(Number);
  assert.ok(REFRESH_TIMING.minutes < (Number(days) * 24 + hours) * 60 + minutes, 'the notebook gives up before the step times out');
  assert.deepEqual(findActivity(acts, STATUS_ACTIVITY).dependsOn, [{ activity: REFRESH_ACTIVITY, dependencyConditions: ['Completed', 'Skipped'] }]);
  assert.match(doc.properties.description, /The semantic model refreshes once every usage load has succeeded\./);
});

test('pipeline: no model, no refresh; a model without the refresh notebook is an error', () => {
  const doc = buildPipeline(catalog, { workspaceId: WS, notebookIds: ids, dataSources: sources });
  assert.equal(findActivity(doc.properties.activities, REFRESH_ACTIVITY), undefined);
  assert.doesNotMatch(doc.properties.description, /semantic model/);
  assert.deepEqual(findActivity(doc.properties.activities, STATUS_ACTIVITY).dependsOn, [{ activity: 'Run_Org_Data', dependencyConditions: ['Completed', 'Skipped'] }]);
  const { refreshModel, ...rest } = ids;
  assert.throws(() => buildPipeline(catalog, { workspaceId: WS, notebookIds: rest, dataSources: sources, modelId: 'm' }), /semantic model refresh notebook has not been deployed/);
});

test('the refresh notebook is deployed only with a connected model, with its IDs filled in', () => {
  assert.ok(!notebooksFor(catalog, sources).some((nb) => nb.key === 'refreshModel'));
  const nb = notebooksFor(catalog, sources, { semanticModel: true }).find((n) => n.key === 'refreshModel');
  assert.ok(nb);

  const config = emptyConfig();
  Object.assign(config.semanticModel, { enabled: true, id: 'model-9' });
  assert.equal(modelDeployed(config), false, 'not connected yet');
  const unbound = pipelineSignature(config, catalog);
  assert.doesNotMatch(unbound, /refreshModel|model=/);
  config.semanticModel.bound = true;
  assert.equal(modelDeployed(config), true);
  assert.notEqual(pipelineSignature(config, catalog), unbound, 'connecting the model changes the pipeline');
  assert.match(pipelineSignature(config, catalog), /refreshModel.*;model=model-9$/);

  const { ctx } = fakeCtx({ config });
  const text = JSON.stringify(prepareNotebook(realSources().notebooks.refreshModel, notebookSettings(ctx, nb)));
  assert.match(text, /WORKSPACE_ID = 'ws-1'/);
  assert.match(text, /SEMANTIC_MODEL_ID = 'model-9'/);
});

test('the refresh notebook takes every parameter the pipeline passes in its parameters cell, and refreshes the whole model', () => {
  const nb = catalog.find((n) => n.key === 'refreshModel');
  assert.ok(nb);
  const doc = buildPipeline(catalog, { workspaceId: WS, notebookIds: ids, dataSources: sources, modelId: 'model-1' });
  const passed = Object.keys(findActivity(doc.properties.activities, REFRESH_ACTIVITY).typeProperties.parameters);
  assert.deepEqual(passed, nb.parameters);

  const config = emptyConfig();
  Object.assign(config.semanticModel, { enabled: true, id: 'model-1', bound: true });
  const { ctx } = fakeCtx({ config });
  const prepared = prepareNotebook(realSources().notebooks.refreshModel, notebookSettings(ctx, nb));
  const tagged = prepared.cells.filter((c) => c.metadata?.tags?.includes('parameters'));
  assert.equal(tagged.length, 1);
  for (const name of passed) assert.match(cellText(tagged[0]), new RegExp(`^${name} = `, 'm'), name);
  assert.match(prepared.cells.map(cellText).join('\n'), /'type': 'full'/);
  assert.ok(!template.model.tables.some((t) => /** @type {any} */ (t).refreshPolicy), 'no table has an incremental refresh policy, so a full refresh reloads every table');
});
