-- MaxPreps reconstruction kit: games, teams, published snapshots.
-- Phase 1 ingest only. Computed rating tables land in a later migration.
-- Safe to re-run: create if not exists / drop+add policies.

create table if not exists public.mp_teams (
  team_id        text primary key,
  display_name   text not null,
  state          text not null default 'UT',
  classification text,
  region         text,
  maxpreps_slug  text,
  is_our_team    boolean not null default false,
  updated_at     timestamptz not null default now()
);

create unique index if not exists mp_teams_one_ours
  on public.mp_teams ((true)) where is_our_team;

create index if not exists mp_teams_display_name_idx
  on public.mp_teams (lower(display_name));

create table if not exists public.mp_games (
  game_id       text primary key,
  played_on     date not null,
  home_team_id  text not null references public.mp_teams (team_id) on delete cascade,
  away_team_id  text not null references public.mp_teams (team_id) on delete cascade,
  home_score    int,
  away_score    int,
  home_rank     int,
  away_rank     int,
  neutral       boolean not null default false,
  is_forfeit    boolean not null default false,
  source_url    text,
  ingested_at   timestamptz not null default now()
);

create index if not exists mp_games_played_on_idx on public.mp_games (played_on);
create index if not exists mp_games_home_team_id_idx on public.mp_games (home_team_id);
create index if not exists mp_games_away_team_id_idx on public.mp_games (away_team_id);

create table if not exists public.mp_snapshots (
  snapshot_id    uuid primary key default gen_random_uuid(),
  taken_on       date not null,
  state          text not null,
  sport          text not null,
  classification text,
  rank           int,
  team_id        text references public.mp_teams (team_id) on delete set null,
  team_name      text not null,
  rating         numeric,
  strength       numeric,
  record         text,
  unique (taken_on, state, sport, team_name)
);

create index if not exists mp_snapshots_taken_on_idx
  on public.mp_snapshots (taken_on, rank);

drop trigger if exists mp_teams_set_updated_at on public.mp_teams;
create trigger mp_teams_set_updated_at
before update on public.mp_teams
for each row execute procedure public.set_updated_at();

create or replace view public.mp_brighton_results as
select
  g.played_on,
  case when g.home_team_id = b.team_id then 'H' else 'A' end as ha,
  opp.display_name as opponent,
  opp.classification as opp_class,
  opp.region as opp_region,
  case when g.home_team_id = b.team_id then g.home_score else g.away_score end as gf,
  case when g.home_team_id = b.team_id then g.away_score else g.home_score end as ga,
  case
    when g.home_score is null or g.away_score is null then null
    when (g.home_team_id = b.team_id and g.home_score > g.away_score)
      or (g.away_team_id = b.team_id and g.away_score > g.home_score) then 'W'
    when g.home_score = g.away_score then 'T'
    else 'L'
  end as result,
  s.rank as opp_rank,
  s.rating as opp_rating,
  s.strength as opp_str,
  g.source_url
from public.mp_games g
join public.mp_teams b on b.is_our_team
join public.mp_teams opp
  on opp.team_id = case
    when g.home_team_id = b.team_id then g.away_team_id
    else g.home_team_id
  end
left join public.mp_snapshots s
  on s.team_id = opp.team_id
 and s.taken_on = (select max(taken_on) from public.mp_snapshots)
where g.home_team_id = b.team_id or g.away_team_id = b.team_id;

alter table public.mp_teams enable row level security;
alter table public.mp_games enable row level security;
alter table public.mp_snapshots enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['mp_teams', 'mp_games', 'mp_snapshots']
  loop
    execute format('drop policy if exists mp_select on public.%I', t);
    execute format(
      'create policy mp_select on public.%I for select to authenticated using (true)',
      t);
  end loop;
end;
$$;

grant select on public.mp_teams, public.mp_games, public.mp_snapshots to authenticated;
grant select on public.mp_brighton_results to authenticated;
revoke all on public.mp_teams from anon;
revoke all on public.mp_games from anon;
revoke all on public.mp_snapshots from anon;
revoke all on public.mp_brighton_results from anon;
