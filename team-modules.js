/**
 * Opt-in feature modules per owned team.
 *
 * Known keys:
 *   planning — Playoffs, Schedule (coach), Club visits
 *
 * Empty by default. Brighton is seeded with planning; other teams opt in via SQL:
 *   update teams set modules = modules || '["planning"]'::jsonb where id = '…' and is_ours;
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.TeamModules = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function (root) {
  "use strict";

  const PLANNING = "planning";
  const KNOWN = Object.freeze({ PLANNING });
  const STORAGE_KEY = "shots-team-modules";

  function normalize(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw) {
      const key = String(item || "")
        .trim()
        .toLowerCase();
      if (key && !out.includes(key)) out.push(key);
    }
    return out;
  }

  function looksLikeBrighton(team) {
    if (!team || !team.is_ours) return false;
    const name = String(team.name || "");
    const org = String(team.organization || "");
    const brand = String(team.brand_name || "");
    return name === "Brighton" || /brighton/i.test(org) || /^brighton/i.test(brand);
  }

  /**
   * Modules for a team row. Explicit `modules` arrays win (including []).
   * When the column is missing (pre-migration), Brighton-branded owned teams
   * still get planning so nav matches the intended default.
   */
  function fromTeam(team) {
    if (!team) return [];
    if (Array.isArray(team.modules)) return normalize(team.modules);
    return looksLikeBrighton(team) ? [PLANNING] : [];
  }

  function has(teamOrMods, key) {
    const mods = Array.isArray(teamOrMods) ? normalize(teamOrMods) : fromTeam(teamOrMods);
    return mods.includes(String(key || "").toLowerCase());
  }

  function readPublished() {
    if (Array.isArray(root.__SHOTS_ACTIVE_MODULES)) return normalize(root.__SHOTS_ACTIVE_MODULES);
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw != null) return normalize(JSON.parse(raw));
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  function syncNav(enabled) {
    if (typeof document === "undefined") return;
    document.body.classList.toggle("module-planning", !!enabled);
    document.querySelectorAll("[data-module='planning']").forEach((el) => {
      el.hidden = !enabled;
      el.setAttribute("aria-hidden", enabled ? "false" : "true");
    });
  }

  function publish(mods) {
    const list = normalize(mods);
    root.__SHOTS_ACTIVE_MODULES = list;
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch (_) {
      /* ignore */
    }
    syncNav(list.includes(PLANNING));
    return list;
  }

  /** @returns {boolean|null} true/false when known; null before any team has published modules */
  function planningEnabled() {
    const mods = readPublished();
    if (mods == null) return null;
    return mods.includes(PLANNING);
  }

  function isPlanningView(view) {
    return (
      view === "shots-bracket" ||
      view === "schedule-admin" ||
      view === "club-agenda" ||
      view === "club-itinerary" ||
      view === "club-data"
    );
  }

  function isPlanningHash(hash) {
    const raw = String(hash || "")
      .replace(/^#/, "")
      .split("?")[0];
    return (
      raw === "shots-bracket" ||
      raw === "schedule" ||
      raw === "schedule-admin" ||
      raw === "club" ||
      raw === "club-agenda" ||
      raw === "club-itinerary" ||
      raw === "club-data"
    );
  }

  /** Hide planning chrome until a team with the module is active. */
  function bootNav() {
    syncNav(planningEnabled() === true);
  }

  return {
    KNOWN,
    PLANNING,
    STORAGE_KEY,
    normalize,
    fromTeam,
    has,
    publish,
    readPublished,
    planningEnabled,
    isPlanningView,
    isPlanningHash,
    syncNav,
    bootNav,
  };
});
