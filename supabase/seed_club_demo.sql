-- Demo club visitation data for DEV only.
-- Safe to re-run: uses fixed demo UUIDs and upserts.
-- Does NOT overwrite production HS shot data.
-- Club players are their own rows. A shot-tracker link is added only when a public.players row has the same name.

-- Facilities
insert into public.club_facilities (id, name, street_address, city, state, postal_code, latitude, longitude, aliases, geocode_status, maps_url)
values
  ('a1000000-0000-4000-8000-000000000001', 'Regional Athletic Complex', '12300 S 3600 W', 'South Jordan', 'UT', '84095', 40.5285, -111.9802, array['RAC','R.A.C.'], 'manual', 'https://maps.google.com/?q=40.5285,-111.9802'),
  ('a1000000-0000-4000-8000-000000000002', 'Layton Commons', '2450 N Fairfield Rd', 'Layton', 'UT', '84041', 41.0892, -111.9715, array['Layton'], 'manual', 'https://maps.google.com/?q=41.0892,-111.9715')
on conflict (id) do update set
  name = excluded.name,
  latitude = excluded.latitude,
  longitude = excluded.longitude,
  aliases = excluded.aliases;

insert into public.club_fields (id, club_facility_id, label)
values
  ('a2000000-0000-4000-8000-000000000005', 'a1000000-0000-4000-8000-000000000001', 'Field 5'),
  ('a2000000-0000-4000-8000-000000000007', 'a1000000-0000-4000-8000-000000000001', 'Field 7'),
  ('a2000000-0000-4000-8000-000000000011', 'a1000000-0000-4000-8000-000000000002', 'Field 1')
on conflict (id) do nothing;

-- Teams (Brighton-affiliated + opponents)
insert into public.club_teams (id, organization_name, team_name, age_group, aliases)
values
  ('b1000000-0000-4000-8000-00000000000a', 'Utah Avalanche', 'Avalanche 09G Navy', 'U17', array['Avalanche Navy']),
  ('b1000000-0000-4000-8000-00000000000b', 'La Roca', 'La Roca 09G Elite', 'U17', array['La Roca Elite']),
  ('b1000000-0000-4000-8000-00000000000c', 'Wasatch SC', 'Wasatch 09G Orange', 'U17', array[]::text[]),
  ('b1000000-0000-4000-8000-00000000000d', 'Olympus Club', 'Olympus 09G Black', 'U17', array[]::text[])
on conflict (id) do update set team_name = excluded.team_name, aliases = excluded.aliases;

-- Club players, then an optional link when a shot-tracker player has the same name.
insert into public.club_players (name, short_name)
select v.name, v.short_name
from (values
  ('Jaqueline Scott', 'Jackie'),
  ('Jane Thackeray', 'Jane'),
  ('Saige Thurgood', 'Saige'),
  ('Stella Bollinger', 'Stella')
) as v(name, short_name)
where not exists (
  select 1 from public.club_players cp where cp.name = v.name
);

insert into public.club_player_links (player_id, club_player_id)
select p.id, cp.id
from (values
  ('Jaqueline Scott'),
  ('Jane Thackeray'),
  ('Saige Thurgood'),
  ('Stella Bollinger')
) as v(name)
join public.players p on p.name = v.name
join public.club_players cp on cp.name = v.name
where not exists (
  select 1 from public.club_player_links l
  where l.player_id = p.id or l.club_player_id = cp.id
);

insert into public.club_player_affiliations (club_player_id, club_team_id, active, season_label)
select cp.id, x.team_id, true, '2026 Spring Club'
from (values
  ('Jaqueline Scott', 'b1000000-0000-4000-8000-00000000000a'::uuid),
  ('Jane Thackeray', 'b1000000-0000-4000-8000-00000000000a'::uuid),
  ('Saige Thurgood', 'b1000000-0000-4000-8000-00000000000b'::uuid),
  ('Stella Bollinger', 'b1000000-0000-4000-8000-00000000000b'::uuid)
) as x(player_name, team_id)
join public.club_players cp on cp.name = x.player_name
where not exists (
  select 1 from public.club_player_affiliations a
  where a.club_player_id = cp.id and a.club_team_id = x.team_id and a.active
);

insert into public.club_competitions (id, name, competition_type, season_year, status)
values
  ('c1000000-0000-4000-8000-000000000001', 'URSA Spring League', 'league', 2026, 'active'),
  ('c1000000-0000-4000-8000-000000000002', 'Cottonwood Invitational', 'invitational', 2026, 'active'),
  ('c1000000-0000-4000-8000-000000000003', 'State Cup Warmup', 'tournament', 2026, 'active')
on conflict (id) do nothing;

insert into public.club_team_competitions (id, club_team_id, club_competition_id)
values
  ('d1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-000000000001'),
  ('d1000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-000000000002'),
  ('d1000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-000000000003'),
  ('d1000000-0000-4000-8000-000000000004', 'b1000000-0000-4000-8000-00000000000b', 'c1000000-0000-4000-8000-000000000001')
on conflict (club_team_id, club_competition_id) do nothing;

-- Independent schedule sources (manual for demo; sync is no-op success)
insert into public.club_schedule_sources (id, club_team_competition_id, source_url, provider, enabled, sync_status)
values
  ('e1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'manual://ursa-avalanche', 'manual', true, 'ok'),
  ('e1000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000002', 'manual://cottonwood-avalanche', 'manual', true, 'ok'),
  ('e1000000-0000-4000-8000-000000000003', 'd1000000-0000-4000-8000-000000000003', 'manual://statecup-avalanche', 'manual', true, 'ok')
on conflict (id) do nothing;

-- Upcoming demo games near late-Oct 2026 (re-run / adjust as needed for demos).
-- Avalanche (Jackie+Jane) vs Wasatch at RAC Field 5
-- La Roca (Saige+Stella) vs Olympus at RAC Field 7 same day (same facility walk)
-- Brighton-vs-Brighton: Avalanche vs La Roca at Layton
insert into public.club_games (
  id, club_competition_id, home_team_id, away_team_id, kickoff_at, kickoff_timezone, status,
  club_facility_id, club_field_id, source_attribution
)
values
  (
    'f1000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-00000000000a',
    'b1000000-0000-4000-8000-00000000000c',
    '2026-10-17 16:00:00-06',
    'America/Denver',
    'scheduled',
    'a1000000-0000-4000-8000-000000000001',
    'a2000000-0000-4000-8000-000000000005',
    'seed_club_demo'
  ),
  (
    'f1000000-0000-4000-8000-000000000002',
    'c1000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-00000000000b',
    'b1000000-0000-4000-8000-00000000000d',
    '2026-10-17 17:30:00-06',
    'America/Denver',
    'scheduled',
    'a1000000-0000-4000-8000-000000000001',
    'a2000000-0000-4000-8000-000000000007',
    'seed_club_demo'
  ),
  (
    'f1000000-0000-4000-8000-000000000003',
    'c1000000-0000-4000-8000-000000000002',
    'b1000000-0000-4000-8000-00000000000a',
    'b1000000-0000-4000-8000-00000000000b',
    '2026-10-18 10:00:00-06',
    'America/Denver',
    'scheduled',
    'a1000000-0000-4000-8000-000000000002',
    'a2000000-0000-4000-8000-000000000011',
    'seed_club_demo'
  ),
  (
    'f1000000-0000-4000-8000-000000000004',
    null,
    'b1000000-0000-4000-8000-00000000000c',
    'b1000000-0000-4000-8000-00000000000d',
    null,
    'America/Denver',
    'tbd',
    null,
    null,
    'seed_club_demo'
  )
on conflict (id) do update set
  kickoff_at = excluded.kickoff_at,
  club_facility_id = excluded.club_facility_id,
  club_field_id = excluded.club_field_id,
  status = excluded.status;
