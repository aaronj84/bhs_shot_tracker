-- Down: 20260916140000_game_final
-- Drops game archives and the live/final status columns.

drop table if exists public.game_archives;
alter table public.games drop constraint if exists games_status_check;
alter table public.games drop column if exists status;
alter table public.games drop column if exists finalized_at;
