-- Rollback Club Player Visitation Planner domain.

do $$
begin
  perform cron.unschedule('club-sync-worker');
exception when others then
  null;
end;
$$;

drop function if exists public.club_kick_sync();
drop function if exists public.club_sources_due();
drop function if exists public.club_register_sync_worker(text, text);
drop view if exists public.v_club_game_brighton;

drop trigger if exists club_teams_normalized_trg on public.club_teams;
drop function if exists public.club_teams_set_normalized();
drop function if exists public.club_normalize_name(text);

do $$
declare
  t text;
begin
  foreach t in array array[
    'club_teams', 'club_player_affiliations', 'club_competitions',
    'club_schedule_sources', 'club_facilities', 'club_games',
    'club_itineraries', 'club_settings'
  ]
  loop
    execute format('drop trigger if exists %I_set_updated_at on public.%I', t, t);
  end loop;
end;
$$;

drop function if exists public.club_set_updated_at();
drop trigger if exists club_games_validate_field_trg on public.club_games;
drop function if exists public.club_games_validate_field();

drop table if exists public.club_itinerary_stops cascade;
drop table if exists public.club_itineraries cascade;
drop table if exists public.club_game_changes cascade;
drop table if exists public.club_sync_runs cascade;
drop table if exists public.club_game_source_links cascade;
drop table if exists public.club_games cascade;
drop table if exists public.club_fields cascade;
drop table if exists public.club_facilities cascade;
drop table if exists public.club_schedule_sources cascade;
drop table if exists public.club_team_competitions cascade;
drop table if exists public.club_competitions cascade;
drop table if exists public.club_player_affiliations cascade;
drop table if exists public.club_teams cascade;
drop table if exists public.club_settings cascade;
