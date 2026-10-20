/**
 * Fetch + parse + reconcile one schedule source.
 * `db` is a thin interface used by the Edge Function and unit tests.
 */

import { parseIcs } from "./ics.mjs";
import { csvToEvents } from "./parse-csv.mjs";
import { parseHtmlSchedule } from "./parse-html.mjs";
import { parseJsonSchedule } from "./parse-json.mjs";
import { mergeGameUpdate, pickBestMatch, shouldCancelFromAbsence } from "./reconcile.mjs";
import { normalizeName, teamMatchesRecord } from "./normalize.mjs";

export const PARSER_VERSION = "club-sync-1";

export function parseByProvider(provider, bodyText, parserConfig) {
  const p = String(provider || "other").toLowerCase();
  if (p === "manual") {
    return { events: [], errors: [], unsupported: false, skipped: true };
  }
  if (p === "ics") return parseIcs(bodyText);
  if (p === "csv") return csvToEvents(bodyText, parserConfig || {});
  if (p === "json") return parseJsonSchedule(bodyText, parserConfig || {});
  if (p === "html") return parseHtmlSchedule(bodyText, parserConfig || {});
  return {
    events: [],
    errors: [`Unsupported provider "${provider}"`],
    unsupported: true,
  };
}

export async function fetchSource(url, fetchImpl = fetch) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: "text/calendar, text/csv, application/json, text/html, */*" },
      redirect: "follow",
    });
    const text = await res.text();
    if (res.status === 429) {
      return { ok: false, status: 429, error: "Rate limited (429)", text: "" };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}`, text };
    }
    return { ok: true, status: res.status, text, error: null };
  } catch (e) {
    return { ok: false, status: 0, error: e?.name === "AbortError" ? "Timeout" : String(e?.message || e), text: "" };
  } finally {
    clearTimeout(t);
  }
}

function resolveTeamId(label, teams) {
  if (!label) return null;
  for (const t of teams) {
    if (teamMatchesRecord(label, t)) return t.id;
  }
  return null;
}

function resolveFacility(label, facilities) {
  if (!label) return null;
  const n = normalizeName(label);
  for (const f of facilities) {
    if (normalizeName(f.name) === n) return f;
    if ((f.aliases || []).some((a) => normalizeName(a) === n)) return f;
    // partial: "RAC Field 5" → facility RAC
    if (n.includes(normalizeName(f.name)) || normalizeName(f.name).includes(n)) return f;
  }
  return null;
}

function resolveField(label, facility, fields) {
  if (!label || !facility) return null;
  const n = normalizeName(label);
  const candidates = (fields || []).filter((f) => f.club_facility_id === facility.id);
  for (const f of candidates) {
    if (normalizeName(f.label) === n) return f;
    if (n.includes(normalizeName(f.label))) return f;
  }
  // "Field 5" pattern
  const m = n.match(/field\s*(\d+[a-z]?)/i);
  if (m) {
    const want = normalizeName(`Field ${m[1]}`);
    return candidates.find((f) => normalizeName(f.label) === want) || null;
  }
  return null;
}

/**
 * db methods expected:
 *   getSource(id), listTeams(), listFacilities(), listFields(), listGamesForTeams(ids),
 *   findSourceLink(sourceId, externalId), insertGame(row), updateGame(id, patch),
 *   upsertSourceLink(...), insertChange(...), insertSyncRun / finishSyncRun,
 *   updateSourceStatus(...)
 */
export async function runSourceSync(db, source, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const started = new Date().toISOString();
  const run = await db.insertSyncRun({
    club_schedule_source_id: source.id,
    started_at: started,
    result: "running",
    parser_version: PARSER_VERSION,
  });

  const counts = { seen: 0, inserted: 0, updated: 0, unchanged: 0, flagged: 0 };

  try {
    if (String(source.provider).toLowerCase() === "manual") {
      await db.finishSyncRun(run.id, {
        result: "ok",
        finished_at: new Date().toISOString(),
        ...countFields(counts),
      });
      await db.updateSourceStatus(source.id, {
        sync_status: "ok",
        last_success_at: new Date().toISOString(),
        last_attempt_at: new Date().toISOString(),
        last_error: null,
        next_check_at: nextCheckIso(source),
      });
      return { ok: true, counts, run_id: run.id, skipped: true };
    }

    const fetched = await fetchSource(source.source_url, fetchImpl);
    await db.updateSourceStatus(source.id, { last_attempt_at: new Date().toISOString(), sync_status: "running" });
    if (!fetched.ok) {
      await db.finishSyncRun(run.id, {
        result: "error",
        finished_at: new Date().toISOString(),
        error_detail: fetched.error,
        ...countFields(counts),
      });
      await db.updateSourceStatus(source.id, {
        sync_status: "error",
        last_error: fetched.error,
        next_check_at: nextCheckIso(source, true),
      });
      return { ok: false, error: fetched.error, counts, run_id: run.id };
    }

    const parsed = parseByProvider(source.provider, fetched.text, source.parser_config || {});
    if (parsed.unsupported) {
      const msg = (parsed.errors || []).join("; ") || "Unsupported format";
      await db.finishSyncRun(run.id, {
        result: "unsupported",
        finished_at: new Date().toISOString(),
        error_detail: msg,
        ...countFields(counts),
      });
      await db.updateSourceStatus(source.id, {
        sync_status: "unsupported",
        last_error: msg,
        next_check_at: nextCheckIso(source, true),
      });
      return { ok: false, unsupported: true, error: msg, counts, run_id: run.id };
    }

    const teams = await db.listTeams();
    const facilities = await db.listFacilities();
    const fields = await db.listFields();
    const teamIds = new Set();
    // Scope: team from team_competition
    if (source.club_team_id) teamIds.add(source.club_team_id);

    const events = parsed.events || [];
    counts.seen = events.length;

    for (const ev of events) {
      const homeId = resolveTeamId(ev.raw_home_label, teams);
      const awayId = resolveTeamId(ev.raw_away_label, teams);
      if (homeId) teamIds.add(homeId);
      if (awayId) teamIds.add(awayId);

      // Filter: if parser_config.team_filter, require our team on one side
      const filterTeam = source.parser_config?.team_filter_id || source.club_team_id;
      if (filterTeam && homeId !== filterTeam && awayId !== filterTeam) {
        // Still allow if labels mention team name
        const our = teams.find((t) => t.id === filterTeam);
        const labelHit =
          our &&
          (teamMatchesRecord(ev.raw_home_label, our) || teamMatchesRecord(ev.raw_away_label, our));
        if (!labelHit && homeId == null && awayId == null) {
          /* keep — may be unresolved labels */
        } else if (!labelHit && homeId !== filterTeam && awayId !== filterTeam) {
          continue;
        }
      }

      const facility = resolveFacility(ev.venue_label, facilities);
      const field = resolveField(ev.field_label || ev.venue_label, facility, fields);

      const incoming = {
        home_team_id: homeId,
        away_team_id: awayId,
        raw_home_label: ev.raw_home_label,
        raw_away_label: ev.raw_away_label,
        kickoff_at: ev.kickoff_at,
        status: normalizeStatus(ev.status),
        club_facility_id: facility?.id || null,
        club_field_id: field?.id || null,
        club_competition_id: source.club_competition_id || null,
        source_attribution: source.source_url,
        round_title: ev.summary || null,
      };

      let game = null;
      if (ev.external_id) {
        const link = await db.findSourceLink(source.id, String(ev.external_id));
        if (link?.club_game_id) {
          game = await db.getGame(link.club_game_id);
        }
      }
      if (!game) {
        const candidates = await db.listGamesForTeams([...teamIds]);
        const { match } = pickBestMatch(incoming, candidates);
        game = match;
      }

      if (!game) {
        const created = await db.insertGame({
          ...incoming,
          last_seen_at: new Date().toISOString(),
          external_fixture_key: ev.external_id || null,
        });
        await db.upsertSourceLink({
          club_game_id: created.id,
          club_schedule_source_id: source.id,
          external_id: ev.external_id ? String(ev.external_id) : `gen-${created.id}`,
          parse_confidence: ev.parse_confidence ?? null,
          last_seen_at: new Date().toISOString(),
        });
        counts.inserted++;
        continue;
      }

      const merge = mergeGameUpdate(game, incoming);
      if (merge.action === "unchanged") {
        await db.updateGame(game.id, { last_seen_at: new Date().toISOString() });
        counts.unchanged++;
      } else if (merge.action === "updated" || merge.action === "conflict") {
        if (Object.keys(merge.patch).length) {
          await db.updateGame(game.id, {
            ...merge.patch,
            last_seen_at: new Date().toISOString(),
          });
          await db.insertChange({
            club_game_id: game.id,
            changed_fields: merge.changes,
            old_values: merge.oldValues,
            new_values: merge.newValues,
            source: source.source_url,
            club_sync_run_id: run.id,
            review_status: "new",
          });
          counts.updated++;
        } else {
          counts.unchanged++;
        }
        if (merge.conflicts?.length) {
          await db.insertChange({
            club_game_id: game.id,
            changed_fields: merge.conflicts.map((c) => c.field),
            old_values: Object.fromEntries(merge.conflicts.map((c) => [c.field, c.old])),
            new_values: Object.fromEntries(merge.conflicts.map((c) => [c.field, c.incoming])),
            source: source.source_url,
            club_sync_run_id: run.id,
            review_status: "conflict",
          });
          counts.flagged++;
        }
      }

      if (ev.external_id) {
        await db.upsertSourceLink({
          club_game_id: game.id,
          club_schedule_source_id: source.id,
          external_id: String(ev.external_id),
          parse_confidence: ev.parse_confidence ?? null,
          last_seen_at: new Date().toISOString(),
        });
      }
    }

    // Absence: intentionally do not cancel
    void shouldCancelFromAbsence;

    const result = (parsed.errors || []).length ? "partial" : "ok";
    await db.finishSyncRun(run.id, {
      result,
      finished_at: new Date().toISOString(),
      error_detail: (parsed.errors || []).join("; ") || null,
      ...countFields(counts),
    });
    await db.updateSourceStatus(source.id, {
      sync_status: result === "ok" ? "ok" : "error",
      last_success_at: result === "ok" || result === "partial" ? new Date().toISOString() : undefined,
      last_error: (parsed.errors || []).join("; ") || null,
      next_check_at: nextCheckIso(source),
    });
    return { ok: true, counts, run_id: run.id, parse_errors: parsed.errors || [] };
  } catch (e) {
    const msg = String(e?.message || e);
    await db.finishSyncRun(run.id, {
      result: "error",
      finished_at: new Date().toISOString(),
      error_detail: msg,
      ...countFields(counts),
    });
    await db.updateSourceStatus(source.id, {
      sync_status: "error",
      last_error: msg,
      last_attempt_at: new Date().toISOString(),
      next_check_at: nextCheckIso(source, true),
    });
    return { ok: false, error: msg, counts, run_id: run.id };
  }
}

function countFields(c) {
  return {
    seen_count: c.seen,
    inserted_count: c.inserted,
    updated_count: c.updated,
    unchanged_count: c.unchanged,
    flagged_count: c.flagged,
  };
}

function normalizeStatus(s) {
  const u = String(s || "scheduled").toLowerCase();
  if (["scheduled", "postponed", "cancelled", "completed", "tbd"].includes(u)) return u;
  if (u.includes("cancel")) return "cancelled";
  if (u.includes("postpon")) return "postponed";
  return "scheduled";
}

function nextCheckIso(source, errored = false) {
  const hours = errored ? 12 : 6;
  return new Date(Date.now() + hours * 3600000).toISOString();
}
