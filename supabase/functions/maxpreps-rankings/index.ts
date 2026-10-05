/**
 * MaxPreps class rankings, read server-side because maxpreps.com blocks framing and CORS.
 * Auto: SUPABASE_URL, SUPABASE_ANON_KEY
 *
 * Only fetches the fixed rankings path below; the client cannot pick the URL.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const RANKINGS_BASE = "https://www.maxpreps.com/ut/soccer/girls/26-27/class/class-5a/rankings";
const STATE_DIVISION_ID = "8fd8bb6b-6430-463a-915b-1e02dba437c1";
const MAX_PAGES = 4;

type MaxPrepsRanking = {
  rank?: number;
  schoolId?: string;
  schoolName?: string;
  schoolMascotUrl?: string;
  overall?: string;
  strength?: number;
  rating?: number;
  movement?: string;
  teamLink?: string;
  lastUpdated?: string;
};

function jsonResponse(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extra },
  });
}

async function fetchPage(page: number): Promise<MaxPrepsRanking[]> {
  const url = `${RANKINGS_BASE}/${page}/?statedivisionid=${STATE_DIVISION_ID}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (BHS Shot Tracker)" } });
  if (res.status === 404 && page > 1) return [];
  if (!res.ok) throw new Error(`MaxPreps returned ${res.status}`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("MaxPreps page format changed");
  const data = JSON.parse(m[1]);
  const list = data?.props?.pageProps?.rankingsListData?.rankings;
  return Array.isArray(list) ? list : [];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
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

    const rows: MaxPrepsRanking[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const list = await fetchPage(page);
      for (const r of list) {
        const key = r.schoolId || `${r.rank}:${r.schoolName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(r);
      }
      if (list.length < 25) break;
    }

    const rankings = rows.map((r) => ({
      rank: r.rank ?? null,
      school: r.schoolName || "",
      mascot: r.schoolMascotUrl || "",
      record: r.overall || "",
      rating: typeof r.rating === "number" ? r.rating : null,
      strength: typeof r.strength === "number" ? r.strength : null,
      movement: r.movement || "",
      link: r.teamLink || "",
    }));
    const updated = rows.map((r) => r.lastUpdated || "").sort().pop() || null;

    return jsonResponse(
      {
        rankings,
        updated,
        source: `${RANKINGS_BASE}/1/?statedivisionid=${STATE_DIVISION_ID}`,
      },
      200,
      { "Cache-Control": "private, max-age=900" },
    );
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : "Could not load rankings" }, 502);
  }
});
