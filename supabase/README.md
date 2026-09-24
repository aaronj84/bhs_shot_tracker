# Shot tracker — Supabase pickup

Use this file when switching machines. Prefer **DEV** for local work; see [`docs/dev-environment.md`](../docs/dev-environment.md).

## Credentials

Copy `shots-config.example.js` → `shots-config.js` (gitignored) and fill DEV values:

```js
window.SHOTS_CONFIG = {
  pitch: { width: 68, length: 105 },
  storageKey: "brighton-varsity-shot-tracker",
  supabaseUrl: "https://YOUR_DEV_REF.supabase.co",
  supabaseAnonKey: "YOUR_DEV_ANON_KEY",
  pin: "KEPPA"
};
```

| Setting | Value |
| --- | --- |
| PIN (shared staff gate) | `KEPPA` (or your chosen PIN) |
| Project URL | Settings → API → Project URL |
| Anon / public key | Settings → API → anon `public` |
| Service role key | Do **not** put this in the app or git |

## Environments

| Env | Project | Used for |
| --- | --- | --- |
| **PROD** | `sczdnalqmymhdornhkbn` | Live site + real data |
| **DEV** | (you create) | Local + CI |

## Schema & migrations

Each change is a versioned **up** + **down** pair:

| | Path |
| --- | --- |
| Up | [`migrations/<timestamp>_<name>.sql`](migrations/) |
| Down | [`down/<timestamp>_<name>.sql`](down/) |

The runner (`scripts/migrate.mjs`) looks at `supabase_migrations.schema_migrations` on the **linked** project, applies any ups that database does not have, and can roll back with the matching down.

```bash
supabase link --project-ref <DEV_REF>
npm run db:status          # local files vs versions on the linked DB
npm run db:up              # apply missing ups
npm run db:up -- --dry-run
npm run db:down -- --dry-run
npm run db:down -- 1 --yes # rollback last applied (refuses PROD unless --allow-prod)
```

New change:

```bash
npm run db:new -- describe_change
# edit supabase/migrations/<timestamp>_describe_change.sql
# edit supabase/down/<timestamp>_describe_change.sql
npm run db:up
git add supabase/migrations supabase/down && git commit
```

- Push to `dev` → GitHub Actions runs `db:up` against **DEV**
- Merge to `main` → Actions dumps PROD, then `db:up` against **PROD**
- A brand-new environment (public DEV, stage, empty project): link it, then `npm run db:up`

If an existing database recorded the same change under a different timestamp, `status` shows it as an **alias** and `up` skips that file. `node scripts/migrate.mjs sync-history --yes` rewrites those remote versions to match git.

On-demand / PR backups: [`docs/backup.md`](../docs/backup.md).

### Dashboard (still required once per project)

1. Authentication → Providers → **Anonymous** → Enable.
2. RLS policies ship in the baseline migration (`authenticated` read/write; PIN is client-only).

### Historical SQL (do not use for new work)

These were one-off / hand-run scripts. The baseline migrations already cover their durable schema pieces. Keep them for reference only — **do not** re-run on prod:

- `schema.sql` → superseded by `migrations/20260831100000_baseline_schema.sql`
- `migrate_semantic_layer.sql` → `…00001_semantic_layer.sql`
- `migrate_explore.sql` → `…00002_explore.sql`
- `migrate_shot_tracker_v3.sql`, `migrate_fouler.sql`, `migrate_charlotte_sharky.sql`, `migrate_position_groups_jv.sql`, `migrate_2026_varsity_schedule.sql`, `migrate_import_recorded_shots.sql`, etc.

Preview / empty-database seed: [`seed.sql`](seed.sql) (wired in `config.toml` `[db.seed]`). Optional SQL Editor extras: `seed_dev_sandbox.sql`, `sample_data.sql`. Never run any of those on prod.

## Explore + Opponent Prep (optional AI)

Natural-language questions live under **Prep → Explore** (`#shots-prep?tab=explore`; `#shots-explore` still works). Uses a Supabase Edge Function + OpenAI.

Opponent Prep briefings (`#shots-prep`) use a separate function + Gemini.

1. Migrations must include semantic + explore (already in `migrations/`) and `prep_notes`.
2. Create an [OpenAI API](https://platform.openai.com) key. Set a low monthly spend limit.
3. Store as a project secret:

```bash
supabase secrets set OPENAI_API_KEY=sk-...
supabase secrets set GEMINI_API_KEY=...
```

4. Deploy:

```bash
supabase functions deploy explore-shots
supabase functions deploy prep-opponent
```

Confirm JWT verification stays on (default).

Optional: `EXPLORE_OPENAI_MODEL` (default `gpt-4.1`), `PREP_GEMINI_MODEL` (default `gemini-3.6-flash`).

Golden scope tests (no LLM): `python -m benchmark.golden --verify` — see [`../benchmark/README.md`](../benchmark/README.md).

## Other machine checklist

1. Pull this repo.
2. Copy example → `shots-config.js` with **DEV** URL/anon/PIN.
3. `python3 -m http.server 8080` → open `#shots`.
4. Log in with PIN.

Hashes: `#shots` record · `#shots-games` schedule · `#shots-history` queries · `#shots-prep` opponent prep · `#shots-prep?tab=explore` AI explore · `#shots-map` game map.
