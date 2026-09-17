-- Mark a game final: freeze the scoreboard and keep a JSON snapshot of plays.

alter table public.games
  add column if not exists status text not null default 'live';

alter table public.games drop constraint if exists games_status_check;
alter table public.games
  add constraint games_status_check
  check (status in ('live', 'final'));

alter table public.games
  add column if not exists finalized_at timestamptz;

comment on column public.games.status is
  'live = in progress. final = whistle blown; scoreboard shows FINAL.';
comment on column public.games.finalized_at is
  'When the game was last marked final.';

create table if not exists public.game_archives (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  created_at timestamptz not null default now(),
  score_us integer not null default 0,
  score_opp integer not null default 0,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists game_archives_game_id_created_at_idx
  on public.game_archives (game_id, created_at desc);

comment on table public.game_archives is
  'Point-in-time snapshot of a game (score, lineup, plays) taken when marked final.';

alter table public.game_archives enable row level security;

do $$
begin
  execute 'drop policy if exists shots_select on public.game_archives';
  execute 'drop policy if exists shots_insert on public.game_archives';
  execute 'drop policy if exists shots_update on public.game_archives';
  execute 'drop policy if exists shots_delete on public.game_archives';
  execute 'create policy shots_select on public.game_archives for select to authenticated using (true)';
  execute 'create policy shots_insert on public.game_archives for insert to authenticated with check (true)';
  execute 'create policy shots_update on public.game_archives for update to authenticated using (true) with check (true)';
  execute 'create policy shots_delete on public.game_archives for delete to authenticated using (true)';
end;
$$;

grant select, insert, update, delete on public.game_archives to authenticated;
revoke all on public.game_archives from anon;
