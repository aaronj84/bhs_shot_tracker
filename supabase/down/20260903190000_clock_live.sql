-- Down: 20260903190000_clock_live
-- Drops live clock polling columns on games.

alter table public.games drop constraint if exists games_clock_period_check;
alter table public.games drop constraint if exists games_clock_elapsed_sec_check;
alter table public.games drop column if exists clock_period;
alter table public.games drop column if exists clock_elapsed_sec;
alter table public.games drop column if exists clock_running;
alter table public.games drop column if exists clock_started_at;
