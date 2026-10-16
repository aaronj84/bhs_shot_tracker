/**
 * Supabase-backed data access for club tools + sync.
 * Works with supabase-js client (user or service role).
 */

import { startOfLocalDayUtc, endOfLocalDayUtc, addDaysIso, localDateInTz } from "./normalize.mjs";

export function createClubDb(sb) {
  return {
    async searchGames(filters = {}) {
      const today = localDateInTz();
      const date_from = filters.date_from || today;
      const date_to = filters.date_to || addDaysIso(today, 7);
      const fromIso = startOfLocalDayUtc(date_from);
      const toIso = endOfLocalDayUtc(date_to);

      let q = sb
        .from("club_games")
        .select(
          `
          id, kickoff_at, status, home_team_id, away_team_id, club_competition_id,
          club_facility_id, club_field_id, raw_home_label, raw_away_label, updated_at,
          home:club_teams!club_games_home_team_id_fkey (id, team_name, organization_name),
          away:club_teams!club_games_away_team_id_fkey (id, team_name, organization_name),
          competition:club_competitions (id, name, competition_type),
          facility:club_facilities (id, name, city, latitude, longitude, maps_url),
          field:club_fields (id, label)
        `
        )
        .or(`kickoff_at.gte.${fromIso},kickoff_at.is.null`)
        .order("kickoff_at", { ascending: true, nullsFirst: false });

      // PostgREST can't easily do kickoff < to OR null in one chain after gte; filter client-side for TBD
      const { data, error } = await q;
      if (error) throw error;
      let rows = data || [];

      rows = rows.filter((g) => {
        if (!g.kickoff_at) return true; // TBD bucket
        const t = new Date(g.kickoff_at).getTime();
        return t >= new Date(fromIso).getTime() && t < new Date(toIso).getTime();
      });

      if (!filters.include_cancelled) {
        rows = rows.filter((g) => g.status !== "cancelled");
      }

      // Brighton view data
      const gameIds = rows.map((r) => r.id);
      const brightonMap = await loadBrightonForGames(sb, gameIds);

      // Recent changes
      const changed = await loadRecentlyChanged(sb, gameIds);

      let enriched = rows.map((g) => flattenGame(g, brightonMap.get(g.id), changed.has(g.id)));

      if (filters.facility_id) {
        enriched = enriched.filter((g) => g.club_facility_id === filters.facility_id);
      }
      if (filters.city) {
        const c = String(filters.city).toLowerCase();
        enriched = enriched.filter((g) => (g.city || "").toLowerCase().includes(c));
      }
      if (filters.team_ids?.length) {
        const set = new Set(filters.team_ids);
        enriched = enriched.filter((g) => set.has(g.home_team_id) || set.has(g.away_team_id));
      }
      if (filters.competition_ids?.length) {
        const set = new Set(filters.competition_ids);
        enriched = enriched.filter((g) => set.has(g.club_competition_id));
      }
      if (filters.player_ids?.length) {
        const set = new Set(filters.player_ids);
        enriched = enriched.filter((g) => {
          const ps = [...(g.home_brighton_players || []), ...(g.away_brighton_players || [])];
          return ps.some((p) => set.has(p.player_id));
        });
      }
      if (filters.both_sides) {
        enriched = enriched.filter((g) => g.brighton_both_sides);
      }
      // Prefer games with at least one Brighton player for agenda default
      if (filters.brighton_only !== false) {
        enriched = enriched.filter((g) => (g.brighton_player_count || 0) > 0);
      }
      return enriched;
    },

    async getGameDetails(gameId) {
      const { data, error } = await sb
        .from("club_games")
        .select(
          `
          *,
          home:club_teams!club_games_home_team_id_fkey (*),
          away:club_teams!club_games_away_team_id_fkey (*),
          competition:club_competitions (*),
          facility:club_facilities (*),
          field:club_fields (*)
        `
        )
        .eq("id", gameId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const brightonMap = await loadBrightonForGames(sb, [gameId]);
      const changed = await loadRecentlyChanged(sb, [gameId]);
      const { data: changes } = await sb
        .from("club_game_changes")
        .select("*")
        .eq("club_game_id", gameId)
        .order("observed_at", { ascending: false })
        .limit(10);
      const flat = flattenGame(data, brightonMap.get(gameId), changed.has(gameId));
      flat.recent_changes = changes || [];
      flat.provenance = {
        coach_verified_at: data.coach_verified_at,
        manual_overrides: data.manual_overrides,
        last_seen_at: data.last_seen_at,
        source_attribution: data.source_attribution,
      };
      return flat;
    },

    async getItinerary(id) {
      const { data: itin, error } = await sb.from("club_itineraries").select("*").eq("id", id).maybeSingle();
      if (error) throw error;
      if (!itin) return null;
      const { data: stops } = await sb
        .from("club_itinerary_stops")
        .select("*")
        .eq("club_itinerary_id", id)
        .order("stop_order");
      const changeWarnings = [];
      for (const s of stops || []) {
        const { data: ch } = await sb
          .from("club_game_changes")
          .select("*")
          .eq("club_game_id", s.club_game_id)
          .is("acknowledged_at", null)
          .gte("observed_at", itin.updated_at || itin.created_at)
          .limit(5);
        if (ch?.length) {
          changeWarnings.push({ game_id: s.club_game_id, changes: ch });
        }
      }
      return { ...itin, stops: stops || [], change_warnings: changeWarnings };
    },

    async listItineraries() {
      const { data, error } = await sb
        .from("club_itineraries")
        .select("id, name, target_date, updated_at, created_at")
        .order("updated_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data || [];
    },

    // ---- sync interface ----
    async insertSyncRun(row) {
      const { data, error } = await sb.from("club_sync_runs").insert(row).select().single();
      if (error) throw error;
      return data;
    },
    async finishSyncRun(id, patch) {
      const { error } = await sb.from("club_sync_runs").update(patch).eq("id", id);
      if (error) throw error;
    },
    async updateSourceStatus(id, patch) {
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      const { error } = await sb.from("club_schedule_sources").update(clean).eq("id", id);
      if (error) throw error;
    },
    async listTeams() {
      const { data, error } = await sb.from("club_teams").select("*");
      if (error) throw error;
      return data || [];
    },
    async listFacilities() {
      const { data, error } = await sb.from("club_facilities").select("*");
      if (error) throw error;
      return data || [];
    },
    async listFields() {
      const { data, error } = await sb.from("club_fields").select("*");
      if (error) throw error;
      return data || [];
    },
    async listGamesForTeams(teamIds) {
      if (!teamIds?.length) return [];
      const { data, error } = await sb
        .from("club_games")
        .select("*")
        .or(teamIds.map((id) => `home_team_id.eq.${id},away_team_id.eq.${id}`).join(","));
      if (error) throw error;
      return data || [];
    },
    async findSourceLink(sourceId, externalId) {
      const { data, error } = await sb
        .from("club_game_source_links")
        .select("*")
        .eq("club_schedule_source_id", sourceId)
        .eq("external_id", externalId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    async getGame(id) {
      const { data, error } = await sb.from("club_games").select("*").eq("id", id).maybeSingle();
      if (error) throw error;
      return data;
    },
    async insertGame(row) {
      const { data, error } = await sb.from("club_games").insert(row).select().single();
      if (error) throw error;
      return data;
    },
    async updateGame(id, patch) {
      const { error } = await sb.from("club_games").update(patch).eq("id", id);
      if (error) throw error;
    },
    async upsertSourceLink(row) {
      const { error } = await sb.from("club_game_source_links").upsert(row, {
        onConflict: "club_schedule_source_id,external_id",
      });
      if (error) throw error;
    },
    async insertChange(row) {
      const { error } = await sb.from("club_game_changes").insert(row);
      if (error) throw error;
    },
  };
}

async function loadBrightonForGames(sb, gameIds) {
  const map = new Map();
  if (!gameIds.length) return map;
  const { data: games } = await sb
    .from("club_games")
    .select("id, home_team_id, away_team_id")
    .in("id", gameIds);
  const teamIds = [
    ...new Set((games || []).flatMap((g) => [g.home_team_id, g.away_team_id]).filter(Boolean)),
  ];
  if (!teamIds.length) {
    for (const id of gameIds) {
      map.set(id, { home: [], away: [], count: 0, both: false });
    }
    return map;
  }
  const { data: aff } = await sb
    .from("club_player_affiliations")
    .select("club_team_id, player_id, player:players (id, name, short_name)")
    .in("club_team_id", teamIds)
    .eq("active", true);
  const byTeam = new Map();
  for (const a of aff || []) {
    if (!byTeam.has(a.club_team_id)) byTeam.set(a.club_team_id, []);
    byTeam.get(a.club_team_id).push({
      player_id: a.player_id,
      name: a.player?.short_name || a.player?.name || "Player",
      full_name: a.player?.name,
    });
  }
  for (const g of games || []) {
    const home = (byTeam.get(g.home_team_id) || []).map((p) => ({ ...p, side: "home" }));
    const away = (byTeam.get(g.away_team_id) || []).map((p) => ({ ...p, side: "away" }));
    const ids = new Set([...home, ...away].map((p) => p.player_id));
    map.set(g.id, {
      home,
      away,
      count: ids.size,
      both: home.length > 0 && away.length > 0,
    });
  }
  return map;
}

async function loadRecentlyChanged(sb, gameIds) {
  const set = new Set();
  if (!gameIds.length) return set;
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data } = await sb
    .from("club_game_changes")
    .select("club_game_id")
    .in("club_game_id", gameIds)
    .gte("observed_at", since)
    .eq("review_status", "new");
  for (const r of data || []) set.add(r.club_game_id);
  return set;
}

function flattenGame(g, brighton, recentlyChanged) {
  const b = brighton || { home: [], away: [], count: 0, both: false };
  return {
    id: g.id,
    club_game_id: g.id,
    kickoff_at: g.kickoff_at,
    status: g.status,
    home_team_id: g.home_team_id,
    away_team_id: g.away_team_id,
    club_competition_id: g.club_competition_id,
    club_facility_id: g.club_facility_id,
    home_team_name: g.home?.team_name || g.raw_home_label || "TBD",
    away_team_name: g.away?.team_name || g.raw_away_label || "TBD",
    competition_name: g.competition?.name || null,
    facility_name: g.facility?.name || null,
    facility_id: g.facility?.id || g.club_facility_id,
    field_label: g.field?.label || null,
    city: g.facility?.city || null,
    latitude: g.facility?.latitude ?? null,
    longitude: g.facility?.longitude ?? null,
    maps_url: g.facility?.maps_url || null,
    home_brighton_players: b.home,
    away_brighton_players: b.away,
    brighton_player_count: b.count,
    brighton_both_sides: b.both,
    recently_changed: !!recentlyChanged,
  };
}
