-- Lightweight first-party usage log (workflows + failures, not a click firehose).

create table if not exists public.app_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  session_id text not null,
  game_id uuid references public.games (id) on delete set null,
  view text,
  name text not null,
  target text,
  detail jsonb not null default '{}'::jsonb,
  constraint app_events_name_check
    check (name in ('view', 'modal', 'control', 'play', 'error'))
);

create index if not exists app_events_created_at_idx
  on public.app_events (created_at desc);
create index if not exists app_events_name_created_at_idx
  on public.app_events (name, created_at desc);
create index if not exists app_events_game_id_created_at_idx
  on public.app_events (game_id, created_at desc);

comment on table public.app_events is
  'Sideline workflow breadcrumbs: route, shot-modal phase, named controls, saved play type, error toasts. No pitch coordinates or jersey names.';

alter table public.app_events enable row level security;

do $$
begin
  execute 'drop policy if exists shots_select on public.app_events';
  execute 'drop policy if exists shots_insert on public.app_events';
  execute 'drop policy if exists shots_update on public.app_events';
  execute 'drop policy if exists shots_delete on public.app_events';
  execute 'create policy shots_select on public.app_events for select to authenticated using (true)';
  execute 'create policy shots_insert on public.app_events for insert to authenticated with check (true)';
end;
$$;

grant select, insert on public.app_events to authenticated;
revoke all on public.app_events from anon;
