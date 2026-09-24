-- Preview / local seed. Cartoon franchise only — never copy production data here.
-- Supabase Preview Branches run this file once after migrations (see config.toml [db.seed]).
--
-- Built from the DEV project's intentional sandbox games (2099-03-01 .. 2099-04-05),
-- not the hundreds of e2e friendlies that also live on DEV.
-- 58 shots across 6 games. Baseline migration already inserts Brighton + Olympus
-- + a 2026 Fall roster; this seed renames the home side to Medville Marauders.

do $$
declare
  marauders uuid;
  season uuid;
  team_id uuid;
  rec record;
  pid uuid;
  gid uuid;
  shot_team uuid;
  assist_id uuid;
  second_id uuid;
  fouler_id uuid;
  other_team uuid;
begin
  update public.teams
  set name = 'Medville Marauders'
  where is_brighton
    and name is distinct from 'Medville Marauders';

  select id into marauders from public.teams where is_brighton limit 1;
  if marauders is null then
    raise exception 'Home team (is_brighton) missing — run migrations first';
  end if;

  insert into public.seasons (year, label)
  values (2099, 'DEV Sandbox')
  on conflict (label) do nothing;
  select id into season from public.seasons where label = 'DEV Sandbox';

  insert into public.teams (name, is_brighton)
  values
    ('Rivertown Rivals', false),
    ('Cedar Comets', false),
    ('Bogwater Badgers', false)
  on conflict (name) do nothing;

  if exists (
    select 1 from public.games
    where season_id = season and date = '2099-03-01'
  ) then
    raise notice 'DEV Sandbox games already present — skip seed';
    return;
  end if;

  for rec in
    select * from (
      values
      ('1', 'Captain Waffles', 'Waffles', ARRAY['GK']::text[]),
      ('00', 'Sprocket Pancake', 'Sprocket', ARRAY['GK']::text[]),
      ('2', 'Maple Syrupson', 'Maple', ARRAY['OB']::text[]),
      ('5', 'Biscuit Flanagan', 'Biscuit', ARRAY['OB']::text[]),
      ('3', 'Boulder Crumbs', 'Boulder', ARRAY['CB']::text[]),
      ('4', 'Beetlejuice Carver', 'Beetle', ARRAY['CB']::text[]),
      ('6', 'Cosmo Driftwood', 'Cosmo', ARRAY['MID']::text[]),
      ('7', 'Nimbus Puddlejump', 'Nimbus', ARRAY['MID']::text[]),
      ('8', 'Ziggy Thunderfoot', 'Ziggy', ARRAY['MID']::text[]),
      ('12', 'Twinkle Toaster', 'Twinkle', ARRAY['MID']::text[]),
      ('9', 'Pippa "Pip" McNoodle', 'Pip', ARRAY['FWD']::text[]),
      ('10', 'Nova Sparkles', 'Nova', ARRAY['FWD']::text[]),
      ('11', 'Pixel Vanderguard', 'Pixel', ARRAY['MID','FWD']::text[]),
      ('14', 'Pretzel Moonbeam', 'Pretzel', ARRAY['FWD']::text[])
    ) as t(jersey, full_name, short_name, groups)
  loop
    insert into public.players (name, short_name, position_groups)
    values (rec.full_name, rec.short_name, rec.groups)
    returning id into pid;
    insert into public.rosters (team_id, season_id, player_id, jersey_number, squad)
    values (marauders, season, pid, rec.jersey, 'varsity')
    on conflict (team_id, season_id, jersey_number) do nothing;
  end loop;

  select id into team_id from public.teams where name = 'Bogwater Badgers';
  for rec in
    select * from (
      values
      ('1', 'Bramble Moss', 'Bramble', ARRAY['GK']::text[]),
      ('00', 'Puddle Finn', 'Puddle', ARRAY['GK']::text[]),
      ('2', 'Cattail Wren', 'Cattail', ARRAY['OB']::text[]),
      ('5', 'Mudskipper Jones', 'Mudskipper', ARRAY['OB']::text[]),
      ('3', 'Bog Myrtle', 'Myrtle', ARRAY['CB']::text[]),
      ('4', 'Silt Hammer', 'Silt', ARRAY['CB']::text[]),
      ('6', 'Peat Brickley', 'Peat', ARRAY['CB']::text[]),
      ('8', 'Fen Whisper', 'Fen', ARRAY['MID']::text[]),
      ('10', 'Reed Canary', 'Reed', ARRAY['MID']::text[]),
      ('14', 'Moss Paget', 'Moss', ARRAY['MID']::text[]),
      ('16', 'Duckweed Lane', 'Duckweed', ARRAY['MID']::text[]),
      ('7', 'Marsh Pike', 'Marsh', ARRAY['FWD']::text[]),
      ('9', 'Bracken Vale', 'Bracken', ARRAY['FWD']::text[]),
      ('11', 'Toadstool Quinn', 'Toad', ARRAY['FWD']::text[]),
      ('17', 'Lily Padgett', 'Lily', ARRAY['FWD']::text[]),
      ('21', 'Newt Gallagher', 'Newt', ARRAY['FWD']::text[])
    ) as t(jersey, full_name, short_name, groups)
  loop
    insert into public.players (name, short_name, position_groups)
    values (rec.full_name, rec.short_name, rec.groups)
    returning id into pid;
    insert into public.rosters (team_id, season_id, player_id, jersey_number, squad)
    values (team_id, season, pid, rec.jersey, 'varsity')
    on conflict (team_id, season_id, jersey_number) do nothing;
  end loop;

  select id into team_id from public.teams where name = 'Rivertown Rivals';
  for rec in
    select * from (
      values
      ('9', 'Rival Robot #9', 'R9', ARRAY[]::text[])
    ) as t(jersey, full_name, short_name, groups)
  loop
    insert into public.players (name, short_name, position_groups)
    values (rec.full_name, rec.short_name, rec.groups)
    returning id into pid;
    insert into public.rosters (team_id, season_id, player_id, jersey_number, squad)
    values (team_id, season, pid, rec.jersey, 'varsity')
    on conflict (team_id, season_id, jersey_number) do nothing;
  end loop;

  select id into team_id from public.teams where name = 'Cedar Comets';
  for rec in
    select * from (
      values
      ('1', 'Comet Keeper', 'Keeper', ARRAY['GK']::text[]),
      ('3', 'Comet Kid Three', 'C3', ARRAY['CB']::text[]),
      ('10', 'Comet Kid', 'Comet', ARRAY['FWD']::text[])
    ) as t(jersey, full_name, short_name, groups)
  loop
    insert into public.players (name, short_name, position_groups)
    values (rec.full_name, rec.short_name, rec.groups)
    returning id into pid;
    insert into public.rosters (team_id, season_id, player_id, jersey_number, squad)
    values (team_id, season, pid, rec.jersey, 'varsity')
    on conflict (team_id, season_id, jersey_number) do nothing;
  end loop;

  for rec in
    select * from (
      values
      ('2099-03-01', 'preseason', 'preseason', 'down', 'Medville Marauders', 'Rivertown Rivals'),
      ('2099-03-08', 'region', 'official', 'down', 'Medville Marauders', 'Cedar Comets'),
      ('2099-03-15', 'region', 'official', 'down', 'Bogwater Badgers', 'Medville Marauders'),
      ('2099-03-22', 'friendly', 'friendly', null, 'Medville Marauders', 'Rivertown Rivals'),
      ('2099-03-29', 'region', 'official', null, 'Medville Marauders', 'Bogwater Badgers'),
      ('2099-04-05', 'playoffs', 'official', 'down', 'Bogwater Badgers', 'Medville Marauders')
    ) as t(gdate, gtype, scope, clock, home, away)
  loop
    insert into public.games (
      season_id, date, game_type, stat_scope, clock_direction,
      clock_half_length_sec, clock_et_length_sec, status,
      home_team_id, away_team_id, our_team_id
    )
    select
      season,
      rec.gdate,
      rec.gtype,
      rec.scope,
      rec.clock,
      2400,
      600,
      'live',
      h.id,
      a.id,
      marauders
    from public.teams h, public.teams a
    where h.name = rec.home and a.name = rec.away;
  end loop;

  for rec in
    select * from (
      values
      ('2099-03-01', 'Medville Marauders', 'Rivertown Rivals', 'Medville Marauders', '1', '9', 'CF', 34, 11, 'C-PS', 'Box · Center', 'goal', null, null, '11', 'cross', 'LW', 8, 20, null, null, null, null, null, null, null, null, null, null),
      ('2099-03-01', 'Medville Marauders', 'Rivertown Rivals', 'Medville Marauders', '1', '10', 'CF', 38, 14, 'RHS-PS', 'Box · Right half-space', 'on-target', null, null, '8', 'pass', 'CM', 30, 28, null, null, null, null, null, null, null, null, null, null),
      ('2099-03-01', 'Medville Marauders', 'Rivertown Rivals', 'Rivertown Rivals', '2', '9', null, 32, 12, 'C-PS', 'Box · Center', 'blocked', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null),
      ('2099-03-01', 'Medville Marauders', 'Rivertown Rivals', 'Medville Marauders', '2', '11', 'RW', 55, 16, 'RW-BOX', 'Box · Right wide', 'missed', 'over', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null),
      ('2099-03-08', 'Medville Marauders', 'Cedar Comets', 'Medville Marauders', '1', '10', 'LW', 10, 13, 'LW-BOX', 'Box · Left wide', 'goal', null, null, '4', 'pass', 'LCB', 20, 40, null, null, null, null, null, null, null, null, null, null),
      ('2099-03-08', 'Medville Marauders', 'Cedar Comets', 'Medville Marauders', '1', '2', 'LB', 12, 35, 'LB-CH', 'Channel · Left', 'blocked', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null),
      ('2099-03-08', 'Medville Marauders', 'Cedar Comets', 'Medville Marauders', '1', '6', 'LM', 14.3, 8.7, 'LW-PS', 'Box · Left wide', 'blocked', null, null, '11', 'cross', 'LW', 64.5, 13, 'RW-BOX', 'Right wide · Penalty area', null, null, null, null, null, null, null, 1060),
      ('2099-03-08', 'Medville Marauders', 'Cedar Comets', 'Cedar Comets', '1', '3', null, 22.9, 24.7, 'LHS-D', 'Left half-space · Top of the box', 'missed', 'wide-right', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 1060),
      ('2099-03-08', 'Medville Marauders', 'Cedar Comets', 'Medville Marauders', '1', '10', 'CF', 28.3, 4, 'C-6Y', 'Six-yard box · Center', 'goal', null, null, '9', 'cross', 'RW', 56.4, 3.6, 'RW-6Y', 'Right wide · Six-yard', '5', 'pass', 'LCB', 49.4, 32.3, 'RHS-AT', 'Right half-space · Attacking third', 1060),
      ('2099-03-08', 'Medville Marauders', 'Cedar Comets', 'Medville Marauders', '1', '9', 'CF', 34.5, 18, 'C-D', 'Zone 14', 'on-target', null, null, '6', 'gap', 'CM', 34, 30, null, null, null, null, null, null, null, null, null, null),
      ('2099-03-08', 'Medville Marauders', 'Cedar Comets', 'Cedar Comets', '1', '1', null, 43.8, 7.1, 'RHS-PS', 'Box · Right half-space', 'goal', null, null, null, 'pass', null, 45.5, 29.2, 'RHS-AT', 'Right half-space · Attacking third', null, null, null, null, null, null, null, 1060),
      ('2099-03-08', 'Medville Marauders', 'Cedar Comets', 'Cedar Comets', '2', '10', null, 28, 15, 'C-PS', 'Box · Center', 'on-target', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null),
      ('2099-03-08', 'Medville Marauders', 'Cedar Comets', 'Medville Marauders', '2', '10', 'CF', 30, 9, 'C-PS', 'Box · Center', 'missed', 'wide-left', null, '11', 'cross', 'RW', 58, 18, null, null, null, null, null, null, null, null, null, null),
      ('2099-03-08', 'Medville Marauders', 'Cedar Comets', 'Medville Marauders', '2', '8', 'CM', 36, 22, 'C-D', 'Zone 14', 'corner', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null),
      ('2099-03-08', 'Medville Marauders', 'Cedar Comets', 'Cedar Comets', '2', '10', null, 40, 11, 'RHS-PS', 'Box · Right half-space', 'goal', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null),
      ('2099-03-15', 'Bogwater Badgers', 'Medville Marauders', 'Medville Marauders', '1', null, 'CF', 18.1, 21.3, 'LHS-D', 'Left half-space · Top of the box', 'on-target', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null),
      ('2099-03-15', 'Bogwater Badgers', 'Medville Marauders', 'Medville Marauders', '1', '9', 'CF', 33, 10.5, 'C-PS', 'Box · Center', 'pk-goal', null, '10', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null),
      ('2099-03-15', 'Bogwater Badgers', 'Medville Marauders', 'Medville Marauders', '1', '6', 'CM', 34, 24, 'C-D', 'Zone 14', 'foul', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null),
      ('2099-03-15', 'Bogwater Badgers', 'Medville Marauders', 'Medville Marauders', '1', '10', 'CF', 40.9, 6.4, 'C-PS', 'Box · Center', 'on-target', null, null, '11', 'pass', 'LW', 21.3, 13.7, 'LHS-BOX', 'Box · Left half-space', '9', 'cross', 'RW', 51.6, 12.1, 'RHS-BOX', 'Box · Right half-space', null),
      ('2099-03-15', 'Bogwater Badgers', 'Medville Marauders', 'Medville Marauders', '1', '8', 'RM', 44.8, 8.1, 'RHS-PS', 'Box · Right half-space', 'missed', 'over', null, '11', 'cross', 'LW', 5, 7.4, 'LW-PS', 'Left wide · Penalty-spot line', null, null, null, null, null, null, null, null),
      ('2099-03-15', 'Bogwater Badgers', 'Medville Marauders', 'Medville Marauders', '2', '10', 'LW', 14, 12, 'LW-BOX', 'Box · Left wide', 'goal', null, null, '2', 'cross', 'LB', 6, 22, null, null, null, null, null, null, null, null, null, null),
      ('2099-03-15', 'Bogwater Badgers', 'Medville Marauders', 'Bogwater Badgers', '2', '2', null, 24, 7.3, 'LHS-PS', 'Box · Left half-space', 'blocked', null, null, null, 'pass', null, 52.2, 20.5, 'RHS-D', 'Right half-space · Top of the box', null, null, null, null, null, null, null, 830),
      ('2099-03-15', 'Bogwater Badgers', 'Medville Marauders', 'Bogwater Badgers', '2', '7', null, 36, 13, 'C-PS', 'Box · Center', 'missed', 'over', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null),
      ('2099-03-15', 'Bogwater Badgers', 'Medville Marauders', 'Bogwater Badgers', '2', '5', null, 48.5, 14.2, 'RHS-BOX', 'Box · Right half-space', 'on-target', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 830),
      ('2099-03-15', 'Bogwater Badgers', 'Medville Marauders', 'Medville Marauders', '2', '11', 'RW', 52, 20, 'RW-CH', 'Channel · Right', 'missed', 'short', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null),
      ('2099-03-22', 'Medville Marauders', 'Rivertown Rivals', 'Medville Marauders', '1', '10', 'CF', 34, 12, 'C-PS', 'Box · Center', 'goal', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null),
      ('2099-03-22', 'Medville Marauders', 'Rivertown Rivals', 'Medville Marauders', '1', '9', 'CF', 40, 16, 'RHS-PS', 'Box · Right half-space', 'on-target', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null),
      ('2099-03-22', 'Medville Marauders', 'Rivertown Rivals', 'Rivertown Rivals', '2', '9', null, 30, 14, 'C-PS', 'Box · Center', 'blocked', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null),
      ('2099-04-05', 'Bogwater Badgers', 'Medville Marauders', 'Bogwater Badgers', '1', '6', 'LCB', 15.1, 33.9, 'LHS-AT', 'Left half-space · Attacking third', 'blocked', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 2181),
      ('2099-04-05', 'Bogwater Badgers', 'Medville Marauders', 'Medville Marauders', '1', '10', 'CF', 18.7, 21.3, 'LHS-D', 'Left half-space · Top of the box', 'missed', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 1646),
      ('2099-04-05', 'Bogwater Badgers', 'Medville Marauders', 'Bogwater Badgers', '1', '10', 'DM', 25.3, 3.8, 'LHS-6Y', 'Six-yard box · Left half-space', 'missed', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 2280),
      ('2099-04-05', 'Bogwater Badgers', 'Medville Marauders', 'Bogwater Badgers', '1', '9', 'CF', 34, 36, 'C-HALF', 'Center · Toward halfway', 'missed', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 358),
      ('2099-04-05', 'Bogwater Badgers', 'Medville Marauders', 'Medville Marauders', '1', '9', 'RW', 38.7, 1.3, 'C-6Y', 'Six-yard box · Center', 'goal', null, null, '5', 'cross', 'RB', 25.3, 1.3, 'LHS-6Y', 'Six-yard box · Left half-space', null, null, null, null, null, null, null, 1371),
      ('2099-04-05', 'Bogwater Badgers', 'Medville Marauders', 'Bogwater Badgers', '1', '9', 'CF', 39.2, 20.9, 'C-D', 'Zone 14', 'missed', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 1448),
      ('2099-04-05', 'Bogwater Badgers', 'Medville Marauders', 'Bogwater Badgers', '1', '21', 'CF', 40.6, 18.8, 'C-D', 'Zone 14', 'blocked', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 2271),
      ('2099-04-05', 'Bogwater Badgers', 'Medville Marauders', 'Medville Marauders', '1', '6', 'LM', 41.4, 24.5, 'C-D', 'Zone 14', 'missed', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 246),
      ('2099-04-05', 'Bogwater Badgers', 'Medville Marauders', 'Bogwater Badgers', '1', '14', 'RM', 44.7, 16.6, 'RHS-D', 'Right half-space · Top of the box', 'missed', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 442),
      ('2099-04-05', 'Bogwater Badgers', 'Medville Marauders', 'Bogwater Badgers', '1', '7', 'RW', 44.8, 20.6, 'RHS-D', 'Right half-space · Top of the box', 'on-target', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 180),
      ('2099-04-05', 'Bogwater Badgers', 'Medville Marauders', 'Medville Marauders', '1', '9', 'RW', 49, 26.3, 'RHS-AT', 'Right half-space · Attacking third', 'missed', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 2078),
      ('2099-04-05', 'Bogwater Badgers', 'Medville Marauders', 'Medville Marauders', '1', '11', 'LW', 52.7, 24.5, 'RHS-D', 'Right half-space · Top of the box', 'missed', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 874),
      ('2099-04-05', 'Bogwater Badgers', 'Medville Marauders', 'Bogwater Badgers', '2', '14', 'RM', 18.6, 8.9, 'LHS-PS', 'Box · Left half-space', 'missed', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 1811),
      ('2099-04-05', 'Bogwater Badgers', 'Medville Marauders', 'Bogwater Badgers', '2', '10', 'DM', 25.9, 14, 'C-BOX', 'Box · Center', 'on-target', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 1708),
      ('2099-04-05', 'Bogwater Badgers', 'Medville Marauders', 'Medville Marauders', '2', '9', 'RW', 29.9, 2.4, 'C-6Y', 'Six-yard box · Center', 'on-target', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 1603),
      ('2099-04-05', 'Bogwater Badgers', 'Medville Marauders', 'Medville Marauders', '2', '9', 'RW', 30.4, 0.2, 'C-6Y', 'Six-yard box · Center', 'on-target', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 1608),
      ('2099-04-05', 'Bogwater Badgers', 'Medville Marauders', 'Medville Marauders', '2', '8', 'RM', 30.7, 31.7, 'C-AT', 'Center · Attacking third', 'missed', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 2238),
      ('2099-04-05', 'Bogwater Badgers', 'Medville Marauders', 'Medville Marauders', '2', '7', 'DM', 33.6, 29, 'C-AT', 'Center · Attacking third', 'missed', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 2340),
      ('2099-04-05', 'Bogwater Badgers', 'Medville Marauders', 'Bogwater Badgers', '2', '8', 'LM', 40.2, 28.8, 'C-AT', 'Center · Attacking third', 'missed', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 120),
      ('2099-04-05', 'Bogwater Badgers', 'Medville Marauders', 'Bogwater Badgers', '2', '7', 'RW', 41.8, 21.1, 'C-D', 'Zone 14', 'missed', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 1017),
      ('2099-04-05', 'Bogwater Badgers', 'Medville Marauders', 'Medville Marauders', '2', '14', 'CF', 43.1, 8.6, 'RHS-PS', 'Box · Right half-space', 'missed', null, null, '10', 'pass', 'CF', 30.5, 14.5, 'C-BOX', 'Box · Center', null, null, null, null, null, null, null, 1258),
      ('2099-04-05', 'Bogwater Badgers', 'Medville Marauders', 'Bogwater Badgers', '2', '7', 'RW', 43.4, 29.2, 'RHS-AT', 'Right half-space · Attacking third', 'goal', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 2292),
      ('2099-04-05', 'Bogwater Badgers', 'Medville Marauders', 'Bogwater Badgers', 'ET1', '9', 'CF', 25, 5.4, 'LHS-6Y', 'Six-yard box · Left half-space', 'missed', null, null, '11', 'cross', 'LW', 66.7, 1.2, 'RW-6Y', 'Right wide · Six-yard', null, null, null, null, null, null, null, 295),
      ('2099-04-05', 'Bogwater Badgers', 'Medville Marauders', 'Bogwater Badgers', 'ET1', '14', 'RM', 27, 12.9, 'C-BOX', 'Box · Center', 'missed', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 181),
      ('2099-04-05', 'Bogwater Badgers', 'Medville Marauders', 'Medville Marauders', 'ET1', '10', 'CF', 34.8, 21, 'C-D', 'Zone 14', 'blocked', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 326),
      ('2099-04-05', 'Bogwater Badgers', 'Medville Marauders', 'Medville Marauders', 'ET1', '10', 'CF', 35.8, 27.5, 'C-AT', 'Center · Attacking third', 'blocked', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 173),
      ('2099-04-05', 'Bogwater Badgers', 'Medville Marauders', 'Medville Marauders', 'ET1', '6', 'LM', 40.7, 30.7, 'C-AT', 'Center · Attacking third', 'on-target', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 540),
      ('2099-04-05', 'Bogwater Badgers', 'Medville Marauders', 'Bogwater Badgers', 'ET1', '16', 'DM', 45.4, 18, 'RHS-D', 'Right half-space · Top of the box', 'missed', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 417),
      ('2099-04-05', 'Bogwater Badgers', 'Medville Marauders', 'Bogwater Badgers', 'ET1', '14', 'RM', 46.8, 12.9, 'RHS-BOX', 'Box · Right half-space', 'on-target', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 60),
      ('2099-04-05', 'Bogwater Badgers', 'Medville Marauders', 'Bogwater Badgers', 'ET2', '9', 'CF', 45.9, 47.8, 'RHS-HALF', 'Right half-space · Toward halfway', 'goal', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 300)
    ) as t(
      gdate, home, away, team_name, period,
      jersey, pos, shot_x, shot_y,
      zone_id, zone_label, result, miss_direction,
      fouler_jersey, assist_jersey, assist_type, assist_position,
      assist_x, assist_y, assist_zone_id, assist_zone_label,
      second_assist_jersey, second_assist_type, second_assist_position,
      second_assist_x, second_assist_y,
      second_assist_zone_id, second_assist_zone_label,
      game_clock_seconds
    )
  loop
    pid := null;
    assist_id := null;
    second_id := null;
    fouler_id := null;
    other_team := null;
    gid := null;
    shot_team := null;

    select g.id into gid
    from public.games g
    join public.teams h on h.id = g.home_team_id
    join public.teams a on a.id = g.away_team_id
    where g.season_id = season
      and g.date = rec.gdate
      and h.name = rec.home
      and a.name = rec.away;

    select id into shot_team from public.teams where name = rec.team_name;

    select r.player_id into pid
    from public.rosters r
    where rec.jersey is not null
      and r.season_id = season and r.team_id = shot_team and r.jersey_number = rec.jersey;

    select r.player_id into assist_id
    from public.rosters r
    where rec.assist_jersey is not null
      and r.season_id = season and r.team_id = shot_team and r.jersey_number = rec.assist_jersey;

    select r.player_id into second_id
    from public.rosters r
    where rec.second_assist_jersey is not null
      and r.season_id = season and r.team_id = shot_team and r.jersey_number = rec.second_assist_jersey;

    select case when g.home_team_id = shot_team then g.away_team_id else g.home_team_id end
      into other_team
    from public.games g where g.id = gid;

    select r.player_id into fouler_id
    from public.rosters r
    where rec.fouler_jersey is not null
      and r.season_id = season and r.team_id = other_team and r.jersey_number = rec.fouler_jersey;

    insert into public.shots (
      game_id, period, team_id, player_id, jersey_number_at_time, position,
      x, y, zone_id, zone_label, result, miss_direction,
      fouler_player_id, fouler_jersey_number_at_time,
      assist_player_id, assist_type, assist_position, assist_x, assist_y,
      assist_zone_id, assist_zone_label,
      second_assist_player_id, second_assist_type, second_assist_position,
      second_assist_x, second_assist_y, second_assist_zone_id, second_assist_zone_label,
      game_clock_seconds
    ) values (
      gid, rec.period, shot_team, pid, rec.jersey, rec.pos,
      rec.shot_x, rec.shot_y, rec.zone_id, rec.zone_label, rec.result, rec.miss_direction,
      fouler_id, rec.fouler_jersey,
      assist_id, rec.assist_type, rec.assist_position, rec.assist_x, rec.assist_y,
      rec.assist_zone_id, rec.assist_zone_label,
      second_id, rec.second_assist_type, rec.second_assist_position,
      rec.second_assist_x, rec.second_assist_y, rec.second_assist_zone_id, rec.second_assist_zone_label,
      rec.game_clock_seconds
    );
  end loop;

  insert into public.notes (game_id, body, author_label)
  select g.id, 'when they switch to back 3 it opens up corners for our attack', 'AJ'
  from public.games g
  join public.teams h on h.id = g.home_team_id
  where g.season_id = season and g.date = '2099-04-05' and h.name = 'Bogwater Badgers';

  insert into public.note_tags (note_id, tag)
  select n.id, 'duckweed'
  from public.notes n
  join public.games g on g.id = n.game_id
  where g.season_id = season and g.date = '2099-04-05' and n.body like 'when they switch%';

  raise notice 'Seeded DEV Sandbox: 6 games, 58 shots';
end;
$$;
