-- Down: 20260831100001_semantic_layer
-- Drops curated views, stat_scope, and the sync trigger.
-- Does not delete shot/game row data.

drop view if exists explore.v_brighton_shots_official;
drop view if exists explore.v_brighton_shots;
drop view if exists explore.v_brighton_games;

drop view if exists public.v_brighton_shots_official;
drop view if exists public.v_brighton_shots;
drop view if exists public.v_brighton_games;

drop trigger if exists games_sync_stat_scope on public.games;
drop function if exists public.games_sync_stat_scope();

alter table public.games drop constraint if exists games_stat_scope_check;
alter table public.games drop column if exists stat_scope;
