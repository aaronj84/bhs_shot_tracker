/**
 * Gemini parse + narrate helpers for Freeman scenario dialogue.
 */
import type { LlmProvider } from "../explore/providers/types.ts";

export type ScenarioPlan = {
  intent: "baseline" | "add" | "swap" | "clarify";
  focus_team: string;
  opponent?: string | null;
  drop?: string | null;
  add?: string | null;
  goals_for?: number | null;
  goals_against?: number | null;
  pk_win?: boolean | null;
  assumptions?: string;
  clarify_question?: string;
};

const PARSE_SYSTEM = `You turn a coach's natural-language ranking question into ONE JSON plan for the Freeman (capped-margin) MaxPreps-style model.

Return ONLY JSON with this shape:
{
  "intent": "baseline" | "add" | "swap" | "clarify",
  "focus_team": "exact team name from the provided list",
  "opponent": "exact team name or null",
  "drop": "team whose win we remove (swap only) or null",
  "add": "team we add a game vs (swap only) or null",
  "goals_for": number or null,
  "goals_against": number or null,
  "pk_win": true | false | null,
  "assumptions": "short note of any score/defaults you assumed",
  "clarify_question": "ask this if intent is clarify, else empty"
}

Rules:
- Use ONLY team names from the provided team list (exact spelling).
- focus_team is whose seed/rating we report. Default Brighton when the coach says "we/us/Brighton" or is ambiguous about subject. Questions may be about other schools.
- intent baseline: where is X ranked / current model seed — no new result.
- intent add: add one hypothetical result for focus_team vs opponent (future or counterfactual add without removing a game).
- intent swap: replace an existing win (drop) with a different opponent/result (add + score). Use when they say "instead of", "rather than", "had we played X instead of Y".
- intent clarify: missing opponent, ambiguous teams, or cannot map to one scenario. Ask one short clarify_question.
- Scores: if they name a score, use it. If they say win/beat with no score, default goals_for=2, goals_against=1. Loss/lost → 1-2. Blowout/mercy win → 5-0.
- Utah high school soccer has no ties: a level game after two overtimes goes to PKs. For a level score set pk_win true if focus_team wins the shootout, false if it loses. "Draw/tie" with no shootout result → 1-1 with pk_win true, and say so in assumptions. pk_win is null whenever the score is not level.
- Schedule lines marked (PK W) / (PK L) were level games settled on PKs.
- goals_* are from focus_team's perspective.
- Do not invent teams outside the list. Prefer clarify over guessing.`;

const NARRATE_SYSTEM = `You are answering a high-school soccer coach about Utah MaxPreps-style seeds using the Freeman capped-margin model (reconstruction, not published MaxPreps).

Rules:
- Use ONLY the numbers in the data payload. Never invent ranks, ratings, or opponents.
- Ratings are estimates on the MaxPreps rating (RTG) scale, calibrated to the published MaxPreps ratings.
- Utah games never end tied; a level score was settled on PKs and counts as a win or loss.
- Lead with the seed move (or current seed for baseline). Mention rating delta briefly.
- Say clearly this is the Freeman model estimate, not the live MaxPreps page.
- If assumptions are listed, state them in one short clause.
- Stay under ~180 words. Plain coach language. Markdown ok for a short bullet list of seed/rating if helpful.
- If clarify_question is present, ask it — do not invent a scenario.
- Questions may not be about Brighton; answer for focus_team.`;

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    return JSON.parse(fence[1].trim());
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }
  throw new Error("Gemini did not return JSON for the scenario plan");
}

export async function parseScenarioQuestion(
  provider: LlmProvider,
  model: string,
  args: {
    question: string;
    teams: string[];
    ourTeam: string;
    schedule: {
      date: string;
      opponent: string;
      gf: number;
      ga: number;
      ha: string;
      pk?: "W" | "L" | null;
    }[];
    history?: { role?: string; content?: string }[];
  },
): Promise<ScenarioPlan> {
  const history = (args.history || [])
    .slice(-6)
    .map((m) => `${m.role || "user"}: ${m.content || ""}`)
    .join("\n");

  const user = [
    `Our team flag: ${args.ourTeam}`,
    `Teams (exact names):\n${args.teams.join("\n")}`,
    `${args.ourTeam} schedule (gf-ga):\n${
      args.schedule
        .map((g) =>
          `${g.date} ${g.ha} vs ${g.opponent} ${g.gf}-${g.ga}${g.pk ? ` (PK ${g.pk})` : ""}`
        )
        .join("\n") || "(none)"
    }`,
    history ? `Recent chat:\n${history}` : "",
    `Coach question:\n${args.question}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const res = await provider.complete({
    model,
    temperature: 0.1,
    json_object: true,
    messages: [
      { role: "system", content: PARSE_SYSTEM },
      { role: "user", content: user },
    ],
  });

  const raw = extractJson(res.content) as Record<string, unknown>;
  const intentRaw = String(raw.intent || "clarify").toLowerCase();
  const intent = (["baseline", "add", "swap", "clarify"] as const).includes(
      intentRaw as "baseline",
    )
    ? (intentRaw as ScenarioPlan["intent"])
    : "clarify";

  return {
    intent,
    focus_team: String(raw.focus_team || args.ourTeam),
    opponent: raw.opponent == null ? null : String(raw.opponent),
    drop: raw.drop == null ? null : String(raw.drop),
    add: raw.add == null ? null : String(raw.add),
    goals_for: raw.goals_for == null ? null : Number(raw.goals_for),
    goals_against: raw.goals_against == null ? null : Number(raw.goals_against),
    pk_win: typeof raw.pk_win === "boolean" ? raw.pk_win : null,
    assumptions: String(raw.assumptions || ""),
    clarify_question: String(raw.clarify_question || ""),
  };
}

export async function narrateScenario(
  provider: LlmProvider,
  model: string,
  args: {
    question: string;
    payload: Record<string, unknown>;
  },
): Promise<string> {
  const res = await provider.complete({
    model,
    temperature: 0.3,
    messages: [
      { role: "system", content: NARRATE_SYSTEM },
      {
        role: "user",
        content:
          `Coach asked:\n${args.question}\n\nFreeman data (source of truth):\n${JSON.stringify(args.payload)}`,
      },
    ],
  });
  return String(res.content || "").trim();
}
