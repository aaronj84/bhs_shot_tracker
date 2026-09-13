/**
 * Opponent Prep briefing via Gemini.
 * Secrets: GEMINI_API_KEY (required). Optional: PREP_GEMINI_MODEL (default gemini-3.6-flash).
 * Auto: SUPABASE_URL, SUPABASE_ANON_KEY
 *
 * Client sends already-filtered shots plus pre-aggregated totals.
 * The model interprets; it must not invent counts.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { createGeminiProvider } from "../_shared/explore/providers/gemini.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SYSTEM_PROMPT = `You are a high-school varsity soccer coach in a live Opponent Prep chat.

Data rules:
- Use ONLY the shot list and totals in the data message. Never invent counts, names, clock times, or lineups.
- If in_progress is true, this is a live/partial report (halftime or pre-ET). Say so in the first sentence. Do not write as if the match is over.
- Cite specific plays as Player 12' zone (e.g. Pip 12' C-6Y) when a follow-up needs examples.
- Brighton always attacks toward the top of the tactical pitch; the opponent attacks toward the bottom. Describe patterns that way (our final third vs their final third).
- Do not guess who was on the field. A shot's position slot is the shooter, not the XI.

Opening briefing (first reply only):
- Team and pattern level only. No player-by-player recap, no ## Players section.
- Cover chance quality, where shots come from, period shape, and what the opponent is doing to us / we to them.
- Under ~280 words.
- After the briefing, ask 3–4 short follow-up questions the coach might want next. Always include variants of:
  1) which parts of the field are yielding better chances
  2) which players are having the biggest impact
  plus 1–2 more that fit this selection (period swing, set pieces/crosses, what to take into the next half or next meeting).

Later replies:
- Answer the coach's question with analysis, not another generic summary.
- Player-level analysis is allowed when they ask for it.
- Stay under ~350 words. Skip empty headings. Markdown is fine.
`;

type PrepShot = Record<string, unknown>;

type PrepBody = {
  opponent?: string;
  our_team?: string;
  in_progress?: boolean;
  periods?: string[];
  games?: { date?: string; game_type?: string }[];
  aggregates?: Record<string, unknown>;
  shots?: PrepShot[];
  question?: string;
  history?: { role?: string; content?: string }[];
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const geminiKey = Deno.env.get("GEMINI_API_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const model = Deno.env.get("PREP_GEMINI_MODEL") || "gemini-3.6-flash";

    if (!geminiKey) {
      return jsonResponse(
        { error: "GEMINI_API_KEY is not configured" },
        500,
      );
    }
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

    const body = (await req.json()) as PrepBody;
    const shots = Array.isArray(body.shots) ? body.shots.slice(0, 400) : [];
    if (!shots.length) {
      return jsonResponse({ error: "No shots in this selection to summarize" }, 400);
    }

    const userPayload = {
      our_team: body.our_team || "Brighton",
      opponent: body.opponent || "Opponent",
      in_progress: !!body.in_progress,
      periods: Array.isArray(body.periods) ? body.periods : [],
      games: Array.isArray(body.games) ? body.games.slice(0, 40) : [],
      aggregates: body.aggregates && typeof body.aggregates === "object" ? body.aggregates : {},
      shots,
    };

    const question = String(body.question || "").trim();
    const history = Array.isArray(body.history) ? body.history.slice(-12) : [];
    const starting = !history.length && !question;

    const provider = createGeminiProvider(geminiKey);
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Filtered shot data (source of truth for every reply):\n\n${JSON.stringify(userPayload)}`,
      },
    ];
    if (starting) {
      messages.push({
        role: "user",
        content:
          "Write the opening briefing: team and pattern level only, then offer follow-up analyses as questions.",
      });
    } else {
      history.forEach((m) => {
        const role = m?.role === "assistant" ? "assistant" : "user";
        const content = String(m?.content || "").trim();
        if (content) messages.push({ role, content });
      });
      messages.push({
        role: "user",
        content: question || "Continue the analysis from the data.",
      });
    }

    const result = await provider.complete({
      model,
      temperature: starting ? 0.25 : 0.35,
      messages,
    });

    return jsonResponse({
      answer: result.content,
      model: result.model,
    });
  } catch (err) {
    console.error(err);
    const msg = err instanceof Error ? err.message : "Prep summary failed";
    const status = /429|rate/i.test(msg) ? 502 : /HTTP 4/i.test(msg) ? 400 : 500;
    return jsonResponse({ error: msg }, status);
  }
});
