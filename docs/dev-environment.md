# Dev environment (Supabase)

**PROD** = existing project `sczdnalqmymhdornhkbn` (real game data).  
**DEV** = a new empty project you create below (local work + GitHub Actions).

Day-to-day: point local `shots-config.js` at **DEV**. Promote schema with migrations; promote the site with a PR `dev` → `main` (see [git-workflow.md](git-workflow.md)).

---

## 1. Create the DEV project

1. Open [Supabase Dashboard](https://supabase.com/dashboard) → same org as prod.
2. **New project** → name e.g. `bhs-shot-tracker-dev` → choose a strong DB password → save the password (you need it for CI).
3. Wait until the project is healthy.
4. **Project Settings → API**
   - Copy **Project URL** (`https://<ref>.supabase.co`)
   - Copy **anon public** key
   - Copy **Project ref** (Settings → General → Reference ID)
5. **Authentication → Providers → Anonymous → Enable** (same as prod).

Do **not** put the **service_role** key in the app, docs, or git.

---

## 2. Point the local app at DEV

```bash
cp shots-config.example.js shots-config.js
```

Edit `shots-config.js`:

```js
window.SHOTS_CONFIG = {
  pitch: { width: 68, length: 105 },
  storageKey: "brighton-varsity-shot-tracker",
  supabaseUrl: "https://YOUR_DEV_REF.supabase.co",
  supabaseAnonKey: "YOUR_DEV_ANON_KEY",
  pin: "KEPPA"
};
```

`shots-config.js` is gitignored. Serve locally:

```bash
python3 -m http.server 8080
# http://localhost:8080/#shots
```

---

## 3. Apply schema to DEV (CLI)

From the repo root (Supabase CLI already used on this machine):

```bash
supabase link --project-ref YOUR_DEV_REF
# enter the DEV database password when prompted

supabase db push
```

That applies everything under `supabase/migrations/` (baseline schema + semantic layer + explore RPC).

Optional DEV seed (rich fake season — **DEV only**):

1. Confirm the dashboard project is `bhs-shot-tracker-dev` (ref `fmiymqnfezkqagpbrmoi`).
2. **SQL Editor** → paste [`supabase/seed_dev_sandbox.sql`](../supabase/seed_dev_sandbox.sql) → Run.
3. Local app → Games → season **DEV Sandbox**. **Medville Marauders** has a full cartoon XI plus a few subs; opponent **Bogwater Badgers** has a cartoon roster (names + positions). Re-run the seed anytime to refresh those rosters without duplicating games.
4. Optional full-game replay (Brighton @ Olympus CSV, translated onto Medville @ Bogwater, including extra time):

```bash
python3 scripts/generate_dev_recorded_game_sql.py
supabase db query --linked -f supabase/seed_dev_recorded_game.sql
```

Safe to re-run: replaces shots on the **2099-04-05 playoffs** game only.

Lighter alternative: `supabase/sample_data.sql`. Never run either on **prod**.

### Local CLI habit

- Link to **DEV** when developing: `supabase link --project-ref <DEV_REF>`
- New schema change: `supabase migration new short_description` → edit the new file → `supabase db push` → commit the migration
- Prod gets the same files automatically when you merge to `main` (see CI below)

Legacy one-off scripts (`supabase/migrate_*.sql`, `schema.sql`) are historical; new work goes in `supabase/migrations/` only.

---

## 4. Optional: Explore / Opponent Prep on DEV

Only if you want the Prep AI tabs against DEV:

```bash
supabase secrets set OPENAI_API_KEY=sk-...
supabase secrets set GEMINI_API_KEY=...
supabase functions deploy explore-shots
supabase functions deploy prep-opponent
```

Core CI does **not** require those functions. Notes tables come from `supabase db push` (migration `prep_notes`).

---

## 5. GitHub secrets checklist

Repo → **Settings → Secrets and variables → Actions → New repository secret**.

| Secret | Where it comes from |
| --- | --- |
| `SUPABASE_ACCESS_TOKEN` | [Account → Access Tokens](https://supabase.com/dashboard/account/tokens) |
| `SUPABASE_PROJECT_REF_DEV` | DEV project ref |
| `SUPABASE_DB_PASSWORD_DEV` | DEV database password from project creation |
| `SUPABASE_PROJECT_REF_PROD` | `sczdnalqmymhdornhkbn` |
| `SUPABASE_DB_PASSWORD_PROD` | PROD database password |
| `SHOTS_SUPABASE_URL_DEV` | DEV Project URL |
| `SHOTS_SUPABASE_ANON_KEY_DEV` | DEV anon key |
| `SHOTS_SUPABASE_URL_PROD` | PROD Project URL (for GitHub Pages build) |
| `SHOTS_SUPABASE_ANON_KEY_PROD` | PROD anon key |
| `SHOTS_PIN` | Staff PIN (e.g. `KEPPA`) |

After secrets exist:

- Push to `dev` → migrations apply to **DEV**; CI runs API + Playwright against **DEV**
- Merge to `main` → migrations apply to **PROD**; Pages deploys with **PROD** config

---

## 6. GitHub Pages and `shots-config.js` (do this before merging to main)

`shots-config.js` is **no longer committed**. The live site gets it from the **Deploy GitHub Pages** workflow (`.github/workflows/pages.yml`).

**Before** the commit that removes `shots-config.js` hits `main`:

1. Add `SHOTS_SUPABASE_URL_PROD`, `SHOTS_SUPABASE_ANON_KEY_PROD`, and `SHOTS_PIN` secrets
2. Repo → **Settings → Pages → Build and deployment → Source → GitHub Actions**
3. Then merge/push to `main` so Pages rebuilds with a generated config

If you merge first and leave Pages on “Deploy from a branch”, the public site will 404 `shots-config.js` until you switch.

### First `db push` to PROD

PROD already has the schema from older hand-run SQL. The baseline migrations are **idempotent** (`if not exists` / `create or replace`), so the first Actions `db push` should apply cleanly and record migration history. If a step fails on an old constraint edge case, open the Actions log, fix or `supabase migration repair` with the CLI linked to PROD, and re-run the workflow (`workflow_dispatch`).

---

## 7. Sanity check

| Check | Expected |
| --- | --- |
| Local `#shots` with DEV config + PIN | Opens tracker; games list loads |
| `supabase db push` on DEV | “Remote database is up to date” or applies pending files |
| GitHub Actions on `dev` | `ci` + `supabase-migrate` (DEV) green |
| PR merge to `main` | Pages live; migrate job targets PROD |
