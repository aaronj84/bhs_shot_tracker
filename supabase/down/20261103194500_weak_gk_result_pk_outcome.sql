-- Down: 20261103194500_weak_gk_result_pk_outcome
-- Fails if a shot already uses result weak-gk or a pk_outcome.

create or replace view public.v_our_shots as
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

alter view public.v_our_shots set (security_invoker = true);

alter table public.shots drop constraint if exists shots_pk_outcome_check;
alter table public.shots drop column if exists pk_outcome;

alter table public.shots drop constraint if exists shots_result_check;
alter table public.shots
  add constraint shots_result_check
  check (
    result in (
      'goal',
      'on-target',
      'blocked',
      'missed',
      'foul',
      'corner',
      'pk-goal',
      'pk-missed'
    )
  );
