// @ts-check
/**
 * The GitHub token Ingest_GitHub_API reads Copilot billing with: what GitHub says about it, checking it, asking for
 * it, and where the summary and status say it is.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyConfig } from '../src/config.js';
import { HttpError } from '../src/http.js';
import { commandLine } from '../src/launch.js';
import { ENV, GITHUB_PAT_SECRET } from '../src/product.js';
import {
  askGithubToken,
  checkGithubToken,
  GITHUB_TOKEN_SCOPES,
  githubContentType,
  githubSecretName,
  NEW_TOKEN_URL,
  refusal,
  revokeHint,
  TOKEN_TRIES,
  TOKEN_WARN_DAYS,
  tokenExpiry,
  tokenLine,
  TOKENS_URL,
  tokenWhere,
} from '../src/steps/github.js';
import { status } from '../src/steps/run.js';
import { fakeCtx, fakeFabric, fakeUi } from './fakes.js';

const EXPIRES = 'github-authentication-token-expiration';
const NEEDS = `The token needs scope ${GITHUB_TOKEN_SCOPES}, and whoever made it must be an owner or billing manager of the enterprise.`;
const CREATE = `Create one at ${NEW_TOKEN_URL} (Generate new token (classic)).`;
const BAD_TOKEN = "GitHub didn't accept the token: it's mistyped, expired or revoked.";

/**
 * An error from GitHub's API.
 * @param {number} status
 * @param {Record<string, string>} [headers]
 * @param {string} [message]
 */
const refused = (status, headers = {}, message = 'Forbidden') =>
  new HttpError(message, { status, method: 'GET', url: 'https://api.github.com/enterprises/contoso/copilot/billing/seats', headers: new Headers(headers) });

/**
 * A GitHub answer.
 * @param {Record<string, string>} [headers]
 */
const answer = (headers = {}) => ({ status: 200, headers: new Headers(headers), data: {} });

/**
 * A run reading Copilot billing for the contoso enterprise. GitHub answers each call with `seats` or `usage`, given
 * the token; by default 200, for a token with no expiry.
 * @param {{ yes?: boolean, answers?: any[], seats?: (token: string) => any, usage?: (token: string) => any, enterprise?: string }} [o]
 */
function githubCtx(o = {}) {
  const ui = fakeUi({ yes: o.yes, answers: o.answers });
  const t = fakeCtx({ ui: ui.ui });
  t.config.dataSources.github = 'api';
  t.config.github = 'enterprise' in o ? { enterprise: o.enterprise } : { enterprise: 'contoso' };
  /** Each call to GitHub: the token, the endpoint and the enterprise. @type {string[][]} */
  const calls = [];
  /** @type {any} */ (t.ctx.api).github = (/** @type {string} */ token) => ({
    copilotSeats: async (/** @type {string} */ enterprise) => {
      calls.push([token, 'copilotSeats', enterprise]);
      return o.seats ? o.seats(token) : answer();
    },
    aiCreditUsage: async (/** @type {string} */ enterprise) => {
      calls.push([token, 'aiCreditUsage', enterprise]);
      return o.usage ? o.usage(token) : answer();
    },
  });
  return { ...t, ui, calls };
}

test('the token: classic, with the billing scopes, made at github.com/settings/tokens, flagged a month before it expires', () => {
  assert.equal(GITHUB_TOKEN_SCOPES, 'read:enterprise or manage_billing:copilot');
  assert.equal(TOKENS_URL, 'https://github.com/settings/tokens');
  assert.equal(NEW_TOKEN_URL, 'https://github.com/settings/tokens/new?description=Consumption%20Central', 'named after the product');
  assert.equal(revokeHint(), 'revoke it at https://github.com/settings/tokens.');
  assert.equal(TOKEN_TRIES, 3);
  assert.equal(TOKEN_WARN_DAYS, 30);
  assert.equal(ENV.GITHUB_TOKEN, 'CONSUMPTION_CENTRAL_GITHUB_TOKEN');
});

test("githubSecretName: Consumption Central's own secret, or the free name a shared vault left it; the content type names the enterprise", () => {
  const config = emptyConfig();
  assert.equal(GITHUB_PAT_SECRET, 'consumption-central-github-pat');
  assert.equal(githubSecretName(config), GITHUB_PAT_SECRET);
  assert.equal(githubContentType(config), 'GitHub token');
  config.github = { enterprise: 'contoso' };
  assert.equal(githubSecretName(config), GITHUB_PAT_SECRET);
  assert.equal(githubContentType(config), 'GitHub token for contoso');
  config.github.secretName = 'consumption-central-github-pat-2';
  assert.equal(githubSecretName(config), 'consumption-central-github-pat-2');
});

test("tokenExpiry: reads GitHub's expiry header in each form it takes; none for a token that never expires", () => {
  const expiry = (/** @type {string} */ value) => tokenExpiry(new Headers({ 'GitHub-Authentication-Token-Expiration': value }));
  assert.equal(expiry('2026-09-01 12:00:00 UTC'), '2026-09-01T12:00:00.000Z');
  assert.equal(expiry('2026-09-01 12:00:00 -0700'), '2026-09-01T19:00:00.000Z');
  assert.equal(expiry('2026-09-01T12:00:00Z'), '2026-09-01T12:00:00.000Z');
  assert.equal(expiry(''), undefined);
  assert.equal(expiry('next week'), undefined);
  assert.equal(tokenExpiry(new Headers()), undefined, 'a token with no expiry');
  assert.equal(tokenExpiry(undefined), undefined, 'no answer seen');
});

test("refusal: says why GitHub turned the token away, and nothing when GitHub couldn't answer", () => {
  const seats = 'the Copilot seats';
  for (const err of [
    new Error('fetch failed'),
    refused(502, {}, 'Bad Gateway'),
    refused(429, {}, 'Too Many Requests'),
    refused(403, { 'x-ratelimit-remaining': '0' }, 'API rate limit exceeded'),
  ]) {
    assert.equal(refusal(err, 'contoso', seats), undefined, err.message);
  }

  const sso = 'https://github.com/enterprises/contoso/sso?authorization_request=A1B2';
  assert.equal(refusal(refused(401, { 'x-github-sso': `required; url=${sso}` }, 'Bad credentials'), 'contoso', seats), BAD_TOKEN, 'a bad token, whatever else');
  assert.equal(refusal(refused(403, { 'x-github-sso': `required; url=${sso}` }), 'contoso', seats), `The token isn't authorised for single sign-on. Open ${sso}, authorise it, and try again.`);
  assert.equal(refusal(refused(403, { 'x-github-sso': 'partial-results; organizations=21955855' }), 'contoso', seats), `GitHub wouldn't show the Copilot seats. ${NEEDS}`, 'no link to follow');

  assert.equal(refusal(refused(403, { 'x-ratelimit-remaining': '4999' }), 'contoso', seats), `GitHub wouldn't show the Copilot seats. ${NEEDS}`);
  assert.equal(refusal(refused(403, { 'x-oauth-scopes': 'repo, read:org' }), 'contoso', seats), `GitHub wouldn't show the Copilot seats. ${NEEDS} It has scope repo, read:org.`);
  assert.equal(refusal(refused(403, { 'x-oauth-scopes': '' }), 'contoso', seats), `GitHub wouldn't show the Copilot seats. ${NEEDS} It has no scopes.`);
  assert.equal(
    refusal(refused(404, { 'x-oauth-scopes': 'read:enterprise' }, 'Not Found'), 'contosso', 'the AI credit usage'),
    'GitHub found no enterprise "contosso" with the AI credit usage this token can see. Check the slug (github.com/enterprises/<slug>), and that whoever made the token is an owner or billing manager of it. It has scope read:enterprise.',
  );
  assert.equal(refusal(refused(422, {}, 'Validation Failed'), 'contoso', seats), 'GitHub answered 422 for the Copilot seats: Validation Failed');
});

test("checkGithubToken: reads the enterprise's Copilot seats, then its AI credit usage, and keeps when the token expires", async () => {
  const t = githubCtx({ seats: () => answer({ [EXPIRES]: '2026-09-01 12:00:00 UTC' }) });
  assert.deepEqual(await checkGithubToken(t.ctx, '  ghp_test  '), { value: 'ghp_test', expires: '2026-09-01T12:00:00.000Z' });
  assert.deepEqual(t.calls, [
    ['ghp_test', 'copilotSeats', 'contoso'],
    ['ghp_test', 'aiCreditUsage', 'contoso'],
  ]);
  assert.equal(t.ui.text(), "  ✓ The GitHub token reads contoso's Copilot billing. It expires 2026-09-01\n");

  const lasting = githubCtx();
  assert.deepEqual(await checkGithubToken(lasting.ctx, 'ghp_test'), { value: 'ghp_test' }, 'no expiry');
  assert.equal(lasting.ui.text(), "  ✓ The GitHub token reads contoso's Copilot billing\n");
});

test("checkGithubToken: a token GitHub refuses, a fine-grained one, or none at all is turned away with the reason", async () => {
  const t = githubCtx();
  await assert.rejects(checkGithubToken(t.ctx, '   '), { message: 'No token was entered.' });
  await assert.rejects(checkGithubToken(t.ctx, 'github_pat_test'), {
    message: `That's a fine-grained token, and GitHub's billing endpoints take only classic ones. ${CREATE}`,
  });
  assert.deepEqual(t.calls, [], 'not sent to GitHub');

  const unset = githubCtx({ enterprise: undefined });
  await assert.rejects(checkGithubToken(unset.ctx, 'ghp_test'), { message: "The GitHub enterprise isn't set." });

  // read:enterprise reads the seats, but not the AI credit usage.
  const half = githubCtx({ usage: () => Promise.reject(refused(403, { 'x-oauth-scopes': 'read:enterprise' })) });
  await assert.rejects(checkGithubToken(half.ctx, 'ghp_test'), { message: `GitHub wouldn't show the AI credit usage. ${NEEDS} It has scope read:enterprise.` });
  assert.equal(half.calls.length, 2);
  assert.equal(half.ui.text(), '');
});

test("checkGithubToken: when GitHub can't be asked, the token is used unchecked, with a warning that says how to replace it", async () => {
  const fix = `It's used unchecked; if GitHub data doesn't load, run "${commandLine('github-token')}" with one that works.`;
  const offline = githubCtx({ seats: () => Promise.reject(new Error('fetch failed')) });
  assert.deepEqual(await checkGithubToken(offline.ctx, 'ghp_test'), { value: 'ghp_test' });
  assert.equal(offline.calls.length, 1, 'no further checks');
  assert.equal(offline.ui.text(), `  ! Couldn't check the GitHub token: fetch failed. ${fix}\n`);

  const limited = githubCtx({ seats: () => Promise.reject(refused(403, { 'x-ratelimit-remaining': '0' }, 'API rate limit exceeded')) });
  assert.deepEqual(await checkGithubToken(limited.ctx, 'ghp_test'), { value: 'ghp_test' });
  assert.equal(limited.ui.text(), `  ! Couldn't check the GitHub token: API rate limit exceeded. ${fix}\n`);

  const outage = githubCtx({
    seats: () => answer({ [EXPIRES]: '2026-09-01 12:00:00 UTC' }),
    usage: () => Promise.reject(refused(503, {}, 'Service Unavailable')),
  });
  assert.deepEqual(await checkGithubToken(outage.ctx, 'ghp_test'), { value: 'ghp_test', expires: '2026-09-01T12:00:00.000Z' }, 'the expiry it saw is kept');
  assert.equal(outage.ui.text(), `  ! Couldn't finish checking the GitHub token: Service Unavailable. ${fix}\n`);
});

test('askGithubToken: a token already given in this run is used without asking', async () => {
  const t = githubCtx();
  const given = { value: 'ghp_given', expires: '2026-09-01T12:00:00.000Z' };
  t.ctx.pendingGithubToken = given;
  assert.equal(await askGithubToken(t.ctx, { why: 'Ingest_GitHub_API is new.', env: { [ENV.GITHUB_TOKEN]: 'ghp_env' } }), given);
  assert.deepEqual(t.calls, []);
  assert.deepEqual(t.ui.asked, []);
  assert.equal(t.ui.text(), '');
});

test("askGithubToken: takes the token in CONSUMPTION_CENTRAL_GITHUB_TOKEN; one that doesn't work stops --yes, and is asked for otherwise", async () => {
  const env = { [ENV.GITHUB_TOKEN]: ' ghp_env ' };
  const quiet = githubCtx({ yes: true });
  assert.deepEqual(await askGithubToken(quiet.ctx, { why: 'Ingest_GitHub_API is new.', env }), { value: 'ghp_env' });
  assert.deepEqual(quiet.ui.asked, []);
  assert.equal(quiet.ui.text(), "    Using the GitHub token in CONSUMPTION_CENTRAL_GITHUB_TOKEN.\n  ✓ The GitHub token reads contoso's Copilot billing\n");

  const reject = (/** @type {string} */ token) => (token === 'ghp_env' ? Promise.reject(refused(401, {}, 'Bad credentials')) : answer());
  const stopped = githubCtx({ yes: true, seats: reject });
  await assert.rejects(askGithubToken(stopped.ctx, { env }), { message: `The GitHub token in CONSUMPTION_CENTRAL_GITHUB_TOKEN doesn't work. ${BAD_TOKEN}` });

  const asked = githubCtx({ answers: ['ghp_typed'], seats: reject });
  assert.deepEqual(await askGithubToken(asked.ctx, { env }), { value: 'ghp_typed' });
  assert.deepEqual(asked.ui.asked, ['GitHub token']);
  assert.ok(asked.ui.text().startsWith(`    Using the GitHub token in CONSUMPTION_CENTRAL_GITHUB_TOKEN.\n  ✗ The token in CONSUMPTION_CENTRAL_GITHUB_TOKEN doesn't work. ${BAD_TOKEN}\n`));

  // Under --yes with none set, the caller decides whether that stops the run.
  const none = githubCtx({ yes: true });
  assert.equal(await askGithubToken(none.ctx, { env: {} }), undefined);
  assert.equal(await askGithubToken(none.ctx, { env: { [ENV.GITHUB_TOKEN]: '  ' } }), undefined);
  assert.deepEqual(none.calls, []);
  assert.equal(none.ui.text(), '');
});

test('askGithubToken: says why and what token to make, then asks up to TOKEN_TRIES times', async () => {
  const t = githubCtx({ answers: ['github_pat_test', '', 'ghp_test'] });
  assert.deepEqual(await askGithubToken(t.ctx, { why: 'Ingest_GitHub_API is new, so it needs the token.', env: {} }), { value: 'ghp_test' });
  assert.deepEqual(t.ui.asked, ['GitHub token', 'GitHub token', 'GitHub token']);
  assert.equal(
    t.ui.text(),
    [
      '    Ingest_GitHub_API is new, so it needs the token.\n',
      `    Ingest_GitHub_API reads Copilot billing with a classic personal access token, scope ${GITHUB_TOKEN_SCOPES}, made by an owner or billing manager of the enterprise. ${CREATE}\n`,
      `  ✗ That's a fine-grained token, and GitHub's billing endpoints take only classic ones. ${CREATE}\n`,
      '  ✗ No token was entered.\n',
      "  ✓ The GitHub token reads contoso's Copilot billing\n",
    ].join(''),
  );

  const refusedEach = githubCtx({ answers: ['ghp_a', 'ghp_b', 'ghp_c'], seats: () => Promise.reject(refused(401, {}, 'Bad credentials')) });
  await assert.rejects(askGithubToken(refusedEach.ctx, { env: {} }), { message: BAD_TOKEN });
  assert.equal(refusedEach.ui.asked.length, TOKEN_TRIES);
  assert.equal(refusedEach.ui.text().split('✗').length - 1, TOKEN_TRIES - 1, 'the last refusal is thrown, not shown');
});

test('tokenLine: where the GitHub token is kept and when it expires, only while GitHub is read from the API', () => {
  const config = emptyConfig();
  assert.equal(tokenLine(config), undefined, 'GitHub skipped');
  config.dataSources.github = 'api';
  assert.equal(tokenLine(config), undefined, 'not set up yet');
  config.github = { enterprise: 'contoso' };
  assert.equal(tokenLine(config), `GitHub token: not set yet. Run "${commandLine('github-token')}".`);

  config.github.tokenSetAt = '2026-06-01T12:00:00.000Z';
  assert.equal(tokenLine(config), 'GitHub token: Key Vault / consumption-central-github-pat', 'no vault name, no expiry');
  config.keyVault.name = 'kv-contoso';
  config.github.tokenExpires = '2026-09-01T12:00:00.000Z';
  assert.equal(tokenLine(config), 'GitHub token: kv-contoso / consumption-central-github-pat, expires 2026-09-01');
  config.github.secretName = 'consumption-central-github-pat-2';
  assert.equal(tokenWhere(config), 'kv-contoso / consumption-central-github-pat-2');
  config.keyVault.mode = 'keyvault-admin';
  assert.equal(tokenWhere(config), 'kv-contoso / consumption-central-github-pat-2', 'a vault admin put it there');
  config.github.tokenInNotebook = true;
  assert.equal(tokenWhere(config), 'in Ingest_GitHub_API', 'written into the notebook before the move to Key Vault, and not yet removed');

  delete config.github.tokenInNotebook;
  config.keyVault.mode = 'notebook';
  assert.equal(tokenLine(config), 'GitHub token: in Ingest_GitHub_API, expires 2026-09-01');
  config.dataSources.github = 'csv';
  assert.equal(tokenLine(config), undefined);
});

test('status: warns about a GitHub token that is not set yet or expires within TOKEN_WARN_DAYS', async () => {
  const fabric = fakeFabric();
  const ui = fakeUi();
  const t = fakeCtx({ fabric: fabric.api, ui: ui.ui, oneLake: { readJson: async () => null } });
  t.config.fabric.pipelineId = 'pl-1';
  t.config.keyVault.name = 'kv-contoso';
  t.config.dataSources.github = 'api';
  t.config.github = { enterprise: 'contoso' };
  const tokenShown = async () => {
    const from = ui.text().length;
    await status(t.ctx);
    return ui.text().slice(from).split('\n').find((l) => l.includes('GitHub token'));
  };
  const inDays = (/** @type {number} */ days) => new Date(t.ctx.now().getTime() + days * 86_400_000).toISOString();
  const run = `Run "${commandLine('github-token')}".`;

  assert.equal(await tokenShown(), `  ! GitHub token: not set yet. ${run}`);
  t.config.github.tokenSetAt = '2026-05-01T12:00:00.000Z';
  assert.equal(await tokenShown(), '    GitHub token: kv-contoso / consumption-central-github-pat', 'a token that never expires');
  t.config.github.tokenExpires = inDays(TOKEN_WARN_DAYS + 1);
  assert.equal(await tokenShown(), '    GitHub token: kv-contoso / consumption-central-github-pat, expires 2026-07-02');
  t.config.github.tokenExpires = inDays(TOKEN_WARN_DAYS - 1);
  assert.equal(await tokenShown(), `  ! GitHub token: kv-contoso / consumption-central-github-pat, expires 2026-06-30 (29 days). ${run}`);
  t.config.github.tokenExpires = inDays(-3);
  const expired = await tokenShown();
  assert.ok(expired?.startsWith('  ! GitHub token: kv-contoso / consumption-central-github-pat, expires 2026-05-29'), expired);
  assert.ok(expired?.endsWith(run));

  t.config.dataSources.github = 'csv';
  assert.equal(await tokenShown(), undefined);
});
