// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyConfig } from '../src/config.js';
import { DATA_SOURCES, describeSources } from '../src/uploads.js';
import { createWebUi } from '../src/web-ui.js';
import { createSession, describeRecord, WEB_COMMANDS } from '../src/web-session.js';

/** A record of an install: its workspace and Lakehouse are there. */
function installed() {
  const config = emptyConfig();
  config.tenantId = 'tenant-1';
  config.fabric.workspaceId = 'ws-1';
  config.fabric.workspaceName = 'Consumption Central';
  config.fabric.lakehouseId = 'lh-1';
  config.fabric.lakehouseName = 'ConsumptionCentral';
  return config;
}

test('describeRecord: the data sources as the home page lists them, and whether there is an app registration', () => {
  const config = installed();
  const rec = describeRecord(config);
  assert.deepEqual(rec.data, describeSources(config.dataSources));
  assert.equal(rec.data.length, DATA_SOURCES.length, 'a line for each source');
  assert.ok(rec.data.includes('Copilot Cowork and Work IQ credits: Upload CSV'));
  assert.ok(rec.data.includes('Copilot Studio credits: Upload CSV only'));
  assert.ok(rec.data.includes('GitHub Copilot: Skip'));
  assert.equal(rec.app, false);
  assert.equal(rec.installed, true);
  assert.equal(rec.target, 'fabric', "the home page is told the record's target");
  assert.equal(rec.workspaceUrl, 'https://app.fabric.microsoft.com/groups/ws-1');

  config.dataSources.studioCredits = 'api';
  config.dataSources.github = 'api';
  config.app.appId = 'app-1';
  const after = describeRecord(config);
  assert.deepEqual(after.data, describeSources(config.dataSources));
  assert.ok(after.data.includes('Copilot Studio credits: Connected (Power Automate flow)'));
  assert.ok(after.data.includes('GitHub Copilot: Connected (GitHub API)'));
  assert.equal(after.app, true);
});

test("describeRecord: the secret that expires first, the app's only while a source signs in as the app, the model connection's only while there is one", () => {
  for (const id of /** @type {const} */ (['studioCredits', 'azureAi', 'orgData'])) {
    const one = installed();
    one.app.secretExpires = '2026-09-01T08:00:00Z';
    assert.equal(describeRecord(one).secretExpires, undefined, `${id} not from its API`);
    one.dataSources[id] = 'api';
    assert.equal(describeRecord(one).secretExpires, '2026-09-01', id);
  }

  const config = installed();
  config.app.appId = 'app-1';
  config.app.secretExpires = '2026-09-01T08:00:00Z';
  config.semanticModel.secretExpires = '2026-08-01T08:00:00Z';
  config.dataSources.github = 'api';
  assert.equal(describeRecord(config).secretExpires, undefined, "the GitHub token isn't the app's secret, and there is no model connection");
  config.dataSources.studioCredits = 'api';
  assert.equal(describeRecord(config).secretExpires, '2026-09-01');
  config.semanticModel.connectionId = 'conn-1';
  assert.equal(describeRecord(config).secretExpires, '2026-08-01', "the model connection's expires first");
  config.app.secretExpires = '2026-07-15T23:00:00Z';
  assert.equal(describeRecord(config).secretExpires, '2026-07-15', "now the app's does");
  config.dataSources.studioCredits = 'csv';
  assert.equal(describeRecord(config).secretExpires, '2026-08-01', "no source signs in as the app: only the model connection's counts");
  config.semanticModel.secretExpires = 'unknown';
  assert.equal(describeRecord(config).secretExpires, undefined, "a date that doesn't parse is left out");
  config.semanticModel.secretExpires = '2026-08-01T08:00:00Z';
  delete config.semanticModel.connectionId;
  assert.equal(describeRecord(config).secretExpires, undefined);
});

test("describeRecord: the GitHub token's expiry only when GitHub is read from the API and a token is set, and Never for one that doesn't expire", () => {
  const config = installed();
  assert.equal(describeRecord(config).tokenExpires, undefined, 'GitHub is skipped');
  config.dataSources.github = 'api';
  config.github = { enterprise: 'contoso' };
  assert.equal(describeRecord(config).tokenExpires, undefined, 'no token set yet');
  config.github.tokenSetAt = '2026-06-01T12:00:00Z';
  assert.equal(describeRecord(config).tokenExpires, 'Never');
  config.github.tokenExpires = '2026-08-30T23:59:59Z';
  assert.equal(describeRecord(config).tokenExpires, '2026-08-30');
  config.dataSources.github = 'csv';
  assert.equal(describeRecord(config).tokenExpires, undefined, 'uploaded: no token in use');
});

test('describeRecord: Check the data needs the install and a semantic model that is deployed and bound', () => {
  const config = installed();
  assert.equal(describeRecord(config).can.check, false, 'no model yet');
  config.semanticModel = { ...config.semanticModel, enabled: true, id: 'sm-1' };
  assert.equal(describeRecord(config).can.check, false, 'not bound to the Lakehouse yet');
  config.semanticModel.bound = true;
  assert.equal(describeRecord(config).can.check, true);
  config.semanticModel.enabled = false;
  assert.equal(describeRecord(config).can.check, false, 'the model is turned off');
  config.semanticModel.enabled = true;
  delete config.fabric.lakehouseId;
  assert.equal(describeRecord(config).installed, false);
  assert.equal(describeRecord(config).can.check, false, 'not installed');
});

test("describeRecord: New secrets for the app's secret where it is kept, or for the model connection's", () => {
  const config = installed();
  config.dataSources.studioCredits = 'api';
  config.keyVault.uri = 'https://kv-contoso.vault.azure.net/';
  assert.equal(describeRecord(config).can['rotate-secret'], false, 'no app registration');
  config.app.appId = 'app-1';
  assert.equal(describeRecord(config).can['rotate-secret'], true, 'in Key Vault');
  delete config.keyVault.uri;
  assert.equal(describeRecord(config).can['rotate-secret'], false, 'no vault to put it in');
  config.keyVault.mode = 'keyvault-admin';
  assert.equal(describeRecord(config).can['rotate-secret'], false, "a vault admin's vault is still a vault");
  config.keyVault.mode = 'notebook';
  assert.equal(describeRecord(config).can['rotate-secret'], true, 'in the notebooks');
  delete config.fabric.workspaceId;
  assert.equal(describeRecord(config).can['rotate-secret'], false, 'no notebooks until it is installed');
  config.fabric.workspaceId = 'ws-1';
  config.dataSources.studioCredits = 'csv';
  assert.equal(describeRecord(config).can['rotate-secret'], false, 'no source signs in as the app');
  config.semanticModel.connectionId = 'conn-1';
  assert.equal(describeRecord(config).can['rotate-secret'], true, "the model connection's secret");
  delete config.app.appId;
  assert.equal(describeRecord(config).can['rotate-secret'], false);
});

test('describeRecord: with no Key Vault, Azure AI waiting for its subscription leaves the app no secret of its own', () => {
  const config = installed();
  config.app.appId = 'app-1';
  config.app.secretExpires = '2026-09-01T08:00:00Z';
  config.keyVault.mode = 'notebook';
  config.dataSources.azureAi = 'api';
  assert.equal(describeRecord(config).can['rotate-secret'], false, 'Ingest_Azure_AI is not deployed, so no notebook holds a secret');
  assert.equal(describeRecord(config).secretExpires, undefined);
  config.semanticModel.connectionId = 'conn-1';
  assert.equal(describeRecord(config).can['rotate-secret'], true, "the model connection's secret");
  delete config.semanticModel.connectionId;
  config.consumption.azureSubscriptionId = 'sub-1';
  config.consumption.azureAccess = true;
  assert.equal(describeRecord(config).can['rotate-secret'], true, 'Ingest_Azure_AI reads it now');
  assert.equal(describeRecord(config).secretExpires, '2026-09-01');
  config.consumption.azureAccess = false;
  delete config.keyVault.mode;
  config.keyVault.uri = 'https://kv-contoso.vault.azure.net/';
  assert.equal(describeRecord(config).can['rotate-secret'], true, 'Key Vault keeps it while Azure AI waits');
  assert.equal(describeRecord(config).secretExpires, '2026-09-01');
});

test('describeRecord: New GitHub token once a GitHub enterprise is read from the API, with its token in Key Vault or the notebook', () => {
  const config = installed();
  config.dataSources.github = 'api';
  config.github = { enterprise: 'contoso' };
  config.keyVault.uri = 'https://kv-contoso.vault.azure.net/';
  assert.equal(describeRecord(config).can['github-token'], true, 'in Key Vault');
  delete config.keyVault.uri;
  assert.equal(describeRecord(config).can['github-token'], false, 'no vault for the token');
  config.keyVault.mode = 'notebook';
  assert.equal(describeRecord(config).can['github-token'], false, 'Ingest_GitHub_API is not deployed yet');
  config.fabric.notebooks.githubApi = 'nb-github';
  assert.equal(describeRecord(config).can['github-token'], true, 'in the notebook');
  delete config.github.enterprise;
  assert.equal(describeRecord(config).can['github-token'], false, 'no enterprise to read');
  config.github.enterprise = 'contoso';
  config.dataSources.github = 'csv';
  assert.equal(describeRecord(config).can['github-token'], false, 'GitHub is uploaded');
  config.dataSources.github = 'api';
  delete config.fabric.lakehouseId;
  assert.equal(describeRecord(config).can['github-token'], false, 'not installed');
});

test('web session: New GitHub token is a command, and a start request with backfill days just runs, as there is no history to load', async () => {
  assert.ok(WEB_COMMANDS.includes('github-token'));
  const ui = createWebUi({ now: () => 1000 });
  let signIns = 0;
  const connect = async () => {
    signIns++;
    throw new Error('No sign-in in this test.');
  };
  const configFile = fileURLToPath(new URL('./no-such-record.json', import.meta.url));
  const s = createSession({ ui, configFile, version: '0.0.0', connect: /** @type {any} */ (connect) });
  const ended = () => ui.history().filter((e) => e.type === 'command' && e.state !== 'running');
  assert.equal(s.state().record, null);

  assert.deepEqual(s.start({ command: 'backfill' }), { ok: false, status: 400, error: 'Unknown command.' });
  // @ts-expect-error backfillDays is no longer part of the request
  assert.deepEqual(s.start({ command: 'run', backfillDays: 0 }), { ok: true }, 'ignored, not turned away');
  await s.settled();
  assert.deepEqual(ended().map((e) => [e.command, e.state]), [['run', 'failed']]);
  assert.match(String(ended()[0].error), /^No install record at .*no-such-record\.json\. Set up Consumption Central first\.$/);

  assert.deepEqual(s.start({ command: 'github-token' }), { ok: true });
  await s.settled();
  assert.deepEqual(ended().map((e) => [e.command, e.state]), [['run', 'failed'], ['github-token', 'failed']]);
  assert.match(String(ended()[1].error), /^No install record at /, 'like every command but install and prerequisites, it needs a record');
  assert.equal(signIns, 0, 'no sign-in without a record');
});
