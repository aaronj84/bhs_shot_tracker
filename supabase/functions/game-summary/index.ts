/**
 * On-demand game summary narrative via Gemini.
 * Secrets: GEMINI_API_KEY (required). Optional: PREP_GEMINI_MODEL (default gemini-3.6-flash).
 * Auto: SUPABASE_URL, SUPABASE_ANON_KEY
 *
 * Client sends pre-aggregated stats + a compact shot list.
 * The model interprets; it must not invent counts.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { createGeminiProvider } from "../_shared/explore/providers/gemini.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SYSTEM_PROMPT = `You write a short game summary for a high-school varsity soccer sideline app.

Data rules:
- Use ONLY the aggregates and shot list in the data message. Never invent counts, scorers, clock times, or lineups.
- If in_progress is true, this is a live/partial report. Say so in the first sentence. Do not write as if the match is over.
- Only mention things Shot Tracker records: shots (and quality/location), corners, and free kicks. Do not invent possession, passes, fouls won, cards, or xG.
- Brighton / our_team always attacks toward the top of the tactical pitch; the opponent attacks toward the bottom.

Output:
- 2–4 short paragraphs, under ~180 words total.
- Lead with the scoreline and the shot story (volume, on-target / on-frame, where chances came from).
- Call out set pieces (corners / free kicks) only when the numbers matter.
- End with one practical coaching takeaway for the next period or next meeting.
- Plain prose or light markdown. No bullet laundry lists of every stat.
`;

type SummaryBody = {
  our_team?: string;
  opponent?: string;
  in_progress?: boolean;
  date?: string;
  game_type?: string;
  periods?: string[];
  aggregates?: Record<string, unknown>;
  shots?: Record<string, unknown>[];
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
      return jsonResponse({ error: "GEMINI_API_KEY is not configured" }, 500);
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

    const body = (await req.json()) as SummaryBody;
    const shots = Array.isArray(body.shots) ? body.shots.slice(0, 400) : [];
    const aggregates =
      body.aggregates && typeof body.aggregates === "object" ? body.aggregates : {};

    const hasPlays =
      shots.length > 0 ||
      (aggregates as { us?: { shots?: number }; opp?: { shots?: number } }).us?.shots ||
      (aggregates as { us?: { shots?: number }; opp?: { shots?: number } }).opp?.shots ||
      (aggregates as { us?: { corners?: number } }).us?.corners ||
      (aggregates as { opp?: { corners?: number } }).opp?.corners ||
      (aggregates as { us?: { freeKicks?: number } }).us?.freeKicks ||
      (aggregates as { opp?: { freeKicks?: number } }).opp?.freeKicks;

    if (!hasPlays) {
      return jsonResponse(
        { error: "No recorded plays in this game to summarize" },
        400,
      );
    }

    const userPayload = {
      our_team: body.our_team || "Brighton",
      opponent: body.opponent || "Opponent",
      in_progress: !!body.in_progress,
      date: body.date || null,
      game_type: body.game_type || null,
      periods: Array.isArray(body.periods) ? body.periods : [],
      aggregates,
      shots,
    };

    const provider = createGeminiProvider(geminiKey);
    const result = await provider.complete({
      model,
      temperature: 0.3,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Game data (source of truth):\n\n${JSON.stringify(userPayload)}\n\nWrite the game summary now.`,
        },
      ],
    });

    return jsonResponse({
      answer: result.content,
      model: result.model,
    });
  } catch (err) {
    console.error(err);
    const msg = err instanceof Error ? err.message : "Game summary failed";
    const status = /429|rate/i.test(msg) ? 502 : /HTTP 4/i.test(msg) ? 400 : 500;
    return jsonResponse({ error: msg }, status);
  }
});
