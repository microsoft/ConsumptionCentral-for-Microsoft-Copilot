// @ts-check
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { notebooksFor, permissionsFor } from '../src/catalog.js';
import { flowDefinitions, flowsWanted } from '../src/steps/flows.js';
import { refreshConfig, RUNNER_DIR } from '../src/steps/pax/local.js';
import { notebookSettings } from '../src/steps/notebook-settings.js';
import { requiredPermissions } from '../src/target.js';
import { buildPipeline, REFRESH_ACTIVITY } from '../src/transform/pipeline.js';
import { defaultDataSources } from '../src/uploads.js';
import { fakeCtx, realSources } from './fakes.js';

test('Graph beta is opt-in, app-only and a hard prerequisite for model refresh', () => {
  const { ctx, config } = fakeCtx();
  config.dataSources = { ...defaultDataSources(), costManagement: 'api' };
  assert.deepEqual(permissionsFor(config.dataSources), ['CopilotCostManagement.Read.All']);
  const source = realSources().catalog.find((n) => n.key === 'costManagement');
  assert.ok(source);
  const settings = notebookSettings(ctx, source);
  assert.equal(settings.values?.CLIENT_ID, config.app.appId);
  assert.equal(settings.values?.TENANT_ID, ctx.user.tenantId);
  const selected = notebooksFor(realSources().catalog, config.dataSources);
  const pipeline = buildPipeline(selected, {
    workspaceId: 'fixture-workspace', modelId: 'fixture-model', dataSources: config.dataSources,
    notebookIds: Object.fromEntries(realSources().catalog.map((n) => [n.key, `id-${n.key}`])),
  });
  const refresh = pipeline.properties.activities.find((a) => a.name === REFRESH_ACTIVITY);
  assert.ok(refresh.dependsOn.some((/** @type {any} */ d) => d.activity === 'Run_Copilot_Cost_Management' && d.dependencyConditions.join() === 'Succeeded'));
  config.target = 'pax';
  assert.ok(requiredPermissions(config).includes('CopilotCostManagement.Read.All'));
});

test('No Fabric preview uses SharePoint connections, not OneLake or a vault', () => {
  const { config } = fakeCtx();
  config.tenantId = 'fixture-tenant';
  config.target = 'pax';
  config.keyVault.mode = 'notebook';
  config.uploads.flowIdentity = 'app';
  config.dataSources.studioCredits = 'reports';
  config.sharePoint = {
    folderUrl: 'https://example.sharepoint.com/sites/Analytics/Shared%20Documents/Reports',
    siteUrl: 'https://example.sharepoint.com/sites/Analytics', sitePath: 'example.sharepoint.com:/sites/Analytics',
    library: 'Shared Documents', folderPath: '/Reports',
  };
  assert.deepEqual(flowsWanted(config), ['studio', 'studioReports']);
  const definition = JSON.stringify(flowDefinitions(config, 'tenant').studioReports.definition);
  assert.match(definition, /shared_sharepointonline/);
  assert.match(definition, /Shared Documents\/Reports\/Files\/landing\/studio/);
  assert.doesNotMatch(definition, /shared_keyvault|onelake\.dfs\.fabric/);
  assert.equal(refreshConfig(config).studioReports, true);
});

test('scheduled Graph collector passes its token privately and uploads only after success', (t) => {
  if (spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { windowsHide: true }).status !== 0) {
    t.skip('PowerShell 7 is unavailable');
    return;
  }
  const python = execFileSync('python', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
  const folder = mkdtempSync(join(tmpdir(), 'cc-credit-runner-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const runner = join(folder, 'test.ps1');
  const fixture = fileURLToPath(new URL('./credit-runner.ps1', import.meta.url));
  writeFileSync(runner, readFileSync(fixture));
  const script = join(folder, 'pull_copilot_cost_management.py');
  const names = ['CopilotCostServiceDaily.csv', 'CopilotCostFundingMonthly.csv', 'CopilotCostBalance.csv'];
  writeFileSync(script, `import sys\nfrom pathlib import Path\nassert sys.stdin.read().strip() == 'fixture-token'\nassert 'fixture-token' not in sys.argv\nfor name in ${JSON.stringify(names)}:\n (Path(sys.argv[1])/name).write_text('complete', encoding='utf-8')\n`);
  const run = () => spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', runner, '-Source', join(RUNNER_DIR, 'refresh.ps1'), '-Python', python],
    { encoding: 'utf8', windowsHide: true });
  let result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /uploaded=3/);
  writeFileSync(script, "import sys\nsys.stdin.read()\nprint('fixture collection failure', file=sys.stderr)\nsys.exit(7)\n");
  result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /uploaded=0; failed=True/);
});
