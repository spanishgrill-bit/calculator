'use strict';

const assert = require('node:assert/strict');
const { pickEffectiveRow } = require('../netlify/functions/lib/effectiveDate');
const { validateDealInput } = require('../netlify/functions/lib/validateDealInput');
const { explainDeal } = require('../netlify/functions/lib/explainDeal');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL - ${name}`);
    console.error(`       ${err.message}`);
  }
}

console.log('\nHelper function tests:\n');

// TEST 12 (spec §54) — tax effective date selection
test('TEST 12: pickEffectiveRow selects the correct historical/future rate', () => {
  const rows = [
    { id: 'old', tax_rate: 0.06, effective_date: '2024-01-01', expiration_date: '2025-01-01', is_active: true },
    { id: 'current', tax_rate: 0.0663, effective_date: '2025-01-01', expiration_date: '2026-07-01', is_active: true },
    { id: 'future', tax_rate: 0.07, effective_date: '2026-07-01', expiration_date: null, is_active: true },
  ];
  assert.equal(pickEffectiveRow(rows, '2024-06-01').id, 'old');
  assert.equal(pickEffectiveRow(rows, '2025-06-01').id, 'current');
  assert.equal(pickEffectiveRow(rows, '2026-09-12').id, 'future');
  assert.equal(pickEffectiveRow(rows, '2023-01-01'), null);
});

test('pickEffectiveRow ignores soft-deleted (is_active=false) rows', () => {
  const rows = [
    { id: 'deleted', effective_date: '2026-01-01', expiration_date: null, is_active: false },
    { id: 'live', effective_date: '2026-01-01', expiration_date: null, is_active: true },
  ];
  assert.equal(pickEffectiveRow(rows, '2026-09-12').id, 'live');
});

test('pickEffectiveRow prefers the most recently effective row among matches', () => {
  const rows = [
    { id: 'a', effective_date: '2026-01-01', expiration_date: null, is_active: true },
    { id: 'b', effective_date: '2026-06-01', expiration_date: null, is_active: true }, // admin correction
  ];
  assert.equal(pickEffectiveRow(rows, '2026-09-12').id, 'b');
});

test('validateDealInput rejects non-positive selling price and negative trade values', () => {
  const result = validateDealInput({
    sellingPrice: -100,
    termMonths: 60,
    trade: { hasTrade: true, tradeValue: -1, payoff: 5000 },
  });
  assert.equal(result.isValid, false);
  assert.ok(result.errors.some((e) => e.includes('sellingPrice')));
  assert.ok(result.errors.some((e) => e.includes('tradeValue')));
});

test('validateDealInput warns (but does not block) on large negative equity and long terms', () => {
  const result = validateDealInput({
    sellingPrice: 30000,
    termMonths: 96,
    trade: { hasTrade: true, tradeValue: 5000, payoff: 15000 },
  });
  assert.equal(result.isValid, true);
  assert.ok(result.warnings.length >= 2);
});

test('explainDeal produces a plain-language string referencing the verified numbers only', () => {
  const scenarios = [
    { scenarioLabel: 'CURRENT DEAL', monthlyPayment: 732, totalInterest: 3000, cashRequired: 2000, termMonths: 60 },
  ];
  const text = explainDeal({
    tradeEquity: 6000,
    scenarios,
    recommended: scenarios[0],
    objective: 'lowest_total_cost',
    paymentGap: { difference: 132, direction: 'above_target' },
  });
  assert.match(text, /\$6,000/);
  assert.match(text, /\$732/);
  assert.match(text, /above your target/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
