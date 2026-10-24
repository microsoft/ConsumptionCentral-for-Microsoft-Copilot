// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askPrices, describePrices, parsePrice, priceParameters, PRICES, templatePrices } from '../src/prices.js';
import { buildModel, loadTemplateModel, mNumberParameter } from '../src/transform/model.js';
import { fakeCtx, fakeUi, realSources } from './fakes.js';

/** @typedef {import('../src/transform/model.js').ModelBim} ModelBim */

const template = loadTemplateModel(realSources().modelFile);

/** The Fabric template's own prices. */
const DEFAULTS = { creditRate: 0.01, prepaidCreditRate: 0.008, prepaidCreditBalance: 0, githubBusinessSeatPrice: 19, githubEnterpriseSeatPrice: 39, billingPeriodWeeks: 4 };

/** @param {import('../src/prices.js').PriceKey} key */
const price = (key) => /** @type {import('../src/prices.js').PriceInfo} */ (PRICES.find((p) => p.key === key));

/** @param {ModelBim} m @param {string} name */
function expression(m, name) {
  const e = m.model.expressions?.find((x) => x.name === name);
  assert.ok(e, name);
  return Array.isArray(e.expression) ? e.expression.join('\n') : e.expression;
}

/**
 * A UI whose price form answers with `values`, keeping the offered default for any price not given.
 * Null closes the form.
 * @param {Record<string, string> | null} [values]
 * @param {{ yes?: boolean }} [o]
 */
function formUi(values = {}, o = {}) {
  const t = fakeUi(o);
  /** @type {import('../src/ui.js').FormField[][]} */
  const forms = [];
  t.ui.form = async (_message, fields) => {
    forms.push(fields);
    return values && Object.fromEntries(fields.map((f) => [f.id, values[f.id] ?? f.default]));
  };
  return { ...t, forms };
}

test('the prices are exactly the Number parameters of the Fabric template, and read its defaults', () => {
  const numbers = (template.model.expressions ?? []).filter((e) => mNumberParameter(template.model, e.name) !== undefined).map((e) => e.name);
  assert.deepEqual(numbers.sort(), PRICES.map((p) => p.parameter).sort());
  assert.equal(new Set(PRICES.map((p) => p.key)).size, PRICES.length);
  assert.deepEqual(templatePrices(template), DEFAULTS);
  for (const p of PRICES) {
    if (DEFAULTS[p.key]) assert.ok(p.hint.includes(String(DEFAULTS[p.key])), `${p.key}: the hint quotes the template's ${DEFAULTS[p.key]}`);
  }
});

test('templatePrices fails on a template without one of the prices as a number parameter', () => {
  const missing = structuredClone(template);
  missing.model.expressions = missing.model.expressions?.filter((e) => e.name !== 'CreditRate');
  assert.throws(() => templatePrices(missing), { message: 'The template has no number parameter "CreditRate".' });

  const text = structuredClone(template);
  const weeks = text.model.expressions?.find((e) => e.name === 'BillingPeriodWeeks');
  assert.ok(weeks);
  weeks.expression = '"4" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=false]';
  assert.throws(() => templatePrices(text), { message: 'The template has no number parameter "BillingPeriodWeeks".' });
});

test('parsePrice reads a typed price and says what is wrong with a bad one', () => {
  const credit = price('creditRate');
  assert.equal(parsePrice(credit, '0.02'), 0.02);
  assert.equal(parsePrice(credit, ' 0.015 '), 0.015);
  assert.equal(parsePrice(credit, '.5'), 0.5);
  assert.equal(parsePrice(credit, '0'), 0);
  for (const bad of ['', ' ', 'abc', '-0.01', '1.', '1e3', '1,5', '0.01 USD', '$0.01']) assert.equal(parsePrice(credit, bad), 'Enter a number, such as 0.01.', bad);
  assert.equal(parsePrice(price('prepaidCreditBalance'), '250000'), 250000);

  const weeks = price('billingPeriodWeeks');
  assert.equal(parsePrice(weeks, '5'), 5);
  assert.equal(parsePrice(weeks, '4.0'), 4);
  assert.equal(parsePrice(weeks, '4.5'), 'Enter a whole number.');
  assert.equal(parsePrice(weeks, 'four'), 'Enter a whole number.');
  assert.equal(parsePrice(weeks, '0'), 'Enter 1 or more.');
});

test('priceParameters gives the prices set by model parameter, and they are written into the model', () => {
  assert.deepEqual(priceParameters(undefined), {});
  assert.deepEqual(priceParameters({}), {});
  const params = priceParameters({ billingPeriodWeeks: 5, creditRate: 0.02, prepaidCreditBalance: 0 });
  assert.deepEqual(Object.entries(params), [['CreditRate', 0.02], ['PrepaidCreditBalance', 0], ['BillingPeriodWeeks', 5]]);
  // A hand-edited record can hold anything.
  assert.deepEqual(priceParameters(/** @type {any} */ ({ creditRate: '0.02', prepaidCreditRate: NaN, githubBusinessSeatPrice: Infinity, githubEnterpriseSeatPrice: null, discount: 3 })), {});

  const built = buildModel(template, { server: 'abc.datawarehouse.fabric.microsoft.com', database: 'ConsumptionCentral', prices: priceParameters({ creditRate: 0.012, githubEnterpriseSeatPrice: 45 }) });
  assert.deepEqual(templatePrices(built), { ...DEFAULTS, creditRate: 0.012, githubEnterpriseSeatPrice: 45 });
  for (const name of ['CreditRate', 'GitHubEnterpriseSeatPrice']) {
    assert.equal(expression(built, name).replace(/^\S+/, ''), expression(template, name).replace(/^\S+/, ''), `${name} keeps its meta record`);
  }
  assert.deepEqual(templatePrices(template), DEFAULTS, 'the template is left alone');
});

test('askPrices offers every price with the template default, and saves only the ones that differ', async () => {
  const t = formUi({ creditRate: '0.012', githubBusinessSeatPrice: '19.00', billingPeriodWeeks: '5' });
  const { ctx, config } = fakeCtx({ ui: t.ui });
  await askPrices(ctx, template);
  assert.equal(t.forms.length, 1);
  const [fields] = t.forms;
  assert.deepEqual(fields.map((f) => f.id), PRICES.map((p) => p.key));
  assert.deepEqual(fields.map((f) => f.default), ['0.01', '0.008', '0', '19', '39', '4']);
  assert.equal(fields[0].label, 'Pay-as-you-go price per Copilot credit (USD). Your agreement or invoice. The list price is 0.01.');
  assert.deepEqual(config.prices, { creditRate: 0.012, billingPeriodWeeks: 5 }, '19.00 is the template default');
  assert.match(t.text(), /Prices\n {4}No export says what a credit or a seat costs you, so the report prices usage with these\. See docs\/COMMERCIAL-TERMS\.md\.\n/);

  const field = (/** @type {string} */ id) => fields.find((f) => f.id === id)?.validate;
  assert.equal(field('creditRate')?.('0.02'), true);
  assert.equal(field('creditRate')?.('-0.02'), 'Enter a number, such as 0.01.');
  assert.equal(field('billingPeriodWeeks')?.('0'), 'Enter 1 or more.');
  assert.equal(field('billingPeriodWeeks')?.('2.5'), 'Enter a whole number.');
});

test('askPrices offers the saved prices, keeps them, and forgets them once they are back to the template defaults', async () => {
  const kept = formUi();
  const one = fakeCtx({ ui: kept.ui });
  one.config.prices = { creditRate: 0.02, prepaidCreditBalance: 100000 };
  await askPrices(one.ctx, template);
  assert.deepEqual(kept.forms[0].map((f) => f.default), ['0.02', '0.008', '100000', '19', '39', '4']);
  assert.deepEqual(one.config.prices, { creditRate: 0.02, prepaidCreditBalance: 100000 });

  const reset = formUi({ creditRate: '0.01', prepaidCreditBalance: '0' });
  const two = fakeCtx({ ui: reset.ui });
  two.config.prices = { creditRate: 0.02, prepaidCreditBalance: 100000 };
  await askPrices(two.ctx, template);
  assert.ok(!('prices' in two.config));
});

test('askPrices leaves the prices alone under --yes, without asking, and when the form is closed', async () => {
  const yes = formUi({ creditRate: '0.5' }, { yes: true });
  const one = fakeCtx({ ui: yes.ui });
  one.config.prices = { creditRate: 0.02 };
  await askPrices(one.ctx, template);
  assert.equal(yes.forms.length, 0);
  assert.deepEqual(one.config.prices, { creditRate: 0.02 });
  assert.match(yes.text(), /No export says what a credit or a seat costs you/);

  const closed = formUi(null);
  const two = fakeCtx({ ui: closed.ui });
  two.config.prices = { creditRate: 0.02 };
  await askPrices(two.ctx, template);
  assert.equal(closed.forms.length, 1);
  assert.deepEqual(two.config.prices, { creditRate: 0.02 });
});

test('describePrices lists the prices set by parameter, or says the template defaults apply', () => {
  assert.equal(describePrices(undefined), "the template's defaults");
  assert.equal(describePrices({}), "the template's defaults");
  assert.equal(describePrices({ billingPeriodWeeks: 5, creditRate: 0.02 }), 'CreditRate 0.02, BillingPeriodWeeks 5');
  assert.equal(describePrices({ prepaidCreditBalance: 0 }), 'PrepaidCreditBalance 0');
});
