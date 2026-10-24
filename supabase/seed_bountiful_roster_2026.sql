-- Bountiful varsity roster for 2026 Fall (PROD-safe).
-- Run in Supabase SQL editor on PROD before 2026-09-01 @ Bountiful.
--
-- Safe to re-run: updates names on existing jersey rows; skips duplicates.
-- Does NOT touch Brighton data or games.
--
-- Suggested default XI (from season GP + production; set in app lineup editor):
--   GK  00 Charli Castleberry
--   DEF 23 Izzy Kuehne, 24 Morgan Rogers, 11 Lauren Smith, 6 Sami Carter
--   MID  8 Emmy Sorensen, 12 Kayd Kupfer, 20 Kendyl Clark
--   FWD  7 Myka Page, 2 Bella Morgan, 10 Jane Hellewell
-- Likely subs: 32 Maya Wentworth, 17 Natalie Coulam, 18 Katie Croft, 5 Gabriella DeBarros

do $$
declare
  bountiful uuid;
  season uuid;
  pid uuid;
  rec record;
begin
  select id into bountiful from public.teams where name = 'Bountiful' and not is_ours limit 1;
  select id into season from public.seasons where label = '2026 Fall' limit 1;

  if bountiful is null then
    raise exception 'Bountiful team missing — run migrate_2026_varsity_schedule.sql first';
  end if;
  if season is null then
    raise exception '2026 Fall season missing — run schema/migrations first';
  end if;

  for rec in
    select * from (
      values
        -- Players with season stats (18)
        ('00', 'Charli Castleberry', 'Charli'),
        ('2',  'Bella Morgan',       'Bella'),
        ('5',  'Gabriella DeBarros', 'Gabi'),
        ('6',  'Sami Carter',        'Sami'),
        ('7',  'Myka Page',          'Myka'),
        ('8',  'Emmy Sorensen',      'Emmy'),
        ('10', 'Jane Hellewell',     'Jane'),
        ('11', 'Lauren Smith',       'Lauren'),
        ('12', 'Kayd Kupfer',        'Kayd'),
        ('15', 'Maia Palfreyman',    'Maia'),
        ('17', 'Natalie Coulam',     'Natalie'),
        ('18', 'Katie Croft',        'Katie'),
        ('20', 'Kendyl Clark',       'Kendyl'),
        ('22', 'Kelsie Nelson',      'Kelsie'),
        ('23', 'Izzy Kuehne',        'Izzy'),
        ('24', 'Morgan Rogers',      'Morgan'),
        ('25', 'Maile Murdock',      'Maile'),
        ('32', 'Maya Wentworth',     'Maya'),
        -- Backup GKs (roster only; not in offensive stats)
        ('0',  'Monroe Collet',      'Monroe'),
        ('01', 'Piper Polatis',      'Piper')
    ) as t(jersey, full_name, short_name)
  loop
    select r.player_id into pid
    from public.rosters r
    where r.team_id = bountiful
      and r.season_id = season
      and r.jersey_number = rec.jersey;

    if pid is null then
      insert into public.players (name, short_name)
      values (rec.full_name, rec.short_name)
      returning id into pid;

      insert into public.rosters (team_id, season_id, player_id, jersey_number, squad)
      values (bountiful, season, pid, rec.jersey, 'varsity')
      on conflict (team_id, season_id, jersey_number) do nothing;

      select r.player_id into pid
      from public.rosters r
      where r.team_id = bountiful
        and r.season_id = season
        and r.jersey_number = rec.jersey;
    end if;

    if pid is not null then
      update public.players
      set name = rec.full_name, short_name = rec.short_name
      where id = pid;
    end if;
  end loop;

  raise notice 'Bountiful roster loaded/updated for 2026 Fall (20 players)';
end $$;
