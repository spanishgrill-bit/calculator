'use strict';

const { createClient } = require('@supabase/supabase-js');

let cachedClient = null;

/**
 * Server-side Supabase client. Uses the SERVICE ROLE key (never the anon
 * key) because these functions run in a trusted server context and need to
 * bypass Row Level Security to do things like resolve tax rules for any
 * jurisdiction. Never expose SUPABASE_SERVICE_ROLE_KEY to the frontend.
 *
 * Required environment variables (set in Netlify site settings, not in
 * code or in the repo):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */
function getSupabaseClient() {
  if (cachedClient) return cachedClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables. ' +
        'Set these in Netlify: Site settings -> Environment variables.'
    );
  }

  cachedClient = createClient(url, key, { auth: { persistSession: false } });
  return cachedClient;
}

module.exports = { getSupabaseClient };
