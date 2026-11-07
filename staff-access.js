/**
 * Staff PIN helpers — shared gate for Shot Tracker / Club.
 *
 * Default PIN is SHOTS_CONFIG.pin (e.g. KEPPA). Optional per-team overrides:
 *   teamPins: { "CFC G10 BD": "OTHER", "<uuid>": "OTHER" }
 *
 * Unlock is tracked in sessionStorage separately from the anonymous Supabase
 * session so a coach can pick a team on the gate and unlock only that team.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StaffAccess = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function () {
  "use strict";

  const UNLOCK_KEY = "shots-staff-unlock";

  function normalizePin(value) {
    return String(value || "")
      .trim()
      .toUpperCase();
  }

  function teamPinsMap(cfg) {
    const raw = cfg && cfg.teamPins;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  }

  function defaultPin(cfg) {
    return normalizePin((cfg && cfg.pin) || "KEPPA");
  }

  /**
   * Resolve the staff PIN for an owned team.
   * Lookup order: teamPins[id] → teamPins[name] → config.pin → KEPPA.
   */
  function pinForTeam(cfg, team) {
    const pins = teamPinsMap(cfg);
    if (team && team.id != null && pins[team.id] != null && String(pins[team.id]).trim() !== "") {
      return normalizePin(pins[team.id]);
    }
    if (team && team.name != null && pins[team.name] != null && String(pins[team.name]).trim() !== "") {
      return normalizePin(pins[team.name]);
    }
    return defaultPin(cfg);
  }

  function pinMatches(cfg, team, entered) {
    return normalizePin(entered) === pinForTeam(cfg, team);
  }

  function readUnlock(storage) {
    const store = storage || (typeof sessionStorage !== "undefined" ? sessionStorage : null);
    if (!store) return null;
    try {
      const raw = store.getItem(UNLOCK_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      const teamId = parsed.teamId != null ? String(parsed.teamId) : "";
      const teamName = parsed.teamName != null ? String(parsed.teamName) : "";
      if (!teamId && !teamName) return null;
      return { teamId, teamName };
    } catch (_) {
      return null;
    }
  }

  function writeUnlock(team, storage) {
    const store = storage || (typeof sessionStorage !== "undefined" ? sessionStorage : null);
    if (!store || !team) return;
    try {
      store.setItem(
        UNLOCK_KEY,
        JSON.stringify({
          teamId: team.id != null ? String(team.id) : "",
          teamName: team.name != null ? String(team.name) : "",
        })
      );
    } catch (_) {
      /* ignore quota / private mode */
    }
  }

  function clearUnlock(storage) {
    const store = storage || (typeof sessionStorage !== "undefined" ? sessionStorage : null);
    if (!store) return;
    try {
      store.removeItem(UNLOCK_KEY);
    } catch (_) {
      /* ignore */
    }
  }

  function unlockCoversTeam(unlock, team) {
    if (!unlock || !team) return false;
    if (team.id && unlock.teamId && String(team.id) === String(unlock.teamId)) return true;
    if (team.name && unlock.teamName && String(team.name) === String(unlock.teamName)) return true;
    return false;
  }

  return {
    UNLOCK_KEY,
    normalizePin,
    defaultPin,
    pinForTeam,
    pinMatches,
    readUnlock,
    writeUnlock,
    clearUnlock,
    unlockCoversTeam,
  };
});
