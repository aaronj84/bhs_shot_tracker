/**
 * Load MaxPreps season graph for Freeman what-if.
 * Prefers mp_games / mp_teams; falls back to bundled season_snapshot.json.
 * Snapshot is imported (not read from disk) so `supabase functions deploy` bundles it.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import seasonSnapshot from "./season_snapshot.json" with { type: "json" };

export type Game = {
  date: string;
  home: string;
  away: string;
  home_score: number;
  away_score: number;
  neutral?: boolean;
  is_forfeit?: boolean;
};

export type TeamRow = {
  team_id: string;
  display_name: string;
  classification: string;
  is_our_team: boolean;
};

export type SeasonLoad = {
  games: Game[];
  teams: TeamRow[];
  source: string;
  as_of?: string | null;
};

type SeasonSnap = {
  games: Game[];
  teams: TeamRow[];
  as_of?: string;
};

function getBundledSnapshot(): SeasonSnap {
  return seasonSnapshot as SeasonSnap;
}

export function classesFromTeams(teams: TeamRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of teams) {
    if (t.display_name && t.classification) out[t.display_name] = t.classification;
  }
  return out;
}

export function ourTeamName(teams: TeamRow[], fallback = "Brighton"): string {
  const ours = teams.find((t) => t.is_our_team);
  return ours?.display_name || fallback;
}

export async function loadSeason(
  userClient: SupabaseClient,
): Promise<SeasonLoad> {
  const fromDb = await loadFromDb(userClient);
  if (fromDb) return fromDb;
  const snap = getBundledSnapshot();
  return {
    games: snap.games,
    teams: snap.teams,
    source: "bundled_snapshot",
    as_of: snap.as_of ?? null,
  };
}

async function loadFromDb(userClient: SupabaseClient): Promise<SeasonLoad | null> {
  const { data: teamRows, error: teamErr } = await userClient
    .from("mp_teams")
    .select("team_id, display_name, classification, is_our_team");
  if (teamErr || !teamRows?.length) return null;

  const { data: gameRows, error: gameErr } = await userClient
    .from("mp_games")
    .select(
      "played_on, home_team_id, away_team_id, home_score, away_score, neutral, is_forfeit",
    )
    .not("home_score", "is", null)
    .not("away_score", "is", null);
  if (gameErr || !gameRows?.length) return null;

  const idToName = new Map(
    (teamRows as TeamRow[]).map((t) => [t.team_id, t.display_name]),
  );

  const games: Game[] = [];
  for (const g of gameRows as Record<string, unknown>[]) {
    const home = idToName.get(String(g.home_team_id));
    const away = idToName.get(String(g.away_team_id));
    if (!home || !away) continue;
    if (g.home_score == null || g.away_score == null) continue;
    games.push({
      date: String(g.played_on),
      home,
      away,
      home_score: Number(g.home_score),
      away_score: Number(g.away_score),
      neutral: Boolean(g.neutral),
      is_forfeit: Boolean(g.is_forfeit),
    });
  }
  if (!games.length) return null;
  return {
    games,
    teams: teamRows as TeamRow[],
    source: "mp_games",
    as_of: null,
  };
}

/** Case-insensitive exact / starts-with / includes match against known teams. */
export function resolveTeamName(
  raw: string | null | undefined,
  teams: TeamRow[],
): string | null {
  const q = String(raw || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!q) return null;
  const names = teams.map((t) => t.display_name).filter(Boolean);
  const exact = names.find((n) => n.toLowerCase() === q);
  if (exact) return exact;
  const starts = names.filter((n) => n.toLowerCase().startsWith(q));
  if (starts.length === 1) return starts[0];
  const includes = names.filter((n) => n.toLowerCase().includes(q));
  if (includes.length === 1) return includes[0];
  return null;
}

export function brightonSchedule(games: Game[], team: string) {
  const rows = [];
  for (const g of games) {
    if (g.home === team) {
      rows.push({
        date: g.date,
        opponent: g.away,
        gf: g.home_score,
        ga: g.away_score,
        ha: "H",
      });
    } else if (g.away === team) {
      rows.push({
        date: g.date,
        opponent: g.home,
        gf: g.away_score,
        ga: g.home_score,
        ha: "A",
      });
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}
