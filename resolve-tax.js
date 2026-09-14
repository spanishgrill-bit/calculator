'use strict';

const { getSupabaseClient } = require('./lib/supabaseClient');
const { resolveTaxRate } = require('./lib/taxResolver');
const { ok, badRequest, serverError, preflight, json } = require('./lib/http');

/**
 * GET /api/resolve-tax?zip=07070&asOf=2026-09-12
 * §5/§6 — used by the frontend's "TAX LOCATION" display panel, independent
 * of a full deal calculation (e.g. to show the estimate as soon as the
 * customer types their ZIP, before the rest of the form is filled in).
 */
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  try {
    const params = event.queryStringParameters || {};
    if (!params.zip) return badRequest('zip is required');

    const supabase = getSupabaseClient();
    const result = await resolveTaxRate(supabase, params.zip, params.asOf);

    return ok({
      state: result.jurisdiction.state,
      city: result.jurisdiction.city,
      zip: result.jurisdiction.zip_code,
      estimatedTaxRate: result.taxRate,
      effectiveDate: result.effectiveDate,
      lastUpdated: result.lastUpdated,
      isStale: !!result.isStale,
      disclaimer:
        'Tax estimate is based on the selected registration location and available tax rules. Final tax treatment may vary based on transaction details, jurisdiction, dealer/lender procedures, and applicable law.',
    });
  } catch (err) {
    if (err.code === 'TAX_UNAVAILABLE') {
      return json(422, { code: 'TAX_UNAVAILABLE', error: err.message });
    }
    return serverError(err);
  }
};
