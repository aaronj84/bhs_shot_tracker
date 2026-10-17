-- Club players are their own identity.
-- club_player_links is the only connection to shot-tracker public.players.

create table if not exists public.club_players (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  short_name text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.club_player_links (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players (id) on delete cascade,
  club_player_id uuid not null references public.club_players (id) on delete cascade,
  notes text,
  created_at timestamptz not null default now()
);

create unique index if not exists club_player_links_player_uniq
  on public.club_player_links (player_id);
create unique index if not exists club_player_links_club_player_uniq
  on public.club_player_links (club_player_id);

alter table public.club_player_affiliations
  add column if not exists club_player_id uuid;

-- Copy each affiliated shot-tracker player into club_players.
-- Keep a link only when that person is already on a roster or a shot.
-- Club-only rows inserted into public.players are removed.
do $$
declare
  r record;
  new_id uuid;
  keep boolean;
  shot_hit boolean;
  drop_ids uuid[] := '{}';
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'club_player_affiliations'
      and column_name = 'player_id'
  ) then
    return;
  end if;

  for r in
    select distinct a.player_id as old_id
    from public.club_player_affiliations a
    where a.player_id is not null
      and a.club_player_id is null
  loop
    new_id := gen_random_uuid();
    insert into public.club_players (id, name, short_name)
    select
      new_id,
      coalesce(nullif(btrim(p.name), ''), nullif(btrim(p.short_name), ''), 'Club player'),
      nullif(btrim(p.short_name), '')
    from public.players p
    where p.id = r.old_id;

    if not found then
      insert into public.club_players (id, name) values (new_id, 'Club player');
    end if;

    update public.club_player_affiliations
    set club_player_id = new_id
    where player_id = r.old_id
      and club_player_id is null;

    keep := false;
    if to_regclass('public.rosters') is not null then
      execute 'select exists (select 1 from public.rosters where player_id = $1)'
        into keep
        using r.old_id;
    end if;
    if not keep and to_regclass('public.shots') is not null then
      execute $q$
        select exists (
          select 1 from public.shots
          where player_id = $1
             or fouler_player_id = $1
             or assist_player_id = $1
             or second_assist_player_id = $1
        )
      $q$
        into shot_hit
        using r.old_id;
      keep := coalesce(shot_hit, false);
    end if;

    if keep then
      insert into public.club_player_links (player_id, club_player_id)
      values (r.old_id, new_id)
      on conflict do nothing;
    else
      drop_ids := drop_ids || r.old_id;
    end if;
  end loop;

  if cardinality(drop_ids) > 0 then
    -- Affiliations already point at club_players. Drop the old FK so
    -- club-only rows can leave public.players.
    alter table public.club_player_affiliations
      drop constraint if exists club_player_affiliations_player_id_fkey;
    delete from public.players p
    where p.id = any(drop_ids);
  end if;
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
        'player_id', cp.id,
        'name', coalesce(nullif(cp.short_name, ''), cp.name),
        'full_name', cp.name,
        'side', 'home',
        'shot_player_id', lnk.player_id,
        'shot_player_name', sp.name
      ) order by cp.name)
      from public.club_player_affiliations a
      join public.club_players cp on cp.id = a.club_player_id
      left join public.club_player_links lnk on lnk.club_player_id = cp.id
      left join public.players sp on sp.id = lnk.player_id
      where a.active and a.club_team_id = g.home_team_id
    ),
    '[]'::jsonb
  ) as home_brighton_players,
  coalesce(
    (
      select jsonb_agg(jsonb_build_object(
        'player_id', cp.id,
        'name', coalesce(nullif(cp.short_name, ''), cp.name),
        'full_name', cp.name,
        'side', 'away',
        'shot_player_id', lnk.player_id,
        'shot_player_name', sp.name
      ) order by cp.name)
      from public.club_player_affiliations a
      join public.club_players cp on cp.id = a.club_player_id
      left join public.club_player_links lnk on lnk.club_player_id = cp.id
      left join public.players sp on sp.id = lnk.player_id
      where a.active and a.club_team_id = g.away_team_id
    ),
    '[]'::jsonb
  ) as away_brighton_players,
  (
    select count(distinct a.club_player_id)::int
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

drop index if exists public.club_player_affiliations_active_uniq;
drop index if exists public.club_player_affiliations_player_idx;

alter table public.club_player_affiliations drop column if exists player_id;

alter table public.club_player_affiliations
  alter column club_player_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'club_player_affiliations_club_player_id_fkey'
  ) then
    alter table public.club_player_affiliations
      add constraint club_player_affiliations_club_player_id_fkey
      foreign key (club_player_id) references public.club_players (id) on delete restrict;
  end if;
end;
$$;

create unique index if not exists club_player_affiliations_active_uniq
  on public.club_player_affiliations (club_player_id, club_team_id)
  where active;

create index if not exists club_player_affiliations_player_idx
  on public.club_player_affiliations (club_player_id) where active;

drop trigger if exists club_players_set_updated_at on public.club_players;
create trigger club_players_set_updated_at
before update on public.club_players
for each row execute procedure public.club_set_updated_at();

alter table public.club_players enable row level security;
alter table public.club_player_links enable row level security;

drop policy if exists club_select on public.club_players;
drop policy if exists club_insert on public.club_players;
drop policy if exists club_update on public.club_players;
drop policy if exists club_delete on public.club_players;
create policy club_select on public.club_players for select to authenticated using (true);
create policy club_insert on public.club_players for insert to authenticated with check (true);
create policy club_update on public.club_players for update to authenticated using (true) with check (true);
create policy club_delete on public.club_players for delete to authenticated using (true);

drop policy if exists club_select on public.club_player_links;
drop policy if exists club_insert on public.club_player_links;
drop policy if exists club_update on public.club_player_links;
drop policy if exists club_delete on public.club_player_links;
create policy club_select on public.club_player_links for select to authenticated using (true);
create policy club_insert on public.club_player_links for insert to authenticated with check (true);
create policy club_update on public.club_player_links for update to authenticated using (true) with check (true);
create policy club_delete on public.club_player_links for delete to authenticated using (true);

grant select, insert, update, delete on public.club_players, public.club_player_links to authenticated;
revoke all on public.club_players, public.club_player_links from anon;
