-- CFC G10 BD (Cottonwood FC, U17), season 26-27, Heros Cup.
-- Run in the Supabase SQL editor on PROD after the multi-team migration.
--
-- Safe to re-run: updates this team's branding, roster names, and game notes.
-- Matches a player by jersey on this season, and a game by date + both teams.
-- Does not touch Brighton or delete anyone who is only on PROD.
--
-- Roster copied from DEV on 2026-11-03, including placeholder jerseys (_1…)
-- and Riley N #98. Change numbers in the Games → Roster editor after load.

do $$
declare
  us uuid;
  season uuid;
  pid uuid;
  gid uuid;
  home_id uuid;
  away_id uuid;
  rec record;
  game_rec record;
begin
  insert into public.teams (
    name, is_ours, organization, org_type, level,
    brand_name, brand_sub, primary_color, accent_color, logo_path
  )
  select
    'CFC G10 BD', true, 'Cottonwood FC', 'club', 'U17',
    'CFC G10 BD', 'Cottonwood FC · U17', '#9b1b2e', '#c9a227', 'assets/logo-cfc.png'
  where not exists (
    select 1 from public.teams where is_ours and name = 'CFC G10 BD'
  );

  select id into us from public.teams where is_ours and name = 'CFC G10 BD';
  if us is null then
    raise exception 'CFC G10 BD team missing after insert';
  end if;

  update public.teams
  set
    organization = 'Cottonwood FC',
    org_type = 'club',
    level = 'U17',
    brand_name = 'CFC G10 BD',
    brand_sub = 'Cottonwood FC · U17',
    primary_color = '#9b1b2e',
    accent_color = '#c9a227',
    logo_path = 'assets/logo-cfc.png'
  where id = us;

  insert into public.seasons (year, label, team_id)
  select 2027, '26-27', us
  where not exists (
    select 1 from public.seasons where team_id = us and label = '26-27'
  );

  select id into season from public.seasons where team_id = us and label = '26-27';
  if season is null then
    raise exception '26-27 season missing for CFC G10 BD';
  end if;

  for rec in
    select * from (
      values
        ('7',  'McKenzie Di Sera',    'McKenzie', '{}'::text[]),
        ('8',  'Jane Erickson',       'Jane',     '{}'::text[]),
        ('11', 'Addison Hunt',        'Addison',  '{}'::text[]),
        ('14', 'Claire Wood',         'Claire',   '{}'::text[]),
        ('18', 'Svea Johnson',        'Svea',     '{}'::text[]),
        ('21', 'Mollie Nevenner',     'Mollie',   '{}'::text[]),
        ('23', 'Evelyn Olesen',       'Evelyn',   '{}'::text[]),
        ('98', 'Riley N',             'Riley',    array['OB']::text[]),
        ('_1', 'Andrea Sun',          'Andrea',   '{}'::text[]),
        ('_2', 'Callie Healey',       'Callie',   '{}'::text[]),
        ('_3', 'Eden Morgan',         'Eden',     '{}'::text[]),
        ('_4', 'Gianna Patterson',    'Gianna',   '{}'::text[]),
        ('_5', 'Jemima Johnsen',      'Jemima',   '{}'::text[]),
        ('_6', 'Kate Daily',          'Kate',     '{}'::text[]),
        ('_7', 'Lana Ratmeyer Duwek', 'Lana',     '{}'::text[]),
        ('_8', 'Tenley Wilson',       'Tenley',   '{}'::text[]),
        ('_9', 'Vienna Holtby',       'Vienna',   '{}'::text[])
    ) as t(jersey, full_name, short_name, groups)
  loop
    select r.player_id into pid
    from public.rosters r
    where r.team_id = us
      and r.season_id = season
      and r.jersey_number = rec.jersey;

    if pid is null then
      insert into public.players (name, short_name, position_groups)
      values (rec.full_name, rec.short_name, rec.groups)
      returning id into pid;

      insert into public.rosters (team_id, season_id, player_id, jersey_number, squad)
      values (us, season, pid, rec.jersey, 'varsity');
    else
      update public.players
      set
        name = rec.full_name,
        short_name = rec.short_name,
        position_groups = rec.groups
      where id = pid;
    end if;
  end loop;

  for game_rec in
    select * from (
      values
        (
          date '2026-11-05',
          'Peak SC 2011G TH',
          'CFC G10 BD',
          'Heros Cup — Mesquite Regional Sports and Event Complex, Field 2, 8:10 PM (Group A2 vs A3)'
        ),
        (
          date '2026-11-06',
          'Utah Rio FC U16G DH',
          'CFC G10 BD',
          'Heros Cup — Mesquite Regional Sports and Event Complex, Field 4, 1:50 PM (Group A1 vs A3)'
        ),
        (
          date '2026-11-06',
          'CFC G10 BD',
          'VIPERS N1 10/11G-CB',
          'Heros Cup — Mesquite Regional Sports and Event Complex, Field 5, 7:10 PM (Group A3 vs A4)'
        )
    ) as t(game_date, home_name, away_name, note_body)
  loop
    if game_rec.home_name = 'CFC G10 BD' then
      home_id := us;
    else
      insert into public.teams (name, is_ours, owner_team_id)
      select game_rec.home_name, false, us
      where not exists (
        select 1 from public.teams
        where owner_team_id = us and name = game_rec.home_name
      );
      select id into home_id
      from public.teams
      where owner_team_id = us and name = game_rec.home_name;
    end if;

    if game_rec.away_name = 'CFC G10 BD' then
      away_id := us;
    else
      insert into public.teams (name, is_ours, owner_team_id)
      select game_rec.away_name, false, us
      where not exists (
        select 1 from public.teams
        where owner_team_id = us and name = game_rec.away_name
      );
      select id into away_id
      from public.teams
      where owner_team_id = us and name = game_rec.away_name;
    end if;

    select g.id into gid
    from public.games g
    where g.season_id = season
      and g.date = game_rec.game_date
      and g.home_team_id = home_id
      and g.away_team_id = away_id;

    if gid is null then
      insert into public.games (
        season_id, date, game_type, competition_name, status,
        home_team_id, away_team_id, our_team_id
      )
      values (
        season, game_rec.game_date, 'tournament', 'Heros Cup', 'live',
        home_id, away_id, us
      )
      returning id into gid;
    else
      update public.games
      set
        game_type = 'tournament',
        competition_name = 'Heros Cup',
        our_team_id = us
      where id = gid;
    end if;

    insert into public.notes (game_id, body)
    select gid, game_rec.note_body
    where not exists (
      select 1 from public.notes n
      where n.game_id = gid and n.body = game_rec.note_body
    );
  end loop;

  raise notice 'CFC G10 BD 26-27 loaded: roster + Heros Cup games';
end $$;
