/**
 * Itinerary sequencing, feasibility, and copyable summary.
 */

import { formatLocalKickoff, mapsDirectionsUrl } from "./normalize.mjs";

/** Typical club-game block on calendar / at the field (kickoff window). */
export const DEFAULT_VISIT_MINUTES = 105;
export const DEFAULT_WALK_MINUTES = 8;
export const TIGHT_BUFFER_MINUTES = 5;

/**
 * @typedef {{ facility_id?: string|null, field_id?: string|null, lat?: number|null, lng?: number|null, kickoff_at?: string|null, visit_minutes?: number|null, locked?: boolean, game_id: string, label?: string }} StopInput
 * @typedef {{ minutes?: number|null, mode: 'drive'|'walk'|'unknown', unavailable?: boolean, note?: string }} Leg
 */

export function sameFacility(a, b) {
  if (!a?.facility_id || !b?.facility_id) return false;
  return a.facility_id === b.facility_id;
}

/**
 * Build legs between ordered stops using a travelMinutes(from,to) async/sync fn
 * that returns { minutes, unavailable?, note? } for inter-facility drives.
 */
export async function buildLegs(stops, opts = {}) {
  const walk = opts.walkMinutes ?? DEFAULT_WALK_MINUTES;
  const travelFn = opts.travelMinutes || (async () => ({ minutes: null, unavailable: true }));
  const legs = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const from = stops[i];
    const to = stops[i + 1];
    if (sameFacility(from, to)) {
      legs.push({
        from_index: i,
        to_index: i + 1,
        mode: "walk",
        minutes: walk,
        note: "Same facility — approximate walk / field transition",
        unavailable: false,
      });
      continue;
    }
    if (from.lat == null || from.lng == null || to.lat == null || to.lng == null) {
      legs.push({
        from_index: i,
        to_index: i + 1,
        mode: "unknown",
        minutes: null,
        unavailable: true,
        note: "Missing coordinates — travel time unavailable",
      });
      continue;
    }
    const t = await travelFn(from, to);
    legs.push({
      from_index: i,
      to_index: i + 1,
      mode: "drive",
      minutes: t?.minutes ?? null,
      unavailable: !!(t?.unavailable || t?.minutes == null),
      note: t?.note || (t?.minutes == null ? "Routing unavailable" : "Estimated drive time"),
    });
  }
  return legs;
}

/**
 * Assign planned arrival/departure and flag conflicts.
 * Arrival aims for kickoff − small buffer, but respects previous departure + travel.
 */
export function assessFeasibility(stops, legs, opts = {}) {
  const visitDefault = opts.defaultVisitMinutes ?? DEFAULT_VISIT_MINUTES;
  const warnings = [];
  const timed = stops.map((s, i) => ({
    ...s,
    index: i,
    visit_minutes: s.visit_minutes ?? visitDefault,
    planned_arrival_at: null,
    planned_departure_at: null,
  }));

  let cursor = null; // Date ms when coach is free after previous stop
  if (opts.startTime) cursor = new Date(opts.startTime).getTime();

  for (let i = 0; i < timed.length; i++) {
    const stop = timed[i];
    const kick = stop.kickoff_at ? new Date(stop.kickoff_at).getTime() : null;
    let arriveMs = kick != null ? kick - TIGHT_BUFFER_MINUTES * 60000 : cursor;

    if (i > 0) {
      const leg = legs[i - 1];
      const prev = timed[i - 1];
      const prevDep = prev.planned_departure_at
        ? new Date(prev.planned_departure_at).getTime()
        : cursor;
      if (leg?.unavailable || leg?.minutes == null) {
        warnings.push({
          type: "missing_route",
          from: i - 1,
          to: i,
          message: `Travel time unknown between stop ${i} and ${i + 1} — feasibility unverified`,
        });
      } else if (prevDep != null) {
        const earliest = prevDep + leg.minutes * 60000;
        if (arriveMs == null || earliest > arriveMs) arriveMs = earliest;
        if (kick != null && earliest > kick + 15 * 60000) {
          warnings.push({
            type: "impossible",
            from: i - 1,
            to: i,
            message: `Cannot reach stop ${i + 1} before kickoff given prior visit + travel`,
          });
        } else if (kick != null && earliest > kick - TIGHT_BUFFER_MINUTES * 60000) {
          warnings.push({
            type: "tight",
            from: i - 1,
            to: i,
            message: `Tight timing into stop ${i + 1} (arrive near/at kickoff)`,
          });
        }
      }
    }

    if (arriveMs != null) {
      stop.planned_arrival_at = new Date(arriveMs).toISOString();
      stop.planned_departure_at = new Date(arriveMs + stop.visit_minutes * 60000).toISOString();
      cursor = new Date(stop.planned_departure_at).getTime();
    } else if (kick != null) {
      warnings.push({
        type: "unknown_kickoff_window",
        to: i,
        message: `Stop ${i + 1} has limited timing data`,
      });
    }
  }

  return { stops: timed, warnings };
}

/** Bounded heuristic: keep locked stops in relative order; permute unlocked for player coverage vs drive. */
export function proposeOrder(candidateStops, lockedIds = [], travelMatrix = {}) {
  const locked = new Set(lockedIds);
  const lockedStops = candidateStops.filter((s) => locked.has(s.game_id));
  const free = candidateStops.filter((s) => !locked.has(s.game_id));

  // Sort free by kickoff when known
  free.sort((a, b) => {
    const ak = a.kickoff_at ? new Date(a.kickoff_at).getTime() : Infinity;
    const bk = b.kickoff_at ? new Date(b.kickoff_at).getTime() : Infinity;
    return ak - bk;
  });

  // Insert free around locked by kickoff interleaving
  const result = [];
  const all = [...lockedStops].sort((a, b) => {
    const ak = a.kickoff_at ? new Date(a.kickoff_at).getTime() : 0;
    const bk = b.kickoff_at ? new Date(b.kickoff_at).getTime() : 0;
    return ak - bk;
  });
  // Start from locked timeline; greedily insert free where travel is least bad
  for (const s of all) result.push(s);
  for (const f of free) {
    let bestIdx = result.length;
    let bestCost = Infinity;
    for (let i = 0; i <= result.length; i++) {
      const prev = result[i - 1];
      const next = result[i];
      let cost = 0;
      if (prev && travelMatrix[`${prev.game_id}>${f.game_id}`] != null) {
        cost += travelMatrix[`${prev.game_id}>${f.game_id}`];
      }
      if (next && travelMatrix[`${f.game_id}>${next.game_id}`] != null) {
        cost += travelMatrix[`${f.game_id}>${next.game_id}`];
      }
      // Prefer kickoff order
      if (f.kickoff_at && prev?.kickoff_at && new Date(f.kickoff_at) < new Date(prev.kickoff_at)) cost += 200;
      if (f.kickoff_at && next?.kickoff_at && new Date(f.kickoff_at) > new Date(next.kickoff_at)) cost += 200;
      if (cost < bestCost) {
        bestCost = cost;
        bestIdx = i;
      }
    }
    result.splice(bestIdx, 0, f);
  }
  return result;
}

export function formatItineraryText(itin, stops, legs, warnings, opts = {}) {
  const lines = [];
  lines.push(itin.name || "Club visitation itinerary");
  if (itin.target_date) lines.push(`Date: ${itin.target_date}`);
  if (itin.start_location_label) lines.push(`Start: ${itin.start_location_label}`);
  if (itin.notes) lines.push(`Notes: ${itin.notes}`);
  lines.push("");
  stops.forEach((s, i) => {
    const n = i + 1;
    lines.push(`${n}. ${s.team_line || s.label || "Game"}`);
    if (s.brighton_line) lines.push(`   Players: ${s.brighton_line}`);
    lines.push(`   Kickoff: ${formatLocalKickoff(s.kickoff_at, s.timezone || "America/Denver")}`);
    if (s.planned_arrival_at) {
      lines.push(`   Arrive ~ ${formatLocalKickoff(s.planned_arrival_at, s.timezone || "America/Denver")}`);
    }
    const venue = [s.facility_name, s.field_label].filter(Boolean).join(" · ") || "Venue TBD";
    lines.push(`   Venue: ${venue}`);
    if (s.lat != null && s.lng != null) {
      const url = mapsDirectionsUrl(s.lat, s.lng, venue);
      if (url) lines.push(`   Map: ${url}`);
    }
    if (s.notes) lines.push(`   Note: ${s.notes}`);
    if (i < legs.length) {
      const leg = legs[i];
      if (leg.mode === "walk") {
        lines.push(`   → Walk/transition ~${leg.minutes} min (same facility, approx)`);
      } else if (leg.unavailable || leg.minutes == null) {
        lines.push(`   → Drive: time unavailable`);
      } else {
        lines.push(`   → Drive ~${Math.round(leg.minutes)} min (estimate)`);
      }
    }
    lines.push("");
  });
  if (warnings?.length) {
    lines.push("Warnings:");
    warnings.forEach((w) => lines.push(`- ${w.message}`));
  }
  if (opts.staleWarning) {
    lines.push("");
    lines.push(`⚠ Schedule change: ${opts.staleWarning}`);
  }
  return lines.join("\n").trim() + "\n";
}

/** RFC 5545 UTC timestamp (YYYYMMDDTHHMMSSZ). */
export function icsDate(iso) {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function icsEscape(text) {
  return String(text ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

/** Fold to 75 octets per line (continuations start with a space). */
export function foldLine(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts = [];
  let cur = "";
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (curBytes + n > limit) {
      parts.push(cur);
      cur = "";
      curBytes = 0;
      limit = 74;
    }
    cur += ch;
    curBytes += n;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

export function itineraryIcsFilename(itin = {}) {
  const raw = String(itin.name || "club-visits")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${raw || "club-visits"}.ics`;
}

/** Subscribe URL for an itinerary feed_token (48 hex). Empty if base/token invalid. */
export function itineraryFeedUrl(baseUrl, token) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const tok = String(token || "");
  if (!base || !/^[0-9a-f]{48}$/.test(tok)) return "";
  return `${base}/functions/v1/club-itinerary-ics/${tok}.ics`;
}

/**
 * One VEVENT per stop for phone calendar import.
 * Uses planned arrival→departure when present; otherwise kickoff − 5m through visit window.
 *
 * @param {{ id?: string, name?: string, notes?: string, target_date?: string }} itin
 * @param {Array<object>} stops
 * @param {{ now?: Date, alertMinutes?: number, defaultVisitMinutes?: number }} [opts]
 */
export function buildItineraryIcs(itin, stops, opts = {}) {
  const now = opts.now || new Date();
  const alertMin = opts.alertMinutes ?? 15;
  const defaultVisit = opts.defaultVisitMinutes ?? DEFAULT_VISIT_MINUTES;
  const calName = itin?.name || "Club visitation";
  const itinKey = itin?.id || "draft";
  const stamp = icsDate(now.toISOString());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Brighton Soccer//Club Visitation//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(calName)}`,
    "X-WR-TIMEZONE:America/Denver",
  ];

  (stops || []).forEach((s, i) => {
    // Game blocks are at least a full match window (105m); longer visits still win.
    const visitMin = Math.max(Number(s.visit_minutes) || defaultVisit, defaultVisit);
    let startIso = s.planned_arrival_at;
    if (!startIso && s.kickoff_at) {
      startIso = new Date(new Date(s.kickoff_at).getTime() - 5 * 60000).toISOString();
    }
    if (!startIso) return;
    const endIso = new Date(new Date(startIso).getTime() + visitMin * 60000).toISOString();
    const team = s.team_line || s.label || "Club game";
    const summary = s.brighton_line ? `Visit: ${s.brighton_line} - ${team}` : `Visit: ${team}`;
    const venue = [s.facility_name, s.field_label].filter(Boolean).join(" · ") || "Venue TBD";
    const descParts = [];
    if (itin?.name) descParts.push(itin.name);
    if (s.brighton_line) descParts.push(`Players: ${s.brighton_line}`);
    descParts.push(`Match: ${team}`);
    if (s.kickoff_at) {
      descParts.push(`Kickoff: ${formatLocalKickoff(s.kickoff_at, s.timezone || "America/Denver")}`);
    }
    descParts.push(`Venue: ${venue}`);
    let mapUrl = null;
    if (s.lat != null && s.lng != null) {
      mapUrl = mapsDirectionsUrl(s.lat, s.lng, venue);
      if (mapUrl) descParts.push(`Map: ${mapUrl}`);
    }
    if (s.notes) descParts.push(s.notes);
    if (itin?.notes && i === 0) descParts.push(`Itinerary notes: ${itin.notes}`);
    const uidGame = s.game_id || s.club_game_id || `stop-${i + 1}`;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${itinKey}-${uidGame}@bhs-club-visits`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsDate(startIso)}`,
      `DTEND:${icsDate(endIso)}`,
      `SUMMARY:${icsEscape(summary)}`,
      `DESCRIPTION:${icsEscape(descParts.join("\n"))}`,
      `LOCATION:${icsEscape(venue)}`,
    );
    if (mapUrl) lines.push(`URL:${mapUrl}`);
    lines.push(
      "STATUS:CONFIRMED",
      "TRANSP:OPAQUE",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `TRIGGER:-PT${alertMin}M`,
      `DESCRIPTION:${icsEscape(summary)}`,
      "END:VALARM",
      "END:VEVENT",
    );
  });

  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** Base64 data URL for Safari / Apple Calendar import (avoids broken encodeURIComponent data: taps on iOS). */
export function icsDataUrl(ics) {
  const bytes = new TextEncoder().encode(ics);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `data:text/calendar;charset=utf-8;base64,${btoa(bin)}`;
}
