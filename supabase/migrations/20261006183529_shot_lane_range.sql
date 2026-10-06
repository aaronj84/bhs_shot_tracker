-- Shot lane / range flags derived from x,y so every shot (past and future) is classified the same way.
-- Coordinates: x = 0..68 m across the pitch (0 = attacker's left touchline), y = metres from the attacking goal line.
-- Must stay in sync with SHOT_LANES / SHOT_RANGES in shots.js.

-- Lanes anchored on the box edges: wide | half-space | center | half-space | wide.
-- Penalty-box sides at 13.84 / 54.16, six-yard-box sides at 24.84 / 43.16.
-- A point on a boundary belongs to the more central lane.
create or replace function public.shot_lane(x numeric)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when x is null then null
    when x < 13.84 then 'LW'
    when x < 24.84 then 'LHS'
    when x <= 43.16 then 'C'
    when x <= 54.16 then 'RHS'
    else 'RW'
  end;
$$;

-- Depth from the goal line in 9-yard steps; 18 yd = the drawn penalty-area line (16.5 m).
-- A point on a line belongs to the nearer range ("within 18" includes 18).
create or replace function public.shot_range(y numeric)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when y is null then null
    when y <= 8.25 then '0-9'
    when y <= 16.5 then '9-18'
    when y <= 24.75 then '18-27'
    else '27+'
  end;
$$;

comment on function public.shot_lane(numeric) is
  'LW | LHS | C | RHS | RW from shot x (metres, 68 m pitch). Box-edge lanes; boundary goes to the more central lane.';
comment on function public.shot_range(numeric) is
  '0-9 | 9-18 | 18-27 | 27+ yards from the goal line, from shot y (metres). 18 yd = penalty-area line (16.5 m).';

-- Extra columns must be appended so CREATE OR REPLACE VIEW stays compatible.
create or replace view public.v_brighton_shots as
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

create or replace view public.v_brighton_shots_official as
select *
from public.v_brighton_shots
where stat_scope in ('official', 'preseason')
  and is_tracked = true;

comment on column public.v_brighton_shots.shot_lane is
  'Vertical lane: LW | LHS | C | RHS | RW (box-edge lanes; see public.shot_lane).';
comment on column public.v_brighton_shots.shot_range is
  'Distance band from the goal line: 0-9 | 9-18 | 18-27 | 27+ yards (see public.shot_range).';
comment on column public.v_brighton_shots.goal_dist_yd is
  'Straight-line distance from the shot to the centre of the goal, in yards.';
comment on column public.v_brighton_shots.goal_angle_deg is
  'Angle (degrees) subtended by the goal mouth from the shot location; larger = more goal to aim at.';

grant select on public.v_brighton_shots to authenticated, service_role;
grant select on public.v_brighton_shots_official to authenticated, service_role;

-- Explore wrappers expand * at creation time, so refresh them to pick up the new columns.
do $$
begin
  if to_regnamespace('explore') is not null then
    execute 'create or replace view explore.v_brighton_shots as select * from public.v_brighton_shots';
    execute 'create or replace view explore.v_brighton_shots_official as select * from public.v_brighton_shots_official';
    execute 'grant select on explore.v_brighton_shots to service_role';
    execute 'grant select on explore.v_brighton_shots_official to service_role';
  end if;
end;
$$;
