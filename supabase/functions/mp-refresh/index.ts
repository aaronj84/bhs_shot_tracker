/**
 * mp-refresh — is the MaxPreps datastore fresh, and if not, kick the scraper.
 *
 * The scrape itself is the GitHub Actions workflow mp-daily-scrape.yml (Python,
 * minutes long, writes DEV + PROD). This function only reads mp_ingest_runs and
 * talks to the GitHub Actions API.
 *
 * POST JSON:
 *   { action: "status", since? }  — freshness + scrape state; `since` is the ISO
 *                                    time the caller started a refresh
 *   { action: "start" }            — dispatch the scrape unless fresh or running
 *
 * Secrets: MP_REFRESH_GITHUB_TOKEN (fine-grained PAT, Actions read/write on the repo).
 * Optional: MP_REFRESH_GITHUB_REPO, MP_REFRESH_WORKFLOW, MP_REFRESH_REF.
 * Auto: SUPABASE_URL, SUPABASE_ANON_KEY. Requires staff PIN session.
 */
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const FRESH_MS = 24 * 60 * 60 * 1000;
// GitHub can take a while to list a dispatched run.
const DISPATCH_GRACE_MS = 3 * 60 * 1000;
const ACTIVE_STATES = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

type IngestRun = {
  started_at: string;
  finished_at: string | null;
  status: string;
  reason: string | null;
  games_added: number | null;
  score_changes: number | null;
};

type GhRun = {
  id: number;
  status: string;
  conclusion: string | null;
  created_at: string;
  html_url: string;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function ghConfig() {
  return {
    token: Deno.env.get("MP_REFRESH_GITHUB_TOKEN") || "",
    repo: Deno.env.get("MP_REFRESH_GITHUB_REPO") || "aaronj84/bhs_shot_tracker",
    workflow: Deno.env.get("MP_REFRESH_WORKFLOW") || "mp-daily-scrape.yml",
    ref: Deno.env.get("MP_REFRESH_REF") || "main",
  };
}

async function gh(path: string, init: RequestInit = {}) {
  const { token, repo, workflow } = ghConfig();
  return await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${workflow}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "bhs-shot-tracker-mp-refresh",
        ...(init.headers || {}),
      },
    },
  );
}

async function recentGhRuns(): Promise<GhRun[]> {
  const res = await gh("/runs?per_page=5");
  if (!res.ok) throw new Error(`GitHub runs lookup failed (${res.status})`);
  const data = await res.json();
  return Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
}

async function recentIngestRuns(client: SupabaseClient): Promise<IngestRun[]> {
  const { data, error } = await client
    .from("mp_ingest_runs")
    .select("started_at, finished_at, status, reason, games_added, score_changes")
    .order("started_at", { ascending: false })
    .limit(10);
  if (error) return [];
  return (data || []) as IngestRun[];
}

async function lastScoredGame(client: SupabaseClient): Promise<string | null> {
  const { data } = await client
    .from("mp_games")
    .select("played_on")
    .not("home_score", "is", null)
    .order("played_on", { ascending: false })
    .limit(1);
  return data?.[0]?.played_on ?? null;
}

async function status(client: SupabaseClient, since: string | null) {
  const now = Date.now();
  const [runs, lastGame] = await Promise.all([
    recentIngestRuns(client),
    lastScoredGame(client),
  ]);
  const lastOk = runs.find((r) => r.status === "ok");
  const lastOkAt = lastOk ? lastOk.finished_at || lastOk.started_at : null;
  const fresh = !!lastOkAt && now - Date.parse(lastOkAt) < FRESH_MS;
  const latest = runs[0] || null;

  const { token } = ghConfig();
  let ghRuns: GhRun[] = [];
  let ghError: string | null = null;
  if (token) {
    try {
      ghRuns = await recentGhRuns();
    } catch (e) {
      ghError = e instanceof Error ? e.message : String(e);
    }
  }
  const active = ghRuns.find((r) => ACTIVE_STATES.has(r.status)) || null;

  let state: "fresh" | "running" | "failed" | "blocked" | "stale" = fresh ? "fresh" : "stale";
  let reason: string | null = null;
  if (!fresh && active) {
    state = "running";
  } else if (!fresh && since) {
    const sinceMs = Date.parse(since);
    const mine = ghRuns.find((r) => Date.parse(r.created_at) >= sinceMs - 60_000);
    const newerIngest = runs.find((r) => Date.parse(r.started_at) >= sinceMs - 60_000);
    if (!mine) {
      if (now - sinceMs < DISPATCH_GRACE_MS) state = "running";
      else {
        state = "failed";
        reason = "The scrape never started on GitHub.";
      }
    } else if (mine.conclusion !== "success") {
      state = "failed";
      reason = newerIngest?.reason || `The scrape ended with "${mine.conclusion}".`;
    } else {
      state = "blocked";
      reason =
        (latest?.status === "blocked" && latest.reason) ||
        "The scrape finished but MaxPreps data was not saved.";
    }
  }

  return {
    ok: true,
    state,
    fresh,
    last_ok_at: lastOkAt,
    last_game_on: lastGame,
    latest_run: latest,
    scrape_run: active || ghRuns[0] || null,
    can_refresh: !!token,
    reason: reason || ghError,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") return jsonResponse({ error: "POST an action" }, 405);

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
    const action = String(body.action || "status").toLowerCase();
    const since = typeof body.since === "string" && body.since ? body.since : null;

    if (action === "status") {
      return jsonResponse(await status(userClient, since));
    }

    if (action === "start") {
      const current = await status(userClient, null);
      if (current.state === "fresh" || current.state === "running") {
        return jsonResponse({ ...current, started: false });
      }
      if (!current.can_refresh) {
        return jsonResponse({ error: "MP_REFRESH_GITHUB_TOKEN is not configured" }, 500);
      }
      const requestedAt = new Date().toISOString();
      const res = await gh("/dispatches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref: ghConfig().ref }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return jsonResponse(
          { error: `GitHub refused the scrape (${res.status}) ${text.slice(0, 200)}`.trim() },
          502,
        );
      }
      return jsonResponse({ ...current, state: "running", started: true, requested_at: requestedAt });
    }

    return jsonResponse({ error: "action must be status or start" }, 400);
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : "Refresh failed" }, 500);
  }
});
