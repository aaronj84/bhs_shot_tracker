/**
 * Club Player Visitation Planner — Gemini Q&A + travel tools.
 * Secrets: GEMINI_API_KEY (required for ask). Optional: PREP_GEMINI_MODEL, GOOGLE_MAPS_API_KEY.
 * Requires staff PIN anonymous session (JWT).
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { createGeminiProvider } from "../_shared/explore/providers/gemini.ts";
import { createClubDb } from "../_shared/club/db-client.mjs";
import {
  buildPlannerSystemPrompt,
  buildToolCatalogPrompt,
  executeClubTool,
  TOOL_NAMES,
} from "../_shared/club/tools.mjs";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) return JSON.parse(fence[1].trim());
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error("Model did not return JSON");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (req.method !== "POST") return jsonResponse({ error: "POST required" }, 405);

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
    const mode = String(body.mode || "ask").toLowerCase();
    const db = createClubDb(userClient);
    const mapsApiKey = Deno.env.get("GOOGLE_MAPS_API_KEY") || "";
    const { data: settings } = await userClient.from("club_settings").select("*").eq("id", true).maybeSingle();
    const ctx = {
      db,
      mapsApiKey,
      walkMinutes: settings?.same_facility_walk_minutes ?? 8,
      question: String(body.question || ""),
    };

    if (mode === "tool") {
      const name = String(body.tool || "");
      if (!TOOL_NAMES.includes(name)) return jsonResponse({ error: "Unknown tool" }, 400);
      const result = await executeClubTool(name, body.arguments || {}, ctx);
      return jsonResponse({ ok: true, tool: name, result });
    }

    if (mode === "travel") {
      const result = await executeClubTool("get_travel_times", body.arguments || body, ctx);
      return jsonResponse({ ok: true, result, provider_configured: !!mapsApiKey });
    }

    // mode=ask
    const question = String(body.question || "").trim();
    if (!question) return jsonResponse({ error: "Ask a visitation planning question" }, 400);
    if (question.length > 2000) return jsonResponse({ error: "Question is too long" }, 400);

    const geminiKey = Deno.env.get("GEMINI_API_KEY");
    if (!geminiKey) return jsonResponse({ error: "GEMINI_API_KEY is not configured" }, 500);
    const model = Deno.env.get("PREP_GEMINI_MODEL") || "gemini-3.6-flash";
    const provider = createGeminiProvider(geminiKey);
    const history = Array.isArray(body.history) ? body.history.slice(-8) : [];

    const planMessages = [
      {
        role: "system" as const,
        content: `${buildPlannerSystemPrompt()}\n\n${buildToolCatalogPrompt()}`,
      },
      ...history.map((m: { role?: string; content?: string }) => ({
        role: (m.role === "assistant" ? "assistant" : "user") as "assistant" | "user",
        content: String(m.content || ""),
      })),
      {
        role: "user" as const,
        content: `Coach question: ${question}\n\nIf you need data, return tool_calls JSON only. Otherwise answer briefly.`,
      },
    ];

    const planResult = await provider.complete({
      model,
      temperature: 0.1,
      messages: planMessages,
    });

    let toolCalls: { name: string; arguments: Record<string, unknown> }[] = [];
    try {
      const parsed = extractJson(planResult.content) as {
        tool_calls?: { name: string; arguments?: Record<string, unknown> }[];
        name?: string;
        arguments?: Record<string, unknown>;
      };
      if (Array.isArray(parsed?.tool_calls)) {
        toolCalls = parsed.tool_calls
          .filter((t) => t && TOOL_NAMES.includes(t.name))
          .map((t) => ({ name: t.name, arguments: t.arguments || {} }));
      } else if (parsed?.name && TOOL_NAMES.includes(parsed.name)) {
        toolCalls = [{ name: parsed.name, arguments: parsed.arguments || {} }];
      }
    } catch {
      // Model answered directly without tools
      return jsonResponse({
        ok: true,
        mode: "ask",
        answer: planResult.content,
        tool_results: [],
        model: planResult.model,
        maps_configured: !!mapsApiKey,
      });
    }

    if (!toolCalls.length) {
      return jsonResponse({
        ok: true,
        mode: "ask",
        answer: planResult.content,
        tool_results: [],
        model: planResult.model,
        maps_configured: !!mapsApiKey,
      });
    }

    const toolResults = [];
    for (const call of toolCalls.slice(0, 4)) {
      console.log("[club-visitation]", call.name, JSON.stringify(call.arguments));
      const result = await executeClubTool(call.name, call.arguments, ctx);
      const summary = result && typeof result === "object"
        ? { date_from: result.date_from, date_to: result.date_to, count: result.count, error: result.error }
        : null;
      console.log("[club-visitation] result", call.name, JSON.stringify(summary));
      toolResults.push({ name: call.name, arguments: call.arguments, result });
    }

    const narrate = await provider.complete({
      model,
      temperature: 0.25,
      messages: [
        { role: "system", content: buildPlannerSystemPrompt() },
        {
          role: "user",
          content: `Coach question: ${question}\n\nTool results (source of truth):\n${JSON.stringify(toolResults)}\n\nAnswer using only these results. Include game_id values when recommending stops. If disambiguation is present, ask the coach to choose.`,
        },
      ],
    });

    return jsonResponse({
      ok: true,
      mode: "ask",
      answer: narrate.content,
      tool_results: toolResults,
      model: narrate.model,
      maps_configured: !!mapsApiKey,
    });
  } catch (e) {
    return jsonResponse({ error: String((e as Error)?.message || e) }, 500);
  }
});
