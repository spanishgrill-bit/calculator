/**
 * AUTO DEAL IQ (TM) — Deterministic Calculation Engine
 *
 * Per spec §34: this file performs ALL authoritative financial math.
 * The AI explanation layer must never compute numbers — it only reads
 * the objects these functions return and describes them in plain language.
 *
 * Design notes:
 *  - Every function is pure (no I/O, no DB, no dates-as-"today" assumptions
 *    baked in) so it is independently unit-testable and safe to call from
 *    either a Node/Express API or Netlify Functions.
 *  - Money is handled as plain JS numbers (not integer cents) per the
 *    spec's "do not round intermediate calculations unnecessarily"
 *    instruction (§19) — rounding to cents happens only at display-value
 *    boundaries via round2(), never mid-calculation.
 *  - Nothing in this file talks to vehicle_pricing / tax_rules / apr_rules
 *    tables directly. Callers resolve the correct rate/rule rows (using
 *    effective_date logic) and pass plain numbers in.
 */

'use strict';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Round to 2 decimal places for display. Never use mid-calculation. */
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function assertFinite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number, got ${JSON.stringify(value)}`);
  }
}

// ---------------------------------------------------------------------------
// Trade equity
// ---------------------------------------------------------------------------

/**
 * calculateTradeEquity
 * §14 — TRADE EQUITY = TRADE VALUE − PAYOFF
 * No trade => pass tradeValue = 0, payoff = 0 => equity = 0 (§13).
 */
function calculateTradeEquity({ tradeValue = 0, payoff = 0 } = {}) {
  assertFinite(tradeValue, 'tradeValue');
  assertFinite(payoff, 'payoff');
  return round2(tradeValue - payoff);
}

// ---------------------------------------------------------------------------
// Vehicle pricing
// ---------------------------------------------------------------------------

/**
 * calculateNetVehiclePrice
 * §12 — combine selling price, discounts, incentives, rebates, accessories,
 * dealer-installed products into one net price, without double-counting.
 *
 * Caller is responsible for ensuring `manufacturerIncentives` and
 * `customerRebates` passed in here are the SAME incentive rows recorded in
 * deals.applied_incentive_ids — this function does not dedupe by ID, it
 * simply sums what it is given exactly once each.
 */
function calculateNetVehiclePrice({
  sellingPrice,
  dealerDiscount = 0,
  manufacturerIncentives = 0,
  customerRebates = 0,
  otherDiscount = 0,
  accessoriesTotal = 0,
  dealerInstalledProductsTotal = 0,
} = {}) {
  assertFinite(sellingPrice, 'sellingPrice');
  const net =
    sellingPrice -
    dealerDiscount -
    manufacturerIncentives -
    customerRebates -
    otherDiscount +
    accessoriesTotal +
    dealerInstalledProductsTotal;
  return round2(Math.max(net, 0));
}

// ---------------------------------------------------------------------------
// Taxes & fees
// ---------------------------------------------------------------------------

/**
 * calculateTaxableAmount
 * §6/§16 — some states let trade-in value reduce the taxable amount
 * (a "trade tax credit"); most tax fees selectively depending on category.
 *
 * @param {number} netVehiclePrice
 * @param {Array<{amount:number, isTaxable:boolean}>} fees
 * @param {object} opts
 * @param {boolean} opts.allowTradeTaxCredit - jurisdiction-specific rule
 * @param {number} opts.tradeEquity - only applied as a credit if allowTradeTaxCredit
 */
function calculateTaxableAmount(netVehiclePrice, fees = [], opts = {}) {
  assertFinite(netVehiclePrice, 'netVehiclePrice');
  const { allowTradeTaxCredit = false, tradeEquity = 0 } = opts;

  const taxableFeesTotal = fees
    .filter((f) => f.isTaxable)
    .reduce((sum, f) => sum + f.amount, 0);

  let taxable = netVehiclePrice + taxableFeesTotal;

  if (allowTradeTaxCredit && tradeEquity > 0) {
    // Positive trade value (not net equity mixed with negative payoff logic)
    // reduces the taxable base in trade-tax-credit states.
    taxable -= tradeEquity;
  }

  return round2(Math.max(taxable, 0));
}

/** calculateTax — straightforward rate application against a resolved taxable amount. */
function calculateTax(taxableAmount, taxRate) {
  assertFinite(taxableAmount, 'taxableAmount');
  assertFinite(taxRate, 'taxRate');
  return round2(taxableAmount * taxRate);
}

/**
 * calculateFees
 * §16 — sums configured fee rules; percent-type fees are computed against
 * the given base (typically net vehicle price).
 * @param {Array<{amount:number, amountType:'flat'|'percent'}>} feeRules
 * @param {number} base - used when amountType === 'percent'
 * @returns {{ total: number, breakdown: Array<{name?:string, amount:number}> }}
 */
function calculateFees(feeRules = [], base = 0) {
  const breakdown = feeRules.map((rule) => {
    const amount = rule.amountType === 'percent' ? base * (rule.amount / 100) : rule.amount;
    return { name: rule.name, amount: round2(amount), isTaxable: !!rule.isTaxable };
  });
  const total = round2(breakdown.reduce((sum, f) => sum + f.amount, 0));
  return { total, breakdown };
}

// ---------------------------------------------------------------------------
// Financing
// ---------------------------------------------------------------------------

/**
 * calculateAmountFinanced
 * §12/§19 — everything that must be financed after cash inputs and trade
 * equity are applied.
 *
 * Negative trade equity, if rolled into the loan (the common case), INCREASES
 * the amount financed. If not rolled in, the caller should not pass it here.
 */
function calculateAmountFinanced({
  netVehiclePrice,
  taxes = 0,
  fees = 0,
  tradeEquity = 0,
  downPayment = 0,
  rollNegativeEquity = true,
}) {
  assertFinite(netVehiclePrice, 'netVehiclePrice');
  let amount = netVehiclePrice + taxes + fees - downPayment;

  if (tradeEquity >= 0) {
    amount -= tradeEquity; // positive equity reduces amount financed
  } else if (rollNegativeEquity) {
    amount += Math.abs(tradeEquity); // negative equity rolled in increases it
  }
  // if negative and NOT rolled in, caller is handling it as extra cash due —
  // it does not touch amount financed here.

  return round2(Math.max(amount, 0));
}

/** Monthly interest rate from an APR expressed as a percent, e.g. 6.5 -> 0.065/12 */
function monthlyRateFromAPR(aprPercent) {
  return aprPercent / 100 / 12;
}

/**
 * calculateMonthlyPayment
 * §19 — standard fixed-rate amortization:
 *   M = P * [r(1+r)^n] / [(1+r)^n - 1]
 * Handles 0% APR as a straight-line P/n (r=0 is a removable singularity).
 */
function calculateMonthlyPayment(principal, aprPercent, termMonths) {
  assertFinite(principal, 'principal');
  assertFinite(aprPercent, 'aprPercent');
  assertFinite(termMonths, 'termMonths');
  if (termMonths <= 0) throw new RangeError('termMonths must be positive');
  if (principal <= 0) return 0;

  const r = monthlyRateFromAPR(aprPercent);
  if (r === 0) return round2(principal / termMonths);

  const factor = Math.pow(1 + r, termMonths);
  const payment = (principal * (r * factor)) / (factor - 1);
  return round2(payment);
}

/** calculateTotalPayments — §19 */
function calculateTotalPayments(monthlyPayment, termMonths) {
  return round2(monthlyPayment * termMonths);
}

/** calculateTotalInterest — §19 */
function calculateTotalInterest(totalPayments, principal) {
  return round2(totalPayments - principal);
}

/**
 * Full amortization schedule (§19 — "amortization schedule").
 * Not rounded per-row to avoid compounding rounding error; final row is
 * adjusted so the sum of principal portions exactly equals the principal.
 */
function buildAmortizationSchedule(principal, aprPercent, termMonths) {
  const r = monthlyRateFromAPR(aprPercent);
  const payment = calculateMonthlyPayment(principal, aprPercent, termMonths);
  let balance = principal;
  const schedule = [];

  for (let month = 1; month <= termMonths; month++) {
    const interestPortion = balance * r;
    let principalPortion = payment - interestPortion;
    if (month === termMonths) {
      // true up rounding drift on the final payment
      principalPortion = balance;
    }
    balance = round2(balance - principalPortion);
    schedule.push({
      month,
      payment: round2(month === termMonths ? principalPortion + interestPortion : payment),
      principalPortion: round2(principalPortion),
      interestPortion: round2(interestPortion),
      remainingBalance: Math.max(balance, 0),
    });
  }
  return schedule;
}

/**
 * calculateMaximumFinancedAmount
 * §21 — reverse financing: given a target monthly payment, APR, and term,
 * find the maximum principal that produces that payment.
 *   P = M * [(1+r)^n - 1] / [r(1+r)^n]
 */
function calculateMaximumFinancedAmount(targetPayment, aprPercent, termMonths) {
  assertFinite(targetPayment, 'targetPayment');
  assertFinite(aprPercent, 'aprPercent');
  assertFinite(termMonths, 'termMonths');
  if (termMonths <= 0) throw new RangeError('termMonths must be positive');

  const r = monthlyRateFromAPR(aprPercent);
  if (r === 0) return round2(targetPayment * termMonths);

  const factor = Math.pow(1 + r, termMonths);
  const principal = (targetPayment * (factor - 1)) / (r * factor);
  return round2(principal);
}

/**
 * calculateRequiredDownPayment
 * §21 — given a desired amount financed and everything else about the
 * deal, back into the down payment needed to hit it.
 */
function calculateRequiredDownPayment({
  netVehiclePrice,
  taxes = 0,
  fees = 0,
  tradeEquity = 0,
  desiredAmountFinanced,
}) {
  assertFinite(netVehiclePrice, 'netVehiclePrice');
  assertFinite(desiredAmountFinanced, 'desiredAmountFinanced');
  const totalDealAmount = netVehiclePrice + taxes + fees - Math.max(tradeEquity, 0);
  const negativeEquityAdd = tradeEquity < 0 ? Math.abs(tradeEquity) : 0;
  const required = totalDealAmount + negativeEquityAdd - desiredAmountFinanced;
  return round2(Math.max(required, 0));
}

/**
 * calculatePaymentGap
 * §20 — "Current = $732, Target = $600, Difference = $132/month"
 */
function calculatePaymentGap(currentPayment, targetPayment) {
  assertFinite(currentPayment, 'currentPayment');
  assertFinite(targetPayment, 'targetPayment');
  const difference = round2(currentPayment - targetPayment);
  return {
    difference: Math.abs(difference),
    direction: difference > 0 ? 'above_target' : difference < 0 ? 'below_target' : 'on_target',
  };
}

// ---------------------------------------------------------------------------
// Scenario engine (§22-26)
// ---------------------------------------------------------------------------

/**
 * computeScenario — runs one fully-specified deal configuration through the
 * financing math and returns a deal_scenarios-shaped result object.
 * This is the single source of truth every scenario (current + generated
 * alternatives) is built from, so they're guaranteed to be apples-to-apples.
 */
function computeScenario({
  label,
  vehiclePrice, // net vehicle price for this scenario
  taxes = 0,
  fees = 0,
  tradeEquity = 0,
  downPayment = 0,
  aprPercent,
  termMonths,
  rollNegativeEquity = true,
}) {
  const amountFinanced = calculateAmountFinanced({
    netVehiclePrice: vehiclePrice,
    taxes,
    fees,
    tradeEquity,
    downPayment,
    rollNegativeEquity,
  });
  const monthlyPayment = calculateMonthlyPayment(amountFinanced, aprPercent, termMonths);
  const totalPayments = calculateTotalPayments(monthlyPayment, termMonths);
  const totalInterest = calculateTotalInterest(totalPayments, amountFinanced);

  const negativeEquityCashDue =
    tradeEquity < 0 && !rollNegativeEquity ? Math.abs(tradeEquity) : 0;
  const cashRequired = round2(downPayment + negativeEquityCashDue);
  const totalCost = round2(totalPayments + cashRequired);

  return {
    scenarioLabel: label,
    vehiclePrice: round2(vehiclePrice),
    tradeEquity: round2(tradeEquity),
    downPayment: round2(downPayment),
    amountFinanced,
    apr: aprPercent,
    termMonths,
    monthlyPayment,
    cashRequired,
    totalInterest,
    totalPayments,
    totalCost,
  };
}

/**
 * generateScenarios
 * §23 — builds "CURRENT DEAL" plus legitimate, input-supported alternatives.
 * Only variations for which the base deal actually has room are generated
 * (e.g. "less down payment" is skipped if down payment is already 0).
 *
 * @param {object} base - the current deal, in computeScenario's input shape,
 *   plus optional bounds: availableCash, maxTermMonths, alternateAPRs (array),
 *   alternateTerms (array), lowerPriceDelta, additionalIncentiveAmount.
 */
function generateScenarios(base) {
  const scenarios = [];

  scenarios.push(computeScenario({ ...base, label: 'CURRENT DEAL' }));

  // MORE DOWN PAYMENT — only if the customer has cash headroom
  if (typeof base.availableCash === 'number' && base.availableCash > base.downPayment) {
    const extra = round2((base.availableCash - base.downPayment) / 2);
    if (extra > 0) {
      scenarios.push(
        computeScenario({ ...base, label: 'MORE DOWN PAYMENT', downPayment: base.downPayment + extra })
      );
    }
  }

  // LESS DOWN PAYMENT — only if there is a down payment to reduce
  if (base.downPayment > 0) {
    scenarios.push(
      computeScenario({ ...base, label: 'LESS DOWN PAYMENT', downPayment: round2(base.downPayment / 2) })
    );
  }

  // DIFFERENT APR — only if alternates were supplied (e.g. a different lender/tier)
  (base.alternateAPRs || []).forEach((apr) => {
    scenarios.push(computeScenario({ ...base, label: `APR ${apr}%`, aprPercent: apr }));
  });

  // DIFFERENT TERM
  (base.alternateTerms || []).forEach((term) => {
    scenarios.push(computeScenario({ ...base, label: `${term}-MONTH TERM`, termMonths: term }));
  });

  // LOWER VEHICLE PRICE — only if a negotiation delta was supplied
  if (base.lowerPriceDelta > 0) {
    scenarios.push(
      computeScenario({
        ...base,
        label: 'LOWER VEHICLE PRICE',
        vehiclePrice: round2(base.vehiclePrice - base.lowerPriceDelta),
      })
    );
  }

  // ADDITIONAL REBATE/INCENTIVE — only if one was supplied as available
  if (base.additionalIncentiveAmount > 0) {
    scenarios.push(
      computeScenario({
        ...base,
        label: 'ADDITIONAL REBATE/INCENTIVE',
        vehiclePrice: round2(base.vehiclePrice - base.additionalIncentiveAmount),
      })
    );
  }

  return scenarios;
}

/**
 * scoreScenario / scoreScenarios
 * §25 — transparent, explainable weighted scoring against the customer's
 * chosen objective. Lower is better for every raw metric used, so scores
 * are normalized 0-1 (0 = worst in the set, 1 = best) then weighted and
 * summed — the weights themselves are the "explanation" of why a scenario
 * won, and are returned alongside the score for the AI layer to describe.
 */
const OBJECTIVE_WEIGHTS = {
  lowest_payment: { monthlyPayment: 0.5, cashRequired: 0.2, totalInterest: 0.2, termMonths: 0.1 },
  lowest_total_cost: { totalCost: 0.4, totalInterest: 0.3, cashRequired: 0.2, termMonths: 0.1 },
  lowest_cash: { cashRequired: 0.6, monthlyPayment: 0.2, totalInterest: 0.2 },
  fastest_payoff: { termMonths: 0.6, totalInterest: 0.3, monthlyPayment: 0.1 },
  best_balance: {
    monthlyPayment: 0.25,
    totalCost: 0.25,
    totalInterest: 0.25,
    cashRequired: 0.15,
    termMonths: 0.1,
  },
};

function normalize(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 1);
  // lower raw value => higher normalized score (1 = best/lowest)
  return values.map((v) => 1 - (v - min) / (max - min));
}

/**
 * scoreScenarios
 * @param {Array} scenarios - output of generateScenarios
 * @param {string} objective - one of OBJECTIVE_WEIGHTS keys
 * @param {number|null} targetPayment - if provided, closeness to target
 *   monthly payment is folded in as an extra weighted factor rather than
 *   just "lowest is best" (per §26's "closest to your $600 target" logic).
 */
function scoreScenarios(scenarios, objective, targetPayment = null) {
  const weights = OBJECTIVE_WEIGHTS[objective] || OBJECTIVE_WEIGHTS.best_balance;
  const metricKeys = Object.keys(weights);

  const normalizedByMetric = {};
  metricKeys.forEach((key) => {
    normalizedByMetric[key] = normalize(scenarios.map((s) => s[key]));
  });

  let targetCloseness = null;
  if (typeof targetPayment === 'number') {
    const distances = scenarios.map((s) => Math.abs(s.monthlyPayment - targetPayment));
    targetCloseness = normalize(distances); // 1 = closest to target
  }

  const scored = scenarios.map((scenario, i) => {
    let score = 0;
    metricKeys.forEach((key) => {
      score += normalizedByMetric[key][i] * weights[key];
    });
    if (targetCloseness) {
      // blend in target-closeness at a fixed 25% influence, rescaling the
      // rest of the weighted score to still sum to 1
      score = score * 0.75 + targetCloseness[i] * 0.25;
    }
    return { ...scenario, score: round2(score * 100) };
  });

  let bestIndex = 0;
  scored.forEach((s, i) => {
    if (s.score > scored[bestIndex].score) bestIndex = i;
  });
  return scored.map((s, i) => ({ ...s, isRecommended: i === bestIndex }));
}

// ---------------------------------------------------------------------------
// Total cost of ownership (§29)
// ---------------------------------------------------------------------------

/**
 * calculateOwnershipCost
 * @param {object} inputs
 * @param {number} inputs.purchasePrice
 * @param {number} inputs.financingInterestTotal - total interest over the years being evaluated
 * @param {number} inputs.annualInsurance
 * @param {number} inputs.annualFuelOrEnergy
 * @param {number} inputs.annualMaintenance
 * @param {number} inputs.annualRegistrationAndTax
 * @param {number} inputs.expectedResaleValue - at the end of `years`
 * @param {number} years
 */
function calculateOwnershipCost(inputs, years) {
  const {
    purchasePrice,
    financingInterestTotal = 0,
    annualInsurance = 0,
    annualFuelOrEnergy = 0,
    annualMaintenance = 0,
    annualRegistrationAndTax = 0,
    expectedResaleValue = 0,
  } = inputs;

  const recurringAnnual =
    annualInsurance + annualFuelOrEnergy + annualMaintenance + annualRegistrationAndTax;
  const totalRecurring = round2(recurringAnnual * years);
  const totalCost = round2(
    purchasePrice + financingInterestTotal + totalRecurring - expectedResaleValue
  );

  return {
    years,
    totalRecurringCosts: totalRecurring,
    estimatedDepreciation: round2(purchasePrice - expectedResaleValue),
    totalEstimatedCost: totalCost,
  };
}

// ---------------------------------------------------------------------------
// Vehicle comparison (§28)
// ---------------------------------------------------------------------------

/**
 * compareVehicles
 * Accepts up to 3 fully-computed scenario-like objects (one per vehicle,
 * each already run through computeScenario) and returns them ranked by
 * total cost — WITHOUT declaring a "winner" as objectively best overall,
 * per the spec's explicit instruction not to claim cheapest = best vehicle.
 */
function compareVehicles(vehicleScenarios) {
  if (vehicleScenarios.length < 2 || vehicleScenarios.length > 3) {
    throw new RangeError('compareVehicles accepts 2 or 3 vehicles');
  }
  const ranked = [...vehicleScenarios].sort((a, b) => a.totalCost - b.totalCost);
  return {
    rankedByTotalCost: ranked,
    lowestTotalCostLabel: ranked[0].scenarioLabel,
    disclaimer:
      'Ranked by total financial cost only. The financially cheapest vehicle is not necessarily the best overall choice.',
  };
}

// ---------------------------------------------------------------------------
// Affordability (§31)
// ---------------------------------------------------------------------------

/**
 * calculateAffordabilityEstimate
 * Educational estimate only — never a lender approval (enforced by the
 * caller displaying the required disclaimer alongside this result).
 */
function calculateAffordabilityEstimate({
  grossMonthlyIncome,
  housingPayment = 0,
  existingDebtPayments = 0,
  insuranceEstimate = 0,
  estimatedVehicleExpenses = 0,
  desiredPayment = 0,
}) {
  assertFinite(grossMonthlyIncome, 'grossMonthlyIncome');
  // Simple, transparent debt-to-income based estimate: total obligations
  // (including the proposed vehicle payment + insurance + other vehicle
  // costs) should not exceed a conventional 45% DTI guideline.
  const DTI_GUIDELINE = 0.45;
  const maxTotalObligations = round2(grossMonthlyIncome * DTI_GUIDELINE);
  const existingObligations = round2(housingPayment + existingDebtPayments);
  const remainingForVehicle = round2(Math.max(maxTotalObligations - existingObligations, 0));
  const vehicleRelatedCosts = round2(insuranceEstimate + estimatedVehicleExpenses);
  const maxRecommendedPayment = round2(Math.max(remainingForVehicle - vehicleRelatedCosts, 0));

  return {
    maxRecommendedPayment,
    desiredPaymentFits: desiredPayment <= maxRecommendedPayment,
    dtiGuidelineUsed: DTI_GUIDELINE,
    disclaimer: 'Educational estimate only. This is not a lender approval or financial advice.',
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  round2,
  calculateTradeEquity,
  calculateNetVehiclePrice,
  calculateTaxableAmount,
  calculateTax,
  calculateFees,
  calculateAmountFinanced,
  calculateMonthlyPayment,
  calculateTotalPayments,
  calculateTotalInterest,
  buildAmortizationSchedule,
  calculateMaximumFinancedAmount,
  calculateRequiredDownPayment,
  calculatePaymentGap,
  computeScenario,
  generateScenarios,
  scoreScenarios,
  calculateOwnershipCost,
  compareVehicles,
  calculateAffordabilityEstimate,
  OBJECTIVE_WEIGHTS,
};
