// @ts-check
/**
 * The GitHub token Ingest_GitHub_API reads Copilot billing with: taking it and checking it. Where it's
 * kept is up to the secret mode: Key Vault (steps/identity.js ensureGithubToken), or the notebook itself
 * (steps/fabric.js ensureNotebooks).
 */
import { secretMode } from '../config.js';
import { HttpError } from '../http.js';
import { commandLine } from '../launch.js';
import { ENV, GITHUB_PAT_SECRET, PRODUCT_NAME } from '../product.js';

/**
 * A token the user gave, held in memory until it's in Key Vault or the notebook. Never saved.
 * @typedef {{ value: string, expires?: string }} PendingToken
 */

export const TOKENS_URL = 'https://github.com/settings/tokens';
export const NEW_TOKEN_URL = `${TOKENS_URL}/new?description=${encodeURIComponent(PRODUCT_NAME)}`;
// As Ingest_GitHub_API documents it. Which of the two the AI credit usage endpoint takes is on the test-tenant list.
export const GITHUB_TOKEN_SCOPES = 'read:enterprise or manage_billing:copilot';
export const TOKEN_TRIES = 3;
/** The Done page shows a card this many days before the token expires. */
export const TOKEN_WARN_DAYS = 30;

export const revokeHint = () => `revoke it at ${TOKENS_URL}.`;
const createHint = () => `Create one at ${NEW_TOKEN_URL} (Generate new token (classic)).`;

/**
 * The Key Vault secret the token is in: GITHUB_PAT_SECRET, or a free name when a shared vault already had that one.
 * @param {import('../config.js').InstallConfig} config
 */
export const githubSecretName = (config) => config.github?.secretName ?? GITHUB_PAT_SECRET;

/**
 * The secret's content type, so whoever looks in the vault can tell what it holds.
 * @param {import('../config.js').InstallConfig} config
 */
export const githubContentType = (config) => (config.github?.enterprise ? `GitHub token for ${config.github.enterprise}` : 'GitHub token');

/** @param {unknown} err */
const messageOf = (err) => (err instanceof Error ? err.message : String(err));

/**
 * When the token expires, from GitHub's response header ("2026-09-01 12:00:00 UTC"), as ISO.
 * Undefined for a token with no expiry, or none seen.
 * @param {Headers | undefined} headers
 */
export function tokenExpiry(headers) {
  const raw = headers?.get('github-authentication-token-expiration')?.trim();
  if (!raw) return undefined;
  const ms = Date.parse(raw) || Date.parse(raw.replace(/ UTC$/, 'Z').replace(' ', 'T'));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * Why GitHub refused the token, or undefined when it couldn't say (no network, an outage, the rate
 * limit), which isn't the token's fault.
 * @param {unknown} err
 * @param {string} enterprise
 * @param {string} what  e.g. "the Copilot seats".
 */
export function refusal(err, enterprise, what) {
  if (!(err instanceof HttpError)) return undefined;
  const h = err.headers;
  if (err.status >= 500 || err.status === 429 || (err.status === 403 && h?.get('x-ratelimit-remaining') === '0')) return undefined;
  const scopes = h?.get('x-oauth-scopes');
  const has = typeof scopes === 'string' ? ` It has ${scopes ? `scope ${scopes}` : 'no scopes'}.` : '';
  const sso = h?.get('x-github-sso')?.match(/url=(\S+)/)?.[1];
  if (err.status === 401) return 'GitHub didn\'t accept the token: it\'s mistyped, expired or revoked.';
  if (sso) return `The token isn't authorised for single sign-on. Open ${sso}, authorise it, and try again.`;
  if (err.status === 403) {
    return `GitHub wouldn't show ${what}. The token needs scope ${GITHUB_TOKEN_SCOPES}, and whoever made it must be an owner or billing manager of the enterprise.${has}`;
  }
  if (err.status === 404) {
    return `GitHub found no enterprise "${enterprise}" with ${what} this token can see. Check the slug (github.com/enterprises/<slug>), and that whoever made the token is an owner or billing manager of it.${has}`;
  }
  return `GitHub answered ${err.status} for ${what}: ${err.message}`;
}

/**
 * Checks the token reads what Ingest_GitHub_API can't do without: the enterprise's Copilot seats and
 * its AI credit usage. When GitHub can't be asked (network, an outage, the rate limit), it warns and
 * keeps the token unchecked.
 * @param {import('../install.js').Ctx} ctx
 * @param {string} token
 * @returns {Promise<PendingToken>}
 */
export async function checkGithubToken(ctx, token) {
  const { ui, config } = ctx;
  const enterprise = config.github?.enterprise;
  if (!enterprise) throw new Error('The GitHub enterprise isn\'t set.');
  const value = token.trim();
  if (!value) throw new Error('No token was entered.');
  if (value.startsWith('github_pat_')) throw new Error(`That's a fine-grained token, and GitHub's billing endpoints take only classic ones. ${createHint()}`);
  const gh = ctx.api.github(value);
  /** @type {[string, () => Promise<import('../http.js').HttpResponse>][]} */
  const checks = [
    ['the Copilot seats', () => gh.copilotSeats(enterprise)],
    ['the AI credit usage', () => gh.aiCreditUsage(enterprise)],
  ];
  /** @type {Headers | undefined} */
  let headers;
  let checked = true;
  for (const [what, call] of checks) {
    try {
      const res = await call();
      headers ??= res.headers;
    } catch (err) {
      const why = refusal(err, enterprise, what);
      if (why) throw new Error(why);
      ui.warn(
        `Couldn't ${headers ? 'finish checking' : 'check'} the GitHub token: ${messageOf(err)}. It's used unchecked; ` +
          `if GitHub data doesn't load, run "${commandLine('github-token')}" with one that works.`,
      );
      checked = false;
      break;
    }
  }
  const expires = tokenExpiry(headers);
  if (checked) ui.ok(`The GitHub token reads ${enterprise}'s Copilot billing${expires ? `. It expires ${expires.slice(0, 10)}` : ''}`);
  return { value, ...(expires ? { expires } : {}) };
}

/**
 * Takes the GitHub token from CONSUMPTION_CENTRAL_GITHUB_TOKEN when it's set, or asks for it, and checks it.
 * Under --yes with none in the environment it returns undefined, and the caller decides whether that stops the run.
 * @param {import('../install.js').Ctx} ctx
 * @param {{ why?: string, env?: Record<string, string | undefined> }} [opts]  why: shown before asking.
 * @returns {Promise<PendingToken | undefined>}
 */
export async function askGithubToken(ctx, opts = {}) {
  const { ui } = ctx;
  if (ctx.pendingGithubToken) return ctx.pendingGithubToken;
  const fromEnv = (opts.env ?? process.env)[ENV.GITHUB_TOKEN]?.trim();
  if (fromEnv) {
    ui.info(`Using the GitHub token in ${ENV.GITHUB_TOKEN}.`);
    try {
      return await checkGithubToken(ctx, fromEnv);
    } catch (err) {
      if (ui.yes) throw new Error(`The GitHub token in ${ENV.GITHUB_TOKEN} doesn't work. ${messageOf(err)}`);
      ui.fail(`The token in ${ENV.GITHUB_TOKEN} doesn't work. ${messageOf(err)}`);
    }
  }
  if (ui.yes) return undefined;
  if (opts.why) ui.info(opts.why);
  ui.info(`Ingest_GitHub_API reads Copilot billing with a classic personal access token, scope ${GITHUB_TOKEN_SCOPES}, made by an owner or billing manager of the enterprise. ${createHint()}`);
  for (let tries = 1; ; tries++) {
    try {
      return await checkGithubToken(ctx, await ui.secret('GitHub token'));
    } catch (err) {
      if (tries >= TOKEN_TRIES) throw err;
      ui.fail(messageOf(err));
    }
  }
}

/**
 * One line for the summary and status, or undefined when GitHub isn't read from the API.
 * @param {import('../config.js').InstallConfig} config
 */
export function tokenLine(config) {
  const gh = config.github;
  if (config.dataSources.github !== 'api' || !gh) return undefined;
  if (!gh.tokenSetAt) return `GitHub token: not set yet. Run "${commandLine('github-token')}".`;
  return `GitHub token: ${tokenWhere(config)}${gh.tokenExpires ? `, expires ${gh.tokenExpires.slice(0, 10)}` : ''}`;
}

/**
 * Where the token is kept: in the notebook in notebook mode, otherwise in Key Vault.
 * @param {import('../config.js').InstallConfig} config
 */
export const tokenWhere = (config) =>
  secretMode(config) === 'notebook' || config.github?.tokenInNotebook
    ? 'in Ingest_GitHub_API'
    : `${config.keyVault?.name ?? 'Key Vault'} / ${githubSecretName(config)}`;
