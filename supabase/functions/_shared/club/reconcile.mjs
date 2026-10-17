/**
 * Idempotent fixture reconciliation + manual-override protection.
 * Pure functions — callers persist results.
 */

const MATERIAL_FIELDS = [
  "kickoff_at",
  "status",
  "club_facility_id",
  "club_field_id",
  "home_team_id",
  "away_team_id",
];

export { MATERIAL_FIELDS };

export function overrideSet(game) {
  const raw = game?.manual_overrides;
  if (!raw || typeof raw !== "object") return new Set();
  if (Array.isArray(raw.fields)) return new Set(raw.fields.map(String));
  if (Array.isArray(raw)) return new Set(raw.map(String));
  return new Set(Object.keys(raw).filter((k) => raw[k]));
}

export function fieldProtected(game, field) {
  return overrideSet(game).has(field) || !!(game?.coach_verified_at && overrideSet(game).size === 0 && MATERIAL_FIELDS.includes(field) && game.coach_verified_at);
}

/** When coach_verified_at is set with empty overrides, protect all material fields. */
export function isFieldLocked(game, field) {
  const ov = overrideSet(game);
  if (ov.has(field)) return true;
  if (game?.coach_verified_at && ov.size === 0) return MATERIAL_FIELDS.includes(field);
  return false;
}

export function valuesEqual(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === "string" && typeof b === "string") {
    // Compare timestamptz as ms when both parse as dates
    if (/^\d{4}-\d{2}-\d{2}T/.test(a) && /^\d{4}-\d{2}-\d{2}T/.test(b)) {
      return new Date(a).getTime() === new Date(b).getTime();
    }
    return a === b;
  }
  return a === b;
}

/**
 * Merge incoming parsed event into an existing game.
 * Returns { action: 'unchanged'|'updated'|'conflict', patch, changes, conflicts }
 */
export function mergeGameUpdate(existing, incoming) {
  const patch = {};
  const changes = [];
  const conflicts = [];
  const oldValues = {};
  const newValues = {};

  for (const field of MATERIAL_FIELDS) {
    if (!(field in incoming) || incoming[field] === undefined) continue;
    const next = incoming[field];
    const prev = existing[field] ?? null;
    if (valuesEqual(prev, next)) continue;
    if (isFieldLocked(existing, field)) {
      conflicts.push({ field, old: prev, incoming: next });
      continue;
    }
    patch[field] = next;
    oldValues[field] = prev;
    newValues[field] = next;
    changes.push(field);
  }

  // Non-material informational fields
  for (const field of ["round_title", "source_attribution", "ends_at", "duration_minutes", "raw_home_label", "raw_away_label"]) {
    if (incoming[field] !== undefined && !valuesEqual(existing[field], incoming[field]) && !isFieldLocked(existing, field)) {
      patch[field] = incoming[field];
    }
  }

  if (conflicts.length && !changes.length) {
    return { action: "conflict", patch: {}, changes: [], conflicts, oldValues: {}, newValues: {} };
  }
  if (!changes.length && !Object.keys(patch).length) {
    return { action: "unchanged", patch: {}, changes: [], conflicts, oldValues: {}, newValues: {} };
  }
  return {
    action: conflicts.length ? "conflict" : "updated",
    patch,
    changes,
    conflicts,
    oldValues,
    newValues,
  };
}

/**
 * Match a parsed event to candidates.
 * Prefer external_id via source links; else composite heuristic.
 */
export function scoreCompositeMatch(parsed, game, windowMinutes = 90) {
  let score = 0;
  const reasons = [];
  if (parsed.home_team_id && parsed.away_team_id && game.home_team_id && game.away_team_id) {
    const same =
      (parsed.home_team_id === game.home_team_id && parsed.away_team_id === game.away_team_id) ||
      (parsed.home_team_id === game.away_team_id && parsed.away_team_id === game.home_team_id);
    if (same) {
      score += 40;
      reasons.push("teams");
    } else {
      return { score: 0, reasons: ["team_mismatch"] };
    }
  }
  if (parsed.club_competition_id && game.club_competition_id === parsed.club_competition_id) {
    score += 15;
    reasons.push("competition");
  }
  if (parsed.kickoff_at && game.kickoff_at) {
    const delta = Math.abs(new Date(parsed.kickoff_at).getTime() - new Date(game.kickoff_at).getTime());
    const mins = delta / 60000;
    if (mins <= 15) {
      score += 35;
      reasons.push("kickoff_close");
    } else if (mins <= windowMinutes) {
      score += 20;
      reasons.push("kickoff_window");
    } else {
      score -= 20;
      reasons.push("kickoff_far");
    }
  } else if (!parsed.kickoff_at && !game.kickoff_at) {
    score += 5;
    reasons.push("both_tbd_time");
  }
  if (parsed.club_facility_id && game.club_facility_id === parsed.club_facility_id) {
    score += 10;
    reasons.push("facility");
  }
  return { score, reasons };
}

export function pickBestMatch(parsed, candidates, minScore = 55) {
  let best = null;
  for (const game of candidates || []) {
    const { score, reasons } = scoreCompositeMatch(parsed, game);
    if (!best || score > best.score) best = { game, score, reasons };
  }
  if (!best || best.score < minScore) return { match: null, review: best };
  return { match: best.game, review: best };
}

/**
 * Absence policy: do not cancel/delete merely because one sync missed an event.
 */
export function shouldCancelFromAbsence() {
  return false;
}

/** Dedupe Brighton player list by player_id. */
export function uniquePlayers(list) {
  const seen = new Set();
  const out = [];
  for (const p of list || []) {
    const id = p.player_id || p.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(p);
  }
  return out;
}

export function playersOnBothSides(homePlayers, awayPlayers) {
  return (homePlayers || []).length > 0 && (awayPlayers || []).length > 0;
}
