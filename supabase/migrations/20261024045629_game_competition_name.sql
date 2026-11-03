-- Optional competition label on games (tournament name, league, futsal session, etc.).
-- Examples: Heros Cup, Premier 2, Futsal SportCity Session 1.

alter table public.games
  add column if not exists competition_name text;

comment on column public.games.competition_name is
  'Competition / event name for this game: tournament, league, futsal session, etc. Null when not used.';

create index if not exists games_competition_name_idx
  on public.games (competition_name)
  where competition_name is not null;

-- Backfill Heros Cup from schedule notes written during the CFC seed.
update public.games g
set competition_name = 'Heros Cup'
from public.notes n
where n.game_id = g.id
  and g.competition_name is null
  and g.game_type = 'tournament'
  and n.body ilike 'Heros Cup%';
