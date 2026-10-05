# PR review environments (STAGING)

Review feature work on a **dedicated stack** that looks like PROD data, without touching live PROD or sharing the cartoon DEV seed.

```text
PROD  (sczdnalqmymhdornhkbn)     live site + real games
  │  encrypted logical dump (existing Backup PROD)
  ▼
STAGING  (you create once)       review backend + optional AI functions
  ▲
  │  shots-config.js (generated, never committed)
  │
staging frontend URL             surge.sh (or Actions artifact)
```

**DEV** stays for local/CI/Cloud Agents. **STAGING** is for human click-through review (iPhone portrait 390×844).

This is **phase A**: one long-lived STAGING project, refreshed from PROD backups. Per-PR ephemeral Supabase projects are **phase B** (see below).

---

## Why not per-PR Supabase projects (yet)?

Supabase Pro allows multiple projects per org, but each project has its own compute bill, pause rules, and secret surface. Spinning a project per PR also means:

- Creating/linking/auth settings/anon keys per PR
- Restoring a full PROD dump each time (minutes + egress)
- Deploying edge functions + LLM secrets each time
- Cleaning up abandoned projects

A single **STAGING** project restored weekly (or on demand before a big review) gives reviewers a real-ish backend with far less operational cost. Phase B can add ephemeral projects later if quotas and cost are acceptable.

---

## Human once: create STAGING

Do this in the [Supabase Dashboard](https://supabase.com/dashboard) (same org as DEV/PROD). **Do not** run one-off SQL against PROD.

1. **New project** → name e.g. `bhs-shot-tracker-staging` → strong DB password → save it.
2. Wait until healthy.
3. **Settings → API**: copy Project URL, **anon** key, Project ref (Settings → General).
4. **Authentication → Providers → Anonymous → Enable** (same as PROD/DEV).
5. **Connect** dialog: copy a **direct** Postgres URI (`db.<ref>.supabase.co:5432`) or session pooler (**5432**, not transaction 6543). Percent-encode the password. Prefer storing the full URI as `SUPABASE_DB_URL_STAGING`.
6. Optional AI tabs: set function secrets on this project (`OPENAI_API_KEY`, `GEMINI_API_KEY`) after the first function deploy.

Never put **service_role** in the app, docs, or git.

### GitHub secrets / vars

Repo → **Settings → Secrets and variables → Actions**.

| Secret | Purpose |
| --- | --- |
| `SUPABASE_PROJECT_REF_STAGING` | Staging project ref |
| `SUPABASE_DB_PASSWORD_STAGING` | Staging DB password (if not using URL) |
| `SUPABASE_DB_URL_STAGING` | Preferred: full `postgresql://…` for restore |
| `SHOTS_SUPABASE_URL_STAGING` | `https://<ref>.supabase.co` |
| `SHOTS_SUPABASE_ANON_KEY_STAGING` | Staging anon key |
| `SURGE_LOGIN` | Optional; email for [surge.sh](https://surge.sh) |
| `SURGE_TOKEN` | Optional; enables public staging URL |

Already required for existing workflows: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD_PROD` / `BACKUP_ENCRYPTION_KEY`, `SHOTS_PIN`.

Optional repo **variable**: `STAGING_SURGE_DOMAIN` (default `bhs-shot-tracker-staging.surge.sh`).

Existing secrets (`SUPABASE_ACCESS_TOKEN`, PROD backup secrets, etc.) are reused. Staging workflows **refuse** targets that look like the PROD project ref.

---

## Workflows

| Workflow | When | What |
| --- | --- | --- |
| [Refresh STAGING](../.github/workflows/staging-refresh.yml) | Manual + weekly cron | Decrypt latest PROD dump (or dump first) → wipe+restore STAGING → deploy edge functions → assemble/publish site |
| [Publish STAGING site](../.github/workflows/staging-pages.yml) | Manual + push to `dev` (frontend paths) | Write staging `shots-config.js` → assemble → surge (if configured) + artifact |

PROD GitHub Pages (`.github/workflows/pages.yml`) is unchanged and still only deploys from `main`.

### Reviewer test URL

1. **Preferred:** set `SURGE_LOGIN` + `SURGE_TOKEN` once. After publish/refresh, open `https://bhs-shot-tracker-staging.surge.sh` (or your `STAGING_SURGE_DOMAIN`).
2. **Without surge:** download the `staging-site-<run_id>` artifact from the workflow, unzip, `python3 -m http.server 8080`, open on a phone-width viewport.

Brand subtitle is set to `Staging` via `SHOTS_BRAND_SUB` so the phone chrome shows you are not on prod (no extra UI chrome).

### Authors

1. Open PRs into **`dev`** as usual ([git-workflow.md](git-workflow.md)).
2. Before asking for a data-heavy review, run **Actions → Refresh STAGING** (or wait for the weekly run).
3. Point reviewers at the staging URL. They use the staff PIN (`SHOTS_PIN`); writes hit **STAGING only**.
4. CI still runs against **DEV**. Staging is for humans, not Playwright.

---

## Scripts (local / CI)

| Script | Role |
| --- | --- |
| [`scripts/backup-db.sh`](../scripts/backup-db.sh) | Existing PROD/DEV logical dump (+ decrypt) |
| [`scripts/restore-db.sh`](../scripts/restore-db.sh) | Restore archive into a target DB (`--env staging`, `--wipe`) |
| [`scripts/deploy-edge-functions.sh`](../scripts/deploy-edge-functions.sh) | Deploy `explore-shots` + `prep-opponent` |
| [`scripts/assemble-site.sh`](../scripts/assemble-site.sh) | Build `_site` / `_staging_site` with generated config |
| [`scripts/publish-staging-site.sh`](../scripts/publish-staging-site.sh) | Verify site; optional surge publish |
| [`scripts/staging-refresh.sh`](../scripts/staging-refresh.sh) | Orchestrate restore + functions + assemble |

```bash
# Dry-run restore plan (no DB writes, no PROD access)
./scripts/restore-db.sh --archive backups/bhs-shot-tracker-prod-….tar.gz --dry-run --wipe

# Full local refresh (needs staging secrets + a dump; does not write PROD)
export SUPABASE_DB_URL_STAGING='postgresql://postgres:…@db.<ref>.supabase.co:5432/postgres'
export SUPABASE_PROJECT_REF_STAGING='…'
export SUPABASE_ACCESS_TOKEN='…'
export BACKUP_ENCRYPTION_KEY='…'   # or SUPABASE_DB_PASSWORD_PROD for decrypt
export SHOTS_SUPABASE_URL_STAGING='https://….supabase.co'
export SHOTS_SUPABASE_ANON_KEY_STAGING='…'
./scripts/staging-refresh.sh --archive backups/….tar.gz.enc

# npm aliases
npm run staging:refresh -- --archive backups/….tar.gz.enc
npm run staging:functions -- --dry-run
npm run staging:site
```

Restore details (roles/schema/data/history) match [backup.md](backup.md). `restore-db.sh` skips `roles.sql` by default (hosted projects often reject it); pass `--roles` to try. It **refuses** a target URL that contains the known PROD ref.

---

## Frontend hosting choice

| Option | Pros | Cons |
| --- | --- | --- |
| **surge.sh** (implemented) | One token, stable URL, fits static site, no collision with PROD Pages | Extra free account |
| **Actions artifact only** (always) | Zero extra services | Not a one-click URL |
| **Cloudflare Pages** | Nice previews | Needs CF token + project; optional later |
| **GitHub Pages `/staging` path** | Same host as prod | One Pages slot; easy to clobber PROD deploy |

GitHub Pages stays **PROD-only** on `main`. Staging uses surge + artifacts so a bad staging publish cannot overwrite the live site.

---

## Phase B (follow-up): per-PR projects

If the org wants isolated backends per PR:

1. Supabase Management API (or dashboard) create project named `bhs-pr-<number>`.
2. Restore latest encrypted PROD dump with `restore-db.sh --wipe`.
3. Deploy functions; write config; publish `pr-<number>.surge.sh`.
4. On PR close, tear down the project.

Defer until phase A is used for a few reviews and cost/quotas are clear. The scripts here (`restore-db.sh`, `deploy-edge-functions.sh`, `assemble-site.sh`, `publish-staging-site.sh`) are the building blocks.

---

## Safety

- No workflow in this folder runs `db:up` / `supabase db push` against PROD.
- Staging refresh may **read**-dump PROD (`--dump-prod-first`) using the existing backup script only.
- `shots-config.js`, service_role keys, DB passwords, and plaintext dumps stay out of git (`shots-config.js` and `/backups/` are gitignored).
- Anonymous auth + RLS still apply on STAGING; staff PIN is the same client gate as other envs (use a different PIN via `SHOTS_PIN` if you want staging-only writes more obviously separated — optional).
