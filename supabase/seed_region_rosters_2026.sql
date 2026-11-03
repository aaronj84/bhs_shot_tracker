-- Region opponent varsity rosters for 2026 Fall (PROD-safe).
-- Run in Supabase SQL editor on PROD (Alta 9/3, Skyline 9/8, and remaining region).
--
-- Teams: Alta, Olympus, Skyline, Woods Cross, Viewmont
-- Safe to re-run: fills names on existing jersey rows (e.g. unnamed Olympus
-- numbers from earlier shot imports); skips duplicate jerseys.
-- Does NOT touch Brighton data or games.
--
-- Position mapping from MaxPreps-style labels → tracker groups:
--   GK → GK | MF → MID | FORW/STRK → FWD | D/SWEP → CB | FB → OB
--   Combined listings keep each mapped group (e.g. D, MF → CB, MID).

do $$
declare
  season uuid;
  tid uuid;
  pid uuid;
  rec record;
  loaded int := 0;
begin
  select id into season from public.seasons where label = '2026 Fall' limit 1;
  if season is null then
    raise exception '2026 Fall season missing — run schema/migrations first';
  end if;

  if not exists (select 1 from public.teams where name = 'Alta' and not is_ours) then
    raise exception 'Alta team missing — run migrate_2026_varsity_schedule.sql first';
  end if;
  if not exists (select 1 from public.teams where name = 'Olympus' and not is_ours) then
    raise exception 'Olympus team missing — run migrate_2026_varsity_schedule.sql first';
  end if;
  if not exists (select 1 from public.teams where name = 'Skyline' and not is_ours) then
    raise exception 'Skyline team missing — run migrate_2026_varsity_schedule.sql first';
  end if;
  if not exists (select 1 from public.teams where name = 'Woods Cross' and not is_ours) then
    raise exception 'Woods Cross team missing — run migrate_2026_varsity_schedule.sql first';
  end if;
  if not exists (select 1 from public.teams where name = 'Viewmont' and not is_ours) then
    raise exception 'Viewmont team missing — run migrate_2026_varsity_schedule.sql first';
  end if;

  for rec in
    select * from (
      values
        -- Alta (17)
        ('Alta', '1',  'Delilah Bolen',     'Delilah',   '{GK}'::text[]),
        ('Alta', '2',  'Sophia Ceballos',   'Sophia',    '{MID}'),
        ('Alta', '3',  'Taylor Butt',       'Taylor',    '{}'),
        ('Alta', '4',  'Alyce Whitson',     'Alyce',     '{MID}'),
        ('Alta', '5',  'Lilly Labrum',      'Lilly',     '{MID}'),
        ('Alta', '6',  'Alyssa Bernard',    'Alyssa',    '{CB}'),
        ('Alta', '7',  'Coco Monge',        'Coco',      '{FWD}'),
        ('Alta', '8',  'Bailey Berry',      'Bailey',    '{MID}'),
        ('Alta', '11', 'Jocelynn Rowley',   'Jocelynn',  '{FWD}'),
        ('Alta', '12', 'Whitney Stoker',    'Whitney',   '{CB}'),
        ('Alta', '13', 'Elle Headrick',     'Elle',      '{CB}'),
        ('Alta', '14', 'Olivia Henderson',  'Olivia',    '{MID}'),
        ('Alta', '16', 'Ellie Tilt',        'Ellie',     '{FWD}'),
        ('Alta', '17', 'Evelyn Woolley',    'Evelyn',    '{CB}'),
        ('Alta', '18', 'Maggie Bradley',    'Maggie',    '{MID}'),
        ('Alta', '19', 'Rachel Wright',     'Rachel',    '{CB}'),
        ('Alta', '22', 'Kali Gillett',      'Kali',      '{CB}'),

        -- Olympus (20)
        ('Olympus', '3',  'Mae Matsumori',       'Mae',     '{MID}'),
        ('Olympus', '6',  'Elle Everson',        'Elle',    '{CB,FWD}'),
        ('Olympus', '9',  'Anna Aldredge',       'Anna',    '{GK}'),
        ('Olympus', '10', 'McCoy Cavazos',       'McCoy',   '{MID}'),
        ('Olympus', '11', 'Quinn Barton',        'Quinn',   '{CB}'),
        ('Olympus', '14', 'Keira Bradley',       'Keira',   '{FWD}'),
        ('Olympus', '15', 'Emma Peterson',       'Emma',    '{CB}'),
        ('Olympus', '17', 'Aiya Jones',          'Aiya',    '{FWD}'),
        ('Olympus', '21', 'Mila Guymon',         'Mila',    '{CB}'),
        ('Olympus', '23', 'Emmy Mulligan',       'Emmy',    '{CB,MID,FWD}'),
        ('Olympus', '24', 'Siri Guymon',         'Siri',    '{FWD}'),
        ('Olympus', '26', 'Claire Christensen',  'Claire',  '{CB,MID}'),
        ('Olympus', '29', 'Mia Green',           'Mia',     '{CB}'),
        ('Olympus', '35', 'Taylor Beck',         'Taylor',  '{FWD}'),
        ('Olympus', '37', 'Annika Sperry',       'Annika',  '{MID}'),
        ('Olympus', '38', 'Jade Cavazos',        'Jade',    '{MID}'),
        ('Olympus', '45', 'Claire Dickson',      'Claire',  '{MID}'),
        ('Olympus', '54', 'Ruby Gilbert',        'Ruby',    '{FWD,MID}'),
        ('Olympus', '55', 'Kayla Bradley',       'Kayla',   '{CB}'),
        ('Olympus', '98', 'Maddie Sharp',        'Maddie',  '{GK}'),

        -- Skyline (27)
        ('Skyline', '1',  'Marie Distel',              'Marie',     '{GK}'),
        ('Skyline', '3',  'McKenzie Di Sera',          'McKenzie',  '{FWD}'),
        ('Skyline', '4',  'Rylee Brewster',            'Rylee',     '{CB,MID}'),
        ('Skyline', '5',  'Piper Carlston',            'Piper',     '{MID}'),
        ('Skyline', '6',  'Eloise Romney',             'Eloise',    '{CB,OB}'),
        ('Skyline', '8',  'Evie Belcher',              'Evie',      '{CB}'),
        ('Skyline', '9',  'Maria Kefalopoulos',        'Maria',     '{FWD}'),
        ('Skyline', '10', 'Alli Langarica',            'Alli',      '{MID}'),
        ('Skyline', '11', 'Mollie Nevenner',           'Mollie',    '{CB}'),
        ('Skyline', '12', 'Lucy Silon',                'Lucy',      '{MID}'),
        ('Skyline', '13', 'Elsie Hubrich',             'Elsie',     '{FWD}'),
        ('Skyline', '15', 'Stella Madsen',             'Stella',    '{CB}'),
        ('Skyline', '16', 'Elsa Starr',                'Elsa',      '{FWD,MID}'),
        ('Skyline', '17', 'Annika Rollins',            'Annika',    '{MID}'),
        ('Skyline', '19', 'Hailey Price',              'Hailey',    '{MID}'),
        ('Skyline', '22', 'Mary Ivins',                'Mary',      '{CB,MID}'),
        ('Skyline', '23', 'Evelyn Olesen',             'Evelyn',    '{CB,MID}'),
        ('Skyline', '26', 'Grace Booth',               'Grace',     '{MID}'),
        ('Skyline', '28', 'Callie Healey',             'Callie',    '{FWD}'),
        ('Skyline', '30', 'Tessa Walker',              'Tessa',     '{MID}'),
        ('Skyline', '31', 'Vivian Lieberman',          'Vivian',    '{CB}'),
        ('Skyline', '33', 'Valeria Gomez Langberg',    'Valeria',   '{MID}'),
        ('Skyline', '34', 'Valeska Stoltenow',         'Valeska',   '{FWD}'),
        ('Skyline', '37', 'Kamilla Khajavi',           'Kamilla',   '{CB}'),
        ('Skyline', '39', 'Gianna Patterson',          'Gianna',    '{MID,CB}'),
        ('Skyline', '44', 'Caroline Lipson',           'Caroline',  '{FWD}'),
        ('Skyline', '45', 'Natalie Perez',             'Natalie',   '{CB}'),

        -- Woods Cross (37)
        ('Woods Cross', '0',  'Harper Burbidge',     'Harper',    '{GK}'),
        ('Woods Cross', '00', 'Kacey Durtschi',      'Kacey',     '{GK}'),
        ('Woods Cross', '1',  'Brightyn Walker',     'Brightyn',  '{GK}'),
        ('Woods Cross', '2',  'Sophia Bingham',      'Sophia',    '{GK}'),
        ('Woods Cross', '3',  'Halle Tucker',        'Halle',     '{FWD}'),
        ('Woods Cross', '4',  'Sydney Oakes',        'Sydney',    '{MID,FWD}'),
        ('Woods Cross', '5',  'Lily Grace Garff',    'Lily',      '{FWD}'),
        ('Woods Cross', '6',  'Kalei Crockett',      'Kalei',     '{FWD}'),
        ('Woods Cross', '7',  'Noemi Pineda',        'Noemi',     '{MID}'),
        ('Woods Cross', '8',  'Jane Norman',         'Jane',      '{FWD}'),
        ('Woods Cross', '9',  'Abby Poulton',        'Abby',      '{FWD}'),
        ('Woods Cross', '10', 'Molly Christensen',   'Molly',     '{MID}'),
        ('Woods Cross', '11', 'Zizi Biehn',          'Zizi',      '{CB}'),
        ('Woods Cross', '12', 'Caroline Manning',    'Caroline',  '{CB}'),
        ('Woods Cross', '13', 'Annie Tyson',         'Annie',     '{CB}'),
        ('Woods Cross', '14', 'Clara Howes',         'Clara',     '{FWD}'),
        ('Woods Cross', '15', 'Emily Gardner',       'Emily',     '{FWD}'),
        ('Woods Cross', '16', 'Briella Masson',      'Briella',   '{FWD}'),
        ('Woods Cross', '17', 'Maddie Marx',         'Maddie',    '{FWD}'),
        ('Woods Cross', '18', 'Danika Wyman',        'Danika',    '{CB}'),
        ('Woods Cross', '19', 'Norah Gilbert',       'Norah',     '{CB}'),
        ('Woods Cross', '20', 'Arianna Galvez',      'Arianna',   '{MID}'),
        ('Woods Cross', '21', 'Lilly Atkin',         'Lilly',     '{FWD}'),
        ('Woods Cross', '22', 'Reese Tanner',        'Reese',     '{MID}'),
        ('Woods Cross', '23', 'Aileen Lopez',        'Aileen',    '{CB}'),
        ('Woods Cross', '24', 'Berklee Palmer',      'Berklee',   '{CB}'),
        ('Woods Cross', '25', 'Oaklee Douros',       'Oaklee',    '{GK}'),
        ('Woods Cross', '26', 'Ari Tucker',          'Ari',       '{FWD}'),
        ('Woods Cross', '27', 'Jillian Gilbert',     'Jillian',   '{CB}'),
        ('Woods Cross', '28', 'Rya Wood',            'Rya',       '{CB}'),
        ('Woods Cross', '29', 'Macie Malmrose',      'Macie',     '{CB}'),
        ('Woods Cross', '30', 'Macie Davis',         'Macie',     '{MID}'),
        ('Woods Cross', '31', 'Rebecca Bennett',     'Rebecca',   '{FWD}'),
        ('Woods Cross', '32', 'Joss Buswell',        'Joss',      '{MID}'),
        ('Woods Cross', '33', 'Harper Lindsay',      'Harper',    '{MID}'),
        ('Woods Cross', '34', 'Rory Nesbit',         'Rory',      '{}'),
        ('Woods Cross', '35', 'Haven Hull',          'Haven',     '{CB}'),

        -- Viewmont (19)
        ('Viewmont', '00', 'Hillary Hendrickson', 'Hillary',  '{GK}'),
        ('Viewmont', '1',  'June Lamb',           'June',     '{GK}'),
        ('Viewmont', '2',  'Abby Smith',          'Abby',     '{FWD}'),
        ('Viewmont', '3',  'London Allen',        'London',   '{MID}'),
        ('Viewmont', '4',  'Paisley Albertelli',  'Paisley',  '{MID}'),
        ('Viewmont', '5',  'Ruby Lamb',           'Ruby',     '{OB}'),
        ('Viewmont', '6',  'Lyla Edginton',       'Lyla',     '{OB}'),
        ('Viewmont', '7',  'Savannah Randall',    'Savannah', '{MID}'),
        ('Viewmont', '8',  'Avery Tyler',         'Avery',    '{OB}'),
        ('Viewmont', '9',  'Hallie Essig',        'Hallie',   '{FWD}'),
        ('Viewmont', '10', 'Jacque Parke',        'Jacque',   '{MID}'),
        ('Viewmont', '12', 'Sara Pena',           'Sara',     '{CB}'),
        ('Viewmont', '13', 'Tessa Nelson',        'Tessa',    '{FWD}'),
        ('Viewmont', '14', 'Savannah Fowles',     'Savannah', '{MID}'),
        ('Viewmont', '15', 'Emerson Hamaker',     'Emerson',  '{MID}'),
        ('Viewmont', '16', 'Raegan Pace',         'Raegan',   '{CB}'),
        ('Viewmont', '17', 'Aida Horlacher',      'Aida',     '{FWD}'),
        ('Viewmont', '18', 'Chaylee Johnson',     'Chaylee',  '{FWD}'),
        ('Viewmont', '19', 'Morgan Feinauer',     'Morgan',   '{CB}')
    ) as t(team_name, jersey, full_name, short_name, groups)
  loop
    select id into tid
    from public.teams
    where name = rec.team_name and not is_ours
    limit 1;

    select r.player_id into pid
    from public.rosters r
    where r.team_id = tid
      and r.season_id = season
      and r.jersey_number = rec.jersey;

    if pid is null then
      insert into public.players (name, short_name, position_groups)
      values (rec.full_name, rec.short_name, rec.groups)
      returning id into pid;

      insert into public.rosters (team_id, season_id, player_id, jersey_number, squad)
      values (tid, season, pid, rec.jersey, 'varsity')
      on conflict (team_id, season_id, jersey_number) do nothing;

      select r.player_id into pid
      from public.rosters r
      where r.team_id = tid
        and r.season_id = season
        and r.jersey_number = rec.jersey;
    end if;

    if pid is not null then
      update public.players
      set name = rec.full_name,
          short_name = rec.short_name,
          position_groups = case
            when rec.groups <> '{}' then rec.groups
            else position_groups
          end
      where id = pid;
      loaded := loaded + 1;
    end if;
  end loop;

  raise notice 'Region rosters loaded/updated for 2026 Fall (% players: Alta 17, Olympus 20, Skyline 27, Woods Cross 37, Viewmont 19)', loaded;
end $$;
