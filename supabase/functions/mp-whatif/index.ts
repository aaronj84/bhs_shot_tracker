/**
 * mp-whatif — Freeman (MaxPreps.com family) scenario ratings + NL dialogue.
 *
 * POST JSON:
 *   { mode: "ask", question, history? }  — Gemini parses + Freeman + Gemini narrates
 *   { mode: "baseline", team? }
 *   { mode: "add", team?, opponent, goals_for, goals_against, pk_win? }
 *   { mode: "swap", team?, drop, add, goals_for, goals_against, pk_win? }
 *   pk_win is required when the score is level (UHSAA games go to PKs).
 *   Ratings are on the MaxPreps RTG scale (MAXPREPS_RATING_OPTS).
 *   { mode: "teams" }
 *
 * Secrets: GEMINI_API_KEY (required for mode=ask). Optional: PREP_GEMINI_MODEL.
 * Auto: SUPABASE_URL, SUPABASE_ANON_KEY. Requires staff PIN session.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { createGeminiProvider } from "../_shared/explore/providers/gemini.ts";
import {
  MAXPREPS_RATING_OPTS,
  marginPowerRating,
  poolFor,
  rankInPool,
  standings,
  whatIf,
  swapResult,
} from "../_shared/mp/freeman.mjs";
import {
  brightonSchedule,
  classesFromTeams,
  loadSeason,
  ourTeamName,
  resolveTeamName,
  type SeasonLoad,
} from "../_shared/mp/season.ts";
import { narrateScenario, parseScenarioQuestion } from "../_shared/mp/ask.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const RATING_OPTS = MAXPREPS_RATING_OPTS;
const DEFAULT_TEAM = "Brighton";

/** Level scores need a shootout result; anything else ignores pk_win. */
function pkWinFor(gf: number, ga: number, raw: unknown): boolean | null | undefined {
  if (Math.round(gf) !== Math.round(ga)) return null;
  if (typeof raw === "boolean") return raw;
  return undefined;
}

const LEVEL_NEEDS_PK =
  "Utah games can't end tied. For a level score, say whether the team won or lost on PKs (pk_win).";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function baselineFor(
  loaded: SeasonLoad,
  team: string,
  classes: Record<string, string>,
  ratings: Record<string, number>,
) {
  const pool = poolFor(team, classes);
  return {
    team,
    rating: Math.round((ratings[team] ?? 0) * 10000) / 10000,
    rank: rankInPool(team, ratings, pool),
    classification: classes[team] || null,
    standings: standings(ratings, pool, 16),
  };
}

function noClassAnswer(team: string) {
  return `I don't have a classification for ${team} in the MaxPreps data, so I can't seed them within their class. The next MaxPreps refresh should fill it in.`;
}

function meta(loaded: SeasonLoad) {
  return {
    model: "freeman",
    source: loaded.source,
    as_of: loaded.as_of ?? null,
    games_count: loaded.games.length,
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

    const loaded = await loadSeason(userClient);
    const classes = classesFromTeams(loaded.teams);
    const defaultTeam = ourTeamName(loaded.teams, DEFAULT_TEAM);

    if (mode === "teams") {
      const names = loaded.teams
        .map((t) => t.display_name)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
      return jsonResponse({
        ok: true,
        team: defaultTeam,
        teams: names,
        ...meta(loaded),
      });
    }

    if (mode === "ask") {
      const question = String(body.question || "").trim();
      if (!question) return jsonResponse({ error: "Ask a what-if question" }, 400);
      if (question.length > 2000) {
        return jsonResponse({ error: "Question is too long" }, 400);
      }

      const geminiKey = Deno.env.get("GEMINI_API_KEY");
      if (!geminiKey) {
        return jsonResponse({ error: "GEMINI_API_KEY is not configured" }, 500);
      }
      const model = Deno.env.get("PREP_GEMINI_MODEL") || "gemini-3.6-flash";
      const provider = createGeminiProvider(geminiKey);
      const teamNames = loaded.teams
        .map((t) => t.display_name)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
      const schedule = brightonSchedule(loaded.games, defaultTeam);
      const history = Array.isArray(body.history) ? body.history.slice(-8) : [];

      const plan = await parseScenarioQuestion(provider, model, {
        question,
        teams: teamNames,
        ourTeam: defaultTeam,
        schedule,
        history,
      });

      const focus =
        resolveTeamName(plan.focus_team, loaded.teams) || defaultTeam;
      if (!classes[focus]) {
        return jsonResponse({
          ok: true,
          mode: "ask",
          answer: noClassAnswer(focus),
          plan: { ...plan, focus_team: focus, intent: "clarify" },
          baseline: null,
          result: null,
          ...meta(loaded),
        });
      }
      const ratings = marginPowerRating(loaded.games, RATING_OPTS);
      const baseline = baselineFor(loaded, focus, classes, ratings);

      if (plan.intent === "clarify") {
        const clarify =
          plan.clarify_question ||
          "Which teams and score should I use for this scenario?";
        const answer = await narrateScenario(provider, model, {
          question,
          payload: {
            intent: "clarify",
            clarify_question: clarify,
            baseline,
            ...meta(loaded),
          },
        });
        return jsonResponse({
          ok: true,
          mode: "ask",
          answer,
          plan: { ...plan, focus_team: focus, intent: "clarify", clarify_question: clarify },
          baseline,
          result: null,
          ...meta(loaded),
        });
      }

      if (plan.intent === "baseline") {
        const answer = await narrateScenario(provider, model, {
          question,
          payload: {
            intent: "baseline",
            assumptions: plan.assumptions || "",
            baseline,
            ...meta(loaded),
          },
        });
        return jsonResponse({
          ok: true,
          mode: "ask",
          answer,
          plan: { ...plan, focus_team: focus, intent: "baseline" },
          baseline,
          result: null,
          ...meta(loaded),
        });
      }

      if (plan.intent === "add") {
        const opponent = resolveTeamName(plan.opponent, loaded.teams);
        const gf = Number(plan.goals_for);
        const ga = Number(plan.goals_against);
        if (!opponent) {
          return jsonResponse({
            ok: true,
            mode: "ask",
            answer:
              "I need a school name from this season’s team list for the opponent. Who should the result be against?",
            plan: { ...plan, focus_team: focus, intent: "clarify" },
            baseline,
            result: null,
            ...meta(loaded),
          });
        }
        if (!Number.isFinite(gf) || !Number.isFinite(ga) || gf < 0 || ga < 0) {
          return jsonResponse({
            ok: true,
            mode: "ask",
            answer: "What score should I use (us–them from the focus team’s view)?",
            plan: { ...plan, focus_team: focus, intent: "clarify" },
            baseline,
            result: null,
            ...meta(loaded),
          });
        }
        const pkWin = pkWinFor(gf, ga, plan.pk_win) ?? true;
        const result = whatIf(loaded.games, focus, opponent, Math.round(gf), Math.round(ga), {
          classes,
          ratingOpts: RATING_OPTS,
          baseline: { ratings, rank: baseline.rank },
          pkWin,
        });
        const answer = await narrateScenario(provider, model, {
          question,
          payload: {
            intent: "add",
            assumptions: plan.assumptions || "",
            focus_team: focus,
            baseline,
            result,
            ...meta(loaded),
          },
        });
        return jsonResponse({
          ok: true,
          mode: "ask",
          answer,
          plan: {
            ...plan,
            focus_team: focus,
            opponent,
            goals_for: Math.round(gf),
            goals_against: Math.round(ga),
            pk_win: pkWin,
          },
          baseline,
          result,
          ...meta(loaded),
        });
      }

      if (plan.intent === "swap") {
        const drop = resolveTeamName(plan.drop, loaded.teams);
        const add = resolveTeamName(plan.add || plan.opponent, loaded.teams);
        const gf = Number(plan.goals_for);
        const ga = Number(plan.goals_against);
        if (!drop || !add) {
          return jsonResponse({
            ok: true,
            mode: "ask",
            answer:
              "For a swap I need the win to drop and the team to add (both from the season list). Can you name both?",
            plan: { ...plan, focus_team: focus, intent: "clarify" },
            baseline,
            result: null,
            ...meta(loaded),
          });
        }
        if (!Number.isFinite(gf) || !Number.isFinite(ga) || gf < 0 || ga < 0) {
          return jsonResponse({
            ok: true,
            mode: "ask",
            answer: "What score should I use for the replacement game?",
            plan: { ...plan, focus_team: focus, intent: "clarify" },
            baseline,
            result: null,
            ...meta(loaded),
          });
        }
        const pkWin = pkWinFor(gf, ga, plan.pk_win) ?? true;
        const result = swapResult(
          loaded.games,
          focus,
          drop,
          add,
          Math.round(gf),
          Math.round(ga),
          { classes, ratingOpts: RATING_OPTS, pkWin },
        );
        if (!result.ok) {
          const answer = await narrateScenario(provider, model, {
            question,
            payload: {
              intent: "swap_failed",
              error: result.error,
              assumptions: plan.assumptions || "",
              focus_team: focus,
              drop,
              add,
              baseline,
              ...meta(loaded),
            },
          });
          return jsonResponse({
            ok: true,
            mode: "ask",
            answer,
            plan: { ...plan, focus_team: focus, drop, add },
            baseline,
            result,
            ...meta(loaded),
          });
        }
        const answer = await narrateScenario(provider, model, {
          question,
          payload: {
            intent: "swap",
            assumptions: plan.assumptions || "",
            focus_team: focus,
            baseline,
            result,
            ...meta(loaded),
          },
        });
        return jsonResponse({
          ok: true,
          mode: "ask",
          answer,
          plan: {
            ...plan,
            focus_team: focus,
            drop,
            add,
            goals_for: Math.round(gf),
            goals_against: Math.round(ga),
            pk_win: pkWin,
          },
          baseline,
          result,
          ...meta(loaded),
        });
      }

      return jsonResponse({ error: "Could not interpret that scenario" }, 400);
    }

    const team = String(body.team || defaultTeam).trim() || DEFAULT_TEAM;
    if (!classes[team]) {
      return jsonResponse({ error: noClassAnswer(team) }, 409);
    }
    const ratings = marginPowerRating(loaded.games, RATING_OPTS);
    const baseline = baselineFor(loaded, team, classes, ratings);

    if (mode === "baseline") {
      return jsonResponse({
        ok: true,
        mode,
        baseline,
        ...meta(loaded),
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
      const pkWin = pkWinFor(gf, ga, body.pk_win);
      if (pkWin === undefined) return jsonResponse({ error: LEVEL_NEEDS_PK }, 400);
      const result = whatIf(loaded.games, team, opponent, Math.round(gf), Math.round(ga), {
        classes,
        ratingOpts: RATING_OPTS,
        baseline: { ratings, rank: baseline.rank },
        pkWin,
      });
      return jsonResponse({
        ok: true,
        mode,
        baseline,
        result,
        ...meta(loaded),
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
      const pkWin = pkWinFor(gf, ga, body.pk_win);
      if (pkWin === undefined) return jsonResponse({ error: LEVEL_NEEDS_PK }, 400);
      const result = swapResult(
        loaded.games,
        team,
        drop,
        add,
        Math.round(gf),
        Math.round(ga),
        { classes, ratingOpts: RATING_OPTS, pkWin },
      );
      if (!result.ok) return jsonResponse(result, 400);
      return jsonResponse({
        ok: true,
        mode,
        baseline,
        result,
        ...meta(loaded),
      });
    }

    return jsonResponse({ error: "mode must be ask, baseline, add, swap, or teams" }, 400);
  } catch (e) {
    return jsonResponse(
      { error: e instanceof Error ? e.message : "Scenario failed" },
      500,
    );
  }
});
