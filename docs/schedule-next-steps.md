# Postseason Meeting Scheduler — next steps

Resume notes for the **Schedule** module.

- **Parents:** isolated page at `blue26/schedule/`. Live link after PROD deploy: <https://aaronj84.github.io/bhs_shot_tracker/blue26/schedule/> (`/blue26/` redirects there). It has no tracker header or nav and no links back into the app.
- **Coaches (Aaron, Ryan, Sarah):** the **Schedule** tab in the tracker (`#schedule`) opens the PIN-gated coach view. Its **Parent page** button opens the parent page.

- Branch: `cursor/postseason-schedule`
- PR: [#20 → `dev`](https://github.com/aaronj84/bhs_shot_tracker/pull/20) (CI green as of Oct 7, 2026)

## Pick up on another computer

```bash
git fetch origin
git checkout cursor/postseason-schedule
npm ci

# UI against a local mock backend (PGlite running the real migration, seeded with times)
echo 'window.SHOTS_CONFIG = { supabaseUrl: "http://127.0.0.1:8787", supabaseAnonKey: "local-mock", pin: "KEPPA" };' > shots-config.js
npm run schedule:mock            # terminal 1 → http://127.0.0.1:8787
python3 -m http.server 8080      # terminal 2
# Parent page: http://127.0.0.1:8080/blue26/schedule/
# Coach view:  http://127.0.0.1:8080/#schedule  (PIN: KEPPA)
# Delete or regenerate shots-config.js (node scripts/write-shots-config.js) before testing the tracker against DEV.

# Tests
npx vitest run tests/unit                       # SQL (PGlite) + shared logic
npx playwright test tests/e2e/schedule.spec.mjs # 390x844, mocked RPCs, no DEV needed
```

## Still to do

1. **Smoke test on DEV:** serve locally with a DEV `shots-config.js` (`node scripts/write-shots-config.js`). Add a few times in the **Schedule** tab (`#schedule`, PIN `KEPPA`), book one from `/blue26/schedule/` with a phone number, then move and cancel it. Open the feed link from the Calendar tab in a browser: it should download `text/calendar`.
2. **Change the scheduler PIN** (Calendar tab → Scheduler PIN). It starts as `KEPPA`, which is readable in the shipped `shots-config.js`.
3. **Coaches subscribe to the private feed** (Calendar tab → Private calendar feed) in Apple Calendar or Outlook. Each event carries alerts: 60 and 15 minutes before the first meeting of the day, 30 and 5 after a break of an hour or more, and 5 before every other meeting (`alertMinutes` in `_shared/schedule/ics.ts`). On a Mac, uncheck **Remove: Alerts** when subscribing or the alerts get stripped.
4. **No automated texts, email, or Google Calendar sync** (`20261010150000_schedule_manual_reminders`). Families pick a player and a time and can leave up to two mobile numbers. Then they tap **Add to my calendar** on the confirmation screen; that event includes a 30-minute reminder. To text reminders by hand, use Calendar tab → **Text messages**: each upcoming day has a comma-separated list of numbers to paste into Messages, plus a draft reminder to copy. When a coach moves or cancels a meeting, tell the family directly; their calendar won't update.
5. **Ship to PROD:** PR `dev` → `main`, then send the feed link to Sarah and Ryan.
6. **Send parents** <https://aaronj84.github.io/bhs_shot_tracker/blue26/schedule/>. Before sending, check on a phone that it loads and shows only the booking form.

## Where things live

| Piece | Path |
| --- | --- |
| Parent + coach UI | `schedule.js`, styles at the end of `styles.css`, coach route in `app.js` |
| Parent page (isolated) | `blue26/schedule/index.html` (+ `blue26/index.html` redirect); shipped by `.github/workflows/pages.yml` |
| Schema + RPCs | `supabase/migrations/20261007160000_postseason_schedule.sql`, then `20261010150000_schedule_manual_reminders.sql` |
| Coach calendar feed (with alerts) | `supabase/functions/schedule-ics/` |
| Shared logic | `supabase/functions/_shared/schedule/` |
| Tests | `tests/unit/schedule-*.test.mjs`, `tests/e2e/schedule.spec.mjs`, `tests/fixtures/schedule-*.mjs` |
