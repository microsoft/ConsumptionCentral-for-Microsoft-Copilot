// @ts-check
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { notebooksFor } from '../src/catalog.js';
import { applyDataFlags, parseCli } from '../src/cli.js';
import { emptyConfig } from '../src/config.js';
import { startServer } from '../src/server.js';
import { checkStaged, clearStaged, inspectFile, inspectPath, sizeOk, stageUpload } from '../src/staging.js';
import { checkCsvFiles, dataSourcesSummary, ensureUploads, planDataSources, uploadCommand, uploadFiles } from '../src/steps/data-sources.js';
import { cellText } from '../src/transform/notebook.js';
import { buildPipeline, UPLOAD_ROUTER_ACTIVITY } from '../src/transform/pipeline.js';
import {
  checkUploadSet,
  CONTEXT_GROUP,
  COWORK_TASKS_DIR,
  DATA_SOURCE_IDS,
  DATA_SOURCES,
  dataSource,
  decodeStart,
  defaultDataSources,
  describeSources,
  detectFile,
  detectSource,
  GITHUB_DIR,
  landsDirect,
  MAX_UPLOAD_BYTES,
  MODE_ALIASES,
  MODE_LABELS,
  modeLabel,
  normaliseDataSources,
  normHeader,
  ORG_DIR,
  pairTaskExports,
  parseCsvHeader,
  parseDataFlags,
  parseModes,
  PEOPLE_ALONE,
  routedSources,
  routerSignaturesJson,
  routerSources,
  routerWanted,
  SHAREPOINT_SUBDIR,
  sourceCards,
  STUDIO_DIR,
  UPLOAD_DIR,
  UPLOAD_FOLDERS,
  UPLOAD_KINDS,
  UPLOAD_LOG_TABLE,
  UPLOADABLE_SOURCES,
  uploadKind,
  uploadName,
  USAGE_GROUP,
  VIVA_DIR,
} from '../src/uploads.js';
import { createWebUi } from '../src/web-ui.js';
import { describeRecord, WEB_COMMANDS } from '../src/web-session.js';
import { fakeCtx, fakeUi, realSources } from './fakes.js';

/** @typedef {import('../src/uploads.js').DataSourceModes} Modes */
/** @typedef {import('../src/catalog.js').NotebookKey} NotebookKey */

/** A header row for each upload kind, in UPLOAD_KINDS order. */
const HEADERS = /** @type {Record<string, string>} */ ({
  studioTenant: 'Billing plan id,Environment id,Capacity type,Prepaid consumed quantity,Usage date',
  studioAgent: 'Agent id,Agent name,Billed credit,Non billed credit,Channel',
  studioUser: 'User id,User email,Credits used,Billable credit used',
  studioAgentDaily: 'Usage date,Agent id,Agent name,Billed credit,Non billed credit,Channel,Environment id',
  studioUserDaily: 'Usage date,User id,Environment id,Agent id,Billed credit,Non billed credit,Unit',
  studioEntitlement: 'Snapshot date,Environment id,Environment allocated,Tenant prepaid consumed,Tenant PAYG consumed',
  vivaCredits:
    'PersonId,MetricDate,ServiceId,ServiceName,SpendingPolicyId,Session count,Spending policy limit,Total Copilot Credits used,User limit,Organization,FunctionType',
  vivaPolicy: 'SpendingPolicyId,Name,PlanLimit,UserLimit,IncludedServices',
  coworkTasks: 'PersonId,MetricDate,TaskCategory,TaskType,Total credits used,Total Cowork tasks',
  coworkPeople: 'PeopleHistoricalId,Organization,FunctionType,IsCopilotLicensed',
  githubUsage:
    'date,username,product,sku,model,quantity,unit_type,applied_cost_per_quantity,gross_amount,discount_amount,net_amount,organization,repository,cost_center_name',
  githubMap: 'username,userPrincipalName,displayName,plan',
  orgFile: 'userPrincipalName,displayName,mail,jobTitle,department,officeLocation,country',
});

/** Exports Analytics Hub read that Consumption Central doesn't. */
const DROPPED = {
  productFeedback: 'Feedback Id,Date submitted (UTC),Feedback type,App,Feedback,Email',
  agent365: 'Agent name,Title ID,Publisher type,Availability,Created by',
  workday: 'Primary Work Email,Cost Center,Level',
};

const TASKS = `${HEADERS.coworkTasks}\nperson-1,2026-05-04,Research,Chat,12.5,3\n`;
const PEOPLE = `${HEADERS.coworkPeople}\nphid-1,Contoso Sales,Sales,TRUE\n`;
/** fakeCtx's clock, as uploadName stamps it. */
const STAMP = '20260601T120000Z';
const UNKNOWN = `It doesn't look like any export Consumption Central reads. Expected one of: Viva credits or spending policies, a Cowork task export with its PeopleMetaData.csv, Copilot Studio credits (PPAC exports or the Studio flow's files), a GitHub usage report or seat map, or an org file.`;
const PAIR_DETAIL = `A Cowork task export is read with the PeopleMetaData.csv that came with it, so the two arrive together: run "consumption-central-installer upload" with both files, or put both in Files/landing/viva/cowork_tasks/ as CoworkWeeklyMetrics.csv and PeopleMetaData.csv, replacing the ones there. A PeopleMetaData.csv on its own isn't needed: credits exports don't use it.`;

const sources = realSources();
const tmp = mkdtempSync(join(tmpdir(), 'consumption-central-uploads-test-'));
after(() => {
  rmSync(tmp, { recursive: true, force: true });
  clearStaged();
});

/**
 * @param {string} rel  Path under the test folder.
 * @param {string} text
 */
function csvFile(rel, text) {
  const p = join(tmp, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
}

/** @param {Partial<Modes>} [over] @returns {Modes} */
const defaultsWith = (over = {}) => ({ ...defaultDataSources(), ...over });
/** Every source skipped, except those given. @param {Partial<Modes>} [over] @returns {Modes} */
const only = (over = {}) => ({ .../** @type {Modes} */ (Object.fromEntries(DATA_SOURCE_IDS.map((id) => [id, 'skip']))), ...over });
const allCsv = () => only(/** @type {Partial<Modes>} */ (Object.fromEntries(UPLOADABLE_SOURCES.map((id) => [id, 'csv']))));

/** @param {string} name @param {string} kind */
const f = (name, kind) => ({ name, kind });
/** @param {string} k */
function kindOf(k) {
  const info = uploadKind(k);
  assert.ok(info, k);
  return info;
}
/** A kind's file name as an upload at fakeCtx's time would have it. @param {string} k */
const fill = (k) => kindOf(k).name.replace('{stamp}', STAMP);
/** @param {NotebookKey} key */
const notebookText = (key) => sources.notebooks[key].cells.map(cellText).join('\n');
/** @param {NotebookKey} key */
const notebookInfo = (key) => /** @type {import('../src/catalog.js').NotebookInfo} */ (sources.catalog.find((n) => n.key === key));
/** @param {string} g  A Spark glob. */
const globRe = (g) => new RegExp(`^${g.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`);
/** @param {string[]} a */
const sorted = (a) => [...new Set(a)].sort();
/** @param {ReturnType<typeof detectSource>} d */
const reason = (d) => (d.ok ? '' : d.reason);

/**
 * A Python dict of column aliases, with the aliases normalised as the router compares them.
 * @param {string} code
 * @param {RegExp} entryRe  Captures the key and the aliases.
 * @param {RegExp} itemRe  Captures one alias.
 * @returns {Record<string, string[]>}
 */
function aliasTable(code, entryRe, itemRe) {
  return Object.fromEntries([...code.matchAll(entryRe)].map((m) => [m[1], [...m[2].matchAll(itemRe)].map((x) => normHeader(x[1]))]));
}

/** A Lakehouse whose files are kept in memory. */
function fakeOneLake(fail = /** @type {RegExp | undefined} */ (undefined)) {
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  /** @type {string[]} */
  const dirs = [];
  return {
    files,
    dirs,
    async createDirectory(/** @type {string} */ _ws, /** @type {string} */ _lh, /** @type {string} */ path) {
      dirs.push(path);
      return true;
    },
    async writeFile(/** @type {string} */ _ws, /** @type {string} */ _lh, /** @type {string} */ path, /** @type {Uint8Array} */ data) {
      if (fail?.test(path)) throw new Error('403 Forbidden');
      files.set(path, data);
    },
  };
}

/**
 * An install with the router deployed and GitHub on Upload CSV, and a pipeline run that records how it was asked.
 * @param {{ answers?: unknown[], failWrites?: RegExp }} [o]
 */
function uploadInstall(o = {}) {
  const oneLake = fakeOneLake(o.failWrites);
  const { ui, text, asked } = fakeUi({ answers: o.answers ?? [] });
  const { ctx, config } = fakeCtx({ ui, oneLake });
  config.fabric.notebooks.uploadRouter = 'nb-router';
  config.dataSources = defaultsWith({ github: 'csv' });
  /** @type {{ wait: boolean }[]} */
  const runs = [];
  let ok = true;
  const runNow = async (/** @type {any} */ _ctx, /** @type {{ wait: boolean }} */ opts) => {
    runs.push(opts);
    return { ok };
  };
  return { oneLake, ctx, config, text, asked, runs, runNow, fail: () => (ok = false) };
}

test('detectSource: each export is recognised by its headers', () => {
  assert.deepEqual(Object.keys(HEADERS), UPLOAD_KINDS.map((k) => k.kind));
  for (const [kind, header] of Object.entries(HEADERS)) {
    const got = detectSource(parseCsvHeader(header));
    assert.ok(got.ok, `${kind}: ${reason(got)}`);
    assert.equal(got.kind.kind, kind);
    assert.equal(got.source, kindOf(kind).source);
  }
});

test('detectSource: no header, an unknown file, a tie and a source not on Upload CSV are refused', () => {
  assert.deepEqual(detectSource([]), { ok: false, reason: 'The file has no header row.', headers: [] });
  assert.deepEqual(detectSource(['Name', 'Colour']), { ok: false, reason: UNKNOWN, headers: ['Name', 'Colour'] });
  const both = parseCsvHeader(`${HEADERS.vivaCredits},Name,PlanLimit,UserLimit,IncludedServices`);
  assert.equal(reason(detectSource(both)), 'It matches more than one export (vivaCredits, vivaPolicy).');
  const map = parseCsvHeader(HEADERS.githubMap);
  assert.equal(reason(detectSource(map, ['studioCredits', 'coworkCredits'])), "It's a GitHub Copilot export, but that source isn't set to Upload CSV.");
  assert.equal(reason(detectSource(parseCsvHeader(HEADERS.studioUser), [])), "It's a Copilot Studio credits export, but that source isn't set to Upload CSV.");
  assert.ok(detectSource(map, ['github']).ok);
  for (const kind of ['coworkTasks', 'coworkPeople']) {
    const got = detectSource(parseCsvHeader(HEADERS[kind]), ['coworkTasks']);
    assert.ok(got.ok, kind);
    assert.equal(got.kind.policy, 'refuse', 'recognised, though the router refuses it');
    assert.ok(landsDirect(got.kind));
  }
});

test('detectSource: the kind matching the most groups wins', () => {
  /** @param {string} kind @param {string} header */
  const matches = (kind, header) => {
    const have = new Set(parseCsvHeader(header).map(normHeader));
    return kindOf(kind).groups.every((g) => g.some((h) => have.has(h)));
  };
  /** @param {string} header */
  const kindFor = (header) => {
    const got = detectSource(parseCsvHeader(header));
    return got.ok ? got.kind.kind : got.reason;
  };
  const githubPlusOrg = `${HEADERS.githubMap},department`;
  const tasksPlusOrg = `${HEADERS.coworkTasks},Organization,FunctionType`;
  for (const header of [HEADERS.vivaCredits, githubPlusOrg, tasksPlusOrg]) assert.ok(matches('orgFile', header), header);
  assert.equal(kindFor(HEADERS.vivaCredits), 'vivaCredits');
  assert.equal(kindFor(githubPlusOrg), 'githubMap');
  assert.equal(kindFor(tasksPlusOrg), 'coworkTasks');
  assert.equal(kindFor('PersonId,Organization'), 'orgFile');
  assert.equal(kindFor('userPrincipalName,displayName'), UNKNOWN);
  assert.equal(
    reason(detectSource(parseCsvHeader(HEADERS.vivaCredits), ['orgData'])),
    "It's a Copilot Cowork and Work IQ credits export, but that source isn't set to Upload CSV.",
    'the credits export wins even when only org data takes uploads',
  );
  for (const [name, header] of Object.entries(DROPPED)) assert.equal(kindFor(header), UNKNOWN, name);
});

test('parseCsvHeader: a BOM, quotes, embedded commas, semicolons and tabs', () => {
  assert.deepEqual(parseCsvHeader('\uFEFF"User id","Credits, used","Say ""hi"""\r\n1,2,3'), ['User id', 'Credits, used', 'Say "hi"']);
  assert.deepEqual(parseCsvHeader('a;b;c\n1;2;3'), ['a', 'b', 'c']);
  assert.deepEqual(parseCsvHeader('a\tb\tc'), ['a', 'b', 'c']);
  assert.deepEqual(parseCsvHeader(' a , b '), ['a', 'b']);
  assert.deepEqual(parseCsvHeader(''), []);
});

test('decodeStart: UTF-8 and UTF-16 saves from Excel', () => {
  const text = `${HEADERS.githubMap}\r\nmona,mona@contoso.com,Mona,Copilot Business\r\n`;
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);
  for (const bytes of [Buffer.from(text), Buffer.from(`\uFEFF${text}`), le, be]) {
    assert.equal(decodeStart(bytes), text);
    const got = detectFile(bytes, ['github']);
    assert.ok(got.ok);
    assert.equal(got.kind.kind, 'githubMap');
  }
});

test('uploadName: stamped, cleaned and kept a .csv', () => {
  const now = new Date('2026-06-01T12:34:56.789Z');
  assert.equal(uploadName('C:\\Users\\me\\Copilot usage (1).csv', now), '20260601T123456Z_Copilot_usage_1_.csv');
  assert.equal(uploadName('../.hidden', now), '20260601T123456Z_hidden.csv');
  assert.equal(uploadName('', now), '20260601T123456Z_upload.csv');
  assert.equal(uploadName('Seats.CSV', now), '20260601T123456Z_Seats.CSV');
});

test('DATA_SOURCES: each source with its modes, default, group and page', () => {
  assert.deepEqual(
    DATA_SOURCES.map((s) => [s.id, s.modes, s.defaultMode, s.group, s.page]),
    [
      ['coworkCredits', ['api', 'csv', 'skip'], 'csv', USAGE_GROUP, '1–4. Cowork'],
      ['coworkTasks', ['csv', 'skip'], 'skip', USAGE_GROUP, '2.1. Cowork: Tasks'],
      ['studioCredits', ['api', 'csv', 'skip'], 'csv', USAGE_GROUP, '5–8. Studio'],
      ['github', ['api', 'csv', 'skip'], 'skip', USAGE_GROUP, '11–14. GHCP'],
      ['azureAi', ['api', 'skip'], 'skip', USAGE_GROUP, '9–10.1. Azure'],
      ['orgData', ['api', 'csv', 'skip'], 'skip', CONTEXT_GROUP, undefined],
      ['commercialTerms', ['api', 'skip'], 'skip', CONTEXT_GROUP, undefined],
    ],
  );
  assert.deepEqual(DATA_SOURCES.map((s) => s.label), [
    'Copilot Cowork and Work IQ credits',
    'Cowork task categories',
    'Copilot Studio credits',
    'GitHub Copilot',
    'Azure AI Foundry and Azure OpenAI',
    'Org data',
    'Credit rate from Azure Cost Management',
  ]);
  assert.deepEqual([USAGE_GROUP, CONTEXT_GROUP], ['Usage and costs', 'People and prices']);
  assert.ok(DATA_SOURCES.every((s) => !s.locked), 'every source can be turned off');
  assert.deepEqual(DATA_SOURCE_IDS, DATA_SOURCES.map((s) => s.id));
  for (const gone of ['core', 'productFeedback', 'agent365', 'workday']) assert.ok(!(/** @type {string[]} */ (DATA_SOURCE_IDS)).includes(gone), gone);
  assert.deepEqual(defaultDataSources(), {
    coworkCredits: 'csv',
    coworkTasks: 'skip',
    studioCredits: 'csv',
    github: 'skip',
    azureAi: 'skip',
    orgData: 'skip',
    commercialTerms: 'skip',
  });
});

test('UPLOAD_KINDS: each kind, where it lands and what a newer one does', () => {
  assert.deepEqual(
    UPLOAD_KINDS.map((k) => [k.kind, k.source, k.dir, k.name, k.policy]),
    [
      ['studioTenant', 'studioCredits', STUDIO_DIR, 'EntitlementConsumptionTenantDetailsReport_MCSMessages_{stamp}.csv', 'replaceKind'],
      ['studioAgent', 'studioCredits', STUDIO_DIR, 'EntitlementConsumptionTenantPerAgentDetailsReport_MCSMessages_{stamp}.csv', 'replaceKind'],
      ['studioUser', 'studioCredits', STUDIO_DIR, 'EntitlementConsumptionTenantPerUserDetailsReport_MCSMessages_{stamp}.csv', 'replaceKind'],
      ['studioAgentDaily', 'studioCredits', STUDIO_DIR, 'StudioApiAgentDaily_{stamp}.csv', 'replaceKind'],
      ['studioUserDaily', 'studioCredits', STUDIO_DIR, 'StudioApiUserDaily_{stamp}.csv', 'replaceKind'],
      ['studioEntitlement', 'studioCredits', STUDIO_DIR, 'StudioApiEntitlement_{stamp}.csv', 'replaceKind'],
      ['vivaCredits', 'coworkCredits', VIVA_DIR, 'PersonServiceCreditsMetrics_{stamp}.csv', 'append'],
      ['vivaPolicy', 'coworkCredits', VIVA_DIR, 'SpendingPolicyMetadata_{stamp}.csv', 'replaceKind'],
      ['coworkTasks', 'coworkTasks', COWORK_TASKS_DIR, 'CoworkWeeklyMetrics.csv', 'refuse'],
      ['coworkPeople', 'coworkTasks', COWORK_TASKS_DIR, 'PeopleMetaData.csv', 'refuse'],
      ['githubUsage', 'github', GITHUB_DIR, 'GitHubUsage_{stamp}.csv', 'replaceKind'],
      ['githubMap', 'github', GITHUB_DIR, 'GitHubUserMap_{stamp}.csv', 'replaceKind'],
      ['orgFile', 'orgData', ORG_DIR, 'OrgData_{stamp}.csv', 'replaceKind'],
    ],
  );
  assert.equal(UPLOAD_DIR, 'Files/consumption_central_uploads');
  assert.equal(SHAREPOINT_SUBDIR, 'Files/consumption_central_uploads/sharepoint');
  assert.equal(UPLOAD_LOG_TABLE, 'dbo.consumption_central_upload_log');
  assert.deepEqual(
    [STUDIO_DIR, VIVA_DIR, COWORK_TASKS_DIR, GITHUB_DIR, ORG_DIR],
    ['Files/landing/studio', 'Files/landing/viva', 'Files/landing/viva/cowork_tasks', 'Files/landing/github', 'Files/landing/org'],
  );
  assert.deepEqual(UPLOAD_FOLDERS, [UPLOAD_DIR, STUDIO_DIR, VIVA_DIR, COWORK_TASKS_DIR, GITHUB_DIR, ORG_DIR]);
  assert.equal(MAX_UPLOAD_BYTES, 200 * 1024 * 1024);
  for (const k of UPLOAD_KINDS) for (const g of k.groups) assert.deepEqual(g, g.map(normHeader), `${k.kind} groups are normalised`);
  assert.deepEqual(UPLOAD_KINDS.filter((k) => landsDirect(k)).map((k) => k.kind), ['coworkTasks', 'coworkPeople']);
  assert.ok(UPLOAD_KINDS.filter((k) => landsDirect(k)).every((k) => k.detail === PAIR_DETAIL));
  assert.equal(landsDirect(undefined), false);
  assert.deepEqual(kindOf('coworkTasks').groups, [['personid', 'userprincipalname', 'upn'], ['metricdate'], ['totalcoworktasks', 'taskcount']]);
  assert.deepEqual(kindOf('coworkPeople').groups, [['peoplehistoricalid'], ['organization', 'organisation'], ['iscopilotlicensed', 'functiontype']]);
  assert.deepEqual(kindOf('githubMap').groups, [['username'], ['userprincipalname', 'upn', 'email'], ['displayname', 'name'], ['plan']]);
  assert.deepEqual(UPLOADABLE_SOURCES, ['studioCredits', 'coworkCredits', 'coworkTasks', 'github', 'orgData']);
  assert.equal(uploadKind('workday'), undefined);
});

test('UPLOAD_KINDS: the GitHub kinds are the columns and files the GitHub notebook reads', () => {
  const code = notebookText('github');
  const usage = code.indexOf('raw = read("*[Uu]sage*.csv")');
  const map = code.indexOf('raw = read("*[Mm]ap*.csv")');
  assert.ok(usage !== -1 && map > usage);
  /** Each F.col(pick(raw, ...)) is one group: the aliases the notebook accepts for a column. @param {string} s */
  const picks = (s) => [...s.matchAll(/F\.col\(pick\(raw, ([^)]*)\)\)/g)].map((x) => [...x[1].matchAll(/"([^"]+)"/g)].map((y) => normHeader(y[1])));
  assert.deepEqual(picks(code.slice(usage, map)), kindOf('githubUsage').groups);
  assert.deepEqual(picks(code.slice(map)), kindOf('githubMap').groups);
  assert.ok(globRe('*[Uu]sage*.csv').test(fill('githubUsage')));
  assert.ok(globRe('*[Mm]ap*.csv').test(fill('githubMap')));
  assert.ok(!globRe('*[Mm]ap*.csv').test(fill('githubUsage')));
  assert.ok(!globRe('*[Uu]sage*.csv').test(fill('githubMap')));
});

test('UPLOAD_KINDS: an org file needs a person and an org column the org notebook reads', () => {
  const aliases = aliasTable(notebookText('org'), /'(\w+)': \[([^\]]*)\]/g, /'([^']+)'/g);
  const [who, org] = kindOf('orgFile').groups;
  assert.equal(kindOf('orgFile').groups.length, 2);
  assert.deepEqual(sorted(who), sorted([...aliases.user_principal_name, ...aliases.person_id]));
  const others = Object.entries(aliases).filter(([k]) => !['user_principal_name', 'person_id', 'display_name'].includes(k));
  assert.deepEqual(sorted(org), sorted(others.flatMap(([, v]) => v)));
});

test('UPLOAD_KINDS: the Cowork task kinds are the columns and files the Viva notebook reads', () => {
  const code = notebookText('vivaConsumption');
  const start = code.indexOf('TASK_COLUMNS = {');
  assert.ok(start !== -1);
  const columns = aliasTable(code.slice(start, code.indexOf('}', start)), /"(\w+)": \(([^)]*)\)/g, /"([^"]+)"/g);
  const tasks = kindOf('coworkTasks').groups;
  const people = kindOf('coworkPeople').groups;
  assert.deepEqual(sorted(tasks[0]), sorted([...columns.person_id, ...columns.user_principal_name]));
  assert.deepEqual(sorted(tasks[1]), sorted(columns.metric_date));
  assert.deepEqual(sorted(tasks[2]), sorted(columns.task_count));
  assert.deepEqual(sorted(people[0]), sorted(columns.people_historical_id));
  assert.deepEqual(sorted(people[1]), sorted(columns.organization));
  assert.deepEqual(sorted(people[2]), sorted([...columns.function_type, ...columns.is_copilot_licensed]));
  for (const s of [
    'def task_key(name):\n    return re.sub("[^a-z0-9]", "", name.lower())',
    'task_key(p.rsplit("/", 1)[-1]).startswith("coworkweeklymetrics")',
    '.lower() == "peoplemetadata.csv"',
    'p.rsplit("/", 1)[0] == path.rsplit("/", 1)[0]',
    'if entry.name.startswith(("_", ".")):',
    'files.extend(viva_landing_files(fs, entry.path))',
    'top_level_files = viva_landing_files(notebookutils.fs, LANDING, recursive=False)',
    '.lower().startswith("personservicecreditsmetrics")',
    '.lower().startswith("spendingpolicymetadata")',
  ]) {
    assert.ok(code.includes(s), s);
  }
  assert.ok(normHeader(fill('coworkTasks')).startsWith('coworkweeklymetrics'));
  assert.equal(fill('coworkPeople').toLowerCase(), 'peoplemetadata.csv');
  assert.ok(fill('vivaCredits').toLowerCase().startsWith('personservicecreditsmetrics'));
  assert.ok(fill('vivaPolicy').toLowerCase().startsWith('spendingpolicymetadata'));
});

test('UPLOAD_KINDS: each kind lands where the notebook that reads it looks', () => {
  /** @type {Record<string, NotebookKey>} */
  const reader = { studioCredits: 'studioConsumption', coworkCredits: 'vivaConsumption', coworkTasks: 'vivaConsumption', github: 'github', orgData: 'org' };
  for (const k of UPLOAD_KINDS) {
    const landing = notebookInfo(reader[k.source]).landing;
    assert.ok(k.dir === landing || k.dir.startsWith(`${landing}/`), `${k.kind} lands in ${k.dir}, under ${landing}`);
  }
  for (const key of /** @type {NotebookKey[]} */ (['studioConsumption', 'vivaConsumption', 'github', 'org'])) {
    assert.match(notebookText(key), new RegExp(`^\\s*LANDING = "${notebookInfo(key).landing}"`, 'm'), key);
  }
  const globs = [...notebookText('studioConsumption').matchAll(/(?:EntitlementConsumption|StudioApi)\w+\*\.csv/g)].map((m) => globRe(m[0]));
  for (const k of UPLOAD_KINDS.filter((x) => x.source === 'studioCredits')) assert.ok(globs.some((g) => g.test(fill(k.kind))), k.kind);
});

test('describeSources: each source and how it arrives, as its card names the mode', () => {
  assert.deepEqual(MODE_LABELS, { api: 'Connected (API)', csv: 'Upload CSV', skip: 'Skip' });
  assert.deepEqual(describeSources(defaultDataSources()), [
    'Copilot Cowork and Work IQ credits: Upload CSV',
    'Cowork task categories: Skip',
    'Copilot Studio credits: Upload CSV only',
    'GitHub Copilot: Skip',
    'Azure AI Foundry and Azure OpenAI: Skip',
    'Org data: Skip',
    'Credit rate from Azure Cost Management: Skip',
  ]);
  const first = /** @type {Modes} */ (Object.fromEntries(DATA_SOURCES.map((s) => [s.id, s.modes[0]])));
  assert.deepEqual(describeSources(first), [
    'Copilot Cowork and Work IQ credits: Connected (Dataflow)',
    'Cowork task categories: Upload CSV',
    'Copilot Studio credits: Connected (Power Automate flow)',
    'GitHub Copilot: Connected (GitHub API)',
    'Azure AI Foundry and Azure OpenAI: Connected (API)',
    'Org data: Connected (Microsoft Entra ID)',
    'Credit rate from Azure Cost Management: Connected (API)',
  ]);
  assert.equal(modeLabel('github', 'api'), 'Connected (GitHub API)');
  assert.equal(modeLabel(dataSource('studioCredits'), 'csv'), 'Upload CSV only');
  assert.equal(modeLabel('azureAi', 'skip'), 'Skip');
});

test('routerSignaturesJson: one line with every kind; the ones the router refuses carry the reason', () => {
  const json = routerSignaturesJson();
  assert.ok(!json.includes('\n'));
  const all = JSON.parse(json);
  assert.deepEqual(all.map((s) => s.kind), UPLOAD_KINDS.map((k) => k.kind));
  const keys = ['kind', 'source', 'groups', 'dir', 'name', 'policy'];
  for (const s of all) assert.deepEqual(Object.keys(s), s.policy === 'refuse' ? [...keys, 'detail'] : keys, s.kind);
  assert.deepEqual(
    all.filter((s) => s.policy === 'refuse').map((s) => [s.kind, s.dir, s.name, s.detail]),
    [
      ['coworkTasks', COWORK_TASKS_DIR, 'CoworkWeeklyMetrics.csv', PAIR_DETAIL],
      ['coworkPeople', COWORK_TASKS_DIR, 'PeopleMetaData.csv', PAIR_DETAIL],
    ],
  );
  assert.deepEqual(all.find((s) => s.kind === 'githubMap'), {
    kind: 'githubMap',
    source: 'github',
    groups: kindOf('githubMap').groups,
    dir: GITHUB_DIR,
    name: 'GitHubUserMap_{stamp}.csv',
    policy: 'replaceKind',
  });
  /** @param {Modes} ds */
  const kinds = (ds) => JSON.parse(routerSignaturesJson(ds)).map((s) => s.kind);
  const studio = UPLOAD_KINDS.filter((k) => k.source === 'studioCredits').map((k) => k.kind);
  assert.deepEqual(kinds(defaultDataSources()), [...studio, 'vivaCredits', 'vivaPolicy']);
  assert.deepEqual(kinds(defaultsWith({ studioCredits: 'api', coworkCredits: 'api' })), [...studio, 'vivaCredits', 'vivaPolicy']);
  assert.deepEqual(kinds(only({ github: 'csv' })), ['githubUsage', 'githubMap']);
  assert.deepEqual(kinds(only({ github: 'api', orgData: 'api' })), []);
  assert.deepEqual(kinds(only({ coworkTasks: 'csv' })), ['coworkTasks', 'coworkPeople']);
});

test('pairTaskExports: one Cowork task export at a time, with at most one PeopleMetaData.csv', () => {
  const task = f('CoworkWeeklyMetrics.csv', 'coworkTasks');
  const people = f('PeopleMetaData.csv', 'coworkPeople');
  const credits = f('PersonServiceCreditsMetrics.csv', 'vivaCredits');
  assert.deepEqual(pairTaskExports([task, credits, people]), { ok: true, files: [credits, people, task] }, 'the PeopleMetaData.csv goes before its export');
  assert.deepEqual(pairTaskExports([task]), { ok: true, files: [task] }, 'a task export alone is allowed');
  assert.deepEqual(pairTaskExports([]), { ok: true, files: [] });
  assert.deepEqual(pairTaskExports([task, f('CoworkWeeklyMetrics (1).csv', 'coworkTasks'), people]), {
    ok: false,
    error: 'CoworkWeeklyMetrics.csv, CoworkWeeklyMetrics (1).csv: upload one Cowork task export at a time. Each replaces the last, so load one before adding the next.',
  });
  assert.deepEqual(pairTaskExports([task, people, f('PeopleMetaData (1).csv', 'coworkPeople')]), {
    ok: false,
    error: 'PeopleMetaData.csv, PeopleMetaData (1).csv: a Cowork task export has one PeopleMetaData.csv.',
  });
  assert.deepEqual(pairTaskExports([credits, people]), { ok: false, error: `PeopleMetaData.csv: ${PEOPLE_ALONE}` });
  assert.deepEqual(pairTaskExports([credits, people], { partial: true }), { ok: true, files: [credits, people] }, 'its export may come next');
});

test('inspectPath: a local folder with a Cowork task export and its PeopleMetaData.csv is one upload; two such folders are not', () => {
  const modes = defaultsWith({ coworkTasks: 'csv' });
  const weeks = ['wk1', 'wk2'].map((wk) => {
    csvFile(`cowork/${wk}/CoworkWeeklyMetrics.csv`, TASKS);
    csvFile(`cowork/${wk}/PeopleMetaData.csv`, PEOPLE);
    return join(tmp, 'cowork', wk);
  });
  /** @type {import('../src/staging.js').PendingUpload[]} */
  const both = [];
  for (const dir of weeks) {
    const got = inspectPath(dir, modes);
    assert.ok(got.ok);
    assert.deepEqual(got.skipped, []);
    const set = checkUploadSet(got.files);
    assert.ok(set.ok);
    assert.deepEqual(set.files.map((x) => [x.name, x.kind, x.path]), [
      ['PeopleMetaData.csv', 'coworkPeople', join(dir, 'PeopleMetaData.csv')],
      ['CoworkWeeklyMetrics.csv', 'coworkTasks', join(dir, 'CoworkWeeklyMetrics.csv')],
    ]);
    both.push(...got.files);
  }
  assert.deepEqual(checkUploadSet(both), {
    ok: false,
    error: 'CoworkWeeklyMetrics.csv, CoworkWeeklyMetrics.csv: upload one Cowork task export at a time. Each replaces the last, so load one before adding the next.',
  });
  const parent = join(tmp, 'cowork');
  assert.deepEqual(inspectPath(parent, modes), { ok: false, error: `Nothing in ${parent} is an export the chosen sources take. It has no .csv files.` }, 'subfolders are not read');
});

test('checkUploadSet: two files of a kind that replaces the last are refused', () => {
  const replacing = UPLOAD_KINDS.filter((k) => k.policy === 'replaceKind');
  assert.equal(replacing.length, 10);
  for (const k of replacing) {
    assert.deepEqual(checkUploadSet([f('a.csv', k.kind), f('b.csv', k.kind)]), {
      ok: false,
      error: `a.csv, b.csv: these are the same ${dataSource(k.source).label} export, and each replaces the last before the run reads it. Upload the newest, or load one before adding the next.`,
    }, k.kind);
  }
  const usage = f('usage.csv', 'githubUsage');
  const map = f('map.csv', 'githubMap');
  assert.deepEqual(checkUploadSet([usage, map]), { ok: true, files: [usage, map] });
  const may = f('may.csv', 'vivaCredits');
  const june = f('june.csv', 'vivaCredits');
  assert.deepEqual(checkUploadSet([may, june]), { ok: true, files: [may, june] }, 'credits exports are kept alongside each other');
  const every = UPLOAD_KINDS.map((k) => f(`${k.kind}.csv`, k.kind)).reverse();
  const set = checkUploadSet(every);
  assert.ok(set.ok);
  assert.equal(set.files.length, UPLOAD_KINDS.length);
  assert.deepEqual(set.files.slice(-2).map((x) => x.kind), ['coworkPeople', 'coworkTasks']);
  assert.deepEqual(checkUploadSet([f('PeopleMetaData.csv', 'coworkPeople')]), { ok: false, error: `PeopleMetaData.csv: ${PEOPLE_ALONE}` });
  assert.ok(checkUploadSet([f('PeopleMetaData.csv', 'coworkPeople')], { partial: true }).ok);
});

test('inspectPath: the exports at the top of a folder, and why the rest were skipped', () => {
  const dir = join(tmp, 'viva zip');
  csvFile('viva zip/PersonServiceCreditsMetrics.csv', `${HEADERS.vivaCredits}\n`);
  csvFile('viva zip/SpendingPolicyMetadata.csv', `${HEADERS.vivaPolicy}\n`);
  csvFile('viva zip/PeopleMetaData.csv', PEOPLE);
  csvFile('viva zip/feedback.csv', `${DROPPED.productFeedback}\n`);
  csvFile('viva zip/notes.txt', 'Not an export.');
  csvFile('viva zip/older/PersonServiceCreditsMetrics.csv', `${HEADERS.vivaCredits}\n`);
  const got = inspectPath(`"${dir}"`, defaultDataSources());
  assert.ok(got.ok);
  assert.deepEqual(got.files.map((x) => [x.name, x.kind]), [['PersonServiceCreditsMetrics.csv', 'vivaCredits'], ['SpendingPolicyMetadata.csv', 'vivaPolicy']]);
  assert.deepEqual(got.skipped, ["PeopleMetaData.csv: It's a Cowork task categories export, but that source isn't set to Upload CSV.", `feedback.csv: ${UNKNOWN}`]);
  const withTasks = inspectPath(dir, defaultsWith({ coworkTasks: 'csv' }));
  assert.ok(withTasks.ok);
  assert.deepEqual(withTasks.files.map((x) => x.name), ['PersonServiceCreditsMetrics.csv', 'SpendingPolicyMetadata.csv']);
  assert.deepEqual(withTasks.skipped, [`feedback.csv: ${UNKNOWN}`, `PeopleMetaData.csv: ${PEOPLE_ALONE}`], 'a Viva ZIP ships a PeopleMetaData.csv too');

  const peopleOnly = join(tmp, 'people only');
  csvFile('people only/PeopleMetaData.csv', PEOPLE);
  assert.deepEqual(inspectPath(peopleOnly, defaultsWith({ coworkTasks: 'csv' })), {
    ok: false,
    error: `Nothing in ${peopleOnly} is an export the chosen sources take. PeopleMetaData.csv: ${PEOPLE_ALONE}`,
  });
  const odd = join(tmp, 'odd');
  for (const n of ['a', 'b', 'c', 'd']) csvFile(`odd/${n}.csv`, 'Name,Colour\n');
  assert.deepEqual(inspectPath(odd, allCsv()), {
    ok: false,
    error: `Nothing in ${odd} is an export the chosen sources take. a.csv: ${UNKNOWN} b.csv: ${UNKNOWN} c.csv: ${UNKNOWN}`,
  });

  const seats = csvFile('named/seats.csv', `${HEADERS.githubMap}\n`);
  const named = inspectPath(seats, only({ github: 'csv' }));
  assert.ok(named.ok);
  assert.deepEqual([named.files.map((x) => x.kind), named.skipped], [['githubMap'], []]);
  assert.deepEqual(inspectPath(seats, defaultDataSources()), { ok: false, error: "seats.csv: It's a GitHub Copilot export, but that source isn't set to Upload CSV." });
  const nowhere = join(tmp, 'nowhere');
  assert.deepEqual(inspectPath(nowhere, defaultDataSources()), { ok: false, error: `There's no file at ${nowhere}.` });
  const people = csvFile('named/PeopleMetaData.csv', PEOPLE);
  assert.ok(inspectPath(people, defaultsWith({ coworkTasks: 'csv' })).ok, 'a named PeopleMetaData.csv is checked with the rest of the set');
});

test('parseDataFlags: comma-separated or repeated; unknown sources and modes are errors', () => {
  assert.deepEqual(parseDataFlags(['github=csv, orgData=API', 'CoworkTasks=csv']), { github: 'csv', orgData: 'api', coworkTasks: 'csv' });
  assert.deepEqual(parseDataFlags(['github=csv', 'github=skip']), { github: 'skip' }, 'the last one wins');
  assert.deepEqual(MODE_ALIASES, { studioCredits: { flow: 'api' }, coworkCredits: { dataflow: 'api' }, github: { token: 'api' } });
  assert.deepEqual(parseDataFlags(['studioCredits=FLOW,coworkCredits=dataflow,github=token']), { studioCredits: 'api', coworkCredits: 'api', github: 'api' });
  assert.throws(() => parseDataFlags(['nope=csv']), {
    message: '--data: unknown source "nope". Use one of coworkCredits, coworkTasks, studioCredits, github, azureAi, orgData, commercialTerms.',
  });
  assert.throws(() => parseDataFlags(['github=flow']), { message: '--data: github can be api or csv or skip or token, not "flow".' });
  assert.throws(() => parseDataFlags(['studioCredits=token']), { message: '--data: studioCredits can be api or csv or skip or flow, not "token".' });
  assert.throws(() => parseDataFlags(['azureAi=csv']), { message: '--data: azureAi can be api or skip, not "csv".' });
  assert.throws(() => parseDataFlags(['coworkTasks']), { message: '--data: coworkTasks can be csv or skip, not "".' });
  for (const gone of ['core', 'productFeedback', 'agent365', 'workday']) assert.throws(() => parseDataFlags([`${gone}=csv`]), new RegExp(`unknown source "${gone}"`));
});

test('normaliseDataSources: gaps and modes a source lacks take the default; sources no longer offered are dropped', () => {
  assert.deepEqual(normaliseDataSources(undefined), defaultDataSources());
  assert.deepEqual(normaliseDataSources({}), defaultDataSources());
  assert.deepEqual(
    normaliseDataSources({ github: 'csv', azureAi: 'csv', coworkTasks: 'api', orgData: 'nope', productFeedback: 'csv', core: 'api' }),
    defaultsWith({ github: 'csv' }),
  );
});

test('normaliseDataSources: a record with the Studio flow on reads as the api mode; exports alone stay csv', () => {
  assert.equal(normaliseDataSources({ studioCredits: 'csv' }, { studioFlow: true }).studioCredits, 'api');
  assert.equal(normaliseDataSources({}, { studioFlow: true }).studioCredits, 'api', 'csv is the default, so a record without the choice reads the same');
  assert.equal(normaliseDataSources({ studioCredits: 'csv' }, {}).studioCredits, 'csv');
  assert.equal(normaliseDataSources({ studioCredits: 'skip' }, { studioFlow: true }).studioCredits, 'skip');
  assert.deepEqual(dataSource('studioCredits').modes, ['api', 'csv', 'skip'], 'Connected first');
});

test('sourceCards: each card with its modes, what each needs and where to get its export', () => {
  const cards = sourceCards(defaultDataSources());
  assert.deepEqual(cards.map((c) => c.id), DATA_SOURCE_IDS);
  assert.deepEqual(Object.keys(cards[0]), ['id', 'label', 'description', 'modes', 'mode', 'locked', 'uploadable', 'uploadModes', 'page', 'group', 'export', 'exportModes']);
  assert.deepEqual(
    cards.map((c) => [c.id, c.uploadable, c.uploadModes, c.exportModes]),
    [
      ['coworkCredits', true, ['api', 'csv'], ['api', 'csv']],
      ['coworkTasks', true, ['csv'], ['csv']],
      ['studioCredits', true, ['api', 'csv'], ['csv']],
      ['github', true, ['csv'], ['csv']],
      ['azureAi', false, [], undefined],
      ['orgData', true, ['csv'], ['csv']],
      ['commercialTerms', false, [], undefined],
    ],
  );
  assert.deepEqual(cards.map((c) => c.mode), Object.values(defaultDataSources()));
  /** @param {string} id @param {string} mode */
  const hint = (id, mode) => cards.find((c) => c.id === id)?.modes.find((m) => m.value === mode)?.hint ?? '';
  for (const [id, mode, re] of /** @type {[string, string, RegExp][]} */ ([
    ['coworkCredits', 'api', /Viva Insights analyst/],
    ['coworkCredits', 'api', /Spending policies are still a CSV upload/],
    ['studioCredits', 'api', /Power Automate Premium/],
    ['github', 'api', /Azure Key Vault or, with no Key Vault, in the notebook/],
    ['github', 'api', /enterprise owner or billing manager/],
    ['azureAi', 'api', /Reader, Cost Management Reader and Monitoring Reader/],
    ['orgData', 'api', /User\.Read\.All/],
    ['orgData', 'api', /admin consents/],
    ['commercialTerms', 'api', /Cost Management Reader on the billing scope/],
    ['coworkTasks', 'csv', /with the PeopleMetaData\.csv that came with it/],
  ])) {
    assert.match(hint(id, mode), re, `${id} ${mode}`);
  }
  for (const c of cards) assert.equal(c.modes.find((m) => m.value === 'skip')?.hint, undefined, `${c.id}: Skip needs nothing`);
  /** @param {string} id */
  const where = (id) => cards.find((c) => c.id === id)?.export?.where ?? '';
  assert.match(where('coworkCredits'), /PersonServiceCreditsMetrics\.csv and SpendingPolicyMetadata\.csv/);
  assert.match(where('coworkTasks'), /CoworkWeeklyMetrics\.csv with its PeopleMetaData\.csv/);
  assert.match(where('studioCredits'), /Licensing > Products > Copilot Studio/);
  assert.match(where('github'), /AI usage > Get usage report/);
  assert.match(where('orgData'), /Download users/);
  const odd = sourceCards(defaultsWith({ azureAi: 'csv', github: 'api' }));
  assert.deepEqual([odd.find((c) => c.id === 'azureAi')?.mode, odd.find((c) => c.id === 'github')?.mode], ['skip', 'api'], 'a mode the source lacks shows its default');
});

test('parseModes: each source takes only its own modes; the rest keep theirs', () => {
  const ds = defaultDataSources();
  assert.deepEqual(parseModes({ github: 'csv', azureAi: 'api', productFeedback: 'csv' }, ds), { modes: defaultsWith({ github: 'csv', azureAi: 'api' }) });
  assert.deepEqual(parseModes({ azureAi: 'csv' }, ds), { error: 'Azure AI Foundry and Azure OpenAI can be Connected (API) or Skip.' });
  assert.deepEqual(parseModes({ coworkTasks: 'api' }, ds), { error: 'Cowork task categories can be Upload CSV or Skip.' });
  assert.deepEqual(parseModes({ studioCredits: 'flow' }, ds), { error: 'Copilot Studio credits can be Connected (Power Automate flow) or Upload CSV only or Skip.' });
  for (const raw of [null, undefined, 'github=csv']) assert.deepEqual(parseModes(raw, ds), { error: 'Choose how each source arrives.' });
  assert.deepEqual(ds, defaultDataSources(), 'the current modes are left alone');
});

test('routedSources, routerSources and routerWanted: the router is deployed when a source it takes is on CSV', () => {
  assert.deepEqual(routedSources(defaultDataSources()), ['studioCredits', 'coworkCredits']);
  assert.equal(routerWanted(defaultDataSources()), true, 'Studio and Viva exports arrive as CSVs by default');
  assert.deepEqual(routedSources(defaultsWith({ studioCredits: 'api', coworkCredits: 'api' })), ['studioCredits', 'coworkCredits'], 'their exports still win for the periods they cover');
  assert.deepEqual(routedSources(only({ github: 'api', orgData: 'api' })), [], "the notebooks that read those exports aren't deployed");
  assert.deepEqual(routedSources(allCsv()), UPLOADABLE_SOURCES);
  assert.deepEqual(routerSources(allCsv()), ['studioCredits', 'coworkCredits', 'github', 'orgData']);
  assert.deepEqual(routedSources(only({ coworkTasks: 'csv' })), ['coworkTasks']);
  assert.deepEqual(routerSources(only({ coworkTasks: 'csv' })), [], 'a Cowork task export lands without the router');
  assert.equal(routerWanted(only({ coworkTasks: 'csv' })), false);
  assert.equal(routerWanted(only()), false);
  assert.equal(routerWanted(only({ orgData: 'csv' })), true);
});

test('staging: a file on disk or from the page is recognised against the chosen sources', () => {
  const modes = allCsv();
  const text = `${HEADERS.githubMap}\nmona,mona@contoso.com,Mona,Copilot Business\n`;
  const map = csvFile('seats.csv', text);
  const good = inspectFile(map, modes);
  assert.deepEqual(good, { ok: true, file: { path: map, name: 'seats.csv', size: Buffer.byteLength(text), source: 'github', kind: 'githubMap' } });
  assert.ok(inspectFile(`  "${map}" `, modes).ok, 'quotes from a pasted path are dropped');
  const missing = join(tmp, 'missing.csv');
  assert.deepEqual(inspectFile(missing, modes), { ok: false, error: `There's no file at ${missing}.` });
  assert.deepEqual(inspectFile('  ', modes), { ok: false, error: "There's no file at (blank)." });
  assert.deepEqual(inspectFile(tmp, modes), { ok: false, error: `${tmp} is a folder. Choose a .csv file.` });
  assert.deepEqual(inspectFile(csvFile('seats.txt', HEADERS.githubMap), modes), { ok: false, error: "seats.txt isn't a .csv file." });
  assert.deepEqual(inspectFile(csvFile('empty.csv', ''), modes), { ok: false, error: 'empty.csv: The file is empty.' });
  const notCsv = "seats.csv: It's a GitHub Copilot export, but that source isn't set to Upload CSV.";
  assert.deepEqual(inspectFile(map, defaultDataSources()), { ok: false, error: notCsv });
  assert.throws(() => checkCsvFiles([map], defaultDataSources()), { message: `--csv: ${notCsv}` });
  assert.throws(() => checkCsvFiles([missing], modes, 'upload'), { message: `upload: There's no file at ${missing}.` });
  assert.deepEqual(checkCsvFiles([map], modes, 'upload'), [good.ok && good.file]);

  assert.equal(sizeOk(0), 'The file is empty.');
  assert.equal(sizeOk(1), true);
  assert.equal(sizeOk(MAX_UPLOAD_BYTES), true);
  assert.equal(sizeOk(MAX_UPLOAD_BYTES + 1), "It's 200 MB. The installer uploads files up to 200 MB; put bigger ones in the Lakehouse with OneLake File Explorer.");

  const bytes = new TextEncoder().encode(text);
  const staged = stageUpload('..\\dir\\Seats.csv', bytes);
  assert.match(staged.token, /^[0-9a-f]{24}$/);
  assert.deepEqual(staged, { token: staged.token, name: 'Seats.csv', size: bytes.length, source: 'github', label: 'GitHub Copilot' });
  const back = checkStaged(staged.token, modes);
  assert.ok(back.ok);
  assert.deepEqual([back.file.token, back.file.name, back.file.kind], [staged.token, 'Seats.csv', 'githubMap']);
  assert.equal(readFileSync(back.file.path, 'utf8'), text);
  assert.deepEqual(checkStaged(staged.token, defaultDataSources()), { ok: false, error: "Seats.csv: It's a GitHub Copilot export, but that source isn't set to Upload CSV." });
  assert.deepEqual(checkStaged('nope', modes), { ok: false, error: 'That file is no longer here. Choose it again.' });
  const odd = stageUpload('odd.csv', new TextEncoder().encode('Name,Colour\n'));
  assert.deepEqual([odd.source, odd.error], [undefined, UNKNOWN]);
  assert.equal(stageUpload('CoworkWeeklyMetrics.csv', new TextEncoder().encode(TASKS)).label, 'Cowork task categories', 'recognised whatever the chosen sources');
});

test('uploadFiles: each export goes to the drop folder; one that fails is reported and the rest still go', async () => {
  const oneLake = fakeOneLake(/broken/);
  const { ui, text } = fakeUi();
  const { ctx } = fakeCtx({ ui, oneLake });
  const files = checkCsvFiles([csvFile('up/broken.csv', HEADERS.orgFile), csvFile('up/seats.csv', HEADERS.githubMap)], allCsv());
  assert.equal(await uploadFiles(ctx, files), 1);
  assert.deepEqual([...oneLake.files.keys()], [`${UPLOAD_DIR}/${STAMP}_seats.csv`]);
  assert.equal(Buffer.from(/** @type {Uint8Array} */ (oneLake.files.get(`${UPLOAD_DIR}/${STAMP}_seats.csv`))).toString(), HEADERS.githubMap);
  assert.match(text(), /✗ Couldn't upload broken\.csv: 403 Forbidden/);
  assert.match(text(), /✓ Uploaded seats\.csv \(GitHub Copilot\)/);

  const staged = stageUpload('usage.csv', new TextEncoder().encode(HEADERS.githubUsage));
  const back = checkStaged(staged.token, allCsv());
  assert.ok(back.ok);
  assert.equal(await uploadFiles(ctx, [back.file]), 1);
  assert.ok(oneLake.files.has(`${UPLOAD_DIR}/${STAMP}_usage.csv`));
  assert.deepEqual(checkStaged(staged.token, allCsv()), { ok: false, error: 'That file is no longer here. Choose it again.' }, 'a staged file is let go once uploaded');
});

test('planDataSources sets the sources and keeps the exports; ensureUploads makes the folders and uploads them', async () => {
  const oneLake = fakeOneLake();
  const modes = defaultsWith({ github: 'csv', azureAi: 'api' });
  const staged = stageUpload('usage.csv', new TextEncoder().encode(HEADERS.githubUsage));
  const picked = checkStaged(staged.token, modes);
  assert.ok(picked.ok);
  const { ui, asked, text } = fakeUi({ answers: [{ modes, files: [picked.file] }] });
  const { ctx, config } = fakeCtx({ ui, oneLake });
  ctx.csvFiles = [csvFile('plan/seats.csv', HEADERS.githubMap)];
  await planDataSources(ctx);
  assert.match(text(), /^Data sources$/m);
  assert.match(asked[0], /^Choose how each source arrives\. The API is read on every run;/);
  assert.deepEqual(config.dataSources, modes);
  assert.deepEqual(ctx.pendingUploads?.map((x) => x.name), ['seats.csv', 'usage.csv'], 'the --csv files, then the ones picked');

  assert.equal(await ensureUploads(ctx), true);
  assert.deepEqual(oneLake.dirs, UPLOAD_FOLDERS);
  assert.equal(config.uploads.folders, true);
  assert.match(text(), /✓ Drop folder: .+ > Files\/consumption_central_uploads/);
  assert.deepEqual([...oneLake.files.keys()], [`${UPLOAD_DIR}/${STAMP}_seats.csv`, `${UPLOAD_DIR}/${STAMP}_usage.csv`]);
  assert.deepEqual(ctx.pendingUploads, []);

  const idle = fakeOneLake();
  const quiet = fakeCtx({ ui: fakeUi().ui, oneLake: idle });
  quiet.config.dataSources = only({ azureAi: 'api' });
  assert.equal(await ensureUploads(quiet.ctx), true);
  assert.deepEqual(idle.dirs, [], 'no export arrives as a CSV and none was picked, so no folders');
});

test('ensureUploads: an export that fails is a failure that says how to put it there; the rest still go', async () => {
  const oneLake = fakeOneLake(/broken/);
  const { ui, text } = fakeUi();
  const { ctx } = fakeCtx({ ui, oneLake });
  ctx.pendingUploads = checkCsvFiles([csvFile('fail/broken.csv', HEADERS.orgFile), csvFile('fail/seats.csv', HEADERS.githubMap)], allCsv());
  assert.equal(await ensureUploads(ctx), false);
  assert.deepEqual([...oneLake.files.keys()], [`${UPLOAD_DIR}/${STAMP}_seats.csv`]);
  assert.match(text(), /✗ Couldn't upload broken\.csv: 403 Forbidden/);
  assert.match(text(), /Put it in .+ > Files\/consumption_central_uploads yourself, or run ".*upload <file>" again\./);
  assert.deepEqual(ctx.pendingUploads, []);

  const none = fakeCtx({ ui: fakeUi().ui, oneLake: fakeOneLake() });
  assert.equal(await ensureUploads(none.ctx), true, 'nothing picked is nothing failed');

  const noDirs = fakeOneLake();
  noDirs.createDirectory = async () => {
    throw new Error('403 Forbidden');
  };
  const blocked = fakeUi();
  const b = fakeCtx({ ui: blocked.ui, oneLake: noDirs });
  b.ctx.pendingUploads = checkCsvFiles([csvFile('fail/seats.csv', HEADERS.githubMap)], allCsv());
  assert.equal(await ensureUploads(b.ctx), true, 'the folders are only a convenience');
  assert.match(blocked.text(), /! Couldn't make Files\/consumption_central_uploads in .+ \(403 Forbidden\)\./);
  assert.match(blocked.text(), /The pipeline makes it on its first run, or make it yourself: in the Lakehouse, choose the \.\.\. next to Files, then New subfolder\./);
  assert.equal(b.config.uploads.folders, undefined);
  assert.equal(noDirs.files.size, 1);
});

test('planDataSources: with every source skipped there is no router; an export for a skipped source is an error', async () => {
  const { ui } = fakeUi({ answers: [{ modes: only(), files: [] }] });
  const { ctx, config } = fakeCtx({ ui });
  await planDataSources(ctx);
  assert.deepEqual(config.dataSources, only());
  assert.equal(routerWanted(config.dataSources), false);
  assert.deepEqual(ctx.pendingUploads, []);

  const { ctx: ctx2 } = fakeCtx({ ui: fakeUi().ui });
  ctx2.csvFiles = [csvFile('plan/org.csv', HEADERS.orgFile)];
  await assert.rejects(planDataSources(ctx2), /^Error: --csv: org\.csv: It's an Org data export, but that source isn't set to Upload CSV\.$/);
});

test('uploadCommand: needs an install that loads exports, and exports its sources take', async () => {
  const runNow = async () => ({ ok: true });
  const bare = fakeCtx();
  bare.config.fabric.workspaceId = undefined;
  await assert.rejects(uploadCommand(bare.ctx, { files: [] }, runNow), { message: 'Nothing is installed yet. Run the installer first.' });
  const { ctx, config } = fakeCtx();
  const refused = /^Error: This install doesn't load exports\. Run the installer again \(".*install"\) and set a source to Upload CSV on the Data sources screen\.$/;
  await assert.rejects(uploadCommand(ctx, { files: [] }, runNow), refused, 'not without the router');
  config.fabric.notebooks.uploadRouter = 'nb-router';
  config.dataSources = only({ github: 'api', orgData: 'api' });
  await assert.rejects(uploadCommand(ctx, { files: [] }, runNow), refused, 'not when no source takes an export');
  config.dataSources = defaultsWith({ github: 'csv' });
  await assert.rejects(
    uploadCommand(ctx, { files: [csvFile('cmd/org.csv', HEADERS.orgFile)] }, runNow),
    /^Error: upload: org\.csv: It's an Org data export, but that source isn't set to Upload CSV\.$/,
  );
});

test('uploadCommand: uploads to the drop folder, then runs the pipeline when asked', async () => {
  const seats = csvFile('cmd/seats.csv', HEADERS.githubMap);
  const usage = csvFile('cmd/usage.csv', HEADERS.githubUsage);
  const now = uploadInstall();
  assert.equal(await uploadCommand(now.ctx, { files: [seats, usage], run: true }, now.runNow), true);
  assert.deepEqual([...now.oneLake.files.keys()], [`${UPLOAD_DIR}/${STAMP}_seats.csv`, `${UPLOAD_DIR}/${STAMP}_usage.csv`]);
  assert.deepEqual(now.oneLake.dirs, UPLOAD_FOLDERS);
  assert.deepEqual(now.runs, [{ wait: true }]);
  assert.deepEqual(now.asked, [], 'no question with --run');
  assert.match(now.text(), /^Upload exports$/m);
  assert.match(now.text(), /To .+ > Files\/consumption_central_uploads\. Sources that take an export: Copilot Studio credits, Copilot Cowork and Work IQ credits, GitHub Copilot\./);

  const noWait = uploadInstall();
  noWait.fail();
  assert.equal(await uploadCommand(noWait.ctx, { files: [seats], run: true, wait: false }, noWait.runNow), true, 'with --no-wait, starting the run is enough');
  assert.deepEqual(noWait.runs, [{ wait: false }]);
  const failed = uploadInstall();
  failed.fail();
  assert.equal(await uploadCommand(failed.ctx, { files: [seats], run: true }, failed.runNow), false);

  const asks = uploadInstall({ answers: [true] });
  assert.equal(await uploadCommand(asks.ctx, { files: [seats] }, asks.runNow), true);
  assert.deepEqual(asks.asked, ['Run the pipeline now to load them? Otherwise the next scheduled run does.']);
  assert.deepEqual(asks.runs, [{ wait: true }]);
  const later = uploadInstall({ answers: [false] });
  assert.equal(await uploadCommand(later.ctx, { files: [seats] }, later.runNow), true);
  assert.deepEqual(later.runs, []);
  assert.match(later.text(), /✓ They load on the next scheduled run\./);

  const broken = uploadInstall({ failWrites: /seats/ });
  assert.equal(await uploadCommand(broken.ctx, { files: [seats], run: true }, broken.runNow), false, 'nothing went, so nothing to run');
  assert.deepEqual(broken.runs, []);
});

test('uploadCommand: with no files, the picker offers the sources that take an export, as they are set', async () => {
  const a = uploadInstall();
  /** @type {unknown[]} */
  const offered = [];
  a.ctx.ui.sources = async (message, cards, o) => {
    offered.push([message, cards.map((c) => c.id), o]);
    return { modes: a.config.dataSources, files: [] };
  };
  assert.equal(await uploadCommand(a.ctx, { files: [] }, a.runNow), true);
  assert.deepEqual(offered, [['Choose the exports to upload.', ['coworkCredits', 'studioCredits', 'github'], { lockModes: true }]]);
  assert.match(a.text(), /! No exports to upload\./);
  assert.deepEqual(a.oneLake.dirs, [], 'nothing to upload, so no folders');
  assert.deepEqual(a.runs, []);

  const b = uploadInstall();
  const seats = checkCsvFiles([csvFile('pick/seats.csv', HEADERS.githubMap)], b.config.dataSources);
  b.ctx.ui.sources = async () => ({ modes: b.config.dataSources, files: seats });
  assert.equal(await uploadCommand(b.ctx, { files: [], run: false }, b.runNow), true);
  assert.deepEqual([...b.oneLake.files.keys()], [`${UPLOAD_DIR}/${STAMP}_seats.csv`]);
  assert.deepEqual([b.asked, b.runs], [[], []]);
});

test('cli: upload takes files; --run, --data and --csv go where they belong', () => {
  const up = parseCli(['upload', 'a.csv', 'b.csv', '--run', '--no-wait'], {});
  assert.deepEqual([up.command, up.files, up.run, up.wait], ['upload', ['a.csv', 'b.csv'], true, false]);
  const install = parseCli(['--data', 'github=csv,orgData=csv', '--data', 'studioCredits=flow', '--csv', 'seats.csv', '--csv', 'org.csv'], {});
  assert.deepEqual(
    [install.command, install.dataSources, install.csvFiles, install.files, install.run],
    ['install', { github: 'csv', orgData: 'csv', studioCredits: 'api' }, ['seats.csv', 'org.csv'], [], undefined],
  );
  assert.throws(() => parseCli(['run', '--run'], {}), { message: '--run goes with upload.' });
  assert.throws(() => parseCli(['upload', '--csv', 'x.csv'], {}), { message: '--data, --csv go with install. To add exports later, use upload.' });
  assert.throws(() => parseCli(['upload', '--studio-flow'], {}), { message: '--data, --csv and --studio-flow go with install. To add exports later, use upload.' });
  assert.throws(() => parseCli(['--ui', '--data', 'github=csv'], {}), { message: 'With --ui, choose data sources and exports on the Data sources page.' });
  assert.throws(() => parseCli(['status', 'extra'], {}), { message: 'Unexpected argument: extra' });
  assert.throws(() => parseCli(['--data', 'workday=csv'], {}), /^Error: --data: unknown source "workday"\./);
});

test('cli: --studio-flow is the Studio flow mode unless Studio is skipped', () => {
  const alone = emptyConfig();
  applyDataFlags(alone, { dataSources: { github: 'csv' }, studioFlow: true });
  assert.deepEqual(alone.dataSources, defaultsWith({ github: 'csv', studioCredits: 'api' }));
  const csv = emptyConfig();
  applyDataFlags(csv, { dataSources: { studioCredits: 'csv' }, studioFlow: true });
  assert.equal(csv.dataSources.studioCredits, 'api', 'with csv too');
  const skipped = emptyConfig();
  applyDataFlags(skipped, { dataSources: { studioCredits: 'skip' }, studioFlow: true });
  assert.equal(skipped.dataSources.studioCredits, 'skip');
  const kept = emptyConfig();
  kept.dataSources = only({ orgData: 'api' });
  applyDataFlags(kept, { dataSources: {} });
  assert.deepEqual(kept.dataSources, only({ orgData: 'api' }), 'no flags leave the record as it is');
});

test('web ui: the Data sources answer checks its modes, its staged files and the set they make', async () => {
  const ui = createWebUi();
  const cards = sourceCards(defaultDataSources());
  const asked = ui.sources('Choose', cards);
  const prompt = /** @type {any} */ (ui.history().filter((e) => e.type === 'prompt').at(-1));
  assert.deepEqual([prompt.kind, prompt.cards, prompt.lockModes], ['sources', cards, undefined]);
  assert.deepEqual(ui.answer(prompt.id, { modes: { azureAi: 'csv' } }), { ok: false, error: 'Azure AI Foundry and Azure OpenAI can be Connected (API) or Skip.' });
  assert.deepEqual(ui.answer(prompt.id, { modes: {}, uploads: 'x' }), { ok: false, error: "The uploads list isn't right. Choose the files again." });
  assert.deepEqual(ui.answer(prompt.id, { modes: {}, uploads: ['gone'] }), { ok: false, error: 'That file is no longer here. Choose it again.' });
  const encode = (/** @type {string} */ s) => new TextEncoder().encode(s);
  const seats = stageUpload('seats.csv', encode(HEADERS.githubMap));
  const seats2 = stageUpload('seats (1).csv', encode(HEADERS.githubMap));
  const people = stageUpload('PeopleMetaData.csv', encode(PEOPLE));
  const task = stageUpload('CoworkWeeklyMetrics.csv', encode(TASKS));
  assert.deepEqual(ui.answer(prompt.id, { modes: {}, uploads: [seats.token] }), {
    ok: false,
    error: "seats.csv: It's a GitHub Copilot export, but that source isn't set to Upload CSV.",
  });
  assert.deepEqual(ui.answer(prompt.id, { modes: { github: 'csv' }, uploads: [seats.token, seats2.token] }), {
    ok: false,
    error: 'seats.csv, seats (1).csv: these are the same GitHub Copilot export, and each replaces the last before the run reads it. Upload the newest, or load one before adding the next.',
  });
  assert.deepEqual(ui.answer(prompt.id, { modes: { coworkTasks: 'csv' }, uploads: [people.token] }), { ok: false, error: `PeopleMetaData.csv: ${PEOPLE_ALONE}` });
  assert.deepEqual(ui.answer(prompt.id, { modes: { github: 'csv', coworkTasks: 'csv' }, uploads: [task.token, seats.token, people.token, task.token] }), { ok: true });
  const r = await asked;
  assert.deepEqual(r.modes, defaultsWith({ github: 'csv', coworkTasks: 'csv' }));
  assert.deepEqual(r.files.map((x) => x.token), [seats.token, people.token, task.token], 'a file sent twice goes once, and the PeopleMetaData.csv before its export');
  assert.equal(/** @type {any} */ (ui.history().at(-1)).display, '2 changed, 3 files to upload');

  const shown = sourceCards(defaultsWith({ github: 'csv' })).filter((card) => card.id === 'github');
  const locked = ui.sources('Upload', shown, { lockModes: true });
  const p2 = /** @type {any} */ (ui.history().filter((e) => e.type === 'prompt').at(-1));
  assert.equal(p2.lockModes, true);
  assert.deepEqual(ui.answer(p2.id, { uploads: [] }), { ok: false, error: 'Choose at least one export to upload.' });
  assert.deepEqual(ui.answer(p2.id, { modes: { github: 'skip' }, uploads: [seats.token] }), { ok: true }, 'modes are ignored when locked');
  const l = await locked;
  assert.deepEqual([l.modes, l.files.map((x) => x.token)], [{ github: 'csv' }, [seats.token]]);
  assert.equal(/** @type {any} */ (ui.history().at(-1)).display, '1 file to upload');
});

test('web session: Upload exports is offered once an install loads exports', () => {
  assert.ok(WEB_COMMANDS.includes('upload'));
  const config = emptyConfig();
  config.fabric.workspaceId = 'ws-1';
  config.fabric.lakehouseId = 'lh-1';
  config.dataSources = only();
  assert.equal(describeRecord(config).can.upload, false);
  config.dataSources.github = 'csv';
  assert.equal(describeRecord(config).can.upload, false, 'not until the router is deployed');
  config.fabric.notebooks.uploadRouter = 'nb-router';
  assert.equal(describeRecord(config).can.upload, true);
  assert.deepEqual(describeRecord(config).data, describeSources(config.dataSources));
  config.dataSources.github = 'api';
  assert.equal(describeRecord(config).can.upload, false);
});

test('catalog and pipeline: the router is deployed and runs first only when a source it takes is on CSV', () => {
  const { catalog } = sources;
  /** @param {Modes} ds */
  const routed = (ds) => notebooksFor(catalog, ds).some((nb) => nb.key === 'uploadRouter');
  assert.equal(routed(defaultDataSources()), true);
  assert.equal(routed(only({ github: 'csv' })), true);
  assert.equal(routed(only({ azureAi: 'api' })), false);
  assert.equal(routed(only({ coworkTasks: 'csv' })), false, 'a Cowork task export lands without it');

  /** @param {Modes} ds */
  const build = (ds) =>
    buildPipeline(catalog, {
      workspaceId: 'ws-1',
      notebookIds: Object.fromEntries(notebooksFor(catalog, ds).map((nb) => [nb.key, `nb-${nb.key}`])),
      dataSources: ds,
    });
  const routes = 'It starts by routing any CSV exports dropped in Files/consumption_central_uploads to the loads that read them.';
  const withRouter = build(defaultDataSources());
  const first = withRouter.properties.activities[0];
  assert.deepEqual([UPLOAD_ROUTER_ACTIVITY, first.name, first.typeProperties.notebookId], ['Run_Upload_Router', 'Run_Upload_Router', 'nb-uploadRouter']);
  assert.ok(withRouter.properties.description.includes(routes));
  const without = build(only({ azureAi: 'api' }));
  assert.ok(!JSON.stringify(without).includes(UPLOAD_ROUTER_ACTIVITY));
  assert.ok(!without.properties.description.includes(routes));
});

test('uploadFiles: a Cowork task export and its PeopleMetaData.csv go straight to where the Viva load reads them', async () => {
  const oneLake = fakeOneLake();
  const { ctx } = fakeCtx({ ui: fakeUi().ui, oneLake });
  const modes = defaultsWith({ coworkTasks: 'csv' });
  const files = checkCsvFiles([csvFile('pair/credits.csv', HEADERS.vivaCredits), csvFile('pair/CoworkWeeklyMetrics.csv', TASKS), csvFile('pair/PeopleMetaData.csv', PEOPLE)], modes);
  const set = checkUploadSet(files);
  assert.ok(set.ok);
  assert.equal(await uploadFiles(ctx, set.files), 3);
  assert.deepEqual([...oneLake.files.keys()], [`${UPLOAD_DIR}/${STAMP}_credits.csv`, `${COWORK_TASKS_DIR}/PeopleMetaData.csv`, `${COWORK_TASKS_DIR}/CoworkWeeklyMetrics.csv`]);
});

test('uploadFiles: a Cowork task export is held back when its PeopleMetaData.csv fails, and the pair gets one hint', async () => {
  const oneLake = fakeOneLake(/PeopleMetaData/);
  const t = fakeUi();
  const { ctx } = fakeCtx({ ui: t.ui, oneLake });
  const files = checkCsvFiles([csvFile('held/CoworkWeeklyMetrics.csv', TASKS), csvFile('held/PeopleMetaData.csv', PEOPLE)], defaultsWith({ coworkTasks: 'csv' }));
  assert.deepEqual(files.map((x) => x.kind), ['coworkPeople', 'coworkTasks']);
  assert.equal(await uploadFiles(ctx, files), 0);
  assert.deepEqual([...oneLake.files.keys()], [], "the export isn't read with the last pair's people");
  const out = t.text();
  assert.match(out, /✗ Couldn't upload PeopleMetaData\.csv: 403 Forbidden\n/);
  assert.match(out, /✗ Couldn't upload CoworkWeeklyMetrics\.csv: its PeopleMetaData\.csv didn't upload, and the export is read with it\n/);
  const hint = /Run ".*upload <CoworkWeeklyMetrics\.csv> <PeopleMetaData\.csv>" with both files again, or put both in .+ > Files\/landing\/viva\/cowork_tasks, replacing the ones there\./g;
  assert.equal(out.match(hint)?.length, 1);
});

test('dataSourcesSummary: says how to add exports, and a Cowork task export, only when the install takes them', () => {
  /** @param {Modes} ds */
  const summary = (ds) => {
    const t = fakeUi();
    const { ctx, config } = fakeCtx({ ui: t.ui });
    config.dataSources = ds;
    dataSourcesSummary(ctx);
    return t.text();
  };
  const tasksBlock =
    /^ {4}Adding a Cowork task export\n {4}It goes with the PeopleMetaData\.csv that came with it: ".*upload <CoworkWeeklyMetrics\.csv> <PeopleMetaData\.csv>" lands both,\n {4}or put both in .+ > Files\/landing\/viva\/cowork_tasks as CoworkWeeklyMetrics\.csv and PeopleMetaData\.csv, replacing the ones there\.$/m;
  const routed = summary(defaultDataSources());
  assert.match(routed, /^ {4}Adding exports\n {4}Drop each export in .+ > Files\/consumption_central_uploads, as downloaded: no renaming, no subfolders\.$/m);
  assert.doesNotMatch(routed, /Cowork task export/);
  const both = summary(defaultsWith({ coworkTasks: 'csv' }));
  assert.match(both, /^ {4}Adding exports$/m);
  assert.match(both, tasksBlock);
  const tasksOnly = summary(only({ coworkTasks: 'csv' }));
  assert.doesNotMatch(tasksOnly, /Adding exports|consumption_central_uploads|New shortcut/);
  assert.match(tasksOnly, tasksBlock);
  assert.doesNotMatch(summary(only({ azureAi: 'api' })), /Adding/);
});

test('upload and --csv: a set the pickers refuse is refused, and a PeopleMetaData.csv goes before its export', async () => {
  const a = uploadInstall();
  a.config.dataSources = defaultsWith({ coworkTasks: 'csv' });
  const policies = ['a', 'b'].map((n) => csvFile(`set/policy-${n}.csv`, HEADERS.vivaPolicy));
  await assert.rejects(uploadCommand(a.ctx, { files: policies, run: false }, a.runNow), /policy-a\.csv, policy-b\.csv: these are the same Copilot Cowork and Work IQ credits export/);
  const people = csvFile('set/PeopleMetaData.csv', PEOPLE);
  await assert.rejects(uploadCommand(a.ctx, { files: [people], run: false }, a.runNow), (/** @type {Error} */ err) => err.message.endsWith(`PeopleMetaData.csv: ${PEOPLE_ALONE}`));
  assert.deepEqual([...a.oneLake.files.keys()], []);
  assert.equal(await uploadCommand(a.ctx, { files: [csvFile('set/CoworkWeeklyMetrics.csv', TASKS), people], run: false }, a.runNow), true);
  assert.deepEqual([...a.oneLake.files.keys()], [`${COWORK_TASKS_DIR}/PeopleMetaData.csv`, `${COWORK_TASKS_DIR}/CoworkWeeklyMetrics.csv`]);
  assert.match(
    a.text(),
    /To .+ > Files\/consumption_central_uploads, and a Cowork task export with its PeopleMetaData\.csv to Files\/landing\/viva\/cowork_tasks\. Sources that take an export: .*Cowork task categories/,
  );

  const { ctx } = fakeCtx({ ui: fakeUi({ answers: [{ modes: only({ github: 'csv' }), files: [] }] }).ui });
  ctx.csvFiles = ['a', 'b'].map((n) => csvFile(`set/map-${n}.csv`, HEADERS.githubMap));
  await assert.rejects(planDataSources(ctx), /map-a\.csv, map-b\.csv: these are the same GitHub Copilot export/);
});

test('upload: an install whose only export is the Cowork task export takes it', async () => {
  const config = emptyConfig();
  config.fabric.workspaceId = 'ws-1';
  config.fabric.lakehouseId = 'lh-1';
  config.dataSources = only({ coworkTasks: 'csv' });
  assert.equal(describeRecord(config).can.upload, true);
  const a = uploadInstall();
  a.config.dataSources = only({ coworkTasks: 'csv' });
  delete a.config.fabric.notebooks.uploadRouter;
  const files = [csvFile('alone/CoworkWeeklyMetrics.csv', TASKS), csvFile('alone/PeopleMetaData.csv', PEOPLE)];
  assert.equal(await uploadCommand(a.ctx, { files, run: false }, a.runNow), true);
  assert.deepEqual([...a.oneLake.files.keys()], [`${COWORK_TASKS_DIR}/PeopleMetaData.csv`, `${COWORK_TASKS_DIR}/CoworkWeeklyMetrics.csv`]);
  assert.deepEqual(a.oneLake.dirs, [], 'no drop folder without the router');
  assert.match(a.text(), /To .+ > Files\/landing\/viva\/cowork_tasks\. Sources that take an export: Cowork task categories\./);
});

test('uploadCommand: the picker offers only the sources whose exports this install takes', async () => {
  const a = uploadInstall();
  a.config.dataSources = defaultsWith({ github: 'api', orgData: 'api' });
  /** @type {string[][]} */
  const offered = [];
  a.ctx.ui.sources = async (_message, cards) => {
    offered.push(cards.map((c) => c.id));
    return { modes: a.config.dataSources, files: [] };
  };
  await uploadCommand(a.ctx, { files: [] }, a.runNow);
  assert.deepEqual(offered, [['coworkCredits', 'studioCredits']]);
});

/**
 * @param {number} port
 * @param {{ path: string, headers?: Record<string, string>, body?: Uint8Array | string }} o
 * @returns {Promise<{ status: number, body: any }>}
 */
function post(port, o) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: o.path, headers: { Host: `127.0.0.1:${port}`, ...o.headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: body ? JSON.parse(body) : null }));
    });
    req.on('error', reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

// Last: closing the server lets go of every staged file.
test('server: /api/upload stages a CSV for a signed-in page from the same origin', async () => {
  const ui = createWebUi();
  const server = await startServer({ ui, session: /** @type {any} */ ({ running: null, state: () => ({ installed: false }), start: () => ({ ok: true }) }), token: 'tok' });
  try {
    const port = server.port;
    const auth = { Cookie: `consumption_central_${port}=tok`, Origin: `http://127.0.0.1:${port}` };
    const text = `${HEADERS.githubMap}\nmona,mona@contoso.com,Mona,Copilot Business\n`;
    const body = new TextEncoder().encode(text);
    const file = { 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent('My seats.csv') };
    /** @param {Record<string, string>} headers @param {Uint8Array | string} [b] */
    const send = (headers, b = body) => post(port, { path: '/api/upload', headers, body: b });

    assert.equal((await send({ ...file, Origin: auth.Origin })).status, 401);
    assert.deepEqual(await send({ ...file, Cookie: auth.Cookie, Origin: 'http://evil.example' }), { status: 403, body: { error: 'Cross-site request refused.' } });
    assert.deepEqual(await send({ ...auth, 'Content-Type': 'text/csv', 'x-file-name': 'a.csv' }), { status: 415, body: { error: 'Send the file as application/octet-stream.' } });
    assert.deepEqual(await send({ ...auth, ...file, 'x-file-name': '%E0%A4%A' }), { status: 400, body: { error: 'The file name is not valid.' } });
    assert.deepEqual(await send({ ...auth, ...file, 'x-file-name': 'a.xlsx' }), { status: 422, body: { error: 'Choose a .csv file.' } });
    assert.deepEqual(await send({ ...auth, ...file }, ''), { status: 422, body: { error: 'The file is empty.' } });

    const ok = await send({ ...auth, ...file });
    assert.equal(ok.status, 200);
    assert.match(ok.body.token, /^[0-9a-f]{24}$/);
    assert.deepEqual(ok.body, { token: ok.body.token, name: 'My seats.csv', size: body.length, source: 'github', label: 'GitHub Copilot' });
    const back = checkStaged(ok.body.token, only({ github: 'csv' }));
    assert.ok(back.ok);
    assert.equal(readFileSync(back.file.path, 'utf8'), text);
  } finally {
    await server.close();
  }
});
