// @ts-check
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { notebooksFor } from '../src/catalog.js';
import { statusConfigJson } from '../src/loads.js';
import { GITHUB_PAT_SECRET, SECRET_NAME } from '../src/product.js';
import {
  AZURE_AI_SECRET_FIND,
  costType,
  githubTokenSecret,
  notebookSettings,
  PAYG_FIND,
  paygPatch,
  rateWindow,
  routerSignature,
  routerValues,
  SECRET_PLACEHOLDER,
  TOKEN_PLACEHOLDER,
} from '../src/steps/notebook-settings.js';
import { cellText, INLINE_SECRET_NOTE, MARKER, prepareNotebook } from '../src/transform/notebook.js';
import { DATA_SOURCES, defaultDataSources, routedSources, routerSignaturesJson, SHAREPOINT_SUBDIR, UPLOAD_DIR, UPLOAD_LOG_TABLE } from '../src/uploads.js';
import { fakeCtx, realSources } from './fakes.js';

/** @typedef {import('../src/uploads.js').DataSourceModes} DataSourceModes */
/** @typedef {import('../src/catalog.js').NotebookInfo} NotebookInfo */
/** @typedef {import('../src/config.js').SecretMode} SecretMode */
/** @typedef {import('../src/transform/notebook.js').NotebookSettings} NotebookSettings */

const VAULT = 'https://kv-consumption-test.vault.azure.net/';
const SECRET = 'contoso-client-secret';
const TOKEN = 'ghp_contoso';
const SECRET_MODES = /** @type {SecretMode[]} */ (['keyvault', 'keyvault-admin', 'notebook']);
const { catalog, notebooks } = realSources();
/** @type {DataSourceModes} */
const EVERY_API = { ...defaultDataSources(), coworkCredits: 'api', studioCredits: 'api', github: 'api', azureAi: 'api', orgData: 'api', commercialTerms: 'api' };

/** @param {string} key */
const info = (key) => /** @type {NotebookInfo} */ (catalog.find((n) => n.key === key));

/**
 * Every combination of modes the Data sources screen allows.
 * @param {number} [i]
 * @param {Record<string, string>} [acc]
 * @returns {Generator<DataSourceModes>}
 */
function* everyChoice(i = 0, acc = {}) {
  if (i === DATA_SOURCES.length) {
    yield /** @type {DataSourceModes} */ ({ ...acc });
    return;
  }
  for (const mode of DATA_SOURCES[i].modes) yield* everyChoice(i + 1, { ...acc, [DATA_SOURCES[i].id]: mode });
}
const CHOICES = [...everyChoice()];

/**
 * An install with everything a notebook reads filled in, so any of them can be prepared.
 * @param {{ ds?: Partial<DataSourceModes>, mode?: SecretMode, payg?: boolean }} [o]
 */
function install(o = {}) {
  const t = fakeCtx();
  const { config } = t;
  config.dataSources = { ...EVERY_API, ...o.ds };
  config.keyVault.uri = VAULT;
  if (o.mode) config.keyVault.mode = o.mode;
  config.consumption.azureSubscriptionId = 'sub-1';
  config.consumption.paygSubscriptions = o.payg
    ? [
        { subscriptionId: 'sub-2', name: 'Contoso pay-as-you-go', policies: ['Contoso policy'], access: true },
        { subscriptionId: 'sub-3', policies: ['Unreadable policy'] },
      ]
    : [];
  config.github = { enterprise: 'contoso' };
  config.commercialTerms = { scope: '/providers/Microsoft.Billing/billingAccounts/contoso' };
  config.semanticModel.id = 'model-1';
  config.fabric.lakehouseName = 'ConsumptionCentral';
  t.ctx.pendingSecret = SECRET;
  t.ctx.pendingGithubToken = { value: TOKEN };
  return t;
}

/** @param {string} key @param {NotebookSettings} settings */
const prepared = (key, settings) => prepareNotebook(notebooks[/** @type {import('../src/catalog.js').NotebookKey} */ (key)], settings).cells.map(cellText).join('\n');

/** What the installer writes into the helpers that ship with it, which installer-assets.json doesn't list. */
const ASSET_VALUES = {
  uploadRouter: ['DROP_DIR', 'SHAREPOINT_DIR', 'LOG_TABLE', 'ENABLED_SOURCES', 'SIGNATURES_JSON'],
  refreshModel: ['WORKSPACE_ID', 'SEMANTIC_MODEL_ID'],
  loadStatus: ['STATUS_JSON'],
};

test('every name notebookSettings writes is one installer-assets.json lists, for every choice, and each fits the real notebook', () => {
  /** @type {Map<string, Set<string>>} */
  const written = new Map(catalog.map((nb) => [nb.key, new Set()]));
  /** @type {Map<string, { key: string, settings: NotebookSettings }>} */
  const distinct = new Map();
  for (const mode of SECRET_MODES) {
    for (const payg of [false, true]) {
      const { ctx, config } = install({ mode, payg });
      for (const choice of CHOICES) {
        config.dataSources = choice;
        for (const nb of notebooksFor(catalog, choice, { semanticModel: true })) {
          const s = notebookSettings(ctx, nb);
          const label = `${nb.key}, ${mode}${payg ? ', pay-as-you-go' : ''}, ${JSON.stringify(choice)}`;
          const names = {
            values: Object.keys(s.values ?? {}),
            expressions: [...Object.keys(s.expressions ?? {}), ...Object.keys(s.secrets ?? {})],
            patches: (s.patches ?? []).map((p) => p.find),
          };
          if (nb.asset) {
            assert.deepEqual(names, { values: ASSET_VALUES[/** @type {keyof ASSET_VALUES} */ (nb.key)], expressions: Object.keys(nb.expressions ?? {}), patches: [] }, label);
          } else {
            for (const name of names.values) assert.ok(nb.values.includes(name), `${label}: value ${name}`);
            for (const name of names.expressions) assert.ok(nb.expressionNames.includes(name), `${label}: expression ${name}`);
            for (const find of names.patches) assert.ok(nb.patchFinds.includes(find), `${label}: patch ${find}`);
            for (const name of [...names.values, ...names.expressions, ...names.patches]) written.get(nb.key)?.add(name);
          }
          // Credentials only where installer-assets.json says so; Ingest_Studio only for the licensing API.
          const credentials = nb.credentials && (nb.key !== 'studioConsumption' || choice.studioCredits === 'api');
          assert.deepEqual(
            { tenantId: s.tenantId, clientId: s.clientId, secret: s.secret },
            credentials
              ? { tenantId: 'tenant-1', clientId: 'app-1', secret: mode === 'notebook' ? { value: SECRET } : { vaultUri: VAULT, secretName: SECRET_NAME } }
              : { tenantId: undefined, clientId: undefined, secret: undefined },
            label,
          );
          assert.deepEqual(s.parameters, nb.parameters, label);
          assert.deepEqual(s.lakehouse, { id: 'lh-1', name: 'ConsumptionCentral', workspaceId: 'ws-1' }, label);
          distinct.set(`${nb.key} ${JSON.stringify(s)}`, { key: nb.key, settings: s });
        }
      }
    }
  }
  // And every name installer-assets.json lists is written for some choice: none has gone stale.
  for (const nb of catalog.filter((n) => !n.asset)) {
    assert.deepEqual([...(written.get(nb.key) ?? [])].sort(), [...nb.values, ...nb.expressionNames, ...nb.patchFinds].sort(), nb.key);
  }
  for (const { key, settings } of distinct.values()) {
    assert.doesNotThrow(() => prepared(key, settings), `${key}: ${JSON.stringify(settings).slice(0, 300)}`);
  }
  assert.deepEqual(new Set([...distinct.values()].map((d) => d.key)), new Set(catalog.map((nb) => nb.key)));
});

test('the helpers get their folders, model and status labels; the pipeline passes their parameters', () => {
  const { ctx, config } = install();
  const router = notebookSettings(ctx, info('uploadRouter'));
  assert.deepEqual(router.values, routerValues(config));
  const refresh = notebookSettings(ctx, info('refreshModel'));
  assert.deepEqual(refresh.values, { WORKSPACE_ID: 'ws-1', SEMANTIC_MODEL_ID: 'model-1' });
  assert.deepEqual(refresh.parameters, ['WORKSPACE_ID', 'SEMANTIC_MODEL_ID', 'TIMEOUT_MINUTES']);
  const status = notebookSettings(ctx, info('loadStatus'));
  assert.deepEqual(status.values, { STATUS_JSON: statusConfigJson() });
  assert.deepEqual(status.parameters, ['PIPELINE_RUN_ID', 'PIPELINE_TRIGGER_TIME']);
  for (const s of [router, refresh, status]) {
    assert.deepEqual([s.tenantId, s.clientId, s.secret, s.expressions, s.secrets, s.patches], [undefined, undefined, undefined, undefined, undefined, undefined]);
  }
  // The dashboard's notebooks take no parameters: a pipeline run passes them none.
  for (const nb of catalog.filter((n) => !n.asset)) assert.deepEqual(notebookSettings(ctx, nb).parameters, [], nb.key);
});

test('the client secret: read from Key Vault, or with no Key Vault written in, and a placeholder in the hashed copy', () => {
  for (const key of ['studioConsumption', 'orgGraph']) {
    const kv = install({ mode: 'keyvault' });
    const text = prepared(key, notebookSettings(kv.ctx, info(key)));
    assert.match(text, /^TENANT_ID\s*= 'tenant-1'/m, key);
    assert.match(text, /^CLIENT_ID\s*= 'app-1'/m, key);
    assert.ok(text.includes(`= notebookutils.credentials.getSecret('${VAULT}', '${SECRET_NAME}')  # ${MARKER}: read from Azure Key Vault at run time`), key);
    assert.ok(!text.includes(SECRET), key);

    const inline = install({ mode: 'notebook' });
    assert.ok(prepared(key, notebookSettings(inline.ctx, info(key))).includes(`= '${SECRET}'  # ${INLINE_SECRET_NOTE}`), key);
    assert.deepEqual(notebookSettings(inline.ctx, info(key), { placeholder: true }).secret, { value: SECRET_PLACEHOLDER }, key);
    inline.ctx.pendingSecret = undefined;
    assert.deepEqual(notebookSettings(inline.ctx, info(key)).secret, { value: SECRET_PLACEHOLDER }, `${key}: no secret to hand`);
  }
  // With CSV exports Ingest_Studio's placeholders stay, so it skips the user lookup.
  const csv = install({ ds: { studioCredits: 'csv' } });
  const studio = notebookSettings(csv.ctx, info('studioConsumption'));
  assert.deepEqual([studio.tenantId, studio.secret, studio.expressions], [undefined, undefined, undefined]);
  assert.deepEqual(notebookSettings(install().ctx, info('studioConsumption')).expressions, { READ_API_FILES: 'True' });

  // Ingest_Azure_AI has its own settings rather than the credentials.
  const kv = install();
  const azure = notebookSettings(kv.ctx, info('azureAi'));
  assert.equal(azure.secret, undefined);
  assert.deepEqual(azure.values, { SUBSCRIPTION_ID: 'sub-1', TENANT_ID: 'tenant-1', CLIENT_ID: 'app-1', KEY_VAULT_URL: VAULT, CLIENT_SECRET_NAME: SECRET_NAME });
  assert.equal(azure.patches, undefined);
  const inline = install({ mode: 'notebook' });
  const azureInline = notebookSettings(inline.ctx, info('azureAi'));
  assert.deepEqual(azureInline.values, { SUBSCRIPTION_ID: 'sub-1', TENANT_ID: 'tenant-1', CLIENT_ID: 'app-1', KEY_VAULT_URL: '', CLIENT_SECRET_NAME: '' });
  assert.deepEqual(azureInline.patches, [{ find: AZURE_AI_SECRET_FIND, replace: `secret = '${SECRET}'  # ${INLINE_SECRET_NOTE}` }]);
  assert.deepEqual(notebookSettings(inline.ctx, info('azureAi'), { placeholder: true }).patches, [
    { find: AZURE_AI_SECRET_FIND, replace: `secret = '${SECRET_PLACEHOLDER}'  # ${INLINE_SECRET_NOTE}` },
  ]);
});

test('githubTokenSecret: the Key Vault read, or with no Key Vault the token itself', () => {
  assert.equal(GITHUB_PAT_SECRET, 'consumption-central-github-pat');
  for (const mode of /** @type {SecretMode[]} */ (['keyvault', 'keyvault-admin'])) {
    const { ctx, config } = install({ mode });
    assert.deepEqual(githubTokenSecret(ctx), { vaultUri: VAULT, secretName: GITHUB_PAT_SECRET }, mode);
    assert.deepEqual(githubTokenSecret(ctx, { placeholder: true }), { vaultUri: VAULT, secretName: GITHUB_PAT_SECRET }, mode);
    // A shared vault already had that name, so the token went in under another.
    config.github = { enterprise: 'contoso', secretName: `${GITHUB_PAT_SECRET}-2` };
    assert.deepEqual(githubTokenSecret(ctx), { vaultUri: VAULT, secretName: `${GITHUB_PAT_SECRET}-2` }, mode);
  }
  const { ctx } = install({ mode: 'notebook' });
  assert.deepEqual(githubTokenSecret(ctx), { value: TOKEN });
  assert.deepEqual(githubTokenSecret(ctx, { placeholder: true }), { value: TOKEN_PLACEHOLDER }, 'the copy whose hash is recorded');
  ctx.pendingGithubToken = undefined;
  assert.deepEqual(githubTokenSecret(ctx), { value: TOKEN_PLACEHOLDER }, 'the token is never saved, so a rewrite without it has the placeholder');

  // Ingest_GitHub_API's TOKEN, as deployed.
  const kv = install();
  const settings = notebookSettings(kv.ctx, info('githubApi'));
  assert.deepEqual(settings.values, { ENTERPRISE: 'contoso' });
  assert.deepEqual(settings.secrets, { TOKEN: githubTokenSecret(kv.ctx) });
  const text = prepared('githubApi', settings);
  assert.ok(text.includes(`\nTOKEN = notebookutils.credentials.getSecret('${VAULT}', '${GITHUB_PAT_SECRET}')  # ${MARKER}: read from Azure Key Vault at run time`));
  assert.ok(!text.includes(TOKEN));
  const inline = install({ mode: 'notebook' });
  assert.ok(prepared('githubApi', notebookSettings(inline.ctx, info('githubApi'))).includes(`\nTOKEN = '${TOKEN}'  # ${INLINE_SECRET_NOTE}`));
});

test('routerValues: the drop folder, the log table, and the signatures of the sources that take a CSV', () => {
  const { config } = install();
  config.dataSources = defaultDataSources();
  assert.deepEqual(routerValues(config), {
    DROP_DIR: 'Files/consumption_central_uploads',
    SHAREPOINT_DIR: 'Files/consumption_central_uploads/sharepoint',
    LOG_TABLE: 'dbo.consumption_central_upload_log',
    ENABLED_SOURCES: 'studioCredits,coworkCredits',
    SIGNATURES_JSON: routerSignaturesJson(config.dataSources),
  });
  assert.deepEqual([UPLOAD_DIR, SHAREPOINT_SUBDIR, UPLOAD_LOG_TABLE], [routerValues(config).DROP_DIR, routerValues(config).SHAREPOINT_DIR, routerValues(config).LOG_TABLE]);
  /** @param {Partial<DataSourceModes>} over */
  const kinds = (over) => {
    config.dataSources = { ...defaultDataSources(), ...over };
    return JSON.parse(routerValues(config).SIGNATURES_JSON).map((/** @type {any} */ k) => k.kind);
  };
  assert.deepEqual(kinds({}), ['studioTenant', 'studioAgent', 'studioUser', 'studioAgentDaily', 'studioUserDaily', 'studioEntitlement', 'vivaCredits', 'vivaPolicy']);
  // The Studio flow and the Viva Dataflow still take exports; GitHub and org data from their APIs don't.
  config.dataSources = { ...EVERY_API };
  assert.equal(routerValues(config).ENABLED_SOURCES, 'studioCredits,coworkCredits');
  config.dataSources = { ...EVERY_API, coworkTasks: 'csv', github: 'csv', orgData: 'csv' };
  assert.equal(routerValues(config).ENABLED_SOURCES, 'studioCredits,coworkCredits,coworkTasks,github,orgData');
  assert.deepEqual(kinds({ coworkCredits: 'skip', studioCredits: 'skip', coworkTasks: 'csv' }), ['coworkTasks', 'coworkPeople']);
  assert.deepEqual(kinds({ coworkCredits: 'skip', studioCredits: 'skip', github: 'csv', orgData: 'csv' }), ['githubUsage', 'githubMap', 'orgFile']);

  // The asset ships the same defaults for a manual import, taking every source.
  const shipped = notebooks.uploadRouter.cells.map(cellText).join('\n');
  /** @param {string} name */
  const pyValue = (name) => new RegExp(`^${name}\\s*=\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'm').exec(shipped)?.[1].replace(/\\(.)/g, '$1');
  assert.deepEqual(
    ['DROP_DIR', 'SHAREPOINT_DIR', 'LOG_TABLE', 'ENABLED_SOURCES', 'SIGNATURES_JSON'].map(pyValue),
    [UPLOAD_DIR, SHAREPOINT_SUBDIR, UPLOAD_LOG_TABLE, '', routerSignaturesJson()],
  );
});

test('routerSignature changes with the sources the router takes, and with nothing else', () => {
  const { config } = install();
  /** @type {Map<string, string>} */
  const byRouted = new Map();
  for (const choice of CHOICES) {
    config.dataSources = choice;
    const sig = routerSignature(config);
    assert.equal(sig, createHash('sha256').update(routerSignaturesJson(choice)).digest('hex').slice(0, 16));
    assert.match(sig, /^[0-9a-f]{16}$/);
    const routed = routedSources(choice).join(',');
    if (byRouted.has(routed)) assert.equal(sig, byRouted.get(routed), `${routed}: ${JSON.stringify(choice)}`);
    else byRouted.set(routed, sig);
  }
  assert.equal(byRouted.size, 32, 'each of the five uploadable sources on or off');
  assert.equal(new Set(byRouted.values()).size, byRouted.size, 'each set of routed sources has its own signature');
  /** @param {Partial<DataSourceModes>} over */
  const sig = (over) => {
    config.dataSources = { ...defaultDataSources(), ...over };
    return routerSignature(config);
  };
  assert.equal(sig({ studioCredits: 'api' }), sig({ studioCredits: 'csv' }), 'the Studio flow still takes exports');
  assert.equal(sig({ github: 'api', orgData: 'api', azureAi: 'api' }), sig({}));
  assert.notEqual(sig({ github: 'csv' }), sig({}));
  assert.notEqual(sig({ coworkTasks: 'csv' }), sig({}));
});

test('paygPatch: the pay-as-you-go subscriptions the app can read, each with its name', () => {
  assert.equal(PAYG_FIND, 'PAYG_SUBSCRIPTION_IDS = []');
  assert.deepEqual(info('azureAi').patchFinds, [PAYG_FIND, AZURE_AI_SECRET_FIND], 'the finds installer-assets.json lists');
  assert.deepEqual(
    paygPatch([
      { subscriptionId: 'sub-2', name: 'Contoso\r\npay-as-you-go', policies: ['Contoso policy'] },
      { subscriptionId: "sub-'3", policies: [] },
    ]),
    { find: PAYG_FIND, replace: `PAYG_SUBSCRIPTION_IDS = [  # ${MARKER}\n    'sub-2',  # Contoso pay-as-you-go\n    'sub-\\'3',\n]` },
  );
  // Only the subscriptions the app has Cost Management Reader on.
  const { ctx } = install({ payg: true });
  const settings = notebookSettings(ctx, info('azureAi'));
  assert.deepEqual(settings.patches, [paygPatch([/** @type {any} */ (ctx.config.consumption.paygSubscriptions)[0]])]);
  const text = prepared('azureAi', settings);
  assert.ok(text.includes(`PAYG_SUBSCRIPTION_IDS = [  # ${MARKER}\n    'sub-2',  # Contoso pay-as-you-go\n]`));
  assert.ok(!text.includes('sub-3'));
  // None readable: the list stays as it ships.
  assert.ok(prepared('azureAi', notebookSettings(install().ctx, info('azureAi'))).includes(`\n${PAYG_FIND}`));
});

test('Commercial terms reads one closed month at the scope, as ActualCost unless a prepaid balance is set', () => {
  assert.deepEqual(rateWindow(new Date('2026-06-01T12:00:00Z')), { from: '2026-04-01', to: '2026-04-30' }, 'May is still closing');
  assert.deepEqual(rateWindow(new Date('2026-06-04T23:59:59Z')), { from: '2026-04-01', to: '2026-04-30' });
  assert.deepEqual(rateWindow(new Date('2026-06-05T00:00:00Z')), { from: '2026-05-01', to: '2026-05-31' });
  assert.deepEqual(rateWindow(new Date('2026-01-03T00:00:00Z')), { from: '2025-11-01', to: '2025-11-30' });
  assert.deepEqual(rateWindow(new Date('2024-03-10T00:00:00Z')), { from: '2024-02-01', to: '2024-02-29' });

  const { ctx, config } = install();
  assert.equal(costType(config), 'ActualCost');
  const settings = notebookSettings(ctx, info('commercialTerms'));
  assert.deepEqual(settings.values, { SCOPE: '/providers/Microsoft.Billing/billingAccounts/contoso', FROM_DATE: '2026-04-01', TO_DATE: '2026-04-30', COST_TYPE: 'ActualCost' });
  // The prices are the model's parameters, so the table carries only the derived rate.
  assert.deepEqual(settings.expressions, { PREPAID_CREDIT_RATE: 'None', PREPAID_CREDIT_BALANCE: 'None', GITHUB_BUSINESS_SEAT: 'None', GITHUB_ENTERPRISE_SEAT: 'None' });
  // Prepaid credits show as $0 in ActualCost, which would make the rate near zero.
  config.prices = /** @type {any} */ ({ prepaidCreditBalance: 0 });
  assert.equal(costType(config), 'ActualCost');
  config.prices = /** @type {any} */ ({ prepaidCreditBalance: 25000 });
  assert.equal(notebookSettings(ctx, info('commercialTerms')).values?.COST_TYPE, 'AmortizedCost');
});
