-- Down: 20260831100000_baseline_schema
-- Drops core tracker tables and the updated_at trigger function.
-- Destructive. Does not drop the pgcrypto extension.

drop table if exists public.shots cascade;
drop table if exists public.rosters cascade;
drop table if exists public.games cascade;
drop table if exists public.players cascade;
drop table if exists public.seasons cascade;
drop table if exists public.teams cascade;
drop function if exists public.set_updated_at();
