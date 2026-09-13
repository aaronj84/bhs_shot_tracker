# Brighton Varsity Shot Tracker

Sideline shot / play recording for Brighton varsity — games, lineups, history, maps, and Prep.

Vanilla HTML, CSS, and JavaScript + Supabase. No build step for the client.

Tactical learning packs (BHS Blueprint, CFC Red) live in a separate repo: [`blueprint_soccer`](https://github.com/aaronj84/blueprint_soccer).

## Use the site

**[https://aaronj84.github.io/bhs_shot_tracker/](https://aaronj84.github.io/bhs_shot_tracker/)**

Staff PIN gates write access (default documented in `shots-config.example.js`).

## Run locally

```bash
cp shots-config.example.js shots-config.js
# fill DEV Supabase URL + anon key + PIN
python3 -m http.server 8080
# then visit http://localhost:8080
```

`shots-config.js` is gitignored — use **DEV** for day-to-day work (see below).

## Safeguards (dev / CI / prod)

| Doc | What it covers |
| --- | --- |
| [docs/dev-environment.md](docs/dev-environment.md) | Create DEV Supabase, CLI migrations, GitHub secrets, Pages |
| [docs/git-workflow.md](docs/git-workflow.md) | `dev` branch → PR to `main` (prod); branch is not deleted |
| [supabase/README.md](supabase/README.md) | Schema, migrations folder, Explore |

```bash
npm ci
export SHOTS_SUPABASE_URL=... SHOTS_SUPABASE_ANON_KEY=... SHOTS_PIN=KEPPA
node scripts/write-shots-config.js   # for Playwright
npm run test:api                     # Vitest vs DEV
npm run test:e2e                     # Playwright smokes
```

GitHub Actions runs those on push/PR to `dev` and `main`, and applies `supabase/migrations/` via `db push` (DEV on `dev`, PROD on `main`).

## Deep links

| Hash | Opens |
|------|--------|
| `#shots` | Record |
| `#shots-games` | Games / schedule |
| `#shots-history` | Cross-game history |
| `#shots-prep` | Opponent Prep (Gemini chat + notes) |
| `#shots-prep?tab=explore` | Explore (LLM Q&A; `#shots-explore` still redirects here) |
| `#shots-map` | Full-field shot map |

## Project structure

```text
/
  index.html
  styles.css
  app.js                  # Thin hash router / chrome
  shots.js                # Tracker UI
  shots-api.js            # Supabase access
  shots-config.js         # Local / generated (gitignored)
  shots-config.example.js
  docs/                   # Dev env + git workflow
  tests/                  # API + Playwright
  supabase/migrations/    # Canonical schema migrations
  supabase/functions/     # Explore Edge Function
  benchmark/              # Explore LLM harness
  scripts/                # Config writer, CSV helpers
```

## Deploy

GitHub Pages via **GitHub Actions** on `main` (writes PROD `shots-config.js` from secrets). Switch Pages source to Actions if it still says “Deploy from a branch” — details in [docs/dev-environment.md](docs/dev-environment.md).
