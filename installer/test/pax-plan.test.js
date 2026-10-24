// @ts-check
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { emptyConfig } from '../src/config.js';
import { THE_APP } from '../src/managed-app/flow.js';
import { PRODUCT } from '../src/product.js';
import { nextSteps, VIVA_QUERY_GUIDE } from '../src/steps/next-steps.js';
import { PWSH_INSTALL, PYTHON_INSTALL, TASK_AT } from '../src/steps/pax/local.js';
import { confirmPaxPlan, paxAppWanted, paxCollected, paxCollectedLabels, paxPlan, paxPlanReview, paxPreflight } from '../src/steps/pax/plan.js';
import { describeFolder } from '../src/steps/pax/site.js';
import { paxHostProblem } from '../src/target.js';
import { fakeAzureGraph, fakeCtx, fakeFabric, fakePowerBi, fakeUi, realSources } from './fakes.js';
import { fakePaxHost } from './pax-fakes.js';

const FOLDER = 'https://contoso.sharepoint.com/sites/Analytics/Shared Documents/Consumption Central';
const ORG_FILE_LABEL = 'users and their departments, as the org file';
const SITE_URL = 'https://contoso.sharepoint.com/sites/Analytics';
const GLOBAL_ADMIN = { roleTemplateId: '62e90394-69f5-4237-9190-012177145e10', displayName: 'Global Administrator' };
const ADVANCED_Q = 'Change the advanced settings?';
const FOLDER_Q = 'SharePoint folder address';
const WORKSPACE_Q = 'Power BI workspace for the report';
const DEPLOY_Q = `Deploy ${THE_APP}?`;
const PARTITION_Q = 'Viva Insights partition ID (usually your tenant ID). Leave blank if you don\'t have the query yet.';
const QUERY_Q = 'Viva Insights query ID. Leave blank if you don\'t have it yet.';
const APP_REG_Q = 'The scheduled refresh signs in to Microsoft Graph and SharePoint as an app.';
const PWSH_OK = { version: '7.4.6', policy: 'RemoteSigned', languageMode: 'FullLanguage', timeZone: 'GMT Standard Time' };
const TENANT = '11111111-2222-3333-4444-555555555555';
const PARTITION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const QUERY = '66666666-7777-8888-9999-000000000000';
const NO_QUERY_NOTE = 'Until the report has the query, its Cowork pages are blank. The Done page says how to get it.';

/** @type {string[]} */
const temps = [];
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const plain = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** A build of the app, for ctx.sources.appDist. */
function appBuild() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-flow-'));
  temps.push(dir);
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Consumption Central</title>');
  return dir;
}

/**
 * A ctx for planning a new PAX install on a fake tenant and PC. fakeCtx fills in a Fabric
 * install's ids, which a new PAX install doesn't have. `defaults` records each input's default.
 * The prices form takes its defaults, and `prices` over them.
 * @param {{ answers?: any[], yesTo?: string[], yes?: boolean, host?: any, app?: boolean, report?: boolean, admin?: boolean, tenantId?: string, prices?: Record<string, string>, workspaces?: { id: string, name: string }[] }} [o]
 */
function planCtx(o = {}) {
  const graph = fakeAzureGraph();
  if (o.admin !== false) graph.directoryRoles.push(GLOBAL_ADMIN);
  const g = /** @type {any} */ (graph.api);
  g.usersCanRegisterApps = async () => true;
  g.subscribedSkus = async () => [];
  const pbi = fakePowerBi();
  pbi.workspaces.push(...(o.workspaces ?? []));
  const ui = fakeUi({ yes: o.yes, answers: o.answers, yesTo: o.yesTo });
  const u = /** @type {any} */ (ui.ui);
  /** @type {Record<string, string | undefined>} */
  const defaults = {};
  const input = u.input;
  u.input = async (/** @type {string} */ message, /** @type {{ default?: string }} */ opts = {}) => {
    defaults[message] = opts.default;
    return input(message, opts);
  };
  // fakeUi doesn't answer forms, and Advanced settings asks for the prices in one.
  u.form = async (/** @type {string} */ message, /** @type {{ id: string, default: string }[]} */ fields) => {
    ui.asked.push(message);
    return { ...Object.fromEntries(fields.map((f) => [f.id, f.default])), ...o.prices };
  };
  let sources = o.app ? { ...realSources(), appDist: appBuild() } : realSources();
  if (o.report === false) sources = { ...sources, paxModelFile: undefined };
  const { ctx, config } = fakeCtx({ ui: ui.ui, graph: g, powerBi: pbi.api, fabric: fakeFabric().api, sources });
  const c = /** @type {any} */ (config);
  for (const key of ['workspaceId', 'lakehouseId', 'lakehouseName']) delete c.fabric[key];
  for (const key of ['appId', 'objectId', 'servicePrincipalId']) delete c.app[key];
  delete c.keyVault.uri;
  c.target = 'pax';
  c.tenantId = o.tenantId ?? 'tenant-1';
  const pax = fakePaxHost({ now: () => ctx.now(), ...o.host });
  if (pax.base) temps.push(pax.base);
  /** @type {any} */ (ctx).paxHost = pax.host;
  return { ctx, config: c, ui, graph, pbi, pax, defaults };
}

/**
 * Plans a new install as a user taking the defaults would: no advanced settings, the folder, a
 * new workspace, then the defaults for the rest.
 * @param {Parameters<typeof planCtx>[0]} [o]
 */
async function planned(o = {}) {
  const s = planCtx({ ...o, answers: o.answers ?? [false, FOLDER, ''] });
  const pre = await paxPreflight(s.ctx);
  await paxPlan(s.ctx, pre);
  return { ...s, pre };
}

test('pax plan: what it collects', { timeout: 10_000 }, () => {
  // Consumption Central's PAX route reads only the org file (userInfo mode): no Copilot interactions,
  // and no Agent 365 file even when a record asks for one.
  assert.equal(PRODUCT.pax.mode, 'userInfo');
  const config = emptyConfig();
  assert.deepEqual(paxCollectedLabels(config), [ORG_FILE_LABEL]);
  assert.equal(paxCollected(config), ORG_FILE_LABEL);
  /** @type {any} */ (config).pax = { agent365: true };
  assert.deepEqual(paxCollectedLabels(config), [ORG_FILE_LABEL]);
  assert.equal(paxCollected(config), ORG_FILE_LABEL);
});

test('pax plan: the app is wanted by default when the build ships', { timeout: 10_000 }, () => {
  const ctx = /** @type {any} */ ({ config: emptyConfig(), sources: { appDist: 'C:\\builds\\app' } });
  assert.equal(paxAppWanted(ctx), true);
  ctx.config.pax = { deployApp: true };
  assert.equal(paxAppWanted(ctx), true);
  ctx.config.pax = { deployApp: false };
  assert.equal(paxAppWanted(ctx), false, 'turned off in the plan');
  ctx.config.pax = {};
  ctx.sources = {};
  assert.equal(paxAppWanted(ctx), false, 'no build of the app');
});

test('pax plan: preflight checks the tenant, then this PC', { timeout: 10_000 }, async () => {
  const { ctx, config, ui, pax } = planCtx();
  const pre = await paxPreflight(ctx);
  const text = plain(ui.text());
  const tenant = text.indexOf('Checking your tenant');
  assert.ok(tenant >= 0, text);
  assert.ok(text.indexOf('Checking this PC') > tenant, text);
  assert.match(text, /✓ Signed in as admin@contoso\.com \(tenant tenant-1\)/);
  assert.match(text, /✓ PowerShell 7\.4\.6 \(execution policy RemoteSigned\)/);
  // The org file needs no Python, so the PC check doesn't look for it.
  assert.doesNotMatch(text, /Python/);
  assert.ok(!pax.keys().includes('python'), pax.keys().join(', '));
  assert.doesNotMatch(text, /✗/);
  assert.equal(pre.canConsent, true);
  assert.ok(config.powerBi?.timeZone, 'the time zone the model refreshes in');
});

test('pax plan: preflight warns when the user can\'t grant admin consent', { timeout: 10_000 }, async () => {
  const { ctx, ui } = planCtx({ admin: false });
  const pre = await paxPreflight(ctx);
  assert.equal(pre.canConsent, false);
  assert.match(plain(ui.text()), /! .*consent/i);
});

test('pax plan: preflight goes on when this PC has no Python, which the org file doesn\'t need', { timeout: 10_000 }, async () => {
  const { ctx, ui, pax } = planCtx({ host: { python: null } });
  const pre = await paxPreflight(ctx);
  assert.equal(pre.canConsent, true);
  const text = plain(ui.text());
  assert.ok(text.indexOf('Checking your tenant') < text.indexOf('Checking this PC'), text);
  assert.doesNotMatch(text, /✗|Python/);
  assert.ok(!text.includes(PYTHON_INSTALL), text);
  assert.ok(!pax.keys().includes('python'), pax.keys().join(', '));
});

test('pax plan: preflight goes on when Python is too old, which the org file doesn\'t need', { timeout: 10_000 }, async () => {
  const { ctx, ui } = planCtx({ host: { python: { python: '3.9.13' } } });
  await paxPreflight(ctx);
  assert.doesNotMatch(plain(ui.text()), /✗|Python|too old/);
});

test('pax plan: preflight stops when this PC has no PowerShell 7', { timeout: 10_000 }, async () => {
  const { ctx, ui } = planCtx({ host: { pwsh: null } });
  await assert.rejects(paxPreflight(ctx), /This PC can't run the scheduled refresh yet/);
  const text = plain(ui.text());
  assert.match(text, /✗ PowerShell 7 isn't installed/);
  assert.ok(text.includes(PWSH_INSTALL), text);
});

test('pax plan: an AllSigned policy stops it, with a fix that never bypasses the policy', { timeout: 10_000 }, async () => {
  const { ctx, ui } = planCtx({ host: { pwsh: { ...PWSH_OK, policy: 'AllSigned' } } });
  await assert.rejects(paxPreflight(ctx), /Missing: /);
  const text = plain(ui.text());
  assert.match(text, /✗ PowerShell's execution policy is AllSigned, so the refresh scripts can't run/);
  assert.ok(text.includes('Set-ExecutionPolicy -Scope CurrentUser RemoteSigned'), text);
  assert.doesNotMatch(text, /ExecutionPolicy\s+Bypass|-Scope\s+\w+\s+(Bypass|Unrestricted)/i);
});

test('pax plan: ConstrainedLanguage mode stops it', { timeout: 10_000 }, async () => {
  const { ctx, ui } = planCtx({ host: { pwsh: { ...PWSH_OK, languageMode: 'ConstrainedLanguage' } } });
  await assert.rejects(paxPreflight(ctx), /Missing: /);
  assert.match(plain(ui.text()), /✗ PowerShell runs in ConstrainedLanguage mode on this PC/);
});

test('pax plan: every problem on the PC is listed before it stops', { timeout: 10_000 }, async () => {
  // The PC check is PowerShell only here, so two PowerShell problems make the list; a missing Python isn't one.
  const { ctx, ui } = planCtx({ host: { pwsh: { ...PWSH_OK, policy: 'AllSigned', languageMode: 'ConstrainedLanguage' }, python: null } });
  await assert.rejects(paxPreflight(ctx), /Missing: PowerShell's execution policy is AllSigned, so the refresh scripts can't run; PowerShell runs in ConstrainedLanguage mode on this PC\. Fix them, /);
  const text = plain(ui.text());
  assert.match(text, /✗ PowerShell's execution policy is AllSigned/);
  assert.match(text, /✗ PowerShell runs in ConstrainedLanguage mode on this PC/);
  assert.doesNotMatch(text, /Python/);
});

test(
  'pax plan: preflight refuses a PC that isn\'t Windows',
  { timeout: 10_000 },
  async () => {
    const { ctx, pax } = planCtx({ host: { platform: 'linux' } });
    const problem = paxHostProblem(pax.host);
    assert.ok(problem);
    await assert.rejects(paxPreflight(ctx), { message: problem });
  },
);

test(
  'pax plan: preflight refuses Cloud Shell',
  { timeout: 10_000 },
  async () => {
    const { ctx, pax } = planCtx({ host: { cloudShell: true } });
    const problem = paxHostProblem(pax.host);
    assert.ok(problem);
    await assert.rejects(paxPreflight(ctx), { message: problem });
  },
);

test('pax plan: a new setup asks for the folder and workspace, and turns the app on by default', { timeout: 10_000 }, async () => {
  const { ctx, config, ui } = await planned({ app: true });
  assert.deepEqual(ui.asked, [ADVANCED_Q, FOLDER_Q, WORKSPACE_Q, DEPLOY_Q, PARTITION_Q, APP_REG_Q]);
  const text = plain(ui.text());
  assert.equal(config.sharePoint.siteUrl, SITE_URL);
  assert.ok(text.includes(`Files: ${describeFolder(config.sharePoint)}`), text);
  assert.equal(config.semanticModel.enabled, true);
  assert.equal(config.semanticModel.name, PRODUCT.pax.model);
  assert.equal(config.fabric.workspaceId, undefined, 'a new workspace');
  assert.ok(String(config.fabric.workspaceName).startsWith(PRODUCT.pax.workspace));
  assert.equal(paxAppWanted(ctx), true);
  assert.notEqual(config.pax.deployApp, false);
  assert.equal(config.access.groupName, PRODUCT.viewerGroup);
  assert.equal(config.access.contact, 'admin@contoso.com');
  assert.equal(config.app.existing, false);
  assert.equal(config.pax.task.name, PRODUCT.pax.task);
  assert.equal(config.pax.task.at, TASK_AT);
  // Each run replaces the org file whole, so there's no history for the first load to pull.
  assert.equal(config.pax.seedDays, undefined);
  assert.equal(config.history, undefined);
  assert.equal(ctx.reloadHistoryDays, undefined);
  assert.equal(/** @type {any} */ (ctx).runFirstLoad, true);
  assert.ok(text.includes(`daily at ${TASK_AT}`), text);
  assert.doesNotMatch(text, /App Edition/i);
});

test('pax plan: without a build of the app it says so and doesn\'t ask', { timeout: 10_000 }, async () => {
  const { ctx, ui } = await planned();
  assert.ok(!ui.asked.includes(DEPLOY_Q));
  assert.ok(plain(ui.text()).includes(`no build of the app, so it won't deploy ${THE_APP}`), ui.text());
  assert.equal(paxAppWanted(ctx), false);
});

test('pax plan: saying no to the app turns it off', { timeout: 10_000 }, async () => {
  const { ctx, config } = await planned({ app: true, answers: [false, FOLDER, '', false] });
  assert.equal(config.pax.deployApp, false);
  assert.equal(paxAppWanted(ctx), false);
});

test('pax plan: an existing workspace can be chosen', { timeout: 10_000 }, async () => {
  const { config } = await planned({ workspaces: [{ id: 'ws-team', name: 'Team reports' }], answers: [false, FOLDER, 'ws-team'] });
  assert.equal(config.fabric.workspaceId, 'ws-team');
  assert.equal(config.fabric.workspaceName, 'Team reports');
  assert.ok(!config.fabric.createdWorkspace);
});

test('pax plan: asks for the Viva Insights query, with the tenant as the partition by default', { timeout: 10_000 }, async () => {
  const { config, ui, defaults } = await planned({ tenantId: TENANT, answers: [false, FOLDER, '', TENANT, ` ${QUERY} `] });
  assert.deepEqual(ui.asked, [ADVANCED_Q, FOLDER_Q, WORKSPACE_Q, PARTITION_Q, QUERY_Q, APP_REG_Q]);
  assert.equal(defaults[PARTITION_Q], TENANT);
  assert.equal(defaults[QUERY_Q], '');
  assert.equal(config.consumption.vivaPartition, TENANT);
  assert.equal(config.consumption.vivaQuery, QUERY, 'trimmed');
  const text = plain(ui.text());
  assert.ok(text.includes('Viva Insights > Create analysis > Create custom query > Consumption query'), text);
  assert.ok(text.includes(`Guide: ${VIVA_QUERY_GUIDE}`), text);
  assert.ok(text.includes(`The report reads Cowork credits from Viva Insights query ${QUERY}`), text);
  assert.ok(!text.includes(NO_QUERY_NOTE), text);
  assert.ok(!nextSteps(config).some((s) => s.id === 'viva-query'), 'no step to ask an analyst for it');
});

test('pax plan: saved or --viva-partition and --viva-query IDs are the defaults, so a rerun keeps them', { timeout: 10_000 }, async () => {
  const s = planCtx({ tenantId: TENANT, answers: [false, FOLDER, ''] });
  s.config.consumption.vivaPartition = PARTITION;
  s.config.consumption.vivaQuery = QUERY;
  await paxPlan(s.ctx, await paxPreflight(s.ctx));
  assert.equal(s.defaults[PARTITION_Q], PARTITION, 'the saved partition, not the tenant');
  assert.equal(s.defaults[QUERY_Q], QUERY);
  assert.equal(s.config.consumption.vivaPartition, PARTITION);
  assert.equal(s.config.consumption.vivaQuery, QUERY);
});

test('pax plan: a blank Viva Insights answer forgets the query, so the Done page still asks an analyst for it', { timeout: 10_000 }, async () => {
  // A blank partition: the query isn't asked, and the IDs saved before are forgotten.
  const blank = planCtx({ tenantId: TENANT, answers: [false, FOLDER, '', ''] });
  blank.config.consumption.vivaPartition = PARTITION;
  blank.config.consumption.vivaQuery = QUERY;
  await paxPlan(blank.ctx, await paxPreflight(blank.ctx));
  assert.ok(blank.ui.asked.includes(PARTITION_Q));
  assert.ok(!blank.ui.asked.includes(QUERY_Q));
  // A partition with no query, as --viva-partition alone gives: it's both or neither.
  const half = await planned({ tenantId: TENANT, answers: [false, FOLDER, '', TENANT, ''] });
  assert.ok(half.ui.asked.includes(QUERY_Q));
  // A tenant ID that isn't a GUID, and nothing saved: the default is blank.
  const none = await planned();
  assert.equal(none.defaults[PARTITION_Q], '');
  for (const [name, { config, ui }] of Object.entries({ blank, half, none })) {
    assert.equal(config.consumption.vivaPartition, undefined, name);
    assert.equal(config.consumption.vivaQuery, undefined, name);
    assert.ok(plain(ui.text()).includes(NO_QUERY_NOTE), `${name}: ${ui.text()}`);
    const viva = nextSteps(config).find((s) => s.id === 'viva-query');
    assert.equal(viva?.who, 'A Viva Insights analyst', name);
    assert.match(String(viva?.why), /run the installer again and enter them when it asks, or pass --viva-partition and --viva-query/, name);
  }
});

test('pax plan: the Viva Insights IDs must look like GUIDs', { timeout: 10_000 }, async () => {
  const hint = 'It looks like 00000000-0000-0000-0000-000000000000.';
  for (const [answers, question] of /** @type {const} */ ([
    [[false, FOLDER, '', 'contoso'], PARTITION_Q],
    [[false, FOLDER, '', TENANT, 'not-a-query'], QUERY_Q],
  ])) {
    const { ctx } = planCtx({ tenantId: TENANT, answers: [...answers] });
    const pre = await paxPreflight(ctx);
    await assert.rejects(paxPlan(ctx, pre), { message: `${question}: ${hint}` });
  }
});

test('pax plan: without the report there is no Viva Insights question', { timeout: 10_000 }, async () => {
  const { config, ui } = await planned({ report: false, tenantId: TENANT });
  assert.equal(config.semanticModel.enabled, false);
  assert.ok(!ui.asked.includes(PARTITION_Q), ui.asked.join('\n'));
  assert.doesNotMatch(plain(ui.text()), /Viva Insights/);
});

test('pax plan: the prices are asked only behind Advanced settings, and only changed ones are kept', { timeout: 10_000 }, async () => {
  const basic = await planned();
  assert.ok(!basic.ui.asked.includes('Prices'));
  assert.equal(basic.config.prices, undefined);

  const advanced = planCtx({ yesTo: [ADVANCED_Q], answers: [FOLDER], prices: { creditRate: '0.012' } });
  const pre = await paxPreflight(advanced.ctx);
  await paxPlan(advanced.ctx, pre);
  const { asked } = advanced.ui;
  assert.ok(asked.includes('Prices'), asked.join('\n'));
  assert.ok(asked.indexOf(PARTITION_Q) < asked.indexOf('Prices'), 'after the Viva Insights query');
  assert.ok(asked.indexOf('Prices') < asked.indexOf(APP_REG_Q), 'before the app registration');
  assert.match(plain(advanced.ui.text()), /Choose Yes to change who can view, the new workspace's name, your prices and when the refresh runs/);
  assert.deepEqual(advanced.config.prices, { creditRate: 0.012 });
  const from = advanced.ui.out.length;
  assert.equal(await confirmPaxPlan(advanced.ctx, pre), true);
  const text = plain(advanced.ui.out.slice(from).join(''));
  assert.ok(text.includes('Prices:      CoworkRatePerCredit/StudioRatePerCredit/GitHubRatePerCredit 0.012'), text);
});

test('pax plan: the folder address is checked', { timeout: 10_000 }, async () => {
  for (const answer of ['not a link', 'https://www.contoso.com/files']) {
    const { ctx } = planCtx({ answers: [false, answer] });
    const pre = await paxPreflight(ctx);
    await assert.rejects(paxPlan(ctx, pre), (err) => err instanceof Error && err.message.startsWith(`${FOLDER_Q}: `), answer);
  }
});

test('pax plan: an unattended new setup needs the folder', { timeout: 10_000 }, async () => {
  const { ctx } = planCtx({ yes: true });
  const pre = await paxPreflight(ctx);
  await assert.rejects(paxPlan(ctx, pre), /A new setup needs the SharePoint folder/);
});

test('pax plan: the review lists what it creates, grants and costs', { timeout: 10_000 }, async () => {
  const { ctx, pre } = await planned({ app: true });
  const review = paxPlanReview(ctx, pre);
  const kinds = review.creates.map((i) => i.kind);
  for (const kind of ['App registration', 'Client secret', 'Scheduled task', 'SharePoint folder', 'Workspace', 'Semantic model', 'Report', 'Entra group', 'Managed app']) {
    assert.ok(kinds.includes(kind), `${kind} in ${kinds.join(', ')}`);
  }
  assert.ok(review.creates.some((i) => i.kind === 'App registration' && i.name === PRODUCT.pax.app && i.isNew));
  assert.ok(review.creates.some((i) => i.kind === 'Scheduled task' && i.name === PRODUCT.pax.task));
  assert.ok(review.creates.some((i) => i.kind === 'Entra group' && i.name === PRODUCT.viewerGroup));
  assert.ok(review.grants.some((g) => g.what === 'Write (Sites.Selected)'), JSON.stringify(review.grants));
  assert.ok(review.grants.some((g) => g.who.startsWith(PRODUCT.viewerGroup) && g.what === 'Build (ReadExplore)'), JSON.stringify(review.grants));
  assert.ok(review.grants.some((g) => g.what === 'Can open the app' && g.where === THE_APP), JSON.stringify(review.grants));
  // A product decision: the viewer group gets Build on the model and no workspace role.
  assert.ok(!review.grants.some((g) => g.who.startsWith(PRODUCT.viewerGroup) && /\b(Viewer|Member|Contributor|Admin)\b/.test(g.what)), JSON.stringify(review.grants));
  const costs = (review.costs ?? []).map((c) => c.what).join('\n');
  assert.match(costs, /Power BI Pro/);
  assert.match(costs, /Power Apps Premium or Copilot Credits/);
  assert.doesNotMatch(JSON.stringify(review), /App Edition/i);
});

test('pax plan: the review leaves the app out when it isn\'t deployed', { timeout: 10_000 }, async () => {
  const { ctx, pre } = await planned();
  const review = paxPlanReview(ctx, pre);
  assert.ok(!review.creates.some((i) => i.kind === 'Managed app'));
  assert.ok(!review.grants.some((g) => g.what === 'Can open the app'));
  assert.ok(review.creates.some((i) => i.kind === 'Report'));
});

test('pax plan: confirming shows the plan and asks to go ahead', { timeout: 10_000 }, async () => {
  const { ctx, pre, ui } = await planned({ app: true });
  const from = ui.out.length;
  assert.equal(await confirmPaxPlan(ctx, pre), true);
  const text = plain(ui.out.slice(from).join(''));
  assert.match(text, /Ready to set up/);
  assert.ok(text.includes(`Data:        ${ORG_FILE_LABEL}`), text);
  assert.ok(text.includes(`Refresh:     daily at ${TASK_AT} on this PC (${PRODUCT.pax.task})`), text);
  assert.ok(text.includes(`App:         ${PRODUCT.managedApp.name} (new)`), text);
  assert.ok(text.includes('First load:  the org file, straight after setup'), text);
  assert.ok(text.includes('Cowork:      no Viva Insights query yet: the Done page says how to get one'), text);
  assert.ok(text.includes('Prices:      the template\'s defaults'), text);
  assert.doesNotMatch(text, /History:|days of (audit )?history/);
  assert.match(text, /Costs: +Power BI Pro/);
  assert.equal(ui.asked.at(-1), 'Go ahead?');
  assert.doesNotMatch(text, /App Edition/i);
});

test('pax plan: confirming names the Viva Insights query when there is one', { timeout: 10_000 }, async () => {
  const { ctx, pre, ui } = await planned({ tenantId: TENANT, answers: [false, FOLDER, '', TENANT, QUERY] });
  const from = ui.out.length;
  assert.equal(await confirmPaxPlan(ctx, pre), true);
  const text = plain(ui.out.slice(from).join(''));
  assert.ok(text.includes(`Cowork:      Viva Insights query ${QUERY}`), text);
});

test('pax plan: saying no to the plan stops, and an app left out says so', { timeout: 10_000 }, async () => {
  const { ctx, pre } = await planned();
  const ui = fakeUi({ answers: [false] });
  ctx.ui = ui.ui;
  assert.equal(await confirmPaxPlan(ctx, pre), false);
  assert.ok(plain(ui.text()).includes('App:         not deployed'), ui.text());
});
