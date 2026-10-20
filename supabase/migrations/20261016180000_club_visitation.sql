-- Club Player Visitation Planner domain.
-- Additive; does not alter shot-tracker or postseason schedule tables.
-- Player identity: public.players.id (durable across seasons).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Settings (sync worker URL + walk minutes)
-- ---------------------------------------------------------------------------

create table if not exists public.club_settings (
  id boolean primary key default true check (id),
  sync_worker_url text,
  sync_cron_secret text,
  same_facility_walk_minutes integer not null default 8
    check (same_facility_walk_minutes between 0 and 60),
  default_visit_minutes integer not null default 30
    check (default_visit_minutes between 5 and 180),
  updated_at timestamptz not null default now()
);

insert into public.club_settings (id)
values (true)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Teams, competitions, affiliations
-- ---------------------------------------------------------------------------

create table if not exists public.club_teams (
  id uuid primary key default gen_random_uuid(),
  organization_name text not null default '',
  team_name text not null,
  age_group text,
  gender_division text,
  normalized_name text not null default '',
  aliases text[] not null default '{}',
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists club_teams_active_idx on public.club_teams (active) where active;
create index if not exists club_teams_normalized_idx on public.club_teams (normalized_name);
create index if not exists club_teams_name_trgm_idx on public.club_teams (lower(team_name));

create table if not exists public.club_player_affiliations (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players (id) on delete restrict,
  club_team_id uuid not null references public.club_teams (id) on delete cascade,
  season_label text,
  starts_on date,
  ends_on date,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists club_player_affiliations_active_uniq
  on public.club_player_affiliations (player_id, club_team_id)
  where active;

create index if not exists club_player_affiliations_team_idx
  on public.club_player_affiliations (club_team_id) where active;
create index if not exists club_player_affiliations_player_idx
  on public.club_player_affiliations (player_id) where active;

create table if not exists public.club_competitions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  competition_type text not null default 'other'
    check (competition_type in ('league', 'tournament', 'invitational', 'friendly', 'other')),
  organizer text,
  season_year integer,
  starts_on date,
  ends_on date,
  website text,
  status text not null default 'active'
    check (status in ('active', 'completed', 'cancelled', 'draft')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.club_team_competitions (
  id uuid primary key default gen_random_uuid(),
  club_team_id uuid not null references public.club_teams (id) on delete cascade,
  club_competition_id uuid not null references public.club_competitions (id) on delete cascade,
  enrollment_status text not null default 'enrolled',
  notes text,
  created_at timestamptz not null default now(),
  unique (club_team_id, club_competition_id)
);

create index if not exists club_team_competitions_comp_idx
  on public.club_team_competitions (club_competition_id);

create table if not exists public.club_schedule_sources (
  id uuid primary key default gen_random_uuid(),
  club_team_competition_id uuid not null
    references public.club_team_competitions (id) on delete cascade,
  source_url text not null,
  provider text not null default 'other'
    check (provider in ('ics', 'csv', 'html', 'json', 'manual', 'other')),
  parser_config jsonb not null default '{}'::jsonb,
  precedence integer not null default 100,
  enabled boolean not null default true,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  next_check_at timestamptz,
  sync_status text not null default 'idle'
    check (sync_status in ('idle', 'ok', 'error', 'unsupported', 'running')),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists club_schedule_sources_enabled_idx
  on public.club_schedule_sources (enabled, next_check_at) where enabled;
create index if not exists club_schedule_sources_tc_idx
  on public.club_schedule_sources (club_team_competition_id);

-- ---------------------------------------------------------------------------
-- Facilities / fields
-- ---------------------------------------------------------------------------

create table if not exists public.club_facilities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  street_address text,
  city text,
  state text default 'UT',
  postal_code text,
  timezone text not null default 'America/Denver',
  latitude double precision,
  longitude double precision,
  google_place_id text,
  maps_url text,
  parking_notes text,
  aliases text[] not null default '{}',
  geocode_status text not null default 'unset'
    check (geocode_status in ('unset', 'ok', 'manual', 'failed', 'pending')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists club_facilities_city_idx on public.club_facilities (lower(city));
create index if not exists club_facilities_name_idx on public.club_facilities (lower(name));

create table if not exists public.club_fields (
  id uuid primary key default gen_random_uuid(),
  club_facility_id uuid not null references public.club_facilities (id) on delete cascade,
  label text not null,
  latitude double precision,
  longitude double precision,
  access_notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (club_facility_id, label)
);

create index if not exists club_fields_facility_idx on public.club_fields (club_facility_id);

-- ---------------------------------------------------------------------------
-- Games + provenance + changes
-- ---------------------------------------------------------------------------

create table if not exists public.club_games (
  id uuid primary key default gen_random_uuid(),
  club_competition_id uuid references public.club_competitions (id) on delete set null,
  home_team_id uuid references public.club_teams (id) on delete restrict,
  away_team_id uuid references public.club_teams (id) on delete restrict,
  raw_home_label text,
  raw_away_label text,
  kickoff_at timestamptz,
  kickoff_timezone text not null default 'America/Denver',
  ends_at timestamptz,
  duration_minutes integer,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'postponed', 'cancelled', 'completed', 'tbd')),
  club_facility_id uuid references public.club_facilities (id) on delete set null,
  club_field_id uuid references public.club_fields (id) on delete set null,
  round_title text,
  source_attribution text,
  external_fixture_key text,
  last_seen_at timestamptz,
  coach_verified_at timestamptz,
  manual_overrides jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint club_games_teams_distinct check (
    home_team_id is null or away_team_id is null or home_team_id <> away_team_id
  )
);

create index if not exists club_games_kickoff_idx on public.club_games (kickoff_at);
create index if not exists club_games_home_idx on public.club_games (home_team_id);
create index if not exists club_games_away_idx on public.club_games (away_team_id);
create index if not exists club_games_competition_idx on public.club_games (club_competition_id);
create index if not exists club_games_facility_idx on public.club_games (club_facility_id);
create index if not exists club_games_status_idx on public.club_games (status);
create index if not exists club_games_external_key_idx on public.club_games (external_fixture_key)
  where external_fixture_key is not null;

-- Field must belong to referenced facility
create or replace function public.club_games_validate_field()
returns trigger
language plpgsql
as $$
declare
  fac uuid;
begin
  if new.club_field_id is null then
    return new;
  end if;
  select club_facility_id into fac from public.club_fields where id = new.club_field_id;
  if fac is null then
    raise exception 'club_field_id % not found', new.club_field_id;
  end if;
  if new.club_facility_id is null then
    new.club_facility_id := fac;
  elsif new.club_facility_id <> fac then
    raise exception 'club_field_id does not belong to club_facility_id';
  end if;
  return new;
end;
$$;

drop trigger if exists club_games_validate_field_trg on public.club_games;
create trigger club_games_validate_field_trg
before insert or update on public.club_games
for each row execute procedure public.club_games_validate_field();

create table if not exists public.club_game_source_links (
  id uuid primary key default gen_random_uuid(),
  club_game_id uuid not null references public.club_games (id) on delete cascade,
  club_schedule_source_id uuid references public.club_schedule_sources (id) on delete set null,
  external_id text,
  external_url text,
  raw_payload jsonb,
  parse_confidence numeric,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (club_schedule_source_id, external_id)
);

create index if not exists club_game_source_links_game_idx
  on public.club_game_source_links (club_game_id);

create table if not exists public.club_sync_runs (
  id uuid primary key default gen_random_uuid(),
  club_schedule_source_id uuid not null
    references public.club_schedule_sources (id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  result text not null default 'running'
    check (result in ('running', 'ok', 'error', 'unsupported', 'partial')),
  seen_count integer not null default 0,
  inserted_count integer not null default 0,
  updated_count integer not null default 0,
  unchanged_count integer not null default 0,
  flagged_count integer not null default 0,
  error_detail text,
  parser_version text,
  created_at timestamptz not null default now()
);

create index if not exists club_sync_runs_source_idx
  on public.club_sync_runs (club_schedule_source_id, started_at desc);

create table if not exists public.club_game_changes (
  id uuid primary key default gen_random_uuid(),
  club_game_id uuid not null references public.club_games (id) on delete cascade,
  changed_fields text[] not null default '{}',
  old_values jsonb,
  new_values jsonb,
  source text,
  club_sync_run_id uuid references public.club_sync_runs (id) on delete set null,
  observed_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  review_status text not null default 'new'
    check (review_status in ('new', 'acknowledged', 'conflict', 'resolved'))
);

create index if not exists club_game_changes_game_idx
  on public.club_game_changes (club_game_id, observed_at desc);
create index if not exists club_game_changes_new_idx
  on public.club_game_changes (review_status) where review_status = 'new';

-- ---------------------------------------------------------------------------
-- Itineraries
-- ---------------------------------------------------------------------------

create table if not exists public.club_itineraries (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  notes text,
  target_date date,
  region_label text,
  start_location_label text,
  start_latitude double precision,
  start_longitude double precision,
  default_visit_minutes integer not null default 30,
  summary_text text,
  last_optimized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.club_itinerary_stops (
  id uuid primary key default gen_random_uuid(),
  club_itinerary_id uuid not null references public.club_itineraries (id) on delete cascade,
  club_game_id uuid not null references public.club_games (id) on delete cascade,
  stop_order integer not null,
  planned_arrival_at timestamptz,
  planned_departure_at timestamptz,
  visit_minutes integer,
  locked boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  unique (club_itinerary_id, club_game_id),
  unique (club_itinerary_id, stop_order)
);

create index if not exists club_itinerary_stops_itin_idx
  on public.club_itinerary_stops (club_itinerary_id, stop_order);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

create or replace function public.club_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

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
    execute format(
      'create trigger %I_set_updated_at before update on public.%I
       for each row execute procedure public.club_set_updated_at()',
      t, t
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Normalize team name helper
-- ---------------------------------------------------------------------------

create or replace function public.club_normalize_name(p_name text)
returns text
language sql
immutable
as $$
  select lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'));
$$;

create or replace function public.club_teams_set_normalized()
returns trigger
language plpgsql
as $$
begin
  if new.normalized_name is null or btrim(new.normalized_name) = '' then
    new.normalized_name := public.club_normalize_name(
      concat_ws(' ', nullif(new.organization_name, ''), new.team_name)
    );
  else
    new.normalized_name := public.club_normalize_name(new.normalized_name);
  end if;
  return new;
end;
$$;

drop trigger if exists club_teams_normalized_trg on public.club_teams;
create trigger club_teams_normalized_trg
before insert or update on public.club_teams
for each row execute procedure public.club_teams_set_normalized();

-- ---------------------------------------------------------------------------
-- Agenda helper view: games with Brighton players on each side
-- ---------------------------------------------------------------------------

create or replace view public.v_club_game_brighton as
select
  g.id as club_game_id,
  g.kickoff_at,
  g.status,
  g.home_team_id,
  g.away_team_id,
  coalesce(
    (
      select jsonb_agg(jsonb_build_object(
        'player_id', p.id,
        'name', coalesce(nullif(p.short_name, ''), p.name),
        'full_name', p.name,
        'side', 'home'
      ) order by p.name)
      from public.club_player_affiliations a
      join public.players p on p.id = a.player_id
      where a.active and a.club_team_id = g.home_team_id
    ),
    '[]'::jsonb
  ) as home_brighton_players,
  coalesce(
    (
      select jsonb_agg(jsonb_build_object(
        'player_id', p.id,
        'name', coalesce(nullif(p.short_name, ''), p.name),
        'full_name', p.name,
        'side', 'away'
      ) order by p.name)
      from public.club_player_affiliations a
      join public.players p on p.id = a.player_id
      where a.active and a.club_team_id = g.away_team_id
    ),
    '[]'::jsonb
  ) as away_brighton_players,
  (
    select count(distinct a.player_id)::int
    from public.club_player_affiliations a
    where a.active
      and a.club_team_id in (g.home_team_id, g.away_team_id)
  ) as brighton_player_count,
  (
    exists (
      select 1 from public.club_player_affiliations a
      where a.active and a.club_team_id = g.home_team_id
    )
    and exists (
      select 1 from public.club_player_affiliations a
      where a.active and a.club_team_id = g.away_team_id
    )
  ) as brighton_both_sides
from public.club_games g;

grant select on public.v_club_game_brighton to authenticated;

-- ---------------------------------------------------------------------------
-- Sync worker registration + kick (pg_net / pg_cron when available)
-- ---------------------------------------------------------------------------

create or replace function public.club_register_sync_worker(p_url text, p_secret text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.club_settings
  set
    sync_worker_url = nullif(btrim(p_url), ''),
    sync_cron_secret = coalesce(nullif(btrim(p_secret), ''), sync_cron_secret),
    updated_at = now()
  where id;
  return jsonb_build_object('ok', true, 'url', (select sync_worker_url from public.club_settings where id));
end;
$$;

create or replace function public.club_sources_due()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.club_schedule_sources
    where enabled
      and provider <> 'manual'
      and (next_check_at is null or next_check_at <= now())
  );
$$;

create or replace function public.club_kick_sync()
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_url text;
  v_secret text;
  v_headers jsonb;
begin
  select sync_worker_url, sync_cron_secret into v_url, v_secret
  from public.club_settings where id;
  if v_url is null or not public.club_sources_due() then
    return;
  end if;
  v_headers := '{"Content-Type":"application/json"}'::jsonb;
  if v_secret is not null and v_secret <> '' then
    v_headers := v_headers || jsonb_build_object('Authorization', 'Bearer ' || v_secret);
  end if;
  begin
    perform net.http_post(
      url := v_url,
      body := jsonb_build_object('source', 'cron', 'due_only', true),
      headers := v_headers,
      timeout_milliseconds := 55000
    );
  exception
    when undefined_function then
      null;
    when others then
      null;
  end;
end;
$$;

do $$
begin
  create extension if not exists pg_net with schema extensions;
exception when others then
  raise notice 'pg_net not available: %', sqlerrm;
end;
$$;

do $$
begin
  create extension if not exists pg_cron with schema pg_catalog;
exception when others then
  raise notice 'pg_cron not available: %', sqlerrm;
end;
$$;

do $cron_unschedule$
begin
  perform cron.unschedule('club-sync-worker');
exception when others then
  null;
end;
$cron_unschedule$;

do $cron_schedule$
begin
  perform cron.schedule(
    'club-sync-worker',
    '0 */6 * * *',
    $job$select public.club_kick_sync()$job$
  );
exception when others then
  raise notice 'club-sync-worker cron not scheduled: %', sqlerrm;
end;
$cron_schedule$;

-- ---------------------------------------------------------------------------
-- RLS (match shot tracker: authenticated full access; PIN is client gate)
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'club_settings', 'club_teams', 'club_player_affiliations', 'club_competitions',
    'club_team_competitions', 'club_schedule_sources', 'club_facilities', 'club_fields',
    'club_games', 'club_game_source_links', 'club_sync_runs', 'club_game_changes',
    'club_itineraries', 'club_itinerary_stops'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists club_select on public.%I', t);
    execute format('drop policy if exists club_insert on public.%I', t);
    execute format('drop policy if exists club_update on public.%I', t);
    execute format('drop policy if exists club_delete on public.%I', t);
    execute format('create policy club_select on public.%I for select to authenticated using (true)', t);
    execute format('create policy club_insert on public.%I for insert to authenticated with check (true)', t);
    execute format('create policy club_update on public.%I for update to authenticated using (true) with check (true)', t);
    execute format('create policy club_delete on public.%I for delete to authenticated using (true)', t);
  end loop;
end;
$$;

grant select, insert, update, delete on
  public.club_settings, public.club_teams, public.club_player_affiliations,
  public.club_competitions, public.club_team_competitions, public.club_schedule_sources,
  public.club_facilities, public.club_fields, public.club_games,
  public.club_game_source_links, public.club_sync_runs, public.club_game_changes,
  public.club_itineraries, public.club_itinerary_stops
to authenticated;

revoke all on
  public.club_settings, public.club_teams, public.club_player_affiliations,
  public.club_competitions, public.club_team_competitions, public.club_schedule_sources,
  public.club_facilities, public.club_fields, public.club_games,
  public.club_game_source_links, public.club_sync_runs, public.club_game_changes,
  public.club_itineraries, public.club_itinerary_stops
from anon;

revoke all on function public.club_register_sync_worker(text, text) from public, anon;
grant execute on function public.club_register_sync_worker(text, text) to authenticated, service_role;
revoke all on function public.club_kick_sync() from public, anon, authenticated;
grant execute on function public.club_kick_sync() to service_role;
revoke all on function public.club_sources_due() from public, anon, authenticated;
grant execute on function public.club_sources_due() to service_role;
