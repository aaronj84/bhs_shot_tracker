/**
 * Opponent Prep briefing via Gemini.
 * Secrets: GEMINI_API_KEY (required). Optional: PREP_GEMINI_MODEL (default gemini-2.5-flash).
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

const SYSTEM_PROMPT = `You are a high-school varsity soccer coach writing a short Opponent Prep briefing.

Rules:
- Use ONLY the shot list and the provided totals. Never invent counts, names, or clock times.
- If in_progress is true, this is a live/partial report (halftime or pre-ET). Say so in the first sentence. Do not write as if the match is over.
- Cite specific plays as Player 12' zone (e.g. Pip 12' C-6Y).
- Brighton always attacks toward the top of the tactical pitch; the opponent attacks toward the bottom. Patterns should be described that way (our final third vs their final third).
- Do not discuss starting lineups or who was on the field unless a shot's position slot is present; even then, that is the shooter's slot, not the XI.
- Skip empty sections. Keep the whole briefing under ~400 words.
- Write markdown with these headings when there is something to say:
  ## Brighton
  ## Opponent
  ## Players
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
    const model = Deno.env.get("PREP_GEMINI_MODEL") || "gemini-2.5-flash";

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

    const provider = createGeminiProvider(geminiKey);
    const result = await provider.complete({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Write the briefing for this filtered set.\n\n${JSON.stringify(userPayload)}`,
        },
      ],
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
