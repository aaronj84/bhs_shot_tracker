/**
 * club-itinerary-ics — private subscribable iCalendar feed for one itinerary.
 *
 *   GET /functions/v1/club-itinerary-ics/<feed_token>.ics
 *
 * No JWT (calendar apps can't send one); the 48-hex feed_token on
 * club_itineraries is the credential. Coaches copy / subscribe from #club-itinerary.
 * Auto: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  buildItineraryIcs,
  DEFAULT_VISIT_MINUTES,
  itineraryIcsFilename,
} from "../_shared/club/itinerary.mjs";

function notFound() {
  return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
}

function sameToken(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function playerName(row: { club_players?: { short_name?: string; name?: string } | null }) {
  return row.club_players?.short_name || row.club_players?.name || "";
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

  const { data: itin, error: itinErr } = await sb
    .from("club_itineraries")
    .select(
      "id, name, notes, target_date, updated_at, default_visit_minutes, feed_token",
    )
    .eq("feed_token", token)
    .maybeSingle();
  if (itinErr || !itin || !sameToken(String(itin.feed_token), token)) return notFound();

  const { data: rawStops, error: stopErr } = await sb
    .from("club_itinerary_stops")
    .select(
      `id, club_game_id, stop_order, visit_minutes, notes, planned_arrival_at, planned_departure_at,
       game:club_games (
         kickoff_at, status, club_facility_id, home_team_id, away_team_id,
         facility:club_facilities (id, name, latitude, longitude),
         field:club_fields (label),
         home:club_teams!club_games_home_team_id_fkey (team_name),
         away:club_teams!club_games_away_team_id_fkey (team_name)
       )`,
    )
    .eq("club_itinerary_id", itin.id)
    .order("stop_order");
  if (stopErr) {
    console.error("club-itinerary-ics: stops query failed", stopErr.message);
    return new Response("Feed unavailable", { status: 503 });
  }

  const stops = [];
  for (const s of rawStops || []) {
    // deno-lint-ignore no-explicit-any
    const g: any = s.game || {};
    const teamIds = [g.home_team_id, g.away_team_id].filter(Boolean);
    let players: string[] = [];
    if (teamIds.length) {
      const { data: aff } = await sb
        .from("club_player_affiliations")
        .select("club_team_id, club_players (short_name, name)")
        .in("club_team_id", teamIds)
        .eq("active", true);
      players = [...new Set((aff || []).map(playerName).filter(Boolean))];
    }
    stops.push({
      game_id: s.club_game_id,
      visit_minutes: s.visit_minutes || itin.default_visit_minutes,
      notes: s.notes || "",
      kickoff_at: g.kickoff_at,
      facility_name: g.facility?.name,
      field_label: g.field?.label,
      lat: g.facility?.latitude,
      lng: g.facility?.longitude,
      team_line: `${g.home?.team_name || "TBD"} vs ${g.away?.team_name || "TBD"}`,
      brighton_line: players.join(", "),
      planned_arrival_at: s.planned_arrival_at,
      planned_departure_at: s.planned_departure_at,
    });
  }

  const body = buildItineraryIcs(
    {
      id: itin.id,
      name: itin.name,
      notes: itin.notes,
      target_date: itin.target_date,
    },
    stops,
    {
      defaultVisitMinutes: Math.max(
        Number(itin.default_visit_minutes) || 0,
        DEFAULT_VISIT_MINUTES,
      ),
    },
  );
  const filename = itineraryIcsFilename(itin);

  return new Response(req.method === "HEAD" ? null : body, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "no-cache, max-age=0",
    },
  });
});
