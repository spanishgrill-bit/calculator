'use strict';

const { pickEffectiveRow } = require('./effectiveDate');

// ---------------------------------------------------------------------------
// PROVIDER CHAIN
// ---------------------------------------------------------------------------
//
// IMPORTANT LICENSING NOTE: some "free" ZIP tax APIs (e.g. API Ninjas'
// Sales Tax API) explicitly prohibit commercial use on their free tier.
// The provider below is illustrative — confirm the exact terms, endpoint,
// and (if required) API key of whichever provider you actually register
// with before deploying to production, and swap PROVIDERS accordingly.
// For a real commercial launch, budget for a paid tier (TaxJar, Zip2Tax,
// zip.tax, or Avalara) — this is covered in README-integration.md.
//
// Nothing outside this file needs to know which provider(s) are in use —
// that's the point of the abstraction. Add/remove/reorder entries in
// PROVIDERS and everything else (calculate-deal.js, the frontend, the
// schema) keeps working unchanged.

const PROVIDERS = [
  {
    name: 'Primary ZIP tax provider',
    buildUrl: (zip) => `https://salestaxzip.com/api/v1/rate/${encodeURIComponent(zip)}`,
    parse: (json) => {
      if (!json || !json.success || !json.data || !json.data.rates) {
        throw new Error('Unexpected response shape from primary provider');
      }
      return { combinedRate: json.data.rates.combined, state: json.data.state, city: json.data.city };
    },
  },
  {
    // Backup provider, only called if the primary fails or times out.
    // CONFIRM the exact request shape/auth for your chosen backup before
    // relying on this in production — placeholder shown for the pattern.
    name: 'Backup ZIP tax provider',
    buildUrl: (zip) => `https://api.zip-tax.com/request/v40?key=${process.env.ZIP_TAX_BACKUP_KEY || ''}&postalcode=${encodeURIComponent(zip)}`,
    parse: (json) => {
      const result = json && json.results && json.results[0];
      if (!result) throw new Error('Unexpected response shape from backup provider');
      return { combinedRate: Number(result.taxSales), state: result.stateAbbreviation, city: result.city };
    },
  },
];

const REQUEST_TIMEOUT_MS = 4000;
const RETRIES_PER_PROVIDER = 1;
const STALE_AFTER_DAYS = 30;

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callProvider(provider, zip) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES_PER_PROVIDER; attempt++) {
    try {
      const res = await fetchWithTimeout(provider.buildUrl(zip), REQUEST_TIMEOUT_MS);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      return provider.parse(json);
    } catch (err) {
      lastErr = err;
      if (attempt < RETRIES_PER_PROVIDER) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1))); // small backoff
      }
    }
  }
  throw new Error(`${provider.name} failed after ${RETRIES_PER_PROVIDER + 1} attempt(s): ${lastErr.message}`);
}

/** Tries each provider in order; returns the first success. */
async function fetchRateFromProviders(supabase, zip) {
  const failures = [];
  for (const provider of PROVIDERS) {
    try {
      const result = await callProvider(provider, zip);
      return { ...result, providerName: provider.name };
    } catch (err) {
      failures.push(`${provider.name}: ${err.message}`);
    }
  }
  // Every provider failed — log it so this is visible without needing an
  // external monitoring tool (check audit_logs in the Supabase dashboard).
  await logProviderFailure(supabase, zip, failures.join(' | '));
  throw new Error(`All tax rate providers failed for ZIP ${zip}: ${failures.join(' | ')}`);
}

async function logProviderFailure(supabase, zip, detail) {
  try {
    await supabase.from('audit_logs').insert({
      action: 'tax_provider_failure',
      entity_type: 'tax_jurisdiction',
      entity_id: '00000000-0000-0000-0000-000000000000',
      after: { zip, detail, at: new Date().toISOString() },
    });
  } catch {
    // Don't let audit logging itself break the request — this is best-effort.
  }
}

// ---------------------------------------------------------------------------
// DB CACHE
// ---------------------------------------------------------------------------

async function findOrCreateDataSource(supabase, providerName) {
  const { data: existing, error: findErr } = await supabase
    .from('data_sources')
    .select('id')
    .eq('name', providerName)
    .eq('entity_scope', 'tax')
    .maybeSingle();
  if (findErr) throw findErr;
  if (existing) return existing.id;

  const { data: created, error: createErr } = await supabase
    .from('data_sources')
    .insert({ name: providerName, entity_scope: 'tax', sync_method: 'api', last_synced_at: new Date().toISOString() })
    .select('id')
    .single();
  if (createErr) throw createErr;
  return created.id;
}

async function findOrCreateJurisdiction(supabase, zip, providerState, providerCity) {
  const { data: existing, error: findErr } = await supabase
    .from('tax_jurisdictions')
    .select('*')
    .eq('zip_code', zip)
    .maybeSingle();
  if (findErr) throw findErr;
  if (existing) return existing;

  const { data: created, error: createErr } = await supabase
    .from('tax_jurisdictions')
    .insert({ zip_code: zip, state: providerState, city: providerCity })
    .select('*')
    .single();
  if (createErr) throw createErr;
  return created;
}

/**
 * resolveTaxRate
 * §5/§6/§7/§9 (Test 12) — the single entry point calculate-deal.js and the
 * standalone /api/resolve-tax endpoint both use.
 *
 * Resilience strategy, cheapest-first:
 *   1. Use a cached, still-fresh rate if we have one — no network call at all.
 *   2. If stale/missing, try each configured provider in order (with a
 *      timeout + one retry each) and cache whatever succeeds.
 *   3. If every provider fails but we DO have a cached rate (even a stale
 *      one), use it anyway and flag the response as `isStale: true` rather
 *      than breaking the whole deal calculation over a rate that's probably
 *      still close to correct.
 *   4. Only if there is truly no cached rate AND every provider fails does
 *      this throw — the caller (calculate-deal.js) turns that into a
 *      structured response so the frontend can offer a manual tax-rate
 *      entry instead of a dead end.
 *
 * @param {object} supabase
 * @param {string} zip - customer registration ZIP (never the dealership ZIP)
 * @param {string} asOfDate - ISO date string, defaults to today
 * @param {boolean} forceRefresh - bypass the cache even if fresh (used by the scheduled refresh job)
 */
async function resolveTaxRate(supabase, zip, asOfDate = new Date().toISOString().slice(0, 10), forceRefresh = false) {
  const jurisdiction = await findOrCreateJurisdiction(supabase, zip);

  const { data: existingRules, error: rulesErr } = await supabase
    .from('tax_rules')
    .select('*')
    .eq('tax_jurisdiction_id', jurisdiction.id)
    .eq('is_active', true);
  if (rulesErr) throw rulesErr;

  let effectiveRule = pickEffectiveRow(existingRules, asOfDate);

  const ageDays = effectiveRule
    ? (Date.now() - new Date(effectiveRule.last_updated).getTime()) / (1000 * 60 * 60 * 24)
    : Infinity;
  const isStale = ageDays > STALE_AFTER_DAYS;

  if (forceRefresh || isStale) {
    try {
      const fresh = await fetchRateFromProviders(supabase, zip);
      const sourceId = await findOrCreateDataSource(supabase, fresh.providerName);

      if (!jurisdiction.state && fresh.state) {
        await supabase.from('tax_jurisdictions').update({ state: fresh.state, city: fresh.city }).eq('id', jurisdiction.id);
      }

      const { data: inserted, error: insertErr } = await supabase
        .from('tax_rules')
        .insert({
          tax_jurisdiction_id: jurisdiction.id,
          tax_rate: fresh.combinedRate,
          taxable_categories: ['vehicle_price'],
          exempt_categories: [],
          effective_date: asOfDate,
          source_id: sourceId,
          is_active: true,
        })
        .select('*')
        .single();
      if (insertErr) throw insertErr;
      effectiveRule = inserted;
    } catch (providerErr) {
      if (!effectiveRule) {
        // No cache AND every provider failed — genuinely can't estimate.
        const err = new Error(`No cached tax rate for ZIP ${zip} and all providers failed: ${providerErr.message}`);
        err.code = 'TAX_UNAVAILABLE';
        throw err;
      }
      // Providers failed but we have SOMETHING cached — degrade gracefully.
      console.warn(`Tax provider refresh failed for ZIP ${zip}, using cached rate (${Math.round(ageDays)}d old): ${providerErr.message}`);
    }
  }

  return {
    jurisdiction,
    taxRate: effectiveRule.tax_rate,
    taxableCategories: effectiveRule.taxable_categories || [],
    exemptCategories: effectiveRule.exempt_categories || [],
    effectiveDate: effectiveRule.effective_date,
    lastUpdated: effectiveRule.last_updated,
    isStale: (Date.now() - new Date(effectiveRule.last_updated).getTime()) / (1000 * 60 * 60 * 24) > STALE_AFTER_DAYS,
    isEstimate: true,
  };
}

module.exports = { resolveTaxRate, fetchRateFromProviders, PROVIDERS };

