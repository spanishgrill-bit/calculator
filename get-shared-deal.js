'use strict';

const { getSupabaseClient } = require('./lib/supabaseClient');
const { ok, badRequest, serverError, preflight } = require('./lib/http');

/**
 * GET /api/get-shared-deal?token=...
 * §47 — the customer view link. Deliberately re-selects only customer-safe
 * columns rather than reusing the dealer-mode query, so a future column
 * added to `deals` doesn't silently leak into a customer's browser just
 * because someone forgot to update a filter list.
 */
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  try {
    const params = event.queryStringParameters || {};
    if (!params.token) return badRequest('token is required');

    const supabase = getSupabaseClient();

    const { data: saved, error: savedErr } = await supabase
      .from('saved_deals')
      .select('deal_id, share_expiration')
      .eq('share_token', params.token)
      .maybeSingle();
    if (savedErr) throw savedErr;
    if (!saved) return badRequest('This link is invalid.');
    if (saved.share_expiration && new Date(saved.share_expiration) < new Date()) {
      return badRequest('This link has expired.');
    }

    // Customer-safe columns only — no dealer_discount, no gross-related
    // fields, no internal notes.
    const { data: deal, error: dealErr } = await supabase
      .from('deals')
      .select(
        'id, selling_price, net_vehicle_price, down_payment, term_months, estimated_apr, target_payment, status, created_at'
      )
      .eq('id', saved.deal_id)
      .single();
    if (dealErr) throw dealErr;

    const { data: scenarios, error: scenarioErr } = await supabase
      .from('deal_scenarios')
      .select(
        'scenario_label, vehicle_price, trade_equity, down_payment, amount_financed, apr, term_months, monthly_payment, cash_required, total_interest, total_payments, total_cost, is_recommended, explanation_text'
      )
      .eq('deal_id', saved.deal_id);
    if (scenarioErr) throw scenarioErr;

    return ok({ deal, scenarios });
  } catch (err) {
    return serverError(err);
  }
};
