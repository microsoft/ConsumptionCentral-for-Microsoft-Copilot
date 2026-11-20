// @ts-check
/**
 * GitHub's REST API with a personal access token: only the calls the installer checks the token with.
 * Ingest_GitHub_API does the reading.
 */
import { createClient } from '../http.js';
import { USER_AGENT } from '../product.js';

export const GITHUB_API_URL = 'https://api.github.com';
export const GITHUB_HOST = 'https://github.com';
const HOST_RULE = 'Use https://github.com or https://<subdomain>.ghe.com, without a path, port, query or credentials.';

/** GitHub Enterprise Cloud only, not arbitrary token destinations or Enterprise Server. @param {string} [host] */
export function githubHost(host = GITHUB_HOST) {
  const raw = host.trim();
  const match = /^https:\/\/(github\.com|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com)\/?$/i.exec(raw);
  if (!match) throw new Error(HOST_RULE);
  return `https://${match[1].toLowerCase()}`;
}

/** @param {string} v */
export function validateGithubHost(v) {
  try {
    githubHost(v);
    return true;
  } catch {
    return HOST_RULE;
  }
}

/** @param {string} [host] */
export function githubApiUrl(host) {
  const webHost = githubHost(host);
  return webHost === GITHUB_HOST ? GITHUB_API_URL : webHost.replace('https://', 'https://api.');
}
// The version Ingest_GitHub_API sends.
export const GITHUB_API_VERSION = '2022-11-28';

/**
 * @param {string} token
 * @param {{ host?: string, fetchImpl?: typeof fetch, debug?: (m: string) => void }} [opts]
 */
export function githubApi(token, opts = {}) {
  const http = createClient({ baseUrl: githubApiUrl(opts.host), getToken: async () => token, fetchImpl: opts.fetchImpl, debug: opts.debug });
  /** @type {import('../http.js').RequestOptions} */
  const base = {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': GITHUB_API_VERSION, 'User-Agent': USER_AGENT },
    // A check, not a load: GitHub not answering is reported straight away, not waited out.
    maxRetries: 0,
  };
  const path = (/** @type {string} */ enterprise) => `/enterprises/${encodeURIComponent(enterprise)}`;
  return {
    /** One seat: whether the token reaches the enterprise's Copilot licences. @param {string} enterprise */
    copilotSeats: (enterprise) => http.request('GET', `${path(enterprise)}/copilot/billing/seats`, { ...base, query: { per_page: 1 } }),
    /** This month's AI credit usage for the whole enterprise. @param {string} enterprise */
    aiCreditUsage: (enterprise) => http.request('GET', `${path(enterprise)}/settings/billing/ai_credit/usage`, base),
  };
}

/** @typedef {ReturnType<typeof githubApi>} GithubApi */
