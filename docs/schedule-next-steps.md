# Postseason Meeting Scheduler — next steps

Resume notes for the **Schedule** module (`#schedule` for parents, `#schedule-admin` for coaches).

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
python3 -m http.server 8080      # terminal 2 → http://127.0.0.1:8080/#schedule
# Coach view: http://127.0.0.1:8080/#schedule-admin  (PIN: KEPPA)
# Delete or regenerate shots-config.js (node scripts/write-shots-config.js) before testing the tracker against DEV.

# Tests
npx vitest run tests/unit                       # SQL (PGlite) + shared logic
npx playwright test tests/e2e/schedule.spec.mjs # 390x844, mocked RPCs, no DEV needed
```

## Still to do

1. **Review + merge PR #20 into `dev`.** CI applies both migrations and deploys `schedule-worker` and `schedule-ics` to DEV.
2. **Smoke test on DEV** (not yet verified against real Supabase):
   - Open `#schedule-admin`, sign in with `KEPPA`. This registers the worker URL. The Calendar tab should say "Reminder service: on".
   - Add a few times, book one from `#schedule` on a phone, then move and cancel it in admin.
   - Open the feed link from the Calendar tab in a browser: it should download `text/calendar`.
   - If the cron migration failed in CI, check that `pg_cron` / `pg_net` are enabled (Dashboard → Database → Extensions).
3. **Change the scheduler PIN** (Calendar tab → Scheduler PIN). It starts as `KEPPA`, which is readable in the shipped `shots-config.js`.
4. **Twilio** (texts are logged as `skipped` until this is done):
   ```bash
   supabase secrets set --project-ref <ref> \
     TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... TWILIO_FROM_NUMBER=+1XXXXXXXXXX
   ```
   US 10-digit numbers need A2P 10DLC registration in Twilio (can take days). Start it early.
5. **Google Calendar** (team calendar `274f71a749b3c3deb6c6f09de7ed5dc47b915cf91f1c6b21ff949003085be79f@group.calendar.google.com`):
   1. In Google Cloud Console, enable the **Google Calendar API**.
   2. Create a service account, then add a JSON key and download it.
   3. Share the calendar with the service account's email, using **Make changes to events**.
   4. Set the secrets:
      ```bash
      supabase secrets set --project-ref <ref> \
        GOOGLE_CALENDAR_ID=274f71a749b3c3deb6c6f09de7ed5dc47b915cf91f1c6b21ff949003085be79f@group.calendar.google.com \
        GOOGLE_SERVICE_ACCOUNT_JSON="$(cat service-account.json)"
      ```
   Use PROD only, or a separate test calendar on DEV, so test bookings stay off the real calendar.
6. **Ship to PROD:** PR `dev` → `main`. After deploy, repeat steps 2–5 on PROD and send the feed link to Sarah and Ryan.

## Open questions

- SMS text still starts with "Brighton Soccer:". Switch to the friendlier "Aaron's code bot" tone? Edit `smsText` in `supabase/functions/_shared/schedule/format.ts` and its test.
- Email confirmations: not built. Fill in `supabase/functions/_shared/schedule/email.ts` (e.g. Resend) if wanted.

## Where things live

| Piece | Path |
| --- | --- |
| Parent + coach UI | `schedule.js`, styles at the end of `styles.css`, route in `app.js` |
| Schema + RPCs | `supabase/migrations/20261007160000_postseason_schedule.sql` |
| Every-minute reminder cron | `supabase/migrations/20261007160100_schedule_worker_cron.sql` |
| Texts + Google sync | `supabase/functions/schedule-worker/` |
| ICS feed | `supabase/functions/schedule-ics/` |
| Shared logic | `supabase/functions/_shared/schedule/` |
| Tests | `tests/unit/schedule-*.test.mjs`, `tests/e2e/schedule.spec.mjs`, `tests/fixtures/schedule-*.mjs` |
