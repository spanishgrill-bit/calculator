# AUTO DEAL IQ — Deployment & Integration Guide

This covers three things: **can you test it before uploading** (yes), **how to upload it**, and **how to attach it to mariotoyota.com** as a `calculator` subdomain, matching how that site is already set up on Netlify + Supabase.

---

## 1. Can you test it before uploading? Yes — two ways.

### Option A: Test the calculation engine right now, no deployment needed
The financial math (trade equity, tax, payments, scenarios) doesn't touch a
database at all. You already saw this pass 18/18 tests. Anyone with Node.js
installed can run it locally with zero setup:
```
cd auto-deal-iq
node test/calculationEngine.test.js
node test/dbResolvers.test.js
```
This proves the numbers are right before a single file touches the internet.

### Option B: Run the whole app locally (frontend + API + real Supabase data)
This is the real pre-launch test — the same code that will run on Netlify,
just running on your own machine first:
1. Install the Netlify CLI once: `npm install -g netlify-cli`
2. In the project folder: `npm install`
3. Create a `.env` file (never commit this) with:
   ```
   SUPABASE_URL=https://YOUR-PROJECT.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   ```
4. Run: `netlify dev`
5. Open the local URL it prints (usually `http://localhost:8888`) — this runs
   the real frontend AND the real serverless functions together, hitting
   your actual Supabase database. Nothing is public yet; it's all on your
   computer.

Do this against a **scratch/test Supabase project** first (a free project
you can throw away), not your production database, until you're comfortable
with it.

---

## 2. Uploading it (getting it into Supabase + Netlify)

### Step 1 — Database (Supabase)
1. Create a new Supabase project (or use an existing one shared with the
   main site, if you want one shared customer/vehicle database — see §4).
2. Open **SQL Editor** in the Supabase dashboard.
3. Paste in the entire contents of `db/001_init_schema.sql` and run it.
   This creates all 24 tables, enum types, and seeds a starter list of
   vehicle categories.
4. Go to **Project Settings → API** and copy:
   - `Project URL` → this is `SUPABASE_URL`
   - `service_role` key (NOT the `anon` key) → this is `SUPABASE_SERVICE_ROLE_KEY`
   Keep the service role key secret — it bypasses all database security
   rules, which is why it only ever lives in Netlify's environment
   variables, never in any file you upload to GitHub.

### Step 2 — Code (Netlify)
The cleanest path is a Git repository, because it gives you automatic
redeploys every time you make a change:
1. Create a new (private) GitHub repository and push this `auto-deal-iq`
   folder into it.
2. In Netlify: **Add new site → Import an existing project → GitHub** →
   select the repo.
3. Netlify will detect `netlify.toml` automatically (build command: none
   needed, publish directory: `public`, functions directory:
   `netlify/functions`).
4. Before the first deploy, go to **Site settings → Environment variables**
   and add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (the same two
   values from Step 1). If/when you register with a backup tax provider
   that needs an API key, add it here too (e.g. `ZIP_TAX_BACKUP_KEY`) —
   never in a file that gets committed to the repo.
5. Deploy. Netlify gives you a temporary URL like
   `random-name-123.netlify.app` — open it and run through a full test deal
   before touching the real domain.

If you'd rather not deal with GitHub yet, Netlify also supports dragging a
built folder directly onto their dashboard for a one-off deploy — but you'd
lose the "push to redeploy" convenience, and functions need the CLI to
package correctly for a drag-and-drop deploy, so the Git route above is the
one worth setting up even for a first test.

---

## 3. Attaching it to mariotoyota.com as `calculator.mariotoyota.com`

Since mariotoyota.com is already on Netlify, this new calculator is its own
**separate Netlify site** (its own repo, its own functions, its own
deploys) that you point a subdomain at — you don't add it into the existing
site's codebase. That keeps the two projects from stepping on each other's
deploys.

1. In the new Netlify site (the one you just created above): **Domain
   management → Add a domain** → enter `calculator.mariotoyota.com`.
2. Netlify will show you a DNS target (something like
   `random-name-123.netlify.app` or an Netlify DNS record to add).
3. Wherever mariotoyota.com's DNS is managed (Netlify DNS if the whole
   domain is on Netlify, or another registrar/DNS host), add a **CNAME
   record**: `calculator` → the target Netlify gave you.
4. Netlify auto-provisions HTTPS (Let's Encrypt) for the subdomain once DNS
   resolves — usually within a few minutes to an hour.
5. Done — `calculator.mariotoyota.com` now serves this app, fully
   independent of the main site's deploys.

**If you'd rather have it feel like a tab on the existing site** (e.g.
`mariotoyota.com/calculator` instead of a subdomain), that's also possible
using Netlify's `_redirects`/proxy rules on the *main* site to reverse-proxy
that path to this app's URL — happy to set that up too if you'd prefer a
path over a subdomain; just let me know which you want, since it changes a
config file on the *main* site rather than this one.

---

## 4. One shared Supabase project, or two?

You can point this app at the **same Supabase project** as the rest of
mariotoyota.com (this schema is entirely new tables — `deals`,
`vehicle_pricing`, `tax_rules`, etc. — so it won't collide with whatever
tables the main site already uses), or a **separate project** dedicated to
the calculator. Shared is simpler to administer (one dashboard, one bill);
separate is cleaner if you want the calculator's data fully isolated. Either
works with zero code changes — it's purely which `SUPABASE_URL` /
`SUPABASE_SERVICE_ROLE_KEY` you put in Netlify's environment variables.

---

## 5. Before you let real customers use it — three things still missing

This is a functioning MVP, but be aware of these gaps before going fully
live with real customer data:

1. **No authentication yet.** The Dealer Mode toggle in the UI is a
   convenience switch, not a security boundary — anyone can click it. Real
   dealer-only access needs Supabase Auth (or similar) wired into the
   frontend and functions before Dealer Mode should be trusted with
   anything sensitive.
2. **The vehicle/tax/APR/fee tables are empty except a starter category
   list** — nothing will calculate until you (or I) populate at least one
   manufacturer/model/trim/price, a lender + credit tiers + APR rules, via
   Supabase's Table Editor (there's no admin UI yet).

~~3. Free tax API reliability~~ — **fixed.** See "Tax rate reliability" below
for what changed and what's still worth deciding before a commercial launch.

---

## 6. Tax rate reliability — what changed and what's still your call

Two separate problems got fixed in the tax resolver
(`netlify/functions/lib/taxResolver.js`):

**Reliability (fixed in code):**
- **Cache-first.** A deal calculation only calls an external provider if the
  cached rate for that ZIP is missing or older than 30 days. Most requests
  never touch the internet at all — they read `tax_rules` in Supabase,
  which is exactly as reliable as the rest of your database.
- **Timeout + retry + fallback provider.** Each provider gets a 4-second
  timeout and one retry before the resolver moves to the next provider in
  the list. Nothing hangs a deal calculation waiting on a dead API.
- **Graceful degrade.** If every provider is down but there's *any* cached
  rate on file (even a stale one), the app uses it and flags the response
  as `isStale: true` rather than failing the whole deal. A slightly old
  sales tax rate is a much smaller problem than a broken calculator.
- **Clean failure path.** Only if there's truly no cached rate *and* every
  provider fails does the app give up automatically — and even then, it
  returns a specific `TAX_UNAVAILABLE` response instead of a generic error.
  The frontend catches this and shows a manual tax-rate entry field so a
  dealer can type in the rate and finish the deal instead of hitting a dead
  end. (A `taxRateOverride` field on the API also lets you skip lookup
  entirely for a ZIP you already know, any time.)
- **Proactive pre-warming.** A scheduled function
  (`netlify/functions/scheduled-tax-refresh.js`, runs monthly, configured in
  `netlify.toml`) refreshes the cached rate for every ZIP that's shown up in
  a real deal in the last 90 days — so by the time a live customer types
  their ZIP in, the rate is usually already cached from this job.
- **Visibility without extra tooling.** If every provider fails, it's logged
  to the `audit_logs` table (`action = 'tax_provider_failure'`) — check that
  table in the Supabase dashboard occasionally to see whether this is
  actually happening in practice.

**Licensing (needs a decision from you, not fixable in code):** while
researching a second/backup provider, it turned up that several "free" ZIP
tax APIs (API Ninjas' Sales Tax API is one confirmed example) **explicitly
prohibit commercial use on their free tier** — meaning a dealership charging
real customers technically isn't allowed to run production traffic through
them regardless of uptime. The provider currently wired in is a placeholder
for the pattern, not a vetted, licensed choice. Before a real commercial
launch:
1. Pick and register with a provider whose terms explicitly permit
   commercial use — TaxJar, Zip2Tax, zip.tax, or Avalara are the common
   choices, typically $10–50/month at low volume.
2. Update the `PROVIDERS` array at the top of `taxResolver.js` with that
   provider's real endpoint/auth (everything else in the app is unaffected
   — this is the only file that knows the provider's request shape).
3. If the provider needs an API key, add it as a Netlify environment
   variable (e.g. `ZIP_TAX_BACKUP_KEY`, already referenced as a placeholder
   for the backup slot) rather than hard-coding it.

Nothing about this blocks testing or a soft launch on your own card — it
only matters once real dealership customers are relying on this in
production.
