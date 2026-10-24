import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkForUpdate, newerVersion, OPT_OUT, RELEASES_API, RELEASES_PAGE, REPO } from '../src/update-check.js';

/** @param {any} body @param {{ ok?: boolean }} [o] */
const fakeFetch = (body, o = {}) => {
  /** @type {string[]} */
  const calls = [];
  const fetch = /** @type {any} */ (async (/** @type {string} */ url) => {
    calls.push(url);
    return { ok: o.ok ?? true, json: async () => body };
  });
  return { fetch, calls };
};

/** @param {string} tag @param {Record<string, any>} [more] */
const release = (tag, more = {}) => ({ tag_name: tag, html_url: `https://github.com/${REPO}/releases/tag/${tag}`, draft: false, prerelease: false, ...more });

test('update check: only a newer consumption-central-installer-v release counts', () => {
  assert.equal(newerVersion('0.5.0', 'consumption-central-installer-v0.5.1'), '0.5.1');
  assert.equal(newerVersion('0.5.0', 'consumption-central-installer-v0.6.0'), '0.6.0');
  assert.equal(newerVersion('0.5.0', 'consumption-central-installer-v1.0.0'), '1.0.0');
  assert.equal(newerVersion('0.5.0', 'consumption-central-installer-v0.5.0'), null);
  assert.equal(newerVersion('0.5.1', 'consumption-central-installer-v0.5.0'), null);
  assert.equal(newerVersion('0.10.0', 'consumption-central-installer-v0.9.9'), null);
  assert.equal(newerVersion('0.5.0', 'v0.6.0'), null);
  assert.equal(newerVersion('0.5.0', 'consumption-central-azure-v0.6.0'), null);
  assert.equal(newerVersion('0.5.0', 'consumption-central-installer-v0.6.0-rc.1'), null);
  assert.equal(newerVersion('0.5.0-dev', 'consumption-central-installer-v0.5.1'), '0.5.1');
  assert.equal(newerVersion('', 'consumption-central-installer-v0.5.1'), null);
});

test('update check: reads the release list, since the latest release is the dashboard\'s', async () => {
  const { fetch, calls } = fakeFetch([release('v2026.06'), release('consumption-central-installer-v0.2.0'), release('2026-06-25')]);
  const u = await checkForUpdate({ version: '0.1.0', fetch, env: {} });
  assert.deepEqual(calls, [RELEASES_API]);
  assert.equal(RELEASES_API, 'https://api.github.com/repos/microsoft/ConsumptionCentral-for-Microsoft-Copilot/releases?per_page=50');
  assert.deepEqual(u, { version: '0.2.0', url: 'https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/releases/tag/consumption-central-installer-v0.2.0' });
});

test('update check: picks the newest installer release, whatever the list order', async () => {
  const { fetch } = fakeFetch([
    release('consumption-central-installer-v0.2.0'),
    release('consumption-central-installer-v0.10.0'),
    release('consumption-central-installer-v0.3.1'),
    release('2026-06-25'),
  ]);
  assert.deepEqual(await checkForUpdate({ version: '0.1.0', fetch, env: {} }), { version: '0.10.0', url: `https://github.com/${REPO}/releases/tag/consumption-central-installer-v0.10.0` });
});

test('update check: skips drafts and pre-releases', async () => {
  const { fetch } = fakeFetch([
    release('consumption-central-installer-v0.4.0', { draft: true }),
    release('consumption-central-installer-v0.3.0', { prerelease: true }),
    release('consumption-central-installer-v0.3.0-rc.1'),
    release('consumption-central-installer-v0.2.0'),
  ]);
  assert.deepEqual(await checkForUpdate({ version: '0.1.0', fetch, env: {} }), { version: '0.2.0', url: `https://github.com/${REPO}/releases/tag/consumption-central-installer-v0.2.0` });
});

test('update check: a link elsewhere falls back to the installer releases page', async () => {
  const { fetch } = fakeFetch([release('consumption-central-installer-v0.6.0', { html_url: 'https://example.com/x' })]);
  assert.deepEqual(await checkForUpdate({ version: '0.5.0', fetch, env: {} }), { version: '0.6.0', url: RELEASES_PAGE });
  assert.equal(RELEASES_PAGE, 'https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/releases?q=consumption-central-installer-v&expanded=true');
});

test('update check: quiet when up to date, offline, failing or opted out', async () => {
  const quiet = async (/** @type {any} */ body, /** @type {{ ok?: boolean }} */ o = {}) => checkForUpdate({ version: '0.6.0', fetch: fakeFetch(body, o).fetch, env: {} });
  assert.equal(await quiet([release('consumption-central-installer-v0.6.0'), release('consumption-central-installer-v0.5.0')]), null);
  assert.equal(await quiet([release('v2026.06'), release('2026-06-25')]), null);
  assert.equal(await quiet([]), null);
  assert.equal(await quiet([release('consumption-central-installer-v0.7.0')], { ok: false }), null);
  assert.equal(await quiet(null), null);
  assert.equal(await quiet(release('consumption-central-installer-v0.7.0')), null, 'one release, as releases/latest returns, is not a list');
  assert.equal((await quiet([null, 'x', release('consumption-central-installer-v0.7.0')]))?.version, '0.7.0');
  const offline = /** @type {any} */ (async () => { throw new TypeError('fetch failed'); });
  assert.equal(await checkForUpdate({ version: '0.5.0', fetch: offline, env: {} }), null);
  const optedOut = fakeFetch([release('consumption-central-installer-v0.6.0')]);
  assert.equal(await checkForUpdate({ version: '0.5.0', fetch: optedOut.fetch, env: { [OPT_OUT]: '1' } }), null);
  assert.deepEqual(optedOut.calls, []);
});

test('update check: nothing the installer ships links to GitHub\'s "Latest" release', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  /** @param {string} dir @returns {string[]} */
  const files = (dir) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.(js|mjs|ps1|cs|html|json)$/.test(e.name) ? [join(dir, e.name)] : []);
  const found = ['bin', 'src', 'packaging'].flatMap(files).filter((f) => /releases\/latest/.test(readFileSync(join(root, f), 'utf8')));
  assert.deepEqual(found, []);
});
test('update check: gives up when GitHub is slow', async () => {
  const slow = /** @type {any} */ ((/** @type {string} */ _url, /** @type {any} */ init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  }));
  const started = Date.now();
  assert.equal(await checkForUpdate({ version: '0.5.0', fetch: slow, timeoutMs: 50, env: {} }), null);
  assert.ok(Date.now() - started < 2000);
});
