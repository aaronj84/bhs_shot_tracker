-- Down: 20261017022910_club_player_links
-- Point affiliations back at public.players. Linked rows reuse the shot-tracker
-- player. Club-only kids get a players row again so the previous schema loads.

alter table public.club_player_affiliations
  add column if not exists player_id uuid;

do $$
declare
  r record;
  pid uuid;
begin
  if to_regclass('public.club_players') is null then
    return;
  end if;
  for r in select id, name, short_name from public.club_players loop
    pid := null;
    if to_regclass('public.club_player_links') is not null then
      select l.player_id into pid
      from public.club_player_links l
      where l.club_player_id = r.id;
    end if;
    if pid is null then
      insert into public.players (name, short_name)
      values (r.name, r.short_name)
      returning id into pid;
    end if;
    update public.club_player_affiliations
    set player_id = pid
    where club_player_id = r.id
      and player_id is null;
  end loop;
end;
$$;

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

alter table public.club_player_affiliations
  drop constraint if exists club_player_affiliations_club_player_id_fkey;

drop index if exists public.club_player_affiliations_active_uniq;
drop index if exists public.club_player_affiliations_player_idx;

alter table public.club_player_affiliations drop column if exists club_player_id;

alter table public.club_player_affiliations
  alter column player_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'club_player_affiliations_player_id_fkey'
  ) then
    alter table public.club_player_affiliations
      add constraint club_player_affiliations_player_id_fkey
      foreign key (player_id) references public.players (id) on delete restrict;
  end if;
end;
$$;

create unique index if not exists club_player_affiliations_active_uniq
  on public.club_player_affiliations (player_id, club_team_id)
  where active;

create index if not exists club_player_affiliations_player_idx
  on public.club_player_affiliations (player_id) where active;

drop table if exists public.club_player_links cascade;
drop table if exists public.club_players cascade;
