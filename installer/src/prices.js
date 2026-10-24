// @ts-check
/**
 * The commercial terms the semantic model prices usage with. No export carries them, so the installer
 * asks for them and writes them into the model's parameters (docs/COMMERCIAL-TERMS.md). A price that
 * isn't set keeps the template's default, read from the template so the two can't drift.
 */
import { mNumberParameter } from './transform/model.js';

/**
 * What the user set. An absent price keeps the template's default.
 * @typedef {object} Prices
 * @property {number} [creditRate]
 * @property {number} [prepaidCreditRate]
 * @property {number} [prepaidCreditBalance]
 * @property {number} [githubBusinessSeatPrice]
 * @property {number} [githubEnterpriseSeatPrice]
 * @property {number} [billingPeriodWeeks]
 */

/** @typedef {keyof Prices} PriceKey */

/**
 * @typedef {object} PriceInfo
 * @property {PriceKey} key
 * @property {string} parameter  The model parameter, a Number in the Fabric template.
 * @property {string} label
 * @property {string} hint  Where the user finds theirs.
 * @property {boolean} [whole]  A whole number.
 * @property {number} [min]  The least it can be. 0 when absent.
 */

/** @type {PriceInfo[]} */
export const PRICES = [
  { key: 'creditRate', parameter: 'CreditRate', label: 'Pay-as-you-go price per Copilot credit (USD)', hint: 'Your agreement or invoice. The list price is 0.01.' },
  {
    key: 'prepaidCreditRate',
    parameter: 'PrepaidCreditRate',
    label: 'Prepaid price per Copilot credit (USD)',
    hint: 'Your Copilot Credit Pre-Purchase Plan. The template\'s 0.008 is the largest tier; most organisations pay more.',
  },
  { key: 'prepaidCreditBalance', parameter: 'PrepaidCreditBalance', label: 'Prepaid Copilot credits bought (0 for none)', hint: 'Microsoft 365 admin center > Copilot > Cost management.' },
  { key: 'githubBusinessSeatPrice', parameter: 'GitHubBusinessSeatPrice', label: 'GitHub Copilot Business seat, per month (USD)', hint: 'Your GitHub agreement. The list price is 19.' },
  { key: 'githubEnterpriseSeatPrice', parameter: 'GitHubEnterpriseSeatPrice', label: 'GitHub Copilot Enterprise seat, per month (USD)', hint: 'Your GitHub agreement. The list price is 39.' },
  { key: 'billingPeriodWeeks', parameter: 'BillingPeriodWeeks', label: 'Billing period, in weeks', hint: 'Your billing cycle. 4 for monthly.', whole: true, min: 1 },
];

/**
 * The template's own value for each price.
 * @param {import('./transform/model.js').ModelBim} template
 * @returns {Required<Prices>}
 */
export function templatePrices(template) {
  /** @type {any} */
  const out = {};
  for (const p of PRICES) {
    const v = mNumberParameter(template.model, p.parameter);
    if (v === undefined) throw new Error(`The template has no number parameter "${p.parameter}".`);
    out[p.key] = v;
  }
  return out;
}

/**
 * Reads a typed price.
 * @param {PriceInfo} p
 * @param {string} text
 * @returns {number | string} the number, or why it can't be one
 */
export function parsePrice(p, text) {
  const t = text.trim();
  const n = Number(t);
  if (!t || !/^\d*\.?\d+$/.test(t) || !Number.isFinite(n)) return p.whole ? 'Enter a whole number.' : 'Enter a number, such as 0.01.';
  if (p.whole && !Number.isInteger(n)) return 'Enter a whole number.';
  if (n < (p.min ?? 0)) return `Enter ${p.min ?? 0} or more.`;
  return n;
}

/**
 * The model parameters to write: the prices the user set, by parameter name.
 * @param {Prices | undefined} prices
 * @returns {Record<string, number>}
 */
export function priceParameters(prices) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const p of PRICES) {
    const v = prices?.[p.key];
    if (typeof v === 'number' && Number.isFinite(v)) out[p.parameter] = v;
  }
  return out;
}

/**
 * Asks for every price, with the saved one or the template's as the default. Under --yes the
 * defaults stand. Prices equal to the template's aren't saved, so a later template default applies.
 * @param {import('./install.js').Ctx} ctx
 * @param {import('./transform/model.js').ModelBim} template
 */
export async function askPrices(ctx, template) {
  const { ui, config } = ctx;
  const defaults = templatePrices(template);
  const current = { ...defaults, ...(config.prices ?? {}) };
  ui.heading('Prices');
  ui.info('No export says what a credit or a seat costs you, so the report prices usage with these. See docs/COMMERCIAL-TERMS.md.');
  if (ui.yes) return;
  const values = await ui.form(
    'Prices',
    PRICES.map((p) => ({
      id: p.key,
      label: `${p.label}. ${p.hint}`,
      default: String(current[p.key]),
      validate: (/** @type {string} */ v) => {
        const n = parsePrice(p, v);
        return typeof n === 'number' ? true : n;
      },
    })),
  );
  if (!values) return;
  /** @type {Prices} */
  const set = {};
  for (const p of PRICES) {
    const n = parsePrice(p, values[p.key]);
    if (typeof n === 'number' && n !== defaults[p.key]) set[p.key] = n;
  }
  if (Object.keys(set).length) config.prices = set;
  else delete config.prices;
}

/**
 * One line for the plan and the summary.
 * @param {Prices | undefined} prices
 */
export function describePrices(prices) {
  const set = PRICES.filter((p) => typeof prices?.[p.key] === 'number');
  return set.length ? set.map((p) => `${p.parameter} ${prices?.[p.key]}`).join(', ') : 'the template\'s defaults';
}
