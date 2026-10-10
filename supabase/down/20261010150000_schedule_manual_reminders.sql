-- Restore texts/email and Google Calendar sync: columns, the SMS log, the worker
-- functions + cron job, and the original function signatures.
-- Emails dropped by the up migration are gone; restored bookings get a blank email.

drop function if exists public.schedule_book(uuid, uuid, text, text, boolean);
drop function if exists public.schedule_admin_book(text, uuid, uuid, text, text);
drop function if exists public.schedule_admin_update_booking(text, uuid, uuid, text, text);
drop function if exists public._schedule_insert_booking(uuid, uuid, text, text);
drop function if exists public._schedule_norm_phones(text, text);

alter table public.meeting_bookings
  add column if not exists parent_email text not null default '',
  add column if not exists scheduled_at timestamptz not null default now(),
  add column if not exists pending_notice text check (pending_notice in ('confirmation', 'update')),
  add column if not exists confirmation_sent_at timestamptz,
  add column if not exists reminder_sent_at timestamptz,
  add column if not exists gcal_dirty boolean not null default true,
  add column if not exists gcal_claimed_at timestamptz,
  add column if not exists gcal_synced_at timestamptz,
  add column if not exists gcal_error text;
alter table public.meeting_bookings alter column parent_email drop default;
alter table public.schedule_settings add column if not exists worker_url text;
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

alter table public.meeting_sms_log enable row level security;
revoke all on public.meeting_sms_log from anon, authenticated;
grant all on public.meeting_sms_log to service_role;

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

do $$
begin
  if to_regnamespace('cron') is not null then
    if not exists (select 1 from cron.job where jobname = 'schedule-worker') then
      perform cron.schedule('schedule-worker', '* * * * *', $job$select public.schedule_kick_worker()$job$);
    end if;
  end if;
end;
$$;
