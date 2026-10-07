-- Down: 20261007160000_postseason_schedule
-- Drops the postseason meeting scheduler (slots, bookings, SMS log, settings).

do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (p.proname like '\_schedule\_%' or p.proname like 'schedule\_%')
  loop
    execute format('drop function if exists %s', f.sig);
  end loop;
end;
$$;

drop table if exists public.meeting_sms_log;
drop table if exists public.meeting_bookings;
drop table if exists public.meeting_slots;
drop table if exists public.schedule_players;
drop table if exists public.schedule_admin_sessions;
drop table if exists public.schedule_admin_attempts;
drop table if exists public.schedule_settings;
