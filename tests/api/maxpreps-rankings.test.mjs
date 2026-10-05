/**
 * Edge Function maxpreps-rankings against DEV (anonymous auth).
 * Requires SHOTS_SUPABASE_URL and SHOTS_SUPABASE_ANON_KEY, and the function deployed to DEV.
 */
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.SHOTS_SUPABASE_URL || "";
const anon = process.env.SHOTS_SUPABASE_ANON_KEY || "";
const configured = !!(url && anon);

/** @type {import('@supabase/supabase-js').SupabaseClient | null} */
let sb = null;

describe.skipIf(!configured)("maxpreps-rankings (DEV)", () => {
  beforeAll(async () => {
    sb = createClient(url, anon, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { transport: class NoopWebSocket {} },
    });
    const { error } = await sb.auth.signInAnonymously();
    if (error) throw new Error(`Anonymous sign-in failed: ${error.message}`);
  });

  afterAll(async () => {
    if (sb) await sb.auth.signOut();
  });

  it("rejects callers without a session", async () => {
    const res = await fetch(`${url}/functions/v1/maxpreps-rankings`, {
      headers: { apikey: anon },
    });
    expect(res.status).toBe(401);
  });

  it("returns every ranked team in order", async () => {
    const { data, error } = await sb.functions.invoke("maxpreps-rankings", { method: "GET" });
    expect(error).toBeNull();
    expect(Array.isArray(data.rankings)).toBe(true);
    expect(data.rankings.length).toBeGreaterThan(0);
    const ranks = data.rankings.map((r) => r.rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(data.rankings.map((r) => r.school)).size).toBe(data.rankings.length);
    const first = data.rankings[0];
    expect(first.school).toBeTruthy();
    expect(first.record).toMatch(/^\d+-\d+(-\d+)?$/);
    expect(typeof first.rating).toBe("number");
  });
});
