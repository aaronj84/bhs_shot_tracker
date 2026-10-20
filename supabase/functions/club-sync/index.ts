/**
 * Schedule source sync worker.
 * Auth: staff JWT (manual Sync Now) OR Bearer CLUB_SYNC_CRON_SECRET (pg_cron).
 * Secrets: CLUB_SYNC_CRON_SECRET (optional but recommended), uses service role for cron path.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { createClubDb } from "../_shared/club/db-client.mjs";
import { runSourceSync } from "../_shared/club/sync-run.mjs";

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (req.method !== "POST") return jsonResponse({ error: "POST required" }, 405);

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const cronSecret = Deno.env.get("CLUB_SYNC_CRON_SECRET") || "";

    if (!supabaseUrl || !anonKey) {
      return jsonResponse({ error: "Supabase env is not configured" }, 500);
    }

    const authHeader = req.headers.get("Authorization") || "";
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
    const body = await req.json().catch(() => ({}));

    let sb;
    let viaCron = false;

    if (cronSecret && bearer === cronSecret) {
      if (!serviceKey) return jsonResponse({ error: "Service role not available for cron sync" }, 500);
      sb = createClient(supabaseUrl, serviceKey);
      viaCron = true;
    } else {
      if (!authHeader) return jsonResponse({ error: "Missing authorization" }, 401);
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: userData, error: userErr } = await userClient.auth.getUser();
      if (userErr || !userData?.user) {
        return jsonResponse({ error: "Sign in with the staff PIN first" }, 401);
      }
      sb = userClient;
    }

    const db = createClubDb(sb);
    let sourcesQuery = sb.from("club_schedule_sources").select(`
      *,
      team_competition:club_team_competitions (
        id, club_team_id, club_competition_id
      )
    `).eq("enabled", true);

    if (body.source_id) {
      sourcesQuery = sourcesQuery.eq("id", body.source_id);
    } else if (body.due_only || viaCron) {
      sourcesQuery = sourcesQuery.or(`next_check_at.is.null,next_check_at.lte.${new Date().toISOString()}`);
    }

    const { data: sources, error } = await sourcesQuery;
    if (error) return jsonResponse({ error: error.message }, 500);

    const results = [];
    for (const src of sources || []) {
      const enriched = {
        ...src,
        club_team_id: src.team_competition?.club_team_id || null,
        club_competition_id: src.team_competition?.club_competition_id || null,
      };
      const r = await runSourceSync(db, enriched);
      results.push({ source_id: src.id, ...r });
    }

    return jsonResponse({
      ok: true,
      via_cron: viaCron,
      source_count: results.length,
      results,
    });
  } catch (e) {
    return jsonResponse({ error: String((e as Error)?.message || e) }, 500);
  }
});
