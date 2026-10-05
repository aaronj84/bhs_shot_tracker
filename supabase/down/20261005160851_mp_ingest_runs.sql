-- Down: 20261005160851_mp_ingest_runs
drop policy if exists mp_ingest_runs_select on public.mp_ingest_runs;
drop table if exists public.mp_ingest_runs;
