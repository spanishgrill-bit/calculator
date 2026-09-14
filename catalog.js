'use strict';

const { getSupabaseClient } = require('./lib/supabaseClient');
const { pickEffectiveRow } = require('./lib/effectiveDate');
const { ok, badRequest, serverError, preflight } = require('./lib/http');

/**
 * GET /api/catalog?resource=manufacturers
 * GET /api/catalog?resource=models&manufacturerId=...
 * GET /api/catalog?resource=modelYears&modelId=...
 * GET /api/catalog?resource=trims&modelYearId=...
 * GET /api/catalog?resource=pricing&trimId=...&asOf=YYYY-MM-DD
 * GET /api/catalog?resource=categories
 * GET /api/catalog?resource=creditTiers
 *
 * This is the single endpoint that drives the cascading
 * Make -> Model -> Year -> Trim dropdown UI, and the MSRP pre-fill.
 */
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  try {
    const supabase = getSupabaseClient();
    const params = event.queryStringParameters || {};
    const asOf = params.asOf || new Date().toISOString().slice(0, 10);

    switch (params.resource) {
      case 'manufacturers': {
        const { data, error } = await supabase.from('manufacturers').select('id,name,slug').order('name');
        if (error) throw error;
        return ok({ data });
      }

      case 'models': {
        if (!params.manufacturerId) return badRequest('manufacturerId is required');
        const { data, error } = await supabase
          .from('vehicle_models')
          .select('id,name')
          .eq('manufacturer_id', params.manufacturerId)
          .order('name');
        if (error) throw error;
        return ok({ data });
      }

      case 'modelYears': {
        if (!params.modelId) return badRequest('modelId is required');
        const { data, error } = await supabase
          .from('vehicle_model_years')
          .select('id,year')
          .eq('vehicle_model_id', params.modelId)
          .order('year', { ascending: false });
        if (error) throw error;
        return ok({ data });
      }

      case 'trims': {
        if (!params.modelYearId) return badRequest('modelYearId is required');
        const { data, error } = await supabase
          .from('vehicle_trims')
          .select('id,name,body_style,drivetrain,fuel_type,category_id')
          .eq('vehicle_model_year_id', params.modelYearId)
          .order('name');
        if (error) throw error;
        return ok({ data });
      }

      case 'pricing': {
        if (!params.trimId) return badRequest('trimId is required');
        const { data: rows, error } = await supabase
          .from('vehicle_pricing')
          .select('*')
          .eq('vehicle_trim_id', params.trimId)
          .eq('is_active', true);
        if (error) throw error;
        const pricing = pickEffectiveRow(rows, asOf);
        // pricing may legitimately be null — the frontend falls back to an
        // open selling-price box in that case (§41 dropdown flow).
        return ok({ pricing });
      }

      case 'categories': {
        const { data, error } = await supabase
          .from('vehicle_categories')
          .select('id,name')
          .eq('is_active', true)
          .order('sort_order');
        if (error) throw error;
        return ok({ data });
      }

      case 'creditTiers': {
        const { data, error } = await supabase
          .from('credit_tiers')
          .select('id,label,score_min,score_max')
          .eq('is_active', true)
          .order('sort_order');
        if (error) throw error;
        return ok({ data });
      }

      default:
        return badRequest(`Unknown resource: ${params.resource}`);
    }
  } catch (err) {
    return serverError(err);
  }
};
