/**
 * mp-whatif — Freeman (MaxPreps.com family) scenario ratings.
 *
 * POST JSON:
 *   { mode: "baseline" }
 *   { mode: "add", team?, opponent, goals_for, goals_against }
 *   { mode: "swap", team?, drop, add, goals_for, goals_against }
 *   { mode: "teams" }  — list teams for pickers
 *
 * Data: prefers mp_games / mp_teams when populated; else bundled season snapshot.
 * Auto: SUPABASE_URL, SUPABASE_ANON_KEY. Requires staff PIN session.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  marginPowerRating,
  poolFor,
  rankInPool,
  standings,
  whatIf,
  swapResult,
} from "../_shared/mp/freeman.mjs";

type SeasonSnap = {
  games: Game[];
  teams: TeamRow[];
  as_of?: string;
};

let cachedSnap: SeasonSnap | null = null;

async function getBundledSnapshot(): Promise<SeasonSnap> {
  if (cachedSnap) return cachedSnap;
  const raw = await Deno.readTextFile(
    new URL("../_shared/mp/season_snapshot.json", import.meta.url),
  );
  cachedSnap = JSON.parse(raw) as SeasonSnap;
  return cachedSnap;
}

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const RATING_OPTS = { cap: 5, ridge: 1, resultBonus: 1, homeAdv: null as null };
const DEFAULT_TEAM = "Brighton";

type Game = {
  date: string;
  home: string;
  away: string;
  home_score: number;
  away_score: number;
  neutral?: boolean;
  is_forfeit?: boolean;
};

type TeamRow = {
  team_id: string;
  display_name: string;
  classification: string;
  is_our_team: boolean;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function classesFromTeams(teams: TeamRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of teams) {
    if (t.display_name && t.classification) out[t.display_name] = t.classification;
  }
  return out;
}

function ourTeamName(teams: TeamRow[]): string {
  const ours = teams.find((t) => t.is_our_team);
  return ours?.display_name || DEFAULT_TEAM;
}

async function loadFromDb(userClient: ReturnType<typeof createClient>): Promise<{
  games: Game[];
  teams: TeamRow[];
  source: string;
} | null> {
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
  };
}

async function loadSnapshot(): Promise<{
  games: Game[];
  teams: TeamRow[];
  source: string;
  as_of?: string;
}> {
  const snap = await getBundledSnapshot();
  return {
    games: snap.games,
    teams: snap.teams,
    source: "bundled_snapshot",
    as_of: snap.as_of,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return jsonResponse({ error: "POST a scenario body" }, 405);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    if (!supabaseUrl || !anonKey) {
      return jsonResponse({ error: "Supabase env is not configured" }, 500);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing authorization" }, 401);
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return jsonResponse({ error: "Sign in with the staff PIN first" }, 401);
    }

    const body = await req.json().catch(() => ({}));
    const mode = String(body.mode || "baseline").toLowerCase();

    const fromDb = await loadFromDb(userClient);
    const loaded = fromDb || (await loadSnapshot());
    const classes = classesFromTeams(loaded.teams);
    const team = String(body.team || ourTeamName(loaded.teams)).trim() || DEFAULT_TEAM;

    if (mode === "teams") {
      const names = loaded.teams
        .map((t) => t.display_name)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
      return jsonResponse({
        ok: true,
        team,
        teams: names,
        source: loaded.source,
        as_of: "as_of" in loaded ? loaded.as_of : null,
        games_count: loaded.games.length,
      });
    }

    const ratings = marginPowerRating(loaded.games, RATING_OPTS);
    const pool = poolFor(team, classes);
    const baseline = {
      team,
      rating: Math.round((ratings[team] ?? 0) * 10000) / 10000,
      rank: rankInPool(team, ratings, pool),
      classification: classes[team] || null,
      standings: standings(ratings, pool, 16),
    };

    if (mode === "baseline") {
      return jsonResponse({
        ok: true,
        mode,
        model: "freeman",
        source: loaded.source,
        as_of: "as_of" in loaded ? loaded.as_of : null,
        games_count: loaded.games.length,
        baseline,
      });
    }

    if (mode === "add") {
      const opponent = String(body.opponent || "").trim();
      const gf = Number(body.goals_for);
      const ga = Number(body.goals_against);
      if (!opponent) return jsonResponse({ error: "opponent is required" }, 400);
      if (!Number.isFinite(gf) || !Number.isFinite(ga) || gf < 0 || ga < 0) {
        return jsonResponse({ error: "goals_for and goals_against must be non-negative numbers" }, 400);
      }
      const result = whatIf(loaded.games, team, opponent, Math.round(gf), Math.round(ga), {
        classes,
        ratingOpts: RATING_OPTS,
        baseline: { ratings, rank: baseline.rank },
      });
      return jsonResponse({
        ok: true,
        mode,
        model: "freeman",
        source: loaded.source,
        as_of: "as_of" in loaded ? loaded.as_of : null,
        games_count: loaded.games.length,
        baseline,
        result,
      });
    }

    if (mode === "swap") {
      const drop = String(body.drop || "").trim();
      const add = String(body.add || "").trim();
      const gf = Number(body.goals_for);
      const ga = Number(body.goals_against);
      if (!drop || !add) {
        return jsonResponse({ error: "drop and add team names are required" }, 400);
      }
      if (!Number.isFinite(gf) || !Number.isFinite(ga) || gf < 0 || ga < 0) {
        return jsonResponse({ error: "goals_for and goals_against must be non-negative numbers" }, 400);
      }
      const result = swapResult(
        loaded.games,
        team,
        drop,
        add,
        Math.round(gf),
        Math.round(ga),
        { classes, ratingOpts: RATING_OPTS },
      );
      if (!result.ok) return jsonResponse(result, 400);
      return jsonResponse({
        ok: true,
        mode,
        model: "freeman",
        source: loaded.source,
        as_of: "as_of" in loaded ? loaded.as_of : null,
        games_count: loaded.games.length,
        baseline,
        result,
      });
    }

    return jsonResponse({ error: "mode must be baseline, add, swap, or teams" }, 400);
  } catch (e) {
    return jsonResponse(
      { error: e instanceof Error ? e.message : "Scenario failed" },
      500,
    );
  }
});
