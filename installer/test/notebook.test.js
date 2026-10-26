// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cellText,
  findAssignmentCell,
  prepareNotebook,
  pyString,
  serialiseNotebook,
  setAssignment,
  toSourceLines,
} from '../src/transform/notebook.js';
import { COWORK_TASKS_DIR, uploadKind, VIVA_DIR } from '../src/uploads.js';
import { realSources } from './fakes.js';

/** @typedef {import('../src/catalog.js').NotebookKey} NotebookKey */

const { catalog, notebooks } = realSources();
/** The notebook as the source folder has it. @param {NotebookKey} key */
const load = (key) => notebooks[key];
/** @param {NotebookKey} key */
const consumption = (key) => /** @type {import('../src/catalog.js').NotebookInfo} */ (catalog.find((n) => n.key === key));
/** @param {string} name */
const kind = (name) => /** @type {import('../src/uploads.js').UploadKind} */ (uploadKind(name));

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SECRET = { vaultUri: 'https://kv-consumption-test.vault.azure.net/', secretName: 'consumption-central-client-secret' };
const LAKEHOUSE = { id: '99999999-0000-0000-0000-000000000001', name: 'ConsumptionCentral', workspaceId: '88888888-0000-0000-0000-000000000002' };

test('setAssignment keeps the comment column', () => {
  const src = "TENANT_ID     = '<your-tenant-guid>'                  # Entra -> Overview\nOTHER = 1\n";
  const out = setAssignment(src, 'TENANT_ID', pyString(TENANT));
  const line = out.split('\n')[0];
  assert.equal(line, `TENANT_ID     = '${TENANT}'  # Entra -> Overview`);
  assert.ok(out.endsWith('OTHER = 1\n'));
});

test('setAssignment pads to the original comment column when the value is shorter', () => {
  const out = setAssignment("MODE          = 'incremental'   # load mode\n", 'MODE', "'x'");
  assert.equal(out, "MODE          = 'x'             # load mode\n");
});

test('setAssignment ignores commented-out lines and replaces a comment when asked', () => {
  const src = "# CLIENT_SECRET = getSecret('a', 'b')\nCLIENT_SECRET = '<value>'  # old\n";
  const out = setAssignment(src, 'CLIENT_SECRET', 'secret()', { comment: 'new', before: 'import x' });
  assert.equal(out, "# CLIENT_SECRET = getSecret('a', 'b')\nimport x\nCLIENT_SECRET = secret()  # new\n");
});

test('setAssignment handles values without comments and fails loudly when missing', () => {
  assert.equal(setAssignment('TIMEOUT_MINUTES = 120\n', 'TIMEOUT_MINUTES', '170'), 'TIMEOUT_MINUTES = 170\n');
  assert.throws(() => setAssignment('X = 1', 'TENANT_ID', "'t'"), /TENANT_ID/);
});

test('pyString escapes quotes and backslashes', () => {
  assert.equal(pyString("a'b\\c"), "'a\\'b\\\\c'");
});

test('toSourceLines matches Jupyter line storage', () => {
  assert.deepEqual(toSourceLines('a\nb\n'), ['a\n', 'b\n']);
  assert.deepEqual(toSourceLines('a\nb'), ['a\n', 'b']);
  assert.deepEqual(toSourceLines(''), []);
});

for (const info of catalog.filter((n) => n.credentials)) {
  test(`${info.displayName}: credentials come from Key Vault`, () => {
    const source = load(info.key);
    const before = JSON.stringify(source);
    const nb = prepareNotebook(source, { tenantId: TENANT, clientId: CLIENT, secret: SECRET, lakehouse: LAKEHOUSE });
    assert.equal(JSON.stringify(source), before, 'source notebook must not change');

    const all = nb.cells.map(cellText).join('\n');
    assert.match(all, new RegExp(`^TENANT_ID\\s*=\\s*'${TENANT}'`, 'm'));
    assert.match(all, new RegExp(`^CLIENT_ID\\s*=\\s*'${CLIENT}'`, 'm'));
    assert.match(
      all,
      /^import notebookutils\nCLIENT_SECRET\s*=\s*notebookutils\.credentials\.getSecret\('https:\/\/kv-consumption-test\.vault\.azure\.net\/', 'consumption-central-client-secret'\)/m,
    );
    assert.doesNotMatch(all, /^CLIENT_SECRET\s*=\s*['"]/m, 'no literal secret left');
    assert.doesNotMatch(all, /^(TENANT_ID|CLIENT_ID)\s*=\s*['"]</m, 'no placeholder left');
    assert.equal(nb.metadata.dependencies.lakehouse.default_lakehouse, LAKEHOUSE.id);
    assert.equal(nb.metadata.dependencies.lakehouse.default_lakehouse_workspace_id, LAKEHOUSE.workspaceId);
  });
}

test('the notebooks the installer fills in credentials for are Studio and Org Graph', () => {
  assert.deepEqual(catalog.filter((n) => n.credentials).map((n) => n.key), ['studioConsumption', 'orgGraph']);
});

for (const info of catalog.filter((n) => n.parameters.length)) {
  test(`${info.displayName}: one cell is tagged parameters`, () => {
    const nb = prepareNotebook(load(info.key), { parameters: info.parameters });
    const tagged = nb.cells.filter((cell) => cell.metadata?.tags?.includes('parameters'));
    assert.equal(tagged.length, 1);
    for (const p of info.parameters) assert.match(cellText(tagged[0]), new RegExp(`^${p}\\s*=`, 'm'));
  });
}

test('every notebook in the catalogue exists and parses', () => {
  assert.deepEqual(Object.keys(notebooks).sort(), catalog.map((n) => n.key).sort());
  for (const info of catalog) {
    const nb = load(info.key);
    assert.ok(Array.isArray(nb.cells) && nb.cells.length > 0, info.displayName);
  }
});

test('notebooks without credentials have none to fill in', () => {
  for (const info of catalog.filter((n) => !n.credentials)) {
    assert.equal(findAssignmentCell(load(info.key), 'CLIENT_SECRET'), -1, info.displayName);
  }
});

test('serialiseNotebook round-trips', () => {
  const nb = prepareNotebook(load('orgGraph'), { tenantId: TENANT, clientId: CLIENT, secret: SECRET });
  assert.deepEqual(JSON.parse(serialiseNotebook(nb)), nb);
});

test('credentials must be given together', () => {
  assert.throws(() => prepareNotebook(load('orgGraph'), { tenantId: TENANT }), /together/);
});

test('Viva consumption: reads the Dataflow table, the CSVs and Cowork task exports, and ends quietly with none', () => {
  const info = consumption('vivaConsumption');
  assert.deepEqual([info.values, info.expressionNames, info.patchFinds], [[], [], []], 'the installer only sets the Lakehouse');
  const nb = prepareNotebook(load('vivaConsumption'), { lakehouse: LAKEHOUSE });
  const all = nb.cells.map(cellText).join('\n');
  assert.match(all, /DATAFLOW_TABLE = "viva_credits_dataflow"/);
  assert.match(all, /spark\.catalog\.tableExists\(DATAFLOW_TABLE\)/);
  assert.match(all, /landing_present = notebookutils\.fs\.exists\(LANDING\)\nlanding_files = viva_landing_files\(notebookutils\.fs, LANDING\) if landing_present else \[\]/);
  assert.match(all, /^ALLOW_EMPTY_LANDING = True/m);
  assert.match(
    all,
    /if raw is None and not task_files:\n\s+message = f"No Viva consumption or Cowork task export in \{LANDING\} or \{DATAFLOW_TABLE\}, so nothing to load\."\n\s+if not ALLOW_EMPTY_LANDING:\n\s+raise ValueError\(message\)\n\s+notebookutils\.notebook\.exit\(message\)/,
  );
  assert.match(all, /policy_files = \[p for p in top_level_files if p\.rsplit\("\/", 1\)\[-1\]\.lower\(\)\.startswith\("spendingpolicymetadata"\)\]/);
  assert.match(all, /\nif policy_files:\n/);
  assert.doesNotMatch(all, /raise ValueError\(f'No PersonServiceCreditsMetrics/);
  assert.equal(nb.metadata.dependencies.lakehouse.default_lakehouse, LAKEHOUSE.id);
});

test('Viva consumption: reads each Viva export where the installer lands it', () => {
  const all = load('vivaConsumption').cells.map(cellText).join('\n');
  assert.equal(/^LANDING = "([^"]+)"/m.exec(all)?.[1], VIVA_DIR);
  assert.equal(consumption('vivaConsumption').landing, VIVA_DIR);
  /** The notebook's task_key: lower case, letters and digits only. @param {string} name */
  const taskKey = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Credits and policy exports are read from the top of LANDING only.
  assert.match(all, /files = \[p for p in top_level_files if p\.rsplit\("\/", 1\)\[-1\]\.lower\(\)\.startswith\("personservicecreditsmetrics"\)\]/);
  for (const [k, prefix] of [['vivaCredits', 'personservicecreditsmetrics'], ['vivaPolicy', 'spendingpolicymetadata']]) {
    assert.equal(kind(k).dir, VIVA_DIR, k);
    assert.ok(kind(k).name.toLowerCase().startsWith(prefix), k);
  }

  // A Cowork task export is found anywhere under LANDING except in _ and . folders, and its
  // PeopleMetaData.csv in the same folder.
  assert.match(all, /def task_key\(name\):\n\s+return re\.sub\("\[\^a-z0-9\]", "", name\.lower\(\)\)/);
  assert.match(all, /if entry\.name\.startswith\(\("_", "\."\)\):\n\s+continue/);
  assert.match(all, /task_files = \[p for p in landing_files if task_key\(p\.rsplit\("\/", 1\)\[-1\]\)\.startswith\("coworkweeklymetrics"\)\]/);
  assert.match(all, /p\.rsplit\("\/", 1\)\[0\] == path\.rsplit\("\/", 1\)\[0\]\n\s+and p\.rsplit\("\/", 1\)\[-1\]\.lower\(\) == "peoplemetadata\.csv"/);
  const tasks = kind('coworkTasks');
  const people = kind('coworkPeople');
  assert.equal(tasks.dir, COWORK_TASKS_DIR);
  assert.equal(people.dir, tasks.dir, 'the companion sits beside the task export');
  assert.ok(COWORK_TASKS_DIR.startsWith(`${VIVA_DIR}/`));
  for (const folder of COWORK_TASKS_DIR.slice(VIVA_DIR.length + 1).split('/')) assert.doesNotMatch(folder, /^[_.]/);
  assert.ok(taskKey(tasks.name).startsWith('coworkweeklymetrics'), tasks.name);
  assert.equal(people.name.toLowerCase(), 'peoplemetadata.csv');
});

test('Studio consumption: licensing API files fill studio_agent_daily and never replace an export', () => {
  const nb = prepareNotebook(load('studioConsumption'), { lakehouse: LAKEHOUSE });
  const all = nb.cells.map(cellText).join('\n');
  // Off as shipped: the installer turns it on when the flow writes the files (Studio credits = api).
  assert.match(all, /^READ_API_FILES = False/m);
  assert.match(all, /if api and not READ_API_FILES:/);
  assert.match(all, /PAT_API_AGENT = \("StudioApiAgentDaily\*\.csv",\)/);
  assert.match(all, /PAT_API_ENTITLEMENT = \("StudioApiEntitlement\*\.csv",\)/);
  assert.match(all, /TBL_AGENT_DAILY = "studio_agent_daily"/);
  assert.match(all, /api_raw = read\(\*PAT_API_AGENT, api=True\)\nif api_raw is None:\n\s+print\("no licensing API files - skipping"\)/);
  // Environment names come from the entitlement snapshot when the resources call has none.
  assert.match(all, /rows\.join\(names, "environment_id", "left"\)/);
  // Months and days an export covers keep the export's figures.
  assert.match(all, /an export covers this month, so the API figures aren't used/);
  assert.match(all, /tenant_api\.alias\("t"\)\n\s+\.join\(exported\.alias\("s"\), F\.expr\(same\(\["usage_date", "environment_id"\]\)\), "left_anti"\)/, 'an export row with no environment ID covers the API row with none');
  assert.match(all, /return " AND "\.join\(f"\{a\}\.\{c\} <=> \{b\}\.\{c\}" for c in columns\)/, 'same() compares null-safely');
  assert.match(all, /no entitlement snapshot - treating every credit as prepaid/);
});

test('Studio consumption: per-user API files fill studio_user_daily, look up UPNs without failing, and roll up only months no export covers', () => {
  const info = consumption('studioConsumption');
  assert.equal(info.credentials, true, 'the installer fills in the app, for the Graph lookup');
  const nb = prepareNotebook(load('studioConsumption'), { lakehouse: LAKEHOUSE, tenantId: TENANT, clientId: CLIENT, secret: SECRET });
  const all = nb.cells.map(cellText).join('\n');
  assert.match(all, new RegExp(`^TENANT_ID = '${TENANT}'`, 'm'));
  assert.match(all, /^CLIENT_SECRET = notebookutils\.credentials\.getSecret\('https:\/\/kv-consumption-test\.vault\.azure\.net\/', 'consumption-central-client-secret'\)/m);
  assert.match(all, /PAT_API_USER = \("StudioApiUserDaily\*\.csv",\)/);
  assert.match(all, /TBL_USER_DAILY = "studio_user_daily"/);
  assert.match(all, /user_raw = read\(\*PAT_API_USER, api=True\)\nif user_raw is None:\n\s+print\("no licensing API user files - skipping"\)/);
  assert.match(all, /graph\.microsoft\.com\/v1\.0\/\$batch/);
  assert.match(all, /except Exception as e:\n\s+print\(f" {2}UPN lookup skipped: \{e\}"\)/, 'a failed lookup never fails the run');
  assert.match(all, /an export covers this month, so the API user figures aren't used/);
  assert.match(all, /replace_rows\(umonthly, TBL_USER, f"\{date_in\('snapshot_month', user_months\)\} AND source_file = '\{API_SOURCE\}'"\)/);
  assert.match(all, /write_export\(user, TBL_USER, \["snapshot_month", "user_id", "agent_id"\], covers=\["snapshot_month"\]\)/, 'an export replaces the API rollup for its month');
  assert.match(all, /api = f"t\.source_file IN \('\{API_SOURCE\}', '\{API_USER_SOURCE\}'\)"[\s\S]*?F\.expr\(f"\{same\(covers\)\} AND \{api\}"\)/, 'the export drops the API rows it covers in the same write');
  // The per-user cell runs after the per-agent one, which it takes agent names from.
  assert.ok(all.indexOf('user_raw = read(') > all.indexOf('api_raw = read('));
});

test('a patch that no longer matches exactly once is an error', () => {
  assert.throws(() => prepareNotebook(load('vivaConsumption'), { patches: [{ find: 'no such text', replace: '' }] }), /found it 0 times/);
  assert.throws(() => prepareNotebook(load('vivaConsumption'), { patches: [{ find: 'LANDING', replace: '' }] }), /LANDING/);
});

test('Azure AI: the subscription, app and Key Vault secret are filled in', () => {
  const nb = prepareNotebook(load('azureAi'), {
    values: { SUBSCRIPTION_ID: TENANT, TENANT_ID: TENANT, CLIENT_ID: CLIENT, KEY_VAULT_URL: SECRET.vaultUri, CLIENT_SECRET_NAME: SECRET.secretName },
  });
  const all = nb.cells.map(cellText).join('\n');
  assert.match(all, new RegExp(`^SUBSCRIPTION_ID = '${TENANT}'`, 'm'));
  assert.match(all, new RegExp(`^CLIENT_ID = '${CLIENT}'`, 'm'));
  assert.match(all, /^KEY_VAULT_URL = 'https:\/\/kv-consumption-test\.vault\.azure\.net\/'/m);
  assert.match(all, /^CLIENT_SECRET_NAME = 'consumption-central-client-secret'/m);
  assert.match(all, /notebookutils\.credentials\.getSecret\(KEY_VAULT_URL, CLIENT_SECRET_NAME\)/);
});
