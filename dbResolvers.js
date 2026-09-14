'use strict';

const { pickEffectiveRow } = require('./effectiveDate');

/**
 * resolveVehicleSource
 * §41/§9 — turns whichever of {trimId, usedListingId, manualEntry} the
 * frontend sent into a consistent { referencePrice, description } shape.
 * `referencePrice` is informational (MSRP or purchase price on file); the
 * actual selling price used in calculations always comes from the deal
 * input itself, since that's what's actually being negotiated.
 */
async function resolveVehicleSource(supabase, vehicleSource, asOfDate) {
  if (vehicleSource.type === 'trim') {
    const { data: rows, error } = await supabase
      .from('vehicle_pricing')
      .select('*')
      .eq('vehicle_trim_id', vehicleSource.trimId)
      .eq('is_active', true);
    if (error) throw error;
    const pricing = pickEffectiveRow(rows, asOfDate);
    return {
      description: 'catalog trim',
      referencePrice: pricing ? pricing.msrp : null,
      pricingRow: pricing,
    };
  }

  if (vehicleSource.type === 'used') {
    const { data: listing, error } = await supabase
      .from('used_vehicle_listings')
      .select('*')
      .eq('id', vehicleSource.usedListingId)
      .single();
    if (error) throw error;
    return { description: 'used/CPO listing', referencePrice: listing.purchase_price, listing };
  }

  if (vehicleSource.type === 'manual') {
    return {
      description: 'manually entered vehicle (not in catalog)',
      referencePrice: vehicleSource.manualEntry.enteredPrice,
    };
  }

  throw new Error(`Unknown vehicleSource.type: ${vehicleSource.type}`);
}

/**
 * resolveIncentives
 * §12 — sums exactly the incentive rows the caller identifies by ID, so
 * double-counting is prevented by construction: the frontend shows the
 * customer which incentives are being applied and sends those specific IDs.
 */
async function resolveIncentives(supabase, incentiveIds = []) {
  if (incentiveIds.length === 0) {
    return { manufacturerIncentives: 0, customerRebates: 0, applied: [] };
  }
  const { data: rows, error } = await supabase
    .from('incentives')
    .select('*')
    .in('id', incentiveIds)
    .eq('is_active', true);
  if (error) throw error;

  const manufacturerIncentives = rows
    .filter((r) => r.type === 'manufacturer_incentive' || r.type === 'dealer_cash')
    .reduce((sum, r) => sum + Number(r.amount), 0);
  const customerRebates = rows
    .filter((r) => r.type === 'customer_rebate')
    .reduce((sum, r) => sum + Number(r.amount), 0);

  return { manufacturerIncentives, customerRebates, applied: rows };
}

/**
 * resolveFees
 * §16 — dealership-specific fees plus any global (dealership_id IS NULL)
 * government/default fees, both effective as of the given date.
 */
async function resolveFees(supabase, dealershipId, asOfDate) {
  const { data: rows, error } = await supabase
    .from('fee_rules')
    .select('*')
    .eq('is_active', true)
    .or(dealershipId ? `dealership_id.eq.${dealershipId},dealership_id.is.null` : 'dealership_id.is.null');
  if (error) throw error;

  // Group by name so a dealership-specific override replaces a same-named
  // global default rather than both being charged.
  const byName = new Map();
  for (const rule of rows) {
    const effective = pickEffectiveRow([rule], asOfDate);
    if (!effective) continue;
    const existing = byName.get(rule.name);
    // Prefer a dealership-specific row over a global one for the same name.
    if (!existing || (rule.dealership_id && !existing.dealership_id)) {
      byName.set(rule.name, rule);
    }
  }
  return Array.from(byName.values());
}

/**
 * resolveApr
 * §18 — configurable APR by lender/tier/condition/term, effective-dated.
 * Falls back to the first active lender if the caller doesn't pin one down
 * (fine for a single-lender dealership; multi-lender dealers should always
 * pass lenderId explicitly).
 */
async function resolveApr(supabase, { lenderId, creditTierId, vehicleCondition, termMonths }, asOfDate) {
  let query = supabase
    .from('apr_rules')
    .select('*')
    .eq('credit_tier_id', creditTierId)
    .eq('vehicle_condition', vehicleCondition)
    .eq('term_months', termMonths)
    .eq('is_active', true);
  if (lenderId) query = query.eq('lender_id', lenderId);

  const { data: rows, error } = await query;
  if (error) throw error;

  const effective = pickEffectiveRow(rows, asOfDate);
  if (!effective) {
    throw new Error(
      `No configured APR rule for creditTierId=${creditTierId}, condition=${vehicleCondition}, term=${termMonths}. ` +
        'An admin needs to add one in the Admin Dashboard before this combination can be quoted.'
    );
  }
  return effective;
}

module.exports = { resolveVehicleSource, resolveIncentives, resolveFees, resolveApr };
