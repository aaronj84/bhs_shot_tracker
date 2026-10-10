/**
 * schedule-ics — private subscribable iCalendar feed of booked postseason meetings.
 *
 *   GET /functions/v1/schedule-ics/<feed_token>.ics
 *
 * No JWT (calendar apps can't send one); the 48-hex-char token from
 * schedule_settings.feed_token is the only credential. Coaches copy the URL
 * from #schedule-admin and can rotate it there.
 * Auto: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import type { Booking } from "../_shared/schedule/format.ts";
import { buildCalendar } from "../_shared/schedule/ics.ts";

function notFound() {
  return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
}

function sameToken(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") return notFound();

  const url = new URL(req.url);
  const last = url.pathname.split("/").pop() || "";
  const token = (url.searchParams.get("token") || last).replace(/\.ics$/i, "");
  if (!/^[0-9a-f]{48}$/.test(token)) return notFound();

  const sb = createClient(Deno.env.get("SUPABASE_URL") || "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "", {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: settings, error: sErr } = await sb
    .from("schedule_settings")
    .select("feed_token")
    .eq("id", true)
    .maybeSingle();
  if (sErr || !settings || !sameToken(String(settings.feed_token), token)) return notFound();

  const { data, error } = await sb
    .from("meeting_bookings")
    .select(
      "id, status, booked_at, updated_at, calendar_uid, ics_sequence, phone_1, phone_2, slot:meeting_slots (starts_at, duration_minutes), player:schedule_players (name)",
    )
    .eq("status", "confirmed");
  if (error) {
    console.error("schedule-ics: query failed", error.message);
    return new Response("Feed unavailable", { status: 503 });
  }

  // deno-lint-ignore no-explicit-any
  const bookings: Booking[] = (data || []).map((r: any) => ({
    id: r.id,
    status: r.status,
    starts_at: r.slot.starts_at,
    duration_minutes: r.slot.duration_minutes,
    player_name: r.player.name,
    phone_1: r.phone_1,
    phone_2: r.phone_2,
    booked_at: r.booked_at,
    updated_at: r.updated_at,
    calendar_uid: r.calendar_uid,
    ics_sequence: r.ics_sequence,
  }));
  bookings.sort((a, b) => a.starts_at.localeCompare(b.starts_at));

  const body = buildCalendar(bookings);
  return new Response(req.method === "HEAD" ? null : body, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="brighton-postseason-meetings.ics"',
      "Cache-Control": "no-cache, max-age=0",
    },
  });
});
