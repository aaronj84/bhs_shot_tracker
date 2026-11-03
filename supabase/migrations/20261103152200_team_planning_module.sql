-- Opt-in feature modules on owned teams.
-- planning = Playoffs + Schedule (coach) + Club visits. Off by default; Brighton only.

alter table public.teams
  add column if not exists modules jsonb not null default '[]'::jsonb;

alter table public.teams drop constraint if exists teams_modules_is_array;
alter table public.teams
  add constraint teams_modules_is_array check (jsonb_typeof(modules) = 'array');

comment on column public.teams.modules is
  'Opt-in feature modules for owned (is_ours) teams, e.g. ["planning"]. Empty by default.';

-- Brighton varsity (and any Brighton-branded owned program) gets planning.
update public.teams
set modules = modules || '["planning"]'::jsonb
where is_ours = true
  and not (modules @> '"planning"'::jsonb)
  and (
    name = 'Brighton'
    or coalesce(organization, '') ilike '%Brighton%'
    or coalesce(brand_name, '') ilike 'Brighton%'
  );
