// @ts-check
// The tests of seats.js from the ValueLens installer's test/seats.test.js (5910a84). Its other tests
// size ValueLens's Fabric route by seats, which Consumption Central's Fabric route doesn't do.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COPILOT_PLAN, copilotLicences, copilotSeats, seatCount } from '../src/seats.js';

/** @param {string} skuPartNumber @param {number} consumedUnits @param {string} [servicePlanName] */
const sku = (skuPartNumber, consumedUnits, servicePlanName = COPILOT_PLAN) => ({ skuPartNumber, consumedUnits, servicePlans: [{ servicePlanName }] });

test('seats: assigned Copilot seats are summed across every Copilot SKU and nothing else', () => {
  const found = copilotLicences([sku('Microsoft_365_Copilot', 25_000), sku('M365_Copilot_EDU', 1_500), sku('ENTERPRISEPACK', 90_000, 'EXCHANGE_S_ENTERPRISE')]);
  assert.deepEqual(found, { names: ['Microsoft_365_Copilot', 'M365_Copilot_EDU'], assigned: 26_500, found: true });
  assert.deepEqual(copilotLicences([]), { names: [], assigned: 0, found: false });
  assert.equal(seatCount(40_000), '40,000');
});

test('seats: a tenant whose licences can\'t be read has no seat count', async () => {
  const api = /** @type {any} */ ({ graph: { subscribedSkus: async () => [sku('Microsoft_365_Copilot', 32_000)] } });
  assert.equal(await copilotSeats(api), 32_000);
  assert.equal(await copilotSeats(/** @type {any} */ ({ graph: { subscribedSkus: async () => { throw new Error('403'); } } })), undefined);
  assert.equal(await copilotSeats(/** @type {any} */ ({ graph: {} })), undefined);
});
