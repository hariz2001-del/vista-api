# Deploying Vista — Vercel + Supabase

```
Tablet / owner's browser
        │ HTTPS
        ├── pos.vistahub.my ─→ Vercel project "vista-pos"  (static PWA)
        ├── rms.vistahub.my ─→ Vercel project "vista-rms"  (static)
        └── api.vistahub.my ─→ Vercel project "vista-api"  (Fastify, one function, Singapore)
                                   │ transaction pooler :6543
                                   ▼
                              Supabase Postgres (Singapore)
                                   │ nightly GitHub Action
                                   ▼
                              pg_dump → Cloudflare R2 (write-only token)
```

Vista uses Supabase as **a Postgres database and nothing else** — no Supabase Auth, no
Data API, no storage. Sign-in, sessions, the PIN and every money rule stay in api-vista
exactly as they are locally. There is no server to patch, no Nginx, no PM2.

**Plans.** All three Vercel projects go under the **aztechdigital** team. Free plans are
fine while this is in development. Before real trading starts, check two things.
Vercel's Hobby plan is non-commercial only. Supabase's free plan keeps no downloadable
backups and pauses a project after a week without traffic. The nightly R2 backup below
runs on any plan.

---

## 1. Supabase — once

1. **New project** → region **Southeast Asia (Singapore)**. Choose a long database
   password and keep it in your password manager.
2. **Shut the Data API off.** Project Settings → **Data API** → turn it off.
   The first migration also locks the Data API's roles out of every table, so this is
   the second lock, not the only one.
3. **Connect** (top bar) → **ORMs** → **Prisma**. It shows two URLs:
   - **Transaction pooler**, port **6543** → becomes `DATABASE_URL`. Add
     `&connection_limit=5` to the end (it already has `?pgbouncer=true`).
   - **Session pooler**, port **5432** → becomes `DIRECT_URL`.

## 2. Put the schema and the account in — from your own machine, once

In `api-vista/`, in PowerShell. The values live only in this terminal window:

```powershell
$env:DATABASE_URL = '<the SESSION pooler URL, port 5432>'
$env:DIRECT_URL   = $env:DATABASE_URL
npx prisma migrate deploy            # creates every table, then locks the Data API out

$env:SEED_PASSWORD = '<a long real password>'
$env:SEED_PIN      = '<4 digits>'
npx tsx prisma/seed.ts               # menu, brands, partners, the one account

# Only to change them later, or to change the sign-in email:
npx tsx scripts/set-credentials.ts you@example.com '<a long real password>' 1234
```

Then close that terminal. Both commands use the session pooler, not the transaction
pooler, because they need a real session.

## 3. Vercel — the API

1. **Add New → Project** → import **vista-api** from GitHub.
2. **Production branch:** the code for Vercel lives on the `vercel-supabase` branch.
   Either merge it into `master`, or set Settings → Git → **Production Branch** to
   `vercel-supabase`.
3. Framework preset: **Fastify** (detected from `src/server.ts`). Leave build and
   install commands as detected; `npm install` runs `prisma generate` for you.
4. **Environment Variables** — the list and how to fill each is in
   [`.env.production.example`](../.env.production.example): `NODE_ENV`, `DATABASE_URL`,
   `DIRECT_URL`, `JWT_SECRET`, `CORS_ORIGINS`.
5. Deploy. Region is pinned to Singapore (`sin1`) by `vercel.json`, next to the database.
6. Check: `https://<project>.vercel.app/healthz` → `{"ok":true}`.

## 4. Vercel — the two apps

For **vista-pos** and **vista-rms**, each its own project:

- Import the repo; same production-branch choice as above.
- Framework preset **Vite**, build `npm run build`, output `dist` (all detected).
- Environment variable `VITE_API_BASE_URL` = the API's address
  (`https://api.vistahub.my`, or its `*.vercel.app` address until the domain is on).
  **Never** set `VITE_DEMO` in production.

Then set the API's `CORS_ORIGINS` to these two sites' addresses and **redeploy the API**
(Deployments → ⋯ → Redeploy) so it picks the change up.

## 5. Domains

In each Vercel project → Settings → **Domains**, add `api.vistahub.my`,
`pos.vistahub.my`, `rms.vistahub.my`. Vercel shows a `CNAME` record for each; create it
wherever `vistahub.my`'s DNS lives. **If that is Cloudflare, set the record to "DNS
only" (grey cloud), not proxied** — Vercel issues the certificate itself, and a
Cloudflare proxy in between breaks that and hides the real client address from the
guessing limits.

Once the domains are live, update `CORS_ORIGINS` and `VITE_API_BASE_URL` to them and
redeploy all three.

## 6. Backups — once

1. Cloudflare → R2 → create bucket `vista-backups`, and an R2 API token with **Object
   Write** on that bucket only.
2. In the **vista-api** GitHub repo → Settings → Secrets and variables → Actions, add
   the five secrets listed at the top of `.github/workflows/backup.yml`.
3. Actions tab → **Nightly database backup** → **Run workflow** once by hand and check
   the file appears in R2.

**Restore once before trusting it:** download a dump from R2 and load it into a scratch
database — locally, `npm run db:up`, then
`docker exec -i vista-db-supabase createdb -U vista restore_test` and
`gunzip -c dump.sql.gz | docker exec -i vista-db-supabase psql -U vista -d restore_test`.

## Updating

- **Code:** push to the production branch. Vercel builds and switches over; if a
  deploy is bad, Deployments → the previous one → **Instant Rollback**.
- **Schema changes:** run `npx prisma migrate deploy` from your machine against the
  session pooler (step 2) **before** pushing the code that needs it. Migrations are
  additive, so the old code keeps working against the new schema in between. Never
  put `migrate deploy` in the Vercel build — preview builds would migrate production.

## Guarantees worth knowing

- **Guessing limits:** 10 sign-in and 10 PIN attempts per 15 minutes per client, counted
  in Postgres (`attempt_counters`) so every function copy shares one count. Keyed on
  `X-Forwarded-For`, which Vercel sets and a client cannot forge.
- **Browsers:** only `CORS_ORIGINS` sites can call the API from a page.
- **Sessions:** the counter's session never expires and is revoked from the RMS
  (Settings → Counter tablet). Owner sessions last 12 hours.
- **The database is reachable only with its password.** Supabase's Data API cannot read
  or write any Vista table, even with the project's public key.
