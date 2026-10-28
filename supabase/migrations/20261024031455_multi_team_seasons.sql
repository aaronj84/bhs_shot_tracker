-- Multi-team seasons: owned Teams own Seasons; opponents scoped per owned Team.
-- Replaces singleton is_brighton with is_ours + team attributes + branding.

-- explore.* wrappers expand columns at create time; drop before reshaping teams/seasons.
drop view if exists explore.teams;
drop view if exists explore.seasons;

-- ---------------------------------------------------------------------------
-- 1. teams: is_ours, attributes, branding, owner_team_id
-- ---------------------------------------------------------------------------

alter table public.teams
  add column if not exists is_ours boolean not null default false;

update public.teams set is_ours = true where is_brighton = true;

alter table public.teams
  add column if not exists organization text,
  add column if not exists org_type text,
  add column if not exists level text,
  add column if not exists brand_name text,
  add column if not exists brand_sub text,
  add column if not exists primary_color text,
  add column if not exists accent_color text,
  add column if not exists logo_path text,
  add column if not exists owner_team_id uuid references public.teams (id) on delete cascade;

alter table public.teams drop constraint if exists teams_org_type_check;
alter table public.teams
  add constraint teams_org_type_check
  check (org_type is null or org_type in ('school', 'club', 'other'));

-- Backfill Brighton (the sole former is_brighton row) + opponents BEFORE the ours/owner check.
update public.teams
set
  organization = coalesce(organization, 'Brighton High School'),
  org_type = coalesce(org_type, 'school'),
  level = coalesce(level, 'Varsity'),
  brand_name = coalesce(brand_name, 'Brighton Bengals'),
  brand_sub = coalesce(brand_sub, 'Varsity Soccer'),
  primary_color = coalesce(primary_color, '#1a4d7c')
where is_ours = true;

update public.teams t
set owner_team_id = b.id
from public.teams b
where t.is_ours = false
  and t.owner_team_id is null
  and b.is_ours = true;

alter table public.teams drop constraint if exists teams_ours_owner_check;
alter table public.teams
  add constraint teams_ours_owner_check
  check (
    (is_ours = true and owner_team_id is null)
    or (is_ours = false and owner_team_id is not null)
  );

-- Replace singleton Brighton index + global name unique.
drop index if exists public.teams_one_brighton;

alter table public.teams drop constraint if exists teams_name_key;

create unique index if not exists teams_ours_name_key
  on public.teams (name)
  where is_ours = true;

create unique index if not exists teams_opponent_owner_name_key
  on public.teams (owner_team_id, name)
  where is_ours = false;

alter table public.teams drop column if exists is_brighton;

comment on column public.teams.is_ours is
  'True for trackable programs (Brighton Varsity, club U17, etc). False for opponents owned by one of those programs.';
comment on column public.teams.owner_team_id is
  'For opponents: the owned Team this opponent belongs to. Null for is_ours rows.';
comment on column public.teams.organization is
  'Parent org display name, e.g. Brighton High School or Cottonwood FC.';
comment on column public.teams.org_type is
  'school | club | other';
comment on column public.teams.level is
  'Varsity, JV, U12, U17, Fresh/Soph Blue, etc.';

-- ---------------------------------------------------------------------------
-- 2. seasons.team_id (owned Team)
-- ---------------------------------------------------------------------------

alter table public.seasons
  add column if not exists team_id uuid references public.teams (id);

update public.seasons s
set team_id = t.id
from public.teams t
where s.team_id is null
  and t.is_ours = true;

-- If somehow no ours team existed, fail loudly rather than leave nulls.
do $$
begin
  if exists (select 1 from public.seasons where team_id is null) then
    raise exception 'seasons.team_id backfill failed: no is_ours team to attach';
  end if;
end;
$$;

alter table public.seasons
  alter column team_id set not null;

alter table public.seasons drop constraint if exists seasons_label_key;

create unique index if not exists seasons_team_label_key
  on public.seasons (team_id, label);

create index if not exists seasons_team_id_idx on public.seasons (team_id);

-- Seasons may only hang off owned teams.
create or replace function public.seasons_require_ours_team()
returns trigger
language plpgsql
as $$
begin
  if not exists (select 1 from public.teams t where t.id = new.team_id and t.is_ours) then
    raise exception 'seasons.team_id % must reference an is_ours team', new.team_id;
  end if;
  return new;
end;
$$;

drop trigger if exists seasons_require_ours_team on public.seasons;
create trigger seasons_require_ours_team
before insert or update of team_id
on public.seasons
for each row execute procedure public.seasons_require_ours_team();

-- Opponents' owner must be an ours team.
create or replace function public.teams_require_ours_owner()
returns trigger
language plpgsql
as $$
begin
  if new.is_ours = false then
    if new.owner_team_id is null then
      raise exception 'opponent teams require owner_team_id';
    end if;
    if not exists (select 1 from public.teams t where t.id = new.owner_team_id and t.is_ours) then
      raise exception 'owner_team_id % must reference an is_ours team', new.owner_team_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists teams_require_ours_owner on public.teams;
create trigger teams_require_ours_owner
before insert or update of is_ours, owner_team_id
on public.teams
for each row execute procedure public.teams_require_ours_owner();

-- ---------------------------------------------------------------------------
-- 3. games: our_team_id must match season.team_id; widen game_type
-- ---------------------------------------------------------------------------

create or replace function public.games_require_season_our_team()
returns trigger
language plpgsql
as $$
declare
  season_team uuid;
begin
  select s.team_id into season_team from public.seasons s where s.id = new.season_id;
  if season_team is null then
    raise exception 'games.season_id % not found', new.season_id;
  end if;
  if new.our_team_id is distinct from season_team then
    raise exception 'games.our_team_id (%) must equal seasons.team_id (%)', new.our_team_id, season_team;
  end if;
  return new;
end;
$$;

drop trigger if exists games_require_season_our_team on public.games;
create trigger games_require_season_our_team
before insert or update of season_id, our_team_id
on public.games
for each row execute procedure public.games_require_season_our_team();

alter table public.games drop constraint if exists games_game_type_check;
alter table public.games
  add constraint games_game_type_check
  check (game_type in (
    'preseason', 'region', 'playoffs', 'friendly', 'other',
    'tournament', 'futsal', 'league'
  ));

-- Map new game types into stat_scope.
create or replace function public.games_sync_stat_scope()
returns trigger
language plpgsql
as $$
begin
  if new.stat_scope is null
     or tg_op = 'INSERT'
     or new.game_type is distinct from old.game_type then
    new.stat_scope := case
      when new.game_type in ('region', 'league', 'playoffs') then 'official'
      when new.game_type = 'preseason' then 'preseason'
      when new.game_type in ('friendly', 'tournament', 'futsal') then 'friendly'
      else 'exhibition'
    end;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Semantic views: v_our_* (+ temporary v_brighton_* aliases)
-- ---------------------------------------------------------------------------

drop view if exists explore.v_brighton_shots_official;
drop view if exists explore.v_brighton_shots;
drop view if exists explore.v_brighton_games;
drop view if exists public.v_brighton_shots_official;
drop view if exists public.v_brighton_shots;
drop view if exists public.v_brighton_games;

create view public.v_our_shots as
select
  s.id as shot_id,
  s.game_id,
  s.team_id,
  s.player_id,
  coalesce(p.short_name, p.name) as player_name,
  s.position,
  s.zone_id,
  s.zone_label,
  s.x,
  s.y,
  s.result,
  s.period,
  s.assist_player_id,
  s.assist_type,
  (s.team_id = g.our_team_id) as is_our_shot,
  (s.team_id = g.our_team_id) as is_brighton_shot,
  (s.team_id is distinct from g.our_team_id) as is_shot_against,
  g.date as game_date,
  g.season_id,
  g.our_team_id,
  opp.name as opponent_name,
  (g.home_team_id = g.our_team_id) as is_home,
  g.game_type,
  g.stat_scope,
  true as is_tracked,
  (s.result in ('goal', 'on-target', 'pk-goal')) as is_on_frame,
  (s.result in ('goal', 'pk-goal')) as is_goal,
  s.second_assist_player_id,
  s.second_assist_type,
  s.game_clock_seconds,
  case when s.y is not null then public.shot_lane(s.x) end as shot_lane,
  case when s.x is not null then public.shot_range(s.y) end as shot_range,
  round((sqrt(power(s.x - 34, 2) + power(s.y, 2)) / 0.9144)::numeric, 1) as goal_dist_yd,
  round(degrees(atan2(7.32 * s.y, power(s.x - 34, 2) + power(s.y, 2) - power(3.66, 2)))::numeric, 1) as goal_angle_deg
from public.shots s
join public.games g on g.id = s.game_id
left join public.players p on p.id = s.player_id
left join public.teams opp on opp.id = case
  when g.home_team_id = g.our_team_id then g.away_team_id
  else g.home_team_id
end;

create view public.v_our_shots_official as
select *
from public.v_our_shots
where stat_scope in ('official', 'preseason')
  and is_tracked = true;

create view public.v_our_games as
select
  g.id as game_id,
  g.season_id,
  g.our_team_id,
  g.date as game_date,
  g.game_type,
  g.stat_scope,
  (exists (select 1 from public.shots s where s.game_id = g.id)) as is_tracked,
  opp.name as opponent_name,
  (g.home_team_id = g.our_team_id) as is_home,
  coalesce(agg.shots_for, 0) as shots_for,
  coalesce(agg.shots_against, 0) as shots_against,
  coalesce(agg.goals_for, 0) as goals_for,
  coalesce(agg.goals_against, 0) as goals_against
from public.games g
left join public.teams opp on opp.id = case
  when g.home_team_id = g.our_team_id then g.away_team_id
  else g.home_team_id
end
left join lateral (
  select
    count(*) filter (where s.team_id = g.our_team_id) as shots_for,
    count(*) filter (where s.team_id is distinct from g.our_team_id) as shots_against,
    count(*) filter (
      where s.team_id = g.our_team_id
        and s.result in ('goal', 'pk-goal')
    ) as goals_for,
    count(*) filter (
      where s.team_id is distinct from g.our_team_id
        and s.result in ('goal', 'pk-goal')
    ) as goals_against
  from public.shots s
  where s.game_id = g.id
) agg on true;

comment on view public.v_our_shots is
  'Curated shot rows for Explore: opponent/home/scope/result flags pre-resolved. Prefer v_our_shots_official for season aggregates.';
comment on view public.v_our_shots_official is
  'Default season-stats surface: official + preseason only; friendlies/exhibition and untracked games excluded.';
comment on view public.v_our_games is
  'Per-game context for trends. is_tracked=false means not logged -- do not treat rollups as zero performance.';

-- Temporary aliases for anything still querying the Brighton-named views.
create view public.v_brighton_shots as select * from public.v_our_shots;
create view public.v_brighton_shots_official as select * from public.v_our_shots_official;
create view public.v_brighton_games as select * from public.v_our_games;

grant select on public.v_our_shots to authenticated, service_role;
grant select on public.v_our_shots_official to authenticated, service_role;
grant select on public.v_our_games to authenticated, service_role;
grant select on public.v_brighton_shots to authenticated, service_role;
grant select on public.v_brighton_shots_official to authenticated, service_role;
grant select on public.v_brighton_games to authenticated, service_role;

do $$
begin
  if to_regnamespace('explore') is not null then
    execute 'create or replace view explore.teams as select t.* from public.teams t';
    execute 'create or replace view explore.seasons as select * from public.seasons';
    execute 'grant select on explore.teams to service_role';
    execute 'grant select on explore.seasons to service_role';
    execute 'create or replace view explore.v_our_shots as select * from public.v_our_shots';
    execute 'create or replace view explore.v_our_shots_official as select * from public.v_our_shots_official';
    execute 'create or replace view explore.v_our_games as select * from public.v_our_games';
    execute 'create or replace view explore.v_brighton_shots as select * from public.v_brighton_shots';
    execute 'create or replace view explore.v_brighton_shots_official as select * from public.v_brighton_shots_official';
    execute 'create or replace view explore.v_brighton_games as select * from public.v_brighton_games';
    execute 'grant select on explore.v_our_shots to service_role';
    execute 'grant select on explore.v_our_shots_official to service_role';
    execute 'grant select on explore.v_our_games to service_role';
    execute 'grant select on explore.v_brighton_shots to service_role';
    execute 'grant select on explore.v_brighton_shots_official to service_role';
    execute 'grant select on explore.v_brighton_games to service_role';
  end if;
end;
$$;

-- Allow explore_readonly to strip public. qualifiers for the new view names.
create or replace function public.explore_readonly(query text)
returns jsonb
language plpgsql
security definer
set search_path = explore, public
as $$
declare
  cleaned text;
  result jsonb;
begin
  if query is null or length(trim(query)) = 0 then
    raise exception 'Empty query';
  end if;

  cleaned := trim(query);
  cleaned := regexp_replace(cleaned, ';\s*$', '');

  if cleaned ~* ';\s*\S' then
    raise exception 'Multiple statements are not allowed';
  end if;

  if cleaned !~* '^\s*(with|select)([[:space:]]|\(|$)' then
    raise exception 'Only SELECT (or WITH … SELECT) queries are allowed';
  end if;

  if cleaned ~* '[[:<:]](insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|execute|do|set|reset|notify|listen|unlisten|vacuum|analyze|reindex|cluster|comment|security|owner|policy|function|procedure|trigger|extension|schema|database|role|user|password)[[:>:]]' then
    raise exception 'Forbidden keyword in query';
  end if;

  cleaned := regexp_replace(
    cleaned,
    '\mpublic\.(teams|seasons|players|games|rosters|shots|v_our_shots|v_our_shots_official|v_our_games|v_brighton_shots|v_brighton_shots_official|v_brighton_games)\M',
    '\1',
    'gi'
  );

  execute format(
    'select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb)
     from (select * from (%s) as explore_inner limit 200) as t',
    cleaned
  )
  into result;

  return result;
end;
$$;

revoke all on function public.explore_readonly(text) from public;
revoke all on function public.explore_readonly(text) from anon;
revoke all on function public.explore_readonly(text) from authenticated;
grant execute on function public.explore_readonly(text) to service_role;
