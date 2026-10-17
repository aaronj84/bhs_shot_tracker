/**
 * Deterministic tool handlers for club-visitation Gemini agent.
 */

import {
  addDaysIso,
  endOfLocalDayUtc,
  localDateInTz,
  parseRelativeDateWindow,
  startOfLocalDayUtc,
  CLUB_TZ,
} from "./normalize.mjs";
import { filterByRadiusMiles, geocodePlace, routeMatrix, travelMinutesBetween } from "./travel.mjs";
import { assessFeasibility, buildLegs, proposeOrder, DEFAULT_WALK_MINUTES } from "./itinerary.mjs";
import { uniquePlayers } from "./reconcile.mjs";

export const TOOL_NAMES = [
  "search_club_games",
  "get_club_game_details",
  "find_nearby_club_games",
  "get_travel_times",
  "propose_club_itinerary",
  "get_saved_club_itinerary",
  "list_club_itineraries",
];

export async function executeClubTool(name, args, ctx) {
  switch (name) {
    case "search_club_games":
      return searchClubGames(args, ctx);
    case "get_club_game_details":
      return getClubGameDetails(args, ctx);
    case "find_nearby_club_games":
      return findNearbyClubGames(args, ctx);
    case "get_travel_times":
      return getTravelTimes(args, ctx);
    case "propose_club_itinerary":
      return proposeClubItinerary(args, ctx);
    case "get_saved_club_itinerary":
      return getSavedItinerary(args, ctx);
    case "list_club_itineraries":
      return listItineraries(ctx);
    default:
      return { error: `Unknown tool ${name}` };
  }
}

async function loadAgendaRows(ctx, filters) {
  return ctx.db.searchGames(filters);
}

function enrichGame(row) {
  const home = row.home_brighton_players || [];
  const away = row.away_brighton_players || [];
  const players = uniquePlayers([...home, ...away]);
  return {
    game_id: row.id || row.club_game_id,
    kickoff_at: row.kickoff_at,
    status: row.status,
    home_team: row.home_team_name,
    away_team: row.away_team_name,
    home_team_id: row.home_team_id,
    away_team_id: row.away_team_id,
    competition: row.competition_name,
    facility: row.facility_name,
    field: row.field_label,
    city: row.city,
    lat: row.latitude,
    lng: row.longitude,
    brighton_players: players,
    brighton_player_count: players.length,
    brighton_both_sides: !!(home.length && away.length),
    home_brighton_players: home,
    away_brighton_players: away,
    recently_changed: !!row.recently_changed,
  };
}

async function searchClubGames(args, ctx) {
  let date_from = args.date_from;
  let date_to = args.date_to;
  if (!date_from || !date_to) {
    const w = parseRelativeDateWindow(args.relative || "next 7 days", CLUB_TZ);
    date_from = date_from || w.date_from;
    date_to = date_to || w.date_to;
  }
  const rows = await loadAgendaRows(ctx, {
    date_from,
    date_to,
    player_ids: args.player_ids,
    team_ids: args.team_ids,
    competition_ids: args.competitions || args.competition_ids,
    facility_id: args.facility_id,
    city: args.city_or_area,
    include_cancelled: !!args.include_cancelled,
    both_sides: !!args.both_sides,
  });
  return {
    date_from,
    date_to,
    count: rows.length,
    games: rows.map(enrichGame),
  };
}

async function getClubGameDetails(args, ctx) {
  const row = await ctx.db.getGameDetails(args.game_id);
  if (!row) return { error: "Game not found", game_id: args.game_id };
  return { game: enrichGame(row), provenance: row.provenance || null, changes: row.recent_changes || [] };
}

async function findNearbyClubGames(args, ctx) {
  const apiKey = ctx.mapsApiKey;
  let origin = args.coordinates || null;
  let disambiguation = null;
  if (!origin && args.place_or_coordinates) {
    const place = String(args.place_or_coordinates);
    if (/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(place)) {
      const [lat, lng] = place.split(",").map((x) => Number(x.trim()));
      origin = { lat, lng, label: place };
    } else {
      const geo = await geocodePlace(place, apiKey);
      if (!geo.ok) return { error: geo.error, games: [] };
      if (!geo.results.length) return { error: `No geocode results for "${place}"`, games: [] };
      if (geo.ambiguous) {
        disambiguation = geo.results.map((r) => ({ label: r.label, lat: r.lat, lng: r.lng }));
        origin = geo.results[0];
      } else {
        origin = geo.results[0];
      }
    }
  }
  if (!origin) return { error: "place_or_coordinates required", games: [] };

  const w = args.date_window || parseRelativeDateWindow("today", CLUB_TZ);
  const date_from = w.date_from || w.from || localDateInTz();
  const date_to = w.date_to || w.to || date_from;
  const rows = await loadAgendaRows(ctx, {
    date_from,
    date_to,
    include_cancelled: false,
  });
  const radius = args.radius_miles || 25;
  const withCoords = rows
    .map(enrichGame)
    .map((g) => ({ ...g, lat: g.lat, lng: g.lng }));
  const nearby = filterByRadiusMiles(withCoords, origin, radius);

  // Optional max drive filter when routing configured
  let driveFiltered = nearby;
  let routing_note = null;
  if (args.radius_or_max_drive_time && apiKey && nearby.length) {
    const maxMin = Number(args.radius_or_max_drive_time);
    if (maxMin > 0 && maxMin < 500) {
      const matrix = await routeMatrix(origin, nearby, apiKey);
      if (matrix.ok) {
        driveFiltered = nearby.filter((_, i) => {
          const m = matrix.durations_minutes[i];
          return m != null && m <= maxMin;
        }).map((g, i) => {
          const idx = nearby.indexOf(g);
          return { ...g, drive_minutes: matrix.durations_minutes[nearby.indexOf(g)] };
        });
        // fix mapping
        driveFiltered = nearby
          .map((g, i) => ({ ...g, drive_minutes: matrix.durations_minutes[i] }))
          .filter((g) => g.drive_minutes != null && g.drive_minutes <= maxMin);
      } else {
        routing_note = matrix.error;
      }
    }
  } else if (!apiKey) {
    routing_note = "Drive-time filter skipped — GOOGLE_MAPS_API_KEY not configured; used geographic radius only.";
  }

  return {
    origin,
    date_from,
    date_to,
    radius_miles: radius,
    disambiguation,
    routing_note,
    count: driveFiltered.length,
    games: driveFiltered,
  };
}

async function getTravelTimes(args, ctx) {
  const origin = args.origin;
  const dests = args.destinations_or_route_stops || args.destinations || [];
  if (!origin || !dests.length) return { error: "origin and destinations required" };
  const results = [];
  for (const d of dests) {
    if (origin.facility_id && d.facility_id && origin.facility_id === d.facility_id) {
      results.push({
        to: d,
        mode: "walk",
        minutes: ctx.walkMinutes ?? DEFAULT_WALK_MINUTES,
        note: "Same facility transition (approximate)",
      });
      continue;
    }
    const t = await travelMinutesBetween(origin, d, ctx.mapsApiKey);
    results.push({
      to: d,
      mode: "drive",
      minutes: t.minutes,
      unavailable: t.unavailable,
      note: t.note,
    });
  }
  return { results, provider_configured: !!ctx.mapsApiKey };
}

async function proposeClubItinerary(args, ctx) {
  const ids = args.candidate_game_ids || [];
  const locked = args.locked_game_ids || [];
  const games = [];
  for (const id of ids) {
    const g = await ctx.db.getGameDetails(id);
    if (g) games.push(enrichGame(g));
  }
  if (!games.length) return { error: "No candidate games found", proposal: null };

  const stops = games.map((g) => ({
    game_id: g.game_id,
    facility_id: g.facility_id || null,
    field_id: null,
    lat: g.lat,
    lng: g.lng,
    kickoff_at: g.kickoff_at,
    visit_minutes: args.viewing_minutes || 30,
    locked: locked.includes(g.game_id),
    label: `${g.home_team} vs ${g.away_team}`,
    team_line: `${g.home_team} vs ${g.away_team}`,
    brighton_line: (g.brighton_players || []).map((p) => p.name).join(", "),
    facility_name: g.facility,
    field_label: g.field,
  }));

  // Build crude travel matrix when possible
  const matrix = {};
  if (ctx.mapsApiKey) {
    for (let i = 0; i < stops.length; i++) {
      for (let j = 0; j < stops.length; j++) {
        if (i === j) continue;
        if (stops[i].facility_id && stops[i].facility_id === stops[j].facility_id) {
          matrix[`${stops[i].game_id}>${stops[j].game_id}`] = ctx.walkMinutes ?? DEFAULT_WALK_MINUTES;
        } else {
          const t = await travelMinutesBetween(stops[i], stops[j], ctx.mapsApiKey);
          if (t.minutes != null) matrix[`${stops[i].game_id}>${stops[j].game_id}`] = t.minutes;
        }
      }
    }
  }

  const ordered = proposeOrder(stops, locked, matrix);
  const legs = await buildLegs(ordered, {
    walkMinutes: ctx.walkMinutes ?? DEFAULT_WALK_MINUTES,
    travelMinutes: async (from, to) => {
      const key = `${from.game_id}>${to.game_id}`;
      if (matrix[key] != null) return { minutes: matrix[key] };
      return travelMinutesBetween(from, to, ctx.mapsApiKey);
    },
  });
  const { stops: timed, warnings } = assessFeasibility(ordered, legs, {
    defaultVisitMinutes: args.viewing_minutes || 30,
  });

  return {
    proposal: {
      ordered_game_ids: timed.map((s) => s.game_id),
      stops: timed,
      legs,
      warnings,
      reasoning:
        "Ordered by kickoff with locked stops preserved; drive times from routing provider when available. Coach must accept before saving.",
    },
  };
}

async function getSavedItinerary(args, ctx) {
  const itin = await ctx.db.getItinerary(args.itinerary_id);
  if (!itin) return { error: "Itinerary not found" };
  return { itinerary: itin };
}

async function listItineraries(ctx) {
  const list = await ctx.db.listItineraries();
  return { itineraries: list };
}

/** Gemini plan: choose tools then narrate. */
export function buildPlannerSystemPrompt() {
  return `You are assisting Brighton High School soccer coaches with the Club Player Visitation Planner.

Rules:
- Never invent games, kickoff times, venues, player names, or drive times.
- Use tools for all factual schedule/travel answers. If a tool returns an error or empty set, say so.
- Prefer disambiguation when multiple players or places match.
- Club players are separate from shot-tracker players. They may appear on home and/or away; always consider both sides.
- shot_player_name is set only when a coach has linked that club player to Shot Tracker. Do not invent a link.
- Itinerary proposals are suggestions only — the coach must confirm before saving.
- Keep answers concise and coach-friendly. Use local America/Denver times from tool data.
- When travel is unavailable, say "travel time unavailable" — do not estimate from distance.
- Minimize student personal data in your wording; use first names / short names from tool results.`;
}

export function buildToolCatalogPrompt() {
  return `Available tools (call by returning JSON):
${TOOL_NAMES.map((n) => `- ${n}`).join("\n")}

To call tools, respond with ONLY JSON:
{"tool_calls":[{"name":"search_club_games","arguments":{...}}]}

After tool results are provided, answer the coach in markdown.`;
}
