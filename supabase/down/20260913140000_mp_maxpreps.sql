-- Down: 20260913140000_mp_maxpreps
-- Drops MaxPreps ingest tables and the Brighton results view.

drop view if exists public.mp_brighton_results;
drop table if exists public.mp_snapshots;
drop table if exists public.mp_games;
drop table if exists public.mp_teams;
