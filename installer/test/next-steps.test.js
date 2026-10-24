// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { myGroupsUrl, VIEWER_GROUP_NAME } from '../src/steps/access.js';
import { FLOW_NAMES, flowsWanted } from '../src/steps/flows.js';
import { NEW_TOKEN_URL, TOKEN_WARN_DAYS, TOKENS_URL } from '../src/steps/github.js';
import { nextSteps, stepsLeftTitle } from '../src/steps/next-steps.js';
import { summary } from '../src/install.js';
import { COWORK_DATAFLOW_ACTIVITY, GITHUB_ACTIVITY } from '../src/transform/pipeline.js';
import { fakeCtx, fakeFabric, fakeUi } from './fakes.js';

const USER = { tenantId: 'tenant-1', upn: 'admin@contoso.com' };
const NOW = new Date('2026-06-01T12:00:00Z');
const DAY_MS = 86_400_000;

/** A Fabric install with a viewer group. */
function installed(answers = /** @type {any[]} */ ([])) {
  const fake = fakeUi({ answers });
  const t = fakeCtx({ ui: fake.ui, fabric: fakeFabric().api });
  t.config.access = { groupId: 'g-1', groupName: VIEWER_GROUP_NAME, contact: 'admin@contoso.com', createdGroup: true };
  t.config.fabric.workspaceName = 'Consumption Central';
  return { ...t, ...fake };
}

const ids = (/** @type {{ id: string }[]} */ steps) => steps.map((s) => s.id);

/**
 * The model deployed, with its report published on it.
 * @param {import('../src/config.js').InstallConfig} config
 */
function withReport(config, reportId = 'rep-1') {
  config.semanticModel = { ...config.semanticModel, enabled: true, id: 'sm-1', bound: true, reports: true, report: { id: reportId, name: 'Consumption Central' } };
}

test('next steps: none left for an install with nothing to do', () => {
  const t = installed();
  t.config.dataSources.coworkCredits = 'skip';
  assert.deepEqual(nextSteps(t.config, USER, { now: NOW }), []);
  assert.equal(stepsLeftTitle([]), '0 optional steps');
});

test('next steps: in order, share the report, the GitHub token, the flow, then the Cowork Dataflow; each says who and why', () => {
  const t = installed();
  const config = t.config;
  withReport(config);
  config.dataSources.github = 'api';
  config.github = { enterprise: 'contoso', tokenSetAt: '2026-01-01T00:00:00Z', tokenExpires: '2026-06-15T00:00:00Z' };
  config.dataSources.studioCredits = 'api';
  config.uploads = { ...config.uploads, flowIds: { studio: 'flow-1' }, flowEnvironment: { id: 'env-1', name: 'Contoso (default)', url: 'https://org.crm.dynamics.com' } };
  config.dataSources.coworkCredits = 'api';
  config.consumption.dataflowId = 'df-1';
  assert.deepEqual(flowsWanted(config), ['studio']);

  const steps = nextSteps(config, USER, { now: NOW });
  assert.deepEqual(ids(steps), ['share-report', 'github-token', 'flows', 'cowork-dataflow']);
  for (const s of steps) {
    assert.ok(s.title && s.why && s.who, `${s.id} has a title, why and who`);
    assert.ok(!s.optional, `${s.id} isn't optional`);
  }
  assert.equal(stepsLeftTitle(steps), '4 steps left');

  const [, , flows, cowork] = steps;
  assert.equal(flows.title, 'Sign in to the Power Automate flow');
  assert.equal(flows.link, 'https://make.powerautomate.com/environments/env-1/flows');
  assert.deepEqual(flows.steps, [`Open ${FLOW_NAMES.studio} in Contoso (default), sign in to its connections, save it and turn it on.`]);
  assert.match(String(flows.message), /^Hi,/);
  assert.match(String(flows.message), /connections of the Consumption Central flow in Power Automate/);
  assert.match(String(flows.message), /It is in Contoso \(default\): https:\/\/make\.powerautomate\.com\/environments\/env-1\/flows/);
  assert.match(String(flows.message), /\nThanks\nadmin@contoso\.com$/);
  assert.equal(cowork.activity, COWORK_DATAFLOW_ACTIVITY, 'its failed refresh is expected until it is signed in');
  assert.equal(cowork.link, 'https://app.fabric.microsoft.com/groups/ws-1');
});

test('next steps: the report is shared with the viewer group once, and a report published again asks again', () => {
  const t = installed();
  const config = t.config;
  config.dataSources.coworkCredits = 'skip';
  withReport(config);
  const steps = nextSteps(config, USER, { now: NOW });
  assert.deepEqual(ids(steps), ['share-report']);
  const [share] = steps;
  assert.equal(share.title, `Share the report with ${VIEWER_GROUP_NAME}`);
  assert.equal(share.who, 'You');
  assert.match(share.why, /people in the group get "no access"/);
  assert.ok(share.why.includes(`(${myGroupsUrl('g-1')})`), 'it says where to add people to the group');
  assert.equal(share.link, 'https://app.powerbi.com/groups/ws-1/reports/rep-1');
  assert.equal(share.linkText, 'Open the report');
  assert.equal(share.steps?.length, 3);
  assert.match(String(share.steps?.[0]), /^Open the Consumption Central report \(https:\/\/app\.powerbi\.com\/groups\/ws-1\/reports\/rep-1\)/);
  assert.equal(share.steps?.[2], `Enter "${VIEWER_GROUP_NAME}" and choose Grant.`);
  assert.equal(share.activity, undefined, 'no pipeline step fails for it');
  assert.equal(stepsLeftTitle(steps), '1 step left');

  const access = /** @type {import('../src/config.js').AccessConfig} */ (config.access);
  access.reportShared = 'rep-1';
  assert.deepEqual(nextSteps(config, USER, { now: NOW }), [], 'not once the report is shared');

  withReport(config, 'rep-2');
  assert.deepEqual(ids(nextSteps(config, USER, { now: NOW })), ['share-report'], 'a report published again has a new ID, so it is asked again');
});

test('next steps: no share card without a published report, with reports or the model off, or without a viewer group', () => {
  const t = installed();
  const config = t.config;
  config.dataSources.coworkCredits = 'skip';
  const left = () => nextSteps(config, USER, { now: NOW });
  withReport(config);
  delete config.semanticModel.report;
  assert.deepEqual(left(), [], 'no report yet');
  withReport(config);
  config.semanticModel.reports = false;
  assert.deepEqual(left(), [], 'reports off');
  withReport(config);
  config.semanticModel.enabled = false;
  assert.deepEqual(left(), [], 'the model left out');
  withReport(config);
  delete config.access;
  assert.deepEqual(left(), [], 'no viewer group');
});

test('next steps: the GitHub token card shows within 30 days of its expiry, and says so once it has expired', () => {
  const t = installed();
  const config = t.config;
  config.dataSources.coworkCredits = 'skip';
  config.dataSources.github = 'api';
  /** @type {import('../src/config.js').GithubConfig} */
  const gh = { enterprise: 'contoso', tokenSetAt: '2026-01-01T00:00:00Z' };
  config.github = gh;
  const at = (/** @type {number} */ days) => new Date(NOW.getTime() + days * DAY_MS).toISOString();
  const left = () => nextSteps(config, USER, { now: NOW });
  assert.deepEqual(left(), [], "a token that doesn't expire");

  gh.tokenExpires = at(TOKEN_WARN_DAYS + 1);
  assert.deepEqual(left(), [], `more than ${TOKEN_WARN_DAYS} days off`);

  gh.tokenExpires = at(TOKEN_WARN_DAYS);
  const [soon] = left();
  assert.equal(soon.id, 'github-token');
  assert.equal(soon.title, 'Replace the GitHub token');
  assert.match(soon.why, /^It expires 2026-07-01,/);
  assert.equal(soon.link, NEW_TOKEN_URL);
  assert.equal(soon.linkText, 'Create a classic token');
  assert.match(String(soon.steps?.[0]), /^Create a classic token with scope /);
  assert.match(String(soon.steps?.[1]), /github-token" and paste it\.$/);
  assert.equal(soon.steps?.[2], `Revoke the old one at ${TOKENS_URL}.`);
  assert.equal(soon.activity, undefined, 'nothing fails yet');

  gh.tokenExpires = at(-1);
  const [expired] = left();
  assert.equal(expired.title, 'Replace the expired GitHub token');
  assert.match(expired.why, /GitHub data stops loading until it's replaced/);
  assert.equal(expired.activity, GITHUB_ACTIVITY, 'its failed run is expected until the token is replaced');

  config.dataSources.github = 'csv';
  assert.deepEqual(left(), [], 'none when GitHub billing comes from uploads');
});

test('next steps: the flow card follows Copilot Studio credits: only from the API, once the flow is made or written out', () => {
  const t = installed();
  const config = t.config;
  config.dataSources.coworkCredits = 'skip';
  config.uploads = { ...config.uploads, flowIds: { studio: 'flow-1' } };
  const left = () => nextSteps(config, USER, { now: NOW });
  for (const mode of /** @type {const} */ (['csv', 'skip'])) {
    config.dataSources.studioCredits = mode;
    assert.deepEqual(left(), [], `none when Copilot Studio credits are ${mode}`);
  }

  config.dataSources.studioCredits = 'api';
  const [made] = left();
  assert.equal(made.id, 'flows');
  assert.equal(made.who, 'You, or a Power Platform administrator');
  assert.equal(made.link, 'https://make.powerautomate.com/', 'no environment recorded, so the Power Automate home');
  assert.match(String(made.message), /Sign in as a Power Platform, Billing or Global administrator/);
  assert.match(String(made.message), /Sign in as someone with Contributor or higher on Consumption Central/);

  config.uploads = { flowFiles: { studio: 'C:\\setup\\studio-flow.json' } };
  const [file] = left();
  assert.deepEqual(file.steps, [`Import ${FLOW_NAMES.studio} from C:\\setup\\studio-flow.json into the Power Automate environment, sign in to its connections, save it and turn it on.`]);
  assert.ok(String(file.message).includes(`${FLOW_NAMES.studio} (to import: C:\\setup\\studio-flow.json):`));

  config.uploads = {};
  assert.deepEqual(left(), [], 'none before the flow is made');
});

test('next steps: Cowork credits: the Dataflow sign-in when connected, an optional Viva query for uploads, nothing when left out', () => {
  const t = installed();
  const config = t.config;
  const left = () => nextSteps(config, USER, { now: NOW });

  config.dataSources.coworkCredits = 'csv';
  const steps = left();
  assert.deepEqual(ids(steps), ['viva-query']);
  const [viva] = steps;
  assert.equal(viva.optional, true);
  assert.equal(viva.who, 'A Viva Insights analyst');
  assert.match(String(viva.message), /^Hi,/);
  assert.match(String(viva.message), /send me the partition ID and the query ID/);
  assert.equal(stepsLeftTitle(steps), '1 optional step');
  assert.equal(stepsLeftTitle([{ id: 'a', title: 'A', why: '', who: '' }, ...steps]), '1 step left, and 1 optional');

  config.consumption.vivaPartition = '11111111-2222-3333-4444-555555555555';
  config.consumption.vivaQuery = 'not-an-id';
  assert.deepEqual(ids(left()), ['viva-query'], 'only real IDs count');
  config.consumption.vivaQuery = '66666666-7777-8888-9999-000000000000';
  assert.deepEqual(left(), [], 'not once the IDs are known');

  config.dataSources.coworkCredits = 'api';
  assert.deepEqual(left(), [], 'none before the Dataflow is made');
  config.consumption.dataflowId = 'df-1';
  const [cowork] = left();
  assert.equal(cowork.id, 'cowork-dataflow');
  assert.equal(cowork.who, 'You');
  assert.equal(cowork.activity, COWORK_DATAFLOW_ACTIVITY, 'its failed refresh is expected until it is signed in');

  config.dataSources.coworkCredits = 'skip';
  assert.deepEqual(left(), []);
});

test('summary: what is left comes first, as cards, before the next steps', async () => {
  const t = installed();
  t.config.dataSources.coworkCredits = 'skip';
  withReport(t.config);
  t.config.dataSources.studioCredits = 'api';
  t.config.uploads = { ...t.config.uploads, flowIds: { studio: 'flow-1' } };
  await summary(t.ctx);
  const text = t.text();
  const left = text.indexOf('2 steps left');
  assert.ok(left >= 0, text);
  const share = text.indexOf(`Share the report with ${VIEWER_GROUP_NAME}`);
  assert.ok(left < share);
  assert.ok(share < text.indexOf('Sign in to the Power Automate flow'));
  assert.ok(left < text.indexOf('Next steps'), 'the cards lead');
  assert.match(text, /Copy and send:/);
  assert.match(text, /Until the report is shared with the group \(the step above\)/);
});

test("summary: after a failed step it says the setup is partly done, not set up", async () => {
  const t = installed();
  await summary(t.ctx);
  assert.match(t.text(), /Consumption Central is set up/);
  const p = installed();
  await summary(p.ctx, { ok: false });
  assert.match(p.text(), /Consumption Central is partly set up/);
  assert.doesNotMatch(p.text(), /Consumption Central is set up/);
  assert.match(p.text(), /run the installer again/);
});

test('install: an unproven first load makes the install not ok', async () => {
  const src = await readFile(new URL('../src/install.js', import.meta.url), 'utf8');
  assert.match(src, /ok = reloads\.ok && ok && stepsOk;\r?\n\s*await summary\(ctx, \{ ok, pending: reloads\.pending \}\)/);
  assert.match(src, /if \(opts\.wait && config\.firstRun\?\.status !== 'Completed'\) ok = false;/);
});
