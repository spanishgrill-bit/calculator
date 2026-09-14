'use strict';

const assert = require('node:assert/strict');
const {
  calculateTradeEquity,
  calculateNetVehiclePrice,
  calculateTaxableAmount,
  calculateTax,
  calculateFees,
  calculateAmountFinanced,
  calculateMonthlyPayment,
  calculateTotalPayments,
  calculateTotalInterest,
  calculateMaximumFinancedAmount,
  calculateRequiredDownPayment,
  calculatePaymentGap,
  computeScenario,
  generateScenarios,
  scoreScenarios,
  calculateOwnershipCost,
  compareVehicles,
  calculateAffordabilityEstimate,
} = require('../src/calculationEngine');

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

console.log('\nSpec §54 tests (engine-level subset):\n');

// TEST 1 — NO TRADE
test('TEST 1: no trade => equity is 0', () => {
  assert.equal(calculateTradeEquity({ tradeValue: 0, payoff: 0 }), 0);
});

// TEST 2 — POSITIVE EQUITY
test('TEST 2: trade 18000, payoff 12000 => +6000 equity', () => {
  assert.equal(calculateTradeEquity({ tradeValue: 18000, payoff: 12000 }), 6000);
});

// TEST 3 — NEGATIVE EQUITY
test('TEST 3: trade 10000, payoff 14000 => -4000 equity', () => {
  assert.equal(calculateTradeEquity({ tradeValue: 10000, payoff: 14000 }), -4000);
});

// TEST 4 — ZERO EQUITY
test('TEST 4: trade 15000, payoff 15000 => 0 equity', () => {
  assert.equal(calculateTradeEquity({ tradeValue: 15000, payoff: 15000 }), 0);
});

// TEST 9 — TERM comparison: 48/60/72/84 months, same principal & APR,
// payment should strictly decrease and total interest strictly increase
// as term lengthens.
test('TEST 9: longer terms => lower payment, higher total interest', () => {
  const principal = 30000;
  const apr = 6.5;
  const terms = [48, 60, 72, 84];
  const payments = terms.map((t) => calculateMonthlyPayment(principal, apr, t));
  const interests = terms.map((t, i) => {
    const totalPayments = calculateTotalPayments(payments[i], t);
    return calculateTotalInterest(totalPayments, principal);
  });

  for (let i = 1; i < payments.length; i++) {
    assert.ok(payments[i] < payments[i - 1], `payment should drop from ${terms[i - 1]}mo to ${terms[i]}mo`);
    assert.ok(interests[i] > interests[i - 1], `total interest should rise from ${terms[i - 1]}mo to ${terms[i]}mo`);
  }
});

// TEST 10 — TARGET PAYMENT reverse calculation
test('TEST 10: reverse financing recovers a consistent principal', () => {
  const apr = 5.9;
  const termMonths = 60;
  const targetPayment = 600;
  const maxPrincipal = calculateMaximumFinancedAmount(targetPayment, apr, termMonths);
  const paymentOnThatPrincipal = calculateMonthlyPayment(maxPrincipal, apr, termMonths);
  // round-trip should land within a cent or two of the original target
  assert.ok(Math.abs(paymentOnThatPrincipal - targetPayment) < 0.05);
});

// TEST 11 — SCENARIO ENGINE generates multiple scenarios and scores them
test('TEST 11: scenario engine generates and scores multiple options', () => {
  const base = {
    vehiclePrice: 35000,
    taxes: 2100,
    fees: 700,
    tradeEquity: 3000,
    downPayment: 2000,
    aprPercent: 6.9,
    termMonths: 72,
    availableCash: 6000,
    alternateAPRs: [4.9],
    alternateTerms: [60, 84],
    lowerPriceDelta: 1500,
  };
  const scenarios = generateScenarios(base);
  assert.ok(scenarios.length >= 5, 'should generate the current deal plus several alternatives');
  assert.equal(scenarios[0].scenarioLabel, 'CURRENT DEAL');

  const scored = scoreScenarios(scenarios, 'lowest_total_cost');
  const recommendedCount = scored.filter((s) => s.isRecommended).length;
  assert.equal(recommendedCount, 1, 'exactly one scenario should be flagged as recommended');

  const recommended = scored.find((s) => s.isRecommended);
  const cheapest = [...scored].sort((a, b) => a.totalCost - b.totalCost)[0];
  assert.equal(
    recommended.scenarioLabel,
    cheapest.scenarioLabel,
    'lowest_total_cost objective should recommend the cheapest total-cost scenario'
  );
});

console.log('\nAdditional engine sanity checks:\n');

test('calculateNetVehiclePrice combines discounts/incentives/accessories correctly', () => {
  const net = calculateNetVehiclePrice({
    sellingPrice: 32000,
    dealerDiscount: 1000,
    manufacturerIncentives: 500,
    customerRebates: 250,
    otherDiscount: 0,
    accessoriesTotal: 300,
    dealerInstalledProductsTotal: 0,
  });
  assert.equal(net, 32000 - 1000 - 500 - 250 + 300);
});

test('calculateTaxableAmount applies a trade-tax-credit only when the jurisdiction allows it', () => {
  const withoutCredit = calculateTaxableAmount(30000, [{ amount: 500, isTaxable: true }], {
    allowTradeTaxCredit: false,
    tradeEquity: 6000,
  });
  const withCredit = calculateTaxableAmount(30000, [{ amount: 500, isTaxable: true }], {
    allowTradeTaxCredit: true,
    tradeEquity: 6000,
  });
  assert.equal(withoutCredit, 30500);
  assert.equal(withCredit, 30500 - 6000);
});

test('calculateTax applies rate to taxable amount', () => {
  assert.equal(calculateTax(30000, 0.06625), 1987.5);
});

test('calculateFees sums flat and percent fees against a base', () => {
  const { total, breakdown } = calculateFees(
    [
      { name: 'Doc Fee', amount: 499, amountType: 'flat', isTaxable: true },
      { name: 'Extended Service Percent Fee', amount: 2, amountType: 'percent', isTaxable: false },
    ],
    30000
  );
  assert.equal(breakdown[1].amount, 600); // 2% of 30000
  assert.equal(total, 499 + 600);
});

test('calculateAmountFinanced: positive equity reduces principal, negative equity rolled in increases it', () => {
  const withPositiveEquity = calculateAmountFinanced({
    netVehiclePrice: 30000,
    taxes: 2000,
    fees: 500,
    tradeEquity: 4000,
    downPayment: 1000,
  });
  const withNegativeEquityRolledIn = calculateAmountFinanced({
    netVehiclePrice: 30000,
    taxes: 2000,
    fees: 500,
    tradeEquity: -4000,
    downPayment: 1000,
    rollNegativeEquity: true,
  });
  assert.equal(withPositiveEquity, 30000 + 2000 + 500 - 1000 - 4000);
  assert.equal(withNegativeEquityRolledIn, 30000 + 2000 + 500 - 1000 + 4000);
});

test('calculateRequiredDownPayment inverts calculateAmountFinanced', () => {
  const netVehiclePrice = 30000;
  const taxes = 2000;
  const fees = 500;
  const tradeEquity = 3000;
  const desiredAmountFinanced = 25000;

  const requiredDown = calculateRequiredDownPayment({
    netVehiclePrice,
    taxes,
    fees,
    tradeEquity,
    desiredAmountFinanced,
  });
  const amountFinanced = calculateAmountFinanced({
    netVehiclePrice,
    taxes,
    fees,
    tradeEquity,
    downPayment: requiredDown,
  });
  assert.equal(amountFinanced, desiredAmountFinanced);
});

test('calculatePaymentGap reports direction correctly', () => {
  const above = calculatePaymentGap(732, 600);
  const below = calculatePaymentGap(500, 600);
  const onTarget = calculatePaymentGap(600, 600);
  assert.deepEqual(above, { difference: 132, direction: 'above_target' });
  assert.deepEqual(below, { difference: 100, direction: 'below_target' });
  assert.deepEqual(onTarget, { difference: 0, direction: 'on_target' });
});

test('computeScenario ties amount financed, payment, interest, and total cost together consistently', () => {
  const scenario = computeScenario({
    label: 'CURRENT DEAL',
    vehiclePrice: 30000,
    taxes: 2000,
    fees: 500,
    tradeEquity: 3000,
    downPayment: 2000,
    aprPercent: 6.5,
    termMonths: 60,
  });
  assert.equal(scenario.amountFinanced, 30000 + 2000 + 500 - 2000 - 3000);
  assert.ok(scenario.monthlyPayment > 0);
  assert.ok(Math.abs(scenario.totalPayments - scenario.monthlyPayment * 60) < 0.01);
  assert.ok(Math.abs(scenario.totalInterest - (scenario.totalPayments - scenario.amountFinanced)) < 0.01);
});

test('compareVehicles ranks by total cost and refuses to declare an overall "best"', () => {
  const a = computeScenario({ label: 'Vehicle A', vehiclePrice: 30000, taxes: 2000, fees: 500, tradeEquity: 0, downPayment: 3000, aprPercent: 6, termMonths: 60 });
  const b = computeScenario({ label: 'Vehicle B', vehiclePrice: 45000, taxes: 3000, fees: 500, tradeEquity: 0, downPayment: 3000, aprPercent: 6, termMonths: 60 });
  const result = compareVehicles([a, b]);
  assert.equal(result.rankedByTotalCost[0].scenarioLabel, 'Vehicle A');
  assert.match(result.disclaimer, /not necessarily the best/);
});

test('calculateOwnershipCost aggregates recurring costs and depreciation', () => {
  const result = calculateOwnershipCost(
    {
      purchasePrice: 30000,
      financingInterestTotal: 4000,
      annualInsurance: 1400,
      annualFuelOrEnergy: 1600,
      annualMaintenance: 600,
      annualRegistrationAndTax: 300,
      expectedResaleValue: 18000,
    },
    3
  );
  assert.equal(result.totalRecurringCosts, (1400 + 1600 + 600 + 300) * 3);
  assert.equal(result.estimatedDepreciation, 30000 - 18000);
});

test('calculateAffordabilityEstimate never returns a lender-approval claim', () => {
  const result = calculateAffordabilityEstimate({
    grossMonthlyIncome: 6000,
    housingPayment: 1800,
    existingDebtPayments: 400,
    insuranceEstimate: 150,
    estimatedVehicleExpenses: 100,
    desiredPayment: 500,
  });
  assert.ok(result.maxRecommendedPayment >= 0);
  assert.match(result.disclaimer, /not a lender approval/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
