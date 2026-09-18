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
3b. Then paste in `db/002_seed_reference_data.sql` and run it. This adds
   the rows that MUST exist before any deal can be calculated: credit
   tiers (so the dropdown isn't empty), a default lender + APR rules for
   every tier/condition/term combination, one sample vehicle (Toyota Camry
   2026, LE/SE) so there's something to test with end-to-end, and a sample
   doc fee. Replace the sample vehicle with real inventory whenever
   convenient — it's just there so a first test deal actually works.
4. Go to **Project Settings → API** and copy:
   - `Project URL` → this is `SUPABASE_URL`
   - `service_role` key (NOT the `anon` key) → this is `SUPABASE_SERVICE_ROLE_KEY`
   Keep the service role key secret — it bypasses all database security
   rules, which is why it only ever lives in Netlify's environment
   variables, never in any file you upload to GitHub.

### Step 2 — Code (Netlify)

You have two options here depending on whether you're comfortable with a
terminal. Both end up in the same place.

#### Option A — No terminal at all (click-only, via GitHub's website)

1. **Unzip** `auto-deal-iq.zip` on your computer — double-click it like any
   zip file. You should end up with a folder called `auto-deal-iq`
   containing `db/`, `netlify/`, `public/`, `src/`, `test/`, `netlify.toml`,
   `package.json`, and `README-integration.md`.
2. Go to **github.com** and sign in (or create a free account if you don't
   have one).
3. Click the **+** icon top-right → **New repository**. Name it something
   like `auto-deal-iq`, keep it **Private**, and click **Create repository**.
4. On the new repo's page, click the link that says **"uploading an
   existing file"** (it's in the small text block on the empty-repo page).
5. Open the unzipped `auto-deal-iq` folder in your file explorer, **select
   everything inside it** (all the files and subfolders — `db`, `netlify`,
   `public`, `src`, `test`, `netlify.toml`, `package.json`, etc.), and
   **drag them all into the browser** onto GitHub's upload area at once.
   Important: drag the *contents* of the folder, not the `.zip` file
   itself and not the outer `auto-deal-iq` folder — GitHub needs to see
   `netlify.toml` sitting at the top level of the repo, not nested one
   folder deeper. (This is almost certainly why the earlier upload
   "failed" — a `.zip` file dragged onto GitHub just uploads as one opaque
   zip file sitting in the repo, not as a proper project structure.)
6. Scroll down, leave the default commit message, click **Commit
   changes**. Wait for the page to finish uploading — for a project this
   size it should take well under a minute.
7. Now go to **app.netlify.com** → **Add new site → Import an existing
   project → Deploy with GitHub** → authorize Netlify to see your GitHub
   account if asked → select the `auto-deal-iq` repository.
8. Netlify auto-detects everything from `netlify.toml` (publish folder
   `public`, functions folder `netlify/functions`) — you don't need to
   type any build settings. Click **Deploy**.
9. Before (or right after) that first deploy finishes, go to **Site
   settings → Environment variables** in Netlify and add:
   - `SUPABASE_URL` → your Project URL from Supabase
   - `SUPABASE_SERVICE_ROLE_KEY` → your service_role key from Supabase

   Then trigger a redeploy (**Deploys tab → Trigger deploy → Deploy site**)
   so the functions pick up those values.
10. Netlify gives you a live URL like `random-name-123.netlify.app` —
    open it and run through a full test deal before touching the real
    domain.

From here on, updating the site is also click-only: whenever there's a new
version of the code, go back to the repo's page on github.com, click **Add
file → Upload files**, drag in the changed files, commit — Netlify
redeploys automatically within a minute or two.

#### Option B — Netlify CLI (a bit faster once set up, needs a terminal)

1. Install Node.js from nodejs.org if you don't have it.
2. Unzip the project, open a terminal in that folder, then:
   ```
   npm install -g netlify-cli
   npm install
   netlify login
   netlify init
   netlify env:set SUPABASE_URL "https://YOUR-PROJECT.supabase.co"
   netlify env:set SUPABASE_SERVICE_ROLE_KEY "your-service-role-key"
   netlify deploy --prod
   ```
   When `netlify init` asks about connecting a Git repository, choose
   **"No"** — this keeps it CLI-managed with no GitHub involved at all.
   To update later, just re-run `netlify deploy --prod` from the same
   folder.

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
2. **Set the dealership ZIP.** The app only asks the customer for their
   own (registration) ZIP — the dealership's ZIP is a single constant in
   `public/app.js` (`DEALERSHIP_ZIP`, near the top of the file), since this
   calculator is wired to one dealership at a time. It's currently a
   placeholder (`'00000'`) — update it to the real ZIP before going live.
   It's used for record-keeping on saved deals only; it never affects the
   tax calculation, which always uses the customer's ZIP.
3. **Real vehicle inventory.** `db/002_seed_reference_data.sql` seeds one
   sample vehicle (a 2026 Camry) so there's something to test with —
   replace/expand this with the dealership's real inventory via Supabase's
   Table Editor whenever convenient. There's no admin UI for this yet
   (§36 in the original spec).

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
