-- One-off: 2026-09-15 Brighton vs Olympus had first/second half labels reversed.
-- Swap period '1' <-> '2' on that game only. Extra time (ET1/ET2) is left alone.
-- game_clock_seconds stays as elapsed time into the period.
--
-- Prod game id: ca6eed99-7d3c-4dc6-ac79-30b72782f3f6
-- Preview before swap: P1 Brighton 5 / Olympus 12; P2 Brighton 10 / Olympus 7; ET1 1+2.
-- Run in Supabase SQL editor (prod). Preview first, then the DO block.
-- Safe to re-run: a second run swaps them back.

-- ---------------------------------------------------------------------------
-- Preview: what will swap
-- ---------------------------------------------------------------------------
with game as (
  select g.id
  from public.games g
  join public.teams h on h.id = g.home_team_id and h.name = 'Brighton'
  join public.teams a on a.id = g.away_team_id and a.name = 'Olympus'
  where g.date = '2026-09-15'
)
select
  s.period as period_now,
  case s.period
    when '1' then '2'
    when '2' then '1'
    else s.period
  end as period_after,
  t.name as team,
  count(*) as shots
from public.shots s
join game g on g.id = s.game_id
join public.teams t on t.id = s.team_id
group by s.period, t.name
order by s.period, t.name;

-- ---------------------------------------------------------------------------
-- Apply: swap first half <-> second half
-- ---------------------------------------------------------------------------
do $$
declare
  target_id uuid;
  swapped int;
begin
  select g.id into target_id
  from public.games g
  join public.teams h on h.id = g.home_team_id and h.name = 'Brighton'
  join public.teams a on a.id = g.away_team_id and a.name = 'Olympus'
  where g.date = '2026-09-15';

  if target_id is null then
    raise exception 'Missing game: 2026-09-15 Brighton vs Olympus';
  end if;

  update public.shots
  set
    period = case period
      when '1' then '2'
      when '2' then '1'
    end,
    updated_at = now()
  where game_id = target_id
    and period in ('1', '2');

  get diagnostics swapped = row_count;
  raise notice 'Swapped period on % shots for 2026-09-15 Brighton vs Olympus. ET shots unchanged.', swapped;
end;
$$;

-- ---------------------------------------------------------------------------
-- Verify: first/second half counts should be inverted vs preview; ET unchanged
-- ---------------------------------------------------------------------------
select
  s.period,
  t.name as team,
  count(*) as shots
from public.games g
join public.teams h on h.id = g.home_team_id and h.name = 'Brighton'
join public.teams a on a.id = g.away_team_id and a.name = 'Olympus'
join public.shots s on s.game_id = g.id
join public.teams t on t.id = s.team_id
where g.date = '2026-09-15'
group by s.period, t.name
order by s.period, t.name;
