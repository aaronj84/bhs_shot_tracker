-- Down: 20261006183529_shot_lane_range
-- Views cannot drop columns via CREATE OR REPLACE, so drop and rebuild the game-clock shape.

drop view if exists explore.v_brighton_shots_official;
drop view if exists explore.v_brighton_shots;
drop view if exists public.v_brighton_shots_official;
drop view if exists public.v_brighton_shots;

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
  s.game_clock_seconds
from public.shots s
join public.games g on g.id = s.game_id
left join public.players p on p.id = s.player_id
left join public.teams opp on opp.id = case
  when g.home_team_id = g.our_team_id then g.away_team_id
  else g.home_team_id
end;

comment on view public.v_brighton_shots is
  'Curated shot rows for Explore: opponent/home/scope/result flags pre-resolved. Prefer v_brighton_shots_official for season aggregates.';

create view public.v_brighton_shots_official as
select *
from public.v_brighton_shots
where stat_scope in ('official', 'preseason')
  and is_tracked = true;

comment on view public.v_brighton_shots_official is
  'Default season-stats surface: official + preseason only; friendlies/exhibition and untracked games excluded.';

grant select on public.v_brighton_shots to authenticated, service_role;
grant select on public.v_brighton_shots_official to authenticated, service_role;

do $$
begin
  if to_regnamespace('explore') is not null then
    execute 'create view explore.v_brighton_shots as select * from public.v_brighton_shots';
    execute 'create view explore.v_brighton_shots_official as select * from public.v_brighton_shots_official';
    execute 'grant select on explore.v_brighton_shots to service_role';
    execute 'grant select on explore.v_brighton_shots_official to service_role';
  end if;
end;
$$;

drop function if exists public.shot_range(numeric);
drop function if exists public.shot_lane(numeric);
