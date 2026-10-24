// @ts-check
// The install docs carry one-liners pinned to this version's release, and link to each other's
// headings. These tests keep both true as the docs and the version change.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXE_NAME, REPO_URL, TAG_PREFIX, ZIP_NAME } from '../src/product.js';

const INSTALLER = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = join(INSTALLER, '..');
const { version } = JSON.parse(readFileSync(join(INSTALLER, 'package.json'), 'utf8'));
const TAG = `${TAG_PREFIX}${version}`;
const GUIDES = ['installer/README.md', 'docs/INSTALL.md'];
const DOCS = [...GUIDES, 'installer/UPSTREAM.md'];
const ASSETS = ['install.ps1', EXE_NAME, ZIP_NAME];

/** @param {string} path */
const readAbs = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
/** @param {string} rel */
const read = (rel) => readAbs(join(REPO_ROOT, rel));
/** @param {string} text */
const withoutFences = (text) => text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
/** @param {RegExp} re @param {string} text */
const all = (re, text) => [...text.matchAll(re)];
const rel = (/** @type {string} */ p) => relative(REPO_ROOT, p).replaceAll('\\', '/');
const escape = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * GitHub's heading anchor: the rendered text, lower-cased, with punctuation dropped and each
 * space turned into a hyphen. A repeated heading gets -1, -2 and so on.
 * @param {string} markdown
 */
function anchors(markdown) {
  const seen = new Map();
  const found = new Set();
  for (const [, heading] of all(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, withoutFences(markdown))) {
    const base = heading
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/[`*]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
      .replace(/ /g, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    found.add(count ? `${base}-${count}` : base);
  }
  for (const [, id] of all(/<a\s+(?:id|name)="([^"]+)"/g, markdown)) found.add(id);
  return found;
}

test('docs: anchors follow GitHub\'s rules for punctuation, code and repeated headings', () => {
  const md = [
    '# IT-approved Node.js',
    '## Locked-down tenant / Azure Cloud Shell',
    "### If you can't register apps",
    '## The `dbo.load_log` table',
    '## [Linked](https://example.com) heading',
    '## Prices',
    '## Prices',
    '```powershell',
    '# not a heading',
    '```',
  ].join('\n');
  assert.deepEqual([...anchors(md)], [
    'it-approved-nodejs',
    'locked-down-tenant--azure-cloud-shell',
    'if-you-cant-register-apps',
    'the-dboload_log-table',
    'linked-heading',
    'prices',
    'prices-1',
  ]);
});

test('docs: every one-liner and download link names this version\'s release', () => {
  for (const doc of GUIDES) {
    const text = read(doc);
    const links = all(new RegExp(`${escape(REPO_URL)}/releases/download/([^/\\s)]+)/([^\\s)\`"']+)`, 'g'), text);
    assert.ok(links.length, `${doc} links to no release download`);
    for (const [link, tag, asset] of links) {
      assert.equal(tag, TAG, `${doc}: ${link} should name ${TAG}, the version in package.json`);
      assert.ok(ASSETS.includes(asset), `${doc}: ${link} names ${asset}, which no release carries`);
    }
    assert.ok(
      text.includes(`irm ${REPO_URL}/releases/download/${TAG}/install.ps1 | iex`),
      `${doc} has no one-liner for ${TAG}`,
    );
  }
});

test('docs: no link relies on GitHub\'s "Latest" release, which a dashboard release can take', () => {
  for (const doc of DOCS) {
    const latest = all(/https?:\/\/[^\s)`"']*\/releases\/latest\b[^\s)`"']*/g, read(doc)).map(([m]) => m);
    assert.deepEqual(latest, [], `${doc} links to the "Latest" release`);
  }
});

test('docs: the guides link to the installer releases, not every release', () => {
  for (const doc of GUIDES) {
    assert.ok(read(doc).includes(`${REPO_URL}/releases?q=${TAG_PREFIX}`), `${doc} doesn't link to the installer releases`);
  }
});

test('docs: relative links and their anchors resolve', () => {
  const problems = [];
  for (const doc of DOCS) {
    const path = join(REPO_ROOT, doc);
    const text = withoutFences(read(doc)).replace(/`[^`\n]*`/g, '');
    for (const [, target] of all(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, text)) {
      if (/^[a-z][a-z+.-]*:/i.test(target)) continue;
      const [file, anchor] = target.split('#');
      const resolved = file ? join(dirname(path), decodeURIComponent(file)) : path;
      const where = `${doc}: (${target})`;
      if (!existsSync(resolved)) {
        problems.push(`${where} points at ${rel(resolved)}, which doesn't exist`);
        continue;
      }
      if (anchor === undefined) continue;
      if (!statSync(resolved).isFile() || !resolved.endsWith('.md')) {
        problems.push(`${where} has an anchor but doesn't point at a markdown file`);
      } else if (!anchors(readAbs(resolved)).has(decodeURIComponent(anchor))) {
        problems.push(`${where} names a heading ${rel(resolved)} doesn't have`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
