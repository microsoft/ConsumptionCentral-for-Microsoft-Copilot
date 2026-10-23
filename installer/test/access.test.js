// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accessCommand, accessReview, ensureViewerGroup, grantModelAccess, myGroupsUrl, NEW_GROUP_ATTEMPTS, NEW_GROUP_RETRY_MS, planAccess, shareReport, shareReportPending, shareReportSteps, VIEWER_GROUP_NAME,
} from '../src/steps/access.js';
import { fabricViewerModels } from '../src/install.js';
import { HttpError } from '../src/http.js';
import { fakeCtx, fakeUi } from './fakes.js';

/** A directory with a few groups and users, recording what was changed. */
function directory() {
  /** @type {Map<string, { id: string, displayName: string, members: string[], owners: string[] }>} */
  const groups = new Map();
  const users = new Map([['ana@contoso.com', { id: 'u-ana', displayName: 'Ana' }], ['ben@contoso.com', { id: 'u-ben', displayName: 'Ben' }]]);
  /** @type {string[]} */
  const calls = [];
  /** @type {Error | undefined} */
  let createError;
  const graph = {
    verifiedDomains: async () => ['contoso.com', 'contoso.onmicrosoft.com'],
    getGroup: async (/** @type {string} */ id) => groups.get(id) ?? null,
    findGroupByName: async (/** @type {string} */ name) => [...groups.values()].find((g) => g.displayName === name) ?? null,
    /** @param {{ displayName: string, ownerId: string }} o */
    createSecurityGroup: async (o) => {
      calls.push(`create ${o.displayName} owner=${o.ownerId}`);
      if (createError) throw createError;
      const g = { id: `g-${groups.size + 1}`, displayName: o.displayName, members: [], owners: [o.ownerId] };
      groups.set(g.id, g);
      return g;
    },
    groupMembers: async (/** @type {string} */ id) => (groups.get(id)?.members ?? []).map((m) => ({ id: m })),
    groupOwners: async (/** @type {string} */ id) => (groups.get(id)?.owners ?? []).map((m) => ({ id: m, userPrincipalName: m })),
    addGroupMember: async (/** @type {string} */ id, /** @type {string} */ member) => {
      const g = /** @type {any} */ (groups.get(id));
      if (g.members.includes(member)) return false;
      g.members.push(member);
      calls.push(`member ${member}`);
      return true;
    },
    addGroupOwner: async (/** @type {string} */ id, /** @type {string} */ owner) => {
      /** @type {any} */ (groups.get(id)).owners.push(owner);
      calls.push(`owner ${owner}`);
      return true;
    },
    resolvePrincipal: async (/** @type {string} */ name) => {
      const u = users.get(name.toLowerCase());
      if (u) return { ...u, kind: 'user' };
      const g = groups.get(name) ?? [...groups.values()].find((x) => x.displayName === name);
      return g ? { id: g.id, displayName: g.displayName, kind: 'group' } : null;
    },
  };
  return { graph, groups, calls, failCreate: (/** @type {Error} */ e) => (createError = e) };
}

function datasets() {
  /** @type {Record<string, any[]>} */
  const users = {};
  /** @type {string[]} */
  const calls = [];
  /** @type {Set<string>} */
  const denied = new Set();
  /** How many more times each model rejects a group Power BI hasn't seen yet. @type {Record<string, number>} */
  const unseen = {};
  const powerBi = {
    datasetUsers: async (/** @type {string} */ _ws, /** @type {string} */ ds) => users[ds] ?? [],
    addDatasetUser: async (/** @type {string} */ ws, /** @type {string} */ ds, /** @type {any} */ body) => {
      if (denied.has(ds)) throw new HttpError('Forbidden', { status: 403, method: 'POST', url: 'https://x' });
      if (unseen[ds] > 0) {
        unseen[ds]--;
        throw new HttpError('InvalidRequest: Parameter identifier is missing or invalid', { status: 400, method: 'POST', url: 'https://x' });
      }
      calls.push(`${ws}/${ds} ${body.identifier} ${body.principalType} ${body.datasetUserAccessRight}`);
      (users[ds] ??= []).push(body);
    },
  };
  return { powerBi, users, calls, denied, unseen };
}

const MODELS = [{ workspaceId: 'ws-1', datasetId: 'ds-vl', name: 'ValueLens' }, { workspaceId: 'ws-1', datasetId: 'ds-cc', name: 'Credits' }];

test('access: the plan asks for a new group by default, with you as the contact', async () => {
  const dir = directory();
  const { ctx: ctx } = fakeCtx({ graph: dir.graph });
  await planAccess(ctx);
  assert.deepEqual(ctx.config.access, { groupName: VIEWER_GROUP_NAME, contact: 'admin@contoso.com', requestUrl: undefined });
  const review = accessReview(ctx.config, 'Workspace X');
  assert.equal(review.creates[0].name, VIEWER_GROUP_NAME);
  assert.equal(review.creates[0].isNew, true);
  assert.equal(review.grants[0].what, 'Build (ReadExplore)');
});

test('access: without Advanced settings, a new viewer group with you as contact, no questions', async () => {
  const { ui, asked } = fakeUi();
  const { ctx } = fakeCtx({ graph: directory().graph, ui });
  ctx.advanced = false;
  await planAccess(ctx);
  assert.deepEqual(ctx.config.access, { groupName: VIEWER_GROUP_NAME, contact: 'admin@contoso.com' });
  assert.deepEqual(asked, []);

  // A re-run keeps the group, contact and link it had.
  const saved = { groupId: 'g-9', groupName: 'Copilot Leads', createdGroup: false, contact: 'leads@contoso.com', requestUrl: 'https://myaccess.microsoft.com/x' };
  const again = fakeCtx({ graph: directory().graph, ui });
  again.ctx.advanced = false;
  again.config.access = { ...saved };
  await planAccess(again.ctx);
  assert.deepEqual(again.config.access, saved);
  assert.deepEqual(asked, []);
});

test('access: a contact from outside the tenant, e.g. a record from another tenant, goes back to you', async () => {
  const quiet = fakeUi();
  const moved = fakeCtx({ graph: directory().graph, ui: quiet.ui });
  moved.ctx.advanced = false;
  moved.config.access = { groupName: VIEWER_GROUP_NAME, contact: 'someone@fabrikam.com' };
  await planAccess(moved.ctx);
  assert.equal(moved.config.access?.contact, 'admin@contoso.com');
  assert.match(quiet.text(), /someone@fabrikam\.com, isn't on one of this tenant's domains, so it's now admin@contoso\.com/);

  const sub = fakeCtx({ graph: directory().graph, ui: fakeUi().ui });
  sub.ctx.advanced = false;
  sub.config.access = { groupName: VIEWER_GROUP_NAME, contact: 'help@it.contoso.com' };
  await planAccess(sub.ctx);
  assert.equal(sub.config.access?.contact, 'help@it.contoso.com', 'a subdomain of a verified domain is kept');

  const blind = fakeCtx({ graph: { ...directory().graph, verifiedDomains: async () => { throw new Error('Forbidden'); } }, ui: fakeUi().ui });
  blind.ctx.advanced = false;
  blind.config.access = { groupName: VIEWER_GROUP_NAME, contact: 'someone@fabrikam.com' };
  await planAccess(blind.ctx);
  assert.equal(blind.config.access?.contact, 'someone@fabrikam.com', 'kept when the domains can\'t be read');

  const t = fakeUi({ answers: ['new'] });
  const asked = fakeCtx({ graph: directory().graph, ui: t.ui });
  asked.config.access = { contact: 'someone@fabrikam.com' };
  await planAccess(asked.ctx);
  assert.equal(asked.config.access?.contact, 'admin@contoso.com', 'the question starts from you');
  assert.match(t.text(), /People without access are asked to email admin@contoso\.com\. Add a link, e.g\. a request form, to offer that too\./);
  assert.ok(t.asked.includes('Link where people can request access (optional)'));
});

test('access: an existing group is found by name, asking again until it exists', async () => {
  const dir = directory();
  dir.groups.set('g-9', { id: 'g-9', displayName: 'Copilot Leads', members: [], owners: [] });
  const { ui, text } = fakeUi({ answers: ['existing', 'Nope', 'Copilot Leads', 'leads@contoso.com', 'https://myaccess.microsoft.com/@contoso.com#/access-packages/1'] });
  const { ctx: ctx } = fakeCtx({ graph: dir.graph, ui });
  await planAccess(ctx);
  assert.match(text(), /No group called "Nope"/);
  assert.equal(ctx.config.access?.groupId, 'g-9');
  assert.equal(ctx.config.access?.createdGroup, false);
  assert.equal(ctx.config.access?.contact, 'leads@contoso.com');
  assert.match(String(ctx.config.access?.requestUrl), /^https:\/\/myaccess/);
  assert.equal(accessReview(ctx.config, 'X').creates[0].isNew, false);
});

test('access: the request link must be https', async () => {
  const { ui } = fakeUi({ answers: ['new', 'admin@contoso.com', 'http://insecure'] });
  await assert.rejects(planAccess(fakeCtx({ graph: directory().graph, ui }).ctx), /https:\/\//);
});

test('access: the viewer group is created once, with the installer as owner, then reused', async () => {
  const dir = directory();
  const { ctx: ctx } = fakeCtx({ graph: dir.graph });
  ctx.config.access = { groupName: VIEWER_GROUP_NAME, contact: 'admin@contoso.com' };
  const first = await ensureViewerGroup(ctx);
  assert.equal(first?.id, 'g-1');
  assert.deepEqual(dir.calls, [`create ${VIEWER_GROUP_NAME} owner=user-1`]);
  assert.equal(ctx.config.access.createdGroup, true);
  await ensureViewerGroup(ctx);
  assert.equal(dir.calls.length, 1);
});

test('access: a created group that was deleted is created again; a chosen one is not', async () => {
  const dir = directory();
  const { ctx: ctx } = fakeCtx({ graph: dir.graph });
  ctx.config.access = { groupId: 'gone', groupName: VIEWER_GROUP_NAME, createdGroup: true, grantedModels: ['ds-vl'], reportShared: 'rp-1' };
  assert.equal((await ensureViewerGroup(ctx))?.id, 'g-1');
  assert.deepEqual(ctx.config.access.grantedModels, []);
  assert.equal(ctx.config.access.reportShared, undefined, 'the new group needs the report shared with it');

  const { ui, text } = fakeUi();
  const { ctx: other } = fakeCtx({ graph: dir.graph, ui });
  other.config.access = { groupId: 'gone', groupName: 'Copilot Leads', createdGroup: false };
  assert.equal(await ensureViewerGroup(other), null);
  assert.equal(other.config.access.groupId, undefined);
  assert.match(text(), /Copilot Leads is gone/);
});

test('access: without permission to create groups, setup carries on and says what to do', async () => {
  const dir = directory();
  dir.failCreate(new HttpError('Forbidden', { status: 403, method: 'POST', url: 'https://x' }));
  const { ui, text } = fakeUi();
  const { ctx: ctx } = fakeCtx({ graph: dir.graph, ui });
  ctx.config.access = { groupName: VIEWER_GROUP_NAME };
  assert.equal(await ensureViewerGroup(ctx), null);
  assert.match(text(), /can't create groups/);
  assert.match(text(), /run "access"/);
});

test('access: the group gets Build on each model once, and a failed grant only warns', async () => {
  const pbi = datasets();
  pbi.users['ds-cc'] = [{ identifier: 'G-1', principalType: 'Group', datasetUserAccessRight: 'ReadExplore' }];
  const { ui, text } = fakeUi();
  const { ctx: ctx } = fakeCtx({ powerBi: pbi.powerBi, ui });
  ctx.config.access = { groupId: 'g-1', groupName: VIEWER_GROUP_NAME };
  await grantModelAccess(ctx, MODELS);
  assert.deepEqual(pbi.calls, ['ws-1/ds-vl g-1 Group ReadExplore']);
  assert.deepEqual(ctx.config.access.grantedModels, ['ds-vl', 'ds-cc']);

  pbi.denied.add('ds-x');
  await grantModelAccess(ctx, [{ workspaceId: 'ws-1', datasetId: 'ds-x', name: 'Other' }]);
  assert.match(text(), /Couldn't give Consumption Central Viewers Build on Other/);
  assert.ok(!ctx.config.access.grantedModels?.includes('ds-x'));
});

test('access: a group Power BI does not know yet is retried, then reported if it never appears', async () => {
  const pbi = datasets();
  pbi.unseen['ds-vl'] = 2;
  const { ui, text } = fakeUi();
  const { ctx: ctx, sleeps } = fakeCtx({ powerBi: pbi.powerBi, ui });
  ctx.config.access = { groupId: 'g-1', groupName: VIEWER_GROUP_NAME };
  await grantModelAccess(ctx, MODELS);
  assert.deepEqual(pbi.calls, ['ws-1/ds-vl g-1 Group ReadExplore', 'ws-1/ds-cc g-1 Group ReadExplore']);
  assert.deepEqual(sleeps, [NEW_GROUP_RETRY_MS, NEW_GROUP_RETRY_MS]);
  assert.match(text(), /Waiting for Power BI to see the group/);
  assert.doesNotMatch(text(), /Couldn't give/);

  pbi.unseen['ds-y'] = NEW_GROUP_ATTEMPTS;
  await grantModelAccess(ctx, [{ workspaceId: 'ws-1', datasetId: 'ds-y', name: 'Other' }]);
  assert.match(text(), /Couldn't give Consumption Central Viewers Build on Other/);
  assert.equal(sleeps.length, 2 + NEW_GROUP_ATTEMPTS - 1);
});

test('access: the command adds viewers and owners, and skips names it cannot find', async () => {
  const dir = directory();
  dir.groups.set('g-1', { id: 'g-1', displayName: VIEWER_GROUP_NAME, members: ['u-ana'], owners: ['user-1'] });
  const { ui, text } = fakeUi({ answers: ['members', 'ana@contoso.com, ben@contoso.com; nobody@contoso.com', 'owner', 'ben@contoso.com', 'done'] });
  const { ctx: ctx } = fakeCtx({ graph: dir.graph, powerBi: datasets().powerBi, ui });
  ctx.config.access = { groupId: 'g-1', groupName: VIEWER_GROUP_NAME };
  await accessCommand(ctx, MODELS);
  assert.deepEqual(dir.calls, ['member u-ben', 'owner u-ben']);
  assert.match(text(), /Ana was already there/);
  assert.match(text(), /No user or group called "nobody@contoso.com"/);
  assert.match(text(), new RegExp(myGroupsUrl('g-1').replace(/[/.]/g, '\\$&')));
});

test('access: the viewer group gets Build on the deployed model', () => {
  const { ctx: ctx } = fakeCtx();
  const config = ctx.config;
  config.semanticModel.enabled = true;
  assert.deepEqual(fabricViewerModels(config), [], 'not deployed yet');
  config.semanticModel.id = 'ds-vl';
  assert.deepEqual(fabricViewerModels(config).map((m) => `${m.workspaceId}/${m.datasetId}`), ['ws-1/ds-vl']);
  config.semanticModel.enabled = false;
  assert.deepEqual(fabricViewerModels(config), [], 'switched off');
});

/**
 * A record with the model and its report deployed, and a viewer group.
 * @param {Parameters<typeof fakeCtx>[0]} [o]
 */
function withReport(o) {
  const t = fakeCtx(o);
  t.config.fabric.workspaceName = 'Consumption Central';
  Object.assign(t.config.semanticModel, { enabled: true, reports: true, id: 'ds-cc', report: { id: 'rp-1', name: 'Consumption Central' } });
  t.config.access = { groupId: 'g-1', groupName: VIEWER_GROUP_NAME, createdGroup: true };
  return t;
}

test('access: the plan review gives the group Build on the model and no workspace role; the report is shared by hand', () => {
  const { config } = fakeCtx();
  config.access = { groupName: VIEWER_GROUP_NAME, contact: 'admin@contoso.com' };
  const review = accessReview(config, 'Semantic model Consumption Central in workspace X');
  assert.deepEqual(review.creates, [
    { kind: 'Entra group', name: VIEWER_GROUP_NAME, isNew: true, detail: 'Who can view Consumption Central. You are its owner; share by adding people to it.' },
  ]);
  assert.deepEqual(review.grants, [{
    who: `${VIEWER_GROUP_NAME} (group)`,
    what: 'Build (ReadExplore)',
    where: 'Semantic model Consumption Central in workspace X',
    detail: 'So its members can view the report, once you share it with the group. Power BI has no API for that, so the installer shows you the clicks.',
  }]);

  config.access = { groupId: 'g-9', groupName: 'Copilot Leads', createdGroup: false };
  assert.equal(accessReview(config, 'X').creates[0].detail, 'Who can view Consumption Central. Its owners share it by adding people to it.');
  delete config.access;
  assert.deepEqual(accessReview(config, 'X'), { creates: [], grants: [] });
});

test('access: granting Build and sharing the report never give the group a workspace role', async () => {
  const pbi = datasets();
  /** @type {string[]} */
  const roles = [];
  const record = (/** @type {string} */ what) => async (/** @type {any[]} */ ...args) => {
    roles.push(`${what} ${args.join(' ')}`);
  };
  const dir = directory();
  dir.groups.set('g-1', { id: 'g-1', displayName: VIEWER_GROUP_NAME, members: [], owners: ['user-1'] });
  const { ui } = fakeUi({ answers: [true, 'grants', 'done'] });
  const { ctx, config } = withReport({
    ui,
    graph: dir.graph,
    fabric: { addRoleAssignment: record('workspace role'), updateRoleAssignment: record('workspace role') },
    powerBi: { ...pbi.powerBi, addGroupUser: record('workspace user') },
  });
  await grantModelAccess(ctx, fabricViewerModels(config));
  await shareReport(ctx);
  await accessCommand(ctx, fabricViewerModels(config));
  assert.deepEqual(pbi.calls, ['ws-1/ds-cc g-1 Group ReadExplore']);
  assert.deepEqual(config.access?.grantedModels, ['ds-cc']);
  assert.deepEqual(roles, []);
});

test('access: shareReportSteps opens the report, then Manage permissions, then grants the group', () => {
  const { config } = withReport();
  assert.deepEqual(shareReportSteps(config), [
    'Open the Consumption Central report (https://app.powerbi.com/groups/ws-1/reports/rp-1), or in Consumption Central choose … (More options) next to it.',
    'Choose Manage permissions, then Add user.',
    `Enter "${VIEWER_GROUP_NAME}" and choose Grant.`,
  ]);

  config.access = { groupId: 'g-9', groupName: 'Copilot Leads' };
  delete config.fabric.workspaceName;
  delete config.semanticModel.report;
  assert.deepEqual(shareReportSteps(config), [
    'Open the Consumption Central report, or in the workspace choose … (More options) next to it.',
    'Choose Manage permissions, then Add user.',
    'Enter "Copilot Leads" and choose Grant.',
  ]);
});

test('access: the report waits to be shared while there is a group and a published report nobody said was shared', () => {
  const { config } = withReport();
  assert.equal(shareReportPending(config), true);
  /** @type {any} */ (config.access).reportShared = 'rp-1';
  assert.equal(shareReportPending(config), false);
  /** @type {any} */ (config.semanticModel.report).id = 'rp-2';
  assert.equal(shareReportPending(config), true, 'a report published again has a new ID, so it is shared again');

  const none = (/** @type {(c: import('../src/config.js').InstallConfig) => void} */ edit) => {
    const t = withReport();
    edit(t.config);
    return shareReportPending(t.config);
  };
  assert.equal(none((c) => { delete c.access?.groupId; }), false, 'no group yet');
  assert.equal(none((c) => { delete c.semanticModel.report?.id; }), false, 'no report yet');
  assert.equal(none((c) => { c.semanticModel.reports = false; }), false, 'model only');
  assert.equal(none((c) => { c.semanticModel.enabled = false; }), false, 'no model');
});

test('access: the report share is asked once; "I\'ve shared it" records the report, Later reminds', async () => {
  const yes = fakeUi({ answers: [true] });
  const shared = withReport({ ui: yes.ui });
  await shareReport(shared.ctx);
  assert.deepEqual(yes.asked, ['Have you shared the report?']);
  assert.match(yes.text(), /Members of "Consumption Central Viewers" can open the report once it's shared with the group\. Power BI has no API for that, so it takes a few clicks:/);
  assert.match(yes.text(), / {2}1\. Open the Consumption Central report \(https:\/\/app\.powerbi\.com\/groups\/ws-1\/reports\/rp-1\)/);
  assert.match(yes.text(), / {2}2\. Choose Manage permissions, then Add user\./);
  assert.match(yes.text(), / {2}3\. Enter "Consumption Central Viewers" and choose Grant\./);
  assert.match(yes.text(), /The report is shared with "Consumption Central Viewers"/);
  assert.equal(shared.config.access?.reportShared, 'rp-1');
  assert.equal(shared.saves(), 1);

  const again = fakeUi();
  shared.ctx.ui = again.ui;
  await shareReport(shared.ctx);
  assert.deepEqual(again.asked, [], 'not asked again once shared');
  assert.equal(again.text(), '');

  const later = fakeUi();
  const notYet = withReport({ ui: later.ui });
  await shareReport(notYet.ctx);
  assert.deepEqual(later.asked, ['Have you shared the report?']);
  assert.match(later.text(), /Until it's shared, people in the group get "no access" when they open the report\./);
  assert.equal(notYet.config.access?.reportShared, undefined, 'Later is the default');
  assert.equal(notYet.saves(), 0);
});

test('access: with no group or no report there is nothing to share, and it says so', async () => {
  const noGroup = fakeUi();
  const a = withReport({ ui: noGroup.ui });
  delete a.config.access?.groupId;
  await shareReport(a.ctx);
  assert.deepEqual(noGroup.asked, []);
  assert.match(noGroup.text(), /There's no viewer group yet, so there's nothing to share\. The summary at the end says what to do\./);

  const noReport = fakeUi();
  const b = withReport({ ui: noReport.ui });
  delete b.config.semanticModel.report;
  await shareReport(b.ctx);
  assert.deepEqual(noReport.asked, []);
  assert.match(noReport.text(), /There's no report yet, so there's nothing to share\. The summary at the end says how to publish it\./);
});

test('access: the command offers to share the report only while it waits', async () => {
  const dir = directory();
  dir.groups.set('g-1', { id: 'g-1', displayName: VIEWER_GROUP_NAME, members: [], owners: ['user-1'] });
  const t = fakeUi({ answers: ['share', true, 'done'] });
  /** @type {any[][]} */
  const offered = [];
  const select = t.ui.select;
  t.ui.select = /** @type {any} */ (async (/** @type {string} */ m, /** @type {any[]} */ ch, /** @type {any} */ d) => {
    if (m === 'What next?') offered.push(ch);
    return select(m, ch, d);
  });
  const { ctx, config } = withReport({ ui: t.ui, graph: dir.graph, powerBi: datasets().powerBi });
  await accessCommand(ctx, fabricViewerModels(config));
  assert.deepEqual(offered.map((ch) => ch.map((c) => c.value)), [['members', 'owner', 'grants', 'share', 'done'], ['members', 'owner', 'grants', 'done']]);
  assert.deepEqual(offered[0].find((c) => c.value === 'share'), {
    name: 'Share the report with the group', value: 'share', description: 'Once only. Members get "no access" on the report until it\'s shared.',
  });
  assert.equal(config.access?.reportShared, 'rp-1');
});

test('access: choosing another group in the plan asks for the report share again', async () => {
  const dir = directory();
  dir.groups.set('g-9', { id: 'g-9', displayName: 'Copilot Leads', members: [], owners: [] });
  const keep = withReport({ graph: dir.graph, ui: fakeUi({ answers: ['new'] }).ui });
  /** @type {any} */ (keep.config.access).reportShared = 'rp-1';
  await planAccess(keep.ctx);
  assert.equal(keep.config.access?.reportShared, 'rp-1', 'the group it created is kept');

  const other = withReport({ graph: dir.graph, ui: fakeUi({ answers: ['existing', 'Copilot Leads'] }).ui });
  /** @type {any} */ (other.config.access).reportShared = 'rp-1';
  await planAccess(other.ctx);
  assert.equal(other.config.access?.groupId, 'g-9');
  assert.equal(other.config.access?.reportShared, undefined);

  const fresh = withReport({ graph: dir.graph, ui: fakeUi({ answers: ['new'] }).ui });
  Object.assign(/** @type {any} */ (fresh.config.access), { groupId: 'g-9', groupName: 'Copilot Leads', createdGroup: false, reportShared: 'rp-1' });
  await planAccess(fresh.ctx);
  assert.equal(fresh.config.access?.groupId, undefined, 'a new group is created');
  assert.equal(fresh.config.access?.reportShared, undefined);
});
