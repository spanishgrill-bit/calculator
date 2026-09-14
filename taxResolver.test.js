'use strict';

const assert = require('node:assert/strict');

// A minimal in-memory fake of just enough Supabase surface for taxResolver
// to exercise its logic without a real network/database.
function makeFakeSupabase(seed = {}) {
  const state = {
    tax_jurisdictions: seed.tax_jurisdictions || [],
    tax_rules: seed.tax_rules || [],
    data_sources: seed.data_sources || [],
    audit_logs: [],
  };
  let idCounter = 1;
  const newId = () => `id-${idCounter++}`;

  function table(name) {
    return {
      select() {
        return this;
      },
      eq(field, value) {
        this._filters = this._filters || [];
        this._filters.push((row) => row[field] === value);
        return this;
      },
      maybeSingle: async function () {
        const rows = applyFilters(state[name], this._filters);
        return { data: rows[0] || null, error: null };
      },
      insert: function (row) {
        const withId = { id: newId(), ...row };
        state[name].push(withId);
        this._inserted = withId;
        return this;
      },
      single: async function () {
        return { data: this._inserted, error: null };
      },
      update(fields) {
        this._updateFields = fields;
        return this;
      },
      then: undefined, // not thenable; callers must await the terminal method
      // support `await supabase.from(x).select().eq().eq()` (returns rows array-ish via a thenable)
    };
  }

  function applyFilters(rows, filters) {
    if (!filters) return rows;
    return rows.filter((r) => filters.every((f) => f(r)));
  }

  // A thin wrapper so `const { data, error } = await supabase.from(x).select().eq()` works
  // by making the builder itself awaitable when used as a terminal (non-.single()) call.
  function fromProxy(name) {
    const builder = table(name);
    let filters = [];
    const proxy = {
      select() {
        return proxy;
      },
      eq(field, value) {
        filters.push((row) => row[field] === value);
        return proxy;
      },
      or() {
        return proxy;
      },
      gte() {
        return proxy;
      },
      maybeSingle: async () => {
        const rows = applyFilters(state[name], filters);
        return { data: rows[0] || null, error: null };
      },
      insert: (row) => {
        const withId = { id: newId(), ...row };
        state[name].push(withId);
        return {
          select: () => ({
            single: async () => ({ data: withId, error: null }),
          }),
        };
      },
      update: (fields) => ({
        eq: (field, value) => {
          state[name] = state[name].map((r) => (r[field] === value ? { ...r, ...fields } : r));
          return Promise.resolve({ data: null, error: null });
        },
      }),
      then: (resolve) => {
        const rows = applyFilters(state[name], filters);
        resolve({ data: rows, error: null });
      },
    };
    return proxy;
  }

  return {
    from: (name) => fromProxy(name),
    _state: state,
  };
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL - ${name}`);
    console.error(`       ${err.stack}`);
  }
}

(async () => {
  console.log('\nTax resolver resilience tests:\n');

  await test('uses a fresh cached rate without calling any provider', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => {
      throw new Error('fetch should NOT have been called — a fresh cached rate was available');
    };
    try {
      const { resolveTaxRate } = require('../netlify/functions/lib/taxResolver');
      const jurisdictionId = 'jur-1';
      const supabase = makeFakeSupabase({
        tax_jurisdictions: [{ id: jurisdictionId, zip_code: '07070', state: 'NJ', city: 'Rutherford' }],
        tax_rules: [
          {
            id: 'rule-1',
            tax_jurisdiction_id: jurisdictionId,
            tax_rate: 0.06625,
            taxable_categories: [],
            effective_date: '2026-08-01',
            expiration_date: null,
            is_active: true,
            last_updated: new Date().toISOString(), // fresh
          },
        ],
      });
      const result = await resolveTaxRate(supabase, '07070', '2026-09-12');
      assert.equal(result.taxRate, 0.06625);
      assert.equal(result.isStale, false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('falls back to the second provider when the first fails', async () => {
    const originalFetch = global.fetch;
    let callCount = 0;
    global.fetch = async (url) => {
      callCount++;
      if (url.includes('salestaxzip.com')) {
        throw new Error('simulated primary provider outage');
      }
      return {
        ok: true,
        json: async () => ({ results: [{ taxSales: 0.07, stateAbbreviation: 'NY', city: 'New York' }] }),
      };
    };
    try {
      const { resolveTaxRate } = require('../netlify/functions/lib/taxResolver');
      const supabase = makeFakeSupabase(); // no cache at all -> must hit providers
      const result = await resolveTaxRate(supabase, '10001', '2026-09-12');
      assert.equal(result.taxRate, 0.07);
      assert.ok(callCount >= 2, 'should have tried both providers (with retry) before succeeding');
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('degrades to a stale cached rate when all providers fail', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => {
      throw new Error('simulated total provider outage');
    };
    try {
      const { resolveTaxRate } = require('../netlify/functions/lib/taxResolver');
      const jurisdictionId = 'jur-2';
      const staleDate = new Date();
      staleDate.setDate(staleDate.getDate() - 60); // 60 days old -> stale
      const supabase = makeFakeSupabase({
        tax_jurisdictions: [{ id: jurisdictionId, zip_code: '90210', state: 'CA', city: 'Beverly Hills' }],
        tax_rules: [
          {
            id: 'rule-2',
            tax_jurisdiction_id: jurisdictionId,
            tax_rate: 0.0825,
            taxable_categories: [],
            effective_date: '2026-01-01',
            expiration_date: null,
            is_active: true,
            last_updated: staleDate.toISOString(),
          },
        ],
      });
      const result = await resolveTaxRate(supabase, '90210', '2026-09-12');
      assert.equal(result.taxRate, 0.0825); // used the stale rate rather than failing
      assert.equal(result.isStale, true);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('throws TAX_UNAVAILABLE when there is no cache and every provider fails', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => {
      throw new Error('simulated total provider outage');
    };
    try {
      const { resolveTaxRate } = require('../netlify/functions/lib/taxResolver');
      const supabase = makeFakeSupabase(); // nothing cached
      await assert.rejects(
        () => resolveTaxRate(supabase, '99999', '2026-09-12'),
        (err) => err.code === 'TAX_UNAVAILABLE'
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
