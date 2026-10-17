/**
 * Club Player Visitation Planner
 *
 *   #club / #club-agenda     upcoming fixtures (browse)
 *   #club-itinerary          itinerary builder; optional game picker
 *   #club-data               record browser (teams, sources, facilities, sync)
 *
 * Requires staff PIN session for writes (same as Shot Tracker).
 */
(function (global) {
  "use strict";

  const TZ = "America/Denver";
  const DEFAULT_VISIT = 30;
  const WALK_MIN = 8;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const rootEl = () => document.getElementById("app-root");
  const api = () => global.ShotAPI;

  const st = {
    tab: "agenda",
    pinBusy: false,
    sessionOk: false,
    loading: false,
    error: "",
    agenda: {
      games: [],
      dateFrom: "",
      dateTo: "",
      filterPlayer: "",
      filterTeam: "",
      filterText: "",
      onlyBoth: false,
      filtersOpen: false,
    },
    itinerary: {
      list: [],
      currentId: "",
      draft: null,
      pickerOpen: false,
      stops: [],
      legs: [],
      warnings: [],
      gemini: { loading: false, error: "", messages: [], draft: "" },
      busy: false,
    },
    data: {
      section: "teams",
      teams: [],
      affiliations: [],
      competitions: [],
      sources: [],
      facilities: [],
      fields: [],
      games: [],
      players: [],
      syncRuns: [],
      importPreview: null,
      busy: false,
    },
    players: [],
    settings: null,
  };

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function showToast(text) {
    const el = $("#role-toast");
    if (!el) return;
    el.textContent = text;
    el.classList.add("is-visible");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.remove("is-visible"), 2600);
  }

  function todayLocal() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }

  function addDays(dateStr, n) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return dt.toISOString().slice(0, 10);
  }

  function formatKickoff(iso) {
    if (!iso) return "Time TBD";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "Time TBD";
    return new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(d);
  }

  function localDateKey(iso) {
    if (!iso) return "tbd";
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));
  }

  function mapsLink(lat, lng, label) {
    if (lat == null || lng == null) return null;
    return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
  }

  function parseHashTab() {
    const raw = (location.hash || "#club").replace(/^#/, "");
    const path = raw.split("?")[0];
    if (path === "club-itinerary") return "itinerary";
    if (path === "club-data") return "data";
    return "agenda";
  }

  async function ensureSession() {
    const a = api();
    if (!a) return false;
    const session = await a.getSession();
    st.sessionOk = !!session;
    return st.sessionOk;
  }

  async function requireSessionUi() {
    if (await ensureSession()) return true;
    paintPinGate();
    return false;
  }

  function paintPinGate() {
    const root = rootEl();
    if (!root) return;
    root.innerHTML = `
      <section class="club-shell">
        <header class="club-hero">
          <p class="club-kicker">Club Player Visitation Planner</p>
          <h1>Staff access</h1>
          <p class="muted">Enter the staff PIN to view club schedules and build visit itineraries.</p>
        </header>
        <form id="club-pin-form" class="club-pin-form">
          <label for="club-pin">PIN</label>
          <input id="club-pin" type="password" inputmode="text" autocomplete="current-password" maxlength="32" />
          <p class="form-error" id="club-pin-error" hidden></p>
          <button type="submit" class="btn btn-primary" ${st.pinBusy ? "disabled" : ""}>Unlock</button>
        </form>
      </section>`;
    $("#club-pin-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("#club-pin-error");
      const val = $("#club-pin")?.value || "";
      st.pinBusy = true;
      paintPinGate();
      const res = await api().signInWithPin(val);
      st.pinBusy = false;
      if (!res.ok) {
        st.sessionOk = false;
        paintPinGate();
        const el = $("#club-pin-error");
        if (el) {
          el.hidden = false;
          el.textContent = res.error || "Wrong PIN";
        }
        return;
      }
      st.sessionOk = true;
      try {
        await api().clubRegisterSyncWorker();
      } catch (_) {
        /* optional */
      }
      render();
    });
    requestAnimationFrame(() => $("#club-pin")?.focus());
  }

  function iconDatabase() {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>`;
  }

  function iconFilter() {
    return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16l-6.2 7.2V19l-3.6 2v-8.8L4 5z"/></svg>`;
  }

  function shell(inner) {
    const tab = st.tab;
    return `
      <section class="club-shell">
        <header class="club-hero">
          <p class="club-kicker">Brighton soccer</p>
          <h1>Club visits</h1>
          <p class="muted">Find returning players at club games and plan realistic field visits.</p>
        </header>
        <nav class="club-tabs" role="tablist" aria-label="Club planner">
          <a class="prep-tab ${tab === "agenda" ? "is-on" : ""}" href="#club-agenda" role="tab" aria-selected="${tab === "agenda"}">Agenda</a>
          <a class="prep-tab ${tab === "itinerary" ? "is-on" : ""}" href="#club-itinerary" role="tab" aria-selected="${tab === "itinerary"}">Itinerary</a>
          <a class="club-data-link ${tab === "data" ? "is-on" : ""}" href="#club-data" role="tab" aria-selected="${tab === "data"}" aria-label="Club data" title="Club data">${iconDatabase()}</a>
        </nav>
        ${st.error ? `<p class="form-error club-banner-error">${escapeHtml(st.error)}</p>` : ""}
        ${st.loading ? `<p class="muted club-loading">Loading…</p>` : ""}
        ${inner}
      </section>`;
  }

  // ---------------------------------------------------------------------------
  // Data loaders
  // ---------------------------------------------------------------------------

  async function loadPlayers() {
    if (api().isPlaceholderConfig?.()) {
      st.players = [];
      return;
    }
    const sb = api().getClient();
    const { data, error } = await sb.from("players").select("id, name, short_name").order("name");
    if (error) throw error;
    st.players = data || [];
  }

  async function loadAgenda() {
    if (!st.agenda.dateFrom) {
      st.agenda.dateFrom = todayLocal();
      st.agenda.dateTo = addDays(st.agenda.dateFrom, 7);
    }
    if (api().isPlaceholderConfig?.()) {
      st.agenda.games = [];
      return;
    }
    const res = await api().clubVisitation({
      mode: "tool",
      tool: "search_club_games",
      arguments: {
        date_from: st.agenda.dateFrom,
        date_to: st.agenda.dateTo,
        both_sides: st.agenda.onlyBoth || undefined,
        include_cancelled: false,
      },
    });
    if (!res.ok) {
      // Fallback: direct table read if edge function not deployed yet
      await loadAgendaDirect();
      return;
    }
    st.agenda.games = res.data?.result?.games || [];
  }

  async function loadAgendaDirect() {
    const sb = api().getClient();
    const { data: games, error } = await sb
      .from("club_games")
      .select(
        `id, kickoff_at, status, home_team_id, away_team_id, raw_home_label, raw_away_label,
         home:club_teams!club_games_home_team_id_fkey (team_name),
         away:club_teams!club_games_away_team_id_fkey (team_name),
         competition:club_competitions (name),
         facility:club_facilities (id, name, city, latitude, longitude),
         field:club_fields (label)`
      )
      .order("kickoff_at", { ascending: true, nullsFirst: false });
    if (error) throw error;
    const teamIds = [...new Set((games || []).flatMap((g) => [g.home_team_id, g.away_team_id]).filter(Boolean))];
    let aff = [];
    if (teamIds.length) {
      const { data } = await sb
        .from("club_player_affiliations")
        .select("club_team_id, player_id, player:players (id, name, short_name)")
        .in("club_team_id", teamIds)
        .eq("active", true);
      aff = data || [];
    }
    const byTeam = new Map();
    for (const a of aff) {
      if (!byTeam.has(a.club_team_id)) byTeam.set(a.club_team_id, []);
      byTeam.get(a.club_team_id).push({
        player_id: a.player_id,
        name: a.player?.short_name || a.player?.name,
        side: null,
      });
    }
    const from = st.agenda.dateFrom;
    const to = st.agenda.dateTo;
    st.agenda.games = (games || [])
      .filter((g) => {
        if (g.status === "cancelled") return false;
        if (!g.kickoff_at) return true;
        const key = localDateKey(g.kickoff_at);
        return key >= from && key <= to;
      })
      .map((g) => {
        const homeP = (byTeam.get(g.home_team_id) || []).map((p) => ({ ...p, side: "home" }));
        const awayP = (byTeam.get(g.away_team_id) || []).map((p) => ({ ...p, side: "away" }));
        const ids = new Set([...homeP, ...awayP].map((p) => p.player_id));
        return {
          game_id: g.id,
          kickoff_at: g.kickoff_at,
          status: g.status,
          home_team: g.home?.team_name || g.raw_home_label || "TBD",
          away_team: g.away?.team_name || g.raw_away_label || "TBD",
          competition: g.competition?.name,
          facility: g.facility?.name,
          field: g.field?.label,
          city: g.facility?.city,
          lat: g.facility?.latitude,
          lng: g.facility?.longitude,
          home_brighton_players: homeP,
          away_brighton_players: awayP,
          brighton_players: [...homeP, ...awayP],
          brighton_player_count: ids.size,
          brighton_both_sides: homeP.length > 0 && awayP.length > 0,
        };
      })
      .filter((g) => g.brighton_player_count > 0);
  }

  async function loadItineraryList() {
    if (api().isPlaceholderConfig?.()) {
      st.itinerary.list = [];
      return;
    }
    const sb = api().getClient();
    const { data, error } = await sb
      .from("club_itineraries")
      .select("id, name, target_date, updated_at")
      .order("updated_at", { ascending: false });
    if (error) throw error;
    st.itinerary.list = data || [];
  }

  async function loadItinerary(id) {
    const sb = api().getClient();
    const { data: itin, error } = await sb.from("club_itineraries").select("*").eq("id", id).single();
    if (error) throw error;
    const { data: stops } = await sb
      .from("club_itinerary_stops")
      .select("*, game:club_games (*, facility:club_facilities (*), field:club_fields (*), home:club_teams!club_games_home_team_id_fkey (team_name), away:club_teams!club_games_away_team_id_fkey (team_name))")
      .eq("club_itinerary_id", id)
      .order("stop_order");
    st.itinerary.currentId = id;
    st.itinerary.draft = itin;
    st.itinerary.stops = await enrichStops(stops || []);
    await refreshLegs();
    await checkStale(itin, st.itinerary.stops);
  }

  async function enrichStops(rawStops) {
    const sb = api().getClient();
    const out = [];
    for (const s of rawStops) {
      const g = s.game || {};
      const teamIds = [g.home_team_id, g.away_team_id].filter(Boolean);
      let players = [];
      if (teamIds.length) {
        const { data: aff } = await sb
          .from("club_player_affiliations")
          .select("club_team_id, player:players (short_name, name)")
          .in("club_team_id", teamIds)
          .eq("active", true);
        players = (aff || []).map((a) => a.player?.short_name || a.player?.name).filter(Boolean);
      }
      out.push({
        stop_id: s.id,
        game_id: s.club_game_id,
        stop_order: s.stop_order,
        locked: !!s.locked,
        notes: s.notes || "",
        visit_minutes: s.visit_minutes || st.itinerary.draft?.default_visit_minutes || DEFAULT_VISIT,
        kickoff_at: g.kickoff_at,
        status: g.status,
        facility_id: g.club_facility_id || g.facility?.id,
        facility_name: g.facility?.name,
        field_label: g.field?.label,
        lat: g.facility?.latitude,
        lng: g.facility?.longitude,
        team_line: `${g.home?.team_name || "TBD"} vs ${g.away?.team_name || "TBD"}`,
        brighton_line: [...new Set(players)].join(", "),
        planned_arrival_at: s.planned_arrival_at,
        planned_departure_at: s.planned_departure_at,
      });
    }
    return out;
  }

  async function checkStale(itin, stops) {
    const sb = api().getClient();
    const since = itin.updated_at || itin.created_at;
    const warnings = [];
    for (const s of stops) {
      const { data } = await sb
        .from("club_game_changes")
        .select("changed_fields, observed_at, review_status")
        .eq("club_game_id", s.game_id)
        .gte("observed_at", since)
        .limit(3);
      if (data?.length) {
        warnings.push({
          type: "stale",
          message: `${s.team_line}: schedule changed (${data.map((d) => (d.changed_fields || []).join("/")).join(", ")})`,
        });
      }
      if (s.status === "cancelled") {
        warnings.push({ type: "cancelled", message: `${s.team_line} was cancelled` });
      }
    }
    st.itinerary.warnings = [...(st.itinerary.warnings || []).filter((w) => w.type !== "stale" && w.type !== "cancelled"), ...warnings];
  }

  async function refreshLegs() {
    const stops = st.itinerary.stops;
    const legs = [];
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i];
      const b = stops[i + 1];
      if (a.facility_id && b.facility_id && a.facility_id === b.facility_id) {
        legs.push({ mode: "walk", minutes: WALK_MIN, note: "Same facility (approx walk)" });
        continue;
      }
      const res = await api().clubVisitation({
        mode: "travel",
        arguments: {
          origin: { lat: a.lat, lng: a.lng, facility_id: a.facility_id },
          destinations: [{ lat: b.lat, lng: b.lng, facility_id: b.facility_id }],
        },
      });
      const r = res.data?.result?.results?.[0];
      if (!res.ok || !r || r.unavailable || r.minutes == null) {
        legs.push({ mode: "drive", minutes: null, unavailable: true, note: "Travel time unavailable" });
      } else {
        legs.push({ mode: "drive", minutes: r.minutes, unavailable: false, note: "Estimated drive" });
      }
    }
    st.itinerary.legs = legs;
    // Feasibility
    const feasWarnings = [];
    let cursor = null;
    stops.forEach((s, i) => {
      const kick = s.kickoff_at ? new Date(s.kickoff_at).getTime() : null;
      let arrive = kick != null ? kick - 5 * 60000 : cursor;
      if (i > 0) {
        const leg = legs[i - 1];
        const prev = stops[i - 1];
        const prevDep = prev.planned_departure_at
          ? new Date(prev.planned_departure_at).getTime()
          : cursor;
        if (leg?.unavailable) {
          feasWarnings.push({ type: "missing_route", message: `Travel unknown into stop ${i + 1}` });
        } else if (prevDep != null && leg?.minutes != null) {
          const earliest = prevDep + leg.minutes * 60000;
          if (arrive == null || earliest > arrive) arrive = earliest;
          if (kick != null && earliest > kick + 15 * 60000) {
            feasWarnings.push({ type: "impossible", message: `Impossible timing into stop ${i + 1}` });
          } else if (kick != null && earliest > kick - 5 * 60000) {
            feasWarnings.push({ type: "tight", message: `Tight timing into stop ${i + 1}` });
          }
        }
      }
      if (arrive != null) {
        s.planned_arrival_at = new Date(arrive).toISOString();
        s.planned_departure_at = new Date(arrive + (s.visit_minutes || DEFAULT_VISIT) * 60000).toISOString();
        cursor = new Date(s.planned_departure_at).getTime();
      }
    });
    st.itinerary.warnings = [
      ...(st.itinerary.warnings || []).filter((w) => ["stale", "cancelled"].includes(w.type)),
      ...feasWarnings,
    ];
  }

  async function loadDataSection() {
    if (api().isPlaceholderConfig?.()) {
      st.data.teams = [];
      st.data.affiliations = [];
      st.data.competitions = [];
      st.data.sources = [];
      st.data.facilities = [];
      st.data.fields = [];
      st.data.games = [];
      st.data.syncRuns = [];
      return;
    }
    const sb = api().getClient();
    const d = st.data;
    const [teams, aff, comps, sources, fac, fields, games, runs] = await Promise.all([
      sb.from("club_teams").select("*").order("team_name"),
      sb.from("club_player_affiliations").select("*, player:players (name, short_name), team:club_teams (team_name)").eq("active", true),
      sb.from("club_competitions").select("*").order("name"),
      sb.from("club_schedule_sources").select("*, team_competition:club_team_competitions (club_team_id, club_competition_id)").order("updated_at", { ascending: false }),
      sb.from("club_facilities").select("*").order("name"),
      sb.from("club_fields").select("*").order("label"),
      sb.from("club_games").select("id, kickoff_at, status, home_team_id, away_team_id, raw_home_label, raw_away_label").order("kickoff_at", { ascending: true }).limit(100),
      sb.from("club_sync_runs").select("*, source:club_schedule_sources (source_url)").order("started_at", { ascending: false }).limit(20),
    ]);
    if (teams.error) throw teams.error;
    d.teams = teams.data || [];
    d.affiliations = aff.data || [];
    d.competitions = comps.data || [];
    d.sources = sources.data || [];
    d.facilities = fac.data || [];
    d.fields = fields.data || [];
    d.games = games.data || [];
    d.syncRuns = runs.data || [];
    if (!st.players.length) await loadPlayers();
  }

  // ---------------------------------------------------------------------------
  // Agenda UI
  // ---------------------------------------------------------------------------

  function filteredAgendaGames() {
    let list = st.agenda.games || [];
    const q = st.agenda.filterText.trim().toLowerCase();
    if (q) {
      list = list.filter((g) => {
        const blob = [
          g.home_team,
          g.away_team,
          g.facility,
          g.competition,
          ...(g.brighton_players || []).map((p) => p.name),
        ]
          .join(" ")
          .toLowerCase();
        return blob.includes(q);
      });
    }
    if (st.agenda.filterPlayer) {
      list = list.filter((g) =>
        (g.brighton_players || []).some((p) => p.player_id === st.agenda.filterPlayer)
      );
    }
    if (st.agenda.onlyBoth) list = list.filter((g) => g.brighton_both_sides);
    return list;
  }

  function shortMd(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
    const [, m, d] = iso.split("-");
    return `${Number(m)}/${Number(d)}`;
  }

  function filtersAreNarrowed() {
    return !!(st.agenda.filterPlayer || st.agenda.onlyBoth || String(st.agenda.filterText || "").trim());
  }

  function filterSummary(count) {
    const from = shortMd(st.agenda.dateFrom);
    const to = shortMd(st.agenda.dateTo);
    const parts = [];
    if (from && to) parts.push(`${from}–${to}`);
    if (st.agenda.filterPlayer) {
      const p = st.players.find((x) => x.id === st.agenda.filterPlayer);
      if (p) parts.push(p.short_name || p.name);
    }
    if (st.agenda.onlyBoth) parts.push("Both sides");
    const q = String(st.agenda.filterText || "").trim();
    if (q) parts.push(q);
    parts.push(`${count} game${count === 1 ? "" : "s"}`);
    return parts.join(" · ");
  }

  function agendaFiltersMarkup() {
    const open = !!st.agenda.filtersOpen;
    const games = filteredAgendaGames();
    const playerOpts = st.players
      .map((p) => `<option value="${escapeHtml(p.id)}" ${st.agenda.filterPlayer === p.id ? "selected" : ""}>${escapeHtml(p.short_name || p.name)}</option>`)
      .join("");
    return `
      <div class="club-filter-bar">
        <button type="button" class="club-filter-toggle" id="club-filter-toggle" aria-expanded="${open}" aria-controls="club-filter-form">
          ${iconFilter()}
          Filters
          ${filtersAreNarrowed() ? `<span class="club-filter-dot" aria-hidden="true"></span>` : ""}
        </button>
        <p class="club-filter-summary">${escapeHtml(filterSummary(games.length))}</p>
      </div>
      <form id="club-filter-form" class="club-filters${open ? " is-open" : ""}">
        <div class="club-split">
          <label>From<input type="date" id="club-date-from" value="${escapeHtml(st.agenda.dateFrom)}" /></label>
          <label>To<input type="date" id="club-date-to" value="${escapeHtml(st.agenda.dateTo)}" /></label>
        </div>
        <label>Player
          <select id="club-filter-player">
            <option value="">All</option>
            ${playerOpts}
          </select>
        </label>
        <label class="club-check"><input type="checkbox" id="club-filter-both" ${st.agenda.onlyBoth ? "checked" : ""} /> Brighton vs Brighton</label>
        <label>Search<input type="search" id="club-filter-text" value="${escapeHtml(st.agenda.filterText)}" placeholder="Team, player, venue" /></label>
        <button type="submit" class="btn btn-primary" id="club-agenda-refresh">Apply</button>
      </form>`;
  }

  function agendaListMarkup(mode) {
    const games = filteredAgendaGames();
    const picked = new Set((st.itinerary.stops || []).map((s) => s.game_id));
    const byDay = new Map();
    for (const g of games) {
      const key = localDateKey(g.kickoff_at);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(g);
    }
    const dayBlocks = [...byDay.entries()]
      .sort((a, b) => {
        if (a[0] === "tbd") return 1;
        if (b[0] === "tbd") return -1;
        return a[0].localeCompare(b[0]);
      })
      .map(([day, items]) => {
        const title = day === "tbd" ? "Kickoff TBD" : day;
        const cards = items
          .map((g) => {
            const both = g.brighton_both_sides
              ? `<span class="club-badge club-badge-both">Brighton both sides</span>`
              : "";
            const changed = g.recently_changed ? `<span class="club-badge club-badge-changed">Updated</span>` : "";
            const players = (g.brighton_players || [])
              .map((p) => `${escapeHtml(p.name)}${p.side ? ` (${p.side})` : ""}`)
              .join(", ");
            const map = mapsLink(g.lat, g.lng, g.facility);
            const venue = [g.facility, g.field].filter(Boolean).join(" · ") || "Venue TBD";
            const already = picked.has(g.game_id);
            const addControl =
              mode === "pick"
                ? already
                  ? `<button type="button" class="btn btn-ghost" disabled>Added</button>`
                  : `<button type="button" class="btn btn-secondary" data-add-itin="${escapeHtml(g.game_id)}">Add</button>`
                : "";
            return `
              <article class="club-game-card${already && mode === "pick" ? " is-added" : ""}" data-game-id="${escapeHtml(g.game_id)}">
                <div class="club-game-card-top">
                  <time>${escapeHtml(formatKickoff(g.kickoff_at))}</time>
                  <span class="club-status">${escapeHtml(g.status || "scheduled")}</span>
                </div>
                <h3>${escapeHtml(g.home_team)} <span class="muted">vs</span> ${escapeHtml(g.away_team)}</h3>
                <p class="club-players">${players || "No Brighton players linked"} · ${g.brighton_player_count || 0} player${(g.brighton_player_count || 0) === 1 ? "" : "s"}</p>
                <p class="muted">${escapeHtml(venue)}${g.city ? ` · ${escapeHtml(g.city)}` : ""}${g.competition ? ` · ${escapeHtml(g.competition)}` : ""}</p>
                <div class="club-game-actions">
                  ${both}${changed}
                  ${map ? `<a class="btn btn-ghost" href="${escapeHtml(map)}" target="_blank" rel="noopener">Directions</a>` : `<span class="muted">No map pin</span>`}
                  ${addControl}
                </div>
              </article>`;
          })
          .join("");
        return `<section class="club-day"><h2>${escapeHtml(title)}</h2>${cards || "<p class='muted'>No games</p>"}</section>`;
      })
      .join("");

    return dayBlocks || `<p class="empty-state">No upcoming club games in this range.</p>`;
  }

  function agendaMarkup() {
    return `${agendaFiltersMarkup()}${agendaListMarkup("browse")}`;
  }

  function readAgendaFiltersFromForm() {
    const from = $("#club-date-from");
    if (!from) return;
    st.agenda.dateFrom = from.value || st.agenda.dateFrom;
    st.agenda.dateTo = $("#club-date-to")?.value || st.agenda.dateTo;
    st.agenda.filterPlayer = $("#club-filter-player")?.value || "";
    st.agenda.onlyBoth = !!$("#club-filter-both")?.checked;
    st.agenda.filterText = $("#club-filter-text")?.value || "";
  }

  async function applyAgendaFilters() {
    if (st.tab === "itinerary") readItineraryForm();
    readAgendaFiltersFromForm();
    st.agenda.filtersOpen = false;
    await refreshAgenda();
  }

  function bindAgendaFilters() {
    $("#club-filter-toggle")?.addEventListener("click", () => {
      if (st.tab === "itinerary") readItineraryForm();
      st.agenda.filtersOpen = !st.agenda.filtersOpen;
      paint();
    });
    $("#club-filter-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      applyAgendaFilters();
    });
  }

  function bindAgenda() {
    bindAgendaFilters();
  }

  async function addGameToDraft(gameId) {
    if (!st.itinerary.draft) {
      st.itinerary.draft = {
        name: `Visits ${todayLocal()}`,
        target_date: st.agenda.dateFrom || todayLocal(),
        default_visit_minutes: DEFAULT_VISIT,
        notes: "",
      };
      st.itinerary.currentId = "";
      st.itinerary.stops = [];
    }
    if (st.itinerary.stops.some((s) => s.game_id === gameId)) return;
    // Load game summary from agenda or DB
    let g = st.agenda.games.find((x) => x.game_id === gameId);
    if (!g) {
      await loadAgendaDirect();
      g = st.agenda.games.find((x) => x.game_id === gameId);
    }
    if (!g) {
      const sb = api().getClient();
      const { data } = await sb
        .from("club_games")
        .select(`*, facility:club_facilities (*), field:club_fields (*), home:club_teams!club_games_home_team_id_fkey (team_name), away:club_teams!club_games_away_team_id_fkey (team_name)`)
        .eq("id", gameId)
        .single();
      if (!data) return;
      g = {
        game_id: data.id,
        kickoff_at: data.kickoff_at,
        status: data.status,
        home_team: data.home?.team_name,
        away_team: data.away?.team_name,
        facility: data.facility?.name,
        field: data.field?.label,
        lat: data.facility?.latitude,
        lng: data.facility?.longitude,
        facility_id: data.club_facility_id,
        brighton_players: [],
      };
    }
    st.itinerary.stops.push({
      game_id: g.game_id,
      stop_order: st.itinerary.stops.length + 1,
      locked: false,
      visit_minutes: DEFAULT_VISIT,
      kickoff_at: g.kickoff_at,
      status: g.status,
      facility_id: g.facility_id || null,
      facility_name: g.facility,
      field_label: g.field,
      lat: g.lat,
      lng: g.lng,
      team_line: `${g.home_team || "TBD"} vs ${g.away_team || "TBD"}`,
      brighton_line: (g.brighton_players || []).map((p) => p.name).join(", "),
      notes: "",
    });
    await refreshLegs();
  }

  // ---------------------------------------------------------------------------
  // Itinerary UI
  // ---------------------------------------------------------------------------

  function readItineraryForm() {
    if (!st.itinerary.draft) {
      st.itinerary.draft = {
        name: `Visits ${todayLocal()}`,
        target_date: todayLocal(),
        default_visit_minutes: DEFAULT_VISIT,
        notes: "",
      };
    }
    const name = $("#club-itin-name");
    if (!name) return;
    st.itinerary.draft.name = name.value;
    st.itinerary.draft.target_date = $("#club-itin-date")?.value || "";
    st.itinerary.draft.start_location_label = $("#club-itin-start")?.value || "";
    st.itinerary.draft.notes = $("#club-itin-notes")?.value || "";
  }

  function itineraryFinderMarkup() {
    const open = !!st.itinerary.pickerOpen;
    return `
      <div class="club-finder">
        <button type="button" class="btn btn-secondary club-find-games" id="club-itin-find" aria-expanded="${open}" aria-controls="club-picker">
          ${open ? "Hide games" : "Find games to add"}
        </button>
        ${
          open
            ? `<div id="club-picker" class="club-picker">${agendaFiltersMarkup()}${agendaListMarkup("pick")}</div>`
            : ""
        }
      </div>`;
  }

  function itineraryMarkup() {
    const draft = st.itinerary.draft;
    const listOpts = st.itinerary.list
      .map(
        (i) =>
          `<option value="${escapeHtml(i.id)}" ${st.itinerary.currentId === i.id ? "selected" : ""}>${escapeHtml(i.name)}${i.target_date ? ` (${i.target_date})` : ""}</option>`
      )
      .join("");
    const stops = st.itinerary.stops
      .map((s, i) => {
        const leg =
          i < st.itinerary.legs.length
            ? st.itinerary.legs[i].unavailable || st.itinerary.legs[i].minutes == null
              ? `<p class="club-leg is-warn">→ Travel time unavailable</p>`
              : `<p class="club-leg">→ ${st.itinerary.legs[i].mode === "walk" ? "Walk/transition" : "Drive"} ~${st.itinerary.legs[i].minutes} min</p>`
            : "";
        const map = mapsLink(s.lat, s.lng, s.facility_name);
        return `
          <article class="club-stop-card" data-stop-index="${i}">
            <div class="club-stop-ord">
              <button type="button" class="btn btn-ghost" data-stop-up="${i}" ${i === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
              <button type="button" class="btn btn-ghost" data-stop-down="${i}" ${i === st.itinerary.stops.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
            </div>
            <div class="club-stop-body">
              <h3>${i + 1}. ${escapeHtml(s.team_line)}</h3>
              <p class="muted">${escapeHtml(formatKickoff(s.kickoff_at))} · ${escapeHtml([s.facility_name, s.field_label].filter(Boolean).join(" · ") || "Venue TBD")}</p>
              ${s.brighton_line ? `<p class="club-players">${escapeHtml(s.brighton_line)}</p>` : ""}
              <label class="club-inline">Visit min<input type="number" min="5" max="180" data-visit-min="${i}" value="${s.visit_minutes || DEFAULT_VISIT}" /></label>
              <label class="club-check"><input type="checkbox" data-lock="${i}" ${s.locked ? "checked" : ""} /> Lock</label>
              ${map ? `<a class="btn btn-ghost" target="_blank" rel="noopener" href="${escapeHtml(map)}">Map</a>` : ""}
              <button type="button" class="btn btn-ghost" data-remove-stop="${i}">Remove</button>
            </div>
            ${leg}
          </article>`;
      })
      .join("");

    const warns = (st.itinerary.warnings || [])
      .map((w) => `<li class="club-warn ${w.type === "impossible" || w.type === "stale" ? "is-bad" : ""}">${escapeHtml(w.message)}</li>`)
      .join("");

    const g = st.itinerary.gemini;
    const transcript = (g.messages || [])
      .map((m) =>
        m.role === "user"
          ? `<div class="explore-msg is-user">${escapeHtml(m.content)}</div>`
          : `<div class="explore-msg is-assistant">${escapeHtml(m.content)}</div>`
      )
      .join("");

    return `
      <div class="club-itin-toolbar">
        <label>Saved
          <select id="club-itin-select">
            <option value="">New itinerary…</option>
            ${listOpts}
          </select>
        </label>
        <button type="button" class="btn btn-ghost" id="club-itin-new">New</button>
      </div>
      <div class="club-itin-form">
        <label>Name<input id="club-itin-name" value="${escapeHtml(draft?.name || "")}" placeholder="Saturday North Valley" /></label>
        <div class="club-split">
          <label>Date<input type="date" id="club-itin-date" value="${escapeHtml(draft?.target_date || "")}" /></label>
          <label>Start<input id="club-itin-start" value="${escapeHtml(draft?.start_location_label || "")}" placeholder="Layton" /></label>
        </div>
        <label>Notes<textarea id="club-itin-notes" rows="2">${escapeHtml(draft?.notes || "")}</textarea></label>
      </div>
      ${itineraryFinderMarkup()}
      ${warns ? `<ul class="club-warn-list">${warns}</ul>` : ""}
      <div class="club-stops">${stops || `<p class="empty-state">No stops yet. Use Find games to add club games to this itinerary.</p>`}</div>
      <div class="club-itin-actions">
        <button type="button" class="btn btn-primary" id="club-itin-save" ${st.itinerary.busy ? "disabled" : ""}>Save</button>
        <button type="button" class="btn btn-secondary" id="club-itin-copy">Copy text</button>
        <button type="button" class="btn btn-ghost" id="club-itin-delete" ${st.itinerary.currentId ? "" : "hidden"}>Delete</button>
      </div>
      <section class="club-gemini">
        <h2>Ask Gemini</h2>
        <p class="muted">Questions use live club data tools — fixtures and drive times are not invented.</p>
        <div class="explore-transcript">${transcript || ""}</div>
        ${g.error ? `<p class="form-error">${escapeHtml(g.error)}</p>` : ""}
        <form id="club-gemini-form" class="explore-form">
          <label class="sr-only" for="club-gemini-input">Question</label>
          <textarea id="club-gemini-input" class="explore-input" rows="2" maxlength="2000" placeholder="Which Brighton-player games are near Layton Saturday?">${escapeHtml(g.draft || "")}</textarea>
          <button type="submit" class="btn btn-primary" ${g.loading ? "disabled" : ""}>${g.loading ? "Thinking…" : "Ask"}</button>
          <button type="button" class="btn btn-ghost" id="club-gemini-suggest" ${g.loading ? "disabled" : ""}>Suggest order</button>
        </form>
      </section>`;
  }

  function buildCopyText() {
    const d = st.itinerary.draft || {};
    const lines = [d.name || "Club visitation itinerary"];
    if (d.target_date) lines.push(`Date: ${d.target_date}`);
    if (d.start_location_label) lines.push(`Start: ${d.start_location_label}`);
    lines.push("");
    st.itinerary.stops.forEach((s, i) => {
      lines.push(`${i + 1}. ${s.team_line}`);
      if (s.brighton_line) lines.push(`   Brighton: ${s.brighton_line}`);
      lines.push(`   Kickoff: ${formatKickoff(s.kickoff_at)}`);
      if (s.planned_arrival_at) lines.push(`   Arrive ~ ${formatKickoff(s.planned_arrival_at)}`);
      lines.push(`   Venue: ${[s.facility_name, s.field_label].filter(Boolean).join(" · ") || "TBD"}`);
      const map = mapsLink(s.lat, s.lng, s.facility_name);
      if (map) lines.push(`   Map: ${map}`);
      if (i < st.itinerary.legs.length) {
        const leg = st.itinerary.legs[i];
        if (leg.mode === "walk") lines.push(`   → Walk/transition ~${leg.minutes} min (approx)`);
        else if (leg.unavailable || leg.minutes == null) lines.push(`   → Drive: time unavailable`);
        else lines.push(`   → Drive ~${leg.minutes} min (estimate)`);
      }
      lines.push("");
    });
    if (st.itinerary.warnings?.length) {
      lines.push("Warnings:");
      st.itinerary.warnings.forEach((w) => lines.push(`- ${w.message}`));
    }
    return lines.join("\n").trim() + "\n";
  }

  function bindItineraryAdds() {
    $$("[data-add-itin]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        readItineraryForm();
        const id = btn.getAttribute("data-add-itin");
        btn.disabled = true;
        await addGameToDraft(id);
        st.itinerary.pickerOpen = true;
        showToast("Added to this itinerary");
        paint();
      });
    });
  }

  function bindItinerary() {
    $("#club-itin-find")?.addEventListener("click", async () => {
      readItineraryForm();
      st.itinerary.pickerOpen = !st.itinerary.pickerOpen;
      if (st.itinerary.pickerOpen && !st.agenda.dateFrom) {
        await refreshAgenda();
        return;
      }
      paint();
    });
    if (st.itinerary.pickerOpen) {
      bindAgendaFilters();
      bindItineraryAdds();
    }
    $("#club-itin-select")?.addEventListener("change", async (e) => {
      const id = e.target.value;
      if (!id) {
        st.itinerary.currentId = "";
        st.itinerary.draft = { name: "", target_date: todayLocal(), default_visit_minutes: DEFAULT_VISIT };
        st.itinerary.stops = [];
        st.itinerary.legs = [];
        st.itinerary.warnings = [];
        paint();
        return;
      }
      st.loading = true;
      paint();
      try {
        await loadItinerary(id);
      } catch (err) {
        st.error = err.message || "Could not load itinerary";
      }
      st.loading = false;
      paint();
    });
    $("#club-itin-new")?.addEventListener("click", () => {
      st.itinerary.currentId = "";
      st.itinerary.draft = { name: `Visits ${todayLocal()}`, target_date: todayLocal(), default_visit_minutes: DEFAULT_VISIT };
      st.itinerary.stops = [];
      st.itinerary.legs = [];
      st.itinerary.warnings = [];
      paint();
    });
    $$("[data-stop-up]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        readItineraryForm();
        const i = Number(btn.getAttribute("data-stop-up"));
        if (i <= 0) return;
        const arr = st.itinerary.stops;
        [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
        await refreshLegs();
        paint();
      })
    );
    $$("[data-stop-down]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        readItineraryForm();
        const i = Number(btn.getAttribute("data-stop-down"));
        const arr = st.itinerary.stops;
        if (i >= arr.length - 1) return;
        [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
        await refreshLegs();
        paint();
      })
    );
    $$("[data-remove-stop]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        readItineraryForm();
        const i = Number(btn.getAttribute("data-remove-stop"));
        st.itinerary.stops.splice(i, 1);
        await refreshLegs();
        paint();
      })
    );
    $$("[data-lock]").forEach((el) =>
      el.addEventListener("change", () => {
        const i = Number(el.getAttribute("data-lock"));
        st.itinerary.stops[i].locked = el.checked;
      })
    );
    $$("[data-visit-min]").forEach((el) =>
      el.addEventListener("change", async () => {
        readItineraryForm();
        const i = Number(el.getAttribute("data-visit-min"));
        st.itinerary.stops[i].visit_minutes = Number(el.value) || DEFAULT_VISIT;
        await refreshLegs();
        paint();
      })
    );
    $("#club-itin-save")?.addEventListener("click", () => saveItinerary());
    $("#club-itin-copy")?.addEventListener("click", async () => {
      const text = buildCopyText();
      try {
        await navigator.clipboard.writeText(text);
        showToast("Copied itinerary");
      } catch (_) {
        global.prompt("Copy itinerary:", text);
      }
    });
    $("#club-itin-delete")?.addEventListener("click", () => deleteItinerary());
    $("#club-gemini-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      askGemini($("#club-gemini-input")?.value || "");
    });
    $("#club-gemini-suggest")?.addEventListener("click", () => suggestOrder());
    $("#club-gemini-input")?.addEventListener("input", (e) => {
      st.itinerary.gemini.draft = e.target.value;
    });
  }

  async function saveItinerary() {
    const sb = api().getClient();
    const name = $("#club-itin-name")?.value?.trim();
    if (!name) {
      showToast("Name required");
      return;
    }
    st.itinerary.busy = true;
    paint();
    const summary = buildCopyText();
    const row = {
      name,
      target_date: $("#club-itin-date")?.value || null,
      start_location_label: $("#club-itin-start")?.value || null,
      notes: $("#club-itin-notes")?.value || null,
      default_visit_minutes: DEFAULT_VISIT,
      summary_text: summary,
      updated_at: new Date().toISOString(),
    };
    try {
      let id = st.itinerary.currentId;
      if (id) {
        const { error } = await sb.from("club_itineraries").update(row).eq("id", id);
        if (error) throw error;
        await sb.from("club_itinerary_stops").delete().eq("club_itinerary_id", id);
      } else {
        const { data, error } = await sb.from("club_itineraries").insert(row).select().single();
        if (error) throw error;
        id = data.id;
        st.itinerary.currentId = id;
      }
      if (st.itinerary.stops.length) {
        const stops = st.itinerary.stops.map((s, i) => ({
          club_itinerary_id: id,
          club_game_id: s.game_id,
          stop_order: i + 1,
          visit_minutes: s.visit_minutes || DEFAULT_VISIT,
          locked: !!s.locked,
          notes: s.notes || null,
          planned_arrival_at: s.planned_arrival_at || null,
          planned_departure_at: s.planned_departure_at || null,
        }));
        const { error } = await sb.from("club_itinerary_stops").insert(stops);
        if (error) throw error;
      }
      st.itinerary.draft = { ...st.itinerary.draft, ...row, id };
      await loadItineraryList();
      showToast("Itinerary saved");
    } catch (err) {
      st.error = err.message || "Save failed";
    }
    st.itinerary.busy = false;
    paint();
  }

  async function deleteItinerary() {
    if (!st.itinerary.currentId) return;
    if (!global.confirm("Delete this itinerary?")) return;
    const sb = api().getClient();
    await sb.from("club_itineraries").delete().eq("id", st.itinerary.currentId);
    st.itinerary.currentId = "";
    st.itinerary.draft = null;
    st.itinerary.stops = [];
    await loadItineraryList();
    showToast("Deleted");
    paint();
  }

  async function askGemini(question) {
    const q = String(question || "").trim();
    if (!q) return;
    const g = st.itinerary.gemini;
    g.loading = true;
    g.error = "";
    g.messages.push({ role: "user", content: q });
    g.draft = "";
    paint();
    const res = await api().clubVisitation({
      mode: "ask",
      question: q,
      history: g.messages.slice(0, -1),
    });
    g.loading = false;
    if (!res.ok) {
      g.error = res.error || "Ask failed";
      paint();
      return;
    }
    g.messages.push({ role: "assistant", content: res.data?.answer || "(no answer)" });
    // If proposal game ids present in tool results, offer add — coach accepts manually via Agenda
    const tools = res.data?.tool_results || [];
    for (const t of tools) {
      const ids = t.result?.proposal?.ordered_game_ids;
      if (ids?.length && global.confirm("Apply suggested stop order to the draft itinerary?")) {
        const locked = new Set(st.itinerary.stops.filter((s) => s.locked).map((s) => s.game_id));
        // Add missing games then reorder
        for (const id of ids) {
          if (!st.itinerary.stops.some((s) => s.game_id === id)) await addGameToDraft(id);
        }
        const byId = new Map(st.itinerary.stops.map((s) => [s.game_id, s]));
        const ordered = [];
        for (const id of ids) if (byId.has(id)) ordered.push(byId.get(id));
        // keep locked relative — proposeOrder already respected; append leftovers
        for (const s of st.itinerary.stops) {
          if (!ordered.includes(s)) ordered.push(s);
        }
        // Never drop locked
        for (const id of locked) {
          if (!ordered.some((s) => s.game_id === id)) {
            const s = byId.get(id);
            if (s) ordered.push(s);
          }
        }
        st.itinerary.stops = ordered;
        await refreshLegs();
      }
    }
    paint();
  }

  async function suggestOrder() {
    const ids = st.itinerary.stops.map((s) => s.game_id);
    if (ids.length < 2) {
      showToast("Add at least two stops");
      return;
    }
    const locked = st.itinerary.stops.filter((s) => s.locked).map((s) => s.game_id);
    st.itinerary.gemini.loading = true;
    paint();
    const res = await api().clubVisitation({
      mode: "tool",
      tool: "propose_club_itinerary",
      arguments: { candidate_game_ids: ids, locked_game_ids: locked, viewing_minutes: DEFAULT_VISIT },
    });
    st.itinerary.gemini.loading = false;
    if (!res.ok) {
      st.itinerary.gemini.error = res.error;
      paint();
      return;
    }
    const order = res.data?.result?.proposal?.ordered_game_ids || [];
    if (!order.length) {
      showToast("No suggestion returned");
      paint();
      return;
    }
    if (!global.confirm("Apply suggested order? Locked stops stay included.")) {
      paint();
      return;
    }
    const byId = new Map(st.itinerary.stops.map((s) => [s.game_id, s]));
    st.itinerary.stops = order.map((id) => byId.get(id)).filter(Boolean);
    const warnings = res.data?.result?.proposal?.warnings || [];
    st.itinerary.warnings = [
      ...(st.itinerary.warnings || []).filter((w) => ["stale", "cancelled"].includes(w.type)),
      ...warnings,
    ];
    await refreshLegs();
    paint();
  }

  // ---------------------------------------------------------------------------
  // Club Data UI
  // ---------------------------------------------------------------------------

  function dataMarkup() {
    const sec = st.data.section;
    const nav = ["teams", "players", "competitions", "sources", "facilities", "games", "sync", "import"]
      .map(
        (s) =>
          `<button type="button" class="btn ${sec === s ? "btn-primary" : "btn-ghost"}" data-data-sec="${s}">${s}</button>`
      )
      .join("");

    let body = "";
    if (sec === "teams") {
      body = `
        <form id="club-add-team" class="club-mini-form">
          <h3>Add team</h3>
          <input name="organization_name" placeholder="Club / org" />
          <input name="team_name" placeholder="Team name" required />
          <input name="age_group" placeholder="Age group" />
          <button class="btn btn-primary" type="submit">Add</button>
        </form>
        <ul class="club-list">${st.data.teams
          .map(
            (t) =>
              `<li><strong>${escapeHtml(t.team_name)}</strong> <span class="muted">${escapeHtml(t.organization_name || "")}</span></li>`
          )
          .join("")}</ul>`;
    } else if (sec === "players") {
      const teamOpts = st.data.teams
        .map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.team_name)}</option>`)
        .join("");
      const playerOpts = st.players
        .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
        .join("");
      body = `
        <form id="club-add-aff" class="club-mini-form">
          <h3>Link Brighton player → club team</h3>
          <select name="player_id" required>${playerOpts}</select>
          <select name="club_team_id" required>${teamOpts}</select>
          <button class="btn btn-primary" type="submit">Link</button>
        </form>
        <ul class="club-list">${st.data.affiliations
          .map(
            (a) =>
              `<li>${escapeHtml(a.player?.short_name || a.player?.name || "?")} → ${escapeHtml(a.team?.team_name || "")}</li>`
          )
          .join("")}</ul>`;
    } else if (sec === "competitions") {
      body = `
        <form id="club-add-comp" class="club-mini-form">
          <h3>Add competition</h3>
          <input name="name" placeholder="Name" required />
          <select name="competition_type">
            <option value="league">league</option>
            <option value="tournament">tournament</option>
            <option value="invitational">invitational</option>
            <option value="friendly">friendly</option>
            <option value="other">other</option>
          </select>
          <button class="btn btn-primary" type="submit">Add</button>
        </form>
        <ul class="club-list">${st.data.competitions
          .map((c) => `<li>${escapeHtml(c.name)} <span class="muted">${escapeHtml(c.competition_type)}</span></li>`)
          .join("")}</ul>`;
    } else if (sec === "sources") {
      const tcNote = "Enroll a team in a competition first, then add a source URL.";
      body = `
        <p class="muted">${tcNote}</p>
        <form id="club-add-source" class="club-mini-form">
          <h3>Schedule source</h3>
          <select name="club_team_id" required>${st.data.teams.map((t) => `<option value="${t.id}">${escapeHtml(t.team_name)}</option>`).join("")}</select>
          <select name="club_competition_id" required>${st.data.competitions.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")}</select>
          <input name="source_url" placeholder="https://… schedule URL" required />
          <select name="provider">
            <option value="ics">ics</option>
            <option value="csv">csv</option>
            <option value="json">json</option>
            <option value="html">html</option>
            <option value="manual">manual</option>
          </select>
          <button class="btn btn-primary" type="submit">Add source</button>
        </form>
        <ul class="club-list">${st.data.sources
          .map(
            (s) =>
              `<li>
                <div><code>${escapeHtml(s.provider)}</code> ${escapeHtml(s.sync_status)} · ${escapeHtml(s.source_url)}</div>
                <button type="button" class="btn btn-secondary" data-sync-now="${escapeHtml(s.id)}">Sync now</button>
                ${s.last_error ? `<p class="form-error">${escapeHtml(s.last_error)}</p>` : ""}
                <p class="muted">Last ok: ${s.last_success_at ? escapeHtml(formatKickoff(s.last_success_at)) : "—"}</p>
              </li>`
          )
          .join("")}</ul>`;
    } else if (sec === "facilities") {
      body = `
        <form id="club-add-fac" class="club-mini-form">
          <h3>Facility</h3>
          <input name="name" placeholder="Name (e.g. RAC)" required />
          <input name="city" placeholder="City" />
          <input name="street_address" placeholder="Address" />
          <input name="latitude" placeholder="Lat" inputmode="decimal" />
          <input name="longitude" placeholder="Lng" inputmode="decimal" />
          <button class="btn btn-primary" type="submit">Add facility</button>
        </form>
        <form id="club-add-field" class="club-mini-form">
          <h3>Field</h3>
          <select name="club_facility_id">${st.data.facilities.map((f) => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join("")}</select>
          <input name="label" placeholder="Field 5" required />
          <button class="btn btn-primary" type="submit">Add field</button>
        </form>
        <ul class="club-list">${st.data.facilities
          .map((f) => {
            const fields = st.data.fields.filter((x) => x.club_facility_id === f.id).map((x) => x.label).join(", ");
            return `<li><strong>${escapeHtml(f.name)}</strong> ${escapeHtml(f.city || "")}<br/><span class="muted">${escapeHtml(fields || "No fields")}</span></li>`;
          })
          .join("")}</ul>`;
    } else if (sec === "games") {
      body = `
        <form id="club-add-game" class="club-mini-form">
          <h3>Manual game</h3>
          <select name="home_team_id">${st.data.teams.map((t) => `<option value="${t.id}">${escapeHtml(t.team_name)}</option>`).join("")}</select>
          <select name="away_team_id">${st.data.teams.map((t) => `<option value="${t.id}">${escapeHtml(t.team_name)}</option>`).join("")}</select>
          <input name="kickoff_at" type="datetime-local" />
          <select name="club_facility_id"><option value="">Venue TBD</option>${st.data.facilities.map((f) => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join("")}</select>
          <label class="club-check"><input type="checkbox" name="coach_verified" /> Coach verified (protect from sync overwrite)</label>
          <button class="btn btn-primary" type="submit">Add game</button>
        </form>
        <ul class="club-list">${st.data.games
          .slice(0, 40)
          .map((g) => `<li>${escapeHtml(formatKickoff(g.kickoff_at))} · ${escapeHtml(g.status)}</li>`)
          .join("")}</ul>`;
    } else if (sec === "sync") {
      body = `
        <button type="button" class="btn btn-primary" id="club-sync-all">Sync all due sources</button>
        <ul class="club-list">${st.data.syncRuns
          .map(
            (r) =>
              `<li>${escapeHtml(r.result)} · seen ${r.seen_count} / +${r.inserted_count} ~${r.updated_count} !${r.flagged_count}
              <br/><span class="muted">${escapeHtml(r.source?.source_url || r.club_schedule_source_id)} · ${escapeHtml(formatKickoff(r.started_at))}</span>
              ${r.error_detail ? `<p class="form-error">${escapeHtml(r.error_detail)}</p>` : ""}</li>`
          )
          .join("")}</ul>`;
    } else if (sec === "import") {
      body = `
        <p class="muted">CSV with header. Types: teams, affiliations, facilities, fields, games. See docs/club-visitation.md.</p>
        <form id="club-import-form" class="club-mini-form">
          <select name="kind">
            <option value="teams">teams (organization_name,team_name,age_group)</option>
            <option value="affiliations">affiliations (player_name,team_name)</option>
            <option value="facilities">facilities (name,city,street_address,latitude,longitude)</option>
            <option value="fields">fields (facility_name,label)</option>
            <option value="games">games (home,away,kickoff,facility,field,status)</option>
          </select>
          <textarea name="csv" rows="8" placeholder="Paste CSV…"></textarea>
          <button class="btn btn-primary" type="submit">Preview &amp; import</button>
        </form>
        <pre class="club-import-out" id="club-import-out"></pre>`;
    }

    return `<header class="club-data-head"><h2>Club data</h2><p class="muted">Teams, players, facilities, sources, and sync — one type at a time.</p></header><div class="club-data-nav">${nav}</div><div class="club-data-body">${body}</div>`;
  }

  function bindData() {
    $$("[data-data-sec]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        st.data.section = btn.getAttribute("data-data-sec");
        paint();
      })
    );
    $("#club-add-team")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const sb = api().getClient();
      const { error } = await sb.from("club_teams").insert({
        organization_name: fd.get("organization_name") || "",
        team_name: fd.get("team_name"),
        age_group: fd.get("age_group") || null,
      });
      if (error) st.error = error.message;
      else showToast("Team added");
      await loadDataSection();
      paint();
    });
    $("#club-add-aff")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const sb = api().getClient();
      const { error } = await sb.from("club_player_affiliations").insert({
        player_id: fd.get("player_id"),
        club_team_id: fd.get("club_team_id"),
        active: true,
      });
      if (error) st.error = error.message;
      else showToast("Affiliation saved");
      await loadDataSection();
      paint();
    });
    $("#club-add-comp")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const sb = api().getClient();
      const { error } = await sb.from("club_competitions").insert({
        name: fd.get("name"),
        competition_type: fd.get("competition_type"),
      });
      if (error) st.error = error.message;
      else showToast("Competition added");
      await loadDataSection();
      paint();
    });
    $("#club-add-source")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const sb = api().getClient();
      const teamId = fd.get("club_team_id");
      const compId = fd.get("club_competition_id");
      let tcId;
      const existing = await sb
        .from("club_team_competitions")
        .select("id")
        .eq("club_team_id", teamId)
        .eq("club_competition_id", compId)
        .maybeSingle();
      if (existing.data?.id) tcId = existing.data.id;
      else {
        const { data, error } = await sb
          .from("club_team_competitions")
          .insert({ club_team_id: teamId, club_competition_id: compId })
          .select()
          .single();
        if (error) {
          st.error = error.message;
          paint();
          return;
        }
        tcId = data.id;
      }
      const { error } = await sb.from("club_schedule_sources").insert({
        club_team_competition_id: tcId,
        source_url: fd.get("source_url"),
        provider: fd.get("provider"),
        enabled: true,
      });
      if (error) st.error = error.message;
      else showToast("Source added");
      await loadDataSection();
      paint();
    });
    $$("[data-sync-now]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-sync-now");
        showToast("Syncing…");
        const res = await api().clubSync({ source_id: id });
        showToast(res.ok ? "Sync finished" : res.error || "Sync failed");
        await loadDataSection();
        paint();
      })
    );
    $("#club-add-fac")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const sb = api().getClient();
      const lat = fd.get("latitude");
      const lng = fd.get("longitude");
      const { error } = await sb.from("club_facilities").insert({
        name: fd.get("name"),
        city: fd.get("city") || null,
        street_address: fd.get("street_address") || null,
        latitude: lat ? Number(lat) : null,
        longitude: lng ? Number(lng) : null,
        geocode_status: lat && lng ? "manual" : "unset",
      });
      if (error) st.error = error.message;
      else showToast("Facility added");
      await loadDataSection();
      paint();
    });
    $("#club-add-field")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const sb = api().getClient();
      const { error } = await sb.from("club_fields").insert({
        club_facility_id: fd.get("club_facility_id"),
        label: fd.get("label"),
      });
      if (error) st.error = error.message;
      else showToast("Field added");
      await loadDataSection();
      paint();
    });
    $("#club-add-game")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const sb = api().getClient();
      const local = fd.get("kickoff_at");
      let kickoff = null;
      if (local) {
        // Treat datetime-local as America/Denver civil time approximately via Date
        kickoff = new Date(local).toISOString();
      }
      const verified = fd.get("coach_verified");
      const { error } = await sb.from("club_games").insert({
        home_team_id: fd.get("home_team_id"),
        away_team_id: fd.get("away_team_id"),
        kickoff_at: kickoff,
        club_facility_id: fd.get("club_facility_id") || null,
        status: kickoff ? "scheduled" : "tbd",
        coach_verified_at: verified ? new Date().toISOString() : null,
        manual_overrides: verified ? { fields: ["kickoff_at", "status", "club_facility_id", "home_team_id", "away_team_id"] } : {},
      });
      if (error) st.error = error.message;
      else showToast("Game added");
      await loadDataSection();
      paint();
    });
    $("#club-sync-all")?.addEventListener("click", async () => {
      showToast("Syncing…");
      const res = await api().clubSync({ due_only: false });
      showToast(res.ok ? `Synced ${res.data?.source_count || 0} sources` : res.error || "Failed");
      await loadDataSection();
      paint();
    });
    $("#club-import-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const out = $("#club-import-out");
      try {
        const result = await runCsvImport(String(fd.get("kind")), String(fd.get("csv") || ""));
        if (out) out.textContent = JSON.stringify(result, null, 2);
        showToast(`Imported ${result.inserted || 0}`);
        await loadDataSection();
      } catch (err) {
        if (out) out.textContent = err.message;
      }
    });
  }

  function parseCsvSimple(text) {
    return String(text || "")
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const cells = [];
        let cur = "";
        let q = false;
        for (const ch of line) {
          if (q) {
            if (ch === '"') q = false;
            else cur += ch;
            continue;
          }
          if (ch === '"') {
            q = true;
            continue;
          }
          if (ch === ",") {
            cells.push(cur);
            cur = "";
            continue;
          }
          cur += ch;
        }
        cells.push(cur);
        return cells;
      });
  }

  async function runCsvImport(kind, csv) {
    const rows = parseCsvSimple(csv);
    if (rows.length < 2) throw new Error("Need header + rows");
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const data = rows.slice(1);
    const sb = api().getClient();
    let inserted = 0;
    const errors = [];
    if (kind === "teams") {
      for (const r of data) {
        const obj = Object.fromEntries(header.map((h, i) => [h, r[i]]));
        const { error } = await sb.from("club_teams").insert({
          organization_name: obj.organization_name || "",
          team_name: obj.team_name,
          age_group: obj.age_group || null,
        });
        if (error) errors.push(error.message);
        else inserted++;
      }
    } else if (kind === "affiliations") {
      for (const r of data) {
        const obj = Object.fromEntries(header.map((h, i) => [h, r[i]]));
        const player = st.players.find(
          (p) => p.name?.toLowerCase() === String(obj.player_name || "").toLowerCase()
        );
        const team = st.data.teams.find(
          (t) => t.team_name?.toLowerCase() === String(obj.team_name || "").toLowerCase()
        );
        if (!player || !team) {
          errors.push(`No match for ${obj.player_name} / ${obj.team_name}`);
          continue;
        }
        const { error } = await sb.from("club_player_affiliations").insert({
          player_id: player.id,
          club_team_id: team.id,
          active: true,
        });
        if (error) errors.push(error.message);
        else inserted++;
      }
    } else if (kind === "facilities") {
      for (const r of data) {
        const obj = Object.fromEntries(header.map((h, i) => [h, r[i]]));
        const { error } = await sb.from("club_facilities").insert({
          name: obj.name,
          city: obj.city || null,
          street_address: obj.street_address || null,
          latitude: obj.latitude ? Number(obj.latitude) : null,
          longitude: obj.longitude ? Number(obj.longitude) : null,
          geocode_status: obj.latitude ? "manual" : "unset",
        });
        if (error) errors.push(error.message);
        else inserted++;
      }
    } else if (kind === "fields") {
      for (const r of data) {
        const obj = Object.fromEntries(header.map((h, i) => [h, r[i]]));
        const fac = st.data.facilities.find(
          (f) => f.name?.toLowerCase() === String(obj.facility_name || "").toLowerCase()
        );
        if (!fac) {
          errors.push(`Facility missing: ${obj.facility_name}`);
          continue;
        }
        const { error } = await sb.from("club_fields").insert({
          club_facility_id: fac.id,
          label: obj.label,
        });
        if (error) errors.push(error.message);
        else inserted++;
      }
    } else if (kind === "games") {
      for (const r of data) {
        const obj = Object.fromEntries(header.map((h, i) => [h, r[i]]));
        const home = st.data.teams.find((t) => t.team_name?.toLowerCase() === String(obj.home || "").toLowerCase());
        const away = st.data.teams.find((t) => t.team_name?.toLowerCase() === String(obj.away || "").toLowerCase());
        const fac = obj.facility
          ? st.data.facilities.find((f) => f.name?.toLowerCase() === String(obj.facility).toLowerCase())
          : null;
        let fieldId = null;
        if (fac && obj.field) {
          const field = st.data.fields.find(
            (f) => f.club_facility_id === fac.id && f.label?.toLowerCase() === String(obj.field).toLowerCase()
          );
          fieldId = field?.id || null;
        }
        const kick = obj.kickoff ? new Date(obj.kickoff) : null;
        const { error } = await sb.from("club_games").insert({
          home_team_id: home?.id || null,
          away_team_id: away?.id || null,
          raw_home_label: home ? null : obj.home,
          raw_away_label: away ? null : obj.away,
          kickoff_at: kick && !Number.isNaN(kick.getTime()) ? kick.toISOString() : null,
          club_facility_id: fac?.id || null,
          club_field_id: fieldId,
          status: obj.status || (kick ? "scheduled" : "tbd"),
        });
        if (error) errors.push(error.message);
        else inserted++;
      }
    } else {
      throw new Error("Unknown import kind");
    }
    return { inserted, errors };
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  function paint() {
    const root = rootEl();
    if (!root) return;
    let inner = "";
    if (st.tab === "agenda") inner = agendaMarkup();
    else if (st.tab === "itinerary") inner = itineraryMarkup();
    else inner = dataMarkup();
    root.innerHTML = shell(inner);
    if (st.tab === "agenda") bindAgenda();
    else if (st.tab === "itinerary") bindItinerary();
    else bindData();
  }

  async function refreshAgenda() {
    st.loading = true;
    st.error = "";
    paint();
    try {
      if (!st.players.length) await loadPlayers();
      await loadAgenda();
    } catch (err) {
      st.error = err.message || "Could not load agenda";
    }
    st.loading = false;
    paint();
  }

  async function render() {
    st.tab = parseHashTab();
    if (!(await requireSessionUi())) return;
    st.loading = true;
    st.error = "";
    paint();
    try {
      if (!api().isPlaceholderConfig?.()) {
        await api().clubRegisterSyncWorker().catch(() => {});
      }
      if (!st.players.length) await loadPlayers();
      if (st.tab === "agenda") await loadAgenda();
      else if (st.tab === "itinerary") {
        await loadItineraryList();
        if (!st.itinerary.draft) {
          st.itinerary.draft = {
            name: `Visits ${todayLocal()}`,
            target_date: todayLocal(),
            default_visit_minutes: DEFAULT_VISIT,
          };
        }
      } else await loadDataSection();
    } catch (err) {
      st.error = err.message || "Load failed";
    }
    st.loading = false;
    paint();
  }

  global.ClubVisitation = {
    render,
    onLeave() {},
  };
})(window);
