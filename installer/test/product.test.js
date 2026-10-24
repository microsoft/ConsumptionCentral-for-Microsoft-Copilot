// @ts-check
// product.js holds the names the installer writes to disk, a tenant or GitHub. The launcher and the
// web app can't import it, so these tests check that the copies they carry still match.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as P from '../src/product.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** @param {string} rel */
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

test('product: names follow the pattern shared with the AI in One and ValueLens installers', () => {
  assert.equal(P.EXE_NAME, `${P.PRODUCT_TOKEN}Installer.exe`);
  assert.equal(P.ZIP_NAME, `${P.PRODUCT_TOKEN}Installer.zip`);
  assert.equal(P.COMMAND, `${P.PRODUCT_ID}-installer`);
  assert.equal(P.RECORD_FILE, `${P.PRODUCT_ID}-setup.json`);
  assert.equal(P.TAG_PREFIX, `${P.PRODUCT_ID}-installer-v`);
  assert.match(P.PRODUCT_ID, /^[a-z]+(-[a-z]+)*$/);
  assert.equal(P.PRODUCT_SNAKE, P.PRODUCT_ID.replaceAll('-', '_'));
  assert.equal(P.ENV_PREFIX, P.PRODUCT_SNAKE.toUpperCase());
  for (const name of Object.values(P.ENV)) assert.match(name, new RegExp(`^${P.ENV_PREFIX}_[A-Z_]+$`));
});

test('product: names the tenant takes are valid there', () => {
  const vault = `${P.KEY_VAULT_PREFIX}abcd`;
  assert.ok(vault.length <= 24, 'Key Vault names are at most 24 characters');
  assert.match(vault, /^[a-z][a-z0-9-]*[a-z0-9]$/);
  assert.doesNotMatch(vault, /--/);
  assert.match(P.LAKEHOUSE_NAME, /^[A-Za-z][A-Za-z0-9_]*$/, 'Lakehouse names take letters, digits and underscores');
  assert.match(P.PRODUCT_SNAKE, /^\w+$/, 'Spark session tags take letters, digits and underscores');
  assert.match(P.RESOURCE_GROUP, /^[\w.()-]{1,90}$/);
  assert.match(P.UPLOAD_LOG_TABLE, /^dbo\.\w+$/);
  for (const dir of [P.INSTALLER_DIR, P.UPLOAD_DIR, P.FLOWS_DIR]) assert.match(dir, /^Files\/\w+$/);
});

test('product: the npm package and its command match', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.name, P.COMMAND);
  assert.deepEqual(pkg.bin, { [P.COMMAND]: P.BIN_SCRIPT });
  assert.equal(pkg.scripts.start, `node ${P.BIN_SCRIPT}`);
  assert.ok(existsSync(join(ROOT, P.BIN_SCRIPT)), P.BIN_SCRIPT);
  assert.equal(lock.name, P.COMMAND);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].name, P.COMMAND);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.deepEqual(lock.packages[''].bin, pkg.bin);
});

test('product: the exe launcher uses the same names', () => {
  const cs = read('packaging/launcher/Launcher.cs');
  assert.ok(cs.includes(`HomeFolder = "${P.HOME_FOLDER}";`), 'HomeFolder');
  assert.ok(cs.includes(`WorkFolder = "${P.DOCUMENTS_FOLDER}";`), 'WorkFolder');
  assert.ok(cs.includes(`Console.Title = "${P.INSTALLER_TITLE}";`), 'Console.Title');
  assert.ok(cs.includes(`EnvironmentVariables["${P.ENV.EXE}"] = "1";`), P.ENV.EXE);
  assert.ok(cs.includes(`"installer", "bin", "${basename(P.BIN_SCRIPT)}"`), P.BIN_SCRIPT);
  assert.ok(cs.includes(`Docs = "${P.DOCS_URL}";`), 'Docs');
  assert.match(read('packaging/launcher/app.manifest'), new RegExp(`<assemblyIdentity [^>]*name="${P.USER_AGENT}"`));
});

test('product: install.ps1 uses the same names', () => {
  const ps = read('packaging/launcher/install.ps1');
  for (const name of [P.ENV.ZIP, P.ENV.PROXY, P.ENV.USE_INSTALLED_NODE, P.ENV.CLOUD_SHELL, P.ENV.LAUNCHER]) {
    assert.ok(ps.includes(`$env:${name}`), name);
  }
  assert.ok(ps.includes(`Join-Path $HOME '${P.CLOUD_SHELL_HOME}'`), 'the Cloud Shell home');
  assert.ok(ps.includes(`Join-Path $HOME '${P.CLOUD_SHELL_WORK}'`), 'the Cloud Shell record folder');
  assert.ok(ps.includes(`Join-Path $CcHome '${P.PRODUCT_ID}'`), 'the Cloud Shell command');
  assert.ok(ps.includes(`Join-Path $env:LOCALAPPDATA '${P.HOME_FOLDER}'`), 'the unpack folder');
  assert.ok(ps.includes(`Join-Path $CcHome '${P.SHIM}'`), 'the Windows command');
  assert.ok(ps.includes(`Join-Path $Docs '${P.DOCUMENTS_FOLDER}'`), 'the record folder');
  assert.ok(ps.includes(`'${P.PRODUCT_TOKEN}.Power' -as [type]`) && ps.includes(`Add-Type -Namespace ${P.PRODUCT_TOKEN} -Name Power`), 'the keep-awake type');
  assert.ok(ps.includes(`installer/bin/${basename(P.BIN_SCRIPT)}`) && ps.includes(`installer\\bin\\${basename(P.BIN_SCRIPT)}`), P.BIN_SCRIPT);
  assert.ok(ps.includes(`Release ${P.TAG_PREFIX}$Version`), P.TAG_PREFIX);
  assert.ok(ps.includes(`$Again = 'irm https://github.com/{{REPO}}/releases/download/${P.TAG_PREFIX}{{VERSION}}/install.ps1 | iex'`), 'the pinned re-run command');
  assert.ok(ps.includes(`$Releases = 'https://github.com/{{REPO}}/releases?q=${P.TAG_PREFIX}'`), 'the installer releases page');
  assert.ok(ps.includes(P.DOCS_URL.replace(P.REPO, '{{REPO}}')), 'the install guide');
});

test('product: the web app uses the same names', () => {
  const app = read('src/web/app.js');
  assert.ok(app.includes(`launcher().command ?? '${P.COMMAND}'`), P.COMMAND);
  assert.ok(app.includes(`run ${P.COMMAND} --ui in your terminal`), 'the reopen hint');
  assert.ok(app.includes(`localStorage.setItem('${P.THEME_KEY}'`) && app.includes(`localStorage.getItem('${P.THEME_KEY}')`), P.THEME_KEY);
  assert.ok(app.includes(`download(\`${P.PRODUCT_ID}-plan-`), 'the saved plan');
  assert.ok(app.includes(`download(\`${P.PRODUCT_ID}-\${run.command}-`), 'the saved log');
  assert.ok(app.includes(P.UPLOAD_DIR), P.UPLOAD_DIR);
  assert.ok(read('src/web/index.html').includes(`<title>${P.INSTALLER_TITLE}</title>`), 'the page title');
  const install = read('src/install.js');
  for (const heading of [`${P.PRODUCT_NAME} is set up`, `${P.PRODUCT_NAME} is partly set up`]) {
    assert.ok(app.includes(`'${heading}'`), `the web app knows "${heading}"`);
    const printed = [`ui.heading('${heading}')`, `ui.heading(\`${heading.replace(P.PRODUCT_NAME, '${PRODUCT_NAME}')}\`)`];
    assert.ok(printed.some((p) => install.includes(p)), `install.js prints "${heading}"`);
  }
});

/** @param {string} dir @returns {string[]} */
const jsFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = join(dir, e.name);
  if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'web' ? [] : jsFiles(p);
  return e.name.endsWith('.js') ? [p] : [];
});

/** Code lines, without comments. Good enough for this repo's style: no comment markers inside strings at the start of a line. */
const codeLines = (/** @type {string} */ text) => {
  /** @type {[number, string][]} */
  const out = [];
  let inBlock = false;
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (inBlock) {
      if (t.includes('*/')) inBlock = false;
      return;
    }
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) inBlock = true;
      return;
    }
    if (t.startsWith('//') || t.startsWith('*')) return;
    out.push([i + 1, line]);
  });
  return out;
};

test('product: the code takes its identifiers from product.js', () => {
  const ids = new RegExp([P.PRODUCT_ID, P.PRODUCT_SNAKE, P.PRODUCT_TOKEN, P.ENV_PREFIX].join('|'), 'i');
  const files = ['bin', 'src', 'packaging'].flatMap((d) => jsFiles(join(ROOT, d))).filter((f) => basename(f) !== 'product.js');
  assert.ok(files.length > 40, 'found the code');
  const found = files.flatMap((f) => codeLines(readFileSync(f, 'utf8'))
    .filter(([, line]) => ids.test(line))
    .map(([n, line]) => `${relative(ROOT, f)}:${n}: ${line.trim()}`));
  assert.deepEqual(found, []);
});

/** @param {string} dir @returns {string[]} */
const allFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = join(dir, e.name);
  if (e.isDirectory()) return e.name === 'node_modules' ? [] : allFiles(p);
  return [p];
});

test('product: no ValueLens or Analytics Hub names are left in what the installer shows, writes or deploys', () => {
  const other = /value ?lens|analytics ?hub/i;
  // Analytics Hub's lineage-tag seed for the pay-as-you-go table: internal, and kept so the port stays diffable.
  // PAX's own -Dashboard values for its rollup (runner/Run-PAX-AIBV.ps1): PAX's parameter, never shown.
  const allowed = [/`valuelens:payg:\$\{key\}`/, /^\s*\$dashboardValues = @\('ValueLens', 'AIBV'\)$/];
  // The one file that names another product on purpose: it tells that product's installs apart from this one's.
  const guard = join(ROOT, 'src', 'other-installs.js');
  const files = ['bin', 'src', 'packaging', 'assets'].flatMap((d) => allFiles(join(ROOT, d))).filter((f) => f !== guard);
  assert.ok(files.some((f) => f.endsWith('.ipynb')), 'found the helper notebooks');
  /** @type {string[]} */
  const found = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    if (f.endsWith('.ipynb')) {
      // Every cell, comments included: people read these notebooks in Fabric.
      JSON.parse(text).cells.forEach((/** @type {any} */ cell, /** @type {number} */ i) => {
        if (other.test([].concat(cell.source).join(''))) found.push(`${relative(ROOT, f)}: cell ${i}`);
      });
      continue;
    }
    if (!/\.(js|cs|ps1|html|css|manifest|cmd)$/.test(f)) continue;
    /** @type {[number, string][]} */
    const lines = f.endsWith('.ps1')
      ? text.split(/\r?\n/).map((line, i) => /** @type {[number, string]} */ ([i + 1, line])).filter(([, line]) => !line.trim().startsWith('#'))
      : codeLines(text);
    for (const [n, line] of lines) {
      if (other.test(line) && !allowed.some((a) => a.test(line))) found.push(`${relative(ROOT, f)}:${n}: ${line.trim()}`);
    }
  }
  assert.deepEqual(found, []);
});
