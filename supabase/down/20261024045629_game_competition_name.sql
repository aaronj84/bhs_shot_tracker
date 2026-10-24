drop index if exists public.games_competition_name_idx;

alter table public.games
  drop column if exists competition_name;
