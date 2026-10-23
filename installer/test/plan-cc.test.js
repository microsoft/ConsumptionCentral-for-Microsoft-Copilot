// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VIEWER_GROUP_NAME } from '../src/steps/access.js';
import {
  APP_NAME, billingScopeFrom, confirmPlan, defaultsToNoVault, KEEP_AWAKE, plan, planCommercialTerms, planGithub, planKeyVault, planReview, validateBillingScope, validateEnterprise,
} from '../src/steps/plan.js';
import { COWORK_TASKS_DIR, UPLOAD_DIR } from '../src/uploads.js';
import { fakeCtx, fakeUi } from './fakes.js';

const SUB_PAYG = '00000000-0000-0000-0000-00000000000a';
const SUB_AI = '00000000-0000-0000-0000-00000000000b';
const SUB_DEV = '00000000-0000-0000-0000-00000000000c';
const ACCOUNT = '/providers/Microsoft.Billing/billingAccounts/12345678';
const ENTERPRISE_RULE = 'The slug from github.com/enterprises/<slug>: letters, digits and hyphens.';
const SCOPE_RULE = 'A subscription (/subscriptions/<id>), a billing account (/providers/Microsoft.Billing/billingAccounts/<id>) or a billing profile (…/billingAccounts/<id>/billingProfiles/<id>).';
const SLUG_QUESTION = 'GitHub enterprise slug, as in github.com/enterprises/<slug>';
const SCOPE_QUESTION = 'Which billing scope should it read the credit rate from? Copilot credits are charged to the subscription a billing policy names.';

/** @type {import('../src/steps/plan.js').Preflight} */
const PRE = { capacities: [], subscriptions: [], roles: [], canConsent: true, canCreateApps: true };

/**
 * A new install: nothing deployed, no app registration and no vault yet.
 * @param {Parameters<typeof fakeCtx>[0]} [o]
 */
function newInstall(o) {
  const t = fakeCtx(o);
  t.config.app = {};
  t.config.keyVault = { secretName: t.config.keyVault.secretName };
  t.config.fabric = { notebooks: {}, workspaceName: 'Consumption Central', lakehouseName: 'ConsumptionCentral' };
  return t;
}

/**
 * Records each select's choices and default, then answers as the fake UI does.
 * @param {ReturnType<typeof fakeUi>} t
 */
function recordSelects(t) {
  /** @type {{ message: string, choices: any[], def: any }[]} */
  const seen = [];
  const select = t.ui.select;
  t.ui.select = /** @type {any} */ (async (/** @type {string} */ message, /** @type {any[]} */ choices, /** @type {any} */ def) => {
    seen.push({ message, choices, def });
    return select(message, choices, def);
  });
  return seen;
}

/** ARM for a new vault the user may create anywhere. */
const vaultArm = () => ({
  listVaults: async () => [],
  getResourceGroup: async (/** @type {string} */ _sub, /** @type {string} */ name) => ({ name }),
  permissions: async () => [{ actions: ['*'], notActions: [] }],
  checkVaultName: async () => ({ nameAvailable: true }),
});

test('plan: a GitHub enterprise slug is letters, digits and hyphens', () => {
  for (const ok of ['contoso', 'Contoso-Labs', 'c0ntoso', '  contoso  ']) assert.equal(validateEnterprise(ok), true, ok);
  for (const bad of ['', '-contoso', 'contoso labs', 'contoso_labs', 'github.com/enterprises/contoso']) assert.equal(validateEnterprise(bad), ENTERPRISE_RULE, bad);
});

test('plan: a billing scope is a subscription, a billing account or a billing profile', () => {
  assert.equal(billingScopeFrom(`  /subscriptions/${SUB_DEV}//  `), `/subscriptions/${SUB_DEV}`);
  for (const ok of [
    `/subscriptions/${SUB_DEV}`,
    `/subscriptions/${SUB_DEV.toUpperCase()}/`,
    ACCOUNT,
    '/providers/Microsoft.Billing/billingAccounts/0a1b2c3d-0000-0000-0000-000000000000:4e5f6a7b-0000-0000-0000-000000000000_2019-05-31',
    `${ACCOUNT}/billingProfiles/AB12-CD34-EF5-GH6`,
    '/providers/microsoft.billing/billingaccounts/12345678',
  ]) {
    assert.equal(validateBillingScope(ok), true, ok);
  }
  for (const bad of [
    '',
    `subscriptions/${SUB_DEV}`,
    '/subscriptions/contoso',
    `/subscriptions/${SUB_DEV}/resourceGroups/rg-contoso`,
    '/providers/Microsoft.Billing/billingAccounts/',
    `${ACCOUNT}/billingProfiles/`,
    `${ACCOUNT}/invoiceSections/XY12`,
    '/providers/Microsoft.Billing/billingAccounts/1234 5678',
  ]) {
    assert.equal(validateBillingScope(bad), SCOPE_RULE, bad);
  }
});

test('plan: GitHub asks nothing unless it reads from the API', async () => {
  for (const mode of /** @type {const} */ (['skip', 'csv'])) {
    const t = fakeUi();
    const { ctx, config } = fakeCtx({ ui: t.ui });
    config.dataSources.github = mode;
    await planGithub(ctx);
    assert.deepEqual(t.asked, []);
    assert.equal(t.text(), '');
    assert.equal(config.github, undefined);
  }
});

test('plan: GitHub from the API asks for the enterprise, then says which token comes next', async () => {
  const t = fakeUi({ answers: ['  contoso  '] });
  const { ctx, config } = fakeCtx({ ui: t.ui });
  config.dataSources.github = 'api';
  await planGithub(ctx);
  assert.deepEqual(t.asked, [SLUG_QUESTION]);
  assert.deepEqual(config.github, { enterprise: 'contoso' });
  assert.match(
    t.text(),
    /Once you go ahead, the installer asks for a classic personal access token with scope read:enterprise or manage_billing:copilot, made by an owner or billing manager of contoso\. Or set CONSUMPTION_CENTRAL_GITHUB_TOKEN before you start\.\n/,
  );

  const web = fakeUi({ answers: ['contoso'] });
  /** @type {any} */ (web.ui).web = true;
  const w = fakeCtx({ ui: web.ui });
  w.config.dataSources.github = 'api';
  await planGithub(w.ctx);
  assert.match(web.text(), /made by an owner or billing manager of contoso\.\n/);
  assert.doesNotMatch(web.text(), /CONSUMPTION_CENTRAL_GITHUB_TOKEN/);

  const bad = fakeUi({ answers: ['contoso labs'] });
  const b = fakeCtx({ ui: bad.ui });
  b.config.dataSources.github = 'api';
  await assert.rejects(planGithub(b.ctx), { message: `${SLUG_QUESTION}: ${ENTERPRISE_RULE}` });
});

test('plan: with --yes, GitHub from the API needs --github-enterprise', async () => {
  const t = fakeUi({ yes: true });
  const { ctx, config } = fakeCtx({ ui: t.ui });
  config.dataSources.github = 'api';
  await assert.rejects(planGithub(ctx), {
    message: 'Reading GitHub Copilot from the API needs your enterprise. Add --github-enterprise <slug>, as in github.com/enterprises/<slug>, or run without --yes.',
  });
  assert.deepEqual(t.asked, []);

  const token = { tokenSetAt: '2026-05-01T00:00:00Z' };
  config.github = { enterprise: 'contoso', ...token };
  await planGithub(ctx);
  assert.deepEqual(config.github, { enterprise: 'contoso', ...token });
  assert.doesNotMatch(t.text(), /Once you go ahead/, 'a token is in place');
});

test('plan: another GitHub enterprise needs a new token; the same one in other capitals does not', async () => {
  const token = { tokenSetAt: '2026-05-01T00:00:00Z', tokenExpires: '2026-08-01T00:00:00Z' };
  const same = fakeUi({ answers: ['CONTOSO'] });
  const a = fakeCtx({ ui: same.ui });
  a.config.dataSources.github = 'api';
  a.config.github = { enterprise: 'contoso', ...token };
  await planGithub(a.ctx);
  assert.deepEqual(a.config.github, { enterprise: 'CONTOSO', ...token });
  assert.doesNotMatch(same.text(), /Once you go ahead/);

  const other = fakeUi({ answers: ['contoso-labs'] });
  const b = fakeCtx({ ui: other.ui });
  b.config.dataSources.github = 'api';
  b.config.github = { enterprise: 'contoso', secretName: 'consumption-central-github-pat-2', ...token };
  await planGithub(b.ctx);
  assert.deepEqual(b.config.github, { enterprise: 'contoso-labs', secretName: 'consumption-central-github-pat-2' });
  assert.match(other.text(), /made by an owner or billing manager of contoso-labs\./);
});

test('plan: the credit rate asks nothing unless it reads from Cost Management', async () => {
  const t = fakeUi();
  const { ctx, config } = fakeCtx({ ui: t.ui });
  await planCommercialTerms(ctx, { subscriptions: [{ subscriptionId: SUB_DEV, displayName: 'Contoso Dev' }] });
  assert.deepEqual(t.asked, []);
  assert.equal(t.text(), '');
  assert.equal(config.commercialTerms, undefined);
});

test('plan: billing scopes list the pay-as-you-go subscriptions first, then Azure AI, then the rest, once each', async () => {
  const t = fakeUi();
  const seen = recordSelects(t);
  const { ctx, config } = fakeCtx({ ui: t.ui });
  config.dataSources.commercialTerms = 'api';
  config.consumption.paygSubscriptions = [{ subscriptionId: SUB_PAYG, name: 'Contoso PAYG', policies: ['Copilot PAYG'] }];
  config.consumption.azureSubscriptionId = SUB_AI;
  config.consumption.azureSubscriptionName = 'Contoso AI';
  await planCommercialTerms(ctx, {
    subscriptions: [
      { subscriptionId: SUB_AI.toUpperCase(), displayName: 'Contoso AI, listed' },
      { subscriptionId: SUB_DEV, displayName: 'Contoso Dev' },
      { subscriptionId: SUB_PAYG, displayName: 'Contoso PAYG, listed' },
    ],
  });
  assert.deepEqual(t.asked, [SCOPE_QUESTION]);
  assert.deepEqual(seen[0].choices, [
    { name: `Contoso PAYG (/subscriptions/${SUB_PAYG})`, value: `/subscriptions/${SUB_PAYG}`, description: 'A billing policy charges Copilot pay-as-you-go here.' },
    { name: `Contoso AI (/subscriptions/${SUB_AI})`, value: `/subscriptions/${SUB_AI}`, description: 'The Azure AI subscription.' },
    { name: `Contoso Dev (/subscriptions/${SUB_DEV})`, value: `/subscriptions/${SUB_DEV}` },
    { name: 'A billing account or billing profile', value: 'other', description: 'Its ID, from Cost Management + Billing > Billing scopes > Properties.' },
  ]);
  assert.equal(seen[0].def, `/subscriptions/${SUB_PAYG}`);
  assert.deepEqual(config.commercialTerms, { scope: `/subscriptions/${SUB_PAYG}`, scopeName: 'Contoso PAYG' });
  assert.match(
    t.text(),
    /Ingest_CommercialTerms runs once after setup, as you, so you need Cost Management Reader \(or a billing reader role\) on Contoso PAYG\. The installer doesn't grant it\./,
  );
});

test('plan: with --yes, the credit rate needs --billing-scope, and takes the one given', async () => {
  const t = fakeUi({ yes: true });
  const { ctx, config } = fakeCtx({ ui: t.ui });
  config.dataSources.commercialTerms = 'api';
  const pre = { subscriptions: [{ subscriptionId: SUB_DEV, displayName: 'Contoso Dev' }] };
  await assert.rejects(planCommercialTerms(ctx, pre), {
    message: 'Reading the credit rate needs a billing scope. Add --billing-scope with a subscription, billing account or billing profile ID, or run without --yes.',
  });
  assert.deepEqual(t.asked, []);

  config.commercialTerms = { scope: `${ACCOUNT}/` };
  await planCommercialTerms(ctx, pre);
  assert.deepEqual(config.commercialTerms, { scope: ACCOUNT });
});

test('plan: a billing account or profile is typed in; a new scope is read again after setup', async () => {
  const profile = `${ACCOUNT}/billingProfiles/AB12-CD34`;
  const t = fakeUi({ answers: ['other', ` ${profile}/ `] });
  const { ctx, config } = fakeCtx({ ui: t.ui });
  config.dataSources.commercialTerms = 'api';
  config.commercialTerms = { scope: `/subscriptions/${SUB_DEV}`, scopeName: 'Contoso Dev', ranAt: '2026-05-02T00:00:00Z', status: 'Completed' };
  await planCommercialTerms(ctx, { subscriptions: [{ subscriptionId: SUB_DEV, displayName: 'Contoso Dev' }] });
  assert.deepEqual(t.asked, [SCOPE_QUESTION, 'Billing scope ID']);
  assert.deepEqual(config.commercialTerms, { scope: profile });
  assert.ok(t.text().includes(`Cost Management Reader (or a billing reader role) on ${profile}.`));

  const bad = fakeUi({ answers: ['other', '/subscriptions/contoso'] });
  const b = fakeCtx({ ui: bad.ui });
  b.config.dataSources.commercialTerms = 'api';
  await assert.rejects(planCommercialTerms(b.ctx, { subscriptions: [] }), { message: `Billing scope ID: ${SCOPE_RULE}` });
});

test('plan: keeping the saved billing scope keeps its last run', async () => {
  const ran = { ranAt: '2026-05-02T00:00:00Z', status: 'Completed' };
  const listed = fakeUi();
  const seen = recordSelects(listed);
  const a = fakeCtx({ ui: listed.ui });
  a.config.dataSources.commercialTerms = 'api';
  a.config.commercialTerms = { scope: `/SUBSCRIPTIONS/${SUB_DEV.toUpperCase()}`, ...ran };
  await planCommercialTerms(a.ctx, {
    subscriptions: [
      { subscriptionId: SUB_AI, displayName: 'Contoso AI' },
      { subscriptionId: SUB_DEV, displayName: 'Contoso Dev' },
    ],
  });
  assert.equal(seen[0].def, `/subscriptions/${SUB_DEV}`);
  assert.deepEqual(a.config.commercialTerms, { scope: `/subscriptions/${SUB_DEV}`, scopeName: 'Contoso Dev', ...ran });

  const typed = fakeUi();
  const seenTyped = recordSelects(typed);
  const b = fakeCtx({ ui: typed.ui });
  b.config.dataSources.commercialTerms = 'api';
  b.config.commercialTerms = { scope: ACCOUNT, scopeName: 'Contoso Dev', ...ran };
  await planCommercialTerms(b.ctx, { subscriptions: [] });
  assert.equal(seenTyped[0].def, 'other');
  assert.deepEqual(typed.asked, [SCOPE_QUESTION, 'Billing scope ID']);
  assert.deepEqual(b.config.commercialTerms, { scope: ACCOUNT, ...ran }, 'the typed default is the saved scope');
});

test('planReview: no app registration unless a source or the model signs in as one', () => {
  const { ctx, config } = newInstall();
  config.semanticModel.enabled = false;
  const off = planReview(ctx);
  assert.deepEqual(off.creates.map((i) => i.kind), ['Workspace', 'Lakehouse', 'Notebooks', 'Pipeline', 'Folder']);
  assert.deepEqual(off.grants, []);
  assert.deepEqual(off.runsOn.map((r) => r.what), ['Notebooks and pipeline', 'Scheduled runs']);

  // The model's connection signs in as the app, with no Graph permissions and no Key Vault.
  config.semanticModel.enabled = true;
  config.semanticModel.reports = true;
  config.access = { groupName: VIEWER_GROUP_NAME, contact: 'admin@contoso.com' };
  const on = planReview(ctx);
  assert.deepEqual(on.creates[0], {
    kind: 'App registration',
    name: APP_NAME,
    isNew: true,
    detail: "Signs in for the semantic model's connection only, with a client secret only the connection holds. No Graph permissions.",
  });
  assert.deepEqual(on.creates.map((i) => i.kind), ['App registration', 'Workspace', 'Lakehouse', 'Notebooks', 'Pipeline', 'Folder', 'Semantic model', 'Connection', 'Report', 'Entra group']);
  assert.equal(on.creates.find((i) => i.kind === 'Connection')?.detail, 'Lets the model read the Lakehouse as the app, with a client secret that only the connection holds.');
  assert.deepEqual(on.grants.map((g) => `${g.who}: ${g.what} on ${g.where}`), [
    `${APP_NAME} (app): Viewer on Workspace Consumption Central`,
    `${VIEWER_GROUP_NAME} (group): Build (ReadExplore) on Semantic model Consumption Central Model in workspace Consumption Central`,
  ]);

  config.dataSources.orgData = 'api';
  Object.assign(config.keyVault, { uri: 'https://kv-contoso.vault.azure.net/', name: 'kv-contoso' });
  const sources = planReview(ctx, { ...PRE, canConsent: false });
  assert.equal(sources.creates[0].detail, 'The notebooks sign in as it, with a client secret kept in Key Vault.');
  assert.deepEqual(sources.grants[0], {
    who: `${APP_NAME} (app)`,
    what: 'Microsoft Graph application permissions: User.Read.All',
    where: 'Your tenant, through admin consent',
    detail: "You can't grant it yourself. You get a link for a Global Administrator or Privileged Role Administrator to approve.",
  });
});

test('planReview: the viewer group gets Build on the model, no workspace role, and the report share is yours to do once', () => {
  const { ctx, config } = newInstall();
  Object.assign(config.semanticModel, { enabled: true, reports: true });
  config.access = { groupId: 'g-1', groupName: VIEWER_GROUP_NAME, createdGroup: true };
  const review = planReview(ctx);
  const group = review.grants.filter((g) => g.who === `${VIEWER_GROUP_NAME} (group)`);
  assert.deepEqual(group, [
    {
      who: `${VIEWER_GROUP_NAME} (group)`,
      what: 'Build (ReadExplore)',
      where: 'Semantic model Consumption Central Model in workspace Consumption Central',
      detail: 'So its members can view the report, once you share it with the group. Power BI has no API for that, so the installer shows you the clicks.',
    },
  ]);
  assert.deepEqual(review.grants.filter((g) => g.where.startsWith('Workspace ')).map((g) => g.who), [`${APP_NAME} (app)`]);
  assert.deepEqual(review.creates.find((i) => i.kind === 'Entra group'), {
    kind: 'Entra group',
    name: VIEWER_GROUP_NAME,
    isNew: false,
    detail: 'Who can view Consumption Central. You are its owner; share by adding people to it.',
  });

  config.semanticModel.enabled = false;
  assert.deepEqual(planReview(ctx).grants, [], 'no model, so nothing for the group');
});

test('planReview: the GitHub token alone, in the notebooks or in a new vault', () => {
  const { ctx, config } = newInstall();
  config.semanticModel.enabled = false;
  config.dataSources.github = 'api';
  config.keyVault.mode = 'notebook';
  const notebook = planReview(ctx);
  assert.deepEqual(notebook.creates[0], {
    kind: 'GitHub token',
    name: 'In the notebooks (no Key Vault)',
    isNew: true,
    detail: 'Anyone with a role in the workspace, Viewer included, can read it; also in run snapshots, exports and deployment pipelines. Key Vault avoids that.',
  });
  assert.ok(!notebook.creates.some((i) => i.kind === 'App registration'));
  config.github = { enterprise: 'contoso', tokenSetAt: '2026-05-01T00:00:00Z' };
  assert.equal(planReview(ctx).creates[0].isNew, false, 'a token in place is kept');

  delete config.keyVault.mode;
  Object.assign(config.keyVault, { name: 'consumption-central-ab12', resourceGroup: 'rg-consumption-central', location: 'westeurope', rbac: true, subscriptionId: SUB_DEV });
  const vault = planReview(ctx, { ...PRE, subscriptions: [{ subscriptionId: SUB_DEV, displayName: 'Contoso Dev' }] });
  assert.deepEqual(vault.creates[0], {
    kind: 'Key Vault',
    name: 'consumption-central-ab12',
    isNew: true,
    detail: 'In resource group rg-consumption-central, westeurope, using Azure RBAC. Holds the GitHub token "consumption-central-github-pat".',
  });
  assert.deepEqual(vault.grants.map((g) => `${g.who}: ${g.what}`), ['admin@contoso.com (you): Key Vault Secrets Officer, so you can write the GitHub token']);
  assert.deepEqual(vault.runsOn.find((r) => r.what === 'Scheduled runs')?.detail, "The schedule's owner reads the GitHub token from Key Vault.");
  assert.deepEqual(vault.costs?.map((x) => `${x.what}: ${x.detail}`).at(-1), 'Azure Key Vault: Holds the GitHub token. Billed to your Azure subscription.');
});

test('planReview: the credit rate is read once after setup, until it has run', () => {
  const { ctx, config } = newInstall();
  config.dataSources.commercialTerms = 'api';
  config.commercialTerms = { scope: `/subscriptions/${SUB_PAYG}`, scopeName: 'Contoso PAYG' };
  assert.deepEqual(planReview(ctx).runsOn.at(-1), {
    what: 'Credit rate',
    where: 'Once, after setup, as admin@contoso.com',
    detail: 'Reads Contoso PAYG; needs Cost Management Reader there.',
  });
  config.commercialTerms.ranAt = '2026-05-02T00:00:00Z';
  assert.ok(!planReview(ctx).runsOn.some((r) => r.what === 'Credit rate'));
});

test('confirmPlan: prints the whole plan, then asks to go ahead', async () => {
  const t = fakeUi();
  const { ctx, config } = newInstall({ ui: t.ui });
  config.keyVault.mode = 'notebook';
  Object.assign(config.semanticModel, { enabled: true, reports: true });
  config.dataSources.github = 'api';
  config.github = { enterprise: 'contoso' };
  config.dataSources.commercialTerms = 'api';
  config.commercialTerms = { scope: `/subscriptions/${SUB_PAYG}`, scopeName: 'Contoso PAYG' };
  config.access = { groupName: VIEWER_GROUP_NAME, contact: 'admin@contoso.com' };
  ctx.runFirstLoad = true;
  assert.equal(await confirmPlan(ctx), true);
  assert.deepEqual(t.asked, ['Go ahead?']);
  const pad = ' '.repeat(17);
  assert.equal(
    t.text(),
    [
      '',
      'Ready to set up',
      '    Data:        Copilot Cowork and Work IQ credits: Upload CSV',
      `${pad}Cowork task categories: Skip`,
      `${pad}Copilot Studio credits: Upload CSV only`,
      `${pad}GitHub Copilot: Connected (GitHub API)`,
      `${pad}Azure AI Foundry and Azure OpenAI: Skip`,
      `${pad}Org data: Skip`,
      `${pad}Credit rate from Azure Cost Management: Connected (API)`,
      `    Exports:     Copilot Cowork and Work IQ credits, Copilot Studio credits (dropped in ${UPLOAD_DIR})`,
      '    Workspace:   Consumption Central (new)',
      '    Lakehouse:   ConsumptionCentral',
      `    App:         ${APP_NAME} (new)`,
      '    Secrets:     the GitHub token in the notebooks (no Key Vault: anyone with a role in the workspace can read it)',
      '    Schedule:    Daily at 02:00 UTC',
      '    Power BI:    Consumption Central Model (new)',
      '    Reports:     Consumption Central (new)',
      "    Prices:      the template's defaults",
      '    GitHub:      contoso (token asked for once you go ahead)',
      '    Credit rate: Contoso PAYG (read once, after setup)',
      '    First load:  straight after setup',
      '    Costs:       Fabric capacity https://azure.microsoft.com/pricing/details/microsoft-fabric/',
      `    ${KEEP_AWAKE}`,
      '',
    ].join('\n'),
  );

  const no = fakeUi({ answers: [false] });
  const b = newInstall({ ui: no.ui });
  b.config.semanticModel.enabled = false;
  b.config.schedule = { ...b.config.schedule, frequency: 'weekly', weekday: 'Monday', time: '06:30' };
  b.config.prices = { creditRate: 0.012 };
  assert.equal(await confirmPlan(b.ctx), false);
  assert.match(no.text(), /Schedule: {4}Mondays at 06:30 UTC\n/);
  assert.doesNotMatch(no.text(), /App:|Secrets:|Key Vault:|Power BI:|Reports:|Prices:|GitHub:|Credit rate:|First load:/, 'no model, no app, no secret');
});

test('confirmPlan: a Cowork task export is said to land where the Viva load reads it', async () => {
  /** @param {Partial<import('../src/uploads.js').DataSourceModes>} over */
  const exportsLine = async (over) => {
    const t = fakeUi();
    const { ctx, config } = newInstall({ ui: t.ui });
    config.dataSources = { ...config.dataSources, ...over };
    await confirmPlan(ctx);
    return t.text().split('\n').find((l) => l.startsWith('    Exports:'));
  };
  assert.equal(
    await exportsLine({ coworkTasks: 'csv' }),
    `    Exports:     Copilot Cowork and Work IQ credits, Cowork task categories, Copilot Studio credits (dropped in ${UPLOAD_DIR}, Cowork tasks in ${COWORK_TASKS_DIR})`,
  );
  assert.equal(await exportsLine({ coworkCredits: 'skip', coworkTasks: 'csv', studioCredits: 'skip' }), `    Exports:     Cowork task categories (in ${COWORK_TASKS_DIR})`);
});

test('defaultsToNoVault: a new install keeps secrets in the notebooks unless it asked for Key Vault or has one', () => {
  const { ctx, config } = newInstall();
  assert.equal(defaultsToNoVault(ctx), true);
  ctx.useKeyVault = true;
  assert.equal(defaultsToNoVault(ctx), false, '--key-vault');
  ctx.useKeyVault = false;
  config.uploads.flowIdentity = 'app';
  assert.equal(defaultsToNoVault(ctx), false, 'flows that read the secret from the vault');
  for (const [key, value] of [
    ['uri', 'https://kv-contoso.vault.azure.net/'],
    ['mode', 'keyvault-admin'],
    ['name', 'kv-contoso'],
    ['id', `/subscriptions/${SUB_DEV}/resourceGroups/rg-contoso/providers/Microsoft.KeyVault/vaults/kv-contoso`],
    ['subscriptionId', SUB_DEV],
  ]) {
    const t = newInstall();
    Object.assign(t.config.keyVault, { [key]: value });
    assert.equal(defaultsToNoVault(t.ctx), false, key);
  }
});

test('plan: with only exports and no model, the identity section needs no app, secret or Key Vault, even with --key-vault', async () => {
  const t = fakeUi();
  const { ctx, config } = newInstall({ ui: t.ui });
  config.semanticModel.enabled = false;
  ctx.useKeyVault = true;
  await plan(ctx, PRE, 'identity');
  assert.deepEqual(t.asked, []);
  assert.equal(t.text(), '\nApp registration\n  ✓ These choices need no app registration or secret\n');
  assert.deepEqual(config.app, {});
  assert.deepEqual(config.keyVault, { secretName: 'consumption-central-client-secret' });
});

test('plan: the model alone asks for the app its connection signs in as, and no Key Vault', async () => {
  const t = fakeUi();
  const seen = recordSelects(t);
  const { ctx, config } = newInstall({ ui: t.ui });
  config.semanticModel.enabled = true;
  await plan(ctx, PRE, 'identity');
  assert.deepEqual(t.asked, ["The semantic model's connection signs in as an app, so the model refreshes without you."]);
  assert.deepEqual(seen[0].choices.map((ch) => ch.value), ['new', 'existing']);
  assert.equal(config.app.existing, false);
  assert.doesNotMatch(t.text(), /Key Vault|need no app/);
});

test('plan: the GitHub token alone needs no app, and goes in the notebooks by default', async () => {
  const t = fakeUi();
  const { ctx, config } = newInstall({ ui: t.ui });
  config.semanticModel.enabled = false;
  config.dataSources.github = 'api';
  await plan(ctx, PRE, 'identity');
  assert.deepEqual(t.asked, ['Where should the GitHub token go?', 'Keep the GitHub token in the notebooks, with no Key Vault?']);
  assert.equal(config.keyVault.mode, 'notebook');
  assert.match(t.text(), /\nKey Vault for the GitHub token\n/);
  assert.match(t.text(), /No Key Vault: the GitHub token is written into the notebooks as plain text\./);
  assert.match(t.text(), /The GitHub token can do whatever its scopes allow in your enterprise/);
  assert.doesNotMatch(t.text(), /App registration|client secret/);
});

test('planKeyVault: a vault for the GitHub token alone asks no client secret name', async () => {
  const pre = { ...PRE, subscriptions: [{ subscriptionId: SUB_DEV, displayName: 'Contoso Dev' }] };
  const t = fakeUi();
  const { ctx, config } = newInstall({ ui: t.ui, arm: vaultArm() });
  config.dataSources.github = 'api';
  await planKeyVault(ctx, pre, 'westeurope');
  assert.deepEqual(t.asked, ['Azure subscription', 'Vault', 'Resource group (created if missing)', 'Azure region', 'Vault name (globally unique)']);
  assert.equal(config.keyVault.subscriptionId, SUB_DEV);
  assert.equal(config.keyVault.resourceGroup, 'rg-consumption-central');
  assert.equal(config.keyVault.location, 'westeurope');
  assert.match(String(config.keyVault.name), /^consumption-central-[0-9a-f]{4}$/);
  assert.equal(config.keyVault.existing, false);
  assert.equal(config.keyVault.rbac, true);

  const app = fakeUi();
  const withApp = newInstall({ ui: app.ui, arm: vaultArm() });
  withApp.config.dataSources.orgData = 'api';
  await planKeyVault(withApp.ctx, pre, 'westeurope');
  assert.equal(app.asked.at(-1), 'Secret name', 'the notebooks sign in as the app');
});
