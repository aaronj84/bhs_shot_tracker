-- Ingest audit for MaxPreps reconstruction data (mp_games / mp_teams / mp_snapshots).
-- Each sync job records what changed vs the previous datastore contents.

create table if not exists public.mp_ingest_runs (
  run_id           uuid primary key default gen_random_uuid(),
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  source_label     text not null default 'csv',
  games_before     int,
  games_after      int,
  games_added      int not null default 0,
  games_updated    int not null default 0,
  games_removed    int not null default 0,
  score_changes    int not null default 0,
  teams_added      int not null default 0,
  notes            text,
  diff_sample      jsonb
);

create index if not exists mp_ingest_runs_started_at_idx
  on public.mp_ingest_runs (started_at desc);

alter table public.mp_ingest_runs enable row level security;

drop policy if exists mp_ingest_runs_select on public.mp_ingest_runs;
create policy mp_ingest_runs_select on public.mp_ingest_runs
  for select to authenticated using (true);

grant select on public.mp_ingest_runs to authenticated;
revoke all on public.mp_ingest_runs from anon;
