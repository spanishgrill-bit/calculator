'use strict';

const { getSupabaseClient } = require('./lib/supabaseClient');
const { resolveTaxRate } = require('./lib/taxResolver');
const { resolveVehicleSource, resolveIncentives, resolveFees, resolveApr } = require('./lib/dbResolvers');
const { validateDealInput } = require('./lib/validateDealInput');
const { explainDeal, explainForDealer } = require('./lib/explainDeal');
const { ok, badRequest, serverError, preflight, json } = require('./lib/http');

const engine = require('../../src/calculationEngine');

/**
 * POST /api/calculate-deal
 *
 * This is the ONE endpoint the frontend calls to go from raw form inputs to
 * a full scenario comparison. It is the concrete implementation of the
 * architecture diagram in spec §34:
 *
 *   USER INPUT -> VALIDATION -> LOCATION/TAX ENGINE -> DETERMINISTIC
 *   FINANCIAL ENGINE -> SCENARIO ENGINE -> OPTIMIZATION ENGINE ->
 *   VERIFIED RESULTS -> AI EXPLANATION
 *
 * Every number in the response comes from src/calculationEngine.js.
 * explainDeal()/explainForDealer() only describe those numbers afterward.
 *
 * Request body shape:
 * {
 *   dealershipZip, customerRegistrationZip,
 *   vehicleSource: { type: 'trim'|'used'|'manual', trimId?, usedListingId?, manualEntry? },
 *   vehicleCondition: 'new'|'used'|'cpo',
 *   sellingPrice, dealerDiscount, otherDiscount, accessoriesTotal, dealerInstalledProductsTotal,
 *   appliedIncentiveIds: [uuid, ...],
 *   dealershipId,
 *   trade: { hasTrade, tradeValue, payoff } | null,
 *   downPayment, cashAvailable,
 *   creditTierId, lenderId?, termMonths,
 *   targetPayment?, objective ('lowest_payment'|'lowest_total_cost'|'lowest_cash'|'fastest_payoff'|'best_balance'),
 *   asOfDate? (defaults to today),
 *   mode: 'customer'|'dealer' (controls which fields the response includes)
 * }
 */
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return badRequest('Use POST');

  let input;
  try {
    input = JSON.parse(event.body || '{}');
  } catch {
    return badRequest('Request body must be valid JSON');
  }

  const { errors, warnings, isValid } = validateDealInput(input);
  if (!isValid) return badRequest(errors.join(' '));

  const asOfDate = input.asOfDate || new Date().toISOString().slice(0, 10);
  const mode = input.mode === 'dealer' ? 'dealer' : 'customer';

  try {
    const supabase = getSupabaseClient();

    // ---- LOCATION / TAX ENGINE (§4-§9) ----
    // Deliberately resolved from customerRegistrationZip, never dealershipZip.
    // A dealer/admin can pass taxRateOverride to bypass provider resolution
    // entirely (e.g. they already know the correct local rate, or every
    // provider is down and TAX_UNAVAILABLE came back on a prior attempt).
    let taxResolution;
    if (typeof input.taxRateOverride === 'number') {
      taxResolution = {
        jurisdiction: { state: null, city: null, id: null, zip_code: input.customerRegistrationZip },
        taxRate: input.taxRateOverride,
        taxableCategories: [],
        isStale: false,
        isManualOverride: true,
      };
    } else {
      try {
        taxResolution = await resolveTaxRate(supabase, input.customerRegistrationZip, asOfDate);
      } catch (taxErr) {
        if (taxErr.code === 'TAX_UNAVAILABLE') {
          return json(422, {
            code: 'TAX_UNAVAILABLE',
            error:
              'Could not automatically determine the tax rate for that ZIP code right now (no cached rate and the tax provider is unreachable). Enter a rate manually to continue.',
          });
        }
        throw taxErr;
      }
    }

    // ---- VEHICLE / PRICING (§8-§12) ----
    const vehicleInfo = await resolveVehicleSource(supabase, input.vehicleSource, asOfDate);
    const { manufacturerIncentives, customerRebates, applied } = await resolveIncentives(
      supabase,
      input.appliedIncentiveIds
    );

    const netVehiclePrice = engine.calculateNetVehiclePrice({
      sellingPrice: input.sellingPrice,
      dealerDiscount: input.dealerDiscount || 0,
      manufacturerIncentives,
      customerRebates,
      otherDiscount: input.otherDiscount || 0,
      accessoriesTotal: input.accessoriesTotal || 0,
      dealerInstalledProductsTotal: input.dealerInstalledProductsTotal || 0,
    });

    // ---- FEES (§16) ----
    const feeRules = await resolveFees(supabase, input.dealershipId, asOfDate);
    const feeResult = engine.calculateFees(
      feeRules.map((f) => ({ name: f.name, amount: Number(f.amount), amountType: f.amount_type, isTaxable: f.is_taxable })),
      netVehiclePrice
    );

    // ---- TRADE (§13-§14) ----
    const trade = input.trade && input.trade.hasTrade ? input.trade : { tradeValue: 0, payoff: 0 };
    const tradeEquity = engine.calculateTradeEquity(trade);

    // ---- TAXABLE AMOUNT & TAX (§6-§7) ----
    const allowTradeTaxCredit = taxResolution.taxableCategories.includes('trade_tax_credit');
    const taxableAmount = engine.calculateTaxableAmount(netVehiclePrice, feeResult.breakdown, {
      allowTradeTaxCredit,
      tradeEquity,
    });
    const estimatedTax = engine.calculateTax(taxableAmount, taxResolution.taxRate);

    // ---- APR (§17-§18) ----
    const aprRule = await resolveApr(
      supabase,
      {
        lenderId: input.lenderId,
        creditTierId: input.creditTierId,
        vehicleCondition: input.vehicleCondition || 'new',
        termMonths: input.termMonths,
      },
      asOfDate
    );
    const estimatedApr = input.estimatedAprOverride != null ? input.estimatedAprOverride : Number(aprRule.default_apr);

    // ---- CURRENT DEAL (§19) ----
    const currentScenarioBase = {
      vehiclePrice: netVehiclePrice,
      taxes: estimatedTax,
      fees: feeResult.total,
      tradeEquity,
      downPayment: input.downPayment || 0,
      aprPercent: estimatedApr,
      termMonths: input.termMonths,
      availableCash: input.cashAvailable,
      alternateTerms: [48, 60, 72, 84].filter((t) => t !== input.termMonths),
      lowerPriceDelta: Math.round(netVehiclePrice * 0.03), // a modest, clearly-labeled negotiation delta
    };

    // ---- SCENARIO + OPTIMIZATION ENGINE (§22-§26) ----
    const rawScenarios = engine.generateScenarios(currentScenarioBase);
    const objective = input.objective || 'best_balance';
    const scoredScenarios = engine.scoreScenarios(rawScenarios, objective, input.targetPayment || null);
    const recommended = scoredScenarios.find((s) => s.isRecommended);

    const paymentGap =
      input.targetPayment != null
        ? engine.calculatePaymentGap(scoredScenarios[0].monthlyPayment, input.targetPayment)
        : null;

    // ---- AI EXPLANATION LAYER (§32-§34) — reads verified numbers only ----
    const customerExplanation = explainDeal({
      tradeEquity,
      scenarios: scoredScenarios,
      recommended,
      objective,
      paymentGap,
    });

    const response = {
      vehicle: { source: vehicleInfo.description, referencePrice: vehicleInfo.referencePrice },
      netVehiclePrice,
      appliedIncentives: applied.map((a) => ({ id: a.id, name: a.name, amount: a.amount, type: a.type })),
      fees: feeResult,
      tax: {
        estimatedTax,
        taxRate: taxResolution.taxRate,
        jurisdiction: { state: taxResolution.jurisdiction.state, city: taxResolution.jurisdiction.city },
        isStale: !!taxResolution.isStale,
        isManualOverride: !!taxResolution.isManualOverride,
        disclaimer:
          'Tax estimate is based on the selected registration location and available tax rules. Final tax treatment may vary based on transaction details, jurisdiction, dealer/lender procedures, and applicable law.',
      },
      trade: { tradeEquity },
      financing: {
        estimatedApr,
        aprDisclaimer: 'Actual APR is determined by lender approval.',
        termMonths: input.termMonths,
      },
      paymentGap,
      scenarios: scoredScenarios,
      recommendedScenarioLabel: recommended.scenarioLabel,
      explanation: customerExplanation,
      warnings,
    };

    if (mode === 'dealer') {
      response.dealerOnly = {
        dealerDiscount: input.dealerDiscount || 0,
        dealerExplanation: explainForDealer({ paymentGap, scenarios: scoredScenarios }),
      };
    }

    if (input.save) {
      const dealId = await persistDeal(supabase, input, response, taxResolution, aprRule);
      response.dealId = dealId;
    }

    return ok(response);
  } catch (err) {
    return serverError(err);
  }
};

/** Persists a calculated deal + its scenarios (§46 "Saved Deals"). */
async function persistDeal(supabase, input, response, taxResolution, aprRule) {
  const { data: deal, error: dealErr } = await supabase
    .from('deals')
    .insert({
      dealership_id: input.dealershipId || null,
      created_by_user_id: input.createdByUserId,
      customer_user_id: input.customerUserId || null,
      vehicle_trim_id: input.vehicleSource.type === 'trim' ? input.vehicleSource.trimId : null,
      used_vehicle_listing_id: input.vehicleSource.type === 'used' ? input.vehicleSource.usedListingId : null,
      manual_vehicle_entry_id: input.vehicleSource.type === 'manual' ? input.vehicleSource.manualEntryId : null,
      dealership_zip: input.dealershipZip,
      customer_registration_zip: input.customerRegistrationZip,
      tax_jurisdiction_id: taxResolution.jurisdiction.id,
      selling_price: input.sellingPrice,
      dealer_discount: input.dealerDiscount || 0,
      accessories_total: input.accessoriesTotal || 0,
      applied_incentive_ids: input.appliedIncentiveIds || [],
      net_vehicle_price: response.netVehiclePrice,
      has_trade: !!(input.trade && input.trade.hasTrade),
      down_payment: input.downPayment || 0,
      cash_available: input.cashAvailable || null,
      credit_tier_id: input.creditTierId,
      apr_rule_id: aprRule.id,
      estimated_apr: response.financing.estimatedApr,
      term_months: input.termMonths,
      target_payment: input.targetPayment || null,
      status: 'calculated',
    })
    .select('id')
    .single();
  if (dealErr) throw dealErr;

  if (input.trade && input.trade.hasTrade) {
    await supabase.from('trades').insert({
      deal_id: deal.id,
      year: input.trade.year,
      make: input.trade.make,
      model: input.trade.model,
      trim: input.trade.trim,
      mileage: input.trade.mileage,
      trade_value: input.trade.tradeValue,
      payoff: input.trade.payoff,
      equity: response.trade.tradeEquity,
    });
  }

  if (input.objective) {
    await supabase.from('customer_preferences').insert({
      deal_id: deal.id,
      objective: input.objective,
      max_cash_available: input.cashAvailable || null,
    });
  }

  const scenarioRows = response.scenarios.map((s) => ({
    deal_id: deal.id,
    scenario_label: s.scenarioLabel,
    vehicle_price: s.vehiclePrice,
    trade_equity: s.tradeEquity,
    down_payment: s.downPayment,
    amount_financed: s.amountFinanced,
    apr: s.apr,
    term_months: s.termMonths,
    monthly_payment: s.monthlyPayment,
    cash_required: s.cashRequired,
    total_interest: s.totalInterest,
    total_payments: s.totalPayments,
    total_cost: s.totalCost,
    score: s.score,
    is_recommended: !!s.isRecommended,
  }));
  await supabase.from('deal_scenarios').insert(scenarioRows);

  return deal.id;
}
