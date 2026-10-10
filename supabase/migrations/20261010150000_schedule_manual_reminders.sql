-- Postseason scheduler: no automated texts or email.
-- Families add the meeting to their own calendar from the confirmation screen
-- and may leave mobile numbers so coaches can text reminders by hand.
-- No Google Calendar sync either: coaches subscribe to the schedule-ics feed.
-- That removes the schedule-worker, its every-minute cron job, and sync state.

do $$
begin
  if to_regnamespace('cron') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname = 'schedule-worker';
  end if;
end;
$$;

drop function if exists public.schedule_kick_worker();
drop function if exists public.schedule_worker_has_work();
drop function if exists public.schedule_worker_claim(boolean);
drop function if exists public.schedule_admin_set_worker_url(text, text);
drop function if exists public.schedule_admin_resend(text, uuid);
drop function if exists public.schedule_book(uuid, uuid, text, text, text, boolean);
drop function if exists public.schedule_admin_book(text, uuid, uuid, text, text, text);
drop function if exists public.schedule_admin_update_booking(text, uuid, uuid, text, text, text);
drop function if exists public._schedule_insert_booking(uuid, uuid, text, text, text);
drop function if exists public._schedule_norm_email(text);

drop table if exists public.meeting_sms_log;

drop index if exists public.meeting_bookings_pending_idx;
alter table public.meeting_bookings
  drop column if exists parent_email,
  drop column if exists scheduled_at,
  drop column if exists pending_notice,
  drop column if exists confirmation_sent_at,
  drop column if exists reminder_sent_at,
  drop column if exists gcal_dirty,
  drop column if exists gcal_claimed_at,
  drop column if exists gcal_synced_at,
  drop column if exists gcal_error;
alter table public.schedule_settings drop column if exists worker_url;

-- Primary first, no duplicate. Raises on a malformed number.
create or replace function public._schedule_norm_phones(p_phone_1 text, p_phone_2 text)
returns text[]
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_p1 text := public._schedule_norm_phone(p_phone_1);
  v_p2 text := public._schedule_norm_phone(p_phone_2);
begin
  if v_p1 is null then
    v_p1 := v_p2;
    v_p2 := null;
  end if;
  if v_p2 = v_p1 then
    v_p2 := null;
  end if;
  return array[v_p1, v_p2];
end;
$$;

create or replace function public._schedule_insert_booking(
  p_player_id uuid,
  p_slot_id uuid,
  p_phone_1 text default null,
  p_phone_2 text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_slot public.meeting_slots;
  v_phones text[] := public._schedule_norm_phones(p_phone_1, p_phone_2);
  v_id uuid;
begin
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

  insert into public.meeting_bookings (slot_id, player_id, phone_1, phone_2)
  values (p_slot_id, p_player_id, v_phones[1], v_phones[2])
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
    'phone_1', b.phone_1,
    'phone_2', b.phone_2,
    'booked_at', b.booked_at,
    'updated_at', b.updated_at,
    'cancelled_at', b.cancelled_at
  )
  from public.meeting_bookings b
  join public.meeting_slots s on s.id = b.slot_id
  join public.schedule_players p on p.id = b.player_id
  where b.id = p_booking_id;
$$;

create or replace function public.schedule_book(
  p_player_id uuid,
  p_slot_id uuid,
  p_phone_1 text default null,
  p_phone_2 text default null,
  p_confirm boolean default false
)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not coalesce(p_confirm, false) then
    raise exception 'Please check the box to confirm your reservation.' using errcode = 'P0001';
  end if;
  v_id := public._schedule_insert_booking(p_player_id, p_slot_id, p_phone_1, p_phone_2);
  return (
    select json_build_object(
      'booking_id', b.id,
      'player_name', p.name,
      'starts_at', s.starts_at,
      'duration_minutes', s.duration_minutes
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
    'settings', (
      select json_build_object(
        'feed_token', st.feed_token,
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
  v_id := public._schedule_insert_booking(p_player_id, p_slot_id, p_phone_1, p_phone_2);
  return public._schedule_booking_json(v_id);
end;
$$;

create or replace function public.schedule_admin_update_booking(
  p_token text,
  p_booking_id uuid,
  p_player_id uuid,
  p_phone_1 text default null,
  p_phone_2 text default null
)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_phones text[];
begin
  perform public._schedule_require_admin(p_token);
  v_phones := public._schedule_norm_phones(p_phone_1, p_phone_2);
  if not exists (select 1 from public.schedule_players where id = p_player_id) then
    raise exception 'Unknown player.' using errcode = 'P0001';
  end if;

  update public.meeting_bookings
  set player_id = p_player_id,
      phone_1 = v_phones[1],
      phone_2 = v_phones[2],
      ics_sequence = ics_sequence + 1,
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
      ics_sequence = ics_sequence + 1,
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
      ics_sequence = ics_sequence + 1,
      updated_at = now()
  where id = p_booking_id and status = 'confirmed';
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
    set ics_sequence = ics_sequence + 1, updated_at = now()
    where player_id = p_player_id and status = 'confirmed';
  end if;
  return v_id;
exception
  when unique_violation then
    raise exception 'A player with that name already exists.' using errcode = 'P0001';
end;
$$;

-- Supabase default privileges hand new functions to anon/authenticated,
-- so revoke everything first and re-grant only the RPC surface.
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
