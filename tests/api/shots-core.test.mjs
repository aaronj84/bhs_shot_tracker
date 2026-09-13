/**
 * API integration tests against DEV Supabase (anon + anonymous auth).
 * Requires SHOTS_SUPABASE_URL and SHOTS_SUPABASE_ANON_KEY.
 */
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.SHOTS_SUPABASE_URL || "";
const anon = process.env.SHOTS_SUPABASE_ANON_KEY || "";
const configured = !!(url && anon);

const runId = `ci-${Date.now()}`;
const seasonLabel = `CI ${runId}`;

/** @type {import('@supabase/supabase-js').SupabaseClient | null} */
let sb = null;
let brightonId = null;
let opponentId = null;
let seasonId = null;
let gameId = null;
let playerId = null;
let shotId = null;

describe.skipIf(!configured)("Shot tracker API (DEV)", () => {
  beforeAll(async () => {
    sb = createClient(url, anon, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await sb.auth.signInAnonymously();
    if (error) {
      throw new Error(
        `Anonymous sign-in failed: ${error.message}. Enable Anonymous auth on DEV.`
      );
    }
  });

  afterAll(async () => {
    if (!sb) return;
    // Cascade: deleting season removes games → shots; clean test season + opponent team.
    if (seasonId) {
      await sb.from("seasons").delete().eq("id", seasonId);
    }
    if (opponentId) {
      await sb.from("teams").delete().eq("id", opponentId);
    }
    await sb.auth.signOut();
  });

  it("loads Brighton team seed", async () => {
    const { data, error } = await sb.from("teams").select("*").eq("is_brighton", true).single();
    expect(error).toBeNull();
    expect(data?.name).toBeTruthy();
    brightonId = data.id;
  });

  it("creates a season, opponent, game", async () => {
    const { data: season, error: sErr } = await sb
      .from("seasons")
      .insert({ year: 2099, label: seasonLabel })
      .select()
      .single();
    expect(sErr).toBeNull();
    seasonId = season.id;

    const { data: opp, error: oErr } = await sb
      .from("teams")
      .insert({ name: `CI Opp ${runId}`, is_brighton: false })
      .select()
      .single();
    expect(oErr).toBeNull();
    opponentId = opp.id;

    const { data: game, error: gErr } = await sb
      .from("games")
      .insert({
        season_id: seasonId,
        date: "2099-01-15",
        game_type: "friendly",
        home_team_id: brightonId,
        away_team_id: opponentId,
        our_team_id: brightonId,
      })
      .select()
      .single();
    expect(gErr).toBeNull();
    expect(game.stat_scope).toBe("friendly");
    gameId = game.id;
  });

  it("ensures a roster player and inserts a shot", async () => {
    const jersey = "97";
    const { data: player, error: pErr } = await sb
      .from("players")
      .insert({ name: `CI Player ${runId}`, short_name: "CI" })
      .select()
      .single();
    expect(pErr).toBeNull();
    playerId = player.id;

    const { error: rErr } = await sb.from("rosters").insert({
      team_id: brightonId,
      season_id: seasonId,
      player_id: playerId,
      jersey_number: jersey,
      squad: "varsity",
    });
    expect(rErr).toBeNull();

    const { data: shot, error: shErr } = await sb
      .from("shots")
      .insert({
        game_id: gameId,
        period: "1",
        team_id: brightonId,
        player_id: playerId,
        jersey_number_at_time: jersey,
        position: "CF",
        x: 34,
        y: 12,
        zone_id: "C-ATT",
        result: "on-target",
      })
      .select()
      .single();
    expect(shErr).toBeNull();
    shotId = shot.id;
  });

  it("updates an existing shot (edit)", async () => {
    const { data, error } = await sb
      .from("shots")
      .update({ result: "goal", position: "LW" })
      .eq("id", shotId)
      .select()
      .single();
    expect(error).toBeNull();
    expect(data.result).toBe("goal");
    expect(data.position).toBe("LW");
  });

  it("records an opponent shot", async () => {
    const { data, error } = await sb
      .from("shots")
      .insert({
        game_id: gameId,
        period: "2",
        team_id: opponentId,
        jersey_number_at_time: "9",
        x: 40,
        y: 20,
        result: "missed",
        miss_direction: "over",
      })
      .select()
      .single();
    expect(error).toBeNull();
    expect(data.team_id).toBe(opponentId);
  });

  it("lists shots for the game", async () => {
    const { data, error } = await sb
      .from("shots")
      .select("id, result, team_id")
      .eq("game_id", gameId)
      .order("created_at", { ascending: true });
    expect(error).toBeNull();
    expect(data.length).toBeGreaterThanOrEqual(2);
  });

  it("deletes a shot", async () => {
    const { error } = await sb.from("shots").delete().eq("id", shotId);
    expect(error).toBeNull();
    const { data } = await sb.from("shots").select("id").eq("id", shotId);
    expect(data?.length ?? 0).toBe(0);
    shotId = null;
  });

  it("saves a game note with tags", async () => {
    const { data: note, error } = await sb
      .from("notes")
      .insert({
        game_id: gameId,
        body: `CI note ${runId}`,
        author_label: "CI",
      })
      .select()
      .single();
    expect(error).toBeNull();
    expect(note.game_id).toBe(gameId);

    const { error: tagErr } = await sb.from("note_tags").insert({ note_id: note.id, tag: "press" });
    expect(tagErr).toBeNull();

    const { data: tagged, error: readErr } = await sb
      .from("notes")
      .select("id, body, note_tags (tag)")
      .eq("id", note.id)
      .single();
    expect(readErr).toBeNull();
    expect(tagged.note_tags?.map((t) => t.tag)).toContain("press");
  });
});

describe.skipIf(configured)("Shot tracker API (env missing)", () => {
  it.skip("set SHOTS_SUPABASE_URL and SHOTS_SUPABASE_ANON_KEY to run against DEV", () => {});
});
