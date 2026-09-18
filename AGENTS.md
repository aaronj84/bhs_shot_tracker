# Brighton Varsity Shot Tracker

Sideline shot/play recorder for Brighton varsity. Vanilla HTML/CSS/JS + Supabase. No client build step.

Staff PIN gates writes. Default PIN is documented in `shots-config.example.js`.

## iPhone portrait UI

This is a phone app. Design, implement, and verify every screen in **iPhone portrait** (390×844 CSS pixels). Do not treat a desktop browser as the target. See `.cursor/rules/iphone-portrait.mdc`.

## Environments

| Env | Project ref | Use |
| --- | --- | --- |
| **DEV** | `fmiymqnfezkqagpbrmoi` | Local, CI, Cloud Agents, feature work |
| **PROD** | `sczdnalqmymhdornhkbn` | Live GitHub Pages site + real game data |

- Day-to-day work points at **DEV**. Never write one-off SQL against PROD.
- New schema is a versioned pair: `supabase/migrations/<ts>_name.sql` (up) and `supabase/down/<ts>_name.sql` (down). Scaffold with `npm run db:new -- describe_change`, then `npm run db:up` on the linked DEV project. The runner records versions in `supabase_migrations.schema_migrations` and applies only what that database is missing — so a new DEV/stage project catches up from empty.
- GitHub flow: work on a branch → PR into `dev` → later PR `dev` → `main`. Do not push to `main`. Merging to `main` deploys Pages and migrates PROD.
- `shots-config.js` is gitignored. Generate it; never commit it.

```bash
# local / cloud: write config from env, then serve
node scripts/write-shots-config.js
python3 -m http.server 8080
# http://127.0.0.1:8080/#shots
```

Required env: `SHOTS_SUPABASE_URL`, `SHOTS_SUPABASE_ANON_KEY`. Optional: `SHOTS_PIN` (default `KEPPA`).

```bash
npm ci
npm run test:api    # Vitest vs DEV
npm run test:e2e    # Playwright smokes
```

## Cursor Cloud specific instructions

Cloud agents read this section.

1. Secrets must already be in the Cloud Agents dashboard (Runtime Secrets): `SHOTS_SUPABASE_URL`, `SHOTS_SUPABASE_ANON_KEY`, `SHOTS_PIN` — **DEV** values, never PROD.
2. `.cursor/environment.json` installs npm + Playwright Chromium, writes `shots-config.js` on start, and serves the site on **port 8080**.
3. After UI changes: open the forwarded site, set the browser to **390×844 portrait**, and click through the flow. Screenshots at desktop width do not count.
4. Run `npm run test:api` and `npm run test:e2e` before opening a PR. Playwright still launches Chromium; override the viewport to 390×844 when checking layout.
5. Open PRs against **`dev`**, not `main`. Do not run `npm run db:up` or `supabase db push` against PROD from a laptop. Do not put service-role keys in the repo, config, or commit messages.
6. Enable the project’s Supabase MCP in the Cloud Agents MCP dropdown if you need to inspect DEV schema. Prod MCP is read-only.
