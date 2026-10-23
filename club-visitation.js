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
  /** Same-day games within this kickoff gap chain from the prior venue; larger gaps reset from home. */
  const CHAIN_GAP_MS = 3 * 60 * 60 * 1000;
  const HOME_STORAGE_KEY = "club-home-location";
  const LOADING_LINES = [
    "Don't you watch enough soccer",
    "Another Saturday. Another patch of turf.",
    "The games will still be there",
    "Folding chairs were invented for this",
    "Someone has to know which field",
    "You could be watching film instead",
  ];

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
      addPrompt: null,
    },
    itinerary: {
      list: [],
      currentId: "",
      draft: null,
      engaged: false,
      pickerOpen: false,
      stops: [],
      legs: [],
      startLeg: null,
      orderManual: false,
      needsStartPrompt: false,
      scrollStart: false,
      warnings: [],
      gemini: { loading: false, error: "", messages: [], draft: "" },
      busy: false,
      startBusy: false,
      matchPrompt: [],
      dismissedMatchIds: [],
      scrollMatch: false,
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
      geocodeBusyId: "",
    },
    players: [],
    shotPlayers: [],
    links: [],
    settings: null,
  };

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Never consume ** here — that ate closing bold next to an id ("**Calvin** `uuid`" → "**Calvin").
  const GAME_ID_RE =
    /(?:\s*\|\s*)?(?:\bgame(?:\s+id)?\s*:?\s*)?`([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`|(?:\s*\|\s*)?(?:\bgame(?:\s+id)?\s*:?\s+)?\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;

  function stageGameAdds(text) {
    return String(text || "")
      .replace(GAME_ID_RE, (...args) => `\uE000${args[1] || args[2]}\uE001`)
      // Model often wraps the id: Zander (`uuid`) → leave the Add marker, drop the wrappers.
      .replace(/[([{]\s*\uE000([0-9a-f-]+)\uE001\s*[)\]}]/gi, " \uE000$1\uE001")
      .replace(/\(\s*(?:game\s*)?id\s*:\s*\)\s*:?/gi, "")
      .replace(/\*{0,2}\s*(?:game\s*)?id\s*:\s*\*{0,2}/gi, "")
      .replace(/\(\s*\)/g, "")
      .replace(/\[\s*\]/g, "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/ \n/g, "\n");
  }

  function gameAddButton(id, addedIds) {
    const onItinerary = !!addedIds && typeof addedIds.has === "function" && addedIds.has(id);
    if (onItinerary) {
      return `<button type="button" class="btn btn-ghost club-md-add" disabled>Added</button>`;
    }
    return `<button type="button" class="btn btn-secondary club-md-add" data-add-itin="${escapeHtml(id)}">Add</button>`;
  }

  function clubMarkdownInline(escaped, addedIds) {
    return escaped
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/\uE000([0-9a-f-]+)\uE001/gi, (_, id) => gameAddButton(id, addedIds));
  }

  /** Render the model's markdown. HTML is escaped first. Game ids become Add buttons. */
  function renderClubMarkdown(text, addedIds) {
    const lines = escapeHtml(stageGameAdds(text)).replace(/\r\n/g, "\n").split("\n");
    const blocks = [];
    let list = [];
    const flushList = () => {
      if (!list.length) return;
      blocks.push(`<ul>${list.map((item) => `<li>${clubMarkdownInline(item, addedIds)}</li>`).join("")}</ul>`);
      list = [];
    };
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        flushList();
        continue;
      }
      if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
        flushList();
        blocks.push("<hr>");
        continue;
      }
      const heading = trimmed.match(/^#{1,3}\s+(.+)$/);
      if (heading) {
        flushList();
        blocks.push(`<h3>${clubMarkdownInline(heading[1], addedIds)}</h3>`);
        continue;
      }
      const bullet = trimmed.match(/^[*-]\s+(.+)$/);
      if (bullet) {
        list.push(bullet[1]);
        continue;
      }
      flushList();
      blocks.push(`<p>${clubMarkdownInline(trimmed, addedIds)}</p>`);
    }
    flushList();
    return blocks.join("");
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

  function mapsLink(lat, lng, origin) {
    if (lat == null || lng == null) return null;
    const dest = `${lat},${lng}`;
    if (origin && origin.lat != null && origin.lng != null) {
      return `https://www.google.com/maps/dir/?api=1&origin=${origin.lat},${origin.lng}&destination=${dest}&travelmode=driving`;
    }
    return `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`;
  }

  function facilityQuery(f) {
    return [f.street_address, f.city, f.state, f.postal_code, f.name].filter(Boolean).join(", ");
  }

  function pinStatusLabel(f) {
    if (f.latitude != null && f.longitude != null) {
      if (f.geocode_status === "manual") return "Pinned";
      if (f.geocode_status === "ok") return "Located";
      return "Pinned";
    }
    if (f.geocode_status === "failed") return "Locate failed";
    if (f.street_address || f.city) return "Needs pin";
    return "No address";
  }

  function readStoredHome() {
    try {
      const raw = global.localStorage?.getItem(HOME_STORAGE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object") return null;
      const label = String(obj.label || "").trim();
      if (!label) return null;
      return {
        label,
        lat: obj.lat != null ? Number(obj.lat) : null,
        lng: obj.lng != null ? Number(obj.lng) : null,
      };
    } catch (_) {
      return null;
    }
  }

  function writeStoredHome(label, lat, lng) {
    const trimmed = String(label || "").trim();
    if (!trimmed || lat == null || lng == null) return;
    try {
      global.localStorage?.setItem(
        HOME_STORAGE_KEY,
        JSON.stringify({ label: trimmed, lat, lng })
      );
    } catch (_) {
      /* ignore quota */
    }
  }

  function emptyItineraryDraft(overrides = {}) {
    const home = readStoredHome();
    return {
      name: `Visits ${todayLocal()}`,
      target_date: todayLocal(),
      default_visit_minutes: DEFAULT_VISIT,
      start_location_label: home?.label || "",
      start_latitude: home?.lat ?? null,
      start_longitude: home?.lng ?? null,
      _startGeocodeFor: home?.lat != null ? home.label : "",
      _startResolveNote: home?.lat != null ? "Saved home location" : "",
      notes: "",
      ...overrides,
    };
  }

  /** Same Denver calendar day and kickoffs ≤ 3h apart → drive from the prior game. */
  function shouldDriveFromPrior(prev, next, gapMs = CHAIN_GAP_MS) {
    if (!prev || !next) return false;
    const dayA = localDateKey(prev.kickoff_at);
    const dayB = localDateKey(next.kickoff_at);
    if (!dayA || !dayB || dayA === "tbd" || dayB === "tbd" || dayA !== dayB) return false;
    const ta = prev.kickoff_at ? new Date(prev.kickoff_at).getTime() : NaN;
    const tb = next.kickoff_at ? new Date(next.kickoff_at).getTime() : NaN;
    if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
    return Math.abs(tb - ta) <= gapMs;
  }

  function startPoint(draft) {
    if (draft?.start_latitude == null || draft?.start_longitude == null) return null;
    return {
      lat: draft.start_latitude,
      lng: draft.start_longitude,
      label: String(draft.start_location_label || "").trim() || "Home",
      facility_id: null,
    };
  }

  function legsNeedHomeOrigin(stops) {
    if (!(stops || []).length) return false;
    for (let i = 0; i < stops.length - 1; i++) {
      if (!shouldDriveFromPrior(stops[i], stops[i + 1])) return true;
    }
    return true; // first stop always uses home/start
  }

  async function geocodePlaceQuery(query) {
    const res = await api().clubVisitation({ mode: "geocode", query });
    if (!res.ok) {
      return {
        ok: false,
        error: res.error || "Geocode failed",
        provider_configured: res.data?.provider_configured,
        results: [],
      };
    }
    return {
      ok: !!res.data?.ok,
      error: res.data?.error || "",
      results: res.data?.results || [],
      ambiguous: !!res.data?.ambiguous,
      provider_configured: !!res.data?.provider_configured,
    };
  }

  async function travelLegBetween(from, to) {
    if (from?.facility_id && to?.facility_id && from.facility_id === to.facility_id) {
      return { mode: "walk", minutes: WALK_MIN, unavailable: false, note: "Same facility (approx walk)" };
    }
    if (from?.lat == null || from?.lng == null || to?.lat == null || to?.lng == null) {
      return { mode: "drive", minutes: null, unavailable: true, note: "Missing map pin" };
    }
    const res = await api().clubVisitation({
      mode: "travel",
      arguments: {
        origin: { lat: from.lat, lng: from.lng, facility_id: from.facility_id },
        destinations: [{ lat: to.lat, lng: to.lng, facility_id: to.facility_id }],
      },
    });
    const r = res.data?.result?.results?.[0];
    const configured = res.data?.provider_configured ?? res.data?.result?.provider_configured;
    if (!res.ok || !r || r.unavailable || r.minutes == null) {
      const note =
        configured === false
          ? "Routing not configured"
          : r?.note || "Travel time unavailable";
      return { mode: "drive", minutes: null, unavailable: true, note };
    }
    return { mode: r.mode || "drive", minutes: r.minutes, unavailable: false, note: r.note || "Estimated drive" };
  }

  function legMarkup(leg, mapHref) {
    if (!leg) return "";
    const fromBit = leg.from_label ? `${leg.from_label} · ` : "";
    if (leg.unavailable || leg.minutes == null) {
      return `<p class="club-leg is-warn">→ ${escapeHtml(fromBit)}${escapeHtml(leg.note || "Travel time unavailable")}${
        mapHref ? ` · <a target="_blank" rel="noopener" href="${escapeHtml(mapHref)}">Directions</a>` : ""
      }</p>`;
    }
    const label = leg.mode === "walk" ? "Walk/transition" : "Drive";
    return `<p class="club-leg">→ ${escapeHtml(fromBit)}${label} ~${leg.minutes} min${
      mapHref ? ` · <a target="_blank" rel="noopener" href="${escapeHtml(mapHref)}">Directions</a>` : ""
    }</p>`;
  }

  async function resolveStartCoords({ force = false } = {}) {
    const draft = st.itinerary.draft;
    if (!draft) return;
    const label = String(draft.start_location_label || "").trim();
    if (!label) {
      draft.start_latitude = null;
      draft.start_longitude = null;
      draft._startGeocodeFor = "";
      draft._startResolveNote = "";
      return;
    }
    if (
      !force &&
      draft.start_latitude != null &&
      draft.start_longitude != null &&
      draft._startGeocodeFor === label
    ) {
      return;
    }
    st.itinerary.startBusy = true;
    const geo = await geocodePlaceQuery(label);
    st.itinerary.startBusy = false;
    if (!geo.ok || !geo.results.length) {
      draft.start_latitude = null;
      draft.start_longitude = null;
      draft._startGeocodeFor = label;
      draft._startResolveNote =
        geo.error || "Could not locate start";
      return;
    }
    const hit = geo.results[0];
    draft.start_latitude = hit.lat;
    draft.start_longitude = hit.lng;
    draft._startGeocodeFor = label;
    draft._startResolveNote = geo.ambiguous
      ? `Using ${hit.label} (pick a more specific start if wrong)`
      : hit.label || "Located";
    writeStoredHome(label, hit.lat, hit.lng);
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

  let loadTimer = null;
  let loadIndex = 0;

  function loadingMarkup() {
    return `
      <p class="club-loading" role="status">
        <span class="club-spin" aria-hidden="true"></span>
        <span id="club-loading-line">${escapeHtml(LOADING_LINES[0])}</span>
      </p>`;
  }

  function stopLoadingLines() {
    if (loadTimer) {
      clearInterval(loadTimer);
      loadTimer = null;
    }
  }

  function startLoadingLines() {
    stopLoadingLines();
    loadIndex = 0;
    const tick = () => {
      const el = $("#club-loading-line");
      if (!el) return;
      el.textContent = LOADING_LINES[loadIndex % LOADING_LINES.length];
      loadIndex += 1;
    };
    tick();
    loadTimer = setInterval(tick, 2200);
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
        ${st.loading ? loadingMarkup() : ""}
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
    const { data, error } = await sb.from("club_players").select("id, name, short_name").order("name");
    if (error) throw error;
    st.players = data || [];
  }

  function normName(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  }

  function nameTokens(value) {
    return normName(value).split(" ").filter(Boolean);
  }

  function namesCouldMatch(club, shot) {
    const clubFull = normName(club.full_name || club.name);
    const shotFull = normName(shot.name);
    if (clubFull && shotFull && clubFull === shotFull) return true;
    const ct = nameTokens(club.full_name || club.name);
    const stt = nameTokens(shot.name);
    if (ct.length >= 2 && stt.length >= 2 && ct[0] === stt[0] && ct[ct.length - 1] === stt[stt.length - 1]) return true;
    const clubShort = normName(club.short_name);
    const shotShort = normName(shot.short_name);
    if (clubShort && shotShort && clubShort === shotShort && ct.length && stt.length && ct[ct.length - 1] === stt[stt.length - 1]) {
      return true;
    }
    return false;
  }

  function shotTrackerMatches(clubPlayers, shotPlayers, links, dismissedIds) {
    const linkedClub = new Set((links || []).map((l) => l.club_player_id));
    const linkedShot = new Set((links || []).map((l) => l.player_id));
    const dismissed = new Set(dismissedIds || []);
    const out = [];
    for (const club of clubPlayers || []) {
      const clubId = club.player_id || club.id;
      if (!clubId || club.shot_player_id || linkedClub.has(clubId) || dismissed.has(clubId)) continue;
      const candidates = (shotPlayers || []).filter((s) => s.id && !linkedShot.has(s.id) && namesCouldMatch(club, s));
      if (!candidates.length) continue;
      out.push({
        clubPlayerId: clubId,
        clubName: club.full_name || club.name || "Club player",
        candidates: candidates.map((s) => ({ id: s.id, name: s.name || s.short_name || "Player" })),
      });
    }
    return out;
  }

  async function collectShotMatches(clubPlayers) {
    if (!clubPlayers?.length || api().isPlaceholderConfig?.()) return [];
    const sb = api().getClient();
    if (!st.shotPlayers.length) {
      const { data, error } = await sb.from("players").select("id, name, short_name").order("name");
      if (error) return [];
      st.shotPlayers = data || [];
    }
    const { data: links, error: linkError } = await sb.from("club_player_links").select("player_id, club_player_id");
    if (linkError) return [];
    return shotTrackerMatches(clubPlayers, st.shotPlayers, links || [], st.itinerary.dismissedMatchIds);
  }

  function queueShotMatches(suggestions) {
    if (!suggestions?.length) return;
    const existing = new Set((st.itinerary.matchPrompt || []).map((row) => row.clubPlayerId));
    const extra = suggestions.filter((row) => !existing.has(row.clubPlayerId));
    if (!extra.length) return;
    st.itinerary.matchPrompt = [...(st.itinerary.matchPrompt || []), ...extra];
    st.itinerary.scrollMatch = true;
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
    // The list is a direct read so it stays on club_players even when the
    // deployed Ask Gemini function is a version behind.
    await loadAgendaDirect();
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
        .select("club_team_id, club_player_id, club_players (id, name, short_name)")
        .in("club_team_id", teamIds)
        .eq("active", true);
      aff = data || [];
    }
    const clubIds = [...new Set(aff.map((a) => a.club_player_id).filter(Boolean))];
    const linkByClub = new Map();
    if (clubIds.length) {
      const { data: links } = await sb
        .from("club_player_links")
        .select("club_player_id, player_id, players (name)")
        .in("club_player_id", clubIds);
      for (const link of links || []) linkByClub.set(link.club_player_id, link);
    }
    const byTeam = new Map();
    for (const a of aff) {
      if (!byTeam.has(a.club_team_id)) byTeam.set(a.club_team_id, []);
      const person = a.club_players || {};
      const link = linkByClub.get(a.club_player_id);
      byTeam.get(a.club_team_id).push({
        player_id: a.club_player_id,
        name: person.short_name || person.name,
        full_name: person.name,
        short_name: person.short_name || "",
        shot_player_id: link?.player_id || null,
        shot_player_name: link?.players?.name || null,
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
    st.itinerary.draft = {
      ...itin,
      _startGeocodeFor:
        itin.start_latitude != null && itin.start_longitude != null
          ? String(itin.start_location_label || "").trim()
          : "",
      _startResolveNote:
        itin.start_latitude != null
          ? "Start located"
          : itin.start_location_label
            ? ""
            : "",
    };
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
          .select("club_team_id, club_players (short_name, name)")
          .in("club_team_id", teamIds)
          .eq("active", true);
        players = (aff || []).map((a) => a.club_players?.short_name || a.club_players?.name).filter(Boolean);
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

  async function driveFromHomeOrMissing(home, to, why) {
    const homeLabel = home?.label || "home";
    if (!home) {
      return {
        mode: "drive",
        minutes: null,
        unavailable: true,
        from_home: true,
        from_label: "From home",
        note: "Set a start / home location",
        needs_start: true,
        why,
      };
    }
    const leg = await travelLegBetween(home, to);
    return {
      ...leg,
      from_home: true,
      from_label: `From ${homeLabel}`,
      why,
      note:
        leg.unavailable
          ? leg.note || "Travel time unavailable from home"
          : why === "first"
            ? "Estimated drive from home"
            : "Gap over 3h (or new day) — estimated from home",
    };
  }

  async function refreshLegs() {
    await resolveStartCoords();
    const stops = st.itinerary.stops;
    const draft = st.itinerary.draft || {};
    const home = startPoint(draft);
    const needHome = legsNeedHomeOrigin(stops);
    const missingHome = needHome && !home;
    st.itinerary.needsStartPrompt = missingHome;
    if (missingHome && !st.itinerary._startPrompted) {
      st.itinerary._startPrompted = true;
      st.itinerary.scrollStart = true;
    }
    if (home) st.itinerary._startPrompted = false;

    let startLeg = null;
    if (stops.length) {
      startLeg = await driveFromHomeOrMissing(home, stops[0], "first");
      if (!home && String(draft.start_location_label || "").trim()) {
        startLeg = {
          ...startLeg,
          note: draft._startResolveNote || "Could not locate start",
        };
      }
    }
    st.itinerary.startLeg = startLeg;

    const legs = [];
    for (let i = 0; i < stops.length - 1; i++) {
      const prev = stops[i];
      const next = stops[i + 1];
      if (shouldDriveFromPrior(prev, next)) {
        const leg = await travelLegBetween(prev, next);
        legs.push({
          ...leg,
          from_home: false,
          from_label: "From prior game",
          why: "chain",
          note: leg.unavailable
            ? leg.note || "Travel time unavailable"
            : leg.mode === "walk"
              ? leg.note
              : "Same day · within 3h — from prior game",
        });
      } else {
        legs.push(await driveFromHomeOrMissing(home, next, "gap"));
      }
    }
    st.itinerary.legs = legs;

    const feasWarnings = [];
    let cursor = null;
    stops.forEach((s, i) => {
      const kick = s.kickoff_at ? new Date(s.kickoff_at).getTime() : null;
      let arrive = kick != null ? kick - 5 * 60000 : cursor;
      const inbound = i === 0 ? startLeg : legs[i - 1];
      if (inbound?.needs_start || (inbound?.from_home && inbound?.unavailable && !home)) {
        feasWarnings.push({
          type: "missing_start",
          message:
            i === 0
              ? "Add a start / home location for drive time to stop 1"
              : `Add a start / home location for the gap into stop ${i + 1}`,
        });
      } else if (i === 0 && startLeg?.unavailable) {
        feasWarnings.push({ type: "missing_route", message: "Travel unknown from home into stop 1" });
      } else if (i > 0 && inbound && !inbound.from_home) {
        const prev = stops[i - 1];
        const prevDep = prev.planned_departure_at
          ? new Date(prev.planned_departure_at).getTime()
          : cursor;
        if (inbound.unavailable) {
          feasWarnings.push({ type: "missing_route", message: `Travel unknown into stop ${i + 1}` });
        } else if (prevDep != null && inbound.minutes != null) {
          const earliest = prevDep + inbound.minutes * 60000;
          if (arrive == null || earliest > arrive) arrive = earliest;
          if (kick != null && earliest > kick + 15 * 60000) {
            feasWarnings.push({ type: "impossible", message: `Impossible timing into stop ${i + 1}` });
          } else if (kick != null && earliest > kick - 5 * 60000) {
            feasWarnings.push({ type: "tight", message: `Tight timing into stop ${i + 1}` });
          }
        }
      } else if (i > 0 && inbound?.from_home && inbound.unavailable) {
        feasWarnings.push({ type: "missing_route", message: `Travel unknown from home into stop ${i + 1}` });
      }
      // Home-origin legs reset the day: arrival targets kickoff − 5, not prior departure.
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
    const [teams, aff, links, comps, sources, fac, fields, games, runs] = await Promise.all([
      sb.from("club_teams").select("*").order("team_name"),
      sb.from("club_player_affiliations").select("*, club_players (id, name, short_name), team:club_teams (team_name)").eq("active", true),
      sb.from("club_player_links").select("id, player_id, club_player_id, players (name, short_name), club_players (name, short_name)"),
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
    st.links = links.data || [];
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
        <label class="club-check"><input type="checkbox" id="club-filter-both" ${st.agenda.onlyBoth ? "checked" : ""} /> Players on both teams</label>
        <label>Search<input type="search" id="club-filter-text" value="${escapeHtml(st.agenda.filterText)}" placeholder="Team, player, venue" /></label>
        <button type="submit" class="btn btn-primary" id="club-agenda-refresh">Apply</button>
      </form>`;
  }

  function sideLabel(side) {
    const text = String(side || "").trim();
    if (!text) return "";
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function rosterNames(players) {
    return [...players]
      .sort((a, b) =>
        String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" })
      )
      .map((p) =>
        p.shot_player_id
          ? `<span class="is-roster" title="Shot tracker roster">${escapeHtml(p.name)}</span>`
          : escapeHtml(p.name)
      )
      .join(", ");
  }

  function playerRosterMarkup(players) {
    const list = players || [];
    if (!list.length) return `<p class="club-players is-empty">No club players</p>`;

    const groups = new Map();
    for (const player of list) {
      const side = String(player.side || "").trim().toLowerCase();
      if (!groups.has(side)) groups.set(side, []);
      groups.get(side).push(player);
    }

    if (groups.size <= 1) {
      const side = sideLabel([...groups.keys()][0]);
      const caption = side
        ? list.length > 1
          ? `${escapeHtml(side)} · ${list.length}`
          : escapeHtml(side)
        : list.length > 1
          ? `${list.length} players`
          : "";
      return `
        <div class="club-players">
          <p class="club-player-names">${rosterNames(list)}</p>
          ${caption ? `<p class="club-player-aside">${caption}</p>` : ""}
        </div>`;
    }

    const order = ["home", "away", ""];
    const rows = [...groups.entries()]
      .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
      .map(
        ([side, group]) => `
          <div class="club-side-group">
            ${side ? `<p class="club-side-label">${escapeHtml(sideLabel(side))}</p>` : ""}
            <p class="club-player-names">${rosterNames(group)}</p>
          </div>`
      )
      .join("");
    return `<div class="club-players">${rows}</div>`;
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
              ? `<span class="club-badge club-badge-both">Both teams</span>`
              : "";
            const changed = g.recently_changed ? `<span class="club-badge club-badge-changed">Updated</span>` : "";
            const playersBlock = playerRosterMarkup(g.brighton_players);
            const map = mapsLink(g.lat, g.lng, g.facility);
            const venue = [g.facility, g.field].filter(Boolean).join(" · ") || "Venue TBD";
            const onThis = picked.has(g.game_id) && (mode === "pick" || isEngaged());
            const addControl =
              mode === "pick"
                ? onThis
                  ? `<button type="button" class="btn btn-ghost" disabled>Added</button>`
                  : `<button type="button" class="btn btn-secondary" data-add-itin="${escapeHtml(g.game_id)}">Add</button>`
                : onThis
                  ? `<button type="button" class="btn btn-ghost club-add-btn" disabled aria-label="Already on this itinerary">Added</button>`
                  : `<button type="button" class="btn btn-secondary club-add-btn" data-agenda-add="${escapeHtml(g.game_id)}" aria-label="${isEngaged() ? `Add to ${escapeHtml(workingName())}` : "Add to an itinerary"}">+</button>`;
            return `
              <article class="club-game-card${onThis ? " is-added" : ""}" data-game-id="${escapeHtml(g.game_id)}">
                <div class="club-game-card-top">
                  <time>${escapeHtml(formatKickoff(g.kickoff_at))}</time>
                  <span class="club-status">${escapeHtml(g.status || "scheduled")}</span>
                </div>
                ${playersBlock}
                <h3>${escapeHtml(g.home_team)} <span>vs</span> ${escapeHtml(g.away_team)}</h3>
                <p class="club-venue">${escapeHtml(venue)}${g.city ? ` · ${escapeHtml(g.city)}` : ""}${g.competition ? ` · ${escapeHtml(g.competition)}` : ""}</p>
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

    if (!dayBlocks && st.loading) return "";
    return dayBlocks || `<p class="empty-state">No upcoming club games in this range.</p>`;
  }

  function isEngaged() {
    return !!st.itinerary.engaged && !!st.itinerary.draft;
  }

  function workingName() {
    return String(st.itinerary.draft?.name || "").trim() || "this itinerary";
  }

  function agendaWorkingMarkup() {
    if (!isEngaged()) return "";
    return `
      <div class="club-working">
        <p>Adding to <strong>${escapeHtml(workingName())}</strong></p>
        <button type="button" class="btn btn-ghost" id="club-close-itin">Close</button>
      </div>`;
  }

  function agendaAddChoiceMarkup() {
    const prompt = st.agenda.addPrompt;
    if (!prompt || isEngaged()) return "";
    const game = (st.agenda.games || []).find((g) => g.game_id === prompt.gameId);
    const title = game ? `${game.home_team || "TBD"} vs ${game.away_team || "TBD"}` : "This game";
    const options = (st.itinerary.list || [])
      .map(
        (i) =>
          `<option value="${escapeHtml(i.id)}">${escapeHtml(i.name)}${i.target_date ? ` (${i.target_date})` : ""}</option>`
      )
      .join("");
    return `
      <section class="club-add-choice" id="club-add-choice">
        <h2>Where should this game go?</h2>
        <p>${escapeHtml(title)}</p>
        <button type="button" class="btn btn-primary" id="club-add-new">New itinerary</button>
        ${
          options
            ? `<label>Existing itinerary
                <select id="club-add-existing">${options}</select>
              </label>
              <button type="button" class="btn btn-secondary" id="club-add-existing-go">Add to this one</button>`
            : `<p class="muted">No saved itineraries yet.</p>`
        }
        <button type="button" class="btn btn-ghost" id="club-add-cancel">Cancel</button>
      </section>`;
  }

  function agendaMarkup() {
    return `${agendaWorkingMarkup()}${matchPromptMarkup()}${agendaAddChoiceMarkup()}${agendaFiltersMarkup()}${agendaListMarkup("browse")}`;
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
    bindMatchPrompt();
    $("#club-close-itin")?.addEventListener("click", () => {
      st.itinerary.engaged = false;
      st.agenda.addPrompt = null;
      paint();
    });
    $("#club-add-cancel")?.addEventListener("click", () => {
      st.agenda.addPrompt = null;
      paint();
    });
    $("#club-add-new")?.addEventListener("click", async () => {
      const gameId = st.agenda.addPrompt?.gameId;
      if (!gameId) return;
      st.itinerary.currentId = "";
      st.itinerary.draft = emptyItineraryDraft({
        target_date: st.agenda.dateFrom || todayLocal(),
      });
      st.itinerary.stops = [];
      st.itinerary.legs = [];
      st.itinerary.startLeg = null;
      st.itinerary.orderManual = false;
      st.itinerary.warnings = [];
      st.itinerary.matchPrompt = [];
      st.itinerary.engaged = true;
      st.agenda.addPrompt = null;
      await addStop(gameId);
      showToast(`Added to ${workingName()}`);
      paint();
    });
    $("#club-add-existing-go")?.addEventListener("click", async () => {
      const gameId = st.agenda.addPrompt?.gameId;
      const id = $("#club-add-existing")?.value;
      if (!gameId || !id) return;
      st.loading = true;
      paint();
      try {
        await loadItinerary(id);
        st.itinerary.engaged = true;
        st.agenda.addPrompt = null;
        const added = await addStop(gameId);
        showToast(added ? `Added to ${workingName()}` : `Already on ${workingName()}`);
      } catch (err) {
        st.error = err.message || "Could not open that itinerary";
      }
      st.loading = false;
      paint();
    });
    $$("[data-agenda-add]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-agenda-add");
        if (isEngaged()) {
          btn.disabled = true;
          const added = await addStop(id);
          showToast(added ? `Added to ${workingName()}` : `Already on ${workingName()}`);
          paint();
          return;
        }
        if (!st.itinerary.list.length) {
          try {
            await loadItineraryList();
          } catch (_) {
            st.itinerary.list = [];
          }
        }
        st.agenda.addPrompt = { gameId: id };
        paint();
        $("#club-add-choice")?.scrollIntoView({ block: "start" });
      });
    });
  }

  async function addGameToDraft(gameId) {
    if (!st.itinerary.draft) {
      st.itinerary.draft = emptyItineraryDraft({
        target_date: st.agenda.dateFrom || todayLocal(),
      });
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
    // Default order is kickoff ascending; ↑↓ can override until the next add.
    st.itinerary.stops = sortStopsByKickoff(st.itinerary.stops);
    st.itinerary.orderManual = false;
    await refreshLegs();
  }

  function sortStopsByKickoff(stops) {
    return [...(stops || [])]
      .sort((a, b) => {
        const ta = a.kickoff_at ? new Date(a.kickoff_at).getTime() : Number.POSITIVE_INFINITY;
        const tb = b.kickoff_at ? new Date(b.kickoff_at).getTime() : Number.POSITIVE_INFINITY;
        if (ta !== tb) return ta - tb;
        return String(a.game_id || "").localeCompare(String(b.game_id || ""));
      })
      .map((s, i) => ({ ...s, stop_order: i + 1 }));
  }

  async function addStop(gameId) {
    const before = (st.itinerary.stops || []).some((s) => s.game_id === gameId);
    await addGameToDraft(gameId);
    if (before) return false;
    const g = (st.agenda.games || []).find((x) => x.game_id === gameId);
    queueShotMatches(await collectShotMatches(g?.brighton_players || []));
    return true;
  }

  // ---------------------------------------------------------------------------
  // Itinerary UI
  // ---------------------------------------------------------------------------

  function readItineraryForm() {
    if (!st.itinerary.draft) {
      st.itinerary.draft = emptyItineraryDraft();
    }
    const name = $("#club-itin-name");
    if (!name) return;
    st.itinerary.draft.name = name.value;
    st.itinerary.draft.target_date = $("#club-itin-date")?.value || "";
    const startVal = $("#club-itin-start")?.value || "";
    if (startVal !== (st.itinerary.draft.start_location_label || "")) {
      st.itinerary.draft.start_latitude = null;
      st.itinerary.draft.start_longitude = null;
      st.itinerary.draft._startGeocodeFor = "";
      st.itinerary.draft._startResolveNote = "";
    }
    st.itinerary.draft.start_location_label = startVal;
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

  function matchPromptMarkup() {
    const rows = st.itinerary.matchPrompt || [];
    if (!rows.length) return "";
    const items = rows
      .map((row) => {
        const one = row.candidates.length === 1 ? row.candidates[0] : null;
        const options = row.candidates
          .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`)
          .join("");
        const lead = one
          ? `${escapeHtml(row.clubName)} looks like ${escapeHtml(one.name)}.`
          : `${escapeHtml(row.clubName)} might match one of these Shot Tracker players.`;
        return `
          <li class="club-match-row">
            <p>${lead}</p>
            ${
              one
                ? ""
                : `<label>Shot Tracker player
                    <select data-match-shot="${escapeHtml(row.clubPlayerId)}">
                      <option value="">Choose</option>
                      ${options}
                    </select>
                  </label>`
            }
            <div class="club-match-actions">
              <button type="button" class="btn btn-primary" data-match-yes="${escapeHtml(row.clubPlayerId)}">Match</button>
              <button type="button" class="btn btn-ghost" data-match-no="${escapeHtml(row.clubPlayerId)}">Not the same</button>
            </div>
          </li>`;
      })
      .join("");
    return `
      <section class="club-match" id="club-match" aria-labelledby="club-match-title">
        <h2 id="club-match-title">Want to match this to a player from Shot Tracker?</h2>
        <ul class="club-match-list">${items}</ul>
        ${rows.length > 1 ? `<button type="button" class="btn btn-ghost" id="club-match-skip">Not now</button>` : ""}
      </section>`;
  }

  function itineraryMarkup() {
    const draft = st.itinerary.draft;
    const listOpts = st.itinerary.list
      .map(
        (i) =>
          `<option value="${escapeHtml(i.id)}" ${st.itinerary.currentId === i.id ? "selected" : ""}>${escapeHtml(i.name)}${i.target_date ? ` (${i.target_date})` : ""}</option>`
      )
      .join("");
    const draftStart = {
      lat: draft?.start_latitude,
      lng: draft?.start_longitude,
      label: draft?.start_location_label,
    };
    const startLeg = st.itinerary.startLeg;
    const startMap =
      startLeg && st.itinerary.stops[0]
        ? mapsLink(st.itinerary.stops[0].lat, st.itinerary.stops[0].lng, draftStart)
        : null;
    const startBlock = startLeg
      ? `<div class="club-start-leg">
            <p class="club-start-from">${escapeHtml(
              draftStart.label ? `From ${String(draftStart.label).trim()}` : "From home / start"
            )}</p>
            ${legMarkup(startLeg, startMap)}
          </div>`
      : "";

    const stops = st.itinerary.stops
      .map((s, i) => {
        const inbound = i === 0 ? startLeg : st.itinerary.legs[i - 1];
        const originForMap =
          i === 0
            ? draftStart.lat != null
              ? draftStart
              : null
            : inbound?.from_home
              ? draftStart.lat != null
                ? draftStart
                : null
              : { lat: st.itinerary.stops[i - 1].lat, lng: st.itinerary.stops[i - 1].lng };
        const map = mapsLink(s.lat, s.lng, originForMap);
        const next = st.itinerary.stops[i + 1];
        const leg = i < st.itinerary.legs.length ? st.itinerary.legs[i] : null;
        const legOrigin =
          leg?.from_home
            ? draftStart.lat != null
              ? draftStart
              : null
            : { lat: s.lat, lng: s.lng };
        const legMap = next ? mapsLink(next.lat, next.lng, legOrigin) : null;
        const pinNote =
          s.lat == null || s.lng == null
            ? `<p class="club-leg is-warn">Venue needs a map pin</p>`
            : "";
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
              ${pinNote}
              <label class="club-inline">Visit min<input type="number" min="5" max="180" data-visit-min="${i}" value="${s.visit_minutes || DEFAULT_VISIT}" /></label>
              <label class="club-check"><input type="checkbox" data-lock="${i}" ${s.locked ? "checked" : ""} /> Lock</label>
              ${map ? `<a class="btn btn-ghost" target="_blank" rel="noopener" href="${escapeHtml(map)}">Map</a>` : ""}
              <button type="button" class="btn btn-ghost" data-remove-stop="${i}">Remove</button>
            </div>
            ${legMarkup(leg, legMap)}
          </article>`;
      })
      .join("");

    const warns = (st.itinerary.warnings || [])
      .map((w) => `<li class="club-warn ${w.type === "impossible" || w.type === "stale" || w.type === "missing_start" ? "is-bad" : ""}">${escapeHtml(w.message)}</li>`)
      .join("");

    const startPrompt = st.itinerary.needsStartPrompt
      ? `<section class="club-start-prompt" id="club-start-prompt" aria-labelledby="club-start-prompt-title">
          <h2 id="club-start-prompt-title">Where are you starting from?</h2>
          <p>Drive times use your home / start for the first game, and again when games are on different days or more than 3 hours apart. Same-day games within 3 hours chain from the prior venue.</p>
          <label>Start / home
            <input id="club-itin-start-prompt" value="${escapeHtml(draft?.start_location_label || "")}" placeholder="Home · Layton" enterkeyhint="done" autocomplete="street-address" />
          </label>
          <button type="button" class="btn btn-primary" id="club-start-prompt-go">Use this location</button>
        </section>`
      : "";

    const g = st.itinerary.gemini;
    const addedIds = new Set((st.itinerary.stops || []).map((s) => s.game_id));
    const transcript = (g.messages || [])
      .map((m) =>
        m.role === "user"
          ? `<div class="explore-msg is-user">${escapeHtml(m.content)}</div>`
          : `<div class="explore-msg is-assistant"><div class="club-md">${renderClubMarkdown(m.content, addedIds)}</div></div>`
      )
      .join("");

    return `
      ${matchPromptMarkup()}
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
          <label>Start / home
            <input id="club-itin-start" value="${escapeHtml(draft?.start_location_label || "")}" placeholder="Home · Layton" enterkeyhint="done" autocomplete="street-address" />
          </label>
        </div>
        <p class="club-start-status muted" id="club-start-status">${
          st.itinerary.startBusy
            ? "Locating start…"
            : draft?.start_latitude != null
              ? escapeHtml(draft._startResolveNote || "Start located")
              : draft?.start_location_label
                ? escapeHtml(draft._startResolveNote || "Enter a place, then tap away to locate")
                : "Used for the first game, and for gaps over 3 hours (or a new day)"
        }</p>
        <label>Notes<textarea id="club-itin-notes" rows="2">${escapeHtml(draft?.notes || "")}</textarea></label>
      </div>
      ${startPrompt}
      ${itineraryFinderMarkup()}
      ${warns ? `<ul class="club-warn-list">${warns}</ul>` : ""}
      <div class="club-stops">${startBlock}${stops || `<p class="empty-state">No stops yet. Use Find games to add club games to this itinerary.</p>`}</div>
      <div class="club-itin-actions">
        <button type="button" class="btn btn-primary" id="club-itin-save" ${st.itinerary.busy ? "disabled" : ""}>Save</button>
        <button type="button" class="btn btn-secondary" id="club-itin-copy">Copy text</button>
        <a class="btn btn-secondary" id="club-itin-ics" ${st.itinerary.stops?.length ? "" : "hidden"} download="club-visits.ics">Add to calendar</a>
        <button type="button" class="btn btn-ghost" id="club-itin-delete" ${st.itinerary.currentId ? "" : "hidden"}>Delete</button>
      </div>
      <section class="club-gemini">
        <h2>Ask Gemini</h2>
        <p class="muted">Questions use live club data tools — fixtures and drive times are not invented.</p>
        <div class="explore-transcript">${transcript || ""}</div>
        ${g.error ? `<p class="form-error">${escapeHtml(g.error)}</p>` : ""}
        <form id="club-gemini-form" class="explore-form">
          <label class="sr-only" for="club-gemini-input">Question</label>
          <textarea id="club-gemini-input" class="explore-input" rows="2" maxlength="2000" enterkeyhint="enter" placeholder="Which club games are near Layton this weekend?">${escapeHtml(g.draft || "")}</textarea>
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
    if (st.itinerary.startLeg) {
      const leg = st.itinerary.startLeg;
      if (leg.mode === "walk") lines.push(`→ Walk/transition ~${leg.minutes} min (approx)`);
      else if (leg.unavailable || leg.minutes == null) lines.push(`→ Drive from start: ${leg.note || "time unavailable"}`);
      else lines.push(`→ Drive from start ~${leg.minutes} min (estimate)`);
    }
    lines.push("");
    st.itinerary.stops.forEach((s, i) => {
      lines.push(`${i + 1}. ${s.team_line}`);
      if (s.brighton_line) lines.push(`   Players: ${s.brighton_line}`);
      lines.push(`   Kickoff: ${formatKickoff(s.kickoff_at)}`);
      if (s.planned_arrival_at) lines.push(`   Arrive ~ ${formatKickoff(s.planned_arrival_at)}`);
      lines.push(`   Venue: ${[s.facility_name, s.field_label].filter(Boolean).join(" · ") || "TBD"}`);
      const prev =
        i === 0
          ? d.start_latitude != null
            ? { lat: d.start_latitude, lng: d.start_longitude }
            : null
          : { lat: st.itinerary.stops[i - 1].lat, lng: st.itinerary.stops[i - 1].lng };
      const map = mapsLink(s.lat, s.lng, prev);
      if (map) lines.push(`   Map: ${map}`);
      if (i < st.itinerary.legs.length) {
        const leg = st.itinerary.legs[i];
        if (leg.mode === "walk") lines.push(`   → Walk/transition ~${leg.minutes} min (approx)`);
        else if (leg.unavailable || leg.minutes == null) lines.push(`   → Drive: ${leg.note || "time unavailable"}`);
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

  /** Keep in sync with supabase/functions/_shared/club/itinerary.mjs buildItineraryIcs. */
  function icsStamp(iso) {
    return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  }
  function icsEsc(text) {
    return String(text ?? "")
      .replace(/\\/g, "\\\\")
      .replace(/\r?\n/g, "\\n")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,");
  }
  function itineraryIcsFilename(itin) {
    const raw = String(itin?.name || "club-visits")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    return `${raw || "club-visits"}.ics`;
  }
  function buildItineraryIcs(itin, stops) {
    const stamp = icsStamp(new Date().toISOString());
    const itinKey = itin?.id || "draft";
    const calName = itin?.name || "Club visitation";
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Brighton Soccer//Club Visitation//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      `X-WR-CALNAME:${icsEsc(calName)}`,
      "X-WR-TIMEZONE:America/Denver",
    ];
    (stops || []).forEach((s, i) => {
      const visitMin = Number(s.visit_minutes) || DEFAULT_VISIT;
      let startIso = s.planned_arrival_at;
      let endIso = s.planned_departure_at;
      if (!startIso && s.kickoff_at) {
        startIso = new Date(new Date(s.kickoff_at).getTime() - 5 * 60000).toISOString();
      }
      if (!startIso) return;
      if (!endIso) {
        endIso = new Date(new Date(startIso).getTime() + visitMin * 60000).toISOString();
      }
      const team = s.team_line || s.label || "Club game";
      const summary = s.brighton_line ? `Visit: ${s.brighton_line} — ${team}` : `Visit: ${team}`;
      const venue = [s.facility_name, s.field_label].filter(Boolean).join(" · ") || "Venue TBD";
      const mapUrl = mapsLink(s.lat, s.lng);
      const desc = [
        itin?.name,
        s.brighton_line ? `Players: ${s.brighton_line}` : "",
        `Match: ${team}`,
        s.kickoff_at ? `Kickoff: ${formatKickoff(s.kickoff_at)}` : "",
        `Venue: ${venue}`,
        mapUrl ? `Map: ${mapUrl}` : "",
        s.notes || "",
        itin?.notes && i === 0 ? `Itinerary notes: ${itin.notes}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const uidGame = s.game_id || s.club_game_id || `stop-${i + 1}`;
      lines.push(
        "BEGIN:VEVENT",
        `UID:${itinKey}-${uidGame}@bhs-club-visits`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${icsStamp(startIso)}`,
        `DTEND:${icsStamp(endIso)}`,
        `SUMMARY:${icsEsc(summary)}`,
        `DESCRIPTION:${icsEsc(desc)}`,
        `LOCATION:${icsEsc(venue)}`,
        "STATUS:CONFIRMED",
        "TRANSP:OPAQUE",
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        "TRIGGER:-PT15M",
        `DESCRIPTION:${icsEsc(summary)}`,
        "END:VALARM",
        "END:VEVENT"
      );
    });
    lines.push("END:VCALENDAR", "");
    return lines.join("\r\n");
  }

  function refreshIcsLink() {
    const link = $("#club-itin-ics");
    if (!link) return;
    const stops = st.itinerary.stops || [];
    if (!stops.length) {
      link.hidden = true;
      link.removeAttribute("href");
      return;
    }
    const draft = st.itinerary.draft || {};
    const itin = {
      id: st.itinerary.currentId || draft.id || "draft",
      name: draft.name || "Club visitation",
      notes: draft.notes || "",
    };
    const ics = buildItineraryIcs(itin, stops);
    link.download = itineraryIcsFilename(itin);
    link.href = `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`;
    link.hidden = false;
  }

  function bindItineraryAdds() {
    $$("[data-add-itin]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        readItineraryForm();
        const id = btn.getAttribute("data-add-itin");
        btn.disabled = true;
        const added = await addStop(id);
        st.itinerary.engaged = true;
        st.itinerary.pickerOpen = true;
        showToast(added ? `Added to ${workingName()}` : `Already on ${workingName()}`);
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
    if (st.itinerary.pickerOpen) bindAgendaFilters();
    bindItineraryAdds();
    $("#club-itin-select")?.addEventListener("change", async (e) => {
      const id = e.target.value;
      if (!id) {
        st.itinerary.currentId = "";
        st.itinerary.draft = emptyItineraryDraft();
        st.itinerary.stops = [];
        st.itinerary.legs = [];
        st.itinerary.startLeg = null;
        st.itinerary.orderManual = false;
        st.itinerary.warnings = [];
        st.itinerary.engaged = true;
        paint();
        return;
      }
      st.loading = true;
      paint();
      try {
        await loadItinerary(id);
        st.itinerary.engaged = true;
      } catch (err) {
        st.error = err.message || "Could not load itinerary";
      }
      st.loading = false;
      paint();
    });
    $("#club-itin-new")?.addEventListener("click", () => {
      st.itinerary.currentId = "";
      st.itinerary.draft = emptyItineraryDraft();
      st.itinerary.stops = [];
      st.itinerary.legs = [];
      st.itinerary.startLeg = null;
      st.itinerary.orderManual = false;
      st.itinerary.warnings = [];
      st.itinerary.engaged = true;
      paint();
    });
    const applyStartInput = async (el) => {
      if (!st.itinerary.draft) st.itinerary.draft = emptyItineraryDraft();
      const val = el?.value || "";
      if (val !== (st.itinerary.draft.start_location_label || "")) {
        st.itinerary.draft.start_latitude = null;
        st.itinerary.draft.start_longitude = null;
        st.itinerary.draft._startGeocodeFor = "";
        st.itinerary.draft._startResolveNote = "";
      }
      st.itinerary.draft.start_location_label = val;
      const formStart = $("#club-itin-start");
      if (formStart && formStart !== el) formStart.value = val;
      await refreshLegs();
      paint();
    };
    $("#club-itin-start")?.addEventListener("change", async (e) => {
      await applyStartInput(e.target);
    });
    $("#club-start-prompt-go")?.addEventListener("click", async () => {
      await applyStartInput($("#club-itin-start-prompt"));
    });
    $("#club-itin-start-prompt")?.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      await applyStartInput(e.target);
    });
    if (st.itinerary.scrollStart) {
      st.itinerary.scrollStart = false;
      const focusEl = $("#club-itin-start-prompt") || $("#club-itin-start");
      focusEl?.scrollIntoView({ block: "nearest" });
      focusEl?.focus();
    }
    $$("[data-stop-up]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        readItineraryForm();
        const i = Number(btn.getAttribute("data-stop-up"));
        if (i <= 0) return;
        const arr = st.itinerary.stops;
        [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
        arr.forEach((s, idx) => {
          s.stop_order = idx + 1;
        });
        st.itinerary.orderManual = true;
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
        arr.forEach((s, idx) => {
          s.stop_order = idx + 1;
        });
        st.itinerary.orderManual = true;
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
    refreshIcsLink();
    $("#club-itin-delete")?.addEventListener("click", () => deleteItinerary());
    $("#club-gemini-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      askGemini($("#club-gemini-input")?.value || "");
    });
    $("#club-gemini-input")?.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      // iPhone keyboard already has Return for a new line and the Ask button to send.
      if (isIosDevice()) return;
      if (e.ctrlKey) {
        e.preventDefault();
        insertTextareaNewline(e.target);
        return;
      }
      if (e.shiftKey || e.altKey || e.metaKey) return;
      const submit = e.target.form?.querySelector('button[type="submit"]');
      if (submit?.disabled) return;
      e.preventDefault();
      e.target.form?.requestSubmit();
    });
    $("#club-gemini-suggest")?.addEventListener("click", () => suggestOrder());
    $("#club-gemini-input")?.addEventListener("input", (e) => {
      st.itinerary.gemini.draft = e.target.value;
    });
    bindMatchPrompt();
  }

  function isIosDevice() {
    const ua = global.navigator?.userAgent || "";
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    return global.navigator?.platform === "MacIntel" && (global.navigator?.maxTouchPoints || 0) > 1;
  }

  function insertTextareaNewline(el) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    el.value = `${el.value.slice(0, start)}\n${el.value.slice(end)}`;
    el.selectionStart = el.selectionEnd = start + 1;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function bindMatchPrompt() {
    const drop = (clubId) => {
      if (!st.itinerary.dismissedMatchIds.includes(clubId)) st.itinerary.dismissedMatchIds.push(clubId);
      st.itinerary.matchPrompt = (st.itinerary.matchPrompt || []).filter((row) => row.clubPlayerId !== clubId);
    };
    $$("[data-match-yes]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        readItineraryForm();
        const clubId = btn.getAttribute("data-match-yes");
        const row = (st.itinerary.matchPrompt || []).find((item) => item.clubPlayerId === clubId);
        if (!row) return;
        const shotId =
          row.candidates.length === 1
            ? row.candidates[0].id
            : $(`[data-match-shot="${CSS.escape(clubId)}"]`)?.value;
        if (!shotId) {
          showToast("Choose a Shot Tracker player");
          return;
        }
        const sb = api().getClient();
        const { error } = await sb.from("club_player_links").insert({
          player_id: shotId,
          club_player_id: clubId,
        });
        if (error) {
          st.error = error.message;
          paint();
          return;
        }
        st.itinerary.matchPrompt = (st.itinerary.matchPrompt || [])
          .filter((item) => item.clubPlayerId !== clubId)
          .map((item) => ({ ...item, candidates: item.candidates.filter((c) => c.id !== shotId) }))
          .filter((item) => item.candidates.length);
        showToast("Matched to Shot Tracker");
        paint();
      });
    });
    $$("[data-match-no]").forEach((btn) => {
      btn.addEventListener("click", () => {
        readItineraryForm();
        drop(btn.getAttribute("data-match-no"));
        paint();
      });
    });
    $("#club-match-skip")?.addEventListener("click", () => {
      readItineraryForm();
      for (const row of st.itinerary.matchPrompt || []) drop(row.clubPlayerId);
      paint();
    });
    if (st.itinerary.scrollMatch) {
      st.itinerary.scrollMatch = false;
      $("#club-match")?.scrollIntoView({ block: "nearest" });
    }
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
    readItineraryForm();
    await resolveStartCoords();
    const summary = buildCopyText();
    const draft = st.itinerary.draft || {};
    const row = {
      name,
      target_date: $("#club-itin-date")?.value || null,
      start_location_label: draft.start_location_label || null,
      start_latitude: draft.start_latitude ?? null,
      start_longitude: draft.start_longitude ?? null,
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
          if (!st.itinerary.stops.some((s) => s.game_id === id)) await addStop(id);
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
      const linkRows = (st.links || [])
        .map(
          (l) =>
            `<li>${escapeHtml(l.club_players?.name || "Club player")} → ${escapeHtml(l.players?.name || "Shot Tracker")}
              <button type="button" class="btn btn-ghost" data-unlink="${escapeHtml(l.id)}">Remove link</button></li>`
        )
        .join("");
      body = `
        <form id="club-add-player" class="club-mini-form">
          <h3>Add club player</h3>
          <input name="name" placeholder="Full name" required />
          <input name="short_name" placeholder="Short name" />
          <button class="btn btn-primary" type="submit">Add</button>
        </form>
        <form id="club-add-aff" class="club-mini-form">
          <h3>Add to a club team</h3>
          <select name="club_player_id" required><option value="">Club player</option>${playerOpts}</select>
          <select name="club_team_id" required><option value="">Team</option>${teamOpts}</select>
          <button class="btn btn-primary" type="submit">Add</button>
        </form>
        <ul class="club-list">${st.data.affiliations
          .map(
            (a) =>
              `<li>${escapeHtml(a.club_players?.short_name || a.club_players?.name || "?")} → ${escapeHtml(a.team?.team_name || "")}</li>`
          )
          .join("")}</ul>
        <h3>Shot Tracker links</h3>
        <p class="muted">A link is optional. It is offered when you add a game whose club player looks like a Shot Tracker player.</p>
        <ul class="club-list">${linkRows || `<li class="muted">No links yet</li>`}</ul>`;
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
          <input name="street_address" placeholder="Street address" autocomplete="street-address" />
          <div class="club-split">
            <input name="latitude" placeholder="Lat (optional)" inputmode="decimal" />
            <input name="longitude" placeholder="Lng (optional)" inputmode="decimal" />
          </div>
          <p class="muted">Leave lat/lng blank — use Locate after save if you have an address.</p>
          <button class="btn btn-primary" type="submit">Add facility</button>
        </form>
        <form id="club-add-field" class="club-mini-form">
          <h3>Field</h3>
          <select name="club_facility_id">${st.data.facilities.map((f) => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join("")}</select>
          <input name="label" placeholder="Field 5" required />
          <button class="btn btn-primary" type="submit">Add field</button>
        </form>
        <ul class="club-list club-fac-list">${st.data.facilities
          .map((f) => {
            const fields = st.data.fields.filter((x) => x.club_facility_id === f.id).map((x) => x.label).join(", ");
            const addr = [f.street_address, f.city].filter(Boolean).join(", ");
            const pinned = f.latitude != null && f.longitude != null;
            const status = pinStatusLabel(f);
            const map = mapsLink(f.latitude, f.longitude);
            const busy = st.data.geocodeBusyId === f.id;
            const canLocate = !!(f.street_address || f.city || f.name);
            return `<li class="club-fac-row">
              <div class="club-fac-main">
                <strong>${escapeHtml(f.name)}</strong>
                <span class="club-pin-badge${pinned ? " is-ok" : " is-miss"}">${escapeHtml(status)}</span>
                ${addr ? `<p class="muted">${escapeHtml(addr)}</p>` : `<p class="muted">No address on file</p>`}
                <p class="muted">${escapeHtml(fields || "No fields")}</p>
              </div>
              <div class="club-fac-actions">
                ${map ? `<a class="btn btn-ghost" target="_blank" rel="noopener" href="${escapeHtml(map)}">Map</a>` : ""}
                ${
                  canLocate
                    ? `<button type="button" class="btn btn-secondary" data-geocode-fac="${escapeHtml(f.id)}" ${busy ? "disabled" : ""}>${
                        busy ? "Locating…" : pinned ? "Re-locate" : "Locate"
                      }</button>`
                    : ""
                }
              </div>
            </li>`;
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
    $("#club-add-player")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const sb = api().getClient();
      const name = String(fd.get("name") || "").trim();
      if (!name) return;
      const { error } = await sb.from("club_players").insert({
        name,
        short_name: String(fd.get("short_name") || "").trim() || null,
      });
      if (error) st.error = error.message;
      else showToast("Club player added");
      st.players = [];
      await loadDataSection();
      paint();
    });
    $$("[data-unlink]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const sb = api().getClient();
        const { error } = await sb.from("club_player_links").delete().eq("id", btn.getAttribute("data-unlink"));
        if (error) st.error = error.message;
        else showToast("Link removed");
        await loadDataSection();
        paint();
      });
    });
    $("#club-add-aff")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const sb = api().getClient();
      const { error } = await sb.from("club_player_affiliations").insert({
        club_player_id: fd.get("club_player_id"),
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
    $$("[data-geocode-fac]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-geocode-fac");
        const f = st.data.facilities.find((x) => x.id === id);
        if (!f) return;
        const query = facilityQuery(f);
        if (!query) {
          showToast("Add an address first");
          return;
        }
        st.data.geocodeBusyId = id;
        paint();
        const geo = await geocodePlaceQuery(query);
        st.data.geocodeBusyId = "";
        if (!geo.ok || !geo.results.length) {
          st.error =
            geo.error || "Could not locate facility";
          if (f.id) {
            await api()
              .getClient()
              .from("club_facilities")
              .update({ geocode_status: "failed" })
              .eq("id", f.id);
          }
          await loadDataSection();
          paint();
          return;
        }
        const hit = geo.results[0];
        const { error } = await api()
          .getClient()
          .from("club_facilities")
          .update({
            latitude: hit.lat,
            longitude: hit.lng,
            geocode_status: "ok",
            maps_url: mapsLink(hit.lat, hit.lng),
          })
          .eq("id", id);
        if (error) st.error = error.message;
        else showToast(geo.ambiguous ? `Located (check): ${hit.label}` : `Located: ${hit.label}`);
        await loadDataSection();
        paint();
      })
    );
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
          club_player_id: player.id,
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
    if (st.loading) startLoadingLines();
    else stopLoadingLines();
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
          st.itinerary.draft = emptyItineraryDraft();
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
    shotTrackerMatches,
    renderClubMarkdown,
    shouldDriveFromPrior,
    buildItineraryIcs,
    itineraryIcsFilename,
    CHAIN_GAP_MS,
    onLeave() {
      stopLoadingLines();
    },
  };
})(window);
