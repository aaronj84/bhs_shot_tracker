-- Down: 20260916130000_game_lineup
-- Drops the persisted XI JSON on games.

alter table public.games drop column if exists lineup;
