// @ts-check
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { MANIFEST_FILE } from '../src/catalog.js';
import { APP_BUILD, DEFAULT_SOURCE_DIR, PAX_SCRIPTS, appDistOf, readJson } from '../src/sources.js';
import {
  APP_SAMPLE_MANIFEST, MANAGED_CLI_DIR, MAX_NATIVE_PATH, MAX_PAYLOAD_PATH, MIRROR_REGISTRY, PUBLIC_REGISTRY, appSampleFiles, fileVersion,
  installerFile, leakedIds, localIds, msalRuntimeArch, paxQueryFiles, payloadId, prunable, publicRegistry, sourceFiles, tooLong,
} from '../packaging/payload.js';
import { CLI_PACKAGE, CLI_PACKAGE_DIR, pinnedVersion } from '../src/managed-app/cli.js';

const manifest = () => readJson(join(DEFAULT_SOURCE_DIR, MANIFEST_FILE));

test('packaging: ships every template the installer reads, and they exist', () => {
  const files = sourceFiles(manifest());
  assert.ok(files.includes('installer-assets.json'));
  assert.ok(files.includes('2. Fabric/Consumption Central - Fabric.pbit'));
  assert.ok(files.includes('2. Fabric/notebooks/Ingest_Viva_Consumption.ipynb'));
  assert.ok(files.includes('2. Fabric/notebooks/Ingest_CommercialTerms.ipynb'));
  // The PAX route's template, and the query it swaps in, which it reads from beside the template.
  assert.ok(files.includes('3. Viva Direct/Consumption Central - Viva Direct.pbit'));
  assert.deepEqual(paxQueryFiles(), ['SourceFiles.SharePoint.m']);
  assert.ok(files.includes('3. Viva Direct/SourceFiles.SharePoint.m'));
  // Never deployed, so never shipped.
  assert.ok(!files.some((f) => f.endsWith('/Ingest_Studio_Consumption.ipynb')));
  assert.ok(!files.some((f) => f.startsWith('1. ')));
  // The helper notebooks ship with the installer code, not the source folder.
  assert.ok(!files.some((f) => f.includes('ConsumptionCentral_')));
  assert.ok(installerFile('assets/notebooks/ConsumptionCentral_Refresh_Model.ipynb'));
  assert.ok(files.every((f) => !f.includes('\\')));
  for (const f of files) assert.ok(existsSync(join(DEFAULT_SOURCE_DIR, f)), `${f} is missing`);
  assert.throws(() => sourceFiles({ ...manifest(), templates: { fabric: manifest().templates.fabric } }), /templates\.vivaDirect/);
});

test('packaging: ships the installer code, not its tests or tooling', () => {
  for (const f of ['bin/consumption-central-installer.js', 'src/cli.js', 'src/web/index.html', 'package.json', 'package-lock.json', 'README.md']) assert.ok(installerFile(f), f);
  for (const f of ['test/cli.test.js', 'packaging/build-exe.js', 'jsconfig.json', '.gitignore', 'consumption-central-setup.json']) assert.ok(!installerFile(f), f);
  // The scheduled PAX refresh's scripts, which the installer copies to the PC from there.
  for (const f of ['refresh.ps1', 'credential.ps1', 'task.ps1', ...PAX_SCRIPTS]) {
    const rel = `src/steps/pax/runner/${f}`;
    assert.ok(installerFile(rel), rel);
    assert.ok(existsSync(join(DEFAULT_SOURCE_DIR, 'installer', rel)), `${rel} is missing`);
  }
});

test('packaging: ships the pin for the managed apps CLI, which the build installs', () => {
  for (const f of ['package.json', 'package-lock.json']) assert.ok(installerFile(`${MANAGED_CLI_DIR}/${f}`), f);
  for (const f of ['node_modules/@microsoft/managed-apps-cli/package.json', 'README.md']) assert.ok(!installerFile(`${MANAGED_CLI_DIR}/${f}`), f);
  // The installer runs the CLI from there, so the payload's folder and the installer's must agree.
  assert.equal(join(DEFAULT_SOURCE_DIR, 'installer', MANAGED_CLI_DIR), CLI_PACKAGE_DIR);
  const lock = JSON.parse(readFileSync(join(CLI_PACKAGE_DIR, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[`node_modules/${CLI_PACKAGE}`]?.version, pinnedVersion(), 'package-lock.json installs the CLI that package.json pins');
  assert.equal(lock.packages['']?.dependencies?.[CLI_PACKAGE], pinnedVersion(), 'package-lock.json is up to date with package.json');
});

test('packaging: the app\'s build is the build folder in the app folder the manifest lists', () => {
  assert.equal(APP_BUILD, 'dist');
  assert.equal(appDistOf(manifest()), 'app/dist');
  assert.equal(appDistOf({ app: { path: 'apps\\cc' } }), 'apps/cc/dist');
  assert.equal(appDistOf({}), undefined);
  assert.ok(existsSync(join(DEFAULT_SOURCE_DIR, manifest().app.path, 'package.json')));
});

test('packaging: the app\'s sample is committed, and the app fetches what its list names', () => {
  // The build copies the app's public folder, sample and all, into the build the exe ships.
  const pub = join(DEFAULT_SOURCE_DIR, manifest().app.path, 'public');
  const names = JSON.parse(readFileSync(join(pub, APP_SAMPLE_MANIFEST), 'utf8'));
  assert.ok(Array.isArray(names) && names.length && names.every((n) => typeof n === 'string' && n.endsWith('.csv')));
  const files = appSampleFiles(names);
  assert.equal(files[0], APP_SAMPLE_MANIFEST);
  assert.equal(files.length, names.length + 1);
  for (const f of files) assert.ok(existsSync(join(pub, f)), `${f} is missing`);
  // The org file the PAX route writes is one of them, so the sample shows what it adds.
  assert.ok(names.includes('entra_org.csv'));
  // The app fetches the list, then each file on it, from the folder the list is in.
  const load = readFileSync(join(DEFAULT_SOURCE_DIR, manifest().app.path, 'src', 'data', 'load.ts'), 'utf8');
  assert.ok(load.includes('const base = `${import.meta.env.BASE_URL}sample/`'));
  assert.ok(load.includes('fetch(`${base}manifest.json`)'));
  assert.ok(load.includes('fetch(base + name)'));
  assert.equal(APP_SAMPLE_MANIFEST, 'sample/manifest.json');
});

test('packaging: payload IDs change with the content', () => {
  assert.equal(payloadId('0.2.0', 'abcdef0123456789'), '0.2.0-abcdef0123');
  assert.notEqual(payloadId('0.2.0', 'abcdef0123456789'), payloadId('0.2.0', 'abcdef0124456789'));
});

test('packaging: file versions take four numbers', () => {
  assert.equal(fileVersion('0.2.0'), '0.2.0.0');
  assert.equal(fileVersion('1.10.3-beta.1'), '1.10.3.0');
  assert.throws(() => fileVersion('1.2'), /file version/);
  assert.throws(() => fileVersion('1.x.0'), /file version/);
  assert.throws(() => fileVersion('1.2.70000'), /file version/);
});

test('packaging: long paths are caught, with a tighter limit for native binaries', () => {
  const ok = 'f/installer/src/cli.js';
  const long = `f/app/node_modules/${'x'.repeat(MAX_PAYLOAD_PATH)}`;
  const addon = `f/app/node_modules/${'x'.repeat(MAX_NATIVE_PATH)}/a.node`;
  const deepJs = `f/app/node_modules/${'x'.repeat(MAX_NATIVE_PATH)}/a.js`;
  assert.ok(MAX_NATIVE_PATH < MAX_PAYLOAD_PATH);
  assert.deepEqual(tooLong([ok, long, addon, deepJs]), [long, addon]);
  assert.deepEqual(tooLong([ok, 'node/node.exe'], { max: 10, native: 100 }), [ok]);
});

test('packaging: source maps in installed packages are left out', () => {
  for (const f of ['f/app/node_modules/a/index.js.map', 'f/installer/node_modules/@s/b/build/x.d.ts.map']) assert.ok(prunable(f), f);
  for (const f of ['f/app/public/assets/index.js.map', 'f/app/node_modules/a/index.js', 'f/installer/node_modules/a/map.js', 'f/x.map']) {
    assert.ok(!prunable(f), f);
  }
});

test('packaging: the sign-in broker keeps only the Windows binaries for the build\'s architecture', () => {
  const runtime = `f/installer/${MANAGED_CLI_DIR}/node_modules/@azure/msal-node-runtime`;
  const other = [
    'dist/macos/arm64/msal-node-runtime.node', 'dist/macos/x64/libmsalruntime.dylib', 'dist/linux/ubuntu/x64/msal-node-runtime.node',
    'dist/linux/rhel10/x64/libmsalruntime.so', 'dist/windows/x86/msalruntime_x86.dll', 'dist/windows/arm64/msal-node-runtime.node',
  ];
  for (const f of other) assert.ok(prunable(`${runtime}/${f}`, 'x64'), f);
  const kept = ['dist/windows/x64/msal-node-runtime.node', 'dist/windows/x64/msalruntime.dll', 'dist/index.cjs', 'dist/index.d.ts', 'package.json', 'LICENSE'];
  for (const f of kept) assert.ok(!prunable(`${runtime}/${f}`, 'x64'), f);
  assert.ok(!prunable(`${runtime}/dist/windows/arm64/msal-node-runtime.node`, 'arm64'));
  assert.ok(prunable(`${runtime}/dist/windows/x64/msal-node-runtime.node`, 'arm64'));
  assert.ok(!prunable(`${runtime}/dist/windows/x86/msalruntime_x86.dll`, 'ia32'));
  assert.equal(msalRuntimeArch('ia32'), 'x86');
  // Only that package: other packages' platform folders stay. A nested copy of it is pruned too.
  for (const f of ['f/installer/node_modules/foo/dist/linux/x.so', `f/installer/${MANAGED_CLI_DIR}/node_modules/@azure/msal-node/dist/macos/x.js`]) {
    assert.ok(!prunable(f, 'x64'), f);
  }
  assert.ok(prunable(`f/installer/${MANAGED_CLI_DIR}/node_modules/@microsoft/managed-apps-cli/node_modules/@azure/msal-node-runtime/${other[0]}`, 'x64'));
  // The binaries kept fit under the tighter limit for native binaries.
  assert.deepEqual(tooLong(kept.filter((f) => f.endsWith('.node')).map((f) => `${runtime}/${f}`)), []);
});

test('packaging: IDs from local settings are caught, public ones are not', () => {
  const graph = '00000003-0000-0000-C000-000000000000';
  const ws = 'aaaa1111-1111-2222-3333-444455556666';
  const ids = localIds([`workspace: ${ws.toUpperCase()}\napp: ${graph}`], [graph]);
  assert.deepEqual([...ids], [ws]);
  assert.deepEqual(leakedIds(`const a="${ws}";const b="${graph}";const c="${ws}"`, ids), [ws]);
  assert.deepEqual(leakedIds('nothing here', ids), []);
});

test('packaging: lock files are pointed at the public registry', () => {
  const lock = JSON.stringify({ packages: { 'node_modules/a': { resolved: `${MIRROR_REGISTRY}a/-/a-1.0.0.tgz` } } });
  assert.equal(JSON.parse(publicRegistry(lock)).packages['node_modules/a'].resolved, `${PUBLIC_REGISTRY}a/-/a-1.0.0.tgz`);
  assert.equal(publicRegistry(publicRegistry(lock)), publicRegistry(lock));
});

test('packaging: the lock-file rewrite loads before npm ci', () => {
  // CI runs public-registry.js before installing dependencies, so neither it nor what it imports
  // may reach the installer source (which imports npm packages).
  for (const file of ['public-registry.js', 'registry.js']) {
    const src = readFileSync(new URL(`../packaging/${file}`, import.meta.url), 'utf8');
    const imports = [...src.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.deepEqual(imports.filter((s) => !s.startsWith('node:') && s !== './registry.js'), [], `${file} imports more than Node built-ins`);
  }
});
