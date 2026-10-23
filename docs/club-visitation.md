# Club Player Visitation Planner

Coach-facing module to find returning Brighton players at club soccer games and plan field visits during the high-school offseason.

Hash routes: `#club` / `#club-agenda` (default) · `#club-itinerary` · `#club-data`

## Design decisions (repository audit)

| Topic | Decision |
| --- | --- |
| Stack | Vanilla HTML/CSS/JS + Supabase (no client build). New module: `club-visitation.js`, same pattern as `schedule.js`. |
| Player identity | Club players live in `club_players`. Shot-tracker `players` stay separate. `club_player_links` is the only connection, and it is optional. |
| Auth / RLS | Anonymous Supabase session after staff PIN (client gate). RLS: `authenticated` full CRUD on `club_*` tables — same as shot tracker. |
| Gemini | Reuse `GEMINI_API_KEY` + `createGeminiProvider` via Edge Function `club-visitation`. Tool-style JSON plans executed server-side against Postgres; model does not invent fixtures. |
| Maps / routing | Facility pins use lat/lng + Google Maps / OSM direction links. Place lookup via Photon (no key) or OpenRouteService geocode when keyed. Drive times via ORS Matrix when `OPENROUTESERVICE_API_KEY` is set; otherwise UI shows “travel time unavailable” (never invents drive minutes from haversine). Same-facility field moves use configurable walk minutes. |
| Cron | `pg_cron` job `club-sync-worker` every 6 hours calls `club_kick_sync()` → `pg_net` POST to registered `club-sync` Edge Function URL. Manual Sync Now from Club Data. |
| Naming | All new tables use `club_` prefix. Separate from HS `games` / postseason `schedule_*`. |
| Itineraries | Shared named records (no coach ownership). PIN-gated users can create/edit/copy. |

## Schema overview

See migration `supabase/migrations/20261016180000_club_visitation.sql`.

- Teams are first-class (`club_teams`), including opponents with zero Brighton players.
- Games reference `home_team_id` / `away_team_id` (nullable only while opponent is TBD + `raw_*` labels).
- Affiliations: `club_player_affiliations.club_player_id → club_players.id`.
- Optional link: `club_player_links` pairs one club player with one shot-tracker player. Adding a game to an itinerary offers that link only when the names could be the same person.
- Schedule URLs live on `club_schedule_sources` (scoped to a team↔competition enrollment), not on the team row.
- Sync audit: `club_sync_runs`, `club_game_changes`, `club_game_source_links`.
- Manual overrides: `club_games.manual_overrides` jsonb + `coach_verified_at`; sync skips overridden fields.

## Environment / secrets

**Cloud Agent / local app**

| Variable | Required | Notes |
| --- | --- | --- |
| `SHOTS_SUPABASE_URL` | yes | DEV project URL |
| `SHOTS_SUPABASE_ANON_KEY` | yes | DEV anon key |
| `SHOTS_PIN` | no | Default `KEPPA` |

**Supabase Edge Function secrets (DEV / PROD)**

| Secret | Required | Notes |
| --- | --- | --- |
| `GEMINI_API_KEY` | for Ask Gemini | Already used by prep-opponent / mp-whatif |
| `PREP_GEMINI_MODEL` | no | Default `gemini-3.6-flash` |
| `OPENROUTESERVICE_API_KEY` | for routed drive times | Free key at [openrouteservice.org](https://openrouteservice.org/dev/#/signup) (no billing card). Place lookup works without it (Photon); with the key, ORS handles geocode + matrix. |
| `CLUB_SYNC_CRON_SECRET` | recommended | Shared bearer for cron → `club-sync` |

```bash
supabase secrets set GEMINI_API_KEY=…
# optional (free ORS key — drive times):
supabase secrets set OPENROUTESERVICE_API_KEY=…
supabase secrets set CLUB_SYNC_CRON_SECRET=$(openssl rand -hex 24)
```

After first coach open of Club Data with PIN session, the app registers the `club-sync` function URL (same pattern as schedule worker registration).

## Deploy

1. PR → `dev` applies migration + deploys Edge Functions via CI.
2. Set secrets on the project if missing.
3. Confirm cron job `club-sync-worker` exists (`select * from cron.job where jobname = 'club-sync-worker'`).
4. Seed demo data on DEV only: `supabase/seed_club_demo.sql` (SQL Editor) — cartoon clubs/facilities/games, not production players’ real club schedules.

## Supported schedule source formats

| Provider key | Format | Notes |
| --- | --- | --- |
| `ics` | iCalendar | Public `.ics` / webcal URLs |
| `csv` | CSV | Configurable column map in `parser_config` |
| `json` | JSON array / `{events:[…]}` | Field map in `parser_config` |
| `html` | HTML | Requires `parser_config.adapter` (e.g. `generic_table`); unsupported sites report failure honestly |
| `manual` | — | Coach-entered games only; sync is a no-op success |

Respect robots/terms; do not bypass login/CAPTCHA. A failed sync never deletes prior games. Source disappearance ≠ cancellation.

## Import

Club Data → CSV import accepts teams, affiliations, facilities, fields, competitions, schedule sources, and games with preview/validation. Column headers are documented in the UI. Alternatively run `seed_club_demo.sql` for a repeatable demo set.

## Itinerary calendar export

On **Itinerary**, **Add to calendar** builds an RFC 5545 `.ics` (one event per stop: planned arrival→departure, venue, players, 15‑minute reminder).

- **iPhone Safari:** tap opens Apple’s Add to Calendar flow (or the share sheet). Safari ignores `<a download>` on `data:` URLs, so the app navigates to a `text/calendar` base64 data URL instead of a silent no-op download.
- **Desktop:** downloads `*.ics` for Outlook / Google Calendar import.

One-shot export — tap again after edits. Live subscribe feeds are post-MVP.

## Known limitations

- HTML adapters cover a small set of table-shaped public pages; many club sites need a new adapter key or manual/ICS entry.
- Without `OPENROUTESERVICE_API_KEY`, drive times are unavailable (explicitly surfaced). Place geocoding still works via Photon.
- Gemini suggestions never auto-write itineraries; coach must accept.
- No SMS / push / per-coach ownership (out of MVP scope).

## Post-MVP

- **Itinerary ICS subscribe** — Publish a stable ICS (or webcal) URL per itinerary so phone calendars stay in sync when the coach edits visits in-app (downloadable `.ics` export already ships).
- **Schedule URL refresh testing** — End-to-end verification that `club-sync` / Sync Now correctly refreshes games from live schedule source URLs (ICS/CSV/HTML/JSON), including change detection and failure handling.
