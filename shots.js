/**
 * Brighton Shot Tracker — Phase 2 UI (vanilla JS).
 *
 * Sideline recording is still tap-fast. Backend is additive.
 *
 * Out of scope (do not add here):
 *   - Per-coach accounts / attribution (PIN is shared access-gating only)
 *   - Audit trail / edit history on shots (silent overwrite is fine)
 *   - Offline-first queue / conflict resolution for spotty connectivity
 *   - Real-time multi-device live updates (manual Sync only)
 *   - xG, video integration, formation drawing
 *
 * Known gap: if a write fails, the play stays marked "not saved — check
 * connection" with Retry or Sync. Writes are not queued offline.
 */
(function (global) {
  "use strict";

  const SHOTS_CFG = global.SHOTS_CONFIG || {};
  const CONFIG = {
    pitch: SHOTS_CFG.pitch || { width: 68, length: 105 },
    shotsStorageKey: SHOTS_CFG.storageKey || "brighton-varsity-shot-tracker",
  };
  const API = global.ShotAPI;
  const PW = CONFIG.pitch.width;
  const PL = CONFIG.pitch.length;
  const HALF_L = PL / 2;
  const DEF_SLIVER = 8;
  const FIELD_Y_MAX = HALF_L + DEF_SLIVER;
  const PEN_W = 40.32;
  const SIX_W = 18.32;
  const PEN_SIDE = (PW - PEN_W) / 2;
  const WIDE_END = PEN_SIDE + 1.2;
  const CENTER_W = 17;
  const CENTER_X0 = (PW - CENTER_W) / 2;
  const CENTER_X1 = CENTER_X0 + CENTER_W;
  const TRACKER_CHANNELS = [
    { id: "LW", label: "Left wide", x0: 0, x1: WIDE_END },
    { id: "LHS", label: "Left half-space", x0: WIDE_END, x1: CENTER_X0 },
    { id: "C", label: "Center", x0: CENTER_X0, x1: CENTER_X1 },
    { id: "RHS", label: "Right half-space", x0: CENTER_X1, x1: PW - WIDE_END },
    { id: "RW", label: "Right wide", x0: PW - WIDE_END, x1: PW },
  ];
  const TRACKER_DEPTHS = [
    { id: "6Y", label: "Six-yard", y0: 0, y1: 5.5 },
    { id: "PS", label: "Penalty-spot line", y0: 5.5, y1: 11 },
    { id: "BOX", label: "Penalty area", y0: 11, y1: 16.5 },
    { id: "D", label: "Top of the box", y0: 16.5, y1: 25 },
    { id: "AT", label: "Attacking third", y0: 25, y1: 35 },
    { id: "HALF", label: "Toward halfway", y0: 35, y1: HALF_L },
  ];
  const OUTSIDE_BOX_DEPTHS = ["D", "AT", "HALF", "DEF"];
  const POSITION_CODES = ["GK", "LB", "LCB", "RCB", "RB", "DM", "LM", "RM", "LW", "CF", "RW"];
  const POSITION_SLOTS = [
    { id: 1, code: "GK", group: "GK" },
    { id: 2, code: "LB", group: "OB" },
    { id: 3, code: "LCB", group: "CB" },
    { id: 4, code: "RCB", group: "CB" },
    { id: 5, code: "RB", group: "OB" },
    { id: 6, code: "DM", group: "MID" },
    { id: 7, code: "LM", group: "MID" },
    { id: 8, code: "RM", group: "MID" },
    { id: 9, code: "LW", group: "FWD" },
    { id: 10, code: "CF", group: "FWD" },
    { id: 11, code: "RW", group: "FWD" },
  ];
  /** 4-3-3 pin map: attacking goal at top, % of pitch (card centers). */
  const FORMATION_LAYOUT = [
    { id: 9, code: "LW", x: 18, y: 26 },
    { id: 10, code: "CF", x: 50, y: 22 },
    { id: 11, code: "RW", x: 82, y: 26 },
    { id: 7, code: "LM", x: 28, y: 46 },
    { id: 8, code: "RM", x: 72, y: 46 },
    { id: 6, code: "DM", x: 50, y: 56 },
    { id: 2, code: "LB", x: 12, y: 68 },
    { id: 3, code: "LCB", x: 36, y: 78 },
    { id: 4, code: "RCB", x: 64, y: 78 },
    { id: 5, code: "RB", x: 88, y: 68 },
    { id: 1, code: "GK", x: 50, y: 90 },
  ];
  const POSITION_GROUPS = [
    { id: "GK", label: "GK" },
    { id: "OB", label: "Outside backs" },
    { id: "CB", label: "Center backs" },
    { id: "MID", label: "Mids" },
    { id: "FWD", label: "Forwards" },
  ];
  const GROUP_FOR_CODE = Object.fromEntries(POSITION_SLOTS.map((s) => [s.code, s.group]));
  /** Jersey → position groups (for Sub / lineup dropdown ordering) */
  const DEFAULT_POSITION_GROUPS = {
    "1": ["GK"], // Lilah
    "19": ["CB"], // Jane
    "20": ["CB"], // Shai
    "11": ["CB"], // Tae
    "33": ["CB", "OB"], // Finley
    "15": ["OB", "MID"], // Saige
    "2": ["OB", "MID"], // Maddie
    "8": ["OB", "FWD"], // Addison
    "9": ["OB", "FWD"], // Georgia
    "24": ["MID", "FWD"], // Savvy
    "17": ["MID"], // Jackie
    "26": ["MID"], // Sharky
    "18": ["MID"], // Stella
    "25": ["MID"], // Grace
    "32": ["FWD"], // Ari
    "13": ["FWD"], // Kailee
    "29": ["FWD"], // Abby
    "5": ["FWD"], // Kate
    "27": ["FWD"], // Natalia
  };
  /** Default 4-3-3 XI: back→front, left→right */
  const DEFAULT_XI_JERSEYS = [
    { slot: 1, code: "GK", number: "1" }, // Lilah
    { slot: 2, code: "LB", number: "15" }, // Saige
    { slot: 3, code: "LCB", number: "20" }, // Shai
    { slot: 4, code: "RCB", number: "19" }, // Jane
    { slot: 5, code: "RB", number: "2" }, // Maddie
    { slot: 6, code: "DM", number: "24" }, // Savvy
    { slot: 7, code: "LM", number: "17" }, // Jackie
    { slot: 8, code: "RM", number: "26" }, // Sharky
    { slot: 9, code: "LW", number: "9" }, // Georgia
    { slot: 10, code: "CF", number: "13" }, // Kailee
    { slot: 11, code: "RW", number: "32" }, // Ari
  ];
  const GAME_TYPES = ["preseason", "region", "playoffs", "friendly", "other"];
  const SHOT_RESULT_LABELS = {
    goal: "Goal",
    "on-target": "Shot on Goal",
    blocked: "Shot Blocked",
    missed: "Missed Shot",
    foul: "Free Kick",
    corner: "Corner",
    "pk-goal": "PK Goal",
    "pk-missed": "PK Missed",
  };
  const MISS_DIRECTION_LABELS = {
    over: "Over",
    short: "Short",
    "wide-left": "Wide left",
    "wide-right": "Wide right",
  };
  const MISS_DIRECTIONS = ["over", "short", "wide-left", "wide-right"];
  const ASSIST_TYPE_LABELS = { pass: "Pass", gap: "Gap", cross: "Cross" };
  const TRACKER_ASSIST_ACTIONS = [
    { id: "assist-pass", label: "Assist — Pass", kind: "assist", type: "pass" },
    { id: "assist-gap", label: "Assist — Gap", kind: "assist", type: "gap" },
    { id: "assist-cross", label: "Assist — Cross", kind: "assist", type: "cross" },
  ];
  const TRACKER_SHOT_ACTIONS = [
    { id: "goal", label: "Goal", kind: "shot", result: "goal" },
    { id: "on-target", label: "Shot on Goal", kind: "shot", result: "on-target" },
    { id: "blocked", label: "Shot Blocked", kind: "shot", result: "blocked" },
    { id: "missed", label: "Missed Shot", kind: "shot", result: "missed" },
  ];
  const TRACKER_OTHER_ACTIONS = [
    { id: "foul", label: "Free Kick", kind: "shot", result: "foul" },
    { id: "corner", label: "Corner", kind: "shot", result: "corner" },
    { id: "pk-goal", label: "PK Goal", kind: "shot", result: "pk-goal" },
    { id: "pk-missed", label: "PK Missed", kind: "shot", result: "pk-missed" },
  ];
  const TRACKER_FIRST_ACTIONS = [...TRACKER_ASSIST_ACTIONS, ...TRACKER_SHOT_ACTIONS, ...TRACKER_OTHER_ACTIONS];
  const SHOT_RESULTS = new Set(["goal", "on-target", "blocked", "missed", "pk-goal", "pk-missed"]);
  const LOG_RESULT_FILTERS = {
    all: { label: "All results", match: () => true },
    shots: { label: "Shots", match: (e) => SHOT_RESULTS.has(e.result) },
    goal: { label: "Goals", match: (e) => e.result === "goal" || e.result === "pk-goal" },
    "on-target": { label: "On target", match: (e) => e.result === "on-target" },
    blocked: { label: "Blocked", match: (e) => e.result === "blocked" },
    missed: { label: "Missed", match: (e) => e.result === "missed" || e.result === "pk-missed" },
    foul: { label: "Free kicks", match: (e) => e.result === "foul" },
    corner: { label: "Corners", match: (e) => e.result === "corner" },
    pk: { label: "PKs", match: (e) => e.result === "pk-goal" || e.result === "pk-missed" },
  };

  function normalizeLogResult(value) {
    return LOG_RESULT_FILTERS[value] ? value : "all";
  }

  function eventMatchesLogFilter(ev) {
    const team = st.logTeam === "us" || st.logTeam === "opp" ? st.logTeam : "all";
    if (team !== "all" && eventTeam(ev) !== team) return false;
    return LOG_RESULT_FILTERS[normalizeLogResult(st.logResult)].match(ev);
  }

  const RESULTS_NEEDING_MISS_DIR = new Set(["missed", "pk-missed"]);
  const RESULTS_NEEDING_FOULER = new Set(["pk-goal", "pk-missed"]);
  const LS_EVENTS = CONFIG.shotsStorageKey || "brighton-varsity-shot-tracker";
  const LS_UI_V1 = "brighton-varsity-shot-tracker-ui";
  const LS_UI_V2 = "brighton-varsity-shot-tracker-ui-v2";
  const LS_LINEUP = "brighton-varsity-shot-tracker-lineup";
  const LS_DEFAULT_LINEUP = "brighton-varsity-shot-tracker-default-lineup";
  const LS_NOTE_AUTHOR = "brighton-varsity-shot-tracker-note-author";
  const LS_CLOCK = "brighton-varsity-shot-tracker-clock";
  const LS_STAMP_OFFSET = "brighton-shot-stamp-offset";
  const LS_SCOREBOARD_POLL = "brighton-scoreboard-poll-sec";
  const SCOREBOARD_POLL_OPTS = [15, 30, 60, 300];
  const DEFAULT_HALF_SEC = 40 * 60;
  const DEFAULT_ET_SEC = 10 * 60;
  const NICK = { Madeline: "Maddie", Abigail: "Abby", Jaqueline: "Jackie", Ariana: "Ari", Charlotte: "Sharky" };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const root = () => $("#app-root");
  const shotModal = $("#shot-event-modal");

  function escapeHtml(str) {
    return String(str)
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
    showToast._t = setTimeout(() => el.classList.remove("is-visible"), 2200);
  }

  function loadUi() {
    try {
      return JSON.parse(localStorage.getItem(LS_UI_V2) || "{}") || {};
    } catch {
      return {};
    }
  }

  function loadStampOffset() {
    const raw = localStorage.getItem(LS_STAMP_OFFSET);
    if (raw == null || raw === "") return 30;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return 30;
    return Math.min(120, Math.round(n));
  }

  function saveStampOffset(n) {
    if (n === "" || n == null) {
      st.stampOffset = 30;
      localStorage.setItem(LS_STAMP_OFFSET, "30");
      return;
    }
    const parsed = Number(n);
    const v = Number.isFinite(parsed) ? Math.min(120, Math.max(0, Math.round(parsed))) : 30;
    st.stampOffset = v;
    localStorage.setItem(LS_STAMP_OFFSET, String(v));
  }

  function saveUi() {
    localStorage.setItem(
      LS_UI_V2,
      JSON.stringify({
        period: st.period,
        team: st.team,
        showGrid: st.showGrid,
        swapSides: st.swapSides,
        logTeam: st.logTeam,
        logResult: st.logResult,
        seasonId: st.seasonId,
        gameId: st.gameId,
      })
    );
    if (st.seasonId) sessionStorage.setItem("shots-season-id", st.seasonId);
    if (st.gameId) sessionStorage.setItem("shots-game-id", st.gameId);
  }

  function loadLineupBag() {
    try {
      const parsed = JSON.parse(localStorage.getItem(LS_LINEUP) || "{}") || {};
      return {
        edit: "us",
        us: parsed.us && typeof parsed.us === "object" ? parsed.us : {},
        opp: {},
      };
    } catch {
      return { edit: "us", us: {}, opp: {} };
    }
  }

  function saveLineupBag() {
    localStorage.setItem(
      LS_LINEUP,
      JSON.stringify({
        edit: "us",
        us: st.lineup.us,
        opp: {},
      })
    );
  }

  function loadDefaultLineup() {
    try {
      const parsed = JSON.parse(localStorage.getItem(LS_DEFAULT_LINEUP) || "{}") || {};
      return parsed.us && typeof parsed.us === "object" ? { us: parsed.us } : { us: {} };
    } catch {
      return { us: {} };
    }
  }

  function saveDefaultLineupBag(bag) {
    localStorage.setItem(LS_DEFAULT_LINEUP, JSON.stringify({ us: bag || {} }));
  }

  const savedUi = loadUi();
  const savedLineup = loadLineupBag();
  const st = {
    view: "shots",
    booted: false,
    booting: false,
    session: null,
    pinError: "",
    loading: false,
    error: "",
    teams: [],
    seasons: [],
    games: [],
    allGames: [],
    game: null,
    seasonId: savedUi.seasonId || sessionStorage.getItem("shots-season-id") || "",
    gameId: savedUi.gameId || sessionStorage.getItem("shots-game-id") || "",
    ourRoster: [],
    oppRoster: [],
    shots: [],
    namedPlayers: [],
    syncing: false,
    mode: "idle",
    pending: null,
    showGrid: savedUi.showGrid !== false,
    period: normalizePeriod(savedUi.period || "1"),
    team: savedUi.team === "opp" ? "opp" : "us",
    swapSides: !!savedUi.swapSides,
    logTeam: savedUi.logTeam === "us" || savedUi.logTeam === "opp" ? savedUi.logTeam : "all",
    logResult: normalizeLogResult(savedUi.logResult),
    lineup: savedLineup,
    defaultLineup: loadDefaultLineup(),
    csvPending: null,
    importOpen: false,
    stampOffset: loadStampOffset(),
    editingClockId: null,
    pendingOpenGameId: "",
    history: { seasonId: "", playerId: "", opponentId: "", depth: "", rows: null, loading: false },
    explore: {
      messages: [],
      draft: "",
      loading: false,
      lastResult: null,
      error: "",
    },
    prep: {
      tab: "opponent",
      opponentId: "",
      seasonId: "",
      includeFriendly: false,
      selectedGameIds: [],
      lockedGameId: "",
      teamFilter: "both",
      resultFilter: "all",
      periodFilter: "all",
      rows: null,
      notes: [],
      loading: false,
      loadKey: "",
      selectedShotId: "",
      noteBody: "",
      noteTags: "",
      noteAuthor: localStorage.getItem(LS_NOTE_AUTHOR) || "",
      noteGameId: "",
      gemini: { loading: false, error: "", messages: [], draft: "" },
      showConfig: false,
      showFilters: false,
      showStats: false,
      showNoteForm: false,
    },
  };

  const shotModalDraft = {
    step: "first",
    phase: "action",
    location: null,
    player: null,
    fouler: null,
    foulerPicked: false,
    foulerPickTeam: "opp",
    action: null,
    position: "",
    missDirection: "",
    fkOutcome: "",
    subSlotId: null,
    justAddedNumber: "",
  };

  const editLocDraft = {
    assist: null,
    second: null,
  };

  function locFromPlay(play) {
    if (!play || play.x == null || play.x === "" || Number.isNaN(Number(play.x))) return null;
    return {
      x: Number(play.x),
      y: Number(play.y),
      zoneId: play.zoneId || play.zone_id || null,
      zoneLabel: play.zoneLabel || play.zone_label || null,
    };
  }

  function positionSelectOptions(selected) {
    const cur = selected || "";
    return `<option value="">—</option>${POSITION_CODES.map(
      (code) => `<option value="${escapeHtml(code)}" ${code === cur ? "selected" : ""}>${escapeHtml(code)}</option>`
    ).join("")}`;
  }

  function normalizePeriod(p) {
    if (p === 3 || p === "3" || p === "ET1") return "ET1";
    if (p === 4 || p === "4" || p === "ET2") return "ET2";
    if (p === 2 || p === "2") return "2";
    return "1";
  }

  function periodLabel(period) {
    const p = normalizePeriod(period);
    if (p === "2") return "2nd Half";
    if (p === "ET1") return "ET 1";
    if (p === "ET2") return "ET 2";
    return "1st Half";
  }

  function periodCsv(period) {
    return normalizePeriod(period);
  }

  function eventPeriod(ev) {
    return normalizePeriod(ev && ev.period);
  }

  function isGoalResult(result) {
    return result === "goal" || result === "pk-goal";
  }

  function gameScore(events) {
    let us = 0;
    let opp = 0;
    (events || []).forEach((ev) => {
      if (!isGoalResult(ev.result)) return;
      if (eventTeam(ev) === "opp") opp += 1;
      else us += 1;
    });
    return { us, opp };
  }

  function clockGame(game) {
    return game || st.game || null;
  }

  function clockDirection(game) {
    return clockGame(game)?.clock_direction === "up" ? "up" : "down";
  }

  function clockEnabled() {
    return true;
  }

  function periodLengthSec(period, game) {
    const g = clockGame(game);
    const p = normalizePeriod(period || st.period);
    if (p === "ET1" || p === "ET2") {
      const n = Number(g?.clock_et_length_sec);
      return Number.isFinite(n) && n > 0 ? n : DEFAULT_ET_SEC;
    }
    const n = Number(g?.clock_half_length_sec);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_HALF_SEC;
  }

  function formatClockSecs(total) {
    const s = Math.max(0, Math.floor(Number(total) || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, "0")}`;
  }

  function parseClockInput(text) {
    const t = String(text || "").trim();
    if (!t) return null;
    const split = t.match(/^(\d*)\D+(\d*)$/);
    if (split) {
      const minutes = split[1] === "" ? 0 : Number(split[1]);
      let secDigits = split[2];
      if (!secDigits) secDigits = "00";
      else if (secDigits.length === 1) secDigits += "0";
      else secDigits = secDigits.slice(0, 2);
      const sec = Number(secDigits);
      if (!Number.isFinite(minutes) || minutes < 0 || !Number.isFinite(sec) || sec > 59) return null;
      return minutes * 60 + sec;
    }
    if (/^\d+$/.test(t)) return Number(t) * 60;
    return null;
  }

  function elapsedToDisplay(elapsed, period, game) {
    const n = Math.max(0, Math.floor(Number(elapsed) || 0));
    if (clockDirection(game) === "down") return Math.max(0, periodLengthSec(period, game) - n);
    return n;
  }

  function displayToElapsed(displaySec, period, game) {
    const n = Math.max(0, Math.floor(Number(displaySec) || 0));
    if (clockDirection(game) === "down") return Math.max(0, periodLengthSec(period, game) - n);
    return n;
  }

  function formatEventClock(ev, game) {
    const raw = ev?.gameClockSeconds ?? ev?.game_clock_seconds;
    if (raw == null || raw === "") return "—";
    return formatClockSecs(elapsedToDisplay(Number(raw), eventPeriod(ev), game || ev.game || st.game));
  }

  let clockMem = { gameId: "", periods: {} };
  let clockTickId = null;

  function loadClockStore() {
    try {
      return JSON.parse(localStorage.getItem(LS_CLOCK) || "{}") || {};
    } catch {
      return {};
    }
  }

  function persistClockMem() {
    if (!clockMem.gameId) return;
    const store = loadClockStore();
    store[clockMem.gameId] = clockMem.periods;
    localStorage.setItem(LS_CLOCK, JSON.stringify(store));
  }

  function ensureClockMem() {
    if (!st.gameId) return;
    if (clockMem.gameId === st.gameId) return;
    const store = loadClockStore();
    clockMem = { gameId: st.gameId, periods: store[st.gameId] && typeof store[st.gameId] === "object" ? store[st.gameId] : {} };
  }

  function clockPeriodState(period) {
    ensureClockMem();
    const p = normalizePeriod(period || st.period);
    if (!clockMem.periods[p]) clockMem.periods[p] = { elapsed: 0, running: false, startedAt: null };
    return clockMem.periods[p];
  }

  function currentElapsed(period) {
    const s = clockPeriodState(period);
    let n = Number(s.elapsed) || 0;
    if (s.running && s.startedAt) n += Math.floor((Date.now() - s.startedAt) / 1000);
    n = Math.max(0, n);
    if (clockDirection() === "down") n = Math.min(n, periodLengthSec(period));
    return n;
  }

  function displayClockSeconds(period) {
    return elapsedToDisplay(currentElapsed(period), period, st.game);
  }

  function clockIsRunning() {
    return !!clockPeriodState().running;
  }

  function stampClockSeconds() {
    if (!clockEnabled()) return null;
    const offset = Math.max(0, Number(st.stampOffset) || 0);
    return Math.max(0, currentElapsed() - offset);
  }

  function autoPauseIfExpired() {
    if (clockDirection() !== "down" || !clockIsRunning()) return false;
    if (currentElapsed() < periodLengthSec()) return false;
    const s = clockPeriodState();
    s.elapsed = periodLengthSec();
    s.running = false;
    s.startedAt = null;
    persistClockMem();
    persistLiveClock();
    return true;
  }

  function startClockTick() {
    if (clockTickId) return;
    clockTickId = setInterval(() => {
      const stopped = autoPauseIfExpired();
      paintClockFaces();
      if (stopped) stopClockTick();
    }, 250);
  }

  function stopClockTick() {
    if (!clockTickId) return;
    clearInterval(clockTickId);
    clockTickId = null;
  }

  function paintClockFaces() {
    const text = formatClockSecs(displayClockSeconds());
    $$("[data-clock-face]").forEach((el) => {
      el.textContent = text;
    });
    $$("[data-clock-toggle]").forEach((btn) => {
      btn.textContent = clockIsRunning() ? "Stop" : "Start";
    });
    if (clockIsRunning()) startClockTick();
    else stopClockTick();
  }

  function startClock() {
    if (!clockEnabled()) return;
    autoPauseIfExpired();
    const s = clockPeriodState();
    if (s.running) return;
    if (clockDirection() === "down" && currentElapsed() >= periodLengthSec()) return;
    s.elapsed = currentElapsed();
    s.running = true;
    s.startedAt = Date.now();
    persistClockMem();
    persistLiveClock();
    startClockTick();
    paintClockFaces();
  }

  function pauseClock() {
    const s = clockPeriodState();
    s.elapsed = currentElapsed();
    s.running = false;
    s.startedAt = null;
    persistClockMem();
    persistLiveClock();
    stopClockTick();
    paintClockFaces();
  }

  function toggleClock() {
    if (clockIsRunning()) pauseClock();
    else startClock();
  }

  function resetClock(period) {
    const s = clockPeriodState(period);
    s.elapsed = 0;
    s.running = false;
    s.startedAt = null;
    persistClockMem();
    persistLiveClock();
    stopClockTick();
    paintClockFaces();
  }

  function setLiveClockDisplay(displaySec) {
    const s = clockPeriodState();
    s.elapsed = displayToElapsed(displaySec, st.period, st.game);
    if (s.running) s.startedAt = Date.now();
    if (clockDirection() === "down" && s.elapsed >= periodLengthSec()) {
      s.elapsed = periodLengthSec();
      s.running = false;
      s.startedAt = null;
    }
    persistClockMem();
    persistLiveClock();
    if (s.running) startClockTick();
    else stopClockTick();
    paintClockFaces();
  }

  function persistLiveClock() {
    const s = clockPeriodState();
    persistGameClockPatch(
      {
        clock_period: normalizePeriod(st.period),
        clock_elapsed_sec: Math.max(0, Math.floor(Number(s.elapsed) || 0)),
        clock_running: !!s.running,
        clock_started_at: s.running && s.startedAt ? new Date(s.startedAt).toISOString() : null,
      },
      { silent: true }
    );
  }

  function hasRemoteClock(game) {
    return game != null && (game.clock_elapsed_sec != null || game.clock_started_at);
  }

  function applyRemoteClock(game) {
    if (!hasRemoteClock(game) || !st.gameId) return;
    const period = normalizePeriod(game.clock_period || st.period);
    if (game.clock_period) st.period = period;
    ensureClockMem();
    const elapsed = Number(game.clock_elapsed_sec);
    const startedAt = game.clock_started_at ? Date.parse(game.clock_started_at) : NaN;
    clockMem.periods[period] = {
      elapsed: Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0,
      running: !!game.clock_running,
      startedAt: game.clock_running && Number.isFinite(startedAt) ? startedAt : null,
    };
    persistClockMem();
    if (clockIsRunning()) startClockTick();
    else stopClockTick();
  }

  async function persistGameClockPatch(patch, opts = {}) {
    if (!st.gameId) return;
    st.game = Object.assign({}, st.game, patch);
    try {
      const saved = await API.updateGame(st.gameId, patch);
      if (saved) st.game = saved;
    } catch (err) {
      if (opts.silent) return;
      const msg = err && err.message ? String(err.message) : "";
      if (/clock_direction|clock_half_length|clock_et_length|clock_period|clock_elapsed|clock_running|clock_started|schema cache|column/i.test(msg)) {
        showToast("Clock saved on this device — push the database migration to share it");
      } else {
        showToast(msg || "Could not save clock setting");
      }
    }
  }

  async function ensureGameClockDefaults() {
    if (!st.game) return;
    const patch = {};
    if (st.game.clock_direction !== "up" && st.game.clock_direction !== "down") patch.clock_direction = "down";
    const half = Number(st.game.clock_half_length_sec);
    const et = Number(st.game.clock_et_length_sec);
    if (!Number.isFinite(half) || half <= 0) patch.clock_half_length_sec = DEFAULT_HALF_SEC;
    if (!Number.isFinite(et) || et <= 0) patch.clock_et_length_sec = DEFAULT_ET_SEC;
    if (!Object.keys(patch).length) return;
    await persistGameClockPatch(patch);
  }

  function miniScoreboardIconMarkup(score, face) {
    return `
      <svg class="scoreboard-mini-svg" viewBox="0 0 52 32" aria-hidden="true">
        <rect x="0.75" y="0.75" width="50.5" height="30.5" rx="5" fill="#0b1f33" stroke="rgba(255,255,255,0.5)" stroke-width="1.5"/>
        <text x="8" y="21" fill="#f15a24" font-size="13" font-weight="800" font-family="system-ui,sans-serif">${score.us}</text>
        <text x="26" y="14" fill="#f4f7fb" font-size="6.5" font-weight="700" text-anchor="middle" font-family="system-ui,sans-serif">${escapeHtml(face)}</text>
        <text x="44" y="21" fill="#f4f7fb" font-size="13" font-weight="800" text-anchor="end" font-family="system-ui,sans-serif">${score.opp}</text>
      </svg>`;
  }

  function scoreboardBoardMarkup(size) {
    const large = size === "large";
    const score = gameScore(st.shots);
    const opp = opponentOf(st.game)?.name || "Opponent";
    const face = formatClockSecs(displayClockSeconds());
    const running = clockIsRunning();
    const clockBlock = large
      ? `<button type="button" class="scoreboard-clock-face" data-clock-face data-scoreboard-sync aria-label="Refresh scoreboard">${escapeHtml(face)}</button>`
      : `<button type="button" class="score-clock-face" data-clock-face data-open-clock-setup aria-label="Set game clock">${escapeHtml(face)}</button>`;
    const periodBlock = large
      ? `<button type="button" class="scoreboard-period" data-open-clock-setup aria-label="Set period and clock">${escapeHtml(periodLabel(st.period))}</button>`
      : "";
    const pollLine = large
      ? `<div class="scoreboard-poll-line" data-scoreboard-poll-line aria-hidden="true"><span class="scoreboard-poll-line-fill"></span></div>`
      : "";
    const board = `
      <div class="${large ? "scoreboard-board" : "score-strip"}">
        <div class="${large ? "scoreboard-team is-us" : "score-strip-team is-us"}">
          <span class="score-name">${escapeHtml(ourTeamName())}</span>
          <span class="score-num">${score.us}</span>
        </div>
        <div class="${large ? "scoreboard-mid" : "score-strip-mid"}">
          ${
            large
              ? `<div class="scoreboard-clock-stack">
          ${pollLine}
          ${clockBlock}
        </div>`
              : clockBlock
          }
          ${periodBlock}
        </div>
        <div class="${large ? "scoreboard-team is-opp" : "score-strip-team is-opp"}">
          <span class="score-num">${score.opp}</span>
          <span class="score-name">${escapeHtml(opp)}</span>
        </div>
        ${
          large
            ? ""
            : `<div class="score-strip-controls">
          <div class="score-strip-menu">
            <button type="button" class="score-strip-gear" data-score-strip-menu aria-label="Pitch settings" aria-expanded="false" aria-haspopup="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>
            <div class="score-strip-menu-pop" id="score-strip-menu-pop" hidden role="menu">
              <button type="button" class="score-strip-menu-item" role="menuitem" data-tracker-action="sync" ${st.syncing ? "disabled" : ""}>${st.syncing ? "Syncing…" : "Sync"}</button>
              <button type="button" class="score-strip-menu-item" role="menuitem" data-tracker-action="swap">Switch Sides</button>
              <button type="button" class="score-strip-menu-item" role="menuitem" data-tracker-action="csv" ${(st.shots || []).length ? "" : "disabled"}>CSV</button>
              <button type="button" class="score-strip-menu-item" role="menuitem" data-tracker-action="zones">${st.showGrid ? "Hide zones" : "Zones"}</button>
            </div>
          </div>
          <button type="button" class="btn score-strip-btn" data-clock-toggle>${running ? "Stop" : "Start"}</button>
          <button type="button" class="btn score-strip-btn" data-open-clock-setup>${escapeHtml(periodLabel(st.period))}</button>
          <a class="score-strip-goto" href="#shots-scoreboard" aria-label="Open scoreboard">${miniScoreboardIconMarkup(score, face)}</a>
        </div>`
        }
      </div>`;
    return large ? board : `<div class="score-strip-block">${board}</div>`;
  }

  function stampOffsetMarkup() {
    return `
      <section class="stamp-offset-card">
        <h2>Game clock</h2>
        <p class="muted">New plays are stamped this many seconds before the current clock, so you can catch up after you see the play.</p>
        <label class="shots-field">Stamp offset (seconds)
          <input type="number" id="stamp-offset" min="0" max="120" step="1" value="${st.stampOffset}" />
        </label>
      </section>`;
  }

  function clockSetupDraftPeriod() {
    return normalizePeriod($("#clock-setup-modal [data-clock-setup-period].is-on")?.getAttribute("data-clock-setup-period") || st.period);
  }

  function clockSetupDraftDir() {
    return $("#clock-setup-modal [data-clock-setup-dir].is-on")?.getAttribute("data-clock-setup-dir") === "up" ? "up" : "down";
  }

  function refreshClockSetupTime() {
    const input = $("#clock-setup-time");
    if (!input) return;
    const period = clockSetupDraftPeriod();
    const dir = clockSetupDraftDir();
    const elapsed = currentElapsed(period);
    const display = dir === "down" ? Math.max(0, periodLengthSec(period) - elapsed) : elapsed;
    input.value = formatClockSecs(display);
  }

  function openClockSetup() {
    const modal = $("#clock-setup-modal");
    if (!modal) return;
    $$("#clock-setup-modal [data-clock-setup-period]").forEach((btn) => {
      btn.classList.toggle("is-on", normalizePeriod(btn.getAttribute("data-clock-setup-period")) === st.period);
    });
    $$("#clock-setup-modal [data-clock-setup-dir]").forEach((btn) => {
      btn.classList.toggle("is-on", btn.getAttribute("data-clock-setup-dir") === clockDirection());
    });
    refreshClockSetupTime();
    modal.hidden = false;
    requestAnimationFrame(() => $("#clock-setup-time")?.select());
  }

  function closeClockSetup() {
    const modal = $("#clock-setup-modal");
    if (modal) modal.hidden = true;
  }

  async function applyClockSetup() {
    const period = clockSetupDraftPeriod();
    const dir = clockSetupDraftDir();
    const sec = parseClockInput($("#clock-setup-time")?.value);
    if (sec == null) {
      showToast("Try 40, 38.5, or 38:50");
      return;
    }
    if (period !== st.period) {
      st.period = period;
      saveUi();
      resetTrackerDraft();
      closeShotModal();
    }
    if (dir !== clockDirection()) {
      await persistGameClockPatch({ clock_direction: dir });
    }
    setLiveClockDisplay(sec);
    closeClockSetup();
    draw({ keepScroll: true });
  }

  let clockSetupBound = false;
  function bindClockSetupModal() {
    if (clockSetupBound) return;
    const modal = $("#clock-setup-modal");
    if (!modal) return;
    clockSetupBound = true;
    modal.addEventListener("click", (e) => {
      if (e.target.closest("[data-close-clock-setup]")) {
        closeClockSetup();
        return;
      }
      const periodBtn = e.target.closest("[data-clock-setup-period]");
      if (periodBtn) {
        $$("#clock-setup-modal [data-clock-setup-period]").forEach((b) => b.classList.remove("is-on"));
        periodBtn.classList.add("is-on");
        refreshClockSetupTime();
        return;
      }
      const dirBtn = e.target.closest("[data-clock-setup-dir]");
      if (dirBtn) {
        $$("#clock-setup-modal [data-clock-setup-dir]").forEach((b) => b.classList.remove("is-on"));
        dirBtn.classList.add("is-on");
        refreshClockSetupTime();
        return;
      }
      if (e.target.closest("[data-clock-setup-reset]")) {
        resetClock(clockSetupDraftPeriod());
        refreshClockSetupTime();
      }
    });
    $("#clock-setup-save")?.addEventListener("click", () => applyClockSetup());
    $("#clock-setup-time")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        applyClockSetup();
      }
    });
  }

  function bindClockUi() {
    bindClockSetupModal();
    $$("[data-clock-toggle]").forEach((btn) => {
      btn.addEventListener("click", () => toggleClock());
    });
    $$("[data-open-clock-setup]").forEach((btn) => {
      btn.addEventListener("click", () => openClockSetup());
    });
    $("#stamp-offset")?.addEventListener("input", (e) => {
      if (e.target.value === "") return;
      const n = Number(e.target.value);
      if (!Number.isFinite(n) || n < 0) e.target.value = "0";
    });
    $("#stamp-offset")?.addEventListener("change", (e) => {
      saveStampOffset(e.target.value);
      e.target.value = String(st.stampOffset);
    });
    if (clockIsRunning()) startClockTick();
    else paintClockFaces();
  }

  function brighton() {
    return st.teams.find((t) => t.is_brighton) || null;
  }

  function teamById(id) {
    return st.teams.find((t) => t.id === id) || null;
  }

  function ourTeamOf(game) {
    const g = game || st.game;
    if (!g) return brighton();
    return g.our_team || teamById(g.our_team_id) || brighton();
  }

  function ourTeamName(game) {
    return ourTeamOf(game)?.name || "Us";
  }

  function opponentOf(game) {
    if (!game) return null;
    const usId = game.our_team_id || ourTeamOf(game)?.id;
    if (usId && game.home_team_id === usId) return game.away_team || teamById(game.away_team_id);
    if (usId && game.away_team_id === usId) return game.home_team || teamById(game.home_team_id);
    const b = brighton();
    if (b && game.home_team_id === b.id) return game.away_team || teamById(game.away_team_id);
    if (b && game.away_team_id === b.id) return game.home_team || teamById(game.home_team_id);
    return game.away_team || teamById(game.away_team_id);
  }

  function slugify(name) {
    return String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
  }

  function parseLocationHash() {
    const raw = (location.hash || "").replace(/^#/, "");
    const path = raw.split("?")[0] || "shots";
    const qs = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : "";
    return { path, params: new URLSearchParams(qs) };
  }

  function gamePool() {
    return st.allGames && st.allGames.length ? st.allGames : st.games || [];
  }

  function rememberGame(game) {
    if (!game || !game.id) return;
    if (!st.allGames) st.allGames = [];
    if (!st.allGames.some((g) => g.id === game.id)) st.allGames.unshift(game);
    if (!st.games.some((g) => g.id === game.id)) st.games.unshift(game);
  }

  function shareTeamRef(team) {
    if (!team) return "";
    const slug = slugify(team.name);
    if (!slug) return team.id;
    const hits = (st.teams || []).filter((t) => slugify(t.name) === slug);
    return hits.length <= 1 ? slug : team.id;
  }

  function findTeamByRef(ref) {
    if (!ref) return null;
    const teams = st.teams || [];
    const byId = teams.find((t) => t.id === ref);
    if (byId) return byId;
    const hits = teams.filter((t) => slugify(t.name) === ref);
    if (hits.length === 1) return hits[0];
    return hits.find((t) => !t.is_brighton) || hits[0] || null;
  }

  function shareSeasonRef(season) {
    if (!season) return "";
    if (season.id === "__last3") return "last3";
    const slug = slugify(season.label) || String(season.year || "");
    if (!slug) return season.id;
    const hits = (st.seasons || []).filter((s) => slugify(s.label) === slug || String(s.year) === slug);
    return hits.length <= 1 ? slug : season.id;
  }

  function findSeasonByRef(ref) {
    if (!ref) return null;
    if (ref === "last3" || ref === "__last3") return { id: "__last3", label: "Last 3 years" };
    const seasons = st.seasons || [];
    const byId = seasons.find((s) => s.id === ref);
    if (byId) return byId;
    const bySlug = seasons.filter((s) => slugify(s.label) === ref);
    if (bySlug.length === 1) return bySlug[0];
    const byYear = seasons.filter((s) => String(s.year) === ref);
    if (byYear.length === 1) return byYear[0];
    return null;
  }

  function sharePlayerRef(player) {
    if (!player) return "";
    const slug = slugify(player.short_name || firstName(player.name) || player.name);
    if (!slug) return player.id;
    const hits = (st.namedPlayers || []).filter(
      (p) => slugify(p.short_name || firstName(p.name) || p.name) === slug
    );
    return hits.length <= 1 ? slug : player.id;
  }

  function findPlayerByRef(ref) {
    if (!ref) return null;
    const players = st.namedPlayers || [];
    const byId = players.find((p) => p.id === ref);
    if (byId) return byId;
    const hits = players.filter((p) => slugify(p.short_name || firstName(p.name) || p.name) === ref);
    return hits.length === 1 ? hits[0] : hits[0] || null;
  }

  function shareGameRef(game) {
    if (!game) return "";
    const date = String(game.date || "").slice(0, 10);
    if (!date) return game.id;
    const same = gamePool().filter((g) => String(g.date || "").slice(0, 10) === date);
    return same.length <= 1 ? date : game.id;
  }

  function findGameByRef(ref, opts = {}) {
    if (!ref) return null;
    const games = gamePool();
    const byId = games.find((g) => g.id === ref);
    if (byId) return byId;
    const dated = games.filter((g) => String(g.date || "").slice(0, 10) === ref);
    if (dated.length === 1) return dated[0];
    if (opts.opponentId) {
      const match = dated.find((g) => opponentOf(g)?.id === opts.opponentId);
      if (match) return match;
    }
    return dated[0] || null;
  }

  async function resolveGameRef(ref, opts = {}) {
    const hit = findGameByRef(ref, opts);
    if (hit) return hit;
    if (!ref) return null;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) {
      try {
        const g = await API.game(ref);
        rememberGame(g);
        return g;
      } catch {
        return null;
      }
    }
    if (!st.allGames.length) {
      try {
        st.allGames = await API.games();
      } catch {
        return null;
      }
    }
    return findGameByRef(ref, opts);
  }

  function compactParams(params) {
    const next = new URLSearchParams();
    params.forEach((value, key) => {
      if (value) next.set(key, value);
    });
    return next;
  }

  function hashFromState() {
    const view = st.view;
    if (view === "shots-games") return "shots-games";
    if (view === "shots-history") {
      const p = new URLSearchParams();
      const season = st.history.seasonId === "__last3" ? { id: "__last3" } : st.seasons.find((s) => s.id === st.history.seasonId);
      if (season) p.set("season", shareSeasonRef(season));
      const player = st.namedPlayers.find((x) => x.id === st.history.playerId);
      if (player) p.set("player", sharePlayerRef(player));
      const opp = teamById(st.history.opponentId);
      if (opp) p.set("opp", shareTeamRef(opp));
      if (st.history.depth) p.set("depth", st.history.depth);
      const qs = compactParams(p).toString();
      return qs ? `shots-history?${qs}` : "shots-history";
    }
    if (view === "shots-prep") {
      const p = new URLSearchParams();
      if (st.prep.tab === "explore") {
        p.set("tab", "explore");
        const asked = [...(st.explore.messages || [])].reverse().find((m) => m.role === "user");
        if (asked) p.set("q", asked.content);
        const qs = compactParams(p).toString();
        return `shots-prep?${qs}`;
      }
      if (st.prep.lockedGameId) {
        const g = gamePool().find((x) => x.id === st.prep.lockedGameId);
        p.set("game", g ? shareGameRef(g) : st.prep.lockedGameId);
      } else {
        const opp = teamById(st.prep.opponentId);
        if (opp) p.set("opp", shareTeamRef(opp));
        const season = st.seasons.find((s) => s.id === st.prep.seasonId);
        if (season) p.set("season", shareSeasonRef(season));
        if (st.prep.includeFriendly) p.set("friendly", "1");
        const selected = prepSelectedIds();
        const candidates = prepCandidateGames();
        if (selected.length && candidates.length && selected.length !== candidates.length) {
          p.set(
            "games",
            selected
              .map((id) => {
                const g = gamePool().find((x) => x.id === id);
                return g ? shareGameRef(g) : id;
              })
              .join(",")
          );
        }
        if (st.prep.teamFilter && st.prep.teamFilter !== "both") p.set("team", st.prep.teamFilter);
        if (st.prep.resultFilter && st.prep.resultFilter !== "all") p.set("result", st.prep.resultFilter);
        if (st.prep.periodFilter && st.prep.periodFilter !== "all") p.set("period", st.prep.periodFilter);
      }
      const qs = compactParams(p).toString();
      return qs ? `shots-prep?${qs}` : "shots-prep";
    }
    if (view === "shots" || view === "shots-map" || view === "shots-scoreboard") {
      const p = new URLSearchParams();
      const g = st.game || gamePool().find((x) => x.id === st.gameId);
      if (g) p.set("game", shareGameRef(g));
      else if (st.gameId) p.set("game", st.gameId);
      const qs = compactParams(p).toString();
      const path = view === "shots" ? "shots" : view;
      return qs ? `${path}?${qs}` : path;
    }
    return view || "shots";
  }

  function syncHashFromState() {
    if (applyingHash || !st.session || !st.booted) return;
    const next = hashFromState();
    const cur = (location.hash || "").replace(/^#/, "");
    if (cur === next) return;
    history.replaceState(null, "", `${location.pathname}${location.search}#${next}`);
  }

  let applyingHash = false;
  let hashExploreQ = "";

  function hrefForView(view, extra) {
    const prevView = st.view;
    const prevTab = st.prep.tab;
    st.view = view;
    if (extra && extra.tab) st.prep.tab = extra.tab;
    const hash = hashFromState();
    st.view = prevView;
    st.prep.tab = prevTab;
    return `#${hash}`;
  }

  async function consumeShareHash() {
    if (!st.session || applyingHash) return "skip";
    const { path, params } = parseLocationHash();
    applyingHash = true;
    let gameChanged = false;
    let runHistory = false;
    let runQ = "";
    try {
      if (path === "shots" || path === "shots-map" || path === "shots-scoreboard") {
        const ref = params.get("game");
        if (ref) {
          const g = await resolveGameRef(ref);
          if (g && g.id !== st.gameId) {
            st.gameId = g.id;
            if (g.season_id) st.seasonId = g.season_id;
            gameChanged = true;
          }
        }
      }
      if (path === "shots-prep" || path === "shots-explore") {
        const tab = params.get("tab") === "explore" || path === "shots-explore" ? "explore" : "opponent";
        st.prep.tab = tab;
        const gameRefParam = params.get("game") || "";
        if (gameRefParam && tab !== "explore") {
          const g = await resolveGameRef(gameRefParam);
          if (g) {
            const was = st.prep.lockedGameId;
            st.prep.lockedGameId = g.id;
            st.prep.selectedGameIds = [g.id];
            st.prep.includeFriendly = true;
            const opp = opponentOf(g);
            if (opp) st.prep.opponentId = opp.id;
            if (g.season_id) st.prep.seasonId = g.season_id;
            if (was !== g.id) {
              st.prep.loadKey = "";
              st.prep.gemini = emptyPrepGemini();
              st.prep.rows = null;
            }
            rememberGame(g);
          }
        } else if (!gameRefParam && st.prep.lockedGameId && tab !== "explore") {
          st.prep.lockedGameId = "";
          st.prep.loadKey = "";
          st.prep.gemini = emptyPrepGemini();
        }
        if (tab !== "explore" && !gameRefParam) {
          const opp = findTeamByRef(params.get("opp") || "");
          if (params.has("opp")) st.prep.opponentId = opp ? opp.id : "";
          const season = findSeasonByRef(params.get("season") || "");
          if (params.has("season")) st.prep.seasonId = season && season.id !== "__last3" ? season.id : "";
          else if (!st.prep.seasonId && st.seasonId) st.prep.seasonId = st.seasonId;
          if (params.has("friendly")) st.prep.includeFriendly = params.get("friendly") === "1";
          const team = params.get("team") || "both";
          if (team === "us" || team === "opp" || team === "both") st.prep.teamFilter = team;
          const result = params.get("result") || "all";
          if (result === "all" || result === "goals" || result === "on-frame") st.prep.resultFilter = result;
          const period = params.get("period") || "all";
          if (period === "all" || period === "1" || period === "2" || period === "ET1" || period === "ET2") {
            st.prep.periodFilter = period;
          }
          if (params.get("games")) {
            const ids = [];
            for (const part of String(params.get("games") || "").split(",")) {
              const g = await resolveGameRef(part.trim(), { opponentId: st.prep.opponentId });
              if (g) ids.push(g.id);
            }
            if (ids.length) st.prep.selectedGameIds = ids;
          } else if (st.prep.opponentId && !st.prep.selectedGameIds.length) {
            fillPrepSelectionFromCandidates();
          }
        }
        if (tab === "explore") {
          const q = String(params.get("q") || "").trim();
          if (q && hashExploreQ !== q && !st.explore.messages.some((m) => m.role === "user" && m.content === q)) {
            runQ = q;
            hashExploreQ = q;
          }
        }
      }
      if (path === "shots-history") {
        const season = findSeasonByRef(params.get("season") || "");
        if (params.has("season")) st.history.seasonId = season ? season.id : "";
        const player = findPlayerByRef(params.get("player") || "");
        if (params.has("player")) st.history.playerId = player ? player.id : "";
        const opp = findTeamByRef(params.get("opp") || "");
        if (params.has("opp")) st.history.opponentId = opp ? opp.id : "";
        if (params.has("depth")) st.history.depth = params.get("depth") || "";
        runHistory = !!(st.history.seasonId || st.history.playerId || st.history.opponentId || st.history.depth);
      }
    } finally {
      applyingHash = false;
    }
    if (gameChanged) {
      st.loading = true;
      draw();
      try {
        await loadGameContext();
        st.error = "";
      } catch (err) {
        st.error = err.message || "Could not open game";
      }
      st.loading = false;
      draw();
      return "drew";
    }
    if (runQ) {
      await runExplore(runQ);
      return "drew";
    }
    if (runHistory && !st.history.rows && !st.history.loading) {
      await runHistoryQuery();
      return "drew";
    }
    return "need-draw";
  }

  function recordingTeam() {
    return st.team === "opp" ? "opp" : "us";
  }

  function teamIdFor(team) {
    const b = brighton();
    if (team === "us") return b ? b.id : st.game?.our_team_id;
    const opp = opponentOf(st.game);
    return opp ? opp.id : null;
  }

  function teamIdForEvent(team, ev) {
    const key = team === "opp" ? "opp" : "us";
    const b = brighton();
    if (key === "us") return b ? b.id : ev?.game?.our_team_id || st.game?.our_team_id || null;
    const game = ev?.game || st.game;
    if (game && b) {
      if (game.home_team_id === b.id) return game.away_team_id;
      if (game.away_team_id === b.id) return game.home_team_id;
    }
    return teamIdFor("opp");
  }

  function recordingTeamId() {
    return teamIdFor(recordingTeam());
  }

  function teamLabel(team, ev) {
    if (team === "opp") {
      if (ev?.opponentName) return ev.opponentName;
      const opp = opponentOf(st.game);
      return opp ? opp.name : "Opponent";
    }
    return ourTeamName(ev?.game || st.game);
  }

  function eventTeam(ev) {
    return ev && ev.team === "opp" ? "opp" : "us";
  }

  function lineupHasXi(team = "us") {
    return onFieldPlayers(team).length > 0;
  }

  function slotPlayer(team, slotId) {
    const bag = team === "opp" ? st.lineup.opp : st.lineup.us;
    return (bag && bag[String(slotId)]) || null;
  }

  function onFieldPlayers(team) {
    return POSITION_SLOTS.map((slot) => {
      const p = slotPlayer(team, slot.id);
      if (!p) return null;
      return Object.assign({ slot: slot.id, slotCode: slot.code, team }, p);
    }).filter(Boolean);
  }

  function formationPitchShell(cardsHtml, extrasHtml = "", opts = {}) {
    const team = opts.team === "opp" ? "opp" : "us";
    return `
      <div class="formation-pitch ${team === "opp" ? "is-opp-pitch" : "is-us-pitch"}" role="group" aria-label="4-3-3 formation">
        <div class="formation-pitch-lines" aria-hidden="true">
          <span class="fp-outline"></span>
          <span class="fp-halfway"></span>
          <span class="fp-circle"></span>
          <span class="fp-box fp-box-att"></span>
          <span class="fp-six fp-six-att"></span>
          <span class="fp-box fp-box-def"></span>
          <span class="fp-six fp-six-def"></span>
        </div>
        ${cardsHtml}
      </div>
      ${extrasHtml || ""}`;
  }

  function formationCardStyle(layout) {
    return `left:${layout.x}%;top:${layout.y}%`;
  }

  function formationMeta(slotCode, player) {
    if (player && player.number != null && player.number !== "") {
      return `${escapeHtml(String(player.number))} · ${escapeHtml(slotCode)}`;
    }
    return escapeHtml(slotCode);
  }

  function usedLineupNumbers(team, exceptSlot) {
    const used = new Set();
    POSITION_SLOTS.forEach((slot) => {
      if (exceptSlot && slot.id === exceptSlot) return;
      const p = slotPlayer(team, slot.id);
      if (p) used.add(String(p.number));
    });
    return used;
  }

  function assignSlot(team, slotId, player) {
    if (team === "opp") return;
    const key = "us";
    if (!st.lineup[key] || typeof st.lineup[key] !== "object") st.lineup[key] = {};
    if (!player) delete st.lineup[key][String(slotId)];
    else st.lineup[key][String(slotId)] = player;
    saveLineupBag();
  }

  /** Ephemeral lineup editor gestures (not persisted). */
  let lineupGesture = null;

  function clearLineupGesture() {
    lineupGesture = null;
  }

  function lineupPlayerPayload(player) {
    if (!player) return null;
    return {
      id: player.id || "",
      number: String(player.number ?? player.jersey_number ?? ""),
      name: player.name || "",
      short: player.short || player.short_name || "",
    };
  }

  function slotIdForNumber(team, number) {
    const want = String(number);
    for (const slot of POSITION_SLOTS) {
      const p = slotPlayer(team, slot.id);
      if (p && String(p.number) === want) return slot.id;
    }
    return null;
  }

  function slotCodeForId(slotId) {
    return POSITION_SLOTS.find((s) => s.id === Number(slotId))?.code || "";
  }

  function copyLineupBag(team) {
    const key = team === "opp" ? "opp" : "us";
    const bag = st.lineup[key] || {};
    const copy = {};
    Object.keys(bag).forEach((k) => {
      copy[k] = Object.assign({}, bag[k]);
    });
    return copy;
  }

  function restoreLineupBag(team, bag) {
    const key = team === "opp" ? "opp" : "us";
    st.lineup[key] = {};
    Object.keys(bag || {}).forEach((k) => {
      st.lineup[key][k] = Object.assign({}, bag[k]);
    });
    saveLineupBag();
  }

  function swapSlots(team, slotA, slotB) {
    if (Number(slotA) === Number(slotB) || team === "opp") return;
    const a = lineupPlayerPayload(slotPlayer(team, slotA));
    const b = lineupPlayerPayload(slotPlayer(team, slotB));
    assignSlot(team, slotA, b);
    assignSlot(team, slotB, a);
  }

  /** Put this player into the shot's position on the live lineup (moves them if needed). */
  function assignPlayerToShotPosition(team, player, positionCode = shotModalDraft.position) {
    if (team === "opp") return false;
    if (!player || !positionCode) return false;
    const slot = POSITION_SLOTS.find((s) => s.code === positionCode);
    if (!slot) return false;
    const payload = lineupPlayerPayload(player);
    if (!payload?.number) return false;
    const elsewhere = slotIdForNumber(team, payload.number);
    if (elsewhere && Number(elsewhere) !== Number(slot.id)) {
      assignSlot(team, elsewhere, null);
    }
    const current = slotPlayer(team, slot.id);
    if (current && String(current.number) === String(payload.number)) return true;
    assignSlot(team, slot.id, payload);
    return true;
  }

  function cancelLineupGesture() {
    clearLineupGesture();
  }

  function startSwapGesture(team, slotId) {
    if (team === "opp") return;
    const filled = slotPlayer("us", slotId);
    if (!filled) return;
    lineupGesture = { mode: "swap", fromSlot: Number(slotId), team: "us" };
  }

  function completeSwapGesture(toSlotId) {
    if (!lineupGesture || lineupGesture.mode !== "swap") return false;
    const team = lineupGesture.team === "opp" ? "opp" : "us";
    const from = Number(lineupGesture.fromSlot);
    const to = Number(toSlotId);
    if (!to || from === to) {
      clearLineupGesture();
      return true;
    }
    const other = slotPlayer(team, to);
    if (!other) {
      showToast("Pick a player on the field to swap with");
      return false;
    }
    swapSlots(team, from, to);
    const a = slotCodeForId(from);
    const b = slotCodeForId(to);
    clearLineupGesture();
    showToast(`Swapped ${a} ↔ ${b}`);
    return true;
  }

  function defaultLineupCount() {
    return Object.keys(st.defaultLineup.us || {}).length;
  }

  function saveCurrentAsDefault() {
    const copy = {};
    Object.keys(st.lineup.us || {}).forEach((k) => {
      copy[k] = Object.assign({}, st.lineup.us[k]);
    });
    st.defaultLineup = { us: copy };
    saveDefaultLineupBag(copy);
    showToast("Default starting lineup saved");
  }

  function restoreDefaultLineup() {
    let bag = st.defaultLineup.us || {};
    if (!Object.keys(bag).length) {
      bag = buildDefaultXiFromRoster();
      if (Object.keys(bag).length < 11) {
        showToast("No default lineup saved yet");
        return;
      }
      st.defaultLineup = { us: Object.assign({}, bag) };
      saveDefaultLineupBag(bag);
    }
    st.lineup.us = {};
    Object.keys(bag).forEach((k) => {
      st.lineup.us[k] = Object.assign({}, bag[k]);
    });
    saveLineupBag();
    showToast("Restored default starting lineup");
    draw({ keepScroll: true });
  }

  function playerWhoLabel(action) {
    if (!action) return "Who?";
    if (action.result === "foul") return "Who took the free kick?";
    if (action.result === "corner") return "Who took the corner?";
    if (action.result === "pk-goal" || action.result === "pk-missed") return "Who took the PK?";
    if (action.kind === "assist") return "Who passed?";
    return "Who shot?";
  }

  function needsMissDirection(action) {
    const result = action?.result === "foul" || action?.result === "corner" ? shotModalDraft.fkOutcome || "" : action?.result;
    return !!(result && RESULTS_NEEDING_MISS_DIR.has(result));
  }

  function needsFoulerStep(action) {
    return !!(action && (action.result === "foul" || RESULTS_NEEDING_FOULER.has(action.result)));
  }

  function canChainAssist() {
    return !!(st.pending?.assist && !st.pending?.secondAssist);
  }

  function awaitingFollowUp() {
    return st.mode === "awaiting-shot-location";
  }

  function draftAssistFromModal(player) {
    return {
      player,
      type: shotModalDraft.action?.type,
      location: shotModalDraft.location,
      position: shotModalDraft.position || "",
    };
  }

  function linkedPlayFields(play, prefix) {
    if (!play) {
      return {
        [`${prefix}_player_id`]: null,
        [`${prefix}_type`]: null,
        [`${prefix}_position`]: null,
        [`${prefix}_x`]: null,
        [`${prefix}_y`]: null,
        [`${prefix}_zone_id`]: null,
        [`${prefix}_zone_label`]: null,
      };
    }
    const loc = play.location || play;
    return {
      [`${prefix}_player_id`]: play.player?.id || play.player_id || null,
      [`${prefix}_type`]: play.type || null,
      [`${prefix}_position`]: play.position || null,
      [`${prefix}_x`]: loc.x,
      [`${prefix}_y`]: loc.y,
      [`${prefix}_zone_id`]: loc.zoneId || loc.zone_id || null,
      [`${prefix}_zone_label`]: loc.zoneLabel || loc.zone_label || null,
    };
  }

  function mapLinkedPlay(row, prefix, playerJoin, roster) {
    const type = row[`${prefix}_type`];
    if (!type) return null;
    const playerId = row[`${prefix}_player_id`];
    const jersey = playerId ? roster.find((r) => r.player_id === playerId)?.jersey_number || "" : "";
    return {
      player_id: playerId || null,
      number: jersey,
      name: playerJoin?.name || "",
      short: playerJoin?.short_name || "",
      type,
      position: normalizePositionCode(row[`${prefix}_position`] || ""),
      x: Number(row[`${prefix}_x`]),
      y: Number(row[`${prefix}_y`]),
      zoneId: row[`${prefix}_zone_id`],
      zoneLabel: row[`${prefix}_zone_label`],
    };
  }

  function effectiveShotResult() {
    const origin = shotModalDraft.action?.result;
    if ((origin === "foul" || origin === "corner") && shotModalDraft.fkOutcome) {
      return shotModalDraft.fkOutcome;
    }
    return shotModalDraft.action?.result || "";
  }

  function oppositeTeam(team) {
    return team === "opp" ? "us" : "opp";
  }

  function firstName(full) {
    const raw = String(full || "").trim().split(/\s+/)[0] || "";
    return NICK[raw] || raw;
  }

  function playerDisplayName(p) {
    if (!p) return "";
    if (p.short || p.short_name) return p.short || p.short_name;
    if (p.name) return firstName(p.name);
    const num = p.jersey_number || p.number;
    return num != null && String(num) !== "" ? `#${num}` : "Unknown";
  }

  /** Opponent roster labels: preferred/short name, else A. Last. */
  function opponentShortName(p) {
    if (!p) return "";
    const short = String(p.short || p.short_name || "").trim();
    if (short) return short;
    const full = String(p.name || "").trim();
    if (!full) return "";
    const parts = full.split(/\s+/).filter(Boolean);
    if (!parts.length) return "";
    if (parts.length === 1) return firstName(parts[0]);
    return `${parts[0].charAt(0).toUpperCase()}. ${parts[parts.length - 1]}`;
  }

  function opponentPosHint(p) {
    const groups = Array.isArray(p?.positionGroups) ? p.positionGroups.filter(Boolean) : [];
    return groups.length ? groups.join("/") : "";
  }

  function playerLabel(p) {
    if (!p) return "untagged";
    if (p.team === "opp") {
      const named = opponentShortName(p);
      if (named) return named;
      const num = p.number || p.jersey_number;
      return num != null && String(num) !== "" ? `Opp #${num}` : "untagged";
    }
    return playerDisplayName(p);
  }

  function rosterPlayers(team) {
    const rows = team === "opp" ? st.oppRoster : st.ourRoster;
    return rows.map((r) => {
      const number = String(r.jersey_number || "");
      const fromDb = Array.isArray(r.player?.position_groups) ? r.player.position_groups.filter(Boolean) : [];
      const fromDefaults = DEFAULT_POSITION_GROUPS[number] || [];
      return {
        id: r.player_id || r.player?.id,
        rosterId: r.id,
        number: r.jersey_number,
        jersey_number: r.jersey_number,
        name: r.player?.name || null,
        short: r.player?.short_name || null,
        short_name: r.player?.short_name || null,
        squad: r.squad === "jv" ? "jv" : "varsity",
        positionGroups: fromDb.length ? fromDb.slice() : team === "us" ? fromDefaults.slice() : [],
        team,
      };
    });
  }

  function sortPlayers(list) {
    return list.slice().sort((a, b) => {
      const aJv = a.squad === "jv" ? 1 : 0;
      const bJv = b.squad === "jv" ? 1 : 0;
      if (aJv !== bJv) return aJv - bJv;
      const aNamed = !!(a.name || a.short || a.short_name);
      const bNamed = !!(b.name || b.short || b.short_name);
      if (aNamed !== bNamed) return aNamed ? -1 : 1;
      const byName = playerDisplayName(a).localeCompare(playerDisplayName(b), undefined, { sensitivity: "base" });
      if (byName) return byName;
      return String(a.number || "").localeCompare(String(b.number || ""), undefined, { numeric: true });
    });
  }

  function normalizePositionCode(code) {
    if (code === "CM") return "RM";
    if (code === "AM") return "LM";
    return code || "";
  }

  function playerInGroup(p, groupId) {
    if (!groupId || !p) return false;
    return (p.positionGroups || []).includes(groupId);
  }

  function groupForSlot(slotId) {
    const slot = POSITION_SLOTS.find((s) => s.id === Number(slotId));
    return slot?.group || GROUP_FOR_CODE[slot?.code] || "";
  }

  function buildDefaultXiFromRoster() {
    const bag = {};
    DEFAULT_XI_JERSEYS.forEach((row) => {
      const p = rosterPlayers("us").find((x) => String(x.number) === String(row.number));
      if (!p) return;
      bag[String(row.slot)] = {
        id: p.id || "",
        number: String(p.number),
        name: p.name || "",
        short: p.short || p.short_name || "",
      };
    });
    return bag;
  }

  function seedDefaultLineupIfEmpty() {
    if (Object.keys(st.defaultLineup.us || {}).length) return;
    if (!st.ourRoster.length) return;
    const bag = buildDefaultXiFromRoster();
    if (Object.keys(bag).length < 11) return;
    st.defaultLineup = { us: bag };
    saveDefaultLineupBag(bag);
    if (!Object.keys(st.lineup.us || {}).length) {
      st.lineup.us = Object.assign({}, bag);
      saveLineupBag();
    }
  }

  function jerseyChoices() {
    return ["00", "0"].concat(Array.from({ length: 99 }, (_, i) => String(i + 1)));
  }

  function localEvents() {
    try {
      const parsed = JSON.parse(localStorage.getItem(LS_EVENTS) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function localUiV1() {
    try {
      return JSON.parse(localStorage.getItem(LS_UI_V1) || "{}") || {};
    } catch {
      return {};
    }
  }

  function mapShot(row) {
    if (row._view) return row;
    const b = brighton();
    const team = b && row.team_id === b.id ? "us" : "opp";
    const roster = team === "us" ? st.ourRoster : st.oppRoster;
    return {
      id: row.id,
      createdAt: row.created_at,
      period: normalizePeriod(row.period),
      team,
      team_id: row.team_id,
      player_id: row.player_id || null,
      shooterNumber: row.jersey_number_at_time || "",
      shooterName: row.player?.name || "",
      shooterShort: row.player?.short_name || "",
      position: normalizePositionCode(row.position || ""),
      result: row.result,
      missDirection: row.miss_direction || "",
      fouler_player_id: row.fouler_player_id || null,
      foulerNumber: row.fouler_jersey_number_at_time || "",
      foulerName: row.fouler?.name || "",
      foulerShort: row.fouler?.short_name || "",
      saveFailed: !!row.saveFailed,
      pendingPayload: row.pendingPayload || null,
      shot: {
        x: Number(row.x),
        y: Number(row.y),
        zoneId: row.zone_id,
        zoneLabel: row.zone_label,
      },
      assist: mapLinkedPlay(row, "assist", row.assist_player, roster),
      secondAssist: mapLinkedPlay(row, "second_assist", row.second_assist_player, roster),
      gameClockSeconds:
        row.game_clock_seconds == null && row.gameClockSeconds == null
          ? null
          : Number(row.gameClockSeconds ?? row.game_clock_seconds),
    };
  }

  async function refreshMeta() {
    st.teams = await API.teams();
    st.seasons = await API.seasons();
    if (!st.seasonId && st.seasons[0]) st.seasonId = st.seasons[0].id;
    st.allGames = await API.games();
    st.games = st.seasonId ? st.allGames.filter((g) => g.season_id === st.seasonId) : st.allGames.slice();
    try {
      st.namedPlayers = await API.namedPlayers();
    } catch {
      st.namedPlayers = [];
    }
  }

  async function loadGameContext() {
    if (!st.gameId) {
      st.game = null;
      st.ourRoster = [];
      st.oppRoster = [];
      st.shots = [];
      return;
    }
    try {
      st.game = await API.game(st.gameId);
    } catch (err) {
      // Stale id after switching DEV/PROD or re-seeding (PGRST116 / missing row).
      const msg = err && err.message ? String(err.message) : "";
      st.gameId = "";
      st.game = null;
      st.ourRoster = [];
      st.oppRoster = [];
      st.shots = [];
      saveUi();
      sessionStorage.removeItem("shots-game-id");
      throw new Error(
        /coerce|multiple \(or no\) rows|PGRST116|permission denied|not found/i.test(msg)
          ? "Previous game is gone (new database or seed). Pick a game from the list."
          : msg || "Could not open game"
      );
    }
    st.seasonId = st.game.season_id;
    const b = brighton();
    const opp = opponentOf(st.game);
    st.ourRoster = b ? await API.roster(b.id, st.game.season_id) : [];
    st.oppRoster = opp ? await API.roster(opp.id, st.game.season_id) : [];
    seedDefaultLineupIfEmpty();
    const rows = await API.shotsForGame(st.gameId);
    st.shots = rows.map(mapShot);
    saveUi();
    await ensureGameClockDefaults();
  }

  async function boot() {
    if (st.booting) return;
    st.booting = true;
    try {
      if (!API || !API.isConfigured()) {
        st.booted = true;
        draw();
        return;
      }
      st.session = await API.getSession();
      if (st.session) {
        st.loading = true;
        draw();
      try {
        await refreshMeta();
        const hashed = await consumeShareHash();
        if (hashed === "drew") {
          st.booted = true;
          return;
        }
        if (st.gameId) await loadGameContext();
      } catch (err) {
        st.error = err.message || "Could not load data";
      }
      st.loading = false;
      }
      st.booted = true;
      draw();
    } finally {
      st.booting = false;
    }
  }

  function trackerNav() {
    return "";
  }

  function closeGameOpenModal() {
    const modal = $("#game-open-modal");
    if (modal) modal.hidden = true;
    st.pendingOpenGameId = "";
  }

  function openGameChooser(id) {
    st.pendingOpenGameId = id;
    const game = st.games.find((g) => g.id === id);
    const modal = $("#game-open-modal");
    const sub = $("#game-open-sub");
    if (sub) sub.textContent = gameTitle(game);
    if (modal) modal.hidden = false;
    bindGameOpenModal();
  }

  let gameOpenModalBound = false;
  function bindGameOpenModal() {
    if (gameOpenModalBound) return;
    const modal = $("#game-open-modal");
    if (!modal) return;
    gameOpenModalBound = true;
    modal.addEventListener("click", (e) => {
      if (e.target.closest("[data-close-game-open]")) {
        closeGameOpenModal();
        return;
      }
      const modeBtn = e.target.closest("[data-open-mode]");
      if (!modeBtn) return;
      const id = st.pendingOpenGameId;
      const mode = modeBtn.getAttribute("data-open-mode");
      if (!id) return;
      selectGame(id, mode === "scoreboard" ? "scoreboard" : "track");
    });
  }

  function runTrackerAction(action) {
    if (action === "sync") syncGameShots();
    else if (action === "swap") {
      st.swapSides = !st.swapSides;
      saveUi();
      draw({ keepScroll: true });
    } else if (action === "zones") {
      st.showGrid = !st.showGrid;
      saveUi();
      draw({ keepScroll: true });
    } else if (action === "csv") {
      exportShotsCsv(st.shots || []);
    }
  }

  let scoreStripMenuDocBound = false;
  function bindScoreStripMenu() {
    const btn = $("[data-score-strip-menu]");
    const pop = $("#score-strip-menu-pop");
    if (!btn || !pop) return;
    const setOpen = (open) => {
      pop.hidden = !open;
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    };
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      setOpen(pop.hidden);
    });
    pop.addEventListener("click", (e) => {
      const item = e.target.closest("[data-tracker-action]");
      if (!item || item.disabled) return;
      e.stopPropagation();
      runTrackerAction(item.getAttribute("data-tracker-action"));
      setOpen(false);
    });
    if (!scoreStripMenuDocBound) {
      scoreStripMenuDocBound = true;
      document.addEventListener("click", (e) => {
        if (e.target.closest(".score-strip-menu")) return;
        const menuBtn = $("[data-score-strip-menu]");
        const menuPop = $("#score-strip-menu-pop");
        if (menuPop) menuPop.hidden = true;
        if (menuBtn) menuBtn.setAttribute("aria-expanded", "false");
      });
    }
  }

  function gameTitle(game) {
    if (!game) return "No game selected";
    const home = game.home_team?.name || "Home";
    const away = game.away_team?.name || "Away";
    const d = game.date ? String(game.date).slice(0, 10) : "";
    return `${d} · ${home} vs ${away}`;
  }

  function renderSetup() {
    root().innerHTML = `
      <div class="shots-gate">
        <h1>Shot tracker setup</h1>
        <p>Create a Supabase project, run <code>supabase/schema.sql</code>, enable Anonymous auth, then put the project URL and anon key in <code>shots-config.js</code>.</p>
        <p class="muted">PIN is the shared staff gate (default KEPPA). It is not per-coach security.</p>
        <a class="btn btn-secondary" href="#home">Back</a>
      </div>`;
  }

  function renderPin() {
    root().innerHTML = `
      <div class="shots-gate">
        <h1>Shot tracker</h1>
        <p>Enter the staff PIN to continue.</p>
        <form id="shots-pin-form" class="shots-pin-form">
          <label class="sr-only" for="shots-pin">PIN</label>
          <input id="shots-pin" class="text-gate-input" type="password" inputmode="text" autocomplete="off" maxlength="16" />
          <button type="submit" class="btn btn-primary">Open tracker</button>
        </form>
        ${st.pinError ? `<p class="shots-error">${escapeHtml(st.pinError)}</p>` : ""}
      </div>`;
    $("#shots-pin-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const value = $("#shots-pin").value;
      st.pinError = "";
      const result = await API.signInWithPin(value);
      if (!result.ok) {
        st.pinError = result.error;
        renderPin();
        return;
      }
      st.session = result.session;
      st.loading = true;
      draw();
      try {
        await refreshMeta();
        const hashed = await consumeShareHash();
        if (hashed === "drew") return;
        if (st.gameId) await loadGameContext();
      } catch (err) {
        st.error = err.message || "Could not load data";
      }
      st.loading = false;
      draw();
    });
    requestAnimationFrame(() => $("#shots-pin")?.focus());
  }

  function renderLoading(msg) {
    root().innerHTML = `<div class="shots-gate"><p>${escapeHtml(msg || "Loading…")}</p></div>`;
  }

  async function selectSeason(id) {
    st.seasonId = id;
    if (st.allGames && st.allGames.length) {
      st.games = id ? st.allGames.filter((g) => g.season_id === id) : st.allGames.slice();
    } else {
      st.games = id ? await API.games(id) : await API.games();
    }
    saveUi();
    draw();
  }

  async function selectGame(id, mode) {
    closeGameOpenModal();
    st.gameId = id;
    st.loading = true;
    draw();
    try {
      await loadGameContext();
      st.error = "";
    } catch (err) {
      st.error = err.message || "Could not open game";
    }
    st.loading = false;
    st.view = mode === "scoreboard" ? "shots-scoreboard" : "shots";
    const hash = hashFromState();
    if (location.hash.replace(/^#/, "") !== hash) location.hash = hash;
    else draw();
  }

  function parseCsvLine(line) {
    const out = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  }

  function parseCsvDate(value) {
    const t = String(value || "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    return t;
  }

  function localYmd(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function addDaysYmd(ymd, delta) {
    const [y, m, d] = String(ymd).slice(0, 10).split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + delta);
    return localYmd(dt);
  }

  function gameDateYmd(g) {
    return String(g?.date || "").slice(0, 10);
  }

  /** Ascending by date, rotated so the first game on/after yesterday leads the list. */
  function gamesForList(gamesList) {
    const yesterday = addDaysYmd(localYmd(), -1);
    const sorted = (gamesList || [])
      .slice()
      .sort((a, b) => gameDateYmd(a).localeCompare(gameDateYmd(b)));
    const start = sorted.findIndex((g) => gameDateYmd(g) >= yesterday);
    if (start <= 0) return sorted;
    return sorted.slice(start).concat(sorted.slice(0, start));
  }

  function parseScheduleCsv(text) {
    const raw = String(text || "").replace(/^\uFEFF/, "");
    const lines = raw.split(/\r\n|\n|\r/).filter((l) => l.trim());
    if (!lines.length) throw new Error("CSV is empty");
    const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, "_"));
    const expected = ["date", "home_team", "away_team", "season_label", "game_type"];
    const hasHeader = expected.every((k, i) => header[i] === k);
    const start = hasHeader ? 1 : 0;
    const rows = [];
    for (let i = start; i < lines.length; i += 1) {
      const cols = parseCsvLine(lines[i]);
      if (cols.every((c) => !c)) continue;
      const [date, home_team, away_team, season_label, game_type] = cols;
      const gt = String(game_type || "other").trim().toLowerCase();
      if (!GAME_TYPES.includes(gt)) {
        throw new Error(`Row ${i + 1}: game_type must be ${GAME_TYPES.join(" / ")}`);
      }
      rows.push({
        date: parseCsvDate(String(date || "").trim()),
        home_team: String(home_team || "").trim(),
        away_team: String(away_team || "").trim(),
        season_label: String(season_label || "").trim(),
        game_type: gt,
      });
    }
    if (!rows.length) throw new Error("No game rows found");
    return rows;
  }

  function newTeamNames(rows) {
    const known = new Set(st.teams.map((t) => t.name.toLowerCase()));
    const names = [];
    rows.forEach((r) => {
      [r.home_team, r.away_team].forEach((n) => {
        if (n && !known.has(n.toLowerCase()) && !names.some((x) => x.toLowerCase() === n.toLowerCase())) {
          names.push(n);
        }
      });
    });
    return names;
  }

  async function importScheduleRows(rows, createNames) {
    for (const name of createNames) {
      await API.createTeam(name);
    }
    await refreshMeta();
    const b = brighton();
    if (!b) throw new Error("Brighton team is missing. Re-run schema.sql.");
    const byName = (n) => st.teams.find((t) => t.name.toLowerCase() === n.toLowerCase());
    const bySeason = (label) => st.seasons.find((s) => s.label.toLowerCase() === label.toLowerCase());
    let created = 0;
    for (const row of rows) {
      let season = bySeason(row.season_label);
      if (!season) {
        const year = Number(String(row.season_label).slice(0, 4)) || new Date().getFullYear();
        season = await API.createSeason(year, row.season_label);
        st.seasons.push(season);
      }
      const home = byName(row.home_team);
      const away = byName(row.away_team);
      if (!home || !away) throw new Error(`Unknown team in ${row.date} ${row.home_team} vs ${row.away_team}`);
      if (home.id !== b.id && away.id !== b.id) {
        throw new Error(`${row.home_team} vs ${row.away_team} does not include Brighton`);
      }
      await API.createGame({
        season_id: season.id,
        date: row.date,
        game_type: row.game_type,
        home_team_id: home.id,
        away_team_id: away.id,
        our_team_id: b.id,
      });
      created += 1;
    }
    st.seasonId = st.seasonId || st.seasons[0]?.id || "";
    st.games = await API.games(st.seasonId);
    st.csvPending = null;
    showToast(`Imported ${created} game${created === 1 ? "" : "s"}`);
    draw();
  }

  async function createGameFromForm() {
    const date = $("#new-game-date").value;
    const type = $("#new-game-type").value;
    let seasonId = $("#new-game-season").value;
    const newSeasonLabel = $("#new-season-label")?.value.trim();
    if (seasonId === "__new__") {
      if (!newSeasonLabel) throw new Error("Enter a season label");
      const year = Number($("#new-season-year")?.value) || new Date().getFullYear();
      const season = await API.createSeason(year, newSeasonLabel);
      seasonId = season.id;
      st.seasons.unshift(season);
    }
    const pickTeam = async (selId, newId) => {
      const v = $(selId).value;
      if (v === "__new__") {
        const name = $(newId).value.trim();
        if (!name) throw new Error("Enter a team name");
        const team = await API.createTeam(name);
        st.teams.push(team);
        return team.id;
      }
      return v;
    };
    const homeId = await pickTeam("#new-game-home", "#new-home-name");
    const awayId = await pickTeam("#new-game-away", "#new-away-name");
    const b = brighton();
    if (!date || !seasonId || !homeId || !awayId) throw new Error("Date, season, and both teams are required");
    if (homeId === awayId) throw new Error("Home and away must be different");
    if (!b || (homeId !== b.id && awayId !== b.id)) throw new Error("Brighton must be home or away");
    const game = await API.createGame({
      season_id: seasonId,
      date,
      game_type: type,
      home_team_id: homeId,
      away_team_id: awayId,
      our_team_id: b.id,
    });
    st.seasonId = seasonId;
    await selectGame(game.id);
  }

  async function importLocalStorageGame() {
    const events = localEvents();
    if (!events.length) throw new Error("No saved game on this device");
    const date = $("#import-date").value;
    const seasonId = $("#import-season").value;
    const oppName = $("#import-opponent").value.trim() || localUiV1().opponent || "Imported opponent";
    const type = $("#import-type").value;
    if (!date || !seasonId) throw new Error("Pick a date and season");
    const b = brighton();
    let opp = st.teams.find((t) => t.name.toLowerCase() === oppName.toLowerCase());
    if (!opp) opp = await API.createTeam(oppName);
    await refreshMeta();
    opp = st.teams.find((t) => t.name.toLowerCase() === oppName.toLowerCase());
    const game = await API.createGame({
      season_id: seasonId,
      date,
      game_type: type,
      home_team_id: b.id,
      away_team_id: opp.id,
      our_team_id: b.id,
    });
    st.gameId = game.id;
    await loadGameContext();
    for (const ev of events) {
      if (ev.shot == null || ev.shot.x == null || ev.shot.y == null) continue;
      const team = ev.team === "opp" ? "opp" : "us";
      const teamId = team === "us" ? b.id : opp.id;
      let playerId = null;
      let jersey = ev.shooterNumber ? String(ev.shooterNumber) : null;
      if (jersey) {
        const name = team === "us" ? ev.shooterName || null : null;
        const roster = await API.ensureRosterPlayer(teamId, seasonId, jersey, name);
        playerId = roster.player_id;
        if (team === "us") st.ourRoster = await API.roster(b.id, seasonId);
        else st.oppRoster = await API.roster(opp.id, seasonId);
      }
      let assistPlayerId = null;
      if (ev.assist?.number) {
        const aName = team === "us" ? ev.assist.name || null : null;
        const aRoster = await API.ensureRosterPlayer(teamId, seasonId, String(ev.assist.number), aName);
        assistPlayerId = aRoster.player_id;
      }
      const row = {
        game_id: game.id,
        period: normalizePeriod(ev.period),
        team_id: teamId,
        player_id: playerId,
        jersey_number_at_time: jersey,
        position: null,
        x: ev.shot?.x,
        y: ev.shot?.y,
        zone_id: ev.shot?.zoneId || null,
        zone_label: ev.shot?.zoneLabel || null,
        result: ev.result,
        assist_player_id: assistPlayerId,
        assist_type: ev.assist?.type || null,
        assist_x: ev.assist ? ev.assist.x : null,
        assist_y: ev.assist ? ev.assist.y : null,
        assist_zone_id: ev.assist ? ev.assist.zoneId : null,
        assist_zone_label: ev.assist ? ev.assist.zoneLabel : null,
        created_at: ev.createdAt || new Date().toISOString(),
      };
      const saved = await API.insertShot(row);
      if (!saved.ok) throw new Error(saved.error);
    }
    await loadGameContext();
    showToast("Imported this device's saved game. localStorage was left in place.");
    location.hash = "shots";
  }

  function teamOptions(selectedId, includeNew) {
    const opts = st.teams
      .map((t) => `<option value="${t.id}" ${t.id === selectedId ? "selected" : ""}>${escapeHtml(t.name)}</option>`)
      .join("");
    return `<option value="">Select…</option>${opts}${includeNew ? `<option value="__new__">New team…</option>` : ""}`;
  }

  function seasonOptions(selectedId, includeNew) {
    const opts = st.seasons
      .map((s) => `<option value="${s.id}" ${s.id === selectedId ? "selected" : ""}>${escapeHtml(s.label)}</option>`)
      .join("");
    return `${opts}${includeNew ? `<option value="__new__">New season…</option>` : ""}`;
  }

  function renderGames() {
    const localCount = localEvents().length;
    const today = localYmd();
    const yesterday = addDaysYmd(today, -1);
    const games = gamesForList(st.games)
      .map((g) => {
        const date = gameDateYmd(g);
        const past = date < yesterday;
        const opp = opponentOf(g);
        const vs = opp ? opp.name : "";
        return `
          <li class="shots-game-row${past ? " is-past" : ""}">
            <button type="button" class="shots-game-btn" data-open-game="${g.id}">
              <strong>${escapeHtml(date)}</strong>
              <span>vs ${escapeHtml(vs)} · ${escapeHtml(g.game_type)}</span>
            </button>
          </li>`;
      })
      .join("");
    const csvBox = st.csvPending
      ? `
        <div class="shots-confirm">
          <h3>New teams in this CSV</h3>
          <p>Confirm these names before anything is created. Typos should be cancelled and fixed in the file.</p>
          <ul>${st.csvPending.newNames.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>
          <div class="tracker-toolbar">
            <button type="button" class="btn btn-primary" id="csv-confirm">Create teams and import</button>
            <button type="button" class="btn btn-ghost" id="csv-cancel">Cancel</button>
          </div>
        </div>`
      : "";

    root().innerHTML = `
      <div class="shots-admin">
        ${trackerNav("games")}
        <h1>Games</h1>
        <p class="muted">Pick a season, then a game — Track Shots or Scoreboard.</p>
        ${st.error ? `<p class="shots-error">${escapeHtml(st.error)}</p>` : ""}
        <label class="shots-field">Season
          <select id="season-pick">${seasonOptions(st.seasonId, false)}</select>
        </label>
        <ul class="shots-game-list">${games || `<li class="muted">No games in this season yet.</li>`}</ul>

        <h2>Add game</h2>
        <form id="new-game-form" class="shots-form">
          <label class="shots-field">Date <input type="date" id="new-game-date" required value="${today}" /></label>
          <label class="shots-field">Type
            <select id="new-game-type">${GAME_TYPES.map((t) => `<option value="${t}">${t}</option>`).join("")}</select>
          </label>
          <label class="shots-field">Season
            <select id="new-game-season">${seasonOptions(st.seasonId, true)}</select>
          </label>
          <div id="new-season-extra" hidden>
            <label class="shots-field">Season label <input type="text" id="new-season-label" placeholder="2026 Fall" /></label>
            <label class="shots-field">Year <input type="number" id="new-season-year" value="${new Date().getFullYear()}" /></label>
          </div>
          <label class="shots-field">Home
            <select id="new-game-home">${teamOptions(brighton()?.id, true)}</select>
          </label>
          <input type="text" id="new-home-name" class="text-gate-input" placeholder="New home team name" hidden />
          <label class="shots-field">Away
            <select id="new-game-away">${teamOptions("", true)}</select>
          </label>
          <input type="text" id="new-away-name" class="text-gate-input" placeholder="New away team name" hidden />
          <button type="submit" class="btn btn-primary">Start tracking</button>
        </form>

        <h2>Bulk upload</h2>
        <p class="muted">CSV columns in order: date, home_team, away_team, season_label, game_type. CRLF preferred.</p>
        <input type="file" id="schedule-csv" accept=".csv,text/csv" />
        ${csvBox}

        ${
          localCount
            ? `<h2>Import this device's saved game</h2>
          <p class="muted">${localCount} play(s) in localStorage will be copied into a new shared game. The original is not deleted.</p>
          <form id="import-local-form" class="shots-form">
            <label class="shots-field">Date <input type="date" id="import-date" required value="${today}" /></label>
            <label class="shots-field">Season <select id="import-season">${seasonOptions(st.seasonId, false)}</select></label>
            <label class="shots-field">Opponent <input type="text" id="import-opponent" value="${escapeHtml(localUiV1().opponent || "")}" placeholder="Opponent" /></label>
            <label class="shots-field">Type
              <select id="import-type">${GAME_TYPES.map((t) => `<option value="${t}">${t}</option>`).join("")}</select>
            </label>
            <button type="submit" class="btn btn-secondary">Import saved game</button>
          </form>`
            : ""
        }
      </div>`;

    $("#season-pick")?.addEventListener("change", (e) => selectSeason(e.target.value));
    $$("[data-open-game]").forEach((btn) => {
      btn.addEventListener("click", () => openGameChooser(btn.getAttribute("data-open-game")));
    });
    const bindNewToggle = (sel, extra) => {
      $(sel)?.addEventListener("change", () => {
        const show = $(sel).value === "__new__";
        if ($(extra)) $(extra).hidden = !show;
      });
    };
    bindNewToggle("#new-game-home", "#new-home-name");
    bindNewToggle("#new-game-away", "#new-away-name");
    $("#new-game-season")?.addEventListener("change", () => {
      const extra = $("#new-season-extra");
      if (extra) extra.hidden = $("#new-game-season").value !== "__new__";
    });
    $("#new-game-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        st.error = "";
        await createGameFromForm();
      } catch (err) {
        st.error = err.message || "Could not add game";
        draw();
      }
    });
    $("#schedule-csv")?.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const rows = parseScheduleCsv(text);
        const names = newTeamNames(rows);
        if (names.length) {
          st.csvPending = { rows, newNames: names };
          draw();
          return;
        }
        await importScheduleRows(rows, []);
      } catch (err) {
        st.error = err.message || "CSV import failed";
        draw();
      }
    });
    $("#csv-confirm")?.addEventListener("click", async () => {
      try {
        await importScheduleRows(st.csvPending.rows, st.csvPending.newNames);
      } catch (err) {
        st.error = err.message || "CSV import failed";
        draw();
      }
    });
    $("#csv-cancel")?.addEventListener("click", () => {
      st.csvPending = null;
      draw();
    });
    $("#import-local-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        st.error = "";
        st.loading = true;
        draw();
        await importLocalStorageGame();
      } catch (err) {
        st.loading = false;
        st.error = err.message || "Import failed";
        draw();
      }
    });
  }

  function locatePitchPoint(rawX, rawY) {
    const x = Math.max(0, Math.min(PW, rawX));
    const y = Math.max(0, Math.min(FIELD_Y_MAX, rawY));
    if (y >= HALF_L) {
      return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, zoneId: "DEF", zoneLabel: "Defensive half" };
    }
    const col = TRACKER_CHANNELS.findIndex((c, i) =>
      i === TRACKER_CHANNELS.length - 1 ? x >= c.x0 && x <= c.x1 : x >= c.x0 && x < c.x1
    );
    const row = TRACKER_DEPTHS.findIndex((d, i) =>
      i === TRACKER_DEPTHS.length - 1 ? y >= d.y0 && y <= d.y1 : y >= d.y0 && y < d.y1
    );
    const channel = TRACKER_CHANNELS[Math.max(0, col)];
    const depth = TRACKER_DEPTHS[Math.max(0, row)];
    const sixX0 = (PW - SIX_W) / 2;
    const penX0 = (PW - PEN_W) / 2;
    const inSix = x >= sixX0 && x <= sixX0 + SIX_W && y <= 5.5;
    const inBox = x >= penX0 && x <= penX0 + PEN_W && y <= 16.5;
    const nearSpot = Math.hypot(x - PW / 2, y - 11) <= 2.2;
    let zoneLabel;
    if (channel.id === "C" && depth.id === "D") zoneLabel = "Zone 14";
    else if (nearSpot) zoneLabel = "Penalty spot";
    else if (inSix) zoneLabel = `Six-yard box · ${channel.label}`;
    else if (inBox) zoneLabel = `Box · ${channel.label}`;
    else zoneLabel = `${channel.label} · ${depth.label}`;
    return {
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      zoneId: `${channel.id}-${depth.id}`,
      zoneLabel,
    };
  }

  function formatLoc(loc) {
    return loc?.zoneLabel || loc?.zone_label || "—";
  }

  function formatXY(loc) {
    if (!loc || loc.x == null) return "—";
    return `${Number(loc.x).toFixed(1)}, ${Number(loc.y).toFixed(1)}`;
  }

  function formatShotTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function csvEscape(value) {
    const s = String(value ?? "");
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function downloadCsv(filename, headers, rows) {
    const lines = [headers.join(",")];
    rows.forEach((cols) => lines.push(cols.join(",")));
    const blob = new Blob([`\uFEFF${lines.join("\r\n")}`], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    showToast("CSV exported");
  }

  function shotCsvRow(ev, extra) {
    const team = eventTeam(ev);
    return [
      extra?.date || ev.gameDate || ev.game?.date || st.game?.date || "",
      extra?.opponent || ev.opponentName || opponentOf(st.game)?.name || "",
      extra?.season || ev.seasonLabel || ev.game?.season?.label || st.game?.season?.label || "",
      periodCsv(eventPeriod(ev)),
      team === "opp" ? "opponent" : "us",
      ev.createdAt || ev.created_at || "",
      formatEventClock(ev, ev.game || st.game),
      ev.gameClockSeconds ?? ev.game_clock_seconds ?? "",
      ev.shooterNumber ?? ev.jersey_number_at_time ?? "",
      csvEscape(ev.shooterName || ev.player?.name || ""),
      ev.position || "",
      csvEscape(SHOT_RESULT_LABELS[ev.result] || ev.result),
      ev.missDirection || ev.miss_direction || "",
      ev.foulerNumber || ev.fouler_jersey_number_at_time || "",
      csvEscape(ev.foulerName || ev.fouler?.name || ""),
      ev.shot?.zoneId ?? ev.zone_id ?? "",
      csvEscape(ev.shot?.zoneLabel || ev.zone_label || ""),
      ev.shot?.x ?? ev.x ?? "",
      ev.shot?.y ?? ev.y ?? "",
      ev.assist?.number ?? "",
      csvEscape(ev.assist?.name || ev.assist_player?.name || ""),
      ev.assist ? ASSIST_TYPE_LABELS[ev.assist.type] || ev.assist.type : ev.assist_type || "",
      ev.assist?.position || ev.assist_position || "",
      ev.assist?.zoneId ?? ev.assist_zone_id ?? "",
      csvEscape(ev.assist?.zoneLabel || ev.assist_zone_label || ""),
      ev.assist?.x ?? ev.assist_x ?? "",
      ev.assist?.y ?? ev.assist_y ?? "",
      ev.secondAssist?.number ?? "",
      csvEscape(ev.secondAssist?.name || ev.second_assist_player?.name || ""),
      ev.secondAssist ? ASSIST_TYPE_LABELS[ev.secondAssist.type] || ev.secondAssist.type : ev.second_assist_type || "",
      ev.secondAssist?.position || ev.second_assist_position || "",
      ev.secondAssist?.zoneId ?? ev.second_assist_zone_id ?? "",
      csvEscape(ev.secondAssist?.zoneLabel || ev.second_assist_zone_label || ""),
      ev.secondAssist?.x ?? ev.second_assist_x ?? "",
      ev.secondAssist?.y ?? ev.second_assist_y ?? "",
    ];
  }

  const CSV_HEADERS = [
    "date",
    "opponent",
    "season",
    "half",
    "team",
    "time",
    "game_clock",
    "game_clock_seconds",
    "player_number",
    "player_name",
    "position",
    "result",
    "miss_direction",
    "fouler_number",
    "fouler_name",
    "shot_zone_id",
    "shot_zone",
    "shot_x",
    "shot_y",
    "assisted_by_number",
    "assisted_by_name",
    "assist_type",
    "assist_position",
    "assist_zone_id",
    "assist_zone",
    "assist_x",
    "assist_y",
    "second_assisted_by_number",
    "second_assisted_by_name",
    "second_assist_type",
    "second_assist_position",
    "second_assist_zone_id",
    "second_assist_zone",
    "second_assist_x",
    "second_assist_y",
  ];

  function exportShotsCsv(events, filename) {
    if (!events.length) {
      showToast("No shots to export");
      return;
    }
    downloadCsv(
      filename || `bengals-shots-${new Date().toISOString().slice(0, 10)}.csv`,
      CSV_HEADERS,
      events.map((ev) => shotCsvRow(ev))
    );
  }

  function pitchFromSvgPoint(sx, sy, swapped) {
    if (swapped) return { x: PW - sy, y: sx };
    return { x: sy, y: HALF_L - sx };
  }

  function svgEventPoint(svg, evt) {
    const pt = svg.createSVGPoint();
    const e = evt.changedTouches?.[0] || evt.touches?.[0] || evt;
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    return pt.matrixTransform(ctm.inverse());
  }

  function halfPitchMarkup(events, opts = {}) {
    const swapped = !!opts.swapped;
    const team = opts.team || "us";
    const line = "var(--pitch-line)";
    const goalW = 7.32;
    const goalX = (PW - goalW) / 2;
    const penW = 40.32;
    const penH = 16.5;
    const sixW = 18.32;
    const sixH = 5.5;
    const penX = (PW - penW) / 2;
    const sixX = (PW - sixW) / 2;
    const spotX = PW / 2;
    const spotY = 11;
    const arcR = 9.15;
    const dx = Math.sqrt(arcR * arcR - (penH - spotY) * (penH - spotY));
    const stripes = [];
    for (let i = 0; i < 5; i += 1) {
      stripes.push(
        `<rect class="grass-stripe" x="0" y="${i * (FIELD_Y_MAX / 5)}" width="${PW}" height="${FIELD_Y_MAX / 10}" />`
      );
    }
    let grid = "";
    if (opts.showGrid) {
      TRACKER_CHANNELS.forEach((ch, i) => {
        TRACKER_DEPTHS.forEach((d, j) => {
          if ((i + j) % 2 === 1) {
            grid += `<rect class="tracker-cell" x="${ch.x0}" y="${d.y0}" width="${ch.x1 - ch.x0}" height="${d.y1 - d.y0}" />`;
          }
        });
      });
      grid += `<rect class="tracker-cell tracker-cell-deep" x="0" y="${HALF_L}" width="${PW}" height="${DEF_SLIVER}" />`;
      TRACKER_CHANNELS.slice(1).forEach((ch) => {
        grid += `<line class="tracker-grid-line" x1="${ch.x0}" y1="0" x2="${ch.x0}" y2="${HALF_L}" />`;
      });
      TRACKER_DEPTHS.slice(1).forEach((d) => {
        grid += `<line class="tracker-grid-line" x1="0" y1="${d.y0}" x2="${PW}" y2="${d.y0}" />`;
      });
    }
    const pendingDots = [];
    const pending = st.pending;
    const modalLoc = shotModalDraft.location;
    const active = recordingTeam() === team;
    if (!opts.noPending) {
      if (active && pending?.secondAssist?.location) {
        const s = pending.secondAssist.location;
        pendingDots.push(svgSquare(s.x, s.y, 2.1, `class="tracker-pending second-assist"`));
      }
      if (active && pending?.assist?.location) {
        const a = pending.assist.location;
        pendingDots.push(svgSquare(a.x, a.y, 2.3, `class="tracker-pending assist"`));
      }
      if (active && modalLoc && shotModal && !shotModal.hidden) {
        pendingDots.push(`<circle class="tracker-pending" cx="${modalLoc.x}" cy="${modalLoc.y}" r="1.25" />`);
      }
    }
    const numRot = swapped ? 90 : -90;
    const markers = events
      .filter((ev) => {
        if (eventTeam(ev) !== team) return false;
        if (opts.allPeriods) return true;
        return eventPeriod(ev) === (opts.period || st.period);
      })
      .map((ev) => {
        let html = "";
        if (ev.secondAssist) {
          const from = ev.assist || ev.shot;
          html += `<line class="tracker-assist-line is-second" x1="${ev.secondAssist.x}" y1="${ev.secondAssist.y}" x2="${from.x}" y2="${from.y}" />`;
          html += svgSquare(ev.secondAssist.x, ev.secondAssist.y, 1.45, `class="tracker-assist-dot is-second"`);
        }
        if (ev.assist) {
          html += `<line class="tracker-assist-line" x1="${ev.assist.x}" y1="${ev.assist.y}" x2="${ev.shot.x}" y2="${ev.shot.y}" />`;
          html += svgSquare(ev.assist.x, ev.assist.y, 1.65, `class="tracker-assist-dot"`);
        }
        html += shotShapeMarkup(ev, ev.shot.x, ev.shot.y, {
          size: 3.4,
          className: `tracker-shot-dot ${escapeHtml(ev.result)}`,
        });
        if (ev.shooterNumber !== undefined && ev.shooterNumber !== null && ev.shooterNumber !== "") {
          html += `<text class="tracker-shot-num" x="${ev.shot.x}" y="${ev.shot.y}" transform="rotate(${numRot} ${ev.shot.x} ${ev.shot.y})">${escapeHtml(String(ev.shooterNumber))}</text>`;
        }
        return `<g class="tracker-event ${team === "opp" ? "is-opp" : ""} ${ev.saveFailed ? "is-failed" : ""}" data-event-id="${escapeHtml(ev.id)}">${html}</g>`;
      })
      .join("");
    const inner = swapped
      ? `translate(0, ${PW}) rotate(-90)`
      : `translate(${HALF_L}, 0) rotate(90)`;
    const viewBox = swapped ? "-3.5 -1 64.8 70" : "-9.4 -1 64.8 70";
    return `
      <svg class="pitch-svg tracker-pitch-svg ${team === "opp" ? "is-opp-pitch" : "is-us-pitch"}" data-pitch-team="${team}" viewBox="${viewBox}" role="application" aria-label="${team === "opp" ? "Opponent" : "Brighton"} attacking half. Goal ${swapped ? "on the left" : "on the right"}.">
        <g transform="${inner}">
          ${stripes.join("")}
          <g class="tracker-grid">${grid}</g>
          <rect x="0" y="0" width="${PW}" height="${FIELD_Y_MAX}" fill="none" stroke="${line}" stroke-width="0.45" />
          <line x1="0" y1="${HALF_L}" x2="${PW}" y2="${HALF_L}" stroke="${line}" stroke-width="0.4" />
          <circle cx="${PW / 2}" cy="${HALF_L}" r="9.15" fill="none" stroke="${line}" stroke-width="0.35" />
          <circle cx="${PW / 2}" cy="${HALF_L}" r="0.45" fill="${line}" />
          <rect x="${goalX}" y="-1.35" width="${goalW}" height="1.35" fill="none" stroke="${line}" stroke-width="0.45" />
          <rect x="${penX}" y="0" width="${penW}" height="${penH}" fill="none" stroke="${line}" stroke-width="0.35" />
          <rect x="${sixX}" y="0" width="${sixW}" height="${sixH}" fill="none" stroke="${line}" stroke-width="0.35" />
          <circle cx="${spotX}" cy="${spotY}" r="0.45" fill="${line}" />
          <path d="M ${spotX - dx} ${penH} A ${arcR} ${arcR} 0 0 0 ${spotX + dx} ${penH}" fill="none" stroke="${line}" stroke-width="0.35" />
          <path d="M 0 1 A 1 1 0 0 0 1 0" fill="none" stroke="${line}" stroke-width="0.3" />
          <path d="M ${PW} 1 A 1 1 0 0 1 ${PW - 1} 0" fill="none" stroke="${line}" stroke-width="0.3" />
          <text class="tracker-goal-label" x="${PW / 2}" y="-1.85" transform="rotate(${numRot} ${PW / 2} -1.85)">GOAL</text>
          <g class="tracker-markers">${markers}${pendingDots.join("")}</g>
        </g>
      </svg>`;
  }

  function resetTrackerDraft() {
    st.mode = "idle";
    st.pending = null;
    shotModalDraft.step = "first";
    shotModalDraft.phase = "action";
    shotModalDraft.location = null;
    shotModalDraft.player = null;
    shotModalDraft.fouler = null;
    shotModalDraft.foulerPicked = false;
    shotModalDraft.foulerPickTeam = "opp";
    shotModalDraft.action = null;
    shotModalDraft.position = "";
    shotModalDraft.missDirection = "";
    shotModalDraft.fkOutcome = "";
    shotModalDraft.subSlotId = null;
    shotModalDraft.justAddedNumber = "";
  }

  function closeShotModal() {
    if (shotModal) shotModal.hidden = true;
    shotModalDraft.player = null;
    shotModalDraft.fouler = null;
    shotModalDraft.foulerPicked = false;
    shotModalDraft.action = null;
    shotModalDraft.phase = "action";
    shotModalDraft.location = null;
    shotModalDraft.position = "";
    shotModalDraft.missDirection = "";
    shotModalDraft.fkOutcome = "";
    shotModalDraft.subSlotId = null;
    shotModalDraft.justAddedNumber = "";
  }

  function dismissShotModal() {
    closeShotModal();
    if (st.view === "shots") draw({ keepScroll: true });
  }

  function fillShotModal(step, location) {
    shotModalDraft.step = step;
    shotModalDraft.phase = "action";
    shotModalDraft.location = location;
    shotModalDraft.player = null;
    shotModalDraft.fouler = st.pending?.foulerPicked ? st.pending.fouler : null;
    shotModalDraft.foulerPicked = !!st.pending?.foulerPicked;
    shotModalDraft.foulerPickTeam =
      st.pending?.foulerPickTeam || oppositeTeam(recordingTeam());
    shotModalDraft.action = null;
    shotModalDraft.position = "";
    shotModalDraft.missDirection = "";
    shotModalDraft.fkOutcome = "";
    shotModalDraft.subSlotId = null;
    shotModalDraft.justAddedNumber = "";
    renderShotModal();
    shotModal.dataset.openedAt = String(Date.now());
    shotModal.hidden = false;
  }

  function actionShortLabel(action) {
    if (!action) return "";
    if (action.kind === "assist") return ASSIST_TYPE_LABELS[action.type] || action.type;
    if (action.result === "on-target") return "On Goal";
    if (action.result === "blocked") return "Blocked";
    if (action.result === "missed") return "Missed";
    if (action.result === "goal") return "Goal";
    if (action.result === "foul") return "Free Kick";
    if (action.result === "corner") return "Corner";
    if (action.result === "pk-goal") return "PK Goal";
    if (action.result === "pk-missed") return "PK Miss";
    return action.label || "";
  }

  function usedThisGameNumbers(team) {
    const nums = new Set();
    st.shots.forEach((ev) => {
      if (eventTeam(ev) === team) {
        if (ev.shooterNumber) nums.add(String(ev.shooterNumber));
        if (ev.assist?.number) nums.add(String(ev.assist.number));
        if (ev.secondAssist?.number) nums.add(String(ev.secondAssist.number));
      }
      if (RESULTS_NEEDING_FOULER.has(ev.result) && ev.foulerNumber) {
        const foulerTeam = oppositeTeam(eventTeam(ev));
        if (foulerTeam === team) nums.add(String(ev.foulerNumber));
      }
    });
    return [...nums].sort((a, b) => Number(a) - Number(b));
  }

  function recordingNeedsPosition() {
    return recordingTeam() !== "opp";
  }

  function takerPhaseFor(team) {
    return team === "opp" ? "player" : "position";
  }

  function advanceAfterAction() {
    const action = shotModalDraft.action;
    // Foul happens before the restart: ask infringer first, then miss dir, then taker/position.
    if (needsFoulerStep(action) && !shotModalDraft.foulerPicked) {
      shotModalDraft.phase = "fouler";
      if (!shotModalDraft.foulerPickTeam) {
        shotModalDraft.foulerPickTeam = oppositeTeam(recordingTeam());
      }
    } else if (needsMissDirection(action) && !shotModalDraft.missDirection) {
      shotModalDraft.phase = "miss-dir";
    } else {
      shotModalDraft.phase = takerPhaseFor(recordingTeam());
    }
    renderShotModal();
  }

  function positionPhaseCards(team, attrs = {}) {
    const pickAttr = attrs.pick || "data-pick-position";
    return FORMATION_LAYOUT.map((layout) => {
      const p = slotPlayer(team, layout.id);
      const who = p
        ? team === "opp" && !p.name && !p.short
          ? `#${escapeHtml(String(p.number))}`
          : escapeHtml(playerDisplayName(p))
        : "Empty";
      const meta = p ? formationMeta(layout.code, p) : escapeHtml(layout.code);
      const playerAttrs = p
        ? ` data-player-number="${escapeHtml(String(p.number))}" data-player-id="${escapeHtml(p.id || "")}"`
        : "";
      return `
        <button type="button" class="formation-card is-pick ${p ? "" : "is-empty"}" style="${formationCardStyle(layout)}" ${pickAttr}="${escapeHtml(layout.code)}" data-player-team="${team}"${playerAttrs}>
          <span class="formation-card-name">${who}</span>
          <span class="formation-card-meta">${meta}</span>
        </button>`;
    }).join("");
  }

  function renderShotModal() {
    const title = $("#shot-modal-title");
    const locEl = $("#shot-modal-location");
    const actionLabel = $("#shot-action-label");
    const playerHeading = $("#shot-modal-heading");
    const playerGrid = $("#shot-player-grid");
    const actionGrid = $("#shot-action-grid");
    const backBtn = $("#shot-modal-back");
    const panel = $(".shot-modal-panel", shotModal);
    const nudge = $("#shot-lineup-nudge");
    const nudgeText = $("#shot-lineup-nudge-text");
    const posGrid = $("#shot-position-grid");
    if (!shotModal || !playerGrid || !actionGrid) return;
    if (actionLabel) actionLabel.hidden = true;
    playerGrid.classList.remove("is-formation");

    const step = shotModalDraft.step;
    const phase = shotModalDraft.phase;
    const loc = shotModalDraft.location;
    const locText = loc ? `${formatLoc(loc)}  ·  (${formatXY(loc)})` : "";
    const inSubFlow = phase === "sub-slot" || phase === "sub-pick";
    if (panel) {
      panel.classList.toggle(
        "is-player-phase",
        phase === "player" ||
          phase === "position" ||
          phase === "fouler" ||
          phase === "miss-dir" ||
          phase === "fk-result" ||
          phase === "corner-result" ||
          inSubFlow
      );
    }
    if (backBtn) backBtn.hidden = phase === "action";
    if (posGrid) posGrid.hidden = true;

    if (nudge) {
      const showNudge = phase === "position" && recordingTeam() === "us" && !lineupHasXi("us");
      nudge.hidden = !showNudge;
      if (nudgeText && showNudge) {
        nudgeText.textContent = "No XI yet — still pick the position for this play. Add numbers below anytime.";
      }
    }

    if (phase === "action") {
      const follow = step === "follow";
      title.textContent = step === "shot" ? "Shot result?" : "What happened?";
      locEl.textContent = locText;
      if (playerHeading) playerHeading.hidden = true;
      if (nudge) nudge.hidden = true;
      playerGrid.hidden = true;
      actionGrid.hidden = false;
      const shotBtns = TRACKER_SHOT_ACTIONS.map(
        (a) =>
          `<button type="button" class="shot-action-btn is-${a.result}" data-action-id="${escapeHtml(a.id)}">${escapeHtml(actionShortLabel(a))}</button>`
      ).join("");
      const assistBtns = TRACKER_ASSIST_ACTIONS.map(
        (a) =>
          `<button type="button" class="shot-action-btn is-assist" data-action-id="${escapeHtml(a.id)}">${escapeHtml(ASSIST_TYPE_LABELS[a.type])}</button>`
      ).join("");
      if (step === "shot") {
        actionGrid.innerHTML = `<div class="shot-action-row shot-action-row-fill">${shotBtns}</div>`;
      } else if (follow) {
        actionGrid.innerHTML = `
          <p class="shot-action-heading">Assist</p>
          <div class="shot-action-row shot-action-row-3">${assistBtns}</div>
          <p class="shot-action-heading">Shot</p>
          <div class="shot-action-row shot-action-row-fill">${shotBtns}</div>`;
      } else {
        const otherBtns = TRACKER_OTHER_ACTIONS.map(
          (a) =>
            `<button type="button" class="shot-action-btn is-${a.result}" data-action-id="${escapeHtml(a.id)}">${escapeHtml(actionShortLabel(a))}</button>`
        ).join("");
        actionGrid.innerHTML = `
          <p class="shot-action-heading">Assist</p>
          <div class="shot-action-row shot-action-row-3">${assistBtns}</div>
          <p class="shot-action-heading">Shot</p>
          <div class="shot-action-row shot-action-row-fill">${shotBtns}</div>
          <p class="shot-action-heading">Set piece</p>
          <div class="shot-action-row shot-action-row-fill">${otherBtns}</div>`;
      }
      return;
    }

    if (phase === "miss-dir") {
      const chosen = shotModalDraft.action;
      const outcome = effectiveShotResult();
      title.textContent = "Where did it miss?";
      locEl.textContent = chosen
        ? `${actionShortLabel(chosen)}${outcome && outcome !== chosen.result ? ` → ${SHOT_RESULT_LABELS[outcome] || outcome}` : ""}  ·  ${locText}`
        : locText;
      if (playerHeading) playerHeading.hidden = true;
      playerGrid.hidden = true;
      actionGrid.hidden = false;
      actionGrid.innerHTML = `
        <div class="shot-action-row shot-action-row-fill">
          ${MISS_DIRECTIONS.map(
            (d) =>
              `<button type="button" class="shot-action-btn is-miss-dir" data-miss-dir="${d}">${escapeHtml(MISS_DIRECTION_LABELS[d])}</button>`
          ).join("")}
        </div>`;
      return;
    }

    if (phase === "fk-result" || phase === "corner-result") {
      const chosen = shotModalDraft.action;
      const isCorner = phase === "corner-result" || chosen?.result === "corner";
      const taker = shotModalDraft.player
        ? playerLabel(Object.assign({ team: recordingTeam() }, shotModalDraft.player))
        : shotModalDraft.position
          ? `untagged · ${shotModalDraft.position}`
          : "untagged";
      title.textContent = isCorner ? "Corner — what next?" : "Free kick — what next?";
      locEl.textContent = chosen ? `${actionShortLabel(chosen)} · ${taker}  ·  ${locText}` : locText;
      if (playerHeading) {
        playerHeading.hidden = false;
        playerHeading.textContent = "Shot from here, another pass, or just log the restart.";
      }
      if (nudge) nudge.hidden = true;
      playerGrid.hidden = true;
      actionGrid.hidden = false;
      const shotBtns = TRACKER_SHOT_ACTIONS.map(
        (a) =>
          `<button type="button" class="shot-action-btn is-${a.result}" data-restart-result="${escapeHtml(a.result)}">${escapeHtml(actionShortLabel(a))}</button>`
      ).join("");
      const assistBtns = TRACKER_ASSIST_ACTIONS.map(
        (a) =>
          `<button type="button" class="shot-action-btn is-assist" data-restart-assist="${escapeHtml(a.type)}">${escapeHtml(ASSIST_TYPE_LABELS[a.type])}</button>`
      ).join("");
      const keepResult = isCorner ? "corner" : "foul";
      const keepLabel = isCorner ? "No shot — corner only" : "No shot — free kick only";
      actionGrid.innerHTML = `
        <p class="shot-action-heading">Assist</p>
        <div class="shot-action-row shot-action-row-3">${assistBtns}</div>
        <p class="shot-action-heading">Shot</p>
        <div class="shot-action-row shot-action-row-fill">${shotBtns}</div>
        <div class="shot-action-row shot-action-row-fill" style="margin-top:0.55rem">
          <button type="button" class="shot-action-btn is-${keepResult}" data-restart-result="${keepResult}">${keepLabel}</button>
        </div>`;
      return;
    }

    if (phase === "position" && recordingTeam() !== "opp") {
      const chosen = shotModalDraft.action;
      const team = recordingTeam();
      const missBit = shotModalDraft.missDirection
        ? ` · ${MISS_DIRECTION_LABELS[shotModalDraft.missDirection]}`
        : "";
      const foulerBit = shotModalDraft.foulerPicked
        ? ` · foul: ${playerLabel(shotModalDraft.fouler ? Object.assign({ team: shotModalDraft.fouler.team || oppositeTeam(recordingTeam()) }, shotModalDraft.fouler) : null)}`
        : "";
      const teamCaption = ourTeamName();
      title.textContent = "Which position?";
      locEl.textContent = chosen
        ? `${actionShortLabel(chosen)}${chosen.kind === "assist" ? " assist" : ""}${missBit}${foulerBit}  ·  ${locText}`
        : locText;
      if (playerHeading) {
        playerHeading.hidden = false;
        playerHeading.textContent =
          chosen?.result === "foul"
            ? "Who took the free kick? Tap Empty for unknown at that spot."
            : chosen?.kind === "assist"
              ? "Who passed? Tap Empty for unknown at that spot."
              : "Tap a player to save. Tap Empty for unknown at that spot.";
      }
      if (nudge) {
        nudge.hidden = !(team === "us" && !lineupHasXi("us"));
        if (!nudge.hidden && nudgeText) {
          nudgeText.textContent = "No XI yet — still pick the position for this play. Add numbers below anytime.";
        }
      }
      actionGrid.hidden = true;
      playerGrid.hidden = false;
      playerGrid.classList.add("is-formation");
      playerGrid.innerHTML = `
        <div class="shot-dual-pitch-block">
          <div class="shot-dual-pitch-head">
            <p class="tracker-pitch-caption">${escapeHtml(teamCaption)}</p>
            <button type="button" class="btn btn-ghost shot-bar-btn is-sub-in" data-make-change="us">Make a Change</button>
          </div>
          ${formationPitchShell(positionPhaseCards(team, { pick: "data-pick-position" }), "", { team })}
        </div>`;
      return;
    }

    if (phase === "sub-slot" && recordingTeam() !== "opp") {
      const team = recordingTeam();
      title.textContent = "Change which position?";
      locEl.textContent = "Pick the spot to fill or replace, then choose who comes in.";
      if (playerHeading) playerHeading.hidden = true;
      if (posGrid) posGrid.hidden = true;
      actionGrid.hidden = true;
      playerGrid.hidden = false;
      playerGrid.classList.add("is-formation");
      const cards = FORMATION_LAYOUT.map((layout) => {
        const slot = POSITION_SLOTS.find((s) => s.id === layout.id);
        const filled = slotPlayer(team, layout.id);
        const who = filled
          ? team === "opp" && !filled.name && !filled.short
            ? `#${escapeHtml(String(filled.number))}`
            : escapeHtml(playerDisplayName(filled))
          : "Empty";
        return `
          <button type="button" class="formation-card is-pick ${filled ? "" : "is-empty"}" style="${formationCardStyle(layout)}" data-sub-slot-pick="${layout.id}">
            <span class="formation-card-name">${who}</span>
            <span class="formation-card-meta">${formationMeta(slot?.code || layout.code, filled)}</span>
          </button>`;
      }).join("");
      playerGrid.innerHTML = formationPitchShell(cards, "", { team });
      return;
    }

    if (phase === "sub-pick" && recordingTeam() !== "opp") {
      const team = recordingTeam();
      const slot = POSITION_SLOTS.find((s) => s.id === Number(shotModalDraft.subSlotId));
      const group = slot?.group || "";
      const groupLabel = POSITION_GROUPS.find((g) => g.id === group)?.label || group;
      title.textContent = `Who comes in at ${slot?.code || ""}?`;
      locEl.textContent =
        team === "us" ? `${groupLabel} first, then bench, then on-field elsewhere.` : "Pick a number, or add a new one.";
      if (playerHeading) playerHeading.hidden = true;
      if (posGrid) posGrid.hidden = true;
      actionGrid.hidden = true;
      playerGrid.hidden = false;
      playerGrid.classList.remove("is-formation");
      const used = usedLineupNumbers(team, shotModalDraft.subSlotId);
      const all = sortPlayers(rosterPlayers(team));
      const available = all.filter((p) => !used.has(String(p.number)));
      const btn = (p, tag) => `
        <button type="button" class="shot-player-btn" data-sub-pick-id="${escapeHtml(String(p.id || ""))}" data-sub-pick-number="${escapeHtml(String(p.number))}">
          <span class="name">${team === "opp" && !p.name && !p.short ? `#${escapeHtml(String(p.number))}` : escapeHtml(playerDisplayName(p))}</span>
          <span class="num">#${escapeHtml(String(p.number))}${tag ? ` · ${tag}` : ""}</span>
        </button>`;
      let body = "";
      if (team === "us") {
        const preferred = available.filter((p) => p.squad !== "jv" && playerInGroup(p, group));
        const varsityBench = available.filter(
          (p) => p.squad !== "jv" && !playerInGroup(p, group) && !slotIdForNumber(team, p.number)
        );
        const varsityOnField = available.filter((p) => {
          const sid = slotIdForNumber(team, p.number);
          return p.squad !== "jv" && sid && Number(sid) !== Number(slot?.id);
        });
        const jv = available.filter((p) => p.squad === "jv");
        body =
          (preferred.length ? `<div class="shot-quick-label">${escapeHtml(groupLabel)}</div>${preferred.map((p) => btn(p, "")).join("")}` : "") +
          (varsityBench.length ? `<div class="shot-quick-label">Varsity Bench</div>${varsityBench.map((p) => btn(p, "")).join("")}` : "") +
          (varsityOnField.length
            ? `<div class="shot-quick-label">Varsity On-Field</div>${varsityOnField
                .map((p) => btn(p, slotCodeForId(slotIdForNumber(team, p.number))))
                .join("")}`
            : "") +
          (jv.length ? `<div class="shot-quick-label">JV</div>${jv.map((p) => btn(p, "JV")).join("")}` : "");
      } else {
        body = available.length
          ? `<div class="shot-quick-label">Roster</div>${available.map((p) => btn(p, "")).join("")}`
          : "";
      }
      if (!body) body = `<p class="muted">No available players — add a number.</p>`;
      playerGrid.innerHTML = `
        <div class="shot-team-bar">
          <div class="shot-team-actions">
            <button type="button" class="btn btn-ghost shot-bar-btn" data-player-add="1">Add number</button>
          </div>
        </div>
        ${body}`;
      return;
    }

    const chosen = shotModalDraft.action;
    const pickingFouler = phase === "fouler";
    const team = pickingFouler ? shotModalDraft.foulerPickTeam || oppositeTeam(recordingTeam()) : recordingTeam();
    title.textContent = pickingFouler ? "Who committed the infringement?" : playerWhoLabel(chosen);
    const missBit = shotModalDraft.missDirection
      ? ` · ${MISS_DIRECTION_LABELS[shotModalDraft.missDirection]}`
      : "";
    const foulerBit =
      !pickingFouler && shotModalDraft.foulerPicked
        ? ` · foul: ${playerLabel(shotModalDraft.fouler ? Object.assign({ team: shotModalDraft.fouler.team || oppositeTeam(recordingTeam()) }, shotModalDraft.fouler) : null)}`
        : "";
    locEl.textContent = chosen
      ? `${actionShortLabel(chosen)}${chosen.kind === "assist" ? " assist" : ""}${missBit}${foulerBit}  ·  ${locText}`
      : locText;
    const onField = team === "opp" ? [] : onFieldPlayers(team);
    const showFormation = team !== "opp" && onField.length > 0;
    const lockedPos = team === "opp" ? "" : shotModalDraft.position || "";
    if (playerHeading) {
      playerHeading.hidden = false;
      playerHeading.textContent = pickingFouler
        ? "Usually the other team. Unknown is fine."
          : team === "opp"
          ? "Pick a name or number. Unknown is fine."
          : lockedPos
            ? `Who at ${lockedPos}? Tap a player, or Unknown to save without a number.`
            : "Who? Tap a player or Unknown.";
    }
    playerGrid.hidden = false;
    actionGrid.hidden = true;
    if (posGrid) posGrid.hidden = true;

    const rosterList = sortPlayers(rosterPlayers(team));
    const usLabel = ourTeamName();
    const oppLabel = opponentOf(st.game)?.name || "Opponent";
    const justAdded = shotModalDraft.justAddedNumber
      ? rosterList.find((p) => String(p.number) === String(shotModalDraft.justAddedNumber))
      : null;

    const posLockBar =
      !pickingFouler && team === "us" && lockedPos
        ? `<div class="shot-pos-lock">
            <span>Position <strong>${escapeHtml(lockedPos)}</strong></span>
            <button type="button" class="btn btn-ghost shot-bar-btn" data-change-position="1">Change</button>
          </div>`
        : "";

    const toolbar = `
      <div class="shot-team-bar">
        <div class="half-toggle shot-team-toggle" role="tablist" aria-label="${pickingFouler ? "Fouler team" : "Recording team"}">
          <button type="button" class="half-toggle-btn ${team === "us" ? "is-on" : ""}" data-shot-team="us">${escapeHtml(usLabel)}</button>
          <button type="button" class="half-toggle-btn ${team === "opp" ? "is-on" : ""}" data-shot-team="opp">${escapeHtml(oppLabel)}</button>
        </div>
        ${posLockBar}
        <div class="shot-team-actions">
          ${
            team === "us" && !pickingFouler
              ? `<button type="button" class="btn btn-ghost shot-bar-btn is-sub-in" data-sub-in="1">Sub player in</button>`
              : ""
          }
          <button type="button" class="btn btn-ghost shot-bar-btn" data-player-skip="1">Unknown</button>
          <button type="button" class="btn btn-ghost shot-bar-btn" data-player-add="1">Add number</button>
        </div>
      </div>`;

    const playerBtn = (p, extra = "", selected = false) => {
      if (team === "opp") {
        const named = opponentShortName(p);
        const posHint = opponentPosHint(p);
        const label = named ? escapeHtml(named) : `#${escapeHtml(String(p.number))}`;
        const meta = [`#${escapeHtml(String(p.number))}`];
        if (posHint) meta.push(escapeHtml(posHint));
        if (extra) meta.push(escapeHtml(extra));
        return `
        <button type="button" class="shot-player-btn ${selected ? "is-selected" : ""}" data-player-number="${escapeHtml(String(p.number))}" data-player-id="${escapeHtml(p.id || "")}" data-player-team="${team}" data-slot-code="${escapeHtml(p.slotCode || "")}">
          <span class="name">${label}</span>
          <span class="num">${meta.join(" · ")}</span>
        </button>`;
      }
      const label = escapeHtml(playerDisplayName(p));
      const posHint = p.slotCode ? ` · ${p.slotCode}` : "";
      return `
        <button type="button" class="shot-player-btn ${selected ? "is-selected" : ""}" data-player-number="${escapeHtml(String(p.number))}" data-player-id="${escapeHtml(p.id || "")}" data-player-team="${team}" data-slot-code="${escapeHtml(p.slotCode || "")}">
          <span class="name">${label}</span>
          <span class="num">${escapeHtml(String(p.number))}${posHint}${extra ? ` · ${escapeHtml(extra)}` : ""}</span>
        </button>`;
    };

    const formationPickCards = (forTeam) =>
      FORMATION_LAYOUT.map((layout) => {
        const p = slotPlayer(forTeam, layout.id);
        const isLockedSlot = !pickingFouler && lockedPos === layout.code;
        if (!p) {
          return `
            <div class="formation-card is-empty ${isLockedSlot ? "is-pos-on" : ""}" style="${formationCardStyle(layout)}">
              <span class="formation-card-name">Empty</span>
              <span class="formation-card-meta">${escapeHtml(layout.code)}</span>
            </div>`;
        }
        return `
          <button type="button" class="formation-card is-pick ${isLockedSlot ? "is-pos-on" : ""}" style="${formationCardStyle(layout)}" data-player-number="${escapeHtml(String(p.number))}" data-player-id="${escapeHtml(p.id || "")}" data-player-team="${forTeam}" data-slot-code="${escapeHtml(layout.code)}">
            <span class="formation-card-name">${escapeHtml(playerDisplayName(p))}</span>
            <span class="formation-card-meta">${formationMeta(layout.code, p)}</span>
          </button>`;
      }).join("");

    const opponentPickerBody = () => {
      const optFor = (p, prefix) => {
        const rostered = rosterList.find((x) => String(x.number) === String(p.number)) || p;
        const named = opponentShortName(rostered);
        const label = named ? `${named} (#${rostered.number})` : `#${p.number}`;
        const id = rostered.id || p.id || "";
        return `<option value="${escapeHtml(`${prefix}-${p.number}`)}" data-number="${escapeHtml(String(p.number))}" data-player-id="${escapeHtml(id)}" data-player-team="opp">${escapeHtml(label)}</option>`;
      };
      const playerForNum = (num) =>
        rosterList.find((x) => String(x.number) === String(num)) || { number: num, id: "", team: "opp" };
      const thisGameOpts = usedThisGameNumbers("opp")
        .map((num) => optFor(playerForNum(num), "g"))
        .join("");
      const rosterOpts = rosterList.map((p) => optFor(p, "r")).join("");
      const allOpts = jerseyChoices()
        .map((num) => optFor(playerForNum(num), "n"))
        .join("");
      const groups = [];
      if (thisGameOpts) groups.push(`<optgroup label="This game">${thisGameOpts}</optgroup>`);
      if (rosterOpts) groups.push(`<optgroup label="Roster">${rosterOpts}</optgroup>`);
      groups.push(`<optgroup label="All Numbers">${allOpts}</optgroup>`);
      return `
        <label class="sr-only" for="shot-opp-pick">Opponent player</label>
        <select id="shot-opp-pick" class="shot-opp-select" data-opp-pick="1">
          <optgroup label="Pick a player">
            <option value="" selected disabled>Pick a player</option>
          </optgroup>
          ${groups.join("")}
        </select>`;
    };

    let html = toolbar;
    if (justAdded && team !== "opp") {
      html += `<div class="shot-quick-label">Just added</div>${playerBtn(justAdded, "new", true)}`;
    }
    if (team === "opp") {
      html += opponentPickerBody();
    } else if (showFormation) {
      html += formationPitchShell(formationPickCards(team), "", { team });
    } else {
      const rest = rosterList.filter((p) => String(p.number) !== String(shotModalDraft.justAddedNumber || ""));
      html += rest.map((p) => playerBtn(p)).join("");
      if (!justAdded && !rest.length) {
        html += `<p class="muted shot-empty-roster">No roster loaded — tap Add number.</p>`;
      }
    }
    playerGrid.classList.toggle("is-formation", html.includes("formation-pitch"));
    playerGrid.innerHTML = html;
  }

  function playerFromRoster(team, playerId, number) {
    const onField = onFieldPlayers(team);
    if (playerId) {
      const fromField = onField.find((p) => p.id === playerId);
      if (fromField) return fromField;
    }
    if (number != null && number !== "") {
      const fromField = onField.find((p) => String(p.number) === String(number));
      if (fromField) return fromField;
    }
    const list = rosterPlayers(team);
    if (playerId) return list.find((p) => p.id === playerId) || null;
    if (number != null && number !== "") return list.find((p) => String(p.number) === String(number)) || null;
    return null;
  }

  function openNumberPicker(onPick, team = recordingTeam()) {
    const modal = $("#number-pick-modal");
    const select = $("#number-pick-select");
    if (!modal || !select) return;
    const used = new Set(rosterPlayers(team).map((p) => String(p.number)));
    select.innerHTML = jerseyChoices()
      .map((num) => `<option value="${num}" ${used.has(num) ? "disabled" : ""}>${num}</option>`)
      .join("");
    const first = jerseyChoices().find((n) => !used.has(n));
    if (first) select.value = first;
    modal.hidden = false;
    const confirmBtn = $("#number-pick-confirm");
    const cancelBtns = $$("[data-close-number-pick]");
    const finish = (picked) => {
      modal.hidden = true;
      confirmBtn.onclick = null;
      cancelBtns.forEach((el) => {
        el.onclick = null;
      });
      if (picked) onPick(picked);
    };
    confirmBtn.onclick = () => {
      const value = String(select.value || "");
      if (!value) {
        showToast("Pick a jersey number");
        return;
      }
      const opt = Array.from(select.options).find((o) => o.value === value);
      if (opt?.disabled) {
        showToast("That number is already on the roster");
        return;
      }
      finish(value);
    };
    cancelBtns.forEach((el) => {
      el.onclick = () => finish(null);
    });
  }

  function playerFromRosterRow(team, row, number) {
    if (!row && (number == null || number === "")) return null;
    return {
      id: row?.player_id || row?.player?.id || "",
      number: String(row?.jersey_number ?? number),
      name: row?.player?.name || null,
      short: row?.player?.short_name || null,
      short_name: row?.player?.short_name || null,
      team,
    };
  }

  async function refreshRosterFor(team) {
    const teamId = teamIdFor(team);
    if (!teamId || !st.game?.season_id) throw new Error("No team/season for roster");
    const rows = await API.roster(teamId, st.game.season_id);
    if (team === "us") st.ourRoster = rows;
    else st.oppRoster = rows;
    return rows;
  }

  async function refreshRecordingRoster() {
    return refreshRosterFor(recordingTeam());
  }

  async function pickNewJersey() {
    const team =
      shotModalDraft.phase === "fouler"
        ? shotModalDraft.foulerPickTeam || oppositeTeam(recordingTeam())
        : recordingTeam();
    openNumberPicker(async (num) => {
      try {
        const teamId = teamIdFor(team);
        if (!teamId) throw new Error("No team selected");
        const row = await API.ensureRosterPlayer(teamId, st.game.season_id, num, null);
        await refreshRosterFor(team);
        const player =
          playerFromRoster(team, row?.player_id || row?.player?.id, num) || playerFromRosterRow(team, row, num);
        if (!player) throw new Error("Number saved but not on roster yet");
        player.team = team;
        shotModalDraft.justAddedNumber = String(num);

        if (shotModalDraft.phase === "fouler") {
          await applyShotPersonPick(team, player.id, num, "");
          return;
        }

        if (shotModalDraft.phase === "sub-pick" && shotModalDraft.subSlotId) {
          const slot = POSITION_SLOTS.find((s) => s.id === Number(shotModalDraft.subSlotId));
          if (!slot) throw new Error("No position selected");
          assignPlayerToShotPosition(team, player, slot.code);
          shotModalDraft.position = slot.code;
          shotModalDraft.player = player;
          shotModalDraft.subSlotId = null;
          showToast(`#${num} in at ${slot.code}`);
          await afterTakerPicked();
          return;
        }

        if (shotModalDraft.position) {
          assignPlayerToShotPosition(team, player);
          shotModalDraft.player = player;
          showToast(`#${num} in at ${shotModalDraft.position}`);
          await afterTakerPicked();
          return;
        }

        if (team === "opp" && shotModalDraft.phase === "player") {
          shotModalDraft.player = player;
          await afterTakerPicked();
          return;
        }

        showToast(`#${num} added — tap to use`);
        renderShotModal();
      } catch (err) {
        showToast(err.message || "Could not add number");
      }
    }, team);
  }

  async function afterTakerPicked() {
    if (shotModalDraft.action?.result === "foul") {
      shotModalDraft.fkOutcome = "";
      shotModalDraft.missDirection = "";
      shotModalDraft.phase = "fk-result";
      renderShotModal();
      return;
    }
    if (shotModalDraft.action?.result === "corner") {
      shotModalDraft.fkOutcome = "";
      shotModalDraft.missDirection = "";
      shotModalDraft.phase = "corner-result";
      renderShotModal();
      return;
    }
    await completeShotModal();
  }

  function stashAssistAndWait(player) {
    const next = draftAssistFromModal(player);
    const foulerBag = {
      fouler: shotModalDraft.fouler,
      foulerPicked: shotModalDraft.foulerPicked,
      foulerPickTeam: shotModalDraft.foulerPickTeam,
    };
    if (st.pending?.assist && !st.pending?.secondAssist) {
      st.pending = Object.assign({ secondAssist: st.pending.assist, assist: next }, foulerBag);
      st.mode = "awaiting-shot-location";
      closeShotModal();
      shotModalDraft.location = null;
      draw();
      showToast("Tap where the shot was taken");
      return;
    }
    st.pending = Object.assign({}, st.pending, { assist: next }, foulerBag);
    st.mode = "awaiting-shot-location";
    closeShotModal();
    shotModalDraft.location = null;
    draw();
    showToast("Tap the next pass or the shot");
  }

  async function completeShotModal() {
    const action = shotModalDraft.action;
    if (!action) return;
    const player = shotModalDraft.player || null;
    if (action.kind === "assist") {
      stashAssistAndWait(player);
      return;
    }
    if (action.kind === "shot") {
      const assist = st.pending?.assist || null;
      const secondAssist = st.pending?.secondAssist || null;
      const result = effectiveShotResult() || action.result;
      await commitShotEvent(result, player, assist, secondAssist);
    }
  }

  function payloadFromDraft(result, shooter, assist, secondAssist) {
    const loc = shotModalDraft.location;
    const teamId = recordingTeamId();
    const saveFouler =
      shotModalDraft.foulerPicked || RESULTS_NEEDING_FOULER.has(result) || result === "foul";
    return {
      id: global.crypto.randomUUID(),
      game_id: st.gameId,
      period: st.period,
      team_id: teamId,
      player_id: shooter?.id || null,
      jersey_number_at_time: shooter ? String(shooter.number) : null,
      position: shotModalDraft.position || null,
      x: loc.x,
      y: loc.y,
      zone_id: loc.zoneId,
      zone_label: loc.zoneLabel,
      result,
      miss_direction: RESULTS_NEEDING_MISS_DIR.has(result) ? shotModalDraft.missDirection || null : null,
      fouler_player_id: saveFouler ? shotModalDraft.fouler?.id || null : null,
      fouler_jersey_number_at_time: saveFouler
        ? shotModalDraft.fouler
          ? String(shotModalDraft.fouler.number)
          : null
        : null,
      ...linkedPlayFields(assist, "assist"),
      ...linkedPlayFields(secondAssist, "second_assist"),
      game_clock_seconds: stampClockSeconds(),
    };
  }

  async function commitShotEvent(result, shooter, assist, secondAssist) {
    const loc = shotModalDraft.location;
    if (!loc) return;
    const team = recordingTeam();
    const payload = payloadFromDraft(result, shooter, assist, secondAssist);
    const view = mapShot({
      ...payload,
      created_at: new Date().toISOString(),
      player: shooter ? { id: shooter.id, name: shooter.name, short_name: shooter.short } : null,
      fouler: shotModalDraft.fouler
        ? {
            id: shotModalDraft.fouler.id,
            name: shotModalDraft.fouler.name,
            short_name: shotModalDraft.fouler.short || shotModalDraft.fouler.short_name,
          }
        : null,
      assist_player: assist?.player
        ? { id: assist.player.id, name: assist.player.name, short_name: assist.player.short }
        : null,
      second_assist_player: secondAssist?.player
        ? {
            id: secondAssist.player.id,
            name: secondAssist.player.name,
            short_name: secondAssist.player.short,
          }
        : null,
      saveFailed: false,
      pendingPayload: payload,
    });
    view.team = team;
    view.shooterNumber = shooter ? String(shooter.number) : "";
    if (view.assist && assist?.player) view.assist.number = String(assist.player.number || "");
    if (view.secondAssist && secondAssist?.player) {
      view.secondAssist.number = String(secondAssist.player.number || "");
    }
    st.shots = [view, ...st.shots];
    closeShotModal();
    resetTrackerDraft();
    draw();
    const missBit = view.missDirection ? ` (${MISS_DIRECTION_LABELS[view.missDirection]})` : "";
    const foulerBit = view.foulerNumber || view.foulerName || view.foulerShort
      ? ` · foul: ${eventPersonLabel(oppositeTeam(team), view.foulerNumber, view.foulerName, view.foulerShort)}`
      : "";
    const extra = view.assist
      ? ` (assist: ${view.assist.number ? (team === "opp" ? `Opp #${view.assist.number}` : view.assist.short || firstName(view.assist.name) || `#${view.assist.number}`) : "untagged"}${
          view.secondAssist
            ? ` · 2nd: ${
                view.secondAssist.number
                  ? team === "opp"
                    ? `Opp #${view.secondAssist.number}`
                    : view.secondAssist.short || firstName(view.secondAssist.name) || `#${view.secondAssist.number}`
                  : "untagged"
              }`
            : ""
        })`
      : "";
    showToast(`${SHOT_RESULT_LABELS[result]}${missBit} — ${playerLabel(shooter ? Object.assign({ team }, shooter) : null)}${foulerBit}${extra}`);
    const saved = await API.insertShot(payload);
    if (!saved.ok) {
      view.saveFailed = true;
      view.pendingPayload = payload;
      showToast("Not saved — check connection");
      draw({ keepScroll: true });
      return;
    }
    const idx = st.shots.findIndex((s) => s.id === view.id);
    if (idx >= 0) st.shots[idx] = mapShot(saved.data);
    draw({ keepScroll: true });
  }

  async function retryShot(id) {
    const ev = st.shots.find((s) => s.id === id);
    if (!ev?.pendingPayload) return;
    const saved = await API.insertShot(ev.pendingPayload);
    if (!saved.ok) {
      showToast("Not saved — check connection");
      return;
    }
    const idx = st.shots.findIndex((s) => s.id === id);
    if (idx >= 0) st.shots[idx] = mapShot(saved.data);
    showToast("Saved");
    draw({ keepScroll: true });
  }

  /** Retry every unsaved insert on this device. */
  async function retryFailedShots() {
    const failed = st.shots.filter((s) => s.saveFailed && s.pendingPayload);
    let saved = 0;
    let stillFailed = 0;
    for (const ev of failed) {
      const result = await API.insertShot(ev.pendingPayload);
      if (!result.ok) {
        stillFailed += 1;
        continue;
      }
      saved += 1;
      const idx = st.shots.findIndex((s) => s.id === ev.id);
      if (idx >= 0) st.shots[idx] = mapShot(result.data);
    }
    return { attempted: failed.length, saved, stillFailed };
  }

  /**
   * Push pending failed saves, then replace the list from Supabase.
   * Keeps any rows that still failed to save so they are not lost on pull.
   */
  async function syncGameShots() {
    if (!st.gameId || st.syncing) return;
    st.syncing = true;
    draw({ keepScroll: true });
    try {
      const push = await retryFailedShots();
      const pendingKeep = st.shots.filter((s) => s.saveFailed && s.pendingPayload);
      await loadGameContext();
      const remoteIds = new Set(st.shots.map((s) => s.id));
      const orphans = pendingKeep.filter((s) => !remoteIds.has(s.id));
      if (orphans.length) st.shots = [...orphans, ...st.shots];
      const n = st.shots.length;
      if (push.stillFailed) showToast(`Synced — ${n} shots · ${push.stillFailed} not saved`);
      else if (push.saved) showToast(`Synced — ${n} shots · saved ${push.saved}`);
      else showToast(`Synced — ${n} shots`);
    } catch (err) {
      showToast(err.message || "Sync failed — check connection");
    } finally {
      st.syncing = false;
      draw({ keepScroll: true });
    }
  }

  async function applyShotPersonPick(team, playerId, number, slotCode = "") {
    if (number == null || number === "") return;
    const picked = playerFromRoster(team, playerId, number) || {
      id: playerId || "",
      number: String(number),
      name: null,
      short: null,
      team,
    };
    picked.team = team;
    shotModalDraft.justAddedNumber = "";
    if (shotModalDraft.phase === "fouler") {
      shotModalDraft.fouler = picked;
      shotModalDraft.foulerPicked = true;
      shotModalDraft.foulerPickTeam = team;
      advanceAfterAction();
      return;
    }
    shotModalDraft.player = picked;
    if (!shotModalDraft.position && slotCode) shotModalDraft.position = slotCode;
    else if (!shotModalDraft.position && shotModalDraft.player?.slotCode) {
      shotModalDraft.position = shotModalDraft.player.slotCode;
    }
    if (recordingNeedsPosition() && !shotModalDraft.position) {
      showToast("Pick a position first");
      shotModalDraft.phase = "position";
      shotModalDraft.player = null;
      renderShotModal();
      return;
    }
    assignPlayerToShotPosition(team, picked);
    await afterTakerPicked();
  }

  function bindShotModal() {
    if (!shotModal || shotModal.dataset.bound === "1") return;
    shotModal.dataset.bound = "1";
    shotModal.addEventListener("change", async (e) => {
      const sel = e.target.closest("[data-opp-pick]");
      if (!sel || !sel.value) return;
      const opt = sel.selectedOptions[0];
      if (!opt) return;
      const number = opt.getAttribute("data-number");
      const playerId = opt.getAttribute("data-player-id") || "";
      const team = opt.getAttribute("data-player-team") === "us" ? "us" : "opp";
      await applyShotPersonPick(team, playerId, number, "");
    });
    shotModal.addEventListener("click", async (e) => {
      const pickPos = e.target.closest("[data-pick-position]");
      if (pickPos) {
        const code = pickPos.getAttribute("data-pick-position") || "";
        const team = pickPos.getAttribute("data-player-team") === "opp" ? "opp" : "us";
        const number = pickPos.getAttribute("data-player-number");
        const playerId = pickPos.getAttribute("data-player-id") || "";
        if (st.team !== team) {
          st.team = team;
          saveUi();
        }
        shotModalDraft.position = code;
        shotModalDraft.justAddedNumber = "";
        if (number != null && number !== "") {
          const picked = playerFromRoster(team, playerId, number) || {
            id: playerId,
            number: String(number),
            name: null,
            short: null,
            team,
          };
          picked.team = team;
          shotModalDraft.player = picked;
        } else {
          shotModalDraft.player = null;
        }
        await afterTakerPicked();
        return;
      }
      const pickFouler = e.target.closest("[data-pick-fouler]");
      if (pickFouler) {
        const team = pickFouler.getAttribute("data-player-team") === "opp" ? "opp" : "us";
        const number = pickFouler.getAttribute("data-player-number");
        const playerId = pickFouler.getAttribute("data-player-id") || "";
        shotModalDraft.foulerPickTeam = team;
        shotModalDraft.justAddedNumber = "";
        if (number != null && number !== "") {
          const picked = playerFromRoster(team, playerId, number) || {
            id: playerId,
            number: String(number),
            name: null,
            short: null,
            team,
          };
          picked.team = team;
          shotModalDraft.fouler = picked;
        } else {
          shotModalDraft.fouler = null;
        }
        shotModalDraft.foulerPicked = true;
        advanceAfterAction();
        return;
      }
      const makeChange = e.target.closest("[data-make-change]");
      if (makeChange) {
        if (st.team !== "us") {
          st.team = "us";
          saveUi();
        }
        shotModalDraft.phase = "sub-slot";
        shotModalDraft.subSlotId = null;
        renderShotModal();
        return;
      }
      if (e.target.closest("[data-change-position]")) {
        shotModalDraft.phase = "position";
        shotModalDraft.position = "";
        shotModalDraft.player = null;
        shotModalDraft.justAddedNumber = "";
        renderShotModal();
        return;
      }
      const missBtn = e.target.closest("[data-miss-dir]");
      if (missBtn) {
        shotModalDraft.missDirection = missBtn.getAttribute("data-miss-dir") || "";
        if (shotModalDraft.fkOutcome && shotModalDraft.position) {
          await completeShotModal();
          return;
        }
        advanceAfterAction();
        return;
      }
      const restartAssistBtn = e.target.closest("[data-restart-assist]");
      if (restartAssistBtn) {
        const type = restartAssistBtn.getAttribute("data-restart-assist");
        const action = TRACKER_ASSIST_ACTIONS.find((a) => a.type === type);
        if (!action) return;
        shotModalDraft.action = action;
        shotModalDraft.fkOutcome = "";
        shotModalDraft.missDirection = "";
        await completeShotModal();
        return;
      }
      const restartResultBtn = e.target.closest("[data-restart-result], [data-fk-result]");
      if (restartResultBtn) {
        shotModalDraft.fkOutcome =
          restartResultBtn.getAttribute("data-restart-result") ||
          restartResultBtn.getAttribute("data-fk-result") ||
          "foul";
        shotModalDraft.missDirection = "";
        if (RESULTS_NEEDING_MISS_DIR.has(shotModalDraft.fkOutcome)) {
          shotModalDraft.phase = "miss-dir";
          renderShotModal();
          return;
        }
        await completeShotModal();
        return;
      }
      const teamBtn = e.target.closest("[data-shot-team]");
      if (teamBtn) {
        const next = teamBtn.getAttribute("data-shot-team") === "opp" ? "opp" : "us";
        if (shotModalDraft.phase === "fouler") {
          if (shotModalDraft.foulerPickTeam !== next) {
            shotModalDraft.foulerPickTeam = next;
            shotModalDraft.fouler = null;
            shotModalDraft.justAddedNumber = "";
          }
          renderShotModal();
          return;
        }
        if (st.team !== next) {
          st.team = next;
          saveUi();
          shotModalDraft.player = null;
          shotModalDraft.position = "";
          shotModalDraft.justAddedNumber = "";
          if (shotModalDraft.phase === "player" || shotModalDraft.phase === "position") {
            shotModalDraft.phase = takerPhaseFor(next);
          }
        }
        renderShotModal();
        return;
      }
      if (e.target.closest("[data-sub-in]")) {
        shotModalDraft.phase = "sub-slot";
        shotModalDraft.subSlotId = null;
        renderShotModal();
        return;
      }
      const subSlotBtn = e.target.closest("[data-sub-slot-pick]");
      if (subSlotBtn) {
        shotModalDraft.subSlotId = Number(subSlotBtn.getAttribute("data-sub-slot-pick"));
        shotModalDraft.phase = "sub-pick";
        renderShotModal();
        return;
      }
      const subPickBtn = e.target.closest("[data-sub-pick-number]");
      if (subPickBtn) {
        const team = recordingTeam();
        const slotId = Number(shotModalDraft.subSlotId);
        const slot = POSITION_SLOTS.find((s) => s.id === slotId);
        const number = subPickBtn.getAttribute("data-sub-pick-number");
        const playerId = subPickBtn.getAttribute("data-sub-pick-id");
        const player = playerFromRoster(team, playerId, number);
        if (!player || !slot) return;
        const payload = lineupPlayerPayload(player);
        const elsewhere = slotIdForNumber(team, payload.number);
        if (elsewhere && Number(elsewhere) !== Number(slotId)) assignSlot(team, elsewhere, null);
        assignSlot(team, slotId, payload);
        shotModalDraft.position = slot.code;
        shotModalDraft.player = Object.assign({ team }, player);
        shotModalDraft.subSlotId = null;
        shotModalDraft.justAddedNumber = "";
        showToast(`${playerDisplayName(player) || `#${player.number}`} in at ${slot.code}`);
        await afterTakerPicked();
        return;
      }
      if (e.target.closest("[data-player-skip]")) {
        if (shotModalDraft.phase === "fouler") {
          shotModalDraft.fouler = null;
          shotModalDraft.foulerPicked = true;
          shotModalDraft.justAddedNumber = "";
          advanceAfterAction();
          return;
        }
        if (recordingNeedsPosition() && !shotModalDraft.position) {
          showToast("Pick a position first");
          shotModalDraft.phase = "position";
          renderShotModal();
          return;
        }
        shotModalDraft.player = null;
        await afterTakerPicked();
        return;
      }
      if (e.target.closest("[data-player-add]")) {
        pickNewJersey();
        return;
      }
      const playerBtn = e.target.closest("[data-player-number]");
      if (playerBtn) {
        const team = playerBtn.getAttribute("data-player-team") || recordingTeam();
        const number = playerBtn.getAttribute("data-player-number");
        const playerId = playerBtn.getAttribute("data-player-id");
        const slotCode = playerBtn.getAttribute("data-slot-code") || "";
        await applyShotPersonPick(team, playerId, number, slotCode);
        return;
      }
      const actionBtn = e.target.closest("[data-action-id]");
      if (actionBtn) {
        const action = TRACKER_FIRST_ACTIONS.find((a) => a.id === actionBtn.getAttribute("data-action-id"));
        if (!action) return;
        shotModalDraft.action = action;
        shotModalDraft.missDirection = "";
        shotModalDraft.fkOutcome = "";
        if (shotModalDraft.step === "first") {
          shotModalDraft.fouler = null;
          shotModalDraft.foulerPicked = false;
          shotModalDraft.foulerPickTeam = oppositeTeam(recordingTeam());
        }
        advanceAfterAction();
      }
    });
    $("#shot-modal-back")?.addEventListener("click", () => {
      if (shotModalDraft.phase === "sub-pick") {
        shotModalDraft.phase = "sub-slot";
        shotModalDraft.subSlotId = null;
        renderShotModal();
        return;
      }
      if (shotModalDraft.phase === "sub-slot") {
        shotModalDraft.phase = "position";
        shotModalDraft.subSlotId = null;
        renderShotModal();
        return;
      }
      if (shotModalDraft.phase === "player") {
        if (recordingNeedsPosition()) {
          shotModalDraft.phase = "position";
          shotModalDraft.position = "";
          shotModalDraft.player = null;
          shotModalDraft.justAddedNumber = "";
          renderShotModal();
          return;
        }
        shotModalDraft.player = null;
        shotModalDraft.justAddedNumber = "";
        if (needsMissDirection(shotModalDraft.action)) {
          shotModalDraft.phase = "miss-dir";
          shotModalDraft.missDirection = "";
          renderShotModal();
          return;
        }
        if (needsFoulerStep(shotModalDraft.action)) {
          shotModalDraft.phase = "fouler";
          shotModalDraft.foulerPicked = false;
          shotModalDraft.fouler = null;
          renderShotModal();
          return;
        }
        shotModalDraft.phase = "action";
        shotModalDraft.action = null;
        shotModalDraft.fkOutcome = "";
        renderShotModal();
        return;
      }
      if (shotModalDraft.phase === "fk-result" || shotModalDraft.phase === "corner-result") {
        shotModalDraft.phase = takerPhaseFor(recordingTeam());
        shotModalDraft.fkOutcome = "";
        shotModalDraft.missDirection = "";
        shotModalDraft.position = "";
        shotModalDraft.player = null;
        renderShotModal();
        return;
      }
      if (
        shotModalDraft.phase === "miss-dir" &&
        (shotModalDraft.action?.result === "foul" || shotModalDraft.action?.result === "corner") &&
        shotModalDraft.fkOutcome
      ) {
        shotModalDraft.phase = shotModalDraft.action.result === "corner" ? "corner-result" : "fk-result";
        shotModalDraft.missDirection = "";
        renderShotModal();
        return;
      }
      if (shotModalDraft.phase === "position" && needsMissDirection(shotModalDraft.action)) {
        shotModalDraft.phase = "miss-dir";
        shotModalDraft.position = "";
        shotModalDraft.missDirection = "";
        renderShotModal();
        return;
      }
      if (shotModalDraft.phase === "position" && needsFoulerStep(shotModalDraft.action)) {
        shotModalDraft.phase = "fouler";
        shotModalDraft.position = "";
        shotModalDraft.foulerPicked = false;
        shotModalDraft.fouler = null;
        renderShotModal();
        return;
      }
      if (shotModalDraft.phase === "position") {
        shotModalDraft.phase = "action";
        shotModalDraft.action = null;
        shotModalDraft.position = "";
        shotModalDraft.fkOutcome = "";
        renderShotModal();
        return;
      }
      if (shotModalDraft.phase === "miss-dir" && needsFoulerStep(shotModalDraft.action)) {
        shotModalDraft.phase = "fouler";
        shotModalDraft.missDirection = "";
        shotModalDraft.foulerPicked = false;
        shotModalDraft.fouler = null;
        renderShotModal();
        return;
      }
      if (shotModalDraft.phase === "miss-dir" || shotModalDraft.phase === "fouler") {
        shotModalDraft.phase = "action";
        shotModalDraft.action = null;
        shotModalDraft.missDirection = "";
        shotModalDraft.fkOutcome = "";
        shotModalDraft.fouler = null;
        shotModalDraft.foulerPicked = false;
        renderShotModal();
        return;
      }
      shotModalDraft.phase = "action";
      shotModalDraft.player = null;
      shotModalDraft.fouler = null;
      shotModalDraft.foulerPicked = false;
      shotModalDraft.action = null;
      shotModalDraft.missDirection = "";
      shotModalDraft.fkOutcome = "";
      shotModalDraft.subSlotId = null;
      renderShotModal();
    });
    $("#shot-goto-lineup")?.addEventListener("click", () => {
      dismissShotModal();
      setTimeout(() => $("#lineup-section")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    });
    $$("[data-close-shot-modal]").forEach((el) =>
      el.addEventListener("click", () => {
        const openedAt = Number(shotModal.dataset.openedAt || 0);
        if (Date.now() - openedAt < 450) return;
        dismissShotModal();
      })
    );
  }

  function bindTrackerPitches() {
    const awaitingShot = awaitingFollowUp();
    $$("#tracker-pitch-us [data-pitch-team], #tracker-pitch-opp [data-pitch-team]").forEach((svg) => {
      const team = svg.getAttribute("data-pitch-team");
      const wrap = svg.closest(".tracker-pitch-wrap");
      const block = svg.closest(".tracker-pitch-block");
      const canSecondTap = awaitingShot && recordingTeam() === team;
      wrap?.classList.toggle("is-recording", canSecondTap || !awaitingShot);
      block?.classList.toggle("is-active", canSecondTap || (!awaitingShot && recordingTeam() === team));
      let lastTapAt = 0;
      let lastTapX = 0;
      let lastTapY = 0;
      const onTap = (evt) => {
        if (!shotModal.hidden) return;
        const now = Date.now();
        const p = svgEventPoint(svg, evt);
        const pitchSwapped = team === "opp" ? !st.swapSides : !!st.swapSides;
        const pitch = pitchFromSvgPoint(p.x, p.y, pitchSwapped);
        const loc = locatePitchPoint(pitch.x, pitch.y);
        const nearPrev = Math.hypot(p.x - lastTapX, p.y - lastTapY) < 8;
        const isDouble = now - lastTapAt < 420 && nearPrev;
        lastTapAt = now;
        lastTapX = p.x;
        lastTapY = p.y;
        evt.preventDefault();
        evt.stopPropagation();

        if (awaitingShot) {
          if (recordingTeam() !== team) {
            showToast("Finish this shot on the same team’s pitch");
            return;
          }
          fillShotModal(canChainAssist() ? "follow" : "shot", loc);
          draw({ keepScroll: true });
          return;
        }

        if (!isDouble) return;
        st.team = team === "opp" ? "opp" : "us";
        st.mode = "idle";
        st.pending = null;
        saveUi();
        fillShotModal("first", loc);
        draw({ keepScroll: true });
      };
      svg.addEventListener("pointerup", onTap);
    });
  }

  function trackerSummary(events) {
    const n = (result) => events.filter((e) => e.result === result).length;
    const assists = events.filter((e) => e.assist).length;
    const secondAssists = events.filter((e) => e.secondAssist).length;
    return {
      goals: n("goal") + n("pk-goal"),
      onTarget: n("on-target"),
      blocked: n("blocked"),
      missed: n("missed") + n("pk-missed"),
      fouls: n("foul"),
      corners: n("corner"),
      pks: n("pk-goal") + n("pk-missed"),
      assists,
      secondAssists,
      total: events.length,
    };
  }

  function summaryPills(sum) {
    return `
      <span class="pill">Plays <strong>${sum.total}</strong></span>
      <span class="pill">Goals <strong>${sum.goals}</strong></span>
      <span class="pill">On target <strong>${sum.onTarget}</strong></span>
      <span class="pill">Blocked <strong>${sum.blocked}</strong></span>
      <span class="pill">Missed <strong>${sum.missed}</strong></span>
      <span class="pill">Free kicks <strong>${sum.fouls}</strong></span>
      <span class="pill">Corners <strong>${sum.corners}</strong></span>
      <span class="pill">PKs <strong>${sum.pks}</strong></span>
      <span class="pill">Assists <strong>${sum.assists}</strong></span>
      <span class="pill">2nd assists <strong>${sum.secondAssists}</strong></span>`;
  }

  function unitsBreakdown(events) {
    const posCounts = {};
    const pairCounts = {};
    const missByPlayer = {};
    events.forEach((ev) => {
      if (eventTeam(ev) !== "us") return;
      const shotResults = ["goal", "on-target", "blocked", "missed", "pk-goal", "pk-missed"];
      if (!shotResults.includes(ev.result)) return;
      const pos = ev.position || "—";
      posCounts[pos] = (posCounts[pos] || 0) + 1;
      if (ev.assist) {
        const aPos = ev.assist.position || "—";
        const key = `${aPos} → ${pos}`;
        pairCounts[key] = (pairCounts[key] || 0) + 1;
        if (ev.secondAssist) {
          const sPos = ev.secondAssist.position || "—";
          const sKey = `${sPos} → ${aPos}`;
          pairCounts[sKey] = (pairCounts[sKey] || 0) + 1;
        }
      }
      if (ev.missDirection) {
        const who = eventPersonLabel("us", ev.shooterNumber, ev.shooterName, ev.shooterShort);
        if (!missByPlayer[who]) missByPlayer[who] = { over: 0, short: 0, "wide-left": 0, "wide-right": 0 };
        missByPlayer[who][ev.missDirection] = (missByPlayer[who][ev.missDirection] || 0) + 1;
      }
    });
    const topPos = Object.entries(posCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    const topPairs = Object.entries(pairCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    const missRows = Object.entries(missByPlayer)
      .map(([who, dirs]) => ({ who, ...dirs, total: dirs.over + dirs.short + dirs["wide-left"] + dirs["wide-right"] }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 8);
    return { topPos, topPairs, missRows };
  }

  function unitsMarkup(events) {
    const { topPos, topPairs, missRows } = unitsBreakdown(events);
    if (!topPos.length && !topPairs.length && !missRows.length) {
      return `<p class="muted">Record positions on shots (and assists) to see which units create chances.</p>`;
    }
    return `
      <div class="units-grid">
        <div>
          <h3 class="tracker-half-heading">Positions producing shots</h3>
          <ul class="units-list">
            ${topPos.map(([pos, n]) => `<li><strong>${escapeHtml(pos)}</strong> <span class="muted">${n}</span></li>`).join("") || "<li class='muted'>None yet</li>"}
          </ul>
        </div>
        <div>
          <h3 class="tracker-half-heading">Units / partnerships</h3>
          <ul class="units-list">
            ${topPairs.map(([pair, n]) => `<li><strong>${escapeHtml(pair)}</strong> <span class="muted">${n}</span></li>`).join("") || "<li class='muted'>Need assists with positions</li>"}
          </ul>
        </div>
        <div>
          <h3 class="tracker-half-heading">Miss trends</h3>
          <ul class="units-list">
            ${
              missRows
                .map(
                  (r) =>
                    `<li><strong>${escapeHtml(r.who)}</strong> <span class="muted">O${r.over} S${r.short} WL${r["wide-left"]} WR${r["wide-right"]}</span></li>`
                )
                .join("") || "<li class='muted'>No miss directions yet</li>"
            }
          </ul>
        </div>
      </div>`;
  }

  function eventPersonLabel(team, number, name, short) {
    const hasNum = number !== undefined && number !== null && String(number) !== "";
    if (!hasNum && !name && !short) return "—";
    if (!hasNum) return short || firstName(name) || name || "—";
    if (team === "opp") {
      const named = opponentShortName({ name, short, short_name: short });
      return named ? `${named} #${number}` : `Opp #${number}`;
    }
    if (short) return `#${number} ${short}`;
    const nick = firstName(name);
    return nick ? `#${number} ${nick}` : `#${number}`;
  }

  function shotTableRows(events, opts = {}) {
    if (!events.length) {
      const empty = opts.emptyLabel || "No plays yet.";
      return `<tr><td colspan="12" class="empty-state" style="padding:1.25rem">${escapeHtml(empty)}</td></tr>`;
    }
    return events
      .map((ev) => {
        const team = eventTeam(ev);
        const player = eventPersonLabel(team, ev.shooterNumber, ev.shooterName, ev.shooterShort);
        const foulerTeam = oppositeTeam(team);
        const foulerLabel =
          ev.foulerNumber || ev.foulerName || ev.foulerShort
            ? eventPersonLabel(foulerTeam, ev.foulerNumber, ev.foulerName, ev.foulerShort)
            : "";
        const playerCell = foulerLabel
          ? `${escapeHtml(player)}<br /><span class="muted">foul: ${escapeHtml(foulerLabel)}</span>`
          : escapeHtml(player);
        const assistBy = ev.assist ? eventPersonLabel(team, ev.assist.number, ev.assist.name, ev.assist.short) : "—";
        const assistType = ev.assist ? ASSIST_TYPE_LABELS[ev.assist.type] || ev.assist.type : "—";
        const assistPos = ev.assist?.position ? ` · ${ev.assist.position}` : "";
        const secondBy = ev.secondAssist
          ? eventPersonLabel(team, ev.secondAssist.number, ev.secondAssist.name, ev.secondAssist.short)
          : "";
        const secondType = ev.secondAssist ? ASSIST_TYPE_LABELS[ev.secondAssist.type] || ev.secondAssist.type : "";
        const secondPos = ev.secondAssist?.position ? ` · ${ev.secondAssist.position}` : "";
        const assistCell = ev.assist
          ? `${escapeHtml(formatLoc(ev.assist))}<br /><span class="muted">${escapeHtml(formatXY(ev.assist))}</span>${
              ev.secondAssist
                ? `<br /><span class="muted">2nd: ${escapeHtml(formatLoc(ev.secondAssist))} · ${escapeHtml(formatXY(ev.secondAssist))}</span>`
                : ""
            }`
          : "—";
        const resultLabel = SHOT_RESULT_LABELS[ev.result] || ev.result;
        const missLabel = ev.missDirection ? MISS_DIRECTION_LABELS[ev.missDirection] || ev.missDirection : "—";
        const failed = ev.saveFailed
          ? `<button type="button" class="btn btn-ghost shots-retry" data-retry-shot="${escapeHtml(ev.id)}">Retry save</button>`
          : "";
        const extra = opts.showGame && ev.gameDate ? `<td>${escapeHtml(ev.gameDate)}</td>` : "";
        const clockLabel = formatEventClock(ev, ev.game || st.game);
        const clockDisplay = formatClockSecs(
          elapsedToDisplay(Number(ev.gameClockSeconds ?? ev.game_clock_seconds ?? 0), eventPeriod(ev), ev.game || st.game)
        );
        let clockCell;
        if (opts.editClock && st.editingClockId === ev.id) {
          clockCell = `<td class="clock-cell"><input class="clock-input" data-clock-input="${escapeHtml(ev.id)}" value="${escapeHtml(ev.gameClockSeconds == null ? "" : clockDisplay)}" inputmode="decimal" aria-label="Game clock" />${failed}</td>`;
        } else if (opts.editClock) {
          clockCell = `<td class="clock-cell"><button type="button" class="clock-edit-btn" data-edit-clock="${escapeHtml(ev.id)}">${escapeHtml(clockLabel)}</button>${failed}</td>`;
        } else {
          clockCell = `<td>${escapeHtml(clockLabel)}${failed}</td>`;
        }
        return `
          <tr class="${ev.saveFailed ? "is-unsaved" : ""}">
            <td class="tracker-edit-cell">
              <button type="button" class="icon-btn tracker-edit" data-edit-shot="${escapeHtml(ev.id)}" aria-label="Edit play">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M12 20h9"/>
                  <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
                </svg>
              </button>
            </td>
            ${clockCell}
            ${extra}
            <td><span class="team-chip ${team === "opp" ? "is-opp" : "is-us"}">${escapeHtml(teamLabel(team, ev))}</span></td>
            <td><button type="button" class="linkish" data-edit-shot="${escapeHtml(ev.id)}"><span class="shot-result-pill ${escapeHtml(ev.result)}">${escapeHtml(resultLabel)}</span></button></td>
            <td><button type="button" class="linkish" data-edit-shot="${escapeHtml(ev.id)}">${playerCell}</button></td>
            <td><button type="button" class="linkish" data-edit-shot="${escapeHtml(ev.id)}">${escapeHtml(ev.position || "—")}</button></td>
            <td>${escapeHtml(missLabel)}</td>
            <td>${escapeHtml(assistBy)}${escapeHtml(assistPos)}${
              secondBy
                ? `<br /><span class="muted">2nd: ${escapeHtml(secondBy)}${escapeHtml(secondPos)}</span>`
                : ""
            }</td>
            <td>${escapeHtml(assistType)}${
              secondType ? `<br /><span class="muted">2nd: ${escapeHtml(secondType)}</span>` : ""
            }</td>
            <td class="tracker-coord-cell">${escapeHtml(formatLoc(ev.shot))}<br /><span class="muted">${escapeHtml(formatXY(ev.shot))}</span></td>
            <td class="tracker-coord-cell">${assistCell}</td>
            <td class="tracker-delete-cell">
              <button type="button" class="icon-btn tracker-delete" data-delete-shot="${escapeHtml(ev.id)}" aria-label="Delete shot">×</button>
            </td>
          </tr>`;
      })
      .join("");
  }

  function logFilterActive() {
    return (st.logTeam === "us" || st.logTeam === "opp") || normalizeLogResult(st.logResult) !== "all";
  }

  function playsFilterMarkup() {
    const teamBtns = [
      ["all", "All teams"],
      ["us", "Brighton"],
      ["opp", "Opponent"],
    ]
      .map(
        ([id, label]) =>
          `<button type="button" class="plays-filter-btn ${st.logTeam === id ? "is-on" : ""}" data-log-team="${id}">${label}</button>`
      )
      .join("");
    const resultBtns = Object.entries(LOG_RESULT_FILTERS)
      .map(
        ([id, spec]) =>
          `<button type="button" class="plays-filter-btn ${normalizeLogResult(st.logResult) === id ? "is-on" : ""}" data-log-result="${id}">${escapeHtml(spec.label)}</button>`
      )
      .join("");
    return `
      <div class="plays-filters" role="group" aria-label="Filter recorded plays">
        <div class="plays-filter-row">
          <span class="plays-filter-label">Team</span>
          <div class="plays-filter-btns">${teamBtns}</div>
        </div>
        <div class="plays-filter-row">
          <span class="plays-filter-label">Result</span>
          <div class="plays-filter-btns">${resultBtns}</div>
        </div>
      </div>`;
  }

  function bindPlaysFilters() {
    $$("[data-log-team]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const next = btn.getAttribute("data-log-team");
        st.logTeam = next === "us" || next === "opp" ? next : "all";
        saveUi();
        draw({ keepScroll: true });
      });
    });
    $$("[data-log-result]").forEach((btn) => {
      btn.addEventListener("click", () => {
        st.logResult = normalizeLogResult(btn.getAttribute("data-log-result"));
        saveUi();
        draw({ keepScroll: true });
      });
    });
  }

  function shotTableMarkup(title, events, opts = {}) {
    return `
      <h3 class="tracker-half-heading">${escapeHtml(title)}</h3>
      <div class="tracker-summary">${summaryPills(trackerSummary(events))}</div>
      <div class="tracker-table-wrap">
        <table class="tracker-table">
          <thead>
            <tr>
              <th class="tracker-edit-cell"><span class="sr-only">Edit</span></th>
              <th>Gameclock</th>
              <th>Team</th>
              <th>Result</th>
              <th>Player</th>
              <th>Pos</th>
              <th>Miss</th>
              <th>Assisted by</th>
              <th>Assist type</th>
              <th>Shot location</th>
              <th>Assist location</th>
              <th class="tracker-delete-cell"><span class="sr-only">Delete</span></th>
            </tr>
          </thead>
          <tbody>${shotTableRows(events, { emptyLabel: opts.emptyLabel, editClock: opts.editClock !== false })}</tbody>
        </table>
      </div>`;
  }

  function bindLogActions() {
    $$("[data-delete-shot]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-delete-shot");
        const ev = st.shots.find((e) => e.id === id);
        const label = ev
          ? `${SHOT_RESULT_LABELS[ev.result] || ev.result} by ${eventPersonLabel(eventTeam(ev), ev.shooterNumber, ev.shooterName, ev.shooterShort)}`
          : "this recording";
        if (!confirm(`Delete ${label}?`)) return;
        if (ev?.saveFailed) {
          st.shots = st.shots.filter((e) => e.id !== id);
          draw({ keepScroll: true });
          return;
        }
        const result = await API.deleteShot(id);
        if (!result.ok) {
          showToast("Not saved — check connection");
          return;
        }
        st.shots = st.shots.filter((e) => e.id !== id);
        draw({ keepScroll: true });
      });
    });
    $$("[data-retry-shot]").forEach((btn) => {
      btn.addEventListener("click", () => retryShot(btn.getAttribute("data-retry-shot")));
    });
    $$("[data-edit-shot]").forEach((btn) => {
      btn.addEventListener("click", () => openEditShot(btn.getAttribute("data-edit-shot")));
    });
    $$("[data-edit-clock]").forEach((btn) => {
      btn.addEventListener("click", () => {
        st.editingClockId = btn.getAttribute("data-edit-clock");
        draw({ keepScroll: true });
      });
    });
    const clockInput = $("[data-clock-input]");
    if (clockInput) {
      const commit = async () => {
        const id = clockInput.getAttribute("data-clock-input");
        if (!st.editingClockId) return;
        const text = clockInput.value;
        st.editingClockId = null;
        const sec = parseClockInput(text);
        if (text.trim() && sec == null) {
          showToast("Try 40, 38.5, or 38:50");
          draw({ keepScroll: true });
          return;
        }
        const ev = (st.shots || []).find((e) => e.id === id) || (st.history.rows || []).find((e) => e.id === id);
        if (!ev) {
          draw({ keepScroll: true });
          return;
        }
        const elapsed = text.trim() === "" ? null : Math.max(0, displayToElapsed(sec, eventPeriod(ev), ev.game || st.game));
        if (ev.saveFailed && ev.pendingPayload) {
          ev.pendingPayload.game_clock_seconds = elapsed;
          ev.gameClockSeconds = elapsed;
          draw({ keepScroll: true });
          return;
        }
        const saved = await API.updateShot(id, { game_clock_seconds: elapsed });
        if (!saved.ok) {
          showToast(saved.error || "Not saved — check connection");
          draw({ keepScroll: true });
          return;
        }
        const mapped = mapShot(saved.data);
        const idx = st.shots.findIndex((s) => s.id === id);
        if (idx >= 0) st.shots[idx] = mapped;
        if (st.history.rows) {
          const hIdx = st.history.rows.findIndex((s) => s.id === id);
          if (hIdx >= 0) st.history.rows[hIdx] = Object.assign({}, st.history.rows[hIdx], mapped);
        }
        draw({ keepScroll: true });
      };
      clockInput.addEventListener("blur", () => {
        commit();
      });
      clockInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          clockInput.blur();
        }
        if (e.key === "Escape") {
          st.editingClockId = null;
          draw({ keepScroll: true });
        }
      });
      requestAnimationFrame(() => {
        clockInput.focus();
        clockInput.select();
      });
    }
  }

  function fillFoulerEditOptions(ev, teamOverride) {
    const wrap = $("#shot-edit-fouler-wrap");
    const sel = $("#shot-edit-fouler");
    if (!wrap || !sel) return;
    const needs =
      RESULTS_NEEDING_FOULER.has(ev.result || $("#shot-edit-result")?.value) ||
      (ev.result || $("#shot-edit-result")?.value) === "foul" ||
      !!(ev.fouler_player_id || ev.foulerNumber);
    wrap.hidden = !needs;
    if (!needs) {
      sel.innerHTML = `<option value="">—</option>`;
      return;
    }
    const team = oppositeTeam(teamOverride || eventTeam(ev));
    const players = sortPlayers(rosterPlayers(team));
    if (ev.fouler_player_id && !players.find((p) => p.id === ev.fouler_player_id)) {
      players.unshift({
        id: ev.fouler_player_id,
        number: ev.foulerNumber,
        name: ev.foulerName,
        short: ev.foulerShort,
        team,
      });
    }
    sel.innerHTML =
      `<option value="">Unknown / untagged</option>` +
      players
        .map(
          (p) =>
            `<option value="${p.id}" ${p.id === ev.fouler_player_id ? "selected" : ""}>${escapeHtml(playerDisplayName(p))} (#${escapeHtml(String(p.number))})</option>`
        )
        .join("");
  }

  function fillEditPlayerOptions(ev, team, selectedId) {
    const sel = $("#shot-edit-player");
    if (!sel) return;
    const players = sortPlayers(rosterPlayers(team));
    const keepId = selectedId || ev.player_id;
    if (keepId && !players.find((p) => p.id === keepId)) {
      players.unshift({
        id: keepId,
        number: ev.shooterNumber,
        name: ev.shooterName,
        short: ev.shooterShort,
        team,
      });
    }
    sel.innerHTML =
      `<option value="">Unknown / untagged</option>` +
      players
        .map(
          (p) =>
            `<option value="${p.id}" ${p.id === keepId ? "selected" : ""}>${escapeHtml(playerDisplayName(p))} (#${escapeHtml(String(p.number))})</option>`
        )
        .join("");
  }

  function fillEditAssistOptions(ev, team, selectedId) {
    const sel = $("#shot-edit-assist");
    if (!sel) return;
    const players = sortPlayers(rosterPlayers(team));
    const keepId = selectedId !== undefined ? selectedId : ev.assist?.player_id || null;
    if (keepId && !players.find((p) => p.id === keepId)) {
      players.unshift({
        id: keepId,
        number: ev.assist?.number || "",
        name: ev.assist?.name || "",
        short: ev.assist?.short || "",
        team,
      });
    }
    sel.innerHTML =
      `<option value="">— None —</option>` +
      players
        .map(
          (p) =>
            `<option value="${p.id}" ${p.id === keepId ? "selected" : ""}>${escapeHtml(playerDisplayName(p))} (#${escapeHtml(String(p.number))})</option>`
        )
        .join("");
  }

  function currentEditShot() {
    const id = $("#shot-edit-modal")?.dataset.shotId;
    if (!id) return null;
    return st.shots.find((s) => s.id === id) || st.history.rows?.find((s) => s.id === id) || null;
  }

  function editPitchSwapped(team) {
    return team === "opp" ? !st.swapSides : !!st.swapSides;
  }

  function locPatch(prefix, type, playerId, position, loc) {
    if (!type) {
      return {
        [`${prefix}_player_id`]: null,
        [`${prefix}_type`]: null,
        [`${prefix}_position`]: null,
        [`${prefix}_x`]: null,
        [`${prefix}_y`]: null,
        [`${prefix}_zone_id`]: null,
        [`${prefix}_zone_label`]: null,
      };
    }
    return {
      [`${prefix}_player_id`]: playerId || null,
      [`${prefix}_type`]: type,
      [`${prefix}_position`]: position || null,
      [`${prefix}_x`]: loc ? loc.x : null,
      [`${prefix}_y`]: loc ? loc.y : null,
      [`${prefix}_zone_id`]: loc ? loc.zoneId : null,
      [`${prefix}_zone_label`]: loc ? loc.zoneLabel : null,
    };
  }

  function renderEditLocPitches(ev) {
    if (!ev) return;
    const team = editModalTeam();
    const assistType = $("#shot-edit-assist-type")?.value || "";
    const secondType = $("#shot-edit-second-assist-type")?.value || "";
    const assistWrap = $("#shot-edit-assist-loc-wrap");
    const secondWrap = $("#shot-edit-second-loc-wrap");
    if (assistWrap) assistWrap.hidden = !assistType;
    if (secondWrap) secondWrap.hidden = !(assistType && secondType);
    const locLabel = (loc) => (loc ? `${formatLoc(loc)} · (${formatXY(loc)})` : "Tap the pitch");
    const assistText = $("#shot-edit-assist-loc-text");
    const secondText = $("#shot-edit-second-loc-text");
    if (assistText) assistText.textContent = locLabel(editLocDraft.assist);
    if (secondText) secondText.textContent = locLabel(editLocDraft.second);
    const preview = {
      id: ev.id,
      team,
      period: eventPeriod(ev),
      result: ev.result,
      shooterNumber: ev.shooterNumber,
      shot: ev.shot,
      assist: editLocDraft.assist,
      secondAssist: editLocDraft.second,
      saveFailed: false,
    };
    const opts = {
      team,
      swapped: editPitchSwapped(team),
      showGrid: true,
      period: eventPeriod(ev),
      noPending: true,
    };
    const assistPitch = $("#shot-edit-assist-pitch");
    const secondPitch = $("#shot-edit-second-pitch");
    if (assistPitch && assistType) assistPitch.innerHTML = halfPitchMarkup([preview], opts);
    if (secondPitch && assistType && secondType) secondPitch.innerHTML = halfPitchMarkup([preview], opts);
  }

  function fillEditSecondAssistOptions(ev, team, selectedId) {
    const sel = $("#shot-edit-second-assist");
    if (!sel) return;
    const players = sortPlayers(rosterPlayers(team));
    const keepId = selectedId !== undefined ? selectedId : ev.secondAssist?.player_id || null;
    if (keepId && !players.find((p) => p.id === keepId)) {
      players.unshift({
        id: keepId,
        number: ev.secondAssist?.number || "",
        name: ev.secondAssist?.name || "",
        short: ev.secondAssist?.short || "",
        team,
      });
    }
    sel.innerHTML =
      `<option value="">— None —</option>` +
      players
        .map(
          (p) =>
            `<option value="${p.id}" ${p.id === keepId ? "selected" : ""}>${escapeHtml(playerDisplayName(p))} (#${escapeHtml(String(p.number))})</option>`
        )
        .join("");
  }

  function editModalTeam() {
    return $("#shot-edit-team")?.value === "opp" ? "opp" : "us";
  }

  function refreshEditModalRosters(ev, opts = {}) {
    const team = editModalTeam();
    const keepPlayer = opts.clearPlayers ? null : $("#shot-edit-player")?.value || ev.player_id;
    const keepAssist = opts.clearPlayers ? null : $("#shot-edit-assist")?.value || ev.assist?.player_id || null;
    const keepSecond =
      opts.clearPlayers ? null : $("#shot-edit-second-assist")?.value || ev.secondAssist?.player_id || null;
    fillEditPlayerOptions(ev, team, keepPlayer);
    fillEditAssistOptions(ev, team, keepAssist);
    fillEditSecondAssistOptions(ev, team, keepSecond);
    fillFoulerEditOptions(
      Object.assign({}, ev, { result: $("#shot-edit-result")?.value || ev.result }),
      team
    );
    const teamSel = $("#shot-edit-team");
    if (teamSel) {
      const oppLabel = teamLabel("opp", ev);
      const usOpt = teamSel.querySelector('option[value="us"]');
      const oppOpt = teamSel.querySelector('option[value="opp"]');
      if (usOpt) usOpt.textContent = teamLabel("us", ev);
      if (oppOpt) oppOpt.textContent = oppLabel;
    }
  }

  function openEditShot(id) {
    const ev = st.shots.find((s) => s.id === id) || st.history.rows?.find((s) => s.id === id);
    if (!ev) return;
    const modal = $("#shot-edit-modal");
    if (!modal) return;
    modal.dataset.shotId = id;
    const team = eventTeam(ev);
    const title = $("#shot-edit-title");
    if (title) title.textContent = "Edit play";
    const teamSel = $("#shot-edit-team");
    if (teamSel) teamSel.value = team;
    $("#shot-edit-result").value = ev.result;
    $("#shot-edit-position").value = ev.position || "";
    const missSel = $("#shot-edit-miss");
    if (missSel) {
      missSel.value = ev.missDirection || "";
      missSel.disabled = !RESULTS_NEEDING_MISS_DIR.has(ev.result);
    }
    const assistTypeSel = $("#shot-edit-assist-type");
    if (assistTypeSel) assistTypeSel.value = ev.assist?.type || "";
    const secondTypeSel = $("#shot-edit-second-assist-type");
    if (secondTypeSel) secondTypeSel.value = ev.secondAssist?.type || "";
    const assistPosSel = $("#shot-edit-assist-position");
    if (assistPosSel) assistPosSel.innerHTML = positionSelectOptions(ev.assist?.position || "");
    const secondPosSel = $("#shot-edit-second-assist-position");
    if (secondPosSel) secondPosSel.innerHTML = positionSelectOptions(ev.secondAssist?.position || "");
    editLocDraft.assist = locFromPlay(ev.assist);
    editLocDraft.second = locFromPlay(ev.secondAssist);
    $("#shot-edit-name").value = ev.shooterName || "";
    $("#shot-edit-short").value = ev.shooterShort || "";
    const clockInput = $("#shot-edit-clock");
    if (clockInput) {
      const raw = ev.gameClockSeconds ?? ev.game_clock_seconds;
      clockInput.value =
        raw == null || raw === ""
          ? ""
          : formatClockSecs(elapsedToDisplay(Number(raw), eventPeriod(ev), ev.game || st.game));
    }
    refreshEditModalRosters(ev);
    fillEditPlayerOptions(ev, team, ev.player_id);
    fillEditAssistOptions(ev, team, ev.assist?.player_id || null);
    fillEditSecondAssistOptions(ev, team, ev.secondAssist?.player_id || null);
    fillFoulerEditOptions(ev, team);
    renderEditLocPitches(ev);
    modal.hidden = false;
  }

  function bindEditModal() {
    const modal = $("#shot-edit-modal");
    if (!modal || modal.dataset.bound === "1") return;
    modal.dataset.bound = "1";
    $$("[data-close-shot-edit]").forEach((el) => {
      el.addEventListener("click", () => {
        modal.hidden = true;
      });
    });
    $("#shot-edit-team")?.addEventListener("change", () => {
      const ev = currentEditShot();
      if (!ev) return;
      refreshEditModalRosters(ev, { clearPlayers: true });
      $("#shot-edit-name").value = "";
      $("#shot-edit-short").value = "";
      renderEditLocPitches(ev);
    });
    $("#shot-edit-result")?.addEventListener("change", () => {
      const missSel = $("#shot-edit-miss");
      if (missSel) {
        const needs = RESULTS_NEEDING_MISS_DIR.has($("#shot-edit-result").value);
        missSel.disabled = !needs;
        if (!needs) missSel.value = "";
      }
      const id = modal.dataset.shotId;
      const ev = st.shots.find((s) => s.id === id) || st.history.rows?.find((s) => s.id === id);
      if (ev) fillFoulerEditOptions(Object.assign({}, ev, { result: $("#shot-edit-result").value }), editModalTeam());
    });
    $("#shot-edit-assist-type")?.addEventListener("change", () => {
      const type = $("#shot-edit-assist-type").value;
      if (!type) {
        if ($("#shot-edit-assist")) $("#shot-edit-assist").value = "";
        if ($("#shot-edit-second-assist")) $("#shot-edit-second-assist").value = "";
        if ($("#shot-edit-second-assist-type")) $("#shot-edit-second-assist-type").value = "";
        if ($("#shot-edit-assist-position")) $("#shot-edit-assist-position").value = "";
        if ($("#shot-edit-second-assist-position")) $("#shot-edit-second-assist-position").value = "";
        editLocDraft.assist = null;
        editLocDraft.second = null;
      }
      renderEditLocPitches(currentEditShot());
    });
    $("#shot-edit-second-assist-type")?.addEventListener("change", () => {
      const type = $("#shot-edit-second-assist-type").value;
      if (!type) {
        if ($("#shot-edit-second-assist")) $("#shot-edit-second-assist").value = "";
        if ($("#shot-edit-second-assist-position")) $("#shot-edit-second-assist-position").value = "";
        editLocDraft.second = null;
      }
      renderEditLocPitches(currentEditShot());
    });
    modal.addEventListener("pointerup", (e) => {
      const host = e.target.closest("[data-edit-loc]");
      const svg = e.target.closest("svg");
      if (!host || !svg || modal.hidden || !host.contains(svg)) return;
      const ev = currentEditShot();
      if (!ev) return;
      const team = editModalTeam();
      const p = svgEventPoint(svg, e);
      const pitch = pitchFromSvgPoint(p.x, p.y, editPitchSwapped(team));
      const loc = locatePitchPoint(pitch.x, pitch.y);
      if (host.getAttribute("data-edit-loc") === "second") editLocDraft.second = loc;
      else editLocDraft.assist = loc;
      renderEditLocPitches(ev);
    });
    $("#shot-edit-save")?.addEventListener("click", async () => {
      const id = modal.dataset.shotId;
      const ev = st.shots.find((s) => s.id === id) || st.history.rows?.find((s) => s.id === id);
      if (!ev) return;
      const team = editModalTeam();
      const teamId = teamIdForEvent(team, ev);
      if (!teamId) {
        showToast("Could not resolve team for this play");
        return;
      }
      const playerId = $("#shot-edit-player").value || null;
      const player = playerId ? playerFromRoster(team, playerId, null) : null;
      const result = $("#shot-edit-result").value;
      const missVal = $("#shot-edit-miss")?.value || "";
      const foulerId = $("#shot-edit-fouler")?.value || null;
      const fouler = foulerId ? playerFromRoster(oppositeTeam(team), foulerId, null) : null;
      const assistType = $("#shot-edit-assist-type")?.value || "";
      const assistIdRaw = $("#shot-edit-assist")?.value || null;
      const secondType = $("#shot-edit-second-assist-type")?.value || "";
      const secondIdRaw = $("#shot-edit-second-assist")?.value || null;
      if (assistIdRaw && !assistType) {
        showToast("Pick an assist type (or clear Assisted by)");
        return;
      }
      if ((secondIdRaw || secondType) && !assistType) {
        showToast("2nd assist needs an assist first");
        return;
      }
      if (secondIdRaw && !secondType) {
        showToast("Pick a 2nd assist type (or clear 2nd assist)");
        return;
      }
      if (assistType && !editLocDraft.assist) {
        showToast("Tap the pitch to set assist location");
        return;
      }
      if (secondType && !editLocDraft.second) {
        showToast("Tap the pitch to set 2nd assist location");
        return;
      }
      const clockText = ($("#shot-edit-clock")?.value || "").trim();
      let clockElapsed = null;
      if (clockText) {
        const clockSec = parseClockInput(clockText);
        if (clockSec == null) {
          showToast("Try 40, 38.5, or 38:50");
          return;
        }
        clockElapsed = Math.max(0, displayToElapsed(clockSec, eventPeriod(ev), ev.game || st.game));
      }
      const assistId = assistType ? assistIdRaw : null;
      const secondId = secondType ? secondIdRaw : null;
      const patch = {
        team_id: teamId,
        result,
        position: $("#shot-edit-position").value || null,
        miss_direction: RESULTS_NEEDING_MISS_DIR.has(result) ? missVal || null : null,
        player_id: playerId,
        jersey_number_at_time: player ? String(player.number) : null,
        fouler_player_id: foulerId,
        fouler_jersey_number_at_time: fouler ? String(fouler.number) : null,
        game_clock_seconds: clockElapsed,
        ...locPatch(
          "assist",
          assistType,
          assistId,
          $("#shot-edit-assist-position")?.value || "",
          editLocDraft.assist
        ),
        ...locPatch(
          "second_assist",
          assistType ? secondType : "",
          assistType ? secondId : null,
          $("#shot-edit-second-assist-position")?.value || "",
          assistType ? editLocDraft.second : null
        ),
      };
      const saved = await API.updateShot(id, patch);
      if (!saved.ok) {
        showToast("Not saved — check connection");
        return;
      }
      const name = $("#shot-edit-name").value.trim();
      const short = $("#shot-edit-short").value.trim();
      const pid = playerId || ev.player_id;
      if (pid && (name || short)) {
        await API.updatePlayer(pid, { name: name || null, short_name: short || null });
        if (st.view === "shots-history") await runHistoryQuery();
        else if (st.game) await loadGameContext();
      } else {
        const mapped = mapShot(saved.data);
        const idx = st.shots.findIndex((s) => s.id === id);
        if (idx >= 0) st.shots[idx] = mapped;
        if (st.history.rows) {
          const hIdx = st.history.rows.findIndex((s) => s.id === id);
          if (hIdx >= 0) st.history.rows[hIdx] = Object.assign({}, st.history.rows[hIdx], mapped);
        }
      }
      modal.hidden = true;
      showToast("Shot updated");
      draw({ keepScroll: true });
    });
  }

  function usSelectOptions(slotId) {
    const current = slotPlayer("us", slotId);
    const group = groupForSlot(slotId);
    const groupLabel = POSITION_GROUPS.find((g) => g.id === group)?.label || group || "Position";
    const all = sortPlayers(rosterPlayers("us"));
    const opts = [`<option value="">—</option>`];

    const fieldStatus = (p) => {
      const sid = slotIdForNumber("us", p.number);
      if (!sid) return "bench";
      if (Number(sid) === Number(slotId)) return "here";
      return "elsewhere";
    };

    const pushOpt = (p, suffix = "") => {
      const selected = current && String(current.number) === String(p.number);
      const status = fieldStatus(p);
      const fieldTag = status === "elsewhere" ? ` · ${slotCodeForId(slotIdForNumber("us", p.number))}` : "";
      opts.push(
        `<option value="${escapeHtml(String(p.id || p.number))}" data-number="${escapeHtml(String(p.number))}" ${selected ? "selected" : ""}>${escapeHtml(playerDisplayName(p))} (#${escapeHtml(String(p.number))})${fieldTag}${suffix}</option>`
      );
    };

    const varsity = all.filter((p) => p.squad !== "jv");
    const jv = all.filter((p) => p.squad === "jv");

    // Current slot first, then bench players for this position group.
    const positional = varsity.filter((p) => {
      const status = fieldStatus(p);
      return status === "here" || (playerInGroup(p, group) && status === "bench");
    });
    // Other varsity available off the field.
    const varsityBench = varsity.filter((p) => fieldStatus(p) === "bench" && !playerInGroup(p, group));
    // Anyone already on the pitch at another spot (swap targets).
    const varsityOnField = varsity.filter((p) => fieldStatus(p) === "elsewhere");

    if (positional.length) {
      opts.push(`<optgroup label="${escapeHtml(groupLabel)}">`);
      positional.forEach((p) => pushOpt(p));
      opts.push(`</optgroup>`);
    }
    if (varsityBench.length) {
      opts.push(`<optgroup label="Varsity Bench">`);
      varsityBench.forEach((p) => pushOpt(p));
      opts.push(`</optgroup>`);
    }
    if (varsityOnField.length) {
      opts.push(`<optgroup label="Varsity On-Field">`);
      varsityOnField.forEach((p) => pushOpt(p));
      opts.push(`</optgroup>`);
    }
    if (jv.length) {
      opts.push(`<optgroup label="JV">`);
      jv.forEach((p) => pushOpt(p, " · JV"));
      opts.push(`</optgroup>`);
    }
    return opts.join("");
  }

  function lineupGestureBanner() {
    if (!lineupGesture) return "";
    if (lineupGesture.mode === "swap") {
      const team = "us";
      const from = slotPlayer(team, lineupGesture.fromSlot);
      const name = escapeHtml(playerDisplayName(from) || "Player");
      const code = escapeHtml(slotCodeForId(lineupGesture.fromSlot));
      return `
        <div class="lineup-gesture-banner" role="status">
          <p><strong>Swap ${name}</strong> (${code}) — tap another player on the field.</p>
          <button type="button" class="btn btn-secondary" data-lineup-gesture-cancel>Cancel</button>
        </div>`;
    }
    return "";
  }

  function lineupEditorCards() {
    const gestureOn = !!lineupGesture && lineupGesture.team !== "opp";
    return FORMATION_LAYOUT.map((layout) => {
      const slot = POSITION_SLOTS.find((s) => s.id === layout.id) || layout;
      const filled = slotPlayer("us", slot.id);
      const who = filled ? escapeHtml(playerDisplayName(filled)) : "—";
      const select = `<select class="lineup-select formation-card-select" data-lineup-team="us" data-lineup-slot="${slot.id}" aria-label="${escapeHtml(slot.code)}" ${gestureOn ? "disabled" : ""}>${usSelectOptions(slot.id)}</select>`;
      const isSwapFrom =
        lineupGesture?.mode === "swap" && gestureOn && Number(lineupGesture.fromSlot) === Number(slot.id);
      const isSwapTarget =
        lineupGesture?.mode === "swap" && gestureOn && !!filled && !isSwapFrom;
      const cardClass = [
        "formation-card",
        "is-editor",
        isSwapFrom ? "is-swap-from" : "",
        isSwapTarget ? "is-gesture-target" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const swapDisabled = !filled || (!!lineupGesture && !gestureOn);
      const swapBtn = `<button type="button" class="btn btn-ghost lineup-swap ${isSwapFrom ? "is-on" : ""}" data-swap-slot="${slot.id}" data-swap-team="us" ${swapDisabled ? "disabled" : ""} title="Swap with another on-field player">Swap</button>`;
      const hitOverlay =
        gestureOn && (isSwapTarget || isSwapFrom)
          ? `<button type="button" class="formation-card-hit" data-lineup-slot-hit="${slot.id}" aria-label="${isSwapFrom ? "Cancel swap" : "Swap with this player"}"></button>`
          : "";
      return `
        <div class="${cardClass}" style="${formationCardStyle(layout)}" data-lineup-slot-card="${slot.id}">
          <div class="formation-card-pick">
            <span class="formation-card-name">${who}</span>
            <span class="formation-card-chevron" aria-hidden="true"></span>
            ${select}
          </div>
          <span class="formation-card-meta">${formationMeta(slot.code, filled)}</span>
          ${swapBtn}
          ${hitOverlay}
        </div>`;
    }).join("");
  }

  function lineupEditorMarkup() {
    const usCount = onFieldPlayers("us").length;
    const gestureOn = !!lineupGesture;
    const usName = ourTeamName();
    const defaultCount = defaultLineupCount();
    const help = (() => {
      if (lineupGesture?.mode === "swap") return "Tap the player she should trade places with.";
      return "Dropdown to assign — Swap to trade spots.";
    })();
    return `
      <section class="lineup-section ${gestureOn ? "is-gesturing" : ""}" id="lineup-section">
        <div class="lineup-header">
          <h2>Starting lineup · 4-3-3</h2>
        </div>
        <p class="muted lineup-help">${help}</p>
        ${lineupGestureBanner()}
        <div class="lineup-dual-pitches">
          <div class="lineup-dual-block ${gestureOn ? "is-gesturing-pitch" : ""}">
            <div class="lineup-dual-head">
              <p class="tracker-pitch-caption">${escapeHtml(usName)}</p>
              <p class="lineup-count">${usCount}/11 on the field</p>
            </div>
            ${formationPitchShell(lineupEditorCards(), "", { team: "us" })}
          </div>
        </div>
        <div class="lineup-actions">
          <button type="button" class="btn btn-ghost" id="save-default-lineup" ${usCount ? "" : "disabled"}>Save as default</button>
          <button type="button" class="btn btn-ghost" id="restore-default-lineup">Restore default${defaultCount ? ` (${defaultCount})` : ""}</button>
        </div>
      </section>`;
  }

  function applyLineupSelect(team, slotId, sel) {
    if (team === "opp") return;
    const opt = sel.selectedOptions[0];
    if (!sel.value) {
      assignSlot(team, slotId, null);
      clearLineupGesture();
      return;
    }
    const number = opt?.getAttribute("data-number") || sel.value.replace(/^n-/, "");
    const list = rosterPlayers(team);
    const fromRoster =
      list.find((p) => p.id && p.id === sel.value) ||
      list.find((p) => String(p.number) === String(number)) ||
      null;
    const player = fromRoster || {
      id: sel.value.startsWith("n-") ? "" : sel.value,
      number,
      name: "",
      short: "",
    };
    const payload = lineupPlayerPayload(player);
    const current = slotPlayer(team, slotId);

    if (current && String(current.number) === String(payload.number)) return;

    const otherSlot = slotIdForNumber(team, payload.number);
    if (otherSlot && Number(otherSlot) !== Number(slotId)) {
      swapSlots(team, slotId, otherSlot);
      clearLineupGesture();
      showToast(`Swapped ${slotCodeForId(slotId)} ↔ ${slotCodeForId(otherSlot)}`);
      return;
    }

    assignSlot(team, slotId, payload);
    clearLineupGesture();
    if (current) {
      showToast(
        `${playerDisplayName(player) || `#${payload.number}`} in at ${slotCodeForId(slotId)} · ${playerDisplayName(current) || "player"} to bench`
      );
    } else {
      showToast(`${playerDisplayName(player) || `#${payload.number}`} in at ${slotCodeForId(slotId)}`);
    }
  }

  function bindLineupEditor() {
    $("#save-default-lineup")?.addEventListener("click", () => {
      saveCurrentAsDefault();
      draw({ keepScroll: true });
    });
    $("#restore-default-lineup")?.addEventListener("click", () => restoreDefaultLineup());
    $$("[data-lineup-gesture-cancel]").forEach((btn) => {
      btn.addEventListener("click", () => {
        cancelLineupGesture();
        draw({ keepScroll: true });
      });
    });
    $$(".lineup-select").forEach((sel) => {
      sel.addEventListener("change", () => {
        const team = sel.getAttribute("data-lineup-team") === "opp" ? "opp" : "us";
        const slotId = Number(sel.getAttribute("data-lineup-slot"));
        applyLineupSelect(team, slotId, sel);
        draw({ keepScroll: true });
      });
    });
    $$("[data-swap-slot]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const slotId = Number(btn.getAttribute("data-swap-slot"));
        const team = btn.getAttribute("data-swap-team") === "opp" ? "opp" : "us";
        if (lineupGesture?.mode === "swap" && lineupGesture.team === team && Number(lineupGesture.fromSlot) === slotId) {
          clearLineupGesture();
          draw({ keepScroll: true });
          return;
        }
        if (lineupGesture?.mode === "swap" && lineupGesture.team === team) {
          completeSwapGesture(slotId);
          draw({ keepScroll: true });
          return;
        }
        if (lineupGesture) return;
        startSwapGesture(team, slotId);
        draw({ keepScroll: true });
      });
    });
    $$("[data-lineup-slot-hit]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!lineupGesture || lineupGesture.mode !== "swap") return;
        const slotId = Number(btn.getAttribute("data-lineup-slot-hit"));
        if (Number(lineupGesture.fromSlot) === slotId) {
          clearLineupGesture();
        } else {
          completeSwapGesture(slotId);
        }
        draw({ keepScroll: true });
      });
    });
  }

  function renderRecorder(opts = {}) {
    bindShotModal();
    bindEditModal();
    const scrollY = window.scrollY;
    const events = st.shots;
    const period = st.period;
    const etMode = period === "ET1" || period === "ET2";
    const firstHalf = events.filter((e) => eventPeriod(e) === "1" && eventMatchesLogFilter(e));
    const secondHalf = events.filter((e) => eventPeriod(e) === "2" && eventMatchesLogFilter(e));
    const etOne = events.filter((e) => eventPeriod(e) === "ET1" && eventMatchesLogFilter(e));
    const etTwo = events.filter((e) => eventPeriod(e) === "ET2" && eventMatchesLogFilter(e));
    const showEtLog =
      etMode || events.some((e) => eventPeriod(e) === "ET1" || eventPeriod(e) === "ET2");
    const filteredCount = events.filter(eventMatchesLogFilter).length;
    const logEmpty = logFilterActive() ? "No plays match this filter." : "No plays yet.";
    const logCount =
      logFilterActive() && events.length
        ? `<p class="plays-filter-count muted">${filteredCount} of ${events.length} plays</p>`
        : "";
    const awaitingShot = awaitingFollowUp();
    const usActive = recordingTeam() === "us";
    const usSwapped = !!st.swapSides;
    const oppSwapped = !usSwapped;
    const pitchOpts = { showGrid: st.showGrid, period };
    const goalSide = usSwapped ? "left" : "right";
    let status = `Double-tap a spot on either pitch to start a play. ${periodLabel(period)} · Brighton goal on the ${goalSide}, opponent opposite.`;
    if (awaitingShot) {
      const a = st.pending?.assist;
      const s2 = st.pending?.secondAssist;
      const who = (play) =>
        playerLabel(play?.player ? Object.assign({ team: recordingTeam() }, play.player) : null);
      if (s2 && a) {
        status = `2nd: ${who(s2)} · Assist: ${who(a)} (${ASSIST_TYPE_LABELS[a.type]}). Tap the shot on the ${teamLabel(recordingTeam())} pitch.`;
      } else if (a) {
        status = `Assist: ${who(a)} (${ASSIST_TYPE_LABELS[a.type]}). Tap the next pass or the shot on the ${teamLabel(recordingTeam())} pitch.`;
      } else {
        status = `Tap where the shot was taken on the ${teamLabel(recordingTeam())} pitch.`;
      }
    }

    document.body.classList.toggle("is-recording-play", awaitingShot);
    const usCaption = awaitingShot
      ? usActive
        ? "Brighton · tap next pass or shot"
        : "Brighton"
      : "Brighton · double-tap to record";
    const oppName = opponentOf(st.game)?.name || "Opponent";
    const oppCaption = awaitingShot
      ? !usActive
        ? `${oppName} · tap next pass or shot`
        : oppName
      : `${oppName} · double-tap to record`;

    root().innerHTML = `
      <div class="tracker-page${awaitingShot ? " is-recording-play" : ""}">
        ${trackerNav("shots")}
        <p class="shots-game-label">${escapeHtml(gameTitle(st.game))}</p>
        ${scoreboardBoardMarkup("compact")}
        <section class="tracker-stage">
          ${
            awaitingShot
              ? `<div class="tracker-recording-banner" role="status">
            <div class="tracker-recording-head">
              <span class="tracker-recording-badge">Recording play</span>
              <button type="button" class="btn btn-ghost tracker-recording-cancel" id="tracker-cancel-record">Cancel</button>
            </div>
            <p class="tracker-status is-live" id="tracker-status">${escapeHtml(status)}</p>
          </div>`
              : `<p class="tracker-status" id="tracker-status">${escapeHtml(status)}</p>`
          }
          <div class="tracker-pitches">
            <div class="tracker-pitch-block ${usActive || !awaitingShot ? "is-active" : ""}">
              <p class="tracker-pitch-caption">${escapeHtml(usCaption)}</p>
              <div class="pitch-wrap tracker-pitch-wrap" id="tracker-pitch-us">${halfPitchMarkup(events, Object.assign({ team: "us", swapped: usSwapped }, pitchOpts))}</div>
            </div>
            <div class="tracker-pitch-block is-opp ${!usActive || !awaitingShot ? "is-active" : ""}">
              <p class="tracker-pitch-caption">${escapeHtml(oppCaption)}</p>
              <div class="pitch-wrap tracker-pitch-wrap" id="tracker-pitch-opp">${halfPitchMarkup(events, Object.assign({ team: "opp", swapped: oppSwapped }, pitchOpts))}</div>
            </div>
          </div>
        </section>
        ${lineupEditorMarkup()}
        <section class="tracker-units" id="tracker-units">
          <h2>Units &amp; trends</h2>
          ${unitsMarkup(events.filter((e) => eventTeam(e) === "us"))}
        </section>
        <section class="tracker-log" id="tracker-log">
          <h2>Recorded plays</h2>
          ${playsFilterMarkup()}
          ${logCount}
          ${shotTableMarkup("1st Half", firstHalf, { emptyLabel: logEmpty })}
          ${shotTableMarkup("2nd Half", secondHalf, { emptyLabel: logEmpty })}
          ${showEtLog ? shotTableMarkup("ET 1", etOne, { emptyLabel: logEmpty }) + shotTableMarkup("ET 2", etTwo, { emptyLabel: logEmpty }) : ""}
        </section>
        ${stampOffsetMarkup()}
        <p class="prep-game-link">
          <a href="#shots-prep?game=${encodeURIComponent(st.gameId)}">Opponent prep — this game</a>
          <span class="muted">Halftime / pre-ET glance</span>
        </p>
      </div>`;

    $("#tracker-cancel-record")?.addEventListener("click", () => {
      closeShotModal();
      resetTrackerDraft();
      draw();
    });
    bindClockUi();
    bindScoreStripMenu();
    bindTrackerPitches();
    bindLineupEditor();
    bindPlaysFilters();
    bindLogActions();
    if (opts.keepScroll) window.scrollTo(0, scrollY);
  }

  function usAttacksFarEnd(period) {
    const p = normalizePeriod(period);
    return p !== "2" && p !== "ET2";
  }

  function toFullFieldPoint(loc, period, team) {
    const x = Number(loc.x);
    const y = Number(loc.y);
    const usAttacksRight = usAttacksFarEnd(period);
    const attacksRight = team === "opp" ? !usAttacksRight : usAttacksRight;
    if (!attacksRight) return { fx: y, fy: PW - x };
    return { fx: PL - y, fy: x };
  }

  function resultFill(result) {
    if (result === "goal" || result === "pk-goal") return "#f15a24";
    if (result === "on-target") return "#ffffff";
    if (result === "blocked") return "#6d5a8c";
    if (result === "foul") return "#9b59b6";
    if (result === "corner") return "#3498db";
    return "rgba(11,31,51,0.4)";
  }

  function isSquareEvent(result) {
    return result === "foul" || result === "corner";
  }

  function svgSquare(cx, cy, size, attrs) {
    const h = size / 2;
    return `<rect x="${Number(cx) - h}" y="${Number(cy) - h}" width="${size}" height="${size}" ${attrs} />`;
  }

  function shotShapeMarkup(ev, cx, cy, opts) {
    const size = opts.size;
    const r = size / 2;
    const extra = opts.attrs ? ` ${opts.attrs}` : "";
    const className = opts.className ? `class="${opts.className}"` : "";
    const fill = opts.fill || resultFill(ev.result);
    const stroke = opts.stroke || "";
    const sw = opts.strokeWidth != null ? opts.strokeWidth : "";
    const paint = [
      fill ? `fill="${fill}"` : "",
      stroke ? `stroke="${stroke}"` : "",
      sw !== "" ? `stroke-width="${sw}"` : "",
    ]
      .filter(Boolean)
      .join(" ");
    if (isSquareEvent(ev.result)) {
      return svgSquare(cx, cy, size, `${className} ${paint}${extra}`.trim());
    }
    return `<circle ${className} cx="${cx}" cy="${cy}" r="${r}" ${paint}${extra} />`.replace(/\s+/g, " ");
  }

  function fullFieldMarkup(events) {
    const line = "#f2f6f3";
    const goalW = 7.32;
    const goalY = (PW - goalW) / 2;
    const penW = 40.32;
    const penH = 16.5;
    const sixW = 18.32;
    const sixH = 5.5;
    const penY = (PW - penW) / 2;
    const sixY = (PW - sixW) / 2;
    const arcR = 9.15;
    const spotInset = 11;
    const dx = Math.sqrt(arcR * arcR - (penH - spotInset) * (penH - spotInset));
    const stripes = [];
    for (let i = 0; i < 6; i += 1) {
      stripes.push(
        `<rect fill="${i % 2 ? "#277047" : "#2d7a4a"}" x="${i * (PL / 6)}" y="0" width="${PL / 6}" height="${PW}" />`
      );
    }
    const markers = events
      .map((ev) => {
        const period = eventPeriod(ev);
        const team = eventTeam(ev);
        const shot = toFullFieldPoint(ev.shot, period, team);
        const stroke = team === "opp" ? "#c0392b" : ev.result === "missed" || ev.result === "pk-missed" ? "#ffffff" : "#0b1f33";
        const numFill = team === "opp" || ev.result === "missed" || ev.result === "pk-missed" ? "#ffffff" : "#0b1f33";
        let html = "";
        const ring = team === "opp" ? "#c0392b" : "#0b1f33";
        if (ev.secondAssist) {
          const s = toFullFieldPoint(ev.secondAssist, period, team);
          const aEnd = ev.assist ? toFullFieldPoint(ev.assist, period, team) : shot;
          html += `<line x1="${s.fx}" y1="${s.fy}" x2="${aEnd.fx}" y2="${aEnd.fy}" stroke="rgba(197,163,232,0.9)" stroke-width="0.28" stroke-dasharray="0.7 0.7" fill="none" />`;
          html += svgSquare(s.fx, s.fy, 1.5, `fill="#c5a3e8" stroke="${ring}" stroke-width="0.2"`);
        }
        if (ev.assist) {
          const a = toFullFieldPoint(ev.assist, period, team);
          html += `<line x1="${a.fx}" y1="${a.fy}" x2="${shot.fx}" y2="${shot.fy}" stroke="rgba(255,255,255,0.85)" stroke-width="0.28" stroke-dasharray="1.1 0.7" fill="none" />`;
          html += svgSquare(a.fx, a.fy, 1.7, `fill="#7ec8e3" stroke="${ring}" stroke-width="0.2"`);
        }
        html += shotShapeMarkup(ev, shot.fx, shot.fy, {
          size: 3.3,
          fill: resultFill(ev.result),
          stroke,
          strokeWidth: team === "opp" ? 0.42 : 0.28,
        });
        if (ev.shooterNumber !== undefined && ev.shooterNumber !== null && String(ev.shooterNumber) !== "") {
          html += `<text x="${shot.fx}" y="${shot.fy}" fill="${numFill}" font-size="1.25" font-weight="700" text-anchor="middle" dominant-baseline="central">${escapeHtml(String(ev.shooterNumber))}</text>`;
        }
        return html;
      })
      .join("");
    return `
      <svg id="shot-map-svg" class="shot-map-svg" viewBox="-3.2 -3.2 111.4 74.4" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Full-field shot map.">
        ${stripes.join("")}
        <rect x="0" y="0" width="${PL}" height="${PW}" fill="none" stroke="${line}" stroke-width="0.45" />
        <line x1="${HALF_L}" y1="0" x2="${HALF_L}" y2="${PW}" stroke="${line}" stroke-width="0.4" />
        <circle cx="${HALF_L}" cy="${PW / 2}" r="9.15" fill="none" stroke="${line}" stroke-width="0.35" />
        <circle cx="${HALF_L}" cy="${PW / 2}" r="0.45" fill="${line}" />
        <rect x="-1.4" y="${goalY}" width="1.4" height="${goalW}" fill="none" stroke="${line}" stroke-width="0.45" />
        <rect x="${PL}" y="${goalY}" width="1.4" height="${goalW}" fill="none" stroke="${line}" stroke-width="0.45" />
        <rect x="0" y="${penY}" width="${penH}" height="${penW}" fill="none" stroke="${line}" stroke-width="0.35" />
        <rect x="${PL - penH}" y="${penY}" width="${penH}" height="${penW}" fill="none" stroke="${line}" stroke-width="0.35" />
        <rect x="0" y="${sixY}" width="${sixH}" height="${sixW}" fill="none" stroke="${line}" stroke-width="0.35" />
        <rect x="${PL - sixH}" y="${sixY}" width="${sixH}" height="${sixW}" fill="none" stroke="${line}" stroke-width="0.35" />
        <circle cx="${spotInset}" cy="${PW / 2}" r="0.45" fill="${line}" />
        <circle cx="${PL - spotInset}" cy="${PW / 2}" r="0.45" fill="${line}" />
        <path d="M ${penH} ${PW / 2 - dx} A ${arcR} ${arcR} 0 0 1 ${penH} ${PW / 2 + dx}" fill="none" stroke="${line}" stroke-width="0.35" />
        <path d="M ${PL - penH} ${PW / 2 - dx} A ${arcR} ${arcR} 0 0 0 ${PL - penH} ${PW / 2 + dx}" fill="none" stroke="${line}" stroke-width="0.35" />
        <text x="12" y="-1.15" fill="${line}" font-size="2.3" font-weight="750" text-anchor="middle">2nd HALF</text>
        <text x="${PL - 12}" y="-1.15" fill="${line}" font-size="2.3" font-weight="750" text-anchor="middle">1st HALF</text>
        ${markers}
      </svg>`;
  }

  function downloadSummaryImage() {
    const rootEl = $("#shot-map-print-root");
    const svgs = rootEl ? $$(".shot-map-team-pitch .pitch-svg, #shot-map-svg", rootEl) : [];
    if (!svgs.length) {
      showToast("Nothing to save");
      return;
    }
    const width = 1600;
    const gap = 36;
    const loads = svgs.map(
      (svg) =>
        new Promise((resolve, reject) => {
          const clone = svg.cloneNode(true);
          const vb = (clone.getAttribute("viewBox") || "0 0 100 70").split(/\s+/).map(Number);
          const vw = vb[2] || 100;
          const vh = vb[3] || 70;
          const h = Math.round(width * (vh / vw));
          clone.setAttribute("width", String(width));
          clone.setAttribute("height", String(h));
          const xml = new XMLSerializer().serializeToString(clone);
          const blob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => {
            URL.revokeObjectURL(url);
            resolve({ img, h });
          };
          img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("image"));
          };
          img.src = url;
        })
    );
    Promise.all(loads)
      .then((parts) => {
        const totalH = parts.reduce((sum, p) => sum + p.h, 0) + gap * Math.max(0, parts.length - 1);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = totalH;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#2d7a4a";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        let y = 0;
        parts.forEach((p, i) => {
          ctx.drawImage(p.img, 0, y, width, p.h);
          y += p.h + (i < parts.length - 1 ? gap : 0);
        });
        canvas.toBlob((png) => {
          if (!png) {
            showToast("Could not save image");
            return;
          }
          const pngUrl = URL.createObjectURL(png);
          const a = document.createElement("a");
          a.href = pngUrl;
          a.download = `bengals-shot-map-${new Date().toISOString().slice(0, 10)}.png`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(pngUrl), 1500);
          showToast("Shot map saved");
        }, "image/png");
      })
      .catch(() => showToast("Could not save image"));
  }

  function renderMap() {
    const events = st.shots;
    const firstHalf = events.filter((e) => eventPeriod(e) === "1");
    const secondHalf = events.filter((e) => eventPeriod(e) === "2");
    const etOne = events.filter((e) => eventPeriod(e) === "ET1");
    const etTwo = events.filter((e) => eventPeriod(e) === "ET2");
    const hasEt = etOne.length > 0 || etTwo.length > 0;
    const usEvents = events.filter((e) => eventTeam(e) === "us");
    const oppEvents = events.filter((e) => eventTeam(e) === "opp");
    const vs = opponentOf(st.game)?.name || "Opponent";
    const dateLabel = st.game?.date || "";
    const halfOpts = { allPeriods: true, swapped: false, showGrid: false };
    root().innerHTML = `
      <div class="shot-map-page">
        ${trackerNav("map")}
        <div class="shot-map-actions no-print">
          <a class="btn btn-ghost" href="#shots">Back</a>
          <button type="button" class="btn btn-primary" id="shot-map-print">Print / PDF</button>
          <button type="button" class="btn btn-ghost" id="shot-map-save" ${events.length ? "" : "disabled"}>Save image</button>
        </div>
        <div class="shot-map-print" id="shot-map-print-root">
          <header class="shot-map-header">
            <h1>Brighton Bengals</h1>
            <p>
              <span class="shot-map-vs-print">${vs ? `vs ${escapeHtml(vs)}` : ""}</span>
              <span class="muted"> · ${escapeHtml(String(dateLabel))}</span>
            </p>
          </header>
          <div class="shot-map-dual">
            <div class="shot-map-team-block">
              <h2>Brighton</h2>
              <div class="shot-map-team-pitch">${halfPitchMarkup(events, Object.assign({ team: "us" }, halfOpts))}</div>
              <div class="tracker-summary">${summaryPills(trackerSummary(usEvents))}</div>
            </div>
            <div class="shot-map-team-block is-opp">
              <h2>${escapeHtml(vs)}</h2>
              <div class="shot-map-team-pitch">${halfPitchMarkup(events, Object.assign({ team: "opp" }, halfOpts))}</div>
              <div class="tracker-summary">${summaryPills(trackerSummary(oppEvents))}</div>
            </div>
          </div>
          <p class="shot-map-caption">Each map is that team’s attacking half (all periods overlaid). Goal at the top. Circles: Orange = goal · White = on target · Purple = blocked · Hollow = missed. Squares: Blue = assist · Lavender = 2nd assist · Purple = free kick · Blue = corner.</p>
          <div class="shot-map-combined">
            <h2>Full field (both teams)</h2>
            <div class="shot-map-pitch">${fullFieldMarkup(events)}</div>
            <p class="shot-map-caption">1st half / ET 1: Brighton attack right, opponent left. 2nd half / ET 2 reverse. Red ring = opponent.</p>
          </div>
          <div class="shot-map-stats">
            <div>
              <h2>1st Half</h2>
              <p class="shot-map-stat-split muted">Brighton</p>
              <div class="tracker-summary">${summaryPills(trackerSummary(firstHalf.filter((e) => eventTeam(e) === "us")))}</div>
              <p class="shot-map-stat-split muted">${escapeHtml(vs)}</p>
              <div class="tracker-summary">${summaryPills(trackerSummary(firstHalf.filter((e) => eventTeam(e) === "opp")))}</div>
            </div>
            <div>
              <h2>2nd Half</h2>
              <p class="shot-map-stat-split muted">Brighton</p>
              <div class="tracker-summary">${summaryPills(trackerSummary(secondHalf.filter((e) => eventTeam(e) === "us")))}</div>
              <p class="shot-map-stat-split muted">${escapeHtml(vs)}</p>
              <div class="tracker-summary">${summaryPills(trackerSummary(secondHalf.filter((e) => eventTeam(e) === "opp")))}</div>
            </div>
            ${
              hasEt
                ? `<div>
              <h2>ET 1</h2>
              <p class="shot-map-stat-split muted">Brighton</p>
              <div class="tracker-summary">${summaryPills(trackerSummary(etOne.filter((e) => eventTeam(e) === "us")))}</div>
              <p class="shot-map-stat-split muted">${escapeHtml(vs)}</p>
              <div class="tracker-summary">${summaryPills(trackerSummary(etOne.filter((e) => eventTeam(e) === "opp")))}</div>
            </div>
            <div>
              <h2>ET 2</h2>
              <p class="shot-map-stat-split muted">Brighton</p>
              <div class="tracker-summary">${summaryPills(trackerSummary(etTwo.filter((e) => eventTeam(e) === "us")))}</div>
              <p class="shot-map-stat-split muted">${escapeHtml(vs)}</p>
              <div class="tracker-summary">${summaryPills(trackerSummary(etTwo.filter((e) => eventTeam(e) === "opp")))}</div>
            </div>`
                : ""
            }
          </div>
        </div>
      </div>`;
    $("#shot-map-print")?.addEventListener("click", () => window.print());
    $("#shot-map-save")?.addEventListener("click", () => downloadSummaryImage());
  }

  function historyViewRow(row) {
    const mapped = mapShot(row);
    mapped.game = row.game;
    mapped.gameDate = row.game?.date || "";
    const b = brighton();
    mapped.opponentName = "";
    if (row.game) {
      mapped.opponentName =
        row.game.home_team_id === b?.id ? row.game.away_team?.name || "" : row.game.home_team?.name || "";
    }
    mapped.seasonLabel = row.game?.season?.label || "";
    mapped.shooterName = row.player?.name || mapped.shooterName;
    mapped.shooterShort = row.player?.short_name || mapped.shooterShort;
    return mapped;
  }

  async function runHistoryQuery() {
    const f = st.history;
    f.loading = true;
    draw();
    const filters = {};
    if (f.playerId) filters.playerId = f.playerId;
    if (f.seasonId === "__last3") filters.seasonYearMin = new Date().getFullYear() - 2;
    else if (f.seasonId) filters.seasonId = f.seasonId;
    if (f.opponentId) filters.opponentId = f.opponentId;
    if (f.depth === "outside") filters.depthIds = OUTSIDE_BOX_DEPTHS;
    if (f.depth === "box") filters.depthIds = ["6Y", "PS", "BOX"];
    if (f.depth && f.depth !== "outside" && f.depth !== "box" && f.depth !== "") {
      filters.depthIds = [f.depth];
    }
    try {
      const rows = await API.queryShots(filters);
      f.rows = rows.map(historyViewRow);
      f.loading = false;
    } catch (err) {
      st.error = err.message || "Query failed";
      f.loading = false;
    }
    draw();
  }

  function renderHistory() {
    bindEditModal();
    const f = st.history;
    const oppTeams = st.teams.filter((t) => !t.is_brighton);
    const rows = f.rows;
    root().innerHTML = `
      <div class="shots-admin shots-history">
        ${trackerNav("history")}
        <h1>Season history</h1>
        <p class="muted">Filter by player, opponent, and depth. Naming a player updates every shot tied to that player.</p>
        ${st.error ? `<p class="shots-error">${escapeHtml(st.error)}</p>` : ""}
        <form id="history-form" class="shots-form">
          <label class="shots-field">Season
            <select id="hist-season">
              <option value="">All seasons</option>
              <option value="__last3" ${f.seasonId === "__last3" ? "selected" : ""}>Last 3 years</option>
              ${seasonOptions(f.seasonId === "__last3" ? "" : f.seasonId, false)}
            </select>
          </label>
          <label class="shots-field">Player
            <select id="hist-player">
              <option value="">All players</option>
              ${st.namedPlayers
                .map(
                  (p) =>
                    `<option value="${p.id}" ${p.id === f.playerId ? "selected" : ""}>${escapeHtml(p.short_name || firstName(p.name) || p.name)}</option>`
                )
                .join("")}
            </select>
          </label>
          <label class="shots-field">Opponent
            <select id="hist-opp">
              <option value="">All opponents</option>
              ${oppTeams
                .map((t) => `<option value="${t.id}" ${t.id === f.opponentId ? "selected" : ""}>${escapeHtml(t.name)}</option>`)
                .join("")}
            </select>
          </label>
          <label class="shots-field">Depth
            <select id="hist-depth">
              <option value="" ${f.depth === "" ? "selected" : ""}>All locations</option>
              <option value="outside" ${f.depth === "outside" ? "selected" : ""}>Outside the box</option>
              <option value="box" ${f.depth === "box" ? "selected" : ""}>In the box</option>
              <option value="D" ${f.depth === "D" ? "selected" : ""}>Top of the box / Zone 14</option>
              <option value="AT" ${f.depth === "AT" ? "selected" : ""}>Attacking third</option>
              <option value="DEF" ${f.depth === "DEF" ? "selected" : ""}>Defensive half</option>
            </select>
          </label>
          <button type="submit" class="btn btn-primary">Run query</button>
        </form>
        ${
          rows
            ? `          <div class="tracker-toolbar">
            <span class="pill">Matches <strong>${rows.length}</strong></span>
            <button type="button" class="btn btn-ghost" id="hist-export" ${rows.length ? "" : "disabled"}>CSV of this view</button>
          </div>
          <section class="tracker-units">
            <h2>Units &amp; trends (Brighton)</h2>
            ${unitsMarkup(rows.filter((e) => eventTeam(e) === "us"))}
          </section>
          <div class="tracker-table-wrap">
            <table class="tracker-table">
              <thead>
                <tr>
                  <th class="tracker-edit-cell"><span class="sr-only">Edit</span></th>
                  <th>Gameclock</th>
                  <th>Game</th>
                  <th>Team</th>
                  <th>Result</th>
                  <th>Player</th>
                  <th>Pos</th>
                  <th>Miss</th>
                  <th>Assisted by</th>
                  <th>Assist type</th>
                  <th>Shot location</th>
                  <th>Assist location</th>
                  <th class="tracker-delete-cell"><span class="sr-only">Delete</span></th>
                </tr>
              </thead>
              <tbody>${shotTableRows(rows, { showGame: true })}</tbody>
            </table>
          </div>
          <p class="muted">Open a past game from Games, then Map, to see that game’s team-by-team shot maps.</p>`
            : `<p class="muted">Run a query to see shots across games.</p>`
        }
      </div>`;
    $("#history-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      st.history.seasonId = $("#hist-season").value;
      st.history.playerId = $("#hist-player").value;
      st.history.opponentId = $("#hist-opp").value;
      st.history.depth = $("#hist-depth").value;
      runHistoryQuery();
    });
    $("#hist-export")?.addEventListener("click", () => {
      exportShotsCsv(
        (rows || []).map((ev) => {
          ev.game = ev.game;
          return Object.assign({}, ev, {});
        }),
        `bengals-shots-filtered-${new Date().toISOString().slice(0, 10)}.csv`
      );
    });
    if (rows) {
      $$("[data-delete-shot]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = btn.getAttribute("data-delete-shot");
          if (!confirm("Delete this shot from the shared database?")) return;
          const result = await API.deleteShot(id);
          if (!result.ok) {
            showToast("Not saved — check connection");
            return;
          }
          st.history.rows = st.history.rows.filter((s) => s.id !== id);
          st.shots = st.shots.filter((s) => s.id !== id);
          draw({ keepScroll: true });
        });
      });
      $$("[data-edit-shot]").forEach((btn) => {
        btn.addEventListener("click", () => openEditShot(btn.getAttribute("data-edit-shot")));
      });
    }
  }

  const EXPLORE_STARTERS = [
    "Show me the trend of assists from midfielders this season",
    "Which forwards have been most successful creating shots on frame or goals from gap passes?",
    "Last time we played Viewmont, which of their players took the most shots and from what parts of the field?",
    "Where do Brighton goals tend to come from on the pitch?",
  ];

  function prepHashParams() {
    const raw = (location.hash || "").replace(/^#/, "");
    const path = raw.split("?")[0];
    const qs = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : "";
    const params = new URLSearchParams(qs);
    if (path === "shots-explore" && !params.get("tab")) params.set("tab", "explore");
    return { path, params };
  }

  function applyPrepHash() {
    const { params } = prepHashParams();
    st.prep.tab = params.get("tab") === "explore" ? "explore" : "opponent";
    const gameId = params.get("game") || "";
    if (gameId) {
      if (st.prep.lockedGameId !== gameId) {
        st.prep.lockedGameId = gameId;
        st.prep.selectedGameIds = [gameId];
        st.prep.includeFriendly = true;
        st.prep.loadKey = "";
        st.prep.gemini = emptyPrepGemini();
        st.prep.rows = null;
        const game = st.games.find((g) => g.id === gameId);
        const opp = game ? opponentOf(game) : null;
        if (opp) st.prep.opponentId = opp.id;
        if (game?.season_id) st.prep.seasonId = game.season_id;
      }
    } else if (st.prep.lockedGameId) {
      st.prep.lockedGameId = "";
      fillPrepSelectionFromCandidates();
      st.prep.loadKey = "";
      st.prep.gemini = emptyPrepGemini();
    }
  }

  function prepTabsMarkup(active) {
    return `
      <div class="prep-tabs" role="tablist" aria-label="Prep">
        <a class="prep-tab ${active === "opponent" ? "is-on" : ""}" href="#shots-prep" role="tab" aria-selected="${
          active === "opponent" ? "true" : "false"
        }">Opponent Prep</a>
        <a class="prep-tab ${active === "explore" ? "is-on" : ""}" href="#shots-prep?tab=explore" role="tab" aria-selected="${
          active === "explore" ? "true" : "false"
        }">Explore</a>
      </div>`;
  }

  function isOfficialGameType(type) {
    return type === "region" || type === "playoffs";
  }

  function prepCandidateGames() {
    const oppId = st.prep.opponentId;
    if (!oppId) return [];
    if (st.prep.lockedGameId) {
      const locked = st.games.find((g) => g.id === st.prep.lockedGameId);
      return locked ? [locked] : [];
    }
    return st.games.filter((g) => {
      const opp = opponentOf(g);
      if (!opp || opp.id !== oppId) return false;
      if (st.prep.seasonId && g.season_id !== st.prep.seasonId) return false;
      if (!st.prep.includeFriendly && !isOfficialGameType(g.game_type)) return false;
      return true;
    });
  }

  function prepSelectedIds() {
    if (st.prep.lockedGameId) return [st.prep.lockedGameId];
    const allowed = new Set(prepCandidateGames().map((g) => g.id));
    return (st.prep.selectedGameIds || []).filter((id) => allowed.has(id));
  }

  function fillPrepSelectionFromCandidates() {
    st.prep.selectedGameIds = prepCandidateGames().map((g) => g.id);
  }

  function prepLoadKey() {
    return [
      st.prep.opponentId || "",
      prepSelectedIds().slice().sort().join(","),
      st.prep.includeFriendly ? "1" : "0",
      st.prep.seasonId || "",
      st.prep.lockedGameId || "",
    ].join("|");
  }

  function tacticalPoint(loc, team) {
    const x = Number(loc?.x);
    const y = Number(loc?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (team === "opp") return { fx: PW - x, fy: PL - y };
    return { fx: x, fy: y };
  }

  function prepVisibleRows() {
    const rows = st.prep.rows || [];
    return rows.filter((ev) => {
      const team = eventTeam(ev);
      if (st.prep.teamFilter === "us" && team !== "us") return false;
      if (st.prep.teamFilter === "opp" && team !== "opp") return false;
      const period = eventPeriod(ev);
      if (st.prep.periodFilter !== "all" && period !== st.prep.periodFilter) return false;
      if (st.prep.resultFilter === "goals") {
        return ev.result === "goal" || ev.result === "pk-goal";
      }
      if (st.prep.resultFilter === "on-frame") {
        return ev.result === "goal" || ev.result === "on-target" || ev.result === "pk-goal";
      }
      return true;
    });
  }

  function prepPlayerLabel(ev) {
    const team = eventTeam(ev);
    return eventPersonLabel(team, ev.shooterNumber, ev.shooterName, ev.shooterShort);
  }

  function prepClockLabel(ev) {
    const face = goalMinuteLabel(ev);
    if (face) return face;
    const p = eventPeriod(ev);
    return p === "1" ? "1H" : p === "2" ? "2H" : p;
  }

  function prepShotPopupMarkup(ev) {
    if (!ev) return "";
    const team = eventTeam(ev);
    const shot = tacticalPoint(ev.shot, team);
    if (!shot) return "";
    const vbX = -4;
    const vbY = -5;
    const vbW = PW + 8;
    const vbH = PL + 10;
    const left = ((shot.fx - vbX) / vbW) * 100;
    const top = ((shot.fy - vbY) / vbH) * 100;
    const place = [];
    if (shot.fy < PL * 0.28) place.push("is-below");
    if (shot.fx < PW * 0.22) place.push("is-start");
    else if (shot.fx > PW * 0.78) place.push("is-end");
    const player = prepPlayerLabel(ev);
    const result = SHOT_RESULT_LABELS[ev.result] || ev.result || "";
    const clock = prepClockLabel(ev);
    const zone = ev.shot?.zoneLabel || ev.shot?.zoneId || "";
    const date = String(ev.gameDate || ev.game?.date || "").slice(0, 10);
    const teamBit = team === "opp" ? "Opponent" : ourTeamName();
    let assist = "";
    if (ev.assist) {
      const who = eventPersonLabel(team, ev.assist.number, ev.assist.name, ev.assist.short);
      const kind = ASSIST_TYPE_LABELS[ev.assist.type] || ev.assist.type || "";
      assist = `<p>Assist ${escapeHtml(who)}${kind ? ` · ${escapeHtml(kind)}` : ""}</p>`;
    }
    return `
      <div class="prep-shot-popup ${place.join(" ")}" id="prep-shot-popup" role="status" style="--x:${left}%; --y:${top}%;">
        <button type="button" class="prep-shot-popup-close" id="prep-shot-popup-close" aria-label="Close shot details">×</button>
        <p class="prep-shot-popup-kicker">${escapeHtml(teamBit)}</p>
        ${player && player !== "—" ? `<p class="prep-shot-popup-player">${escapeHtml(player)}</p>` : ""}
        <p class="prep-shot-popup-result">${escapeHtml(result)}</p>
        <p>${escapeHtml([clock, zone].filter(Boolean).join(" · "))}</p>
        ${date ? `<p class="prep-shot-popup-date">${escapeHtml(date)}</p>` : ""}
        ${assist}
      </div>`;
  }

  function prepShotPayload(ev) {
    return {
      team: eventTeam(ev),
      player: prepPlayerLabel(ev),
      jersey: ev.shooterNumber || "",
      position: ev.position || "",
      period: eventPeriod(ev),
      clock: prepClockLabel(ev),
      result: ev.result,
      zone: ev.shot?.zoneId || ev.shot?.zoneLabel || "",
      x: ev.shot?.x,
      y: ev.shot?.y,
      game_date: ev.gameDate || ev.game?.date || "",
      assist: ev.assist
        ? {
            player: eventPersonLabel(
              eventTeam(ev),
              ev.assist.number,
              ev.assist.name,
              ev.assist.short
            ),
            type: ev.assist.type || "",
            zone: ev.assist.zoneId || ev.assist.zoneLabel || "",
          }
        : null,
    };
  }

  function prepAggregates(rows) {
    const byTeam = (team) => trackerSummary(rows.filter((e) => eventTeam(e) === team));
    const playerMap = {};
    rows.forEach((ev) => {
      const key = `${eventTeam(ev)}:${prepPlayerLabel(ev)}`;
      if (!playerMap[key]) {
        playerMap[key] = {
          team: eventTeam(ev),
          player: prepPlayerLabel(ev),
          shots: 0,
          goals: 0,
          on_frame: 0,
          assists: 0,
        };
      }
      const row = playerMap[key];
      if (SHOT_RESULTS.has(ev.result)) row.shots += 1;
      if (ev.result === "goal" || ev.result === "pk-goal") row.goals += 1;
      if (ev.result === "goal" || ev.result === "on-target" || ev.result === "pk-goal") row.on_frame += 1;
    });
    rows.forEach((ev) => {
      if (!ev.assist) return;
      const who = eventPersonLabel(eventTeam(ev), ev.assist.number, ev.assist.name, ev.assist.short);
      const key = `${eventTeam(ev)}:${who}`;
      if (!playerMap[key]) {
        playerMap[key] = { team: eventTeam(ev), player: who, shots: 0, goals: 0, on_frame: 0, assists: 0 };
      }
      playerMap[key].assists += 1;
    });
    const players = Object.values(playerMap).sort((a, b) => b.shots + b.assists - (a.shots + a.assists));
    return { us: byTeam("us"), opp: byTeam("opp"), players: players.slice(0, 16) };
  }

  function tacticalPitchMarkup(events, selectedId) {
    const line = "#f2f6f3";
    const goalW = 7.32;
    const goalX = (PW - goalW) / 2;
    const penW = 40.32;
    const penH = 16.5;
    const sixW = 18.32;
    const sixH = 5.5;
    const penX = (PW - penW) / 2;
    const sixX = (PW - sixW) / 2;
    const arcR = 9.15;
    const spotInset = 11;
    const dx = Math.sqrt(Math.max(0, arcR * arcR - (penH - spotInset) * (penH - spotInset)));
    const stripes = [];
    for (let i = 0; i < 6; i += 1) {
      stripes.push(
        `<rect fill="${i % 2 ? "#277047" : "#2d7a4a"}" x="0" y="${i * (PL / 6)}" width="${PW}" height="${PL / 6}" />`
      );
    }
    const markers = events
      .map((ev) => {
        const team = eventTeam(ev);
        const shot = tacticalPoint(ev.shot, team);
        if (!shot) return "";
        const selected = selectedId && ev.id === selectedId;
        const ring = team === "opp" ? "#c0392b" : ev.result === "missed" || ev.result === "pk-missed" ? "#ffffff" : "#0b1f33";
        const numFill = team === "opp" || ev.result === "missed" || ev.result === "pk-missed" ? "#ffffff" : "#0b1f33";
        let html = "";
        if (ev.secondAssist) {
          const s = tacticalPoint(ev.secondAssist, team);
          const aEnd = ev.assist ? tacticalPoint(ev.assist, team) : shot;
          if (s && aEnd) {
            html += `<line x1="${s.fx}" y1="${s.fy}" x2="${aEnd.fx}" y2="${aEnd.fy}" stroke="rgba(197,163,232,0.9)" stroke-width="0.28" stroke-dasharray="0.7 0.7" fill="none" />`;
            html += svgSquare(s.fx, s.fy, 1.5, `fill="#c5a3e8" stroke="${ring}" stroke-width="0.2"`);
          }
        }
        if (ev.assist) {
          const a = tacticalPoint(ev.assist, team);
          if (a) {
            html += `<line x1="${a.fx}" y1="${a.fy}" x2="${shot.fx}" y2="${shot.fy}" stroke="rgba(255,255,255,0.85)" stroke-width="0.28" stroke-dasharray="1.1 0.7" fill="none" />`;
            html += svgSquare(a.fx, a.fy, 1.7, `fill="#7ec8e3" stroke="${ring}" stroke-width="0.2"`);
          }
        }
        html += shotShapeMarkup(ev, shot.fx, shot.fy, {
          size: selected ? 4.7 : 3.7,
          className: "prep-shot-dot",
          fill: resultFill(ev.result),
          stroke: selected ? "#f7e27c" : ring,
          strokeWidth: selected ? 0.55 : team === "opp" ? 0.42 : 0.28,
          attrs: `data-prep-shot="${escapeHtml(ev.id || "")}"`,
        });
        if (ev.shooterNumber !== undefined && ev.shooterNumber !== null && String(ev.shooterNumber) !== "") {
          html += `<text data-prep-shot="${escapeHtml(ev.id || "")}" x="${shot.fx}" y="${shot.fy}" fill="${numFill}" font-size="1.2" font-weight="700" text-anchor="middle" dominant-baseline="central">${escapeHtml(
            String(ev.shooterNumber)
          )}</text>`;
        }
        return html;
      })
      .join("");
    return `
      <svg class="prep-pitch-svg" viewBox="-4 -5 ${PW + 8} ${PL + 10}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Tactical pitch. Brighton attack up, opponent attack down.">
        ${stripes.join("")}
        <rect x="0" y="0" width="${PW}" height="${PL}" fill="none" stroke="${line}" stroke-width="0.45" />
        <line x1="0" y1="${HALF_L}" x2="${PW}" y2="${HALF_L}" stroke="${line}" stroke-width="0.4" />
        <circle cx="${PW / 2}" cy="${HALF_L}" r="9.15" fill="none" stroke="${line}" stroke-width="0.35" />
        <circle cx="${PW / 2}" cy="${HALF_L}" r="0.45" fill="${line}" />
        <rect x="${goalX}" y="-1.4" width="${goalW}" height="1.4" fill="none" stroke="${line}" stroke-width="0.45" />
        <rect x="${goalX}" y="${PL}" width="${goalW}" height="1.4" fill="none" stroke="${line}" stroke-width="0.45" />
        <rect x="${penX}" y="0" width="${penW}" height="${penH}" fill="none" stroke="${line}" stroke-width="0.35" />
        <rect x="${penX}" y="${PL - penH}" width="${penW}" height="${penH}" fill="none" stroke="${line}" stroke-width="0.35" />
        <rect x="${sixX}" y="0" width="${sixW}" height="${sixH}" fill="none" stroke="${line}" stroke-width="0.35" />
        <rect x="${sixX}" y="${PL - sixH}" width="${sixW}" height="${sixH}" fill="none" stroke="${line}" stroke-width="0.35" />
        <circle cx="${PW / 2}" cy="${spotInset}" r="0.45" fill="${line}" />
        <circle cx="${PW / 2}" cy="${PL - spotInset}" r="0.45" fill="${line}" />
        <path d="M ${PW / 2 - dx} ${penH} A ${arcR} ${arcR} 0 0 0 ${PW / 2 + dx} ${penH}" fill="none" stroke="${line}" stroke-width="0.35" />
        <path d="M ${PW / 2 - dx} ${PL - penH} A ${arcR} ${arcR} 0 0 1 ${PW / 2 + dx} ${PL - penH}" fill="none" stroke="${line}" stroke-width="0.35" />
        <text x="${PW / 2}" y="-2.4" fill="${line}" font-size="2.4" font-weight="750" text-anchor="middle">Brighton attack</text>
        <text x="${PW / 2}" y="${PL + 3.6}" fill="${line}" font-size="2.4" font-weight="750" text-anchor="middle">Opponent attack</text>
        ${markers}
      </svg>`;
  }

  function prepFilterChip(name, value, current, label) {
    return `<button type="button" class="plays-filter-btn ${current === value ? "is-on" : ""}" data-prep-filter="${name}" data-prep-value="${escapeHtml(
      value
    )}">${escapeHtml(label)}</button>`;
  }

  function prepTagSuggestions(rows) {
    const seen = new Set();
    const out = [];
    const add = (raw) => {
      const tag = String(raw || "")
        .trim()
        .toLowerCase();
      if (!tag || seen.has(tag)) return;
      seen.add(tag);
      out.push(tag);
    };
    (rows || []).forEach((ev) => {
      if (ev.shooterShort) add(ev.shooterShort);
      else if (ev.shooterName) add(firstName(ev.shooterName));
      if (ev.shooterNumber) add(`#${ev.shooterNumber}`);
      if (ev.assist?.short) add(ev.assist.short);
      else if (ev.assist?.name) add(firstName(ev.assist.name));
    });
    return out.slice(0, 24);
  }

  function markdownLite(text) {
    const escaped = escapeHtml(text || "").replace(/\r\n/g, "\n");
    const withHead = escaped
      .replace(/^### (.+)$/gm, "<h3>$1</h3>")
      .replace(/^## (.+)$/gm, "<h3>$1</h3>")
      .replace(/^# (.+)$/gm, "<h3>$1</h3>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    return withHead
      .split(/\n{2,}/)
      .map((block) => {
        if (block.startsWith("<h3>")) return block.replace(/\n/g, "<br>");
        return `<p>${block.replace(/\n/g, "<br>")}</p>`;
      })
      .join("");
  }

  async function loadPrepData() {
    if (st.prep.lockedGameId && !st.games.find((g) => g.id === st.prep.lockedGameId)) {
      try {
        const g = await API.game(st.prep.lockedGameId);
        if (g && !st.games.some((x) => x.id === g.id)) st.games.unshift(g);
        const opp = opponentOf(g);
        if (opp) st.prep.opponentId = opp.id;
        if (g?.season_id) st.prep.seasonId = g.season_id;
      } catch (err) {
        st.error = err.message || "Could not load that game";
      }
    }
    const key = prepLoadKey();
    st.prep.loading = true;
    st.prep.loadKey = key;
    draw();
    try {
      const ids = prepSelectedIds();
      const rows = ids.length ? await API.queryShots({ gameIds: ids }) : [];
      st.prep.rows = rows.map(historyViewRow);
      try {
        st.prep.notes = ids.length ? await API.notesForGames(ids) : [];
      } catch (noteErr) {
        st.prep.notes = [];
        if (!/schema cache|could not find/i.test(String(noteErr.message || ""))) {
          st.error = noteErr.message || "Could not load notes";
        }
      }
    } catch (err) {
      st.error = err.message || "Could not load prep shots";
      st.prep.rows = [];
      st.prep.notes = [];
    }
    st.prep.loading = false;
    if (st.prep.loadKey === key) draw();
  }

  function emptyPrepGemini() {
    return { loading: false, error: "", messages: [], draft: "" };
  }

  const PREP_FOLLOWUPS = [
    { label: "Chances by area", q: "Which parts of the field are yielding better chances?" },
    { label: "Player impact", q: "Which players are having the biggest impact?" },
    { label: "By period", q: "How does the chance quality change by period?" },
    { label: "Next meeting", q: "What should we take into the next meeting?" },
  ];

  async function runPrepGemini(question) {
    const visible = prepVisibleRows();
    const g = st.prep.gemini;
    if (!g.messages) g.messages = [];
    const q = String(question || "").trim();
    const starting = !g.messages.length;
    if (!visible.length || g.loading) return;
    if (!starting && !q) return;
    const games = prepCandidateGames().filter((x) => prepSelectedIds().includes(x.id));
    const live = !!(st.prep.lockedGameId && st.game && st.game.id === st.prep.lockedGameId);
    if (!starting) {
      g.messages.push({ role: "user", content: q });
      g.draft = "";
    }
    g.loading = true;
    g.error = "";
    draw();
    const opp = st.teams.find((t) => t.id === st.prep.opponentId);
    const periods = [...new Set(visible.map((e) => eventPeriod(e)))];
    const history = starting
      ? []
      : g.messages
          .slice(0, -1)
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role, content: m.content }));
    const result = await API.prepOpponent({
      our_team: ourTeamName(),
      opponent: opp?.name || "Opponent",
      in_progress: live,
      periods,
      games: games.map((row) => ({ date: row.date, game_type: row.game_type })),
      aggregates: prepAggregates(visible),
      shots: visible.map(prepShotPayload),
      question: starting ? "" : q,
      history,
    });
    g.loading = false;
    if (!result.ok) {
      g.error = result.error || "Prep chat failed";
    } else {
      g.error = "";
      g.messages.push({ role: "assistant", content: result.data?.answer || "" });
    }
    draw();
  }

  function prepActiveFilterCount() {
    let n = 0;
    if (st.prep.teamFilter !== "both") n += 1;
    if (st.prep.resultFilter !== "all") n += 1;
    if (st.prep.periodFilter !== "all") n += 1;
    return n;
  }

  function prepOpponentName() {
    return st.teams.find((t) => t.id === st.prep.opponentId)?.name || "Opponent";
  }

  function closePrepConfig() {
    st.prep.showConfig = false;
    const modal = $("#prep-config-modal");
    if (modal) modal.hidden = true;
  }

  function openPrepConfig() {
    st.prep.showConfig = true;
    const modal = $("#prep-config-modal");
    if (modal) modal.hidden = false;
  }

  let prepConfigModalBound = false;
  function bindPrepConfigModalOnce() {
    if (prepConfigModalBound) return;
    const modal = $("#prep-config-modal");
    if (!modal) return;
    prepConfigModalBound = true;
    modal.addEventListener("click", (e) => {
      if (e.target.closest("[data-close-prep-config]")) {
        e.preventDefault();
        closePrepConfig();
      }
    });
  }

  function fillPrepConfigModal(oppTeams, gameChecks) {
    const body = $("#prep-config-body");
    if (body) {
      body.innerHTML = `
        <div class="prep-scope shots-form">
          <label class="shots-field">Opponent
            <select id="prep-opponent" ${st.prep.lockedGameId ? "disabled" : ""}>
              <option value="">Select opponent…</option>
              ${oppTeams
                .map(
                  (t) =>
                    `<option value="${t.id}" ${t.id === st.prep.opponentId ? "selected" : ""}>${escapeHtml(t.name)}</option>`
                )
                .join("")}
            </select>
          </label>
          ${
            st.prep.lockedGameId
              ? `<p><a class="prep-unlock" href="#shots-prep">Show all meetings with this opponent</a></p>`
              : `<label class="shots-field">Season
            <select id="prep-season">
              <option value="">All seasons</option>
              ${seasonOptions(st.prep.seasonId, false)}
            </select>
          </label>
          <label class="prep-friendly-check">
            <input type="checkbox" id="prep-friendly" ${st.prep.includeFriendly ? "checked" : ""} />
            Include friendly / preseason
          </label>`
          }
          <div class="prep-game-set">
            <p class="prep-game-set-label">Games</p>
            ${gameChecks}
          </div>
        </div>`;
    }
    const modal = $("#prep-config-modal");
    if (modal) modal.hidden = !st.prep.showConfig;
    bindPrepConfigModalOnce();
    bindPrepConfigFields();
  }

  function prepSessionMarkup(lockedGame, selectedIds) {
    const oppName = prepOpponentName();
    if (!st.prep.opponentId && !st.prep.lockedGameId) {
      return `
        <div class="prep-empty">
          <p class="prep-empty-title">Set up this prep session</p>
          <p class="muted">Choose an opponent and which games to overlay. Filters, stats, and notes stay one tap away after that.</p>
          <button type="button" class="btn btn-primary" id="prep-config-open">Choose opponent</button>
        </div>`;
    }
    let meta;
    if (st.prep.lockedGameId) {
      meta = `This game only · ${escapeHtml(gameTitle(lockedGame))}`;
    } else {
      const season = st.seasons.find((s) => s.id === st.prep.seasonId);
      const n = selectedIds.length;
      const bits = [
        season?.label || (st.prep.seasonId ? "Season" : "All seasons"),
        `${n} game${n === 1 ? "" : "s"}`,
      ];
      if (st.prep.includeFriendly) bits.push("friendlies on");
      meta = escapeHtml(bits.join(" · "));
    }
    return `
      <div class="prep-session${st.prep.lockedGameId ? " prep-locked-banner" : ""}">
        <div class="prep-session-copy">
          <p class="prep-session-opp">${escapeHtml(oppName)}</p>
          <p class="prep-session-meta">${meta}</p>
        </div>
        <button type="button" class="btn btn-ghost prep-session-setup" id="prep-config-open">Setup</button>
      </div>`;
  }

  function prepPitchToolbarMarkup() {
    const filterN = prepActiveFilterCount();
    return `
      <div class="prep-pitch-toolbar">
        <button type="button" class="prep-pitch-tool${st.prep.showFilters ? " is-on" : ""}${
          filterN ? " is-filtered" : ""
        }" id="prep-filter-toggle" aria-expanded="${st.prep.showFilters ? "true" : "false"}" aria-controls="prep-filter-panel">
          Filter${filterN ? `<span class="prep-tool-badge">${filterN}</span>` : ""}
        </button>
        <button type="button" class="prep-pitch-tool${st.prep.showStats ? " is-on" : ""}" id="prep-stats-toggle" aria-expanded="${
          st.prep.showStats ? "true" : "false"
        }" aria-controls="prep-stats-panel">
          Stats
        </button>
      </div>`;
  }

  function prepFilterPanelMarkup() {
    if (!st.prep.showFilters) return "";
    return `
      <div class="prep-pitch-panel" id="prep-filter-panel" role="dialog" aria-label="Shot filters">
        <div class="plays-filters">
          <div class="plays-filter-row">
            <span class="plays-filter-label">Team</span>
            <div class="plays-filter-btns">
              ${prepFilterChip("teamFilter", "both", st.prep.teamFilter, "Both")}
              ${prepFilterChip("teamFilter", "us", st.prep.teamFilter, ourTeamName())}
              ${prepFilterChip("teamFilter", "opp", st.prep.teamFilter, "Opp")}
            </div>
          </div>
          <div class="plays-filter-row">
            <span class="plays-filter-label">Result</span>
            <div class="plays-filter-btns">
              ${prepFilterChip("resultFilter", "all", st.prep.resultFilter, "All")}
              ${prepFilterChip("resultFilter", "goals", st.prep.resultFilter, "Goals")}
              ${prepFilterChip("resultFilter", "on-frame", st.prep.resultFilter, "On frame")}
            </div>
          </div>
          <div class="plays-filter-row">
            <span class="plays-filter-label">Period</span>
            <div class="plays-filter-btns">
              ${prepFilterChip("periodFilter", "all", st.prep.periodFilter, "All")}
              ${prepFilterChip("periodFilter", "1", st.prep.periodFilter, "1st")}
              ${prepFilterChip("periodFilter", "2", st.prep.periodFilter, "2nd")}
              ${prepFilterChip("periodFilter", "ET1", st.prep.periodFilter, "ET1")}
              ${prepFilterChip("periodFilter", "ET2", st.prep.periodFilter, "ET2")}
            </div>
          </div>
        </div>
      </div>`;
  }

  function prepStatsPanelMarkup(aggregates) {
    if (!st.prep.showStats) return "";
    return `
      <div class="prep-pitch-panel prep-stats-panel" id="prep-stats-panel" role="dialog" aria-label="Shot totals">
        <div class="prep-stats-grid">
          <div>
            <p class="prep-stat-split">${escapeHtml(ourTeamName())}</p>
            <div class="tracker-summary">${summaryPills(aggregates.us)}</div>
          </div>
          <div>
            <p class="prep-stat-split">${escapeHtml(prepOpponentName())}</p>
            <div class="tracker-summary">${summaryPills(aggregates.opp)}</div>
          </div>
        </div>
        <p class="prep-legend">Orange goal · White on target · Purple blocked · Hollow missed. Blue square assist · Lavender 2nd assist.</p>
      </div>`;
  }

  function prepGeminiMarkup(visible) {
    const g = st.prep.gemini;
    const msgs = g.messages || [];
    const transcript = msgs
      .map((m) =>
        m.role === "user"
          ? `<div class="explore-msg is-user"><p>${escapeHtml(m.content)}</p></div>`
          : `<div class="explore-msg is-assistant"><div class="prep-gemini-answer">${markdownLite(m.content)}</div></div>`
      )
      .join("");
    const started = msgs.length > 0;
    const last = msgs[msgs.length - 1];
    const showFollowups = started && !g.loading && last?.role === "assistant";
    const typing = !!String(g.draft || "").trim();
    const chips = showFollowups
      ? `<div class="prep-followups" id="prep-followups" role="group" aria-label="Further analysis" ${
          typing ? "hidden" : ""
        }>${PREP_FOLLOWUPS.map(
          (item) =>
            `<button type="button" class="prep-followup" data-prep-followup="${escapeHtml(item.q)}" ${
              g.loading ? "disabled" : ""
            }>${escapeHtml(item.label)}</button>`
        ).join("")}</div>`
      : "";
    return `
      <section class="prep-gemini">
        <div class="prep-gemini-head">
          <p class="prep-gemini-kicker">Analysis</p>
          <h2>Gemini</h2>
        </div>
        <p class="prep-gemini-lede">${
          started
            ? "Follow-ups use the shots currently on the pitch."
            : "A briefing from the shots on the pitch — not lineup guesses."
        }</p>
        ${
          started
            ? `<div class="explore-transcript prep-gemini-transcript" id="prep-gemini-transcript">${transcript}${
                g.loading ? `<p class="explore-loading">Working…</p>` : ""
              }</div>`
            : ""
        }
        ${g.error ? `<p class="shots-error">${escapeHtml(g.error)}</p>` : ""}
        ${chips}
        ${
          started
            ? `<form id="prep-gemini-form" class="explore-form">
          <label class="sr-only" for="prep-gemini-input">Follow-up</label>
          <textarea id="prep-gemini-input" class="explore-input" rows="2" maxlength="2000" placeholder="Ask a follow-up…" ${
            g.loading ? "disabled" : ""
          }>${escapeHtml(g.draft || "")}</textarea>
          <div class="explore-form-actions">
            <button type="submit" class="btn btn-primary" ${g.loading ? "disabled" : ""}>Ask</button>
            <button type="button" class="btn btn-ghost" id="prep-gemini-clear" ${g.loading ? "disabled" : ""}>New briefing</button>
          </div>
        </form>`
            : `<button type="button" class="btn btn-primary" id="prep-gemini-run" ${
                visible.length && !g.loading ? "" : "disabled"
              }>${g.loading ? "Summarizing…" : "Start briefing"}</button>`
        }
      </section>`;
  }

  function prepNotesMarkup(notesList, noteGameChoices, suggestBtns) {
    const open = st.prep.showNoteForm;
    return `
      <section class="prep-notes">
        <div class="prep-section-head">
          <h2>Notes</h2>
        </div>
        <button type="button" class="btn btn-ghost prep-note-add-btn" id="prep-note-add">${
          open ? "Cancel" : "Add note"
        }</button>
        <div class="prep-note-list">${notesList}</div>
        ${
          open
            ? `<form id="prep-note-form" class="shots-form prep-note-form">
          <label class="shots-field">Game
            <select id="prep-note-game" ${st.prep.lockedGameId ? "disabled" : ""}>
              ${noteGameChoices
                .map(
                  (g) =>
                    `<option value="${g.id}" ${g.id === st.prep.noteGameId ? "selected" : ""}>${escapeHtml(
                      gameTitle(g)
                    )}</option>`
                )
                .join("")}
            </select>
          </label>
          <label class="shots-field">Note
            <textarea id="prep-note-body" class="explore-input" rows="3" maxlength="4000" placeholder="They overload our left after 30'">${escapeHtml(
              st.prep.noteBody
            )}</textarea>
          </label>
          <label class="shots-field">Tags
            <input type="text" id="prep-note-tags" value="${escapeHtml(st.prep.noteTags)}" placeholder="pip, #9, press" />
          </label>
          <div class="prep-tag-row">${suggestBtns}</div>
          <label class="shots-field">Your name (optional)
            <input type="text" id="prep-note-author" maxlength="40" value="${escapeHtml(st.prep.noteAuthor)}" />
          </label>
          <button type="submit" class="btn btn-secondary" ${noteGameChoices.length ? "" : "disabled"}>Save note</button>
        </form>`
            : ""
        }
      </section>`;
  }

  function bindPrepConfigFields() {
    $("#prep-config-open")?.addEventListener("click", () => openPrepConfig());
    $("#prep-opponent")?.addEventListener("change", (e) => {
      st.prep.opponentId = e.target.value;
      st.prep.loadKey = "";
      st.prep.gemini = emptyPrepGemini();
      st.prep.rows = null;
      st.prep.notes = [];
      st.prep.showFilters = false;
      st.prep.showStats = false;
      fillPrepSelectionFromCandidates();
      draw();
    });
    $("#prep-season")?.addEventListener("change", (e) => {
      st.prep.seasonId = e.target.value;
      st.prep.loadKey = "";
      st.prep.gemini = emptyPrepGemini();
      st.prep.showFilters = false;
      st.prep.showStats = false;
      fillPrepSelectionFromCandidates();
      draw();
    });
    $("#prep-friendly")?.addEventListener("change", (e) => {
      st.prep.includeFriendly = !!e.target.checked;
      st.prep.loadKey = "";
      st.prep.gemini = emptyPrepGemini();
      st.prep.showFilters = false;
      st.prep.showStats = false;
      fillPrepSelectionFromCandidates();
      draw();
    });
    $$("[data-prep-game]").forEach((box) => {
      box.addEventListener("change", () => {
        st.prep.selectedGameIds = $$("[data-prep-game]:checked").map((el) => el.getAttribute("data-prep-game"));
        st.prep.loadKey = "";
        st.prep.gemini = emptyPrepGemini();
        st.prep.showFilters = false;
        st.prep.showStats = false;
        draw();
      });
    });
  }

  function renderPrep() {
    applyPrepHash();
    if (st.prep.tab === "explore") {
      closePrepConfig();
      renderExplore();
      return;
    }
    renderOpponentPrep();
  }

  function renderOpponentPrep() {
    if (!st.prep.seasonId && st.seasonId) st.prep.seasonId = st.seasonId;
    const candidates = prepCandidateGames();
    const key = prepLoadKey();
    if ((st.prep.opponentId || st.prep.lockedGameId) && key !== st.prep.loadKey && !st.prep.loading) {
      loadPrepData();
    }
    const oppTeams = st.teams.filter((t) => !t.is_brighton);
    const selectedIds = prepSelectedIds();
    const visible = prepVisibleRows();
    const aggregates = prepAggregates(visible);
    const lockedGame = st.prep.lockedGameId ? st.games.find((g) => g.id === st.prep.lockedGameId) : null;
    const selectedShot = visible.find((e) => e.id === st.prep.selectedShotId) || null;
    const suggestions = prepTagSuggestions(visible);
    const noteGameChoices = st.prep.lockedGameId
      ? candidates
      : candidates.filter((g) => selectedIds.includes(g.id));
    if (!st.prep.noteGameId && noteGameChoices.length) st.prep.noteGameId = noteGameChoices[0].id;
    const hasSession = !!(st.prep.opponentId || st.prep.lockedGameId);

    const gameChecks = st.prep.lockedGameId
      ? `<p class="muted">This game only · ${escapeHtml(gameTitle(lockedGame))} · recorded periods so far.</p>`
      : candidates
          .map(
            (g) => `
            <label class="prep-game-check">
              <input type="checkbox" data-prep-game="${escapeHtml(g.id)}" ${
                selectedIds.includes(g.id) ? "checked" : ""
              } />
              <span>${escapeHtml(String(g.date || "").slice(0, 10))} · ${escapeHtml(g.game_type || "")}</span>
            </label>`
          )
          .join("") || `<p class="muted">No games match this opponent and season filter.</p>`;

    const notesList =
      (st.prep.notes || [])
        .map((note) => {
          const game = st.games.find((g) => g.id === note.game_id);
          const tags = (note.tags || []).map((t) => `<span class="prep-tag">${escapeHtml(t)}</span>`).join("");
          return `
          <article class="prep-note">
            <p class="prep-note-meta">${escapeHtml(gameTitle(game))}${
              note.author_label ? ` · ${escapeHtml(note.author_label)}` : ""
            }</p>
            <p class="prep-note-body">${escapeHtml(note.body)}</p>
            ${tags ? `<p class="prep-note-tags">${tags}</p>` : ""}
            <button type="button" class="btn btn-ghost prep-note-del" data-del-note="${escapeHtml(note.id)}">Delete</button>
          </article>`;
        })
        .join("") || `<p class="muted">No notes on these games yet.</p>`;

    const suggestBtns = suggestions
      .map((t) => `<button type="button" class="prep-tag-suggest" data-prep-tag="${escapeHtml(t)}">#${escapeHtml(t)}</button>`)
      .join("");

    const board = st.prep.loading
      ? `<p class="explore-loading">Loading shots…</p>`
      : hasSession
        ? `
        <div class="prep-board">
          <section class="prep-pitch-section">
            <div class="prep-pitch-wrap">
              ${prepPitchToolbarMarkup()}
              ${prepFilterPanelMarkup()}
              ${prepStatsPanelMarkup(aggregates)}
              <div class="prep-pitch-field">${tacticalPitchMarkup(visible, st.prep.selectedShotId)}</div>
              ${selectedShot ? prepShotPopupMarkup(selectedShot) : ""}
            </div>
            <p class="prep-pitch-caption">${visible.length} play${visible.length === 1 ? "" : "s"} · Brighton attack up${
              selectedShot ? "" : " · tap a shot"
            }</p>
          </section>
          ${prepGeminiMarkup(visible)}
          ${prepNotesMarkup(notesList, noteGameChoices, suggestBtns)}
        </div>`
        : "";

    root().innerHTML = `
      <div class="shots-admin shots-prep">
        ${trackerNav()}
        <h1>Prep</h1>
        ${prepTabsMarkup("opponent")}
        ${st.error ? `<p class="shots-error">${escapeHtml(st.error)}</p>` : ""}
        ${prepSessionMarkup(lockedGame, selectedIds)}
        ${board}
      </div>`;

    fillPrepConfigModal(oppTeams, gameChecks);
    $("#prep-filter-toggle")?.addEventListener("click", (e) => {
      e.stopPropagation();
      st.prep.showFilters = !st.prep.showFilters;
      if (st.prep.showFilters) st.prep.showStats = false;
      draw({ keepScroll: true });
    });
    $("#prep-stats-toggle")?.addEventListener("click", (e) => {
      e.stopPropagation();
      st.prep.showStats = !st.prep.showStats;
      if (st.prep.showStats) st.prep.showFilters = false;
      draw({ keepScroll: true });
    });
    $("#prep-filter-panel")?.addEventListener("click", (e) => e.stopPropagation());
    $("#prep-stats-panel")?.addEventListener("click", (e) => e.stopPropagation());
    $$("[data-prep-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const name = btn.getAttribute("data-prep-filter");
        const value = btn.getAttribute("data-prep-value");
        if (name === "teamFilter") st.prep.teamFilter = value;
        if (name === "resultFilter") st.prep.resultFilter = value;
        if (name === "periodFilter") st.prep.periodFilter = value;
        draw({ keepScroll: true });
      });
    });
    $$("[data-prep-shot]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = el.getAttribute("data-prep-shot") || "";
        st.prep.selectedShotId = st.prep.selectedShotId === id ? "" : id;
        st.prep.showFilters = false;
        st.prep.showStats = false;
        draw({ keepScroll: true });
      });
    });
    $(".prep-pitch-svg")?.addEventListener("click", () => {
      let changed = false;
      if (st.prep.selectedShotId) {
        st.prep.selectedShotId = "";
        changed = true;
      }
      if (st.prep.showFilters || st.prep.showStats) {
        st.prep.showFilters = false;
        st.prep.showStats = false;
        changed = true;
      }
      if (changed) draw({ keepScroll: true });
    });
    $("#prep-shot-popup-close")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      st.prep.selectedShotId = "";
      draw({ keepScroll: true });
    });
    $("#prep-shot-popup")?.addEventListener("click", (e) => e.stopPropagation());
    $("#prep-gemini-run")?.addEventListener("click", () => runPrepGemini());
    $$("[data-prep-followup]").forEach((btn) => {
      btn.addEventListener("click", () => runPrepGemini(btn.getAttribute("data-prep-followup") || ""));
    });
    $("#prep-gemini-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      runPrepGemini($("#prep-gemini-input")?.value || "");
    });
    $("#prep-gemini-input")?.addEventListener("input", (e) => {
      st.prep.gemini.draft = e.target.value;
      const chips = $("#prep-followups");
      if (chips) chips.hidden = !!e.target.value.trim();
    });
    $("#prep-gemini-clear")?.addEventListener("click", () => {
      st.prep.gemini = emptyPrepGemini();
      draw({ keepScroll: true });
    });
    const prepTranscript = $("#prep-gemini-transcript");
    if (prepTranscript) prepTranscript.scrollTop = prepTranscript.scrollHeight;
    $("#prep-note-add")?.addEventListener("click", () => {
      st.prep.showNoteForm = !st.prep.showNoteForm;
      draw({ keepScroll: true });
      if (st.prep.showNoteForm) {
        $("#prep-note-form")?.scrollIntoView({ block: "center", behavior: "smooth" });
        $("#prep-note-body")?.focus();
      }
    });
    $("#prep-note-body")?.addEventListener("input", (e) => {
      st.prep.noteBody = e.target.value;
    });
    $("#prep-note-tags")?.addEventListener("input", (e) => {
      st.prep.noteTags = e.target.value;
    });
    $("#prep-note-author")?.addEventListener("input", (e) => {
      st.prep.noteAuthor = e.target.value;
      localStorage.setItem(LS_NOTE_AUTHOR, st.prep.noteAuthor);
    });
    $("#prep-note-game")?.addEventListener("change", (e) => {
      st.prep.noteGameId = e.target.value;
    });
    $$("[data-prep-tag]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tag = btn.getAttribute("data-prep-tag");
        const cur = st.prep.noteTags
          .split(/[,;]+/)
          .map((t) => t.trim())
          .filter(Boolean);
        if (!cur.includes(tag)) cur.push(tag);
        st.prep.noteTags = cur.join(", ");
        draw({ keepScroll: true });
      });
    });
    $("#prep-note-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const gameId = st.prep.lockedGameId || st.prep.noteGameId;
      const body = String(st.prep.noteBody || "").trim();
      if (!gameId || !body) {
        showToast("Add a note and pick a game");
        return;
      }
      try {
        await API.createNote({
          game_id: gameId,
          body,
          author_label: st.prep.noteAuthor,
          tags: st.prep.noteTags,
        });
        st.prep.noteBody = "";
        st.prep.noteTags = "";
        st.prep.showNoteForm = false;
        st.prep.loadKey = "";
        showToast("Note saved");
        await loadPrepData();
      } catch (err) {
        showToast(err.message || "Could not save note");
      }
    });
    $$("[data-del-note]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this note?")) return;
        const id = btn.getAttribute("data-del-note");
        const result = await API.deleteNote(id);
        if (!result.ok) {
          showToast(result.error || "Could not delete");
          return;
        }
        st.prep.loadKey = "";
        await loadPrepData();
      });
    });
  }

  function exploreCell(value) {
    if (value === null || value === undefined) return "—";
    if (typeof value === "object") return escapeHtml(JSON.stringify(value));
    return escapeHtml(String(value));
  }

  function exploreTableMarkup(columns, rows) {
    if (!columns?.length || !rows?.length) {
      return `<p class="muted">No matching rows.</p>`;
    }
    const head = columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
    const body = rows
      .slice(0, 100)
      .map(
        (row) =>
          `<tr>${columns.map((c) => `<td>${exploreCell(row[c])}</td>`).join("")}</tr>`
      )
      .join("");
    return `
      <div class="tracker-table-wrap explore-table-wrap">
        <table class="tracker-table">
          <thead><tr>${head}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
  }

  function explorePitchMarkup(rows) {
    const points = (rows || [])
      .map((r) => ({
        x: Number(r.x ?? r.assist_x),
        y: Number(r.y ?? r.assist_y),
        result: r.result || "",
        fromAssist: r.x == null && r.assist_x != null,
        label: r.jersey_number_at_time || r.jersey || r.short_name || r.name || "",
      }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (!points.length) {
      return `<p class="muted">No x/y locations in this result to plot.</p>`;
    }
    const line = "#f2f6f3";
    const markers = points
      .map((p) => {
        const fill = resultFill(p.result || "missed");
        const square = p.fromAssist || isSquareEvent(p.result);
        let html = square
          ? svgSquare(p.x, p.y, 2.8, `fill="${fill}" stroke="#0b1f33" stroke-width="0.25"`)
          : `<circle cx="${p.x}" cy="${p.y}" r="1.5" fill="${fill}" stroke="#0b1f33" stroke-width="0.25" />`;
        if (p.label) {
          html += `<text x="${p.x}" y="${p.y}" fill="#0b1f33" font-size="1.1" font-weight="700" text-anchor="middle" dominant-baseline="central">${escapeHtml(String(p.label))}</text>`;
        }
        return html;
      })
      .join("");
    return `
      <div class="explore-pitch-wrap">
        <svg class="explore-pitch-svg" viewBox="-2 -2 ${PW + 4} ${FIELD_Y_MAX + 4}" role="img" aria-label="Shot locations">
          <rect x="0" y="0" width="${PW}" height="${FIELD_Y_MAX}" fill="#2d7a4a" />
          <rect x="0" y="0" width="${PW}" height="${FIELD_Y_MAX}" fill="none" stroke="${line}" stroke-width="0.4" />
          <rect x="${PEN_SIDE}" y="0" width="${PEN_W}" height="16.5" fill="none" stroke="${line}" stroke-width="0.3" />
          <rect x="${(PW - SIX_W) / 2}" y="0" width="${SIX_W}" height="5.5" fill="none" stroke="${line}" stroke-width="0.3" />
          <line x1="0" y1="${HALF_L}" x2="${PW}" y2="${HALF_L}" stroke="${line}" stroke-width="0.3" stroke-dasharray="1 0.6" />
          <text x="${PW / 2}" y="-0.6" fill="${line}" font-size="2" text-anchor="middle">Attacking goal</text>
          ${markers}
        </svg>
        <p class="muted explore-pitch-caption">Attacking half · ${points.length} point${points.length === 1 ? "" : "s"}</p>
      </div>`;
  }

  function exploreResultMarkup(result) {
    if (!result) return "";
    const cols = result.columns || [];
    const rows = result.rows || [];
    const viz = result.viz || "table";
    let body = "";
    if (viz === "pitch") {
      body = explorePitchMarkup(rows) + exploreTableMarkup(cols, rows);
    } else if (viz === "none" && !rows.length) {
      body = "";
    } else {
      body = exploreTableMarkup(cols, rows);
    }
    return `
      <div class="explore-result">
        ${result.answer ? `<p class="explore-answer">${escapeHtml(result.answer)}</p>` : ""}
        ${body}
        ${
          result.sql
            ? `<details class="explore-sql"><summary>SQL used</summary><pre>${escapeHtml(result.sql)}</pre></details>`
            : ""
        }
      </div>`;
  }

  async function runExplore(question) {
    const q = String(question || "").trim();
    if (!q || st.explore.loading) return;
    const ex = st.explore;
    ex.error = "";
    ex.loading = true;
    ex.draft = "";
    ex.messages.push({ role: "user", content: q });
    draw();

    const history = ex.messages
      .slice(0, -1)
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content }));

    const result = await API.explore(q, history);
    ex.loading = false;
    if (!result.ok) {
      ex.error = result.error || "Explore failed";
      if (result.data) ex.lastResult = result.data;
      ex.messages.push({
        role: "assistant",
        content: ex.error,
        result: result.data || null,
      });
      draw();
      return;
    }
    ex.lastResult = result.data;
    ex.messages.push({
      role: "assistant",
      content: result.data?.answer || "Done.",
      result: result.data,
    });
    draw();
  }

  function renderExplore() {
    const ex = st.explore;
    const transcript = ex.messages
      .map((m) => {
        if (m.role === "user") {
          return `<div class="explore-msg is-user"><p>${escapeHtml(m.content)}</p></div>`;
        }
        return `<div class="explore-msg is-assistant">${
          m.result ? exploreResultMarkup(m.result) : `<p>${escapeHtml(m.content)}</p>`
        }</div>`;
      })
      .join("");

    root().innerHTML = `
      <div class="shots-admin shots-explore">
        ${trackerNav()}
        <h1>Prep</h1>
        ${prepTabsMarkup("explore")}
        <p class="muted">Ask questions about games, shots, assists, and opponents. Answers use live Supabase data via OpenAI.</p>
        ${st.error ? `<p class="shots-error">${escapeHtml(st.error)}</p>` : ""}
        ${ex.error ? `<p class="shots-error">${escapeHtml(ex.error)}</p>` : ""}
        <div class="explore-starters" role="group" aria-label="Suggested questions">
          ${EXPLORE_STARTERS.map(
            (q) =>
              `<button type="button" class="explore-starter" data-explore-starter>${escapeHtml(q)}</button>`
          ).join("")}
        </div>
        <div class="explore-transcript" id="explore-transcript">
          ${
            transcript ||
            `<p class="muted">Try a starter above, or type your own question.</p>`
          }
          ${ex.loading ? `<p class="explore-loading">Working…</p>` : ""}
        </div>
        <form id="explore-form" class="explore-form">
          <label class="sr-only" for="explore-input">Question</label>
          <textarea id="explore-input" class="explore-input" rows="2" maxlength="2000" placeholder="e.g. Which Brighton players assisted the most goals?" ${ex.loading ? "disabled" : ""}>${escapeHtml(ex.draft)}</textarea>
          <div class="explore-form-actions">
            <button type="submit" class="btn btn-primary" ${ex.loading ? "disabled" : ""}>Ask</button>
            <button type="button" class="btn btn-ghost" id="explore-clear" ${ex.loading || !ex.messages.length ? "disabled" : ""}>Clear</button>
          </div>
        </form>
      </div>`;

    $$("[data-explore-starter]").forEach((btn) => {
      btn.addEventListener("click", () => runExplore(btn.textContent));
    });
    $("#explore-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = $("#explore-input");
      runExplore(input?.value || "");
    });
    $("#explore-input")?.addEventListener("input", (e) => {
      ex.draft = e.target.value;
    });
    $("#explore-clear")?.addEventListener("click", () => {
      ex.messages = [];
      ex.lastResult = null;
      ex.error = "";
      ex.draft = "";
      draw();
    });
    const transcriptEl = $("#explore-transcript");
    if (transcriptEl) transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }

  function matchElapsedSeconds(ev) {
    if (ev.gameClockSeconds == null || ev.gameClockSeconds === "") return null;
    const elapsed = Number(ev.gameClockSeconds);
    if (!Number.isFinite(elapsed)) return null;
    const p = eventPeriod(ev);
    let off = 0;
    if (p === "2") off = periodLengthSec("1", ev.game);
    else if (p === "ET1") off = periodLengthSec("1", ev.game) + periodLengthSec("2", ev.game);
    else if (p === "ET2") {
      off = periodLengthSec("1", ev.game) + periodLengthSec("2", ev.game) + periodLengthSec("ET1", ev.game);
    }
    return off + elapsed;
  }

  function goalMinuteLabel(ev) {
    const total = matchElapsedSeconds(ev);
    if (total == null) return "";
    return `${Math.max(1, Math.floor(total / 60))}'`;
  }

  function scorerShortName(ev) {
    const team = eventTeam(ev);
    const short = ev.shooterShort;
    const nick = firstName(ev.shooterName);
    const num = ev.shooterNumber;
    const hasNum = num !== undefined && num !== null && String(num) !== "";
    if (team === "opp") {
      if (short || nick) return short || nick;
      return hasNum ? `#${num}` : "Opp";
    }
    return short || nick || (hasNum ? `#${num}` : ourTeamName());
  }

  function teamBoxLine(events) {
    const goals = events.filter((e) => isGoalResult(e.result));
    const shots = events.filter((e) => SHOT_RESULTS.has(e.result));
    const onFrame = events.filter((e) => e.result === "goal" || e.result === "on-target" || e.result === "pk-goal");
    const corners = events.filter((e) => e.result === "corner").length;
    const fouls = events.filter((e) => e.result === "foul").length;
    return {
      goals: goals.length,
      shots: shots.length,
      onFrame: onFrame.length,
      corners,
      fouls,
      scorers: goals.slice().sort((a, b) => {
        const ae = matchElapsedSeconds(a);
        const be = matchElapsedSeconds(b);
        if (ae != null && be != null && ae !== be) return ae - be;
        if (ae != null && be == null) return -1;
        if (ae == null && be != null) return 1;
        return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
      }),
    };
  }

  function scorerPhrase(goals) {
    if (!goals.length) return "";
    return goals
      .map((ev) => {
        const who = scorerShortName(ev);
        const min = goalMinuteLabel(ev);
        const pk = ev.result === "pk-goal" ? " PK" : "";
        return min ? `${who} ${min}${pk}` : `${who}${pk}`;
      })
      .join(", ");
  }

  function scoreboardFieldLabel(name) {
    const raw = String(name || "").trim().toUpperCase();
    if (raw.length <= 18) return raw;
    return `${raw.slice(0, 17)}…`;
  }

  function scoreboardBoxMarkup() {
    const events = st.shots || [];
    const usName = ourTeamName();
    const oppName = opponentOf(st.game)?.name || "Opponent";
    const us = teamBoxLine(events.filter((e) => eventTeam(e) === "us"));
    const opp = teamBoxLine(events.filter((e) => eventTeam(e) === "opp"));
    const usPhrase = scorerPhrase(us.scorers);
    const oppPhrase = scorerPhrase(opp.scorers);
    const recap =
      us.goals || opp.goals
        ? `${escapeHtml(usName)} ${us.goals}${usPhrase ? ` (${escapeHtml(usPhrase)})` : ""} : ${escapeHtml(oppName)} ${opp.goals}${
            oppPhrase ? ` (${escapeHtml(oppPhrase)})` : ""
          }`
        : "No goals yet.";
    return `
      <section class="scoreboard-box">
        <div class="scoreboard-table-wrap">
          <table class="scoreboard-stat-table">
            <thead>
              <tr>
                <th></th>
                <th>Goals</th>
                <th>Shots (On Frame)</th>
                <th>Corners</th>
                <th>Fouls</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">${escapeHtml(usName)}</th>
                <td>${us.goals}</td>
                <td>${us.shots} (${us.onFrame})</td>
                <td>${us.corners}</td>
                <td>${us.fouls}</td>
              </tr>
              <tr>
                <th scope="row">${escapeHtml(oppName)}</th>
                <td>${opp.goals}</td>
                <td>${opp.shots} (${opp.onFrame})</td>
                <td>${opp.corners}</td>
                <td>${opp.fouls}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="scoreboard-recap">${recap}</p>
        <div class="scoreboard-field-wrap">
          ${scoreboardFieldMarkup(events)}
        </div>
        <p class="scoreboard-refresh-foot">
          <button type="button" class="scoreboard-refresh-link" data-scoreboard-poll-cycle>Refresh Time: ${pollIntervalSec()}s</button>
        </p>
      </section>`;
  }

  function scoreboardFieldPoint(loc, team, usAttacksTop) {
    if (!loc || loc.x == null || loc.y == null) return null;
    const x = Number(loc.x);
    const y = Number(loc.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const attacksTop = team === "opp" ? !usAttacksTop : usAttacksTop;
    if (attacksTop) return { fx: x, fy: y };
    return { fx: PW - x, fy: PL - y };
  }

  function scoreboardTrianglePoints(cx, cy, size, up) {
    if (up) {
      return `${cx},${cy - size} ${cx - size * 0.92},${cy + size * 0.62} ${cx + size * 0.92},${cy + size * 0.62}`;
    }
    return `${cx},${cy + size} ${cx - size * 0.92},${cy - size * 0.62} ${cx + size * 0.92},${cy - size * 0.62}`;
  }

  function scoreboardFieldMarkup(events) {
    const line = "rgba(242, 246, 243, 0.88)";
    const goalW = 7.32;
    const goalX = (PW - goalW) / 2;
    const penW = 40.32;
    const penH = 16.5;
    const sixW = 18.32;
    const sixH = 5.5;
    const penX = (PW - penW) / 2;
    const sixX = (PW - sixW) / 2;
    const arcR = 9.15;
    const spotInset = 11;
    const dx = Math.sqrt(arcR * arcR - (penH - spotInset) * (penH - spotInset));
    const band = PL / 6;
    const period = normalizePeriod(st.period);
    const usAttacksTop = usAttacksFarEnd(period);
    const stripes = [];
    for (let i = 0; i < 6; i += 1) {
      const usHalf = usAttacksTop ? i < 3 : i >= 3;
      const fill = usHalf ? (i % 2 ? "#24633c" : "#2d7a4a") : i % 2 ? "#4b5563" : "#6b7280";
      stripes.push(`<rect fill="${fill}" x="0" y="${i * band}" width="${PW}" height="${band}" />`);
    }
    const shots = (events || []).filter(
      (ev) => SHOT_RESULTS.has(ev.result) && ev.shot && eventPeriod(ev) === period
    );
    const regular = [];
    const goals = [];
    shots.forEach((ev) => {
      const pt = scoreboardFieldPoint(ev.shot, eventTeam(ev), usAttacksTop);
      if (!pt) return;
      if (isGoalResult(ev.result)) goals.push({ ev, pt });
      else regular.push({ ev, pt });
    });
    const markers = [];
    regular.forEach(({ ev, pt }) => {
      const up = eventTeam(ev) === "us" ? usAttacksTop : !usAttacksTop;
      markers.push(
        `<polygon points="${scoreboardTrianglePoints(pt.fx, pt.fy, 1.45, up)}" fill="rgba(244,247,251,0.28)" />`
      );
    });
    goals.forEach(({ ev, pt }) => {
      const us = eventTeam(ev) === "us";
      const up = us ? usAttacksTop : !usAttacksTop;
      const fill = us ? "#f15a24" : "#f4f7fb";
      markers.push(
        `<polygon points="${scoreboardTrianglePoints(pt.fx, pt.fy, 3.35, up)}" fill="${fill}" stroke="#0b1f33" stroke-width="0.28" stroke-linejoin="round" />`
      );
      const num = ev.shooterNumber;
      if (num !== undefined && num !== null && String(num) !== "") {
        markers.push(
          `<text x="${pt.fx}" y="${pt.fy + (up ? 0.35 : -0.15)}" fill="#0b1f33" font-size="2.05" font-weight="800" text-anchor="middle" dominant-baseline="central">${escapeHtml(String(num))}</text>`
        );
      }
    });
    const usName = scoreboardFieldLabel(ourTeamName());
    const oppName = scoreboardFieldLabel(opponentOf(st.game)?.name || "Opponent");
    const topName = usAttacksTop ? usName : oppName;
    const botName = usAttacksTop ? oppName : usName;
    const attackDir = usAttacksTop ? "top" : "bottom";
    return `
      <svg class="scoreboard-field-svg" viewBox="-4 -5.4 76 116.2" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Shot map for ${escapeHtml(periodLabel(period))}. ${escapeHtml(ourTeamName())} attacks toward the ${attackDir}.">
        ${stripes.join("")}
        <rect x="0" y="0" width="${PW}" height="${PL}" fill="none" stroke="${line}" stroke-width="0.45" />
        <line x1="0" y1="${HALF_L}" x2="${PW}" y2="${HALF_L}" stroke="${line}" stroke-width="0.4" />
        <circle cx="${PW / 2}" cy="${HALF_L}" r="9.15" fill="none" stroke="${line}" stroke-width="0.35" />
        <circle cx="${PW / 2}" cy="${HALF_L}" r="0.45" fill="${line}" />
        <rect x="${goalX}" y="-1.4" width="${goalW}" height="1.4" fill="none" stroke="${line}" stroke-width="0.45" />
        <rect x="${goalX}" y="${PL}" width="${goalW}" height="1.4" fill="none" stroke="${line}" stroke-width="0.45" />
        <rect x="${penX}" y="0" width="${penW}" height="${penH}" fill="none" stroke="${line}" stroke-width="0.35" />
        <rect x="${penX}" y="${PL - penH}" width="${penW}" height="${penH}" fill="none" stroke="${line}" stroke-width="0.35" />
        <rect x="${sixX}" y="0" width="${sixW}" height="${sixH}" fill="none" stroke="${line}" stroke-width="0.35" />
        <rect x="${sixX}" y="${PL - sixH}" width="${sixW}" height="${sixH}" fill="none" stroke="${line}" stroke-width="0.35" />
        <circle cx="${PW / 2}" cy="${spotInset}" r="0.45" fill="${line}" />
        <circle cx="${PW / 2}" cy="${PL - spotInset}" r="0.45" fill="${line}" />
        <path d="M ${PW / 2 - dx} ${penH} A ${arcR} ${arcR} 0 0 0 ${PW / 2 + dx} ${penH}" fill="none" stroke="${line}" stroke-width="0.35" />
        <path d="M ${PW / 2 - dx} ${PL - penH} A ${arcR} ${arcR} 0 0 1 ${PW / 2 + dx} ${PL - penH}" fill="none" stroke="${line}" stroke-width="0.35" />
        <text x="${PW / 2}" y="-2.05" fill="rgba(244,247,251,0.78)" font-size="2.35" font-weight="750" text-anchor="middle">${escapeHtml(topName)}</text>
        <text x="${PW / 2}" y="${PL + 3.55}" fill="rgba(244,247,251,0.78)" font-size="2.35" font-weight="750" text-anchor="middle">${escapeHtml(botName)}</text>
        ${markers.join("")}
      </svg>`;
  }

  let scoreboardPoll = { deadline: 0, tickId: null, inFlight: false, visBound: false };

  function pollIntervalSec() {
    const n = Number(localStorage.getItem(LS_SCOREBOARD_POLL));
    return SCOREBOARD_POLL_OPTS.includes(n) ? n : 60;
  }

  function stopScoreboardPollTick() {
    if (!scoreboardPoll.tickId) return;
    clearInterval(scoreboardPoll.tickId);
    scoreboardPoll.tickId = null;
  }

  function paintPollLine() {
    const line = $("[data-scoreboard-poll-line]");
    const fill = line?.querySelector(".scoreboard-poll-line-fill");
    const clock = $("[data-scoreboard-sync]");
    if (!fill) return;
    const total = pollIntervalSec();
    const left = Math.max(0, (scoreboardPoll.deadline - Date.now()) / 1000);
    const remain = total ? Math.max(0, Math.min(1, left / total)) : 0;
    fill.style.width = `${remain * 100}%`;
    fill.style.transform = "none";
    line.classList.toggle("is-syncing", scoreboardPoll.inFlight);
    if (clock) {
      const secs = Math.max(0, Math.ceil(left));
      clock.setAttribute(
        "aria-label",
        scoreboardPoll.inFlight ? "Refreshing scoreboard" : `Refresh now. Next refresh in ${secs} seconds`
      );
    }
  }

  function armScoreboardPoll(resetDeadline) {
    if (resetDeadline || !scoreboardPoll.deadline) {
      scoreboardPoll.deadline = Date.now() + pollIntervalSec() * 1000;
    }
    if (!scoreboardPoll.tickId) {
      scoreboardPoll.tickId = setInterval(() => {
        if (st.view !== "shots-scoreboard") {
          stopScoreboardPollTick();
          return;
        }
        paintPollLine();
        if (document.hidden || scoreboardPoll.inFlight) return;
        if (Date.now() >= scoreboardPoll.deadline) refreshScoreboardLive();
      }, 250);
    }
    paintPollLine();
  }

  async function refreshScoreboardLive() {
    if (st.view !== "shots-scoreboard" || !st.gameId || scoreboardPoll.inFlight) return;
    scoreboardPoll.inFlight = true;
    paintPollLine();
    try {
      const pendingKeep = (st.shots || []).filter((s) => s.saveFailed && s.pendingPayload);
      const [game, rows] = await Promise.all([API.game(st.gameId), API.shotsForGame(st.gameId)]);
      if (st.view !== "shots-scoreboard" || !game || game.id !== st.gameId) return;
      st.game = game;
      st.shots = (rows || []).map(mapShot);
      const remoteIds = new Set(st.shots.map((s) => s.id));
      const orphans = pendingKeep.filter((s) => !remoteIds.has(s.id));
      if (orphans.length) st.shots = [...orphans, ...st.shots];
      applyRemoteClock(game);
      scoreboardPoll.deadline = Date.now() + pollIntervalSec() * 1000;
      draw({ keepScroll: true });
    } catch {
      scoreboardPoll.deadline = Date.now() + pollIntervalSec() * 1000;
    } finally {
      scoreboardPoll.inFlight = false;
      paintPollLine();
    }
  }

  function cycleScoreboardPoll() {
    const cur = pollIntervalSec();
    const next = SCOREBOARD_POLL_OPTS[(SCOREBOARD_POLL_OPTS.indexOf(cur) + 1) % SCOREBOARD_POLL_OPTS.length];
    localStorage.setItem(LS_SCOREBOARD_POLL, String(next));
    scoreboardPoll.deadline = Date.now() + next * 1000;
    const link = $("[data-scoreboard-poll-cycle]");
    if (link) link.textContent = `Refresh Time: ${next}s`;
    paintPollLine();
  }

  function renderScoreboard() {
    document.body.classList.remove("is-recording-play");
    if (st.view === "shots-scoreboard") applyRemoteClock(st.game);
    root().innerHTML = `
      <div class="scoreboard-page">
        <div class="scoreboard-menu">
          <button type="button" class="scoreboard-menu-btn" data-scoreboard-menu aria-label="Scoreboard menu" aria-expanded="false" aria-haspopup="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="12" cy="5" r="1.85"/>
              <circle cx="12" cy="12" r="1.85"/>
              <circle cx="12" cy="19" r="1.85"/>
            </svg>
          </button>
          <div class="scoreboard-menu-pop" id="scoreboard-menu-pop" hidden role="menu">
            <a class="scoreboard-menu-item" href="#shots" role="menuitem">Track shots</a>
          </div>
        </div>
        <div class="scoreboard-hero-pin" data-scoreboard-hero-pin>
          <div class="scoreboard-hero" data-scoreboard-hero>
            ${scoreboardBoardMarkup("large")}
          </div>
        </div>
        <div class="scoreboard-hero-spacer" data-scoreboard-hero-spacer aria-hidden="true"></div>
        ${scoreboardBoxMarkup()}
      </div>`;
    bindClockUi();
    bindScoreboardChrome();
  }

  function bindScoreboardChrome() {
    const btn = $("[data-scoreboard-menu]");
    const pop = $("#scoreboard-menu-pop");
    const setOpen = (open) => {
      if (!btn || !pop) return;
      pop.hidden = !open;
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    };
    btn?.addEventListener("click", (e) => {
      e.stopPropagation();
      setOpen(pop.hidden);
    });
    $(".scoreboard-page")?.addEventListener("click", (e) => {
      if (e.target.closest(".scoreboard-menu")) return;
      setOpen(false);
    });
    $("[data-scoreboard-sync]")?.addEventListener("click", (e) => {
      e.stopPropagation();
      refreshScoreboardLive();
    });
    $("[data-scoreboard-poll-cycle]")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      cycleScoreboardPoll();
    });
    if (!scoreboardPoll.visBound) {
      scoreboardPoll.visBound = true;
      document.addEventListener("visibilitychange", () => {
        if (document.hidden || st.view !== "shots-scoreboard") return;
        refreshScoreboardLive();
      });
    }
    armScoreboardPoll(false);
    bindScoreboardPinch();
  }

  let scoreboardPinch = { bound: false, ticking: false, maxH: 0, minH: 76, minScale: 0.34, boardH: 0, range: 1 };

  function measureScoreboardPinch() {
    const pin = $("[data-scoreboard-hero-pin]");
    const board = pin?.querySelector(".scoreboard-board");
    if (!pin || !board) return;
    board.style.transform = "none";
    pin.style.height = "";
    const maxH = window.innerHeight;
    const boardH = board.offsetHeight || Math.round(maxH * 0.4);
    const num = board.querySelector(".score-num");
    const largePx = num ? parseFloat(getComputedStyle(num).fontSize) : 64;
    const minScale = Math.max(0.26, Math.min(0.5, 29.6 / Math.max(largePx, 1)));
    const minH = Math.max(72, Math.round(boardH * minScale + 20));
    scoreboardPinch.maxH = maxH;
    scoreboardPinch.minH = minH;
    scoreboardPinch.minScale = minScale;
    scoreboardPinch.boardH = boardH;
    scoreboardPinch.range = Math.max(1, maxH - minH);
  }

  function applyScoreboardPinch() {
    const pin = $("[data-scoreboard-hero-pin]");
    const board = pin?.querySelector(".scoreboard-board");
    if (!pin || !board || st.view !== "shots-scoreboard") return;
    if (!scoreboardPinch.maxH) measureScoreboardPinch();
    const { maxH, minH, minScale, boardH, range } = scoreboardPinch;
    const p = Math.min(1, Math.max(0, window.scrollY / range));
    const s = 1 - p * (1 - minScale);
    const h = maxH - p * (maxH - minH);
    const yCenter = Math.max(8, (h - boardH * s) / 2);
    const ty = yCenter * (1 - p) + 10 * p;
    pin.style.height = `${h}px`;
    board.style.transform = `translate3d(0, ${ty}px, 0) scale(${s})`;
    if (p > 0.9) pin.classList.add("is-compact");
    else if (p < 0.8) pin.classList.remove("is-compact");
  }

  function bindScoreboardPinch() {
    measureScoreboardPinch();
    applyScoreboardPinch();
    if (scoreboardPinch.bound) return;
    scoreboardPinch.bound = true;
    window.addEventListener(
      "scroll",
      () => {
        if (st.view !== "shots-scoreboard") return;
        if (scoreboardPinch.ticking) return;
        scoreboardPinch.ticking = true;
        requestAnimationFrame(() => {
          scoreboardPinch.ticking = false;
          applyScoreboardPinch();
        });
      },
      { passive: true }
    );
    window.addEventListener("resize", () => {
      if (st.view !== "shots-scoreboard") return;
      measureScoreboardPinch();
      applyScoreboardPinch();
    });
  }

  function draw(opts = {}) {
    const el = root();
    if (!el) return;
    const scrollY = window.scrollY;
    document.body.classList.remove("is-recording-play");
    if (!API || !API.isConfigured()) {
      renderSetup();
      return;
    }
    if (!st.booted) {
      renderLoading("Connecting…");
      return;
    }
    if (!st.session) {
      renderPin();
      return;
    }
    if (st.loading) {
      stopScoreboardPollTick();
      renderLoading("Loading…");
      return;
    }
    const view = st.view;
    if (view !== "shots" && view !== "shots-scoreboard") stopClockTick();
    if (view !== "shots-scoreboard") stopScoreboardPollTick();
    if (view === "shots-games") {
      renderGames();
      return;
    }
    if (view === "shots-history") {
      renderHistory();
      return;
    }
    if (view !== "shots-prep") closePrepConfig();
    if (view === "shots-prep") {
      renderPrep();
      if (opts.keepScroll) window.scrollTo(0, scrollY);
      return;
    }
    if (!st.gameId || !st.game) {
      renderGames();
      return;
    }
    if (view === "shots-map") {
      renderMap();
      return;
    }
    if (view === "shots-scoreboard") {
      renderScoreboard();
      if (opts.keepScroll) window.scrollTo(0, scrollY);
      applyScoreboardPinch();
      return;
    }
    renderRecorder(opts);
  }

  global.ShotTracker = {
    render(view) {
      st.view = view || "shots";
      if (!st.booted) {
        draw();
        boot();
        return;
      }
      draw();
    },
    onLeave() {
      closeShotModal();
      resetTrackerDraft();
      closeGameOpenModal();
      closeClockSetup();
      stopScoreboardPollTick();
      st.editingClockId = null;
      const edit = $("#shot-edit-modal");
      if (edit) edit.hidden = true;
    },
    onEscape() {
      if (shotModal && !shotModal.hidden) {
        dismissShotModal();
        return true;
      }
      if (lineupGesture) {
        cancelLineupGesture();
        draw({ keepScroll: true });
        return true;
      }
      const edit = $("#shot-edit-modal");
      if (edit && !edit.hidden) {
        edit.hidden = true;
        return true;
      }
      const openGame = $("#game-open-modal");
      if (openGame && !openGame.hidden) {
        closeGameOpenModal();
        return true;
      }
      const stripPop = $("#score-strip-menu-pop");
      if (stripPop && !stripPop.hidden) {
        stripPop.hidden = true;
        $("[data-score-strip-menu]")?.setAttribute("aria-expanded", "false");
        return true;
      }
      const menuPop = $("#scoreboard-menu-pop");
      if (menuPop && !menuPop.hidden) {
        menuPop.hidden = true;
        $("[data-scoreboard-menu]")?.setAttribute("aria-expanded", "false");
        return true;
      }
      const clockSetup = $("#clock-setup-modal");
      if (clockSetup && !clockSetup.hidden) {
        closeClockSetup();
        return true;
      }
      if (st.editingClockId) {
        st.editingClockId = null;
        draw({ keepScroll: true });
        return true;
      }
      return false;
    },
  };
})(window);
