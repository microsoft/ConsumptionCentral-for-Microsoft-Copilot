// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { armApi, ROLES } from '../src/clients/azure.js';
import { FABRIC_ADMIN_ROLE, graphApi } from '../src/clients/graph.js';
import { emptyConfig } from '../src/config.js';
import { HttpError } from '../src/http.js';
import { canAssignDirectoryRoles, checkPrereqs } from '../src/prereqs.js';
import { createUi } from '../src/ui.js';

const GA = '62e90394-69f5-4237-9190-012177145e10';
const USER = /** @type {any} */ ({ id: 'user-1', upn: 'admin@contoso.com', tenantId: 't-1' });
const ALL = [{ actions: ['*'], notActions: [] }];
const READ = [{ actions: ['*/read'], notActions: [] }];
const CREATE = [{ actions: ['Microsoft.Resources/*'], notActions: [] }];
const assignment = (/** @type {string} */ role, principalId = USER.id) => ({ properties: { roleDefinitionId: `/subscriptions/x/providers/Microsoft.Authorization/roleDefinitions/${role}`, principalId } });

/**
 * Read-only APIs with everything a user could have, to take away test by test.
 * @param {any} [over]
 */
function fakeApis(over = {}) {
  /** @type {Record<string, any[]>} */
  const perms = { '/subscriptions/sub-1': ALL, ...(over.perms ?? {}) };
  return /** @type {any} */ ({
    graph: {
      myDirectoryRoles: async () => over.roles ?? [{ roleTemplateId: GA, displayName: 'Global Administrator' }, { roleTemplateId: FABRIC_ADMIN_ROLE, displayName: 'Fabric Administrator' }],
      myEligibleRoles: over.eligible ?? (async () => []),
      myGroupIds: async () => ['group-1'],
      myLicenseDetails: async () => over.licences ?? [{ servicePlans: [{ servicePlanName: 'BI_AZURE_P2', provisioningStatus: 'Success' }] }],
      usersCanRegisterApps: async () => over.usersCanRegister ?? true,
    },
    arm: {
      listSubscriptions: async () => over.subs ?? [{ subscriptionId: 'sub-1', displayName: 'Production', state: 'Enabled' }],
      permissions: async (/** @type {string} */ scope) => perms[scope] ?? READ,
      myRoleAssignments: async (/** @type {string} */ scope) => over.assigned?.[scope] ?? [assignment(ROLES.owner)],
      myEligibleRoles: async (/** @type {string} */ scope) => over.armEligible?.[scope] ?? [],
      getVault: async () => ({ name: 'kv' }),
    },
    fabric: {
      listCapacities: async () => over.capacities ?? [{ id: 'cap-1', displayName: 'F64', sku: 'F64', state: 'Active' }],
      tenantSettings: over.tenantSettings ?? (async () => { throw new HttpError('401 Unauthorized', { method: 'GET', url: 'https://api.fabric.microsoft.com/v1/admin/tenantsettings', status: 401 }); }),
    },
    discovery: {
      instances: async () => over.envs ?? [{ Url: 'https://org1.crm.dynamics.com', FriendlyName: 'Default', State: 0, IsUserSysAdmin: true }],
    },
  });
}

const run = async (/** @type {any} */ over, config = emptyConfig()) => {
  const items = await checkPrereqs({ api: fakeApis(over), user: USER, config });
  return Object.fromEntries(items.map((i) => [i.id, i]));
};

test('checkPrereqs: a well-equipped admin meets everything; each item says what it is for and how to get it', async () => {
  const items = await checkPrereqs({ api: fakeApis(), user: USER, config: emptyConfig() });
  assert.deepEqual(items.map((i) => i.id), ['consent-role', 'fabric-admin', 'power-platform-admin', 'register-apps', 'power-bi-pro', 'power-automate-premium', 'fabric-capacity', 'azure-rbac', 'key-vault', 'environments', 'viva-analyst', 'tenant-settings']);
  for (const i of items) {
    assert.ok(i.neededFor && i.howTo && i.label, i.id);
  }
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(byId['consent-role'].status, 'met');
  assert.match(byId['consent-role'].detail, /Active: Global Administrator/);
  assert.equal(byId['fabric-admin'].status, 'met');
  assert.equal(byId['power-platform-admin'].status, 'met', 'a Global Administrator can sign in to the licensing connection');
  assert.match(byId['power-platform-admin'].detail, /Active: Global Administrator/);
  assert.equal(byId['register-apps'].status, 'met');
  assert.equal(byId['power-bi-pro'].status, 'met');
  assert.equal(byId['fabric-capacity'].status, 'met');
  assert.equal(byId['azure-rbac'].status, 'met');
  assert.match(byId['azure-rbac'].rows?.[0].detail ?? '', /Can create resources and assign roles \(Owner\)/);
  assert.equal(byId['key-vault'].status, 'met');
  assert.equal(byId.environments.status, 'met');
  assert.equal(byId['tenant-settings'].status, 'unknown', 'a 401 on tenant settings is "couldn\'t check", not missing');
  assert.match(byId['tenant-settings'].detail, /only a Fabric Administrator can read/);
});

test('checkPrereqs: only active roles count; one you can activate in PIM says so, with a link', async () => {
  const eligible = await run({ roles: [], eligible: async () => [{ roleDefinitionId: GA, principalId: USER.id }] });
  assert.equal(eligible['consent-role'].status, 'eligible');
  assert.match(eligible['consent-role'].detail, /Not active yet: Global Administrator\. You can activate this role in Entra \(Privileged Identity Management\): https:\/\/entra\.microsoft\.com\//);
  assert.doesNotMatch(eligible['consent-role'].detail, /PIM-eligible|Eligible/);

  const none = await run({ roles: [], eligible: async () => { throw new HttpError('403', { method: 'GET', url: 'x', status: 403 }); } });
  assert.equal(none['consent-role'].status, 'missing');
  assert.match(none['consent-role'].detail, /Couldn't check for roles you could activate yourself/);
  assert.match(none['consent-role'].howTo, /link for a Global Administrator/);
  assert.equal(none['register-apps'].status, 'met', 'users can register apps');

  const locked = await run({ roles: [], usersCanRegister: false });
  assert.equal(locked['register-apps'].status, 'missing');
});

test('checkPrereqs: Power BI Pro only counts once provisioned', async () => {
  const none = await run({ licences: [{ servicePlans: [{ servicePlanName: 'BI_AZURE_P2', provisioningStatus: 'PendingActivation' }, { servicePlanName: 'EXCHANGE_S_ENTERPRISE', provisioningStatus: 'Success' }] }] });
  assert.equal(none['power-bi-pro'].status, 'missing');
  const ppu = await run({ licences: [{ servicePlans: [{ servicePlanName: 'BI_AZURE_P3', provisioningStatus: 'Success' }] }] });
  assert.equal(ppu['power-bi-pro'].status, 'met');
  assert.match(ppu['power-bi-pro'].detail, /Premium Per User/);
});

test('checkPrereqs: Azure access per subscription: Contributor alone is missing, Contributor and UAA is met, eligible Owner says activate first', async () => {
  const subs = [
    { subscriptionId: 'sub-a', displayName: 'A', state: 'Enabled' },
    { subscriptionId: 'sub-b', displayName: 'B', state: 'Enabled' },
    { subscriptionId: 'sub-c', displayName: 'C', state: 'Enabled' },
    { subscriptionId: 'sub-off', displayName: 'Off', state: 'Disabled' },
  ];
  const r = await run({
    subs,
    perms: { '/subscriptions/sub-a': CREATE, '/subscriptions/sub-b': ALL, '/subscriptions/sub-c': READ },
    assigned: {
      '/subscriptions/sub-a': [assignment(ROLES.contributor)],
      '/subscriptions/sub-b': [assignment(ROLES.contributor), assignment(ROLES.userAccessAdministrator, 'group-1')],
      '/subscriptions/sub-c': [],
    },
    armEligible: { '/subscriptions/sub-c': [assignment(ROLES.owner)] },
  });
  const rows = Object.fromEntries((r['azure-rbac'].rows ?? []).map((row) => [row.name, row]));
  assert.deepEqual(Object.keys(rows).sort(), ['A', 'B', 'C'], 'disabled subscriptions are skipped');
  assert.equal(rows.A.status, 'missing');
  assert.match(rows.A.detail ?? '', /not assign roles \(no User Access Administrator\) \(Contributor\)/);
  assert.equal(rows.B.status, 'met');
  assert.match(rows.B.detail ?? '', /Contributor, User Access Administrator/, 'a role held through a group counts');
  assert.equal(rows.C.status, 'eligible');
  assert.match(rows.C.detail ?? '', /Not active yet: Owner\. You can activate it/);
  assert.equal(r['azure-rbac'].status, 'met');
  assert.match(r['azure-rbac'].detail, /1 of 3 subscriptions/);
});

test('checkPrereqs: the install\'s subscription is checked first; no Azure at all is optional for Fabric', async () => {
  const config = emptyConfig();
  config.keyVault.subscriptionId = 'sub-b';
  const r = await run({ subs: [{ subscriptionId: 'sub-a', displayName: 'A', state: 'Enabled' }, { subscriptionId: 'sub-b', displayName: 'B', state: 'Enabled' }] }, config);
  assert.equal(r['azure-rbac'].rows?.[0].name, 'B');

  const none = await run({ subs: [] });
  assert.equal(none['azure-rbac'].status, 'missing');
  assert.equal(none['azure-rbac'].optional, true);
  assert.match(none['azure-rbac'].howTo, /--no-key-vault/);
  assert.equal(none['key-vault'].status, 'missing');
  assert.equal(none['key-vault'].optional, true, 'no Key Vault is a choice on Fabric');
});

test('checkPrereqs: the Studio flow\'s licensing connection takes a Power Platform, Billing or Global Administrator', async () => {
  const billing = await run({ roles: [{ roleTemplateId: 'b0f54661-2d74-4c50-afa3-1ec803f12efe', displayName: 'Billing Administrator' }] });
  assert.equal(billing['power-platform-admin'].status, 'met');
  assert.match(billing['power-platform-admin'].detail, /Active: Billing Administrator/);
  assert.match(billing['power-platform-admin'].neededFor, /^Only the Power Automate flow for Copilot Studio credits/);
  assert.doesNotMatch(`${billing['power-platform-admin'].neededFor} ${billing['power-platform-admin'].howTo}`, /System Administrator|Adding the app/);

  const none = await run({ roles: [] });
  assert.equal(none['power-platform-admin'].status, 'missing');
  assert.match(none['power-platform-admin'].detail, /^You don't have Power Platform Administrator, Billing Administrator or Global Administrator active\./);
  assert.match(none['consent-role'].detail, /^You don't have Global Administrator or Privileged Role Administrator active\./);
  assert.match(none['power-platform-admin'].howTo, /CSV exports/);
});

test('checkPrereqs: environments: a System Administrator can make flows; anyone else is "couldn\'t tell", since Environment Maker is enough', async () => {
  const r = await run({
    envs: [
      { Url: 'https://a.crm.dynamics.com', FriendlyName: 'Dev', State: 0, IsUserSysAdmin: false },
      { Url: 'https://b.crm.dynamics.com', FriendlyName: 'Prod', State: 0 },
    ],
    capacities: [{ id: 'p1', displayName: 'Premium', sku: 'P1', state: 'Active' }, { id: 'f2', displayName: 'Paused', sku: 'F2', state: 'Paused' }],
  });
  assert.equal(r.environments.status, 'unknown', 'not being a System Administrator doesn\'t mean you can\'t make flows');
  assert.deepEqual(r.environments.rows?.map((x) => x.status), ['unknown', 'unknown']);
  assert.match(r.environments.rows?.[0].detail ?? '', /Not a System Administrator\. Environment Maker is enough/);
  assert.equal(r.environments.rows?.[1].detail, 'Couldn\'t tell');
  assert.match(r.environments.detail, /You have access to 2 environments, but couldn't tell .*Environment Maker or higher/);
  assert.match(r.environments.neededFor, /^Only the Power Automate flow for Copilot Studio credits/);
  assert.equal(r['fabric-capacity'].status, 'met', 'a P SKU runs Fabric');

  const admin = await run({});
  assert.equal(admin.environments.status, 'met');
  assert.match(admin.environments.detail, /^System Administrator in 1 of 1 environment, so you can make flows there\./);

  const none = await run({ envs: [{ Url: 'https://off.crm.dynamics.com', FriendlyName: 'Off', State: 1, IsUserSysAdmin: true }] });
  assert.equal(none.environments.status, 'missing', 'a disabled environment doesn\'t count');
  assert.match(none.environments.howTo, /file to import|CSV exports/);

  const noCap = await run({ capacities: [{ id: 'a1', displayName: 'Embedded', sku: 'A1', state: 'Active' }] });
  assert.equal(noCap['fabric-capacity'].status, 'missing');

  const api = fakeApis();
  api.discovery.instances = async () => { throw new HttpError('503 Service Unavailable', { method: 'GET', url: 'x', status: 503 }); };
  const items = await checkPrereqs({ api, user: USER, config: emptyConfig() });
  const env = items.find((i) => i.id === 'environments');
  assert.equal(env?.status, 'unknown');
  assert.match(env?.detail ?? '', /^Couldn't check: 503/);
});

test('graph and ARM lookups keep only rows for the signed-in user\'s principals, whatever the filter returned', async () => {
  /** @type {any[]} */
  const queries = [];
  const http = /** @type {any} */ ({
    list: async (/** @type {string} */ path, /** @type {any} */ o) => {
      queries.push([path, o.query]);
      if (path.includes('roleEligibilityScheduleInstances') && path.startsWith('/roleManagement')) {
        return [{ roleDefinitionId: GA, principalId: USER.id }, { roleDefinitionId: GA, principalId: 'someone-else' }];
      }
      return [assignment(ROLES.owner), assignment(ROLES.owner, 'someone-else'), assignment(ROLES.contributor, 'group-1')];
    },
  });
  const graph = graphApi(http);
  assert.deepEqual((await graph.myEligibleRoles(USER.id)).map((r) => r.principalId), [USER.id]);
  assert.match(queries[0][1].$filter, /principalId eq 'user-1'/);

  const arm = armApi(http);
  const ids = [USER.id, 'group-1'];
  assert.deepEqual((await arm.myRoleAssignments('/subscriptions/s', ids)).map((r) => r.properties.principalId), [USER.id, 'group-1']);
  assert.equal(queries[1][1].$filter, "assignedTo('user-1')");
  assert.deepEqual((await arm.myEligibleRoles('/subscriptions/s', ids)).map((r) => r.properties.principalId), [USER.id, 'group-1']);
  assert.equal(queries[2][1].$filter, 'asTarget()');
});

test('checkPrereqs: Fabric administrator says plainly it is only needed when the tenant setting is off', async () => {
  const r = await run({ roles: [], eligible: async () => [{ roleDefinitionId: FABRIC_ADMIN_ROLE, principalId: USER.id }] });
  assert.match(r['fabric-admin'].label, /only needed if the tenant setting below is off/);
  assert.equal(r['fabric-admin'].status, 'eligible');
  assert.match(r['fabric-admin'].detail, /You can activate this role in Entra \(Privileged Identity Management\)/);
  for (const i of Object.values(r)) assert.doesNotMatch(`${i.label} ${i.detail} ${i.howTo}`, /PIM-eligible/, i.id);
});

test("checkPrereqs: tenant settings flag the model connection's setting, not the Power BI SDK visuals one the report doesn't use", async () => {
  const settings = (/** @type {boolean} */ apisOn) => async () => [
    { settingName: 'ServicePrincipalAccessPermissionAPIs', enabled: apisOn },
    { settingName: 'CustomVisualsTenant', enabled: false },
  ];
  const on = await run({ tenantSettings: settings(true) });
  assert.equal(on['tenant-settings'].status, 'met');
  assert.equal(on['tenant-settings'].detail, 'The setting Consumption Central needs is on.');
  const off = await run({ tenantSettings: settings(false) });
  assert.equal(off['tenant-settings'].status, 'missing');
  assert.equal(off['tenant-settings'].detail, 'Off: Service principals can call Fabric public APIs.');
});

test('checkPrereqs: Power Automate Premium is optional, needed only for the flows, and read from your own licences', async () => {
  const none = await run({});
  assert.equal(none['power-automate-premium'].status, 'missing');
  assert.equal(none['power-automate-premium'].optional, true);
  assert.match(none['power-automate-premium'].neededFor, /Copilot Studio credits/);
  assert.match(none['power-automate-premium'].neededFor, /signs in to the flow/);
  const premium = await run({ licences: [{ servicePlans: [{ servicePlanName: 'BI_AZURE_P2', provisioningStatus: 'Success' }, { servicePlanName: 'POWER_AUTOMATE_ATTENDED_RPA', provisioningStatus: 'Success' }] }] });
  assert.equal(premium['power-automate-premium'].status, 'met');
  assert.equal(premium['power-bi-pro'].status, 'met', 'one licence read serves both rows');
  assert.match(premium['power-automate-premium'].detail, /Power Automate Premium/);
  const perUser = await run({ licences: [{ servicePlans: [{ servicePlanName: 'FLOW_PER_USER', provisioningStatus: 'Success' }] }] });
  assert.equal(perUser['power-automate-premium'].status, 'met');
  const seeded = await run({ licences: [{ servicePlans: [{ servicePlanName: 'FLOW_O365_P3', provisioningStatus: 'Success' }, { servicePlanName: 'FLOW_PER_USER', provisioningStatus: 'PendingActivation' }] }] });
  assert.equal(seeded['power-automate-premium'].status, 'missing', 'the Microsoft 365 flow plan has no premium connectors');
});

test('checkPrereqs: Viva Insights analyst can\'t be read, so it is optional and "couldn\'t check", and says it can wait', async () => {
  const r = await run({});
  assert.equal(r['viva-analyst'].status, 'unknown');
  assert.equal(r['viva-analyst'].optional, true);
  assert.match(r['viva-analyst'].detail, /^Couldn't check/);
  assert.match(r['viva-analyst'].neededFor, /Insights Analyst role creates the query/);
  assert.match(r['viva-analyst'].neededFor, /add it later/);
});

test('canAssignDirectoryRoles: true only with Global Administrator or Privileged Role Administrator active', async () => {
  assert.equal(await canAssignDirectoryRoles(fakeApis()), true);
  assert.equal(await canAssignDirectoryRoles(fakeApis({ roles: [{ roleTemplateId: 'e8611ab8-c189-46e8-94e1-60213ab1f814', displayName: 'Privileged Role Administrator' }] })), true);
  assert.equal(await canAssignDirectoryRoles(fakeApis({ roles: [{ roleTemplateId: FABRIC_ADMIN_ROLE, displayName: 'Fabric Administrator' }] })), false);
  assert.equal(await canAssignDirectoryRoles(fakeApis({ roles: [] })), false);
});

test('terminal: a missing optional prerequisite gets a neutral mark, not the red cross', () => {
  /** @type {string[]} */
  const out = [];
  const item = { detail: 'd', neededFor: 'n', howTo: 'h' };
  createUi({ write: (s) => out.push(s) }).prereqs(/** @type {any} */ ([
    { ...item, status: 'missing', label: 'Key Vault', optional: true },
    { ...item, status: 'missing', label: 'Fabric capacity' },
  ]));
  const text = out.join('');
  assert.match(text, /– Key Vault \(optional\)/);
  assert.match(text, /✗ Fabric capacity/);
  assert.doesNotMatch(text, /✗ Key Vault/);
});