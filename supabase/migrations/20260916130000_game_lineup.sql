-- Persist the live XI on the game so Sync can push/pull lineup across devices.

alter table public.games
  add column if not exists lineup jsonb not null default '{}'::jsonb;
