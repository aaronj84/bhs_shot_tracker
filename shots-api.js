/**
 * Brighton Shot Tracker — Supabase access layer.
 *
 * Known gap (Phase 2): writes are online-only. Spotty stadium wifi is not
 * queued or synced. Failed inserts stay on-screen as "not saved" so the coach
 * can retry. Offline-first / conflict resolution is out of scope.
 *
 * Also out of scope: per-coach attribution, shot audit trail, realtime
 * multi-device live updates (UI has manual Sync), xG / video / formation drawing.
 */
(function (global) {
  "use strict";

  const cfg = () => global.SHOTS_CONFIG || {};

  let client = null;

  function isConfigured() {
    const c = cfg();
    return !!(c.supabaseUrl && c.supabaseAnonKey && global.supabase);
  }

  function getClient() {
    if (!isConfigured()) return null;
    if (!client) {
      const c = cfg();
      client = global.supabase.createClient(c.supabaseUrl, c.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true },
      });
    }
    return client;
  }

  function pinValue() {
    return String(cfg().pin || "KEPPA").trim().toUpperCase();
  }

  function throwIfError(error, fallback) {
    if (error) throw new Error(error.message || fallback || "Request failed");
  }

  const SHOT_SELECT_CORE = `
    *,
    player:players!shots_player_id_fkey (id, name, short_name),
    fouler:players!shots_fouler_player_id_fkey (id, name, short_name),
    assist_player:players!shots_assist_player_id_fkey (id, name, short_name)
  `;
  const SHOT_SELECT = `${SHOT_SELECT_CORE.trim()},
    second_assist_player:players!second_assist_player_id (id, name, short_name)
  `;

  function isMissingRelationship(error) {
    const msg = String(error?.message || "");
    return /could not find a relationship/i.test(msg) || /schema cache/i.test(msg);
  }

  async function runShotSelect(build) {
    const first = await build(SHOT_SELECT);
    if (!first.error || !isMissingRelationship(first.error)) return first;
    return build(SHOT_SELECT_CORE);
  }

  const GAME_SELECT = `
    *,
    season:seasons (*),
    home_team:teams!games_home_team_id_fkey (*),
    away_team:teams!games_away_team_id_fkey (*),
    our_team:teams!games_our_team_id_fkey (*)
  `;

  const ROSTER_SELECT = `
    *,
    player:players (*)
  `;

  const api = {
    isConfigured,
    pinValue,
    getClient,

    async getSession() {
      const sb = getClient();
      if (!sb) return null;
      const { data } = await sb.auth.getSession();
      return data.session || null;
    },

    async signInWithPin(entered) {
      if (String(entered || "").trim().toUpperCase() !== pinValue()) {
        return { ok: false, error: "Wrong PIN" };
      }
      const sb = getClient();
      if (!sb) return { ok: false, error: "Supabase is not configured" };
      const { data, error } = await sb.auth.signInAnonymously();
      if (error) {
        return {
          ok: false,
          error: error.message || "Sign-in failed. Enable Anonymous auth in Supabase.",
        };
      }
      return { ok: true, session: data.session };
    },

    async signOut() {
      const sb = getClient();
      if (sb) await sb.auth.signOut();
    },

    async teams() {
      const { data, error } = await getClient().from("teams").select("*").order("name");
      throwIfError(error, "Could not load teams");
      return data || [];
    },

    async seasons() {
      const { data, error } = await getClient()
        .from("seasons")
        .select("*")
        .order("year", { ascending: false })
        .order("label", { ascending: false });
      throwIfError(error, "Could not load seasons");
      return data || [];
    },

    async games(seasonId) {
      let q = getClient().from("games").select(GAME_SELECT).order("date", { ascending: false });
      if (seasonId) q = q.eq("season_id", seasonId);
      const { data, error } = await q;
      throwIfError(error, "Could not load games");
      return data || [];
    },

    async game(id) {
      const { data, error } = await getClient().from("games").select(GAME_SELECT).eq("id", id).single();
      throwIfError(error, "Could not load game");
      return data;
    },

    async createTeam(name) {
      const { data, error } = await getClient()
        .from("teams")
        .insert({ name: String(name).trim(), is_brighton: false })
        .select()
        .single();
      throwIfError(error, "Could not create team");
      return data;
    },

    async createSeason(year, label) {
      const { data, error } = await getClient()
        .from("seasons")
        .insert({ year: Number(year), label: String(label).trim() })
        .select()
        .single();
      throwIfError(error, "Could not create season");
      return data;
    },

    async createGame(row) {
      const { data, error } = await getClient().from("games").insert(row).select(GAME_SELECT).single();
      throwIfError(error, "Could not create game");
      return data;
    },

    async updateGame(id, patch) {
      const { data, error } = await getClient()
        .from("games")
        .update(patch)
        .eq("id", id)
        .select(GAME_SELECT)
        .single();
      throwIfError(error, "Could not update game");
      return data;
    },

    async roster(teamId, seasonId) {
      const { data, error } = await getClient()
        .from("rosters")
        .select(ROSTER_SELECT)
        .eq("team_id", teamId)
        .eq("season_id", seasonId)
        .order("jersey_number");
      throwIfError(error, "Could not load roster");
      return data || [];
    },

    async ensureRosterPlayer(teamId, seasonId, jerseyNumber, name) {
      const jersey = String(jerseyNumber);
      const existing = await getClient()
        .from("rosters")
        .select(ROSTER_SELECT)
        .eq("team_id", teamId)
        .eq("season_id", seasonId)
        .eq("jersey_number", jersey)
        .maybeSingle();
      throwIfError(existing.error, "Could not look up roster");
      if (existing.data) return existing.data;

      const playerInsert = await getClient()
        .from("players")
        .insert({
          name: name ? String(name).trim() : null,
          short_name: null,
        })
        .select()
        .single();
      throwIfError(playerInsert.error, "Could not create player");

      const rosterInsert = await getClient()
        .from("rosters")
        .insert({
          team_id: teamId,
          season_id: seasonId,
          player_id: playerInsert.data.id,
          jersey_number: jersey,
          squad: "varsity",
        })
        .select(ROSTER_SELECT)
        .single();
      if (rosterInsert.error) {
        const again = await getClient()
          .from("rosters")
          .select(ROSTER_SELECT)
          .eq("team_id", teamId)
          .eq("season_id", seasonId)
          .eq("jersey_number", jersey)
          .maybeSingle();
        if (again.data) return again.data;
        throwIfError(rosterInsert.error, "Could not add roster row");
      }
      return rosterInsert.data;
    },

    async updatePlayer(id, patch) {
      const { data, error } = await getClient().from("players").update(patch).eq("id", id).select().single();
      throwIfError(error, "Could not update player");
      return data;
    },

    async shotsForGame(gameId) {
      const { data, error } = await runShotSelect((select) =>
        getClient().from("shots").select(select).eq("game_id", gameId).order("created_at", { ascending: false })
      );
      throwIfError(error, "Could not load shots");
      return data || [];
    },

    async insertShot(row) {
      const { data, error } = await runShotSelect((select) =>
        getClient().from("shots").insert(row).select(select).single()
      );
      if (!error) return { ok: true, data };
      if (/second_assist_|game_clock_seconds|schema cache|Could not find/i.test(error.message || "")) {
        const slim = { ...row };
        Object.keys(slim).forEach((k) => {
          if (k.startsWith("second_assist_")) delete slim[k];
        });
        delete slim.game_clock_seconds;
        const retry = await runShotSelect((select) =>
          getClient().from("shots").insert(slim).select(select).single()
        );
        if (!retry.error) return { ok: true, data: retry.data };
        return { ok: false, error: retry.error.message || "Not saved — check connection" };
      }
      return { ok: false, error: error.message || "Not saved — check connection" };
    },

    async updateShot(id, patch) {
      const { data, error } = await runShotSelect((select) =>
        getClient().from("shots").update(patch).eq("id", id).select(select).single()
      );
      if (error) return { ok: false, error: error.message || "Not saved — check connection" };
      return { ok: true, data };
    },

    async deleteShot(id) {
      const { error } = await getClient().from("shots").delete().eq("id", id);
      if (error) return { ok: false, error: error.message || "Could not delete" };
      return { ok: true };
    },

    async queryShots(filters) {
      const extraCore = `,
          game:games!shots_game_id_fkey (
            id, date, game_type, season_id, home_team_id, away_team_id, our_team_id,
            season:seasons (*),
            home_team:teams!games_home_team_id_fkey (*),
            away_team:teams!games_away_team_id_fkey (*)
          ),
          team:teams!shots_team_id_fkey (*)
        `;
      const extra = `,
          game:games!shots_game_id_fkey (
            id, date, game_type, season_id, home_team_id, away_team_id, our_team_id,
            clock_direction, clock_half_length_sec, clock_et_length_sec,
            season:seasons (*),
            home_team:teams!games_home_team_id_fkey (*),
            away_team:teams!games_away_team_id_fkey (*)
          ),
          team:teams!shots_team_id_fkey (*)
        `;
      const applyFilters = (q) => {
        if (filters.playerId) q = q.eq("player_id", filters.playerId);
        if (filters.teamId) q = q.eq("team_id", filters.teamId);
        if (filters.gameId) q = q.eq("game_id", filters.gameId);
        if (filters.gameIds && filters.gameIds.length) q = q.in("game_id", filters.gameIds);
        if (filters.result) q = q.eq("result", filters.result);
        if (filters.period) q = q.eq("period", filters.period);
        if (filters.zoneId) q = q.eq("zone_id", filters.zoneId);
        if (filters.zonePrefix) q = q.like("zone_id", `${filters.zonePrefix}%`);
        if (filters.zoneIds && filters.zoneIds.length) q = q.in("zone_id", filters.zoneIds);
        if (filters.depthIds && filters.depthIds.length) {
          const ors = filters.depthIds
            .map((d) => (d === "DEF" ? "zone_id.eq.DEF" : `zone_id.like.%-${d}`))
            .join(",");
          q = q.or(ors);
        }
        return q.order("created_at", { ascending: false }).limit(5000);
      };
      let { data, error } = await runShotSelect((select) =>
        applyFilters(getClient().from("shots").select(`${select}${extra}`))
      );
      if (error && /clock_direction|clock_half_length|clock_et_length|schema cache/i.test(error.message || "")) {
        const retry = await runShotSelect((select) =>
          applyFilters(getClient().from("shots").select(`${select}${extraCore}`))
        );
        data = retry.data;
        error = retry.error;
      }
      throwIfError(error, "Could not query shots");
      let rows = data || [];

      if (filters.seasonId) {
        rows = rows.filter((s) => s.game && s.game.season_id === filters.seasonId);
      }
      if (filters.opponentId) {
        rows = rows.filter(
          (s) =>
            s.game &&
            (s.game.home_team_id === filters.opponentId || s.game.away_team_id === filters.opponentId)
        );
      }
      if (filters.seasonYearMin) {
        rows = rows.filter((s) => s.game?.season && s.game.season.year >= filters.seasonYearMin);
      }
      return rows;
    },

    async namedPlayers() {
      const { data, error } = await getClient()
        .from("players")
        .select("*")
        .not("name", "is", null)
        .order("name");
      throwIfError(error, "Could not load players");
      return data || [];
    },

    /**
     * Natural-language explore via Edge Function explore-shots.
     * Requires staff PIN session. OPENAI_API_KEY must be set as a Supabase secret.
     */
    async explore(question, history) {
      const sb = getClient();
      if (!sb) return { ok: false, error: "Supabase is not configured" };
      const { data, error } = await sb.functions.invoke("explore-shots", {
        body: {
          question: String(question || "").trim(),
          history: Array.isArray(history) ? history : [],
        },
      });
      const payload = data && typeof data === "object" ? data : null;
      if (error) {
        const msg =
          (payload && payload.error) ||
          error.message ||
          "Explore request failed. Deploy explore-shots and set OPENAI_API_KEY.";
        return { ok: false, error: msg, data: payload };
      }
      if (payload && payload.error) {
        return { ok: false, error: payload.error, data: payload };
      }
      return { ok: true, data: payload };
    },

    async notesForGames(gameIds) {
      const ids = (gameIds || []).filter(Boolean);
      if (!ids.length) return [];
      const { data, error } = await getClient()
        .from("notes")
        .select("*, note_tags (tag)")
        .in("game_id", ids)
        .order("created_at", { ascending: false });
      throwIfError(error, "Could not load notes");
      return (data || []).map((row) => ({
        ...row,
        tags: (row.note_tags || []).map((t) => t.tag).filter(Boolean),
      }));
    },

    async createNote(row) {
      const tags = normalizeNoteTags(row.tags);
      const insert = await getClient()
        .from("notes")
        .insert({
          game_id: row.game_id,
          body: String(row.body || "").trim(),
          author_label: row.author_label ? String(row.author_label).trim() : null,
        })
        .select("*")
        .single();
      throwIfError(insert.error, "Could not save note");
      await replaceNoteTags(insert.data.id, tags);
      return { ...insert.data, tags };
    },

    async updateNote(id, patch) {
      const body = {};
      if (patch.body != null) body.body = String(patch.body).trim();
      if (Object.prototype.hasOwnProperty.call(patch, "author_label")) {
        body.author_label = patch.author_label ? String(patch.author_label).trim() : null;
      }
      let data = null;
      if (Object.keys(body).length) {
        const upd = await getClient().from("notes").update(body).eq("id", id).select("*").single();
        throwIfError(upd.error, "Could not update note");
        data = upd.data;
      } else {
        const existing = await getClient().from("notes").select("*").eq("id", id).single();
        throwIfError(existing.error, "Could not load note");
        data = existing.data;
      }
      let tags = null;
      if (Object.prototype.hasOwnProperty.call(patch, "tags")) {
        tags = normalizeNoteTags(patch.tags);
        await replaceNoteTags(id, tags);
      }
      if (tags == null) {
        const { data: tagRows, error } = await getClient().from("note_tags").select("tag").eq("note_id", id);
        throwIfError(error, "Could not load tags");
        tags = (tagRows || []).map((t) => t.tag);
      }
      return { ...data, tags };
    },

    async deleteNote(id) {
      const { error } = await getClient().from("notes").delete().eq("id", id);
      if (error) return { ok: false, error: error.message || "Could not delete note" };
      return { ok: true };
    },

    /**
     * Opponent Prep briefing via Edge Function prep-opponent (Gemini).
     * Requires staff PIN session. GEMINI_API_KEY must be set as a Supabase secret.
     */
    async prepOpponent(payload) {
      const sb = getClient();
      if (!sb) return { ok: false, error: "Supabase is not configured" };
      const { data, error } = await sb.functions.invoke("prep-opponent", {
        body: payload && typeof payload === "object" ? payload : {},
      });
      const boxed = await functionPayload(data, error);
      if (error || (boxed && boxed.error)) {
        return {
          ok: false,
          error: friendlyPrepError((boxed && boxed.error) || error?.message),
          data: boxed,
        };
      }
      return { ok: true, data: boxed };
    },
  };

  async function functionPayload(data, error) {
    if (data && typeof data === "object") return data;
    const ctx = error && error.context;
    if (!ctx) return null;
    try {
      if (typeof ctx.json === "function") return await ctx.json();
      if (typeof ctx.clone === "function") return await ctx.clone().json();
    } catch (_) {
      /* body already consumed or not JSON */
    }
    return null;
  }

  function friendlyPrepError(msg) {
    const text = String(msg || "").trim();
    if (/GEMINI_API_KEY is not configured/i.test(text)) {
      return "Gemini is not configured on this Supabase project. In the DEV project run: supabase secrets set GEMINI_API_KEY=… (Google AI Studio key).";
    }
    if (/non-2xx status code/i.test(text)) {
      return "Prep summary failed. If this is a new project, set GEMINI_API_KEY on the Edge Function secrets.";
    }
    return text || "Prep request failed. Deploy prep-opponent and set GEMINI_API_KEY.";
  }

  function normalizeNoteTags(raw) {
    const list = Array.isArray(raw)
      ? raw
      : String(raw || "")
          .split(/[,;]+/)
          .map((t) => t.trim());
    const seen = new Set();
    const out = [];
    list.forEach((item) => {
      const tag = String(item || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
      if (!tag || seen.has(tag)) return;
      seen.add(tag);
      out.push(tag);
    });
    return out;
  }

  async function replaceNoteTags(noteId, tags) {
    const del = await getClient().from("note_tags").delete().eq("note_id", noteId);
    throwIfError(del.error, "Could not update tags");
    if (!tags.length) return;
    const ins = await getClient()
      .from("note_tags")
      .insert(tags.map((tag) => ({ note_id: noteId, tag })));
    throwIfError(ins.error, "Could not save tags");
  }

  global.ShotAPI = api;
})(window);
