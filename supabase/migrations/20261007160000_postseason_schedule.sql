-- Postseason player/parent meeting scheduler (#schedule).
--
-- Public: families see open slots as Available/Booked and book through
-- schedule_book(). Coaches unlock #schedule-admin with the staff PIN, checked
-- here against a bcrypt hash (the shots PIN is client-only; this one is not).
--
-- None of these tables are granted to anon/authenticated. Every read/write goes
-- through the SECURITY DEFINER functions below so parent emails and phone
-- numbers only leave the database through a valid coach session.
-- The schedule-worker / schedule-ics Edge Functions use the service role.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.schedule_players (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 80),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists schedule_players_name_key
  on public.schedule_players (lower(btrim(name)));

create table if not exists public.meeting_slots (
  id uuid primary key default gen_random_uuid(),
  starts_at timestamptz not null,
  duration_minutes integer not null default 20 check (duration_minutes between 5 and 240),
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  constraint meeting_slots_starts_at_key unique (starts_at)
);

create table if not exists public.meeting_bookings (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references public.meeting_slots (id) on delete restrict,
  player_id uuid not null references public.schedule_players (id) on delete restrict,
  parent_email text not null,
  phone_1 text,
  phone_2 text,
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  booked_at timestamptz not null default now(),
  -- Last time the meeting time was set (book or move). Reminders skip bookings
  -- made inside the 30-minute window so a family doesn't get two texts at once.
  scheduled_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  cancelled_at timestamptz,
  pending_notice text check (pending_notice in ('confirmation', 'update')),
  confirmation_sent_at timestamptz,
  reminder_sent_at timestamptz,
  calendar_uid text not null unique default (gen_random_uuid()::text || '@bhs-shot-tracker'),
  ics_sequence integer not null default 0,
  gcal_dirty boolean not null default true,
  gcal_claimed_at timestamptz,
  gcal_synced_at timestamptz,
  gcal_error text
);

-- The double-booking guarantee: one confirmed booking per slot and per player.
create unique index if not exists meeting_bookings_one_per_slot
  on public.meeting_bookings (slot_id) where status = 'confirmed';
create unique index if not exists meeting_bookings_one_per_player
  on public.meeting_bookings (player_id) where status = 'confirmed';
create index if not exists meeting_bookings_pending_idx
  on public.meeting_bookings (id) where pending_notice is not null or gcal_dirty;

create table if not exists public.meeting_sms_log (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid references public.meeting_bookings (id) on delete set null,
  kind text not null check (kind in ('confirmation', 'update', 'reminder')),
  to_last4 text,
  status text not null check (status in ('sent', 'failed', 'skipped')),
  provider_id text,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists meeting_sms_log_created_at_idx
  on public.meeting_sms_log (created_at desc);

comment on table public.meeting_sms_log is
  'One row per SMS attempt. Stores only the last 4 digits of the number.';

create table if not exists public.schedule_settings (
  id boolean primary key default true check (id),
  admin_pin_hash text not null,
  feed_token text not null,
  worker_url text,
  default_duration integer not null default 20 check (default_duration between 5 and 240),
  updated_at timestamptz not null default now()
);

create table if not exists public.schedule_admin_sessions (
  token_hash text primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists public.schedule_admin_attempts (
  id bigserial primary key,
  ip text,
  created_at timestamptz not null default now()
);

-- PIN defaults to the documented staff PIN; coaches can change it in #schedule-admin.
-- Feed token is generated per database and never lives in git.
insert into public.schedule_settings (id, admin_pin_hash, feed_token)
values (true, crypt('KEPPA', gen_salt('bf')), encode(gen_random_bytes(24), 'hex'))
on conflict (id) do nothing;

insert into public.schedule_players (name)
select v.name
from (
  values
    ('Makenna'), ('Sophie'), ('Sami'), ('Alanna'), ('Ellie'), ('Lizzie'),
    ('Sarah'), ('Moira'), ('Myken'), ('Beth'), ('Lucy'), ('Kali-Shea'),
    ('Brynley'), ('Lily'), ('Mehana'), ('Skye'), ('Emmeline')
) as v(name)
where not exists (
  select 1 from public.schedule_players p where lower(btrim(p.name)) = lower(v.name)
);

-- ---------------------------------------------------------------------------
-- Lock tables down
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'schedule_players', 'meeting_slots', 'meeting_bookings', 'meeting_sms_log',
    'schedule_settings', 'schedule_admin_sessions', 'schedule_admin_attempts'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;

revoke all on sequence public.schedule_admin_attempts_id_seq from anon, authenticated;
grant all on sequence public.schedule_admin_attempts_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------

create or replace function public._schedule_norm_phone(p_phone text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  d text;
begin
  if p_phone is null or btrim(p_phone) = '' then
    return null;
  end if;
  d := regexp_replace(p_phone, '\D', '', 'g');
  if length(d) = 11 and left(d, 1) = '1' then
    d := substr(d, 2);
  end if;
  if length(d) <> 10 or substr(d, 1, 1) in ('0', '1') or substr(d, 4, 1) in ('0', '1') then
    raise exception 'Enter mobile numbers as 10-digit US numbers, like 801-555-0123.'
      using errcode = 'P0001';
  end if;
  return '+1' || d;
end;
$$;

create or replace function public._schedule_norm_email(p_email text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  e text := lower(btrim(coalesce(p_email, '')));
begin
  if length(e) > 254 or e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a valid parent/guardian email.' using errcode = 'P0001';
  end if;
  return e;
end;
$$;

create or replace function public._schedule_client_ip()
returns text
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  h json;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    h := null;
  end;
  if h is null then
    return null;
  end if;
  return nullif(btrim(split_part(coalesce(h ->> 'cf-connecting-ip', h ->> 'x-forwarded-for', ''), ',', 1)), '');
end;
$$;

create or replace function public._schedule_require_admin(p_token text)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if p_token is null or not exists (
    select 1 from public.schedule_admin_sessions
    where token_hash = encode(digest(p_token, 'sha256'), 'hex')
      and expires_at > now()
  ) then
    raise exception 'Coach session expired. Enter the PIN again.'
      using errcode = 'P0001', hint = 'schedule_auth';
  end if;
end;
$$;

create or replace function public._schedule_insert_booking(
  p_player_id uuid,
  p_slot_id uuid,
  p_email text,
  p_phone_1 text,
  p_phone_2 text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_slot public.meeting_slots;
  v_email text;
  v_p1 text;
  v_p2 text;
  v_id uuid;
begin
  v_email := public._schedule_norm_email(p_email);
  v_p1 := public._schedule_norm_phone(p_phone_1);
  v_p2 := public._schedule_norm_phone(p_phone_2);
  if v_p1 is null then
    v_p1 := v_p2;
    v_p2 := null;
  end if;
  if v_p2 = v_p1 then
    v_p2 := null;
  end if;

  -- Row locks serialize concurrent attempts on the same slot / same player;
  -- the partial unique indexes are the backstop.
  select * into v_slot from public.meeting_slots where id = p_slot_id for update;
  if not found or v_slot.status <> 'open' or v_slot.starts_at <= now() then
    raise exception 'That time is no longer available. Please pick another.' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.meeting_bookings where slot_id = p_slot_id and status = 'confirmed'
  ) then
    raise exception 'Another family just booked that time. Please pick another.' using errcode = 'P0001';
  end if;

  perform 1 from public.schedule_players where id = p_player_id and active for update;
  if not found then
    raise exception 'Please pick your player from the list.' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.meeting_bookings where player_id = p_player_id and status = 'confirmed'
  ) then
    raise exception 'This player already has a meeting booked. Contact the coaches to change it.'
      using errcode = 'P0001';
  end if;

  insert into public.meeting_bookings (slot_id, player_id, parent_email, phone_1, phone_2, pending_notice)
  values (p_slot_id, p_player_id, v_email, v_p1, v_p2, 'confirmation')
  returning id into v_id;
  return v_id;
exception
  when unique_violation then
    raise exception 'That time or player was just booked. Refresh and try again.' using errcode = 'P0001';
end;
$$;

create or replace function public._schedule_booking_json(p_booking_id uuid)
returns json
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select json_build_object(
    'id', b.id,
    'status', b.status,
    'slot_id', b.slot_id,
    'starts_at', s.starts_at,
    'duration_minutes', s.duration_minutes,
    'player_id', b.player_id,
    'player_name', p.name,
    'parent_email', b.parent_email,
    'phone_1', b.phone_1,
    'phone_2', b.phone_2,
    'booked_at', b.booked_at,
    'updated_at', b.updated_at,
    'cancelled_at', b.cancelled_at,
    'pending_notice', b.pending_notice,
    'confirmation_sent_at', b.confirmation_sent_at,
    'reminder_sent_at', b.reminder_sent_at,
    'gcal_dirty', b.gcal_dirty,
    'gcal_synced_at', b.gcal_synced_at,
    'gcal_error', b.gcal_error
  )
  from public.meeting_bookings b
  join public.meeting_slots s on s.id = b.slot_id
  join public.schedule_players p on p.id = b.player_id
  where b.id = p_booking_id;
$$;

-- ---------------------------------------------------------------------------
-- Public (no session)
-- ---------------------------------------------------------------------------

create or replace function public.schedule_public_state()
returns json
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select json_build_object(
    'players', coalesce((
      select json_agg(json_build_object('id', p.id, 'name', p.name) order by lower(p.name))
      from public.schedule_players p
      where p.active
        and not exists (
          select 1 from public.meeting_bookings b
          where b.player_id = p.id and b.status = 'confirmed'
        )
    ), '[]'::json),
    'slots', coalesce((
      select json_agg(json_build_object(
        'id', s.id,
        'starts_at', s.starts_at,
        'duration_minutes', s.duration_minutes,
        'booked', exists (
          select 1 from public.meeting_bookings b
          where b.slot_id = s.id and b.status = 'confirmed'
        )
      ) order by s.starts_at)
      from public.meeting_slots s
      where s.status = 'open' and s.starts_at > now()
    ), '[]'::json)
  );
$$;

create or replace function public.schedule_book(
  p_player_id uuid,
  p_slot_id uuid,
  p_email text,
  p_phone_1 text default null,
  p_phone_2 text default null,
  p_consent boolean default false
)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not coalesce(p_consent, false) then
    raise exception 'Please check the box to confirm your reservation.' using errcode = 'P0001';
  end if;
  v_id := public._schedule_insert_booking(p_player_id, p_slot_id, p_email, p_phone_1, p_phone_2);
  return (
    select json_build_object(
      'booking_id', b.id,
      'player_name', p.name,
      'starts_at', s.starts_at,
      'duration_minutes', s.duration_minutes,
      'phone_count', (b.phone_1 is not null)::int + (b.phone_2 is not null)::int
    )
    from public.meeting_bookings b
    join public.meeting_slots s on s.id = b.slot_id
    join public.schedule_players p on p.id = b.player_id
    where b.id = v_id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Coach session
-- ---------------------------------------------------------------------------

create or replace function public.schedule_admin_login(p_pin text)
returns json
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_ip text := public._schedule_client_ip();
  v_fails integer;
  v_token text;
begin
  delete from public.schedule_admin_attempts where created_at < now() - interval '1 day';
  delete from public.schedule_admin_sessions where expires_at < now();

  select count(*) into v_fails
  from public.schedule_admin_attempts
  where ip is not distinct from v_ip and created_at > now() - interval '15 minutes';
  if v_fails >= 10 then
    return json_build_object('ok', false, 'error', 'Too many tries. Wait 15 minutes and try again.');
  end if;

  if not exists (
    select 1 from public.schedule_settings
    where admin_pin_hash = crypt(upper(btrim(coalesce(p_pin, ''))), admin_pin_hash)
  ) then
    -- Return instead of raise so the failed attempt row commits.
    insert into public.schedule_admin_attempts (ip) values (v_ip);
    return json_build_object('ok', false, 'error', 'Wrong PIN');
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');
  insert into public.schedule_admin_sessions (token_hash, expires_at)
  values (encode(digest(v_token, 'sha256'), 'hex'), now() + interval '30 days');
  return json_build_object('ok', true, 'token', v_token);
end;
$$;

create or replace function public.schedule_admin_logout(p_token text)
returns void
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  delete from public.schedule_admin_sessions
  where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');
$$;

-- ---------------------------------------------------------------------------
-- Coach reads
-- ---------------------------------------------------------------------------

create or replace function public.schedule_admin_state(p_token text)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._schedule_require_admin(p_token);
  return json_build_object(
    'slots', coalesce((
      select json_agg(json_build_object(
        'id', s.id,
        'starts_at', s.starts_at,
        'duration_minutes', s.duration_minutes,
        'status', s.status,
        'has_history', exists (select 1 from public.meeting_bookings x where x.slot_id = s.id),
        'booking', (
          select public._schedule_booking_json(b.id)
          from public.meeting_bookings b
          where b.slot_id = s.id and b.status = 'confirmed'
        )
      ) order by s.starts_at)
      from public.meeting_slots s
    ), '[]'::json),
    'players', coalesce((
      select json_agg(json_build_object(
        'id', p.id,
        'name', p.name,
        'active', p.active,
        'booked', exists (
          select 1 from public.meeting_bookings b
          where b.player_id = p.id and b.status = 'confirmed'
        )
      ) order by lower(p.name))
      from public.schedule_players p
    ), '[]'::json),
    'cancelled', coalesce((
      select json_agg(j order by (j ->> 'cancelled_at') desc)
      from (
        select public._schedule_booking_json(b.id) as j
        from public.meeting_bookings b
        where b.status = 'cancelled'
        order by b.cancelled_at desc nulls last
        limit 25
      ) c
    ), '[]'::json),
    'sms', coalesce((
      select json_agg(json_build_object(
        'kind', l.kind,
        'to_last4', l.to_last4,
        'status', l.status,
        'error', l.error,
        'created_at', l.created_at,
        'player_name', p.name
      ) order by l.created_at desc)
      from (
        select * from public.meeting_sms_log order by created_at desc limit 40
      ) l
      left join public.meeting_bookings b on b.id = l.booking_id
      left join public.schedule_players p on p.id = b.player_id
    ), '[]'::json),
    'settings', (
      select json_build_object(
        'feed_token', st.feed_token,
        'worker_url', st.worker_url,
        'default_duration', st.default_duration
      )
      from public.schedule_settings st
      where st.id
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Coach writes
-- ---------------------------------------------------------------------------

create or replace function public.schedule_admin_create_slots(
  p_token text,
  p_dates date[],
  p_start time,
  p_end time default null,
  p_duration integer default 20,
  p_gap integer default 0
)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d date;
  v_cur timestamp;
  v_stop timestamp;
  v_step interval;
  v_len interval;
  v_created integer := 0;
  v_skipped integer := 0;
  v_rows integer;
begin
  perform public._schedule_require_admin(p_token);
  if p_dates is null or cardinality(p_dates) = 0 or p_start is null then
    raise exception 'Pick a date and a start time.' using errcode = 'P0001';
  end if;
  if p_duration is null or p_duration not between 5 and 240 then
    raise exception 'Meeting length must be 5–240 minutes.' using errcode = 'P0001';
  end if;
  if coalesce(p_gap, 0) not between 0 and 120 then
    raise exception 'Break between meetings must be 0–120 minutes.' using errcode = 'P0001';
  end if;
  v_len := make_interval(mins => p_duration);
  v_step := make_interval(mins => p_duration + coalesce(p_gap, 0));

  foreach d in array p_dates loop
    v_cur := d + p_start;
    v_stop := case when p_end is null then v_cur + v_len else d + p_end end;
    if v_stop < v_cur + v_len then
      raise exception 'End time must be at least one meeting after the start time.' using errcode = 'P0001';
    end if;
    while v_cur + v_len <= v_stop loop
      if v_created + v_skipped >= 300 then
        raise exception 'That would create more than 300 slots. Use a shorter range.' using errcode = 'P0001';
      end if;
      -- Wall-clock time in Denver → absolute instant.
      insert into public.meeting_slots (starts_at, duration_minutes)
      values (v_cur at time zone 'America/Denver', p_duration)
      on conflict (starts_at) do nothing;
      get diagnostics v_rows = row_count;
      if v_rows > 0 then
        v_created := v_created + 1;
      else
        v_skipped := v_skipped + 1;
      end if;
      v_cur := v_cur + v_step;
    end loop;
  end loop;

  update public.schedule_settings set default_duration = p_duration, updated_at = now() where id;
  return json_build_object('created', v_created, 'skipped', v_skipped);
end;
$$;

create or replace function public.schedule_admin_set_slot_status(p_token text, p_slot_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._schedule_require_admin(p_token);
  if p_status not in ('open', 'closed') then
    raise exception 'Unknown slot status.' using errcode = 'P0001';
  end if;
  update public.meeting_slots set status = p_status where id = p_slot_id;
end;
$$;

create or replace function public.schedule_admin_delete_slot(p_token text, p_slot_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._schedule_require_admin(p_token);
  if exists (select 1 from public.meeting_bookings where slot_id = p_slot_id) then
    raise exception 'This time has booking history. Close it instead of deleting.' using errcode = 'P0001';
  end if;
  delete from public.meeting_slots where id = p_slot_id;
end;
$$;

create or replace function public.schedule_admin_book(
  p_token text,
  p_player_id uuid,
  p_slot_id uuid,
  p_email text,
  p_phone_1 text default null,
  p_phone_2 text default null
)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  perform public._schedule_require_admin(p_token);
  v_id := public._schedule_insert_booking(p_player_id, p_slot_id, p_email, p_phone_1, p_phone_2);
  return public._schedule_booking_json(v_id);
end;
$$;

create or replace function public.schedule_admin_update_booking(
  p_token text,
  p_booking_id uuid,
  p_player_id uuid,
  p_email text,
  p_phone_1 text default null,
  p_phone_2 text default null
)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text;
  v_p1 text;
  v_p2 text;
begin
  perform public._schedule_require_admin(p_token);
  v_email := public._schedule_norm_email(p_email);
  v_p1 := public._schedule_norm_phone(p_phone_1);
  v_p2 := public._schedule_norm_phone(p_phone_2);
  if v_p1 is null then
    v_p1 := v_p2;
    v_p2 := null;
  end if;
  if v_p2 = v_p1 then
    v_p2 := null;
  end if;
  if not exists (select 1 from public.schedule_players where id = p_player_id) then
    raise exception 'Unknown player.' using errcode = 'P0001';
  end if;

  update public.meeting_bookings
  set player_id = p_player_id,
      parent_email = v_email,
      phone_1 = v_p1,
      phone_2 = v_p2,
      ics_sequence = ics_sequence + 1,
      gcal_dirty = true,
      updated_at = now()
  where id = p_booking_id and status = 'confirmed';
  if not found then
    raise exception 'That booking is no longer active.' using errcode = 'P0001';
  end if;
  return public._schedule_booking_json(p_booking_id);
exception
  when unique_violation then
    raise exception 'That player already has another meeting booked.' using errcode = 'P0001';
end;
$$;

create or replace function public.schedule_admin_move_booking(p_token text, p_booking_id uuid, p_slot_id uuid)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_slot public.meeting_slots;
begin
  perform public._schedule_require_admin(p_token);
  select * into v_slot from public.meeting_slots where id = p_slot_id for update;
  if not found or v_slot.status <> 'open' or v_slot.starts_at <= now() then
    raise exception 'That time is not available.' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.meeting_bookings
    where slot_id = p_slot_id and status = 'confirmed' and id <> p_booking_id
  ) then
    raise exception 'That time is already booked.' using errcode = 'P0001';
  end if;

  update public.meeting_bookings
  set slot_id = p_slot_id,
      scheduled_at = now(),
      reminder_sent_at = null,
      pending_notice = 'update',
      ics_sequence = ics_sequence + 1,
      gcal_dirty = true,
      updated_at = now()
  where id = p_booking_id and status = 'confirmed' and slot_id <> p_slot_id;
  if not found and not exists (
    select 1 from public.meeting_bookings where id = p_booking_id and status = 'confirmed'
  ) then
    raise exception 'That booking is no longer active.' using errcode = 'P0001';
  end if;
  return public._schedule_booking_json(p_booking_id);
exception
  when unique_violation then
    raise exception 'That time is already booked.' using errcode = 'P0001';
end;
$$;

create or replace function public.schedule_admin_cancel_booking(p_token text, p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._schedule_require_admin(p_token);
  update public.meeting_bookings
  set status = 'cancelled',
      cancelled_at = now(),
      pending_notice = null,
      ics_sequence = ics_sequence + 1,
      gcal_dirty = true,
      updated_at = now()
  where id = p_booking_id and status = 'confirmed';
end;
$$;

create or replace function public.schedule_admin_resend(p_token text, p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._schedule_require_admin(p_token);
  update public.meeting_bookings
  set pending_notice = 'confirmation', updated_at = now()
  where id = p_booking_id and status = 'confirmed';
  if not found then
    raise exception 'That booking is no longer active.' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.schedule_admin_save_player(
  p_token text,
  p_player_id uuid,
  p_name text,
  p_active boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_id uuid;
begin
  perform public._schedule_require_admin(p_token);
  if length(v_name) not between 1 and 80 then
    raise exception 'Enter a player name.' using errcode = 'P0001';
  end if;
  if p_player_id is null then
    insert into public.schedule_players (name, active)
    values (v_name, coalesce(p_active, true))
    returning id into v_id;
  else
    update public.schedule_players
    set name = v_name, active = coalesce(p_active, active)
    where id = p_player_id
    returning id into v_id;
    -- Name shows in calendar titles.
    update public.meeting_bookings
    set gcal_dirty = true, ics_sequence = ics_sequence + 1, updated_at = now()
    where player_id = p_player_id and status = 'confirmed';
  end if;
  return v_id;
exception
  when unique_violation then
    raise exception 'A player with that name already exists.' using errcode = 'P0001';
end;
$$;

create or replace function public.schedule_admin_set_worker_url(p_token text, p_url text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._schedule_require_admin(p_token);
  if p_url !~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?/functions/v1/schedule-worker$' then
    raise exception 'Unexpected worker URL.' using errcode = 'P0001';
  end if;
  update public.schedule_settings set worker_url = p_url, updated_at = now() where id;
end;
$$;

create or replace function public.schedule_admin_rotate_feed(p_token text)
returns text
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v text := encode(gen_random_bytes(24), 'hex');
begin
  perform public._schedule_require_admin(p_token);
  update public.schedule_settings set feed_token = v, updated_at = now() where id;
  return v;
end;
$$;

create or replace function public.schedule_admin_change_pin(p_token text, p_new_pin text)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v text := upper(btrim(coalesce(p_new_pin, '')));
begin
  perform public._schedule_require_admin(p_token);
  if length(v) < 4 or length(v) > 64 then
    raise exception 'PIN must be 4–64 characters.' using errcode = 'P0001';
  end if;
  update public.schedule_settings
  set admin_pin_hash = crypt(v, gen_salt('bf')), updated_at = now()
  where id;
  -- Other devices must sign in with the new PIN.
  delete from public.schedule_admin_sessions
  where token_hash <> encode(digest(p_token, 'sha256'), 'hex');
end;
$$;

-- ---------------------------------------------------------------------------
-- Worker (service role only): claim due work atomically so overlapping runs
-- (cron + post-booking poke) never double-send.
-- ---------------------------------------------------------------------------

create or replace function public.schedule_worker_claim(p_include_gcal boolean default false)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_notices json;
  v_reminders json;
  v_gcal json;
begin
  with picked as (
    select b.id, b.pending_notice as kind
    from public.meeting_bookings b
    where b.pending_notice is not null and b.status = 'confirmed'
    for update skip locked
    limit 50
  ),
  upd as (
    update public.meeting_bookings b
    set pending_notice = null, confirmation_sent_at = now()
    from picked
    where b.id = picked.id
    returning b.id, picked.kind
  )
  select json_agg(public._schedule_booking_json(upd.id)::jsonb || jsonb_build_object('kind', upd.kind))
  into v_notices
  from upd;

  with picked as (
    select b.id
    from public.meeting_bookings b
    join public.meeting_slots s on s.id = b.slot_id
    where b.status = 'confirmed'
      and b.reminder_sent_at is null
      and (b.phone_1 is not null or b.phone_2 is not null)
      and s.starts_at > now()
      and s.starts_at <= now() + interval '30 minutes'
      and b.scheduled_at <= s.starts_at - interval '30 minutes'
    for update of b skip locked
    limit 50
  ),
  upd as (
    update public.meeting_bookings b
    set reminder_sent_at = now()
    from picked
    where b.id = picked.id
    returning b.id
  )
  select json_agg(public._schedule_booking_json(upd.id)::jsonb || jsonb_build_object('kind', 'reminder'))
  into v_reminders
  from upd;

  if coalesce(p_include_gcal, false) then
    with picked as (
      select b.id
      from public.meeting_bookings b
      where b.gcal_dirty
        and (b.gcal_claimed_at is null or b.gcal_claimed_at < now() - interval '5 minutes')
      for update skip locked
      limit 25
    ),
    upd as (
      update public.meeting_bookings b
      set gcal_dirty = false, gcal_claimed_at = now()
      from picked
      where b.id = picked.id
      returning b.id
    )
    select json_agg(public._schedule_booking_json(upd.id))
    into v_gcal
    from upd;
  end if;

  return json_build_object(
    'notices', coalesce(v_notices, '[]'::json),
    'reminders', coalesce(v_reminders, '[]'::json),
    'gcal', coalesce(v_gcal, '[]'::json)
  );
end;
$$;

create or replace function public.schedule_worker_has_work()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.meeting_bookings
    where (pending_notice is not null and status = 'confirmed')
       or (gcal_dirty and (gcal_claimed_at is null or gcal_claimed_at < now() - interval '5 minutes'))
  ) or exists (
    select 1
    from public.meeting_bookings b
    join public.meeting_slots s on s.id = b.slot_id
    where b.status = 'confirmed'
      and b.reminder_sent_at is null
      and (b.phone_1 is not null or b.phone_2 is not null)
      and s.starts_at > now()
      and s.starts_at <= now() + interval '30 minutes'
      and b.scheduled_at <= s.starts_at - interval '30 minutes'
  );
$$;

-- Called every minute by pg_cron (next migration). pg_net is async, so this
-- returns immediately; the Edge Function does the sending.
create or replace function public.schedule_kick_worker()
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_url text;
begin
  select worker_url into v_url from public.schedule_settings where id;
  if v_url is null or not public.schedule_worker_has_work() then
    return;
  end if;
  perform net.http_post(
    url := v_url,
    body := '{"source":"cron"}'::jsonb,
    headers := '{"Content-Type":"application/json"}'::jsonb,
    timeout_milliseconds := 20000
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: Supabase default privileges hand new functions to anon/authenticated,
-- so revoke everything first and re-grant only the RPC surface.
-- ---------------------------------------------------------------------------

do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (p.proname like '\_schedule\_%' or p.proname like 'schedule\_%')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
    if f.proname = 'schedule_public_state'
       or f.proname = 'schedule_book'
       or f.proname like 'schedule\_admin\_%' then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end;
$$;
