-- Roll back multi_team_seasons.
-- WARNING: extra is_ours teams beyond the first, and opponent rows owned by
-- non-Brighton teams, cannot round-trip cleanly. This down keeps the oldest
-- is_ours team as Brighton and re-attaches all opponents / seasons to it.

drop view if exists explore.v_our_shots_official;
drop view if exists explore.v_our_shots;
drop view if exists explore.v_our_games;
drop view if exists explore.v_brighton_shots_official;
drop view if exists explore.v_brighton_shots;
drop view if exists explore.v_brighton_games;
drop view if exists public.v_brighton_shots_official;
drop view if exists public.v_brighton_shots;
drop view if exists public.v_brighton_games;
drop view if exists public.v_our_shots_official;
drop view if exists public.v_our_shots;
drop view if exists public.v_our_games;

drop trigger if exists games_require_season_our_team on public.games;
drop function if exists public.games_require_season_our_team();

drop trigger if exists seasons_require_ours_team on public.seasons;
drop function if exists public.seasons_require_ours_team();

drop trigger if exists teams_require_ours_owner on public.teams;
drop function if exists public.teams_require_ours_owner();

-- Restore prior game_type check (rows with tournament/futsal/league must be rewritten first).
update public.games
set game_type = case
  when game_type = 'tournament' then 'friendly'
  when game_type = 'futsal' then 'other'
  when game_type = 'league' then 'region'
  else game_type
end
where game_type in ('tournament', 'futsal', 'league');

alter table public.games drop constraint if exists games_game_type_check;
alter table public.games
  add constraint games_game_type_check
  check (game_type in ('preseason', 'region', 'playoffs', 'friendly', 'other'));

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
      when new.game_type = 'friendly' then 'friendly'
      else 'exhibition'
    end;
  end if;
  return new;
end;
$$;

-- Collapse seasons onto a single Brighton team before dropping team_id.
do $$
declare
  brighton_id uuid;
begin
  select id into brighton_id
  from public.teams
  where is_ours
  order by name
  limit 1;

  if brighton_id is null then
    raise exception 'down multi_team_seasons: no is_ours team to restore as Brighton';
  end if;

  -- Prefer a team literally named Brighton if present.
  if exists (select 1 from public.teams where is_ours and name = 'Brighton') then
    select id into brighton_id from public.teams where is_ours and name = 'Brighton' limit 1;
  end if;

  update public.seasons set team_id = brighton_id;
  update public.games set our_team_id = brighton_id;
  update public.teams
  set owner_team_id = brighton_id
  where is_ours = false;
end;
$$;

drop index if exists public.seasons_team_label_key;
drop index if exists public.seasons_team_id_idx;

-- Relabel collisions: append team suffix before dropping team_id uniqueness context.
update public.seasons s
set label = s.label || ' (' || left(s.id::text, 8) || ')'
where exists (
  select 1 from public.seasons o
  where o.label = s.label and o.id < s.id
);

alter table public.seasons drop column if exists team_id;

alter table public.seasons drop constraint if exists seasons_label_key;
alter table public.seasons add constraint seasons_label_key unique (label);

-- Restore is_brighton singleton.
alter table public.teams
  add column if not exists is_brighton boolean not null default false;

update public.teams set is_brighton = false;
update public.teams
set is_brighton = true
where id = (
  select id from public.teams
  where is_ours
  order by case when name = 'Brighton' then 0 else 1 end, name
  limit 1
);

-- Opponent name collisions across former owners: dedupe before restoring global unique.
update public.teams t
set name = t.name || ' (' || left(t.id::text, 8) || ')'
where t.is_ours = false
  and exists (
    select 1 from public.teams o
    where o.name = t.name and o.id < t.id
  );

drop index if exists public.teams_ours_name_key;
drop index if exists public.teams_opponent_owner_name_key;

alter table public.teams drop constraint if exists teams_ours_owner_check;
alter table public.teams drop constraint if exists teams_org_type_check;

alter table public.teams drop column if exists owner_team_id;
alter table public.teams drop column if exists organization;
alter table public.teams drop column if exists org_type;
alter table public.teams drop column if exists level;
alter table public.teams drop column if exists brand_name;
alter table public.teams drop column if exists brand_sub;
alter table public.teams drop column if exists primary_color;
alter table public.teams drop column if exists accent_color;
alter table public.teams drop column if exists logo_path;
alter table public.teams drop column if exists is_ours;

alter table public.teams drop constraint if exists teams_name_key;
alter table public.teams add constraint teams_name_key unique (name);

create unique index if not exists teams_one_brighton
  on public.teams ((true)) where is_brighton;

-- Restore prior curated views (post shot_lane_range shape).
create view public.v_brighton_shots as
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
  (s.team_id = g.our_team_id) as is_brighton_shot,
  (s.team_id is distinct from g.our_team_id) as is_shot_against,
  g.date as game_date,
  g.season_id,
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

create view public.v_brighton_shots_official as
select *
from public.v_brighton_shots
where stat_scope in ('official', 'preseason')
  and is_tracked = true;

create view public.v_brighton_games as
select
  g.id as game_id,
  g.season_id,
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

grant select on public.v_brighton_shots to authenticated, service_role;
grant select on public.v_brighton_shots_official to authenticated, service_role;
grant select on public.v_brighton_games to authenticated, service_role;

do $$
begin
  if to_regnamespace('explore') is not null then
    execute 'drop view if exists explore.teams';
    execute 'drop view if exists explore.seasons';
    execute 'create view explore.teams as select t.* from public.teams t';
    execute 'create view explore.seasons as select * from public.seasons';
    execute 'grant select on explore.teams to service_role';
    execute 'grant select on explore.seasons to service_role';
    execute 'create or replace view explore.v_brighton_shots as select * from public.v_brighton_shots';
    execute 'create or replace view explore.v_brighton_shots_official as select * from public.v_brighton_shots_official';
    execute 'create or replace view explore.v_brighton_games as select * from public.v_brighton_games';
    execute 'grant select on explore.v_brighton_shots to service_role';
    execute 'grant select on explore.v_brighton_shots_official to service_role';
    execute 'grant select on explore.v_brighton_games to service_role';
  end if;
end;
$$;

-- Restore explore_readonly allowlist to pre-multi-team relation list.
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
    '\mpublic\.(teams|seasons|players|games|rosters|shots|v_brighton_shots|v_brighton_shots_official|v_brighton_games)\M',
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
