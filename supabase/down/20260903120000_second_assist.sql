-- Down: 20260903120000_second_assist
-- Drops second-assist columns and restores the semantic-layer shot views.

drop index if exists public.shots_second_assist_player_id_idx;
alter table public.shots drop constraint if exists shots_second_assist_player_id_fkey;
alter table public.shots drop constraint if exists shots_second_assist_type_check;
alter table public.shots drop constraint if exists shots_second_assist_position_check;
alter table public.shots drop column if exists second_assist_player_id;
alter table public.shots drop column if exists second_assist_type;
alter table public.shots drop column if exists second_assist_position;
alter table public.shots drop column if exists second_assist_x;
alter table public.shots drop column if exists second_assist_y;
alter table public.shots drop column if exists second_assist_zone_id;
alter table public.shots drop column if exists second_assist_zone_label;

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
  (s.result in ('goal', 'pk-goal')) as is_goal
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

grant select on public.v_brighton_shots to authenticated, service_role;
grant select on public.v_brighton_shots_official to authenticated, service_role;
