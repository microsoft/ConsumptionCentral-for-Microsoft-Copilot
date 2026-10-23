// @ts-check
/**
 * Commands that each change one thing on an install, run as the CLI runs them: check, rotate-secret
 * and github-token. And preview, which writes what would be deployed and changes nothing.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { emptyConfig } from '../src/config.js';
import { HttpError } from '../src/http.js';
import { preview, runCommand } from '../src/install.js';
import { commandLine } from '../src/launch.js';
import { ENV } from '../src/product.js';
import { ensureNotebooks } from '../src/steps/fabric.js';
import { FLOW_FILES } from '../src/steps/flows.js';
import { isResumeLater } from '../src/steps/identity.js';
import { MODEL_PROBE } from '../src/steps/model.js';
import { checkData, DATA_CHECK_FILE } from '../src/steps/run.js';
import { fakeCtx, fakeFabric, fakeGraph, fakePowerBi, fakeUi, realSources } from './fakes.js';

/** Graph calls without the per-run ref in a new secret's name. @param {string[]} calls */
const unref = (calls) => calls.map((c) => c.replace(/ \(ref [0-9a-f]{12}\)$/, ''));

/** What a UI printed, without colour. @param {{ text: () => string }} u */
const plain = (u) => u.text().replace(/\u001b\[[0-9;]*m/g, '');

/** @param {string[]} l */
const lines = (...l) => l.map((s) => `${s}\n`).join('');

const NOTHING_INSTALLED = 'Nothing is installed yet. Run the installer first.';
const VAULT_ID = '/subscriptions/sub-1/resourceGroups/rg-consumption-central/providers/Microsoft.KeyVault/vaults/kv-test';
const NOTEBOOK_MODE = { secretName: 'consumption-central-client-secret', mode: /** @type {const} */ ('notebook') };

/**
 * Sources that sign in as the app, so the install keeps its client secret. With no Key Vault,
 * Ingest_Studio and Ingest_Org_Graph hold it.
 * @template {{ config: import('../src/config.js').InstallConfig }} T
 * @param {T} t
 */
const withAppSources = (t) => {
  Object.assign(t.config.dataSources, { studioCredits: 'api', orgData: 'api' });
  return t;
};

/**
 * A deployed model whose connection signs in as the app, with a secret of its own.
 * @template {{ config: import('../src/config.js').InstallConfig }} T
 * @param {T} t
 * @param {ReturnType<typeof fakeFabric>} [fabric]  Gets the connection too.
 */
function withConnection(t, fabric) {
  Object.assign(t.config.semanticModel, {
    enabled: true,
    id: 'sm-1',
    bound: true,
    connectionId: 'connection-1',
    connectionName: 'Consumption Central SQL ws-1',
    secretKeyId: 'key-connection-0',
    secretExpires: '2026-07-01T00:00:00.000Z',
  });
  fabric?.connections.push({ id: 'connection-1', displayName: 'Consumption Central SQL ws-1' });
  return t;
}

/**
 * An install using an existing vault the user can't write to, with a vault admin adding secrets.
 * @param {Parameters<typeof fakeCtx>[0]} [o]
 */
function adminCtx(o) {
  const made = fakeCtx(o);
  Object.assign(made.config.keyVault, { existing: true, id: VAULT_ID, name: 'kv-test', mode: 'keyvault-admin', rbac: true, uri: 'https://kv-test.vault.azure.net/' });
  return made;
}

/** Key Vault secrets held in memory, by name. */
function fakeKeyVault() {
  /** @type {string[]} */
  const calls = [];
  /** @type {Record<string, any>} */
  const secrets = {};
  const api = {
    /** @param {string} _uri @param {string} name */
    waitForAccess: async (_uri, name) => {
      calls.push(`waitForAccess ${name}`);
    },
    /** @param {string} _uri @param {string} name @param {string} value @param {{ expires?: Date, contentType?: string }} [o] */
    setSecret: async (_uri, name, value, o = {}) => {
      calls.push(`setSecret ${name}`);
      secrets[name] = { value, ...o };
    },
    /** @param {string} _uri @param {string} name */
    secretExists: async (_uri, name) => name in secrets,
    /** @param {string} _uri @param {string} name */
    secretInfo: async (_uri, name) => {
      calls.push(`secretInfo ${name}`);
      return name in secrets ? { contentType: secrets[name].contentType } : null;
    },
  };
  return { api, calls, secrets };
}

/** GitHub taking any token, and saying it expires on 1 September 2026. */
function fakeGithub() {
  /** @type {string[]} The tokens the installer asked GitHub about. */
  const tokens = [];
  /** @type {string[]} */
  const calls = [];
  const answer = { status: 200, body: {}, headers: new Headers({ 'github-authentication-token-expiration': '2026-09-01 12:00:00 UTC' }) };
  /** @param {string} token */
  const api = (token) => {
    tokens.push(token);
    return {
      /** @param {string} enterprise */
      copilotSeats: async (enterprise) => {
        calls.push(`copilotSeats ${enterprise}`);
        return answer;
      },
      /** @param {string} enterprise */
      aiCreditUsage: async (enterprise) => {
        calls.push(`aiCreditUsage ${enterprise}`);
        return answer;
      },
    };
  };
  return { api: /** @type {any} */ (api), tokens, calls };
}

/**
 * Runs fn with an environment variable set, or unset, as the CLI would see it.
 * @template T
 * @param {string} name
 * @param {string | undefined} value
 * @param {() => Promise<T>} fn
 */
async function withEnv(name, value, fn) {
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
}

/** An install that reads GitHub from the API, for enterprise contoso. @param {Partial<NonNullable<import('../src/config.js').InstallConfig['github']>>} [github] */
const readsGithub = (/** @type {{ config: import('../src/config.js').InstallConfig }} */ t, github = {}) => {
  t.config.dataSources.github = 'api';
  t.config.github = { enterprise: 'contoso', ...github };
};

// check

/** What Power BI gives for a DAX query that returns one row. @param {Record<string, unknown>} row */
const answer = (row) => ({ results: [{ tables: [{ rows: [row] }] }] });

/** Power BI turning down a DAX query. @param {string} detail */
const daxError = (detail) =>
  new HttpError('Bad Request', {
    status: 400,
    method: 'POST',
    url: 'https://api.powerbi.com/v1.0/myorg/groups/ws-1/datasets/sm-1/executeQueries',
    body: { error: { 'pbi.error': { details: [{ code: 'DetailsMessage', detail: { type: 1, value: detail } }] } } },
  });

/** The model's answer to the count, for the default sources: Cowork credits loaded, Studio credits not yet. */
const COUNTED = {
  '[coworkCredits]': 1200,
  '[coworkCreditsFrom]': '2026-03-02T00:00:00',
  '[coworkCreditsTo]': '2026-05-25T00:00:00',
  '[studioCredits]': 0,
  '[studioCreditsFrom]': null,
  '[studioCreditsTo]': null,
};

/** A deployed model over the default sources, a Power BI that records each DAX query, and a Lakehouse. */
function deployedModel() {
  const u = fakeUi();
  const pbi = fakePowerBi();
  /** @type {Map<string, string>} */
  const files = new Map();
  const oneLake = {
    /** @param {string} ws @param {string} lh @param {string} path @param {Uint8Array} data */
    writeFile: async (ws, lh, path, data) => {
      files.set(`${ws}/${lh}/${path}`, new TextDecoder().decode(data));
    },
  };
  /** @type {string[]} */
  const queries = [];
  const execute = pbi.api.executeQueries;
  pbi.api.executeQueries = async (ws, id, query) => {
    queries.push(query);
    return execute(ws, id, query);
  };
  const t = fakeCtx({ ui: u.ui, powerBi: pbi.api, oneLake });
  Object.assign(t.config.semanticModel, { enabled: true, id: 'sm-1', bound: true });
  return { ...t, u, pbi, files, queries };
}

/**
 * Runs `check` as the CLI does, and checkData itself, on two copies of the same install, and checks
 * both did exactly the same. Returns the CLI's copy.
 * @param {(m: ReturnType<typeof deployedModel>) => void} arrange
 * @param {boolean} ok  What both return.
 */
async function checkBothWays(arrange, ok) {
  const cli = deployedModel();
  const direct = deployedModel();
  arrange(cli);
  arrange(direct);
  assert.equal(await runCommand(cli.ctx, 'check', { wait: true }), ok);
  assert.equal(await checkData(direct.ctx), ok);
  assert.deepEqual(cli.queries, direct.queries);
  assert.deepEqual(cli.pbi.calls, direct.pbi.calls);
  assert.equal(cli.u.text(), direct.u.text());
  assert.deepEqual([...cli.files], [...direct.files]);
  assert.deepEqual(cli.config, direct.config);
  return cli;
}

test('check: runCommand runs checkData, which probes the model, counts each chosen source and keeps the result for status', async () => {
  const m = await checkBothWays((x) => x.pbi.answers.push(answer({ '[CalendarDays]': 1096 }), answer(COUNTED)), true);
  assert.equal(m.queries.length, 2);
  assert.equal(m.queries[0], MODEL_PROBE);
  assert.match(m.queries[1], /COUNTROWS\('CreditsWeekly'\)/);
  assert.match(m.queries[1], /COUNTROWS\('Credit Consumption \(Tenant\)'\)/);
  assert.doesNotMatch(m.queries[1], /GitHub Usage|AzureAiSpend|'Org'|Cowork Tasks/, 'only the chosen sources are counted');
  assert.equal(
    m.u.text(),
    lines(
      '  ✓ Consumption Central Model answers queries (its Date table has 1,096 days)',
      '  ✓ Copilot Cowork and Work IQ credits: 1,200 rows in the model, 2026-03-02 to 2026-05-25',
      '  ! Copilot Studio credits: no rows in the model yet',
      `    Upload its export with "${commandLine('upload <file> --run')}".`,
    ),
  );
  const file = `ws-1/lh-1/${DATA_CHECK_FILE}`;
  assert.deepEqual([...m.files.keys()], [file]);
  assert.deepEqual(JSON.parse(/** @type {string} */ (m.files.get(file))), {
    checkedAt: '2026-06-01T12:00:00.000Z',
    tables: {
      coworkCredits: { table: 'CreditsWeekly', rows: 1200, from: '2026-03-02', to: '2026-05-25' },
      studioCredits: { table: 'Credit Consumption (Tenant)', rows: 0, from: null, to: null },
    },
  });
});

test('check: a model with an empty Date table fails the check before anything is counted', async () => {
  const m = await checkBothWays((x) => x.pbi.answers.push(answer({ '[CalendarDays]': 0 })), false);
  assert.deepEqual(m.queries, [MODEL_PROBE]);
  assert.equal(
    m.u.text(),
    lines(
      '  ✗ Consumption Central Model refreshed, but its Date table is empty, so report pages will fail',
      `    Run the installer again from the latest release to redeploy and refresh the model, or run "${commandLine('update')}".`,
    ),
  );
  assert.equal(m.files.size, 0);
});

test('check: a count Power BI turns down fails the check, says why and how to run it again, and keeps nothing', async () => {
  const m = await checkBothWays((x) => {
    x.pbi.answers.push(answer({ '[CalendarDays]': 1096 }));
    x.pbi.failures.executeQueries = /** @type {Error[]} */ ([undefined, daxError("Query (2, 23) Cannot find table 'CreditsWeekly'.")]);
  }, false);
  assert.equal(m.queries.length, 2);
  assert.equal(
    m.u.text(),
    lines(
      '  ✓ Consumption Central Model answers queries (its Date table has 1,096 days)',
      '  ✗ Data check: the query on Consumption Central Model failed',
      "    Query (2, 23) Cannot find table 'CreditsWeekly'.",
      `    Run "${commandLine('check')}" to try it again.`,
    ),
  );
  assert.equal(m.files.size, 0);
});

test('check: with no semantic model deployed the command fails, saying so, and asks Power BI nothing', async () => {
  /** @type {[string, Partial<import('../src/config.js').SemanticModelConfig>][]} */
  const states = [
    ['a fresh install', {}],
    ['switched on but not made yet', { enabled: true }],
    ['made but not connected to the Lakehouse', { enabled: true, id: 'sm-1' }],
    ['switched off', { enabled: false, id: 'sm-1', bound: true }],
  ];
  for (const [state, model] of states) {
    const m = deployedModel();
    m.config.semanticModel = { name: 'Consumption Central Model', ...model };
    await assert.rejects(runCommand(m.ctx, 'check', { wait: true }), { message: 'There is no semantic model yet. Run the installer first.' }, state);
    assert.deepEqual(m.pbi.calls, [], state);
    assert.equal(m.u.text(), '', state);
    assert.equal(m.files.size, 0, state);
  }
});

// rotate-secret

/** What the connection was given. @param {ReturnType<typeof fakeFabric>} fabric @param {string} secret */
const connectionBody = (fabric, secret) => {
  assert.deepEqual(fabric.connections[0].body, {
    connectivityType: 'ShareableCloud',
    credentialDetails: {
      singleSignOnType: 'None',
      connectionEncryption: 'Encrypted',
      skipTestConnection: false,
      credentials: { credentialType: 'ServicePrincipal', tenantId: 'tenant-1', servicePrincipalClientId: 'app-1', servicePrincipalSecret: secret },
    },
  });
};

const ONLY_CONNECTION = lines(
  '\nNew client secret',
  '    App: app-1',
  '    Connection: Consumption Central SQL ws-1, used by Consumption Central Model',
  "    No notebook reads the app's secret, so only the connection's is replaced. The old one is removed from the app.",
  '  ✓ Gave "Consumption Central SQL ws-1" a new secret (expires 2027-06-01)',
  "  ✓ Removed the connection's old secret from the app",
);

test("rotate-secret: with no notebook reading the app's secret, only the model connection's is replaced", async () => {
  const fabric = fakeFabric();
  const graph = fakeGraph();
  const kv = fakeKeyVault();
  const u = fakeUi({ answers: [true] });
  const t = withConnection(fakeCtx({ ui: u.ui, fabric: fabric.api, graph: graph.api, keyVault: kv.api }), fabric);
  const app = structuredClone(t.config.app);
  const vault = structuredClone(t.config.keyVault);

  assert.equal(await runCommand(t.ctx, 'rotate-secret', { wait: true }), true);
  assert.deepEqual(u.asked, ["Create a new secret and replace the connection's?"]);
  assert.deepEqual(unref(graph.calls), ['addPassword Consumption Central semantic model connection', 'removePassword key-connection-0']);
  assert.deepEqual(fabric.calls, ['updateConnection connection-1']);
  connectionBody(fabric, 'secret-1');
  const sm = t.config.semanticModel;
  assert.equal(sm.secretKeyId, 'key-1');
  assert.equal(sm.secretExpires, '2027-06-01T12:00:00.000Z');
  assert.equal(sm.pendingSecretKeyIds, undefined);
  assert.equal(sm.retiredSecretKeyIds, undefined);
  assert.deepEqual(t.config.app, app, "the app's own secret is left alone");
  assert.deepEqual(t.config.keyVault, vault);
  assert.deepEqual(kv.calls, [], 'Key Vault is not touched');
  assert.equal(u.text(), ONLY_CONNECTION);
});

test('rotate-secret: with the secret kept in the notebooks but none reading it, the notebooks stay as they are', async () => {
  const fabric = fakeFabric();
  const graph = fakeGraph();
  const t = withConnection(fakeCtx({ fabric: fabric.api, graph: graph.api }), fabric);
  t.config.keyVault = { ...NOTEBOOK_MODE };
  await ensureNotebooks(t.ctx);
  assert.deepEqual(graph.calls, [], 'the default sources put no secret in the notebooks');
  const contents = fabric.items.map((i) => [i.displayName, i.content]);
  fabric.calls.length = 0;

  const u = fakeUi({ answers: [true] });
  t.ctx.ui = u.ui;
  assert.equal(await runCommand(t.ctx, 'rotate-secret', { wait: true }), true);
  assert.deepEqual(fabric.calls, ['updateConnection connection-1']);
  assert.deepEqual(fabric.items.map((i) => [i.displayName, i.content]), contents);
  assert.deepEqual(unref(graph.calls), ['addPassword Consumption Central semantic model connection', 'removePassword key-connection-0']);
  connectionBody(fabric, 'secret-1');
  assert.equal(t.config.app.secretKeyId, undefined);
  assert.equal(u.text(), ONLY_CONNECTION);
});

test('rotate-secret: saying no changes nothing', async () => {
  for (const appSources of [false, true]) {
    const fabric = fakeFabric();
    const graph = fakeGraph();
    const kv = fakeKeyVault();
    const u = fakeUi({ answers: [false] });
    const t = withConnection(fakeCtx({ ui: u.ui, fabric: fabric.api, graph: graph.api, keyVault: kv.api }), fabric);
    if (appSources) withAppSources(t);
    const before = structuredClone(t.config);
    assert.equal(await runCommand(t.ctx, 'rotate-secret', { wait: true }), true);
    assert.equal(u.asked.length, 1);
    assert.deepEqual([graph.calls, fabric.calls, kv.calls], [[], [], []]);
    assert.deepEqual(t.config, before);
    assert.doesNotMatch(u.text(), /✓/);
  }
});

test('rotate-secret: an install with no app, or nothing that holds its secret yet, is turned down', async () => {
  const graph = fakeGraph();
  // The default sources and no model connection: no secret anywhere.
  const bare = fakeCtx({ graph: graph.api });
  const noVault = withAppSources(fakeCtx({ graph: graph.api }));
  delete noVault.config.keyVault.uri;
  const noWorkspace = withAppSources(fakeCtx({ graph: graph.api }));
  noWorkspace.config.keyVault = { ...NOTEBOOK_MODE };
  delete noWorkspace.config.fabric.workspaceId;
  const noApp = withConnection(withAppSources(fakeCtx({ graph: graph.api })));
  delete noApp.config.app.appId;
  /** @type {[string, ReturnType<typeof fakeCtx>][]} */
  const cases = [
    ['nothing reads the secret', bare],
    ['sources sign in as the app, but there is no vault yet', noVault],
    ['secrets go in the notebooks, but there is no workspace yet', noWorkspace],
    ['no app registration', noApp],
  ];
  for (const [what, t] of cases) {
    const u = fakeUi({ answers: [true] });
    t.ctx.ui = u.ui;
    await assert.rejects(runCommand(t.ctx, 'rotate-secret', { wait: true }), { message: NOTHING_INSTALLED }, what);
    assert.deepEqual(u.asked, [], what);
    assert.equal(u.text(), '', what);
  }
  assert.deepEqual(graph.calls, []);
});

test('rotate-secret: with Key Vault, the app gets a new secret in the vault and the connection one of its own', async () => {
  const fabric = fakeFabric();
  const graph = fakeGraph();
  const kv = fakeKeyVault();
  const u = fakeUi({ answers: [true] });
  const t = withConnection(withAppSources(fakeCtx({ ui: u.ui, fabric: fabric.api, graph: graph.api, keyVault: kv.api })), fabric);
  Object.assign(t.config.keyVault, { name: 'kv-test', secretKeyId: 'key-vault-0' });

  assert.equal(await runCommand(t.ctx, 'rotate-secret', { wait: true }), true);
  assert.deepEqual(u.asked, ["Create new secrets and replace the one in Key Vault and the connection's?"]);
  assert.deepEqual(unref(graph.calls), [
    'addPassword Consumption Central installer',
    'addPassword Consumption Central semantic model connection',
    'removePassword key-connection-0',
  ]);
  assert.deepEqual(kv.calls, ['waitForAccess consumption-central-client-secret', 'setSecret consumption-central-client-secret']);
  assert.deepEqual(kv.secrets['consumption-central-client-secret'], {
    value: 'secret-1',
    expires: new Date('2027-06-01T12:00:00.000Z'),
    contentType: 'Client secret for app-1',
  });
  assert.deepEqual(fabric.calls, ['updateConnection connection-1']);
  connectionBody(fabric, 'secret-2');
  const { app, keyVault: vault, semanticModel: sm } = t.config;
  assert.equal(app.secretExpires, '2027-06-01T12:00:00.000Z');
  assert.equal(vault.secretSetAt, '2026-06-01T12:00:00.000Z');
  assert.equal(vault.secretKeyId, 'key-1');
  assert.deepEqual(vault.previousSecretKeyIds, ['key-vault-0'], 'the old secret stays on the app until it expires, as a run may still use it');
  assert.equal(sm.secretKeyId, 'key-2');
  assert.equal(sm.secretExpires, '2027-06-01T12:00:00.000Z');
  const text = plain(u);
  assert.match(text, /\n {4}Key Vault: kv-test, secret consumption-central-client-secret\n {4}Connection: Consumption Central SQL ws-1, used by Consumption Central Model\n/);
  assert.match(text, /The notebooks' old secret keeps working until it expires\. Delete it from the app's Certificates & secrets page once a run has succeeded\./);
  assert.match(text, /✓ Created a client secret and saved it to Key Vault as consumption-central-client-secret \(expires 2027-06-01\)/);
  assert.match(text, /✓ Gave "Consumption Central SQL ws-1" a new secret \(expires 2027-06-01\)/);
  assert.doesNotMatch(text, /secret-[12]\b/);
});

test('rotate-secret: with the secret in the notebooks, they are rewritten with a new one, and the connection gets its own', async () => {
  const fabric = fakeFabric();
  const graph = fakeGraph();
  const t = withConnection(withAppSources(fakeCtx({ fabric: fabric.api, graph: graph.api })), fabric);
  t.config.keyVault = { ...NOTEBOOK_MODE };
  await ensureNotebooks(t.ctx);
  const notebooks = fabric.items.map((i) => i.displayName);
  const holding = fabric.items.filter((i) => String(i.content).includes('secret-1')).map((i) => i.displayName);
  assert.deepEqual(holding, ['Ingest_Studio', 'Ingest_Org_Graph']);
  graph.calls.length = 0;
  fabric.calls.length = 0;

  const u = fakeUi({ answers: [true] });
  t.ctx.ui = u.ui;
  assert.equal(await runCommand(t.ctx, 'rotate-secret', { wait: true }), true);
  assert.deepEqual(u.asked, ["Create a new secret and rewrite the notebooks, and replace the connection's?"]);
  assert.deepEqual(unref(graph.calls), [
    'addPassword Consumption Central installer',
    'removePassword key-1',
    'addPassword Consumption Central semantic model connection',
    'removePassword key-connection-0',
  ]);
  assert.deepEqual(fabric.calls, [...notebooks.map((name) => `updateNotebook ${name}`), 'updateConnection connection-1']);
  assert.deepEqual(fabric.items.filter((i) => String(i.content).includes('secret-2')).map((i) => i.displayName), holding);
  assert.ok(fabric.items.every((i) => !String(i.content).includes('secret-1')), 'the old secret is in no notebook');
  connectionBody(fabric, 'secret-3');
  assert.equal(t.config.app.secretKeyId, 'key-2');
  assert.equal(t.config.app.secretExpires, '2026-08-30T12:00:00.000Z');
  assert.equal(t.config.semanticModel.secretKeyId, 'key-3');
  const text = plain(u);
  assert.match(text, /\n {4}Secret: in the notebooks \(no Key Vault\)\n {4}Connection: Consumption Central SQL ws-1, used by Consumption Central Model\n/);
  assert.match(text, /A new secret, valid for 90 days, is written into the notebooks, then the old one is removed from the app/);
  assert.match(text, /✓ Gave "Consumption Central SQL ws-1" a new secret \(expires 2027-06-01\)/);
  assert.match(text, /Anyone with a role in the workspace can read the secret in the notebooks\. Key Vault avoids that/);
  assert.doesNotMatch(text, /secret-[123]\b/);
});

// Azure AI waits for a subscription the app can read (deployedSources), so until then no notebook reads
// the app's secret and, with no Key Vault, the install has none of its own to replace.
test('rotate-secret: Azure AI chosen without a subscription puts no secret in the notebooks, so only the connection is rotated', async () => {
  const fabric = fakeFabric();
  const graph = fakeGraph();
  const t = withConnection(fakeCtx({ fabric: fabric.api, graph: graph.api }), fabric);
  t.config.keyVault = { ...NOTEBOOK_MODE };
  t.config.dataSources.azureAi = 'api';
  await ensureNotebooks(t.ctx);
  assert.deepEqual(graph.calls, [], 'no deployed notebook reads the secret');
  fabric.calls.length = 0;

  const u = fakeUi({ answers: [true] });
  t.ctx.ui = u.ui;
  assert.equal(await runCommand(t.ctx, 'rotate-secret', { wait: true }), true);
  assert.deepEqual(fabric.calls, ['updateConnection connection-1']);
  assert.deepEqual(unref(graph.calls), ['addPassword Consumption Central semantic model connection', 'removePassword key-connection-0']);
  assert.equal(u.text(), ONLY_CONNECTION);
});

// github-token

test('github-token: with Key Vault, the new token is checked with GitHub and saved as a new version of its secret', async () => {
  const gh = fakeGithub();
  const kv = fakeKeyVault();
  const fabric = fakeFabric();
  const graph = fakeGraph();
  const u = fakeUi({ answers: ['ghp_new'] });
  const t = fakeCtx({ ui: u.ui, keyVault: kv.api, fabric: fabric.api, graph: graph.api });
  t.ctx.api.github = gh.api;
  t.config.keyVault.name = 'kv-test';
  readsGithub(t, { tokenSetAt: '2026-03-01T00:00:00.000Z', tokenExpires: '2026-07-01T00:00:00.000Z' });

  await withEnv(ENV.GITHUB_TOKEN, undefined, async () => assert.equal(await runCommand(t.ctx, 'github-token', { wait: true }), true));
  assert.deepEqual(u.asked, ['GitHub token']);
  assert.deepEqual(gh.tokens, ['ghp_new']);
  assert.deepEqual(gh.calls, ['copilotSeats contoso', 'aiCreditUsage contoso']);
  assert.deepEqual(kv.calls, ['waitForAccess consumption-central-github-pat', 'setSecret consumption-central-github-pat']);
  assert.deepEqual(kv.secrets, { 'consumption-central-github-pat': { value: 'ghp_new', contentType: 'GitHub token for contoso' } });
  assert.deepEqual(t.config.github, {
    enterprise: 'contoso',
    secretName: 'consumption-central-github-pat',
    tokenSetAt: '2026-06-01T12:00:00.000Z',
    tokenExpires: '2026-09-01T12:00:00.000Z',
  });
  assert.equal(t.ctx.pendingGithubToken, undefined);
  assert.deepEqual([graph.calls, fabric.calls], [[], []], 'no app secret or notebook is touched');
  const text = plain(u);
  assert.match(text, /\nNew GitHub token\n {4}Enterprise: contoso\n {4}Key Vault: kv-test, secret consumption-central-github-pat\n {4}The current one expires 2026-07-01\.\n/);
  assert.match(text, /✓ The GitHub token reads contoso's Copilot billing\. It expires 2026-09-01\n/);
  assert.match(text, /✓ Saved the GitHub token to Key Vault as consumption-central-github-pat \(expires 2026-09-01\)\n/);
  assert.match(text, /Revoke the old token at https:\/\/github\.com\/settings\/tokens once GitHub data has loaded with the new one\./);
  assert.doesNotMatch(text, /ghp_new/);
});

test('github-token: under --yes the token comes from the environment, and without one there it stops', async () => {
  const gh = fakeGithub();
  const kv = fakeKeyVault();
  const u = fakeUi({ yes: true });
  const t = fakeCtx({ ui: u.ui, keyVault: kv.api });
  t.ctx.api.github = gh.api;
  t.config.keyVault.name = 'kv-test';
  readsGithub(t);

  await withEnv(ENV.GITHUB_TOKEN, ' ghp_env ', async () => assert.equal(await runCommand(t.ctx, 'github-token', { wait: true }), true));
  assert.deepEqual(u.asked, []);
  assert.deepEqual(gh.tokens, ['ghp_env']);
  assert.equal(kv.secrets['consumption-central-github-pat'].value, 'ghp_env');
  assert.ok(plain(u).includes(`    Using the GitHub token in ${ENV.GITHUB_TOKEN}.\n`));
  assert.doesNotMatch(plain(u), /Revoke the old token/, 'there was no token before');

  const none = fakeUi({ yes: true });
  const bare = fakeCtx({ ui: none.ui, keyVault: kv.api });
  bare.ctx.api.github = gh.api;
  readsGithub(bare);
  kv.calls.length = 0;
  await withEnv(ENV.GITHUB_TOKEN, undefined, () =>
    assert.rejects(runCommand(bare.ctx, 'github-token', { wait: true }), { message: `The new GitHub token is needed. Run without --yes, or set ${ENV.GITHUB_TOKEN}.` }),
  );
  assert.deepEqual(kv.calls, []);
  assert.deepEqual(bare.config.github, { enterprise: 'contoso' });
});

test("github-token: an install that doesn't read GitHub from the API, or has nowhere to keep the token yet, is turned down", async () => {
  const notApi = 'This install doesn\'t read GitHub from the API, so it has no GitHub token. Choose "From the API" for GitHub in the setup first.';
  const csv = fakeCtx();
  readsGithub(csv);
  csv.config.dataSources.github = 'csv';
  const noEnterprise = fakeCtx();
  noEnterprise.config.dataSources.github = 'api';
  const noVault = fakeCtx();
  readsGithub(noVault);
  delete noVault.config.keyVault.uri;
  const noNotebook = fakeCtx();
  readsGithub(noNotebook);
  noNotebook.config.keyVault = { ...NOTEBOOK_MODE };
  /** @type {[string, ReturnType<typeof fakeCtx>, string][]} */
  const cases = [
    ['GitHub from a CSV', csv, notApi],
    ['no enterprise', noEnterprise, notApi],
    ['no vault yet', noVault, NOTHING_INSTALLED],
    ['no Ingest_GitHub_API yet', noNotebook, NOTHING_INSTALLED],
  ];
  for (const [what, t, message] of cases) {
    const u = fakeUi({ answers: ['ghp_new'] });
    t.ctx.ui = u.ui;
    await assert.rejects(runCommand(t.ctx, 'github-token', { wait: true }), { message }, what);
    assert.deepEqual(u.asked, [], what);
    assert.equal(u.text(), '', what);
  }
});

test('github-token: a vault admin replaces the token, so the installer never sees it, and can stop to resume later', async () => {
  const kv = fakeKeyVault();
  const gh = fakeGithub();
  const u = fakeUi({ answers: ['go'] });
  const t = adminCtx({ ui: u.ui, keyVault: kv.api });
  t.ctx.api.github = gh.api;
  readsGithub(t, { tokenSetAt: '2026-03-01T00:00:00.000Z', tokenExpires: '2026-07-01T00:00:00.000Z' });

  // Not even a token in the environment is read.
  await withEnv(ENV.GITHUB_TOKEN, 'ghp_env', async () => assert.equal(await runCommand(t.ctx, 'github-token', { wait: true }), true));
  assert.deepEqual(u.asked, ['Has the admin replaced the GitHub token?']);
  assert.deepEqual(gh.tokens, []);
  assert.deepEqual(kv.calls, ['secretInfo consumption-central-github-pat'], 'it only checks the name is free');
  assert.deepEqual(kv.secrets, {});
  assert.deepEqual(t.config.github, { enterprise: 'contoso', secretName: 'consumption-central-github-pat', tokenSetAt: '2026-06-01T12:00:00.000Z' });
  assert.equal(t.config.keyVault.secretSetAt, undefined, 'the client secret is not part of it');
  const text = plain(u);
  assert.ok(text.includes('  ! A vault admin needs to replace the GitHub token in kv-test. The installer never sees its value.\n'));
  assert.ok(text.includes(`    Vault:   kv-test  https://portal.azure.com/#@tenant-1/resource${VAULT_ID}/secrets\n`));
  assert.ok(
    text.includes('    Token:   consumption-central-github-pat, a classic GitHub token with scope read:enterprise or manage_billing:copilot, made by an owner or billing manager of contoso\n'),
  );
  assert.ok(
    text.includes(
      '      read -rs -p "GitHub token: " T && echo && az keyvault secret set --vault-name kv-test --name consumption-central-github-pat ' +
        '--content-type "GitHub token for contoso" --value "$T" --query id -o tsv; unset T\n',
    ),
  );
  assert.match(text, /Once GitHub data has loaded with the new token, revoke the old one at https:\/\/github\.com\/settings\/tokens\./);
  assert.match(text, /✓ The vault admin has replaced the GitHub token consumption-central-github-pat\n/);
  assert.doesNotMatch(text, /Secret: {2}|az ad app credential reset/, 'only the token is handed over');

  const later = adminCtx({ ui: fakeUi({ answers: ['stop'] }).ui, keyVault: fakeKeyVault().api });
  readsGithub(later, { tokenSetAt: '2026-03-01T00:00:00.000Z' });
  await assert.rejects(runCommand(later.ctx, 'github-token', { wait: true }), (err) => isResumeLater(err));
  assert.equal(later.config.github?.tokenSetAt, '2026-03-01T00:00:00.000Z');
});

test('github-token: with no Key Vault, Ingest_GitHub_API is written again with the new token, and nothing else changes', async () => {
  const fabric = fakeFabric();
  const graph = fakeGraph();
  const gh = fakeGithub();
  const t = fakeCtx({ fabric: fabric.api, graph: graph.api });
  t.ctx.api.github = gh.api;
  t.config.keyVault = { ...NOTEBOOK_MODE };
  readsGithub(t);
  t.ctx.pendingGithubToken = { value: 'ghp_old', expires: '2026-07-01T00:00:00.000Z' };
  await ensureNotebooks(t.ctx);
  const tokenNb = fabric.items.find((i) => i.displayName === 'Ingest_GitHub_API');
  assert.ok(tokenNb);
  assert.ok(String(tokenNb.content).includes('ghp_old'));
  const others = () => fabric.items.filter((i) => i !== tokenNb).map((i) => [i.displayName, i.content]);
  const before = others();
  assert.ok(before.length > 1);
  fabric.calls.length = 0;

  const u = fakeUi({ answers: ['ghp_new'] });
  t.ctx.ui = u.ui;
  await withEnv(ENV.GITHUB_TOKEN, undefined, async () => assert.equal(await runCommand(t.ctx, 'github-token', { wait: true }), true));
  assert.deepEqual(u.asked, ['GitHub token']);
  assert.deepEqual(gh.tokens, ['ghp_new']);
  assert.deepEqual(fabric.calls, ['updateNotebook Ingest_GitHub_API']);
  assert.ok(String(tokenNb.content).includes('ghp_new'));
  assert.ok(!String(tokenNb.content).includes('ghp_old'));
  assert.deepEqual(others(), before);
  assert.deepEqual(t.config.github, { enterprise: 'contoso', tokenSetAt: '2026-06-01T12:00:00.000Z', tokenInNotebook: true, tokenExpires: '2026-09-01T12:00:00.000Z' });
  assert.equal(t.ctx.pendingGithubToken, undefined);
  assert.deepEqual(graph.calls, [], 'no client secret is made');
  const text = plain(u);
  assert.match(text, /\nNew GitHub token\n {4}Enterprise: contoso\n {4}Token: in Ingest_GitHub_API \(no Key Vault\)\n {4}The current one expires 2026-07-01\.\n/);
  assert.match(text, /✓ Updated Ingest_GitHub_API\n/);
  assert.match(text, /Revoke the old token at https:\/\/github\.com\/settings\/tokens once GitHub data has loaded with the new one\./);
  assert.doesNotMatch(text, /ghp_/);
});

// preview

/**
 * Runs preview into a new folder, checks it changed nothing, and returns what it wrote.
 * @param {import('../src/config.js').InstallConfig} config
 */
function previewOf(config) {
  const u = fakeUi();
  const dir = mkdtempSync(join(tmpdir(), 'consumption-central-preview-'));
  const before = structuredClone(config);
  try {
    preview({ ui: u.ui, config, sources: realSources(), outDir: dir, now: new Date('2026-06-01T12:00:00Z') });
    assert.deepEqual(config, before, 'the install record is unchanged');
    assert.deepEqual(u.asked, []);
    return {
      files: readdirSync(dir).sort(),
      notebooks: readdirSync(join(dir, 'notebooks')).sort(),
      flows: existsSync(join(dir, 'flows')) ? readdirSync(join(dir, 'flows')) : [],
      permissions: readFileSync(join(dir, 'graph-permissions.txt'), 'utf8'),
      text: plain(u),
      out: resolve(dir),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** @param {string[]} names */
const ipynb = (...names) => names.map((n) => `${n}.ipynb`).sort();

const COMMON = ['ConsumptionCentral_Upload_Router', 'Ingest_Studio', 'Ingest_Viva_Consumption', 'ConsumptionCentral_Refresh_Model', 'ConsumptionCentral_Load_Status'];

test('preview: writes the notebook of each chosen source, the pipeline, schedule and model, and changes nothing', () => {
  const defaults = previewOf(emptyConfig());
  assert.deepEqual(defaults.notebooks, ipynb(...COMMON));
  assert.deepEqual(defaults.files, ['graph-permissions.txt', 'model.bim', 'notebooks', 'pipeline-content.json', 'schedule.json']);
  assert.equal(defaults.permissions, 'Microsoft Graph application permissions for the app registration:\n  none\n');
  assert.equal(
    defaults.text,
    lines(
      '\nPreview written',
      `    ${defaults.out}`,
      '    Notebooks, pipeline-content.json, schedule.json, model.bim and graph-permissions.txt, with placeholder IDs where none are known yet.',
    ),
  );

  const api = emptyConfig();
  Object.assign(api.dataSources, { studioCredits: 'api', github: 'api', orgData: 'api', azureAi: 'api', commercialTerms: 'api' });
  api.consumption.azureSubscriptionId = 'sub-1';
  api.github = { enterprise: 'contoso' };
  const fromApis = previewOf(api);
  assert.deepEqual(fromApis.notebooks, ipynb(...COMMON, 'Ingest_Azure_AI', 'Ingest_GitHub_API', 'Ingest_CommercialTerms', 'Ingest_Org_Graph'));
  assert.deepEqual(fromApis.flows, [FLOW_FILES.studio]);
  assert.equal(fromApis.permissions, 'Microsoft Graph application permissions for the app registration:\n  User.Read.All\n');

  const csv = emptyConfig();
  Object.assign(csv.dataSources, { github: 'csv', orgData: 'csv' });
  const fromFiles = previewOf(csv);
  assert.deepEqual(fromFiles.notebooks, ipynb(...COMMON, 'Ingest_GitHub', 'Ingest_Org'));
  assert.deepEqual(fromFiles.flows, []);
  assert.equal(fromFiles.permissions, 'Microsoft Graph application permissions for the app registration:\n  none\n');
});

test('preview: leaves out Azure AI without a subscription, and the model when it is switched off', () => {
  const noSubscription = emptyConfig();
  noSubscription.dataSources.azureAi = 'api';
  assert.deepEqual(previewOf(noSubscription).notebooks, ipynb(...COMMON));

  const noModel = emptyConfig();
  noModel.semanticModel.enabled = false;
  const written = previewOf(noModel);
  assert.deepEqual(written.notebooks, ipynb(...COMMON.filter((n) => n !== 'ConsumptionCentral_Refresh_Model')));
  assert.ok(!written.files.includes('model.bim'));
  assert.match(written.text, /Notebooks, pipeline-content\.json, schedule\.json and graph-permissions\.txt, with placeholder IDs/);
});
