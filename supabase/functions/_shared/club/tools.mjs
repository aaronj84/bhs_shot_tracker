/**
 * Deterministic tool handlers for club-visitation Gemini agent.
 */

import {
  addDaysIso,
  endOfLocalDayUtc,
  localDateInTz,
  normalizeName,
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
    facility_id: row.facility_id || row.club_facility_id || null,
    field: row.field_label,
    address: row.street_address || null,
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

function isIsoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function hasTimeClue(text) {
  return /\b(today|tomorrow|saturday|sunday|weekend|week|upcoming|january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\b|\b20\d{2}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\b|\b\d{1,2}(?:st|nd|rd|th)\b/.test(
    String(text || "").toLowerCase()
  );
}

function clueText(ctx) {
  return [ctx?.question, ctx?.historyText].filter(Boolean).join("\n");
}

function normalizeDateWindow(date_from, date_to) {
  if (isIsoDate(date_from) && isIsoDate(date_to) && date_from > date_to) {
    return { date_from: date_to, date_to: date_from };
  }
  return { date_from, date_to };
}

/** Dates and filters come from the question, not the agenda screen. */
function resolveAskedWindow(args, ctx) {
  const clue = String(clueText(ctx) || args.relative || "").trim();
  if (clue && hasTimeClue(clue)) {
    const w = parseRelativeDateWindow(clue, CLUB_TZ, ctx?.now);
    return normalizeDateWindow(w.date_from, w.date_to);
  }
  if (isIsoDate(args.date_from) && isIsoDate(args.date_to)) {
    return normalizeDateWindow(args.date_from, args.date_to);
  }
  const w = parseRelativeDateWindow(clue || "upcoming", CLUB_TZ, ctx?.now);
  return normalizeDateWindow(w.date_from, w.date_to);
}

const SKIP_WORDS = new Set([
  "the", "to", "on", "at", "vs", "game", "team", "from", "there", "watch", "going", "gonna",
  "have", "time", "drive", "driving", "next", "saturday", "sunday", "this", "that", "with",
  "for", "and", "how", "long", "will", "it", "me", "do", "alright", "im", "i", "a", "an",
  "of", "in", "my", "you", "your", "against", "both", "make",
]);

function questionTeamPhrases(question) {
  const words = normalizeName(question)
    .split(" ")
    .filter((word) => word && !SKIP_WORDS.has(word) && !/^\d/.test(word));
  const phrases = [];
  for (let i = 0; i < words.length - 1; i++) {
    const phrase = `${words[i]} ${words[i + 1]}`;
    if (phrase.length >= 5) phrases.push(phrase);
  }
  return phrases;
}

function rowMatchesTeamPhrase(row, phrase) {
  return (
    normalizeName(row.home_team_name).includes(phrase) || normalizeName(row.away_team_name).includes(phrase)
  );
}

function asksAboutDrive(question) {
  return /\b(drive|driving|how long|time to)\b/i.test(String(question || ""));
}

function mentionedPlayerNeedles(question, rows) {
  const q = ` ${normalizeName(question)} `;
  const needles = new Set();
  for (const row of rows) {
    const people = [...(row.home_brighton_players || []), ...(row.away_brighton_players || [])];
    for (const person of people) {
      for (const raw of [person.short_name, person.name, person.full_name]) {
        const name = normalizeName(raw);
        const first = name.split(" ")[0];
        if (first && first.length >= 3 && q.includes(` ${first} `)) needles.add(first);
      }
    }
  }
  return needles;
}

function rowHasNamedPlayer(row, needles) {
  const people = [...(row.home_brighton_players || []), ...(row.away_brighton_players || [])];
  return people.some((person) => {
    const names = [person.name, person.short_name, person.full_name].map(normalizeName);
    return [...needles].some((needle) => names.some((name) => name === needle || name.startsWith(`${needle} `)));
  });
}

function rowMatchesPlayerName(row, playerName) {
  const needle = normalizeName(playerName);
  if (!needle) return true;
  const people = [...(row.home_brighton_players || []), ...(row.away_brighton_players || [])];
  return people.some((p) => {
    const names = [p.full_name, p.name, p.short_name].map(normalizeName);
    return names.some((n) => n && (n === needle || n.includes(needle)));
  });
}

async function searchClubGames(args, ctx) {
  const window = resolveAskedWindow(args, ctx);
  const date_from = window.date_from;
  const date_to = window.date_to;
  const allRows = await loadAgendaRows(ctx, {
    date_from,
    date_to,
    player_ids: args.player_ids,
    team_ids: args.team_ids,
    competition_ids: args.competitions || args.competition_ids,
    facility_id: args.facility_id,
    city: args.city_or_area,
    include_cancelled: !!args.include_cancelled,
    both_sides: !!args.both_sides,
    brighton_only: args.brighton_only === true,
  });
  let rows = allRows;
  if (args.player_name) rows = rows.filter((row) => rowMatchesPlayerName(row, args.player_name));
  if (args.team_name) {
    const team = normalizeName(args.team_name);
    rows = rows.filter((row) => rowMatchesTeamPhrase(row, team));
  }
  const clue = clueText(ctx);
  const mentioned = questionTeamPhrases(clue);
  const playerNeedles = mentionedPlayerNeedles(clue, allRows);
  if (mentioned.length || playerNeedles.size) {
    const seen = new Set(rows.map((row) => row.id || row.club_game_id));
    for (const row of allRows) {
      const id = row.id || row.club_game_id;
      if (seen.has(id)) continue;
      const teamHit = mentioned.some((phrase) => rowMatchesTeamPhrase(row, phrase));
      const playerHit = playerNeedles.size && rowHasNamedPlayer(row, playerNeedles);
      if (!teamHit && !playerHit) continue;
      rows.push(row);
      seen.add(id);
    }
  }
  const games = rows
    .map(enrichGame)
    .sort((a, b) => String(a.kickoff_at || "").localeCompare(String(b.kickoff_at || "")));
  let travel = null;
  if (asksAboutDrive(clue) && games.length >= 2) {
    travel = [];
    for (let i = 0; i < games.length - 1; i++) {
      const leg = await travelMinutesBetween(games[i], games[i + 1], ctx.mapsApiKey);
      travel.push({
        from_game_id: games[i].game_id,
        to_game_id: games[i + 1].game_id,
        from_place: games[i].facility,
        to_place: games[i + 1].facility,
        minutes: leg.minutes,
        unavailable: !!leg.unavailable,
        note: leg.note || (leg.same_facility ? "Same facility" : null),
      });
    }
  }
  return {
    date_from,
    date_to,
    count: games.length,
    games,
    travel,
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

  const w = resolveAskedWindow(
    {
      date_from: args.date_window?.date_from || args.date_from,
      date_to: args.date_window?.date_to || args.date_to,
      relative: args.relative,
    },
    ctx
  );
  const date_from = w.date_from || localDateInTz();
  const date_to = w.date_to || date_from;
  const rows = await loadAgendaRows(ctx, {
    date_from,
    date_to,
    include_cancelled: false,
    brighton_only: args.brighton_only === true,
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
    routing_note =
      "Drive-time filter skipped — OPENROUTESERVICE_API_KEY not configured; used geographic radius only.";
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

async function resolveTravelPoint(raw, ctx) {
  if (!raw) return null;
  if (typeof raw === "string") {
    const g = await ctx.db.getGameDetails(raw);
    return g ? enrichGame(g) : null;
  }
  if (raw.game_id || raw.club_game_id || raw.id) {
    if (raw.lat != null && raw.lng != null) {
      return {
        ...raw,
        game_id: raw.game_id || raw.club_game_id || raw.id,
        facility: raw.facility || raw.facility_name || null,
      };
    }
    const g = await ctx.db.getGameDetails(raw.game_id || raw.club_game_id || raw.id);
    return g ? enrichGame(g) : null;
  }
  if (raw.lat != null && raw.lng != null) return raw;
  return null;
}

async function getTravelTimes(args, ctx) {
  let origin = await resolveTravelPoint(args.origin || args.origin_game_id, ctx);
  let dests = args.destinations_or_route_stops || args.destinations || args.destination_game_ids || [];
  if (!dests.length && args.destination_game_id) dests = [args.destination_game_id];
  if (!Array.isArray(dests)) dests = [dests];
  dests = (await Promise.all(dests.map((d) => resolveTravelPoint(d, ctx)))).filter(Boolean);

  if (!origin || !dests.length) {
    return {
      error: "origin and destinations required",
      hint: "Pass origin/destinations with lat/lng, or origin_game_id + destination_game_id from search results",
    };
  }

  const results = [];
  for (const d of dests) {
    if (origin.facility_id && d.facility_id && origin.facility_id === d.facility_id) {
      results.push({
        from_game_id: origin.game_id || null,
        to_game_id: d.game_id || null,
        from_place: origin.facility || origin.facility_name || null,
        to_place: d.facility || d.facility_name || null,
        to: d,
        mode: "walk",
        minutes: ctx.walkMinutes ?? DEFAULT_WALK_MINUTES,
        note: "Same facility transition (approximate)",
      });
      continue;
    }
    const t = await travelMinutesBetween(origin, d, ctx.mapsApiKey);
    results.push({
      from_game_id: origin.game_id || null,
      to_game_id: d.game_id || null,
      from_place: origin.facility || origin.facility_name || null,
      to_place: d.facility || d.facility_name || null,
      to: d,
      mode: "drive",
      minutes: t.minutes,
      unavailable: t.unavailable,
      note: t.note,
    });
  }
  return {
    results,
    provider_configured: !!ctx.mapsApiKey,
    origin: {
      game_id: origin.game_id || null,
      facility: origin.facility || origin.facility_name || null,
      kickoff_at: origin.kickoff_at || null,
      lat: origin.lat,
      lng: origin.lng,
    },
  };
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
- Never write "Unavailable" for kickoff or facility when tool results include those fields — copy kickoff_at and facility from the JSON.
- Minimize student personal data in your wording; use first names / short names from tool results.

When listing games (especially ones the coach named by player), use this markdown shape — put each game_id in backticks alone, never inside parentheses:

1. **FirstName** \`game_id-here\`
   - **Kickoff:** 1:00 PM
   - **Facility:** Butler M.S.
   - **Includes:** OtherName, AnotherName

- Title the game with the player the coach asked about (first/short name). Close bold around the name only: **Calvin** then a space then \`game_id\`.
- **Includes:** lists other Brighton players at that same game (from brighton_players), excluding the titled player. Omit the Includes line when there are no others.
- Do not write empty parentheses. Do not write "Game ID".`;
}

export function buildToolCatalogPrompt() {
  return `Available tools (call by returning JSON):
${TOOL_NAMES.map((n) => `- ${n}`).join("\n")}

Build search_club_games arguments from the coach's words only. Ignore the agenda screen's date range, player menu, and "players on both teams" checkbox.

search_club_games arguments:
- date_from, date_to: YYYY-MM-DD in America/Denver, taken from the question. date_from must be ≤ date_to. "Saturday" is the coming Saturday. "this weekend" is Saturday through Sunday. "10/24" or "October 24" is that calendar day. Use the next 7 days only when the question has no day or date.
- player_name: a name they mentioned, otherwise omit.
- team_name: a team they mentioned, otherwise omit.
- city_or_area: a city or area they mentioned, otherwise omit.
- both_sides: true only when they ask for players on both teams.
- Do not set a filter the question did not ask for.

get_travel_times arguments (prefer game ids from prior search results):
- origin_game_id + destination_game_id, OR
- origin: {lat, lng} and destinations: [{lat, lng}, ...]

To call tools, respond with ONLY JSON:
{"tool_calls":[{"name":"search_club_games","arguments":{"date_from":"YYYY-MM-DD","date_to":"YYYY-MM-DD"}}]}

After tool results are provided, answer the coach in markdown.`;
}
