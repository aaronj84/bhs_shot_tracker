-- Down: 20261007215033_mp_pk_winner_deleted
drop view if exists public.mp_brighton_results;

create view public.mp_brighton_results as
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

grant select on public.mp_brighton_results to authenticated;
revoke all on public.mp_brighton_results from anon;

drop index if exists public.mp_games_pk_winner_team_id_idx;
alter table public.mp_games drop constraint if exists mp_games_pk_winner_valid;
alter table public.mp_games
  drop column if exists is_deleted,
  drop column if exists pk_winner_team_id;
