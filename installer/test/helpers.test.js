// @ts-check
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { checkTokens, createTokenProvider, isMsiAudienceError, isTransientNetworkError, TOKEN_ATTEMPTS } from '../src/auth.js';
import { help, parseCli } from '../src/cli.js';
import { allowsAction, armLocation, parseResourceId, validateVaultName } from '../src/clients/azure.js';
import { notebookDefinition, notebookJobParameters, scheduleBody } from '../src/clients/fabric.js';
import { resolveAppRoles } from '../src/clients/graph.js';
import { emptyConfig, loadConfig, saveConfig } from '../src/config.js';
import { bundled, CLOUD_SHELL_ENV, commandLine, EXE_ENV, fromExe, inCloudShell, INSTALLED_NODE_ENV, installerWindow, LAUNCHER_ENV, launcher, reopenHint, SCRIPT_COMMAND, SCRIPT_URL, scriptUrl, updateHint } from '../src/launch.js';
import { describeSchedule, sameSchedule } from '../src/steps/fabric.js';
import { addDays, addMonths, notebookSecretDays } from '../src/steps/identity.js';
import { jobIdFrom, utc } from '../src/steps/run.js';
import { formatDuration } from '../src/ui.js';

const dir = mkdtempSync(join(tmpdir(), 'cc-installer-'));
after(() => rmSync(dir, { recursive: true, force: true }));
/** This installer's version, from package.json. */
const VERSION = String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);

test('tokens are tried again when the network or DNS blips, and not otherwise', async () => {
  const dns = new Error("HTTPSConnectionPool(host='login.microsoftonline.com', port=443): Max retries exceeded (Caused by NameResolutionError(\"Failed to resolve 'login.microsoftonline.com' ([Errno 11001] getaddrinfo failed)\"))");
  assert.equal(isTransientNetworkError(dns), true);
  assert.equal(isTransientNetworkError(new Error('outer', { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) })), true);
  assert.equal(isTransientNetworkError(new Error('AADSTS50076: multi-factor authentication required')), false);

  /** @type {number[]} */
  const sleeps = [];
  const sleep = async (/** @type {number} */ ms) => void sleeps.push(ms);
  let fails = 2;
  let calls = 0;
  const flaky = {
    getToken: async () => {
      calls++;
      if (fails-- > 0) throw dns;
      return { token: 't', expiresOnTimestamp: Date.now() + 3_600_000 };
    },
  };
  const getToken = createTokenProvider(flaky, { sleep });
  assert.equal(await getToken('fabric'), 't');
  assert.equal(await getToken('fabric'), 't', 'cached');
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [2000, 4000]);

  const down = createTokenProvider({ getToken: async () => { throw dns; } }, { sleep });
  sleeps.length = 0;
  await assert.rejects(down('graph'), /getaddrinfo failed/);
  assert.equal(sleeps.length, TOKEN_ATTEMPTS - 1);

  let mfaCalls = 0;
  const mfa = createTokenProvider({ getToken: async () => { mfaCalls++; throw new Error('AADSTS50076'); } }, { sleep });
  await assert.rejects(mfa('graph'), /AADSTS50076/);
  assert.equal(mfaCalls, 1);
});

test('createTokenProvider and checkTokens: Cloud Shell\'s own Azure CLI sign-in says which APIs it can\'t reach and what to do', async () => {
  const msi = (/** @type {string} */ scope) => new Error(`ERROR: Audience ${scope.replace('/.default', '')} is not a supported MSI token audience.`);
  let calls = 0;
  const cloud = createTokenProvider({
    getToken: async (/** @type {string} */ scope) => {
      calls++;
      if (/fabric|powerbi|powerapps|flow/.test(scope)) throw msi(scope);
      return { token: 't', expiresOnTimestamp: Date.now() + 3_600_000 };
    },
  }, { sleep: async () => {} });
  await assert.rejects(cloud('fabric'), (/** @type {any} */ err) => {
    assert.match(err.message, /Cloud Shell's own sign-in, which can't get tokens for Fabric\. Run az login --use-device-code/);
    assert.match(err.cause.message, /not a supported MSI token audience/);
    return true;
  });
  assert.equal(calls, 1, 'not retried');
  assert.ok(isMsiAudienceError(msi('x')));
  assert.ok(!isMsiAudienceError(new Error('AADSTS50076')));
  await assert.rejects(checkTokens(cloud), /can't get tokens for Fabric, Power BI, Power Automate, Power Apps\. Run az login --use-device-code/);
  await assert.doesNotReject(checkTokens(cloud, ['graph', 'arm']));
  await assert.rejects(checkTokens(async () => { throw new Error('AADSTS50076'); }), /AADSTS50076/, 'other failures as they are');
});

test('createTokenProvider: a sign-in can be given up on, and then it isn\'t tried again', async () => {
  /** @type {unknown[][]} */
  const requests = [];
  const credential = {
    getToken: async (/** @type {unknown[]} */ ...args) => {
      requests.push(args);
      return { token: 't', expiresOnTimestamp: Date.now() + 3_600_000 };
    },
  };
  const scope = 'https://contoso.crm.dynamics.com/.default';
  await createTokenProvider(credential)(scope);
  assert.deepEqual(requests, [[scope]], 'without a signal, the scope alone, as before');
  const abort = new AbortController();
  await createTokenProvider(credential)(scope, { abortSignal: abort.signal });
  assert.deepEqual(requests[1], [scope, { abortSignal: abort.signal }], 'the signal reaches the sign-in');

  const dropped = new Error('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) });
  assert.equal(isTransientNetworkError(dropped), true, 'one that would be tried again');
  /** @type {number[]} */
  const sleeps = [];
  let calls = 0;
  const gaveUp = new AbortController();
  const getToken = createTokenProvider({
    getToken: async () => {
      calls++;
      gaveUp.abort();
      throw dropped;
    },
  }, { sleep: async (ms) => void sleeps.push(ms) });
  await assert.rejects(getToken(scope, { abortSignal: gaveUp.signal }), /fetch failed/);
  assert.equal(calls, 1, 'not tried again once given up on');
  assert.deepEqual(sleeps, []);
  await assert.rejects(getToken(scope, { abortSignal: gaveUp.signal }), { name: 'AbortError' });
  assert.equal(calls, 1, 'nothing asked once already given up on');
});

/**
 * Runs a script that leaves a listener open on localhost, like a browser sign-in waiting for the browser,
 * then ends the way the installer's bin does.
 * @param {boolean} abandon  Whether the sign-in was given up on first.
 */
function listenThenExit(abandon) {
  const auth = new URL('../src/auth.js', import.meta.url).href;
  const script = [
    'import { createServer } from \'node:http\';',
    `import { abandonSignIn, exitWhenDone } from ${JSON.stringify(auth)};`,
    'createServer().listen(0, \'127.0.0.1\', () => {',
    '  console.log(\'listening\');',
    abandon ? '  abandonSignIn();' : '',
    '  exitWhenDone(3);',
    '});',
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
  child.stderr.setEncoding('utf8').on('data', (d) => { out += d; });
  /** @type {Promise<number | null>} */
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, exited, out: () => out };
}

/** @param {Promise<unknown>} p @param {number} ms */
async function within(p, ms) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    return await Promise.race([p, new Promise((r) => { timer = setTimeout(r, ms, 'still running'); })]);
  } finally {
    clearTimeout(timer);
  }
}

test('exitWhenDone: once a sign-in was given up on, the installer exits, though the sign-in\'s listener is still open', async () => {
  const gaveUp = listenThenExit(true);
  try {
    assert.equal(await within(gaveUp.exited, 15_000), 3, gaveUp.out());
    assert.match(gaveUp.out(), /listening/);
  } finally {
    gaveUp.child.kill();
  }

  const waiting = listenThenExit(false);
  try {
    for (let i = 0; !waiting.out().includes('listening') && i < 150; i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(waiting.out(), /listening/);
    assert.equal(await within(waiting.exited, 1_000), 'still running', 'otherwise the open listener keeps it running');
  } finally {
    waiting.child.kill();
  }
  await waiting.exited;
});

test('exitWhenDone: after a sign-in was given up on, it exits only once slow stdout and stderr have written everything, with the exit code', async () => {
  const auth = new URL('../src/auth.js', import.meta.url).href;
  const size = 1024 * 1024;
  const streams = [
    ['stdout', join(dir, 'slow-stdout.txt'), '\nUpload ConsumptionCentral-Teams.zip to Teams by hand.\n'],
    ['stderr', join(dir, 'slow-stderr.txt'), '\nThe last error.\n'],
  ];
  // Slow stdout and stderr, like pipes to a slow reader on Linux or macOS, where pipes write asynchronously.
  // Writing anything takes 3 seconds.
  const script = [
    'import { appendFileSync } from \'node:fs\';',
    'import { createServer } from \'node:http\';',
    'import { Writable } from \'node:stream\';',
    `import { abandonSignIn, exitWhenDone } from ${JSON.stringify(auth)};`,
    `const streams = ${JSON.stringify(streams)};`,
    'for (const [name, file] of streams) {',
    '  const slow = new Writable({ write(chunk, _encoding, done) { setTimeout(() => { appendFileSync(file, chunk); done(); }, chunk.length ? 3_000 : 0); } });',
    '  Object.defineProperty(process, name, { value: slow });',
    '}',
    'createServer().listen(0, \'127.0.0.1\', () => {',
    '  abandonSignIn();',
    `  for (const [name, , last] of streams) process[name].write('x'.repeat(${size}) + last);`,
    '  exitWhenDone(7);',
    '});',
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let other = '';
  child.stdout.setEncoding('utf8').on('data', (d) => { other += d; });
  child.stderr.setEncoding('utf8').on('data', (d) => { other += d; });
  /** @type {Promise<number | null>} */
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  try {
    assert.equal(await within(exited, 20_000), 7, other);
  } finally {
    child.kill();
  }
  for (const [name, file, last] of streams) {
    const written = existsSync(file) ? readFileSync(file, 'utf8') : '';
    assert.ok(written.endsWith(last), `the last line of ${name} arrives`);
    assert.equal(written.length, size + last.length, `all of ${name} arrives`);
  }
});

test('allowsAction handles wildcards, notActions and data actions', () => {
  const owner = [{ actions: ['*'], notActions: [] }];
  const contributor = [{ actions: ['*'], notActions: ['Microsoft.Authorization/*/Write', 'Microsoft.Authorization/*/Delete'] }];
  const write = 'Microsoft.Authorization/roleAssignments/write';
  assert.equal(allowsAction(owner, write), true);
  assert.equal(allowsAction(contributor, write), false);
  assert.equal(allowsAction(contributor, 'Microsoft.KeyVault/vaults/write'), true);

  const setSecret = 'Microsoft.KeyVault/vaults/secrets/setSecret/action';
  const officer = [{ dataActions: ['Microsoft.KeyVault/vaults/secrets/*'], notDataActions: [] }];
  const reader = [{ dataActions: ['Microsoft.KeyVault/vaults/secrets/readMetadata/action'] }];
  const blocked = [{ dataActions: ['*'], notDataActions: ['Microsoft.KeyVault/vaults/secrets/setSecret/action'] }];
  assert.equal(allowsAction(officer, setSecret, 'dataActions'), true);
  assert.equal(allowsAction(reader, setSecret, 'dataActions'), false);
  assert.equal(allowsAction(blocked, setSecret, 'dataActions'), false);
  assert.equal(allowsAction(owner, setSecret, 'dataActions'), false, 'control-plane * is not a data action');
});

test('Key Vault names, regions and resource IDs', () => {
  assert.equal(validateVaultName('kv-consumption-01'), true);
  assert.notEqual(validateVaultName('1kv'), true);
  assert.notEqual(validateVaultName('kv'), true);
  assert.notEqual(validateVaultName('kv--consumption'), true);
  assert.notEqual(validateVaultName('kv-consumption-'), true);
  assert.notEqual(validateVaultName('a'.repeat(25)), true);

  assert.equal(armLocation('UK South'), 'uksouth');
  assert.equal(armLocation('westeurope'), 'westeurope');

  assert.deepEqual(parseResourceId('/subscriptions/s1/resourceGroups/rg-1/providers/Microsoft.KeyVault/vaults/kv1'), {
    subscriptionId: 's1',
    resourceGroup: 'rg-1',
    type: 'Microsoft.KeyVault/vaults',
    name: 'kv1',
  });
  assert.throws(() => parseResourceId('/subscriptions/s1'), /Not a resource ID/);
});

test('resolveAppRoles: required permissions must exist, optional ones are reported', () => {
  const sp = { appRoles: [{ id: 'r1', value: 'AuditLogsQuery.Read.All' }, { id: 'r2', value: 'User.Read.All' }] };
  assert.deepEqual(resolveAppRoles(sp, ['AuditLogsQuery.Read.All', 'User.Read.All']), {
    roles: [
      { value: 'AuditLogsQuery.Read.All', id: 'r1' },
      { value: 'User.Read.All', id: 'r2' },
    ],
    missing: [],
  });
  const withOptional = resolveAppRoles(sp, ['CopilotPackages.Read.All', 'User.Read.All'], ['CopilotPackages.Read.All']);
  assert.deepEqual(withOptional.missing, ['CopilotPackages.Read.All']);
  assert.deepEqual(withOptional.roles, [{ value: 'User.Read.All', id: 'r2' }]);
  assert.throws(() => resolveAppRoles(sp, ['Reports.Read.All']), /no application permission named Reports\.Read\.All/);
});

test('schedule body starts tomorrow and is compared on what matters', () => {
  const now = new Date('2026-03-31T22:15:00Z');
  const daily = scheduleBody({ frequency: 'daily', time: '02:00', weekday: 'Sunday', timeZone: 'GMT Standard Time' }, now);
  assert.deepEqual(daily, {
    enabled: true,
    configuration: {
      startDateTime: '2026-04-01T00:00:00',
      endDateTime: '2036-03-31T00:00:00',
      localTimeZoneId: 'GMT Standard Time',
      type: 'Daily',
      times: ['02:00'],
    },
  });
  const weekly = scheduleBody({ frequency: 'weekly', time: '06:30', weekday: 'Monday', timeZone: 'UTC' }, now);
  assert.deepEqual(weekly.configuration.weekdays, ['Monday']);
  assert.equal(weekly.configuration.type, 'Weekly');

  const fromApi = { id: 's', enabled: true, owner: {}, configuration: { ...daily.configuration, startDateTime: '2025-01-01T00:00:00' } };
  assert.equal(sameSchedule(fromApi, daily), true, 'start date is ignored');
  assert.equal(sameSchedule({ ...fromApi, enabled: false }, daily), false);
  assert.equal(sameSchedule({ ...fromApi, configuration: { ...fromApi.configuration, times: ['03:00'] } }, daily), false);
  assert.equal(sameSchedule({ ...fromApi, configuration: { ...weekly.configuration, weekdays: ['Friday'] } }, weekly), false);
  assert.equal(describeSchedule({ frequency: 'weekly', time: '06:30', weekday: 'Monday', timeZone: 'UTC' }), 'every Monday at 06:30 UTC');
  assert.equal(describeSchedule({ frequency: 'daily', time: '02:00', weekday: 'Sunday', timeZone: 'UTC' }), 'daily at 02:00 UTC');
});

test('Fabric definitions and job parameters', () => {
  const def = notebookDefinition('{"cells":[]}');
  assert.equal(def.format, 'ipynb');
  assert.equal(def.parts[0].path, 'notebook-content.ipynb');
  assert.equal(Buffer.from(def.parts[0].payload, 'base64').toString('utf8'), '{"cells":[]}');
  assert.deepEqual(notebookJobParameters({ MODE: 'backfill', DAYS: 30, RATE: 0.5, ON: true }), {
    MODE: { value: 'backfill', type: 'string' },
    DAYS: { value: 30, type: 'int' },
    RATE: { value: 0.5, type: 'float' },
    ON: { value: true, type: 'bool' },
  });
});

test('job helpers read Fabric times as UTC and take the job ID from its URL', () => {
  assert.equal(utc('2026-05-01T02:00:13.123')?.toISOString(), '2026-05-01T02:00:13.123Z');
  assert.equal(utc('2026-05-01T02:00:13Z')?.toISOString(), '2026-05-01T02:00:13.000Z');
  assert.equal(utc('2026-05-01T03:00:13+01:00')?.toISOString(), '2026-05-01T02:00:13.000Z');
  assert.equal(utc(null), undefined);
  assert.equal(jobIdFrom('https://api.fabric.microsoft.com/v1/workspaces/w/items/i/jobs/instances/j-123'), 'j-123');
  assert.equal(jobIdFrom('/workspaces/w/items/i/jobs/instances/j-9/'), 'j-9');
});

test('addMonths, addDays, notebookSecretDays and formatDuration', () => {
  assert.equal(addMonths(new Date('2026-01-15T10:00:00Z'), 12).toISOString(), '2027-01-15T10:00:00.000Z');
  assert.equal(addDays(new Date('2026-06-01T12:00:00Z'), 90).toISOString(), '2026-08-30T12:00:00.000Z');
  const config = emptyConfig();
  assert.equal(notebookSecretDays(config), 90);
  config.app.secretDays = 14;
  assert.equal(notebookSecretDays(config), 14);
  assert.equal(formatDuration(4_000), '4s');
  assert.equal(formatDuration(125_000), '2m 05s');
  assert.equal(formatDuration(3_780_000), '1h 03m');
});

test('parseCli: commands, sign-in methods and validation', () => {
  const d = parseCli([]);
  assert.equal(d.command, 'install');
  assert.equal(d.method, 'browser');
  assert.equal(d.wait, true);
  assert.equal(d.yes, false);
  assert.match(d.configFile, /consumption-central-setup\.json$/);

  const r = parseCli(['run', '--use-az', '-y', '--no-wait', '--config', 'x.json']);
  assert.equal(r.command, 'run');
  assert.equal(r.method, 'azure-cli');
  assert.equal(r.yes, true);
  assert.equal(r.wait, false);
  assert.match(r.configFile, /x\.json$/);

  assert.equal(parseCli(['--dry-run']).command, 'preview');
  assert.equal(parseCli(['check']).command, 'check');
  assert.equal(parseCli(['--device-code']).method, 'device-code');
  assert.throws(() => parseCli(['nope']), /Unknown command "nope"/);
  assert.throws(() => parseCli(['run', 'extra']), /Unexpected argument: extra/);
  assert.throws(() => parseCli(['--device-code', '--use-az']), /Choose one/);
  assert.throws(() => parseCli(['run', '--backfill-days', '30']), /Unknown option '--backfill-days'/, 'there is no history to reload');
  assert.throws(() => parseCli(['--bogus']), /Unknown option/);
});

test('install record round-trips, fills defaults and refuses secrets', () => {
  const file = join(dir, 'consumption-central-setup.json');
  assert.equal(loadConfig(file).existed, false);

  const config = emptyConfig();
  config.tenantId = 't';
  config.fabric.workspaceId = 'w';
  config.fabric.notebooks.vivaConsumption = 'nb';
  saveConfig(file, config);
  const { config: back, existed } = loadConfig(file);
  assert.equal(existed, true);
  assert.deepEqual(back, config);

  writeFileSync(file, JSON.stringify({ version: 1, product: 'consumption-central', schedule: { time: '05:00' }, dataSources: { github: 'csv' } }));
  const partial = loadConfig(file).config;
  assert.equal(partial.schedule.time, '05:00');
  assert.equal(partial.schedule.frequency, 'daily');
  assert.deepEqual(partial.dataSources, { ...emptyConfig().dataSources, github: 'csv' });
  assert.deepEqual(partial.fabric.notebooks, {});

  const leaky = /** @type {any} */ (emptyConfig());
  leaky.app.clientSecret = 'abc';
  assert.throws(() => saveConfig(file, leaky), /Refusing to keep a secret/);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).schedule.time, '05:00', 'the old record is untouched');

  writeFileSync(file, JSON.stringify({ version: 2, product: 'consumption-central' }));
  assert.throws(() => loadConfig(file), /version 2/);
  writeFileSync(file, '{not json');
  assert.throws(() => loadConfig(file), /not valid JSON/);

  writeFileSync(file, JSON.stringify({ version: 1, product: 'consumption-central', dataSources: { azureAi: 'csv' }, uploads: { studioFlow: true } }));
  const older = loadConfig(file).config;
  assert.equal(older.dataSources.azureAi, 'skip', 'a mode the source doesn\'t have falls back to its default');
  assert.equal(older.dataSources.studioCredits, 'api', 'an older record\'s Studio flow is the API mode');
  assert.deepEqual(older.uploads, {});
});

test('messages name the exe when it started the installer', () => {
  const exe = { [EXE_ENV]: '1' };
  assert.equal(fromExe({}), false);
  assert.equal(fromExe({ [EXE_ENV]: '0' }), false);
  assert.equal(fromExe(exe), true);
  assert.equal(commandLine('status', {}), 'consumption-central-installer status');
  assert.equal(commandLine('status', exe), 'ConsumptionCentralInstaller.exe status');
  assert.equal(commandLine('', exe), 'ConsumptionCentralInstaller.exe');
  assert.equal(installerWindow({}), 'your terminal');
  assert.equal(installerWindow(exe), 'the installer window');
  assert.match(help(), /Usage: (consumption-central-installer|ConsumptionCentralInstaller\.exe) \[command\] \[options\]/);
});

test('messages name the PowerShell command when install.ps1 started the installer', () => {
  const pwsh = { [LAUNCHER_ENV]: 'pwsh' };
  assert.equal(launcher({}), 'node');
  assert.equal(launcher(pwsh), 'pwsh');
  assert.equal(launcher({ [EXE_ENV]: '1', [LAUNCHER_ENV]: 'pwsh' }), 'exe', 'the exe wins if both are set');
  assert.equal(fromExe(pwsh), false);
  assert.equal(bundled(pwsh), true);
  assert.equal(bundled({ [EXE_ENV]: '1' }), true);
  assert.equal(bundled({}), false);
  assert.equal(commandLine('status', pwsh), '& $env:LOCALAPPDATA\\ConsumptionCentral\\consumption-central.cmd status');
  assert.equal(installerWindow(pwsh), 'the PowerShell window');
  assert.match(reopenHint(pwsh), /consumption-central\.cmd in PowerShell/);
  assert.match(reopenHint({ [EXE_ENV]: '1' }), /ConsumptionCentralInstaller\.exe/);
  assert.match(reopenHint({}), /consumption-central-installer --ui/);

  // install.ps1 comes from a named installer release: the repo's latest release can be a dashboard release.
  assert.equal(scriptUrl('0.2.0'), 'https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/releases/download/consumption-central-installer-v0.2.0/install.ps1');
  assert.equal(SCRIPT_URL, scriptUrl(VERSION), "this release's own script");
  assert.equal(SCRIPT_COMMAND, `irm ${SCRIPT_URL} | iex`);

  const update = { version: '0.2.0', url: 'https://example.test/r' };
  const next = 'irm https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/releases/download/consumption-central-installer-v0.2.0/install.ps1 | iex';
  const hint = updateHint(update, pwsh);
  assert.equal(hint, `Close the installer and run "${next}" in PowerShell, then choose Repair or change.`);
  assert.ok(!hint.includes(SCRIPT_URL), "this release's script would start this version again");
  assert.equal(updateHint(update, {}), 'Download it from https://example.test/r, then choose Repair or change.');
  assert.equal(updateHint(update, { [EXE_ENV]: '1' }), 'Download it from https://example.test/r, then choose Repair or change.');
});

test('messages keep -UseInstalledNode when install.ps1 ran the installer with the installed Node.js', () => {
  const installed = { [LAUNCHER_ENV]: 'pwsh', [INSTALLED_NODE_ENV]: '1' };
  assert.equal(INSTALLED_NODE_ENV, 'CONSUMPTION_CENTRAL_USE_INSTALLED_NODE');
  assert.equal(bundled(installed), true, "the installer is still the zip's");
  assert.ok(reopenHint(installed).includes(`"$env:CONSUMPTION_CENTRAL_USE_INSTALLED_NODE = '1'; ${SCRIPT_COMMAND}" again`));
  const update = { version: '0.2.0', url: 'https://example.test/r' };
  const next = 'irm https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/releases/download/consumption-central-installer-v0.2.0/install.ps1 | iex';
  assert.equal(updateHint(update, installed), `Close the installer and run "$env:CONSUMPTION_CENTRAL_USE_INSTALLED_NODE = '1'; ${next}" in PowerShell, then choose Repair or change.`);
  assert.ok(!updateHint(update, installed).includes(SCRIPT_URL));
  assert.doesNotMatch(reopenHint({ [LAUNCHER_ENV]: 'pwsh' }), /INSTALLED_NODE/);
  assert.doesNotMatch(reopenHint({ [LAUNCHER_ENV]: 'cloudshell', [INSTALLED_NODE_ENV]: '1' }), /INSTALLED_NODE/);
  assert.doesNotMatch(reopenHint({ [EXE_ENV]: '1', [INSTALLED_NODE_ENV]: '1' }), /INSTALLED_NODE/);
  assert.doesNotMatch(updateHint(update, { [LAUNCHER_ENV]: 'pwsh' }), /INSTALLED_NODE/);
  assert.doesNotMatch(updateHint(update, { [LAUNCHER_ENV]: 'cloudshell', [INSTALLED_NODE_ENV]: '1' }), /INSTALLED_NODE/);
  assert.doesNotMatch(updateHint(update, { [EXE_ENV]: '1', [INSTALLED_NODE_ENV]: '1' }), /INSTALLED_NODE/);
});

test('in Azure Cloud Shell: noticed from its environment, with commands for its shell', () => {
  const cs = { [LAUNCHER_ENV]: 'cloudshell' };
  assert.equal(inCloudShell({}), false);
  assert.equal(inCloudShell(cs), true);
  assert.equal(inCloudShell({ AZUREPS_HOST_ENVIRONMENT: 'cloud-shell/1.0' }), true);
  assert.equal(inCloudShell({ ACC_CLOUD: 'PROD' }), true);
  assert.equal(inCloudShell({ [CLOUD_SHELL_ENV]: '1' }), true);
  assert.equal(inCloudShell({ [CLOUD_SHELL_ENV]: '0', ACC_CLOUD: 'PROD' }), false, 'the override wins');
  assert.equal(launcher(cs), 'cloudshell');
  assert.equal(bundled(cs), false, 'it runs from source');
  assert.equal(commandLine('status', cs), '~/.consumption-central/consumption-central status');
  assert.equal(installerWindow(cs), 'Cloud Shell');
  assert.match(reopenHint(cs), /~\/\.consumption-central\/consumption-central in Cloud Shell/);
  const hint = updateHint({ version: '0.2.0', url: 'https://example.test/r' }, cs);
  assert.equal(
    hint,
    'Run "irm https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/releases/download/consumption-central-installer-v0.2.0/install.ps1 | iex" in Cloud Shell\'s PowerShell, then install to repair or change.',
  );
  assert.ok(!hint.includes(SCRIPT_URL), "this release's script would start this version again");
});

test('parseCli: in Azure Cloud Shell, signs in with a code and stays in the terminal', () => {
  const cs = { ACC_CLOUD: 'PROD' };
  assert.equal(parseCli([], cs).method, 'device-code');
  assert.equal(parseCli([], cs).cloudShell, true);
  assert.equal(parseCli(['--use-az'], cs).method, 'azure-cli');
  assert.equal(parseCli([], {}).method, 'browser');
  assert.equal(parseCli([], {}).cloudShell, false);
  assert.throws(() => parseCli(['--ui'], cs), /Leave out --ui/);
  assert.doesNotThrow(() => parseCli(['--ui'], {}));
});