-- Every minute, poke the schedule-worker Edge Function if anything is due
-- (confirmation texts, 30-minute reminders, Google Calendar sync).
-- Durable: state lives in meeting_bookings, so a missed run just catches up.
-- The worker URL is registered from #schedule-admin on coach sign-in.

create extension if not exists pg_net;
create extension if not exists pg_cron;

select cron.schedule(
  'schedule-worker',
  '* * * * *',
  $$select public.schedule_kick_worker()$$
);
