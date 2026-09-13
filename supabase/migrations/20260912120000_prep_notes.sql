-- Opponent Prep notes: each note belongs to one game.
-- Tags are loose labels (players now; other connections later).
-- Safe to re-run: create if not exists / drop+add policies.

create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  body text not null,
  author_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notes_body_not_blank check (char_length(trim(body)) > 0)
);

create table if not exists public.note_tags (
  note_id uuid not null references public.notes (id) on delete cascade,
  tag text not null,
  primary key (note_id, tag),
  constraint note_tags_normalized check (tag = lower(trim(tag)) and tag <> '')
);

create index if not exists notes_game_id_created_at_idx
  on public.notes (game_id, created_at desc);

create index if not exists note_tags_tag_idx
  on public.note_tags (tag);

drop trigger if exists notes_set_updated_at on public.notes;
create trigger notes_set_updated_at
before update on public.notes
for each row execute procedure public.set_updated_at();

alter table public.notes enable row level security;
alter table public.note_tags enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['notes', 'note_tags']
  loop
    execute format('drop policy if exists shots_select on public.%I', t);
    execute format('drop policy if exists shots_insert on public.%I', t);
    execute format('drop policy if exists shots_update on public.%I', t);
    execute format('drop policy if exists shots_delete on public.%I', t);
    execute format('create policy shots_select on public.%I for select to authenticated using (true)', t);
    execute format('create policy shots_insert on public.%I for insert to authenticated with check (true)', t);
    execute format('create policy shots_update on public.%I for update to authenticated using (true) with check (true)', t);
    execute format('create policy shots_delete on public.%I for delete to authenticated using (true)', t);
  end loop;
end;
$$;

grant select, insert, update, delete on public.notes to authenticated;
grant select, insert, update, delete on public.note_tags to authenticated;
revoke all on public.notes from anon;
revoke all on public.note_tags from anon;
