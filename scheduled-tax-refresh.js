'use strict';

const { getSupabaseClient } = require('./lib/supabaseClient');
const { resolveTaxRate } = require('./lib/taxResolver');

/**
 * Scheduled function (see netlify.toml [[functions.schedule]]) — runs
 * monthly and refreshes cached tax rates for every ZIP that's actually
 * been used in a deal recently. This is the other half of the reliability
 * fix: by the time a live customer types a ZIP in, the odds are good the
 * rate is already sitting in tax_rules from this job, so the live request
 * hits Supabase (fast, always available) instead of a third-party API
 * (rate-limited, no SLA).
 *
 * Batches requests with a small delay between each to stay well under the
 * free provider's rate limit even if hundreds of ZIPs need refreshing.
 */
exports.handler = async () => {
  const supabase = getSupabaseClient();

  const since = new Date();
  since.setDate(since.getDate() - 90);

  const { data: recentDeals, error } = await supabase
    .from('deals')
    .select('customer_registration_zip')
    .gte('created_at', since.toISOString());

  if (error) {
    console.error('Scheduled tax refresh: failed to load recent ZIPs', error);
    return { statusCode: 500, body: 'failed to load recent zips' };
  }

  const uniqueZips = [...new Set((recentDeals || []).map((d) => d.customer_registration_zip).filter(Boolean))];

  let refreshed = 0;
  let failed = 0;

  for (const zip of uniqueZips) {
    try {
      await resolveTaxRate(supabase, zip, new Date().toISOString().slice(0, 10), /* forceRefresh */ true);
      refreshed++;
    } catch (err) {
      failed++;
      console.warn(`Scheduled tax refresh failed for ZIP ${zip}: ${err.message}`);
    }
    // Gentle pacing to stay under provider rate limits.
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(`Scheduled tax refresh complete: ${refreshed} refreshed, ${failed} failed, ${uniqueZips.length} total ZIPs.`);
  return { statusCode: 200, body: `refreshed ${refreshed}/${uniqueZips.length}` };
};
