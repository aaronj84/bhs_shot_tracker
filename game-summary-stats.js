/**
 * Pure game-summary aggregates from Shot Tracker events.
 * Only stats derivable from recorded plays: shots (+ quality/location), corners, free kicks.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.GameSummaryStats = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function () {
  "use strict";

  const SHOT_RESULTS = new Set([
    "goal",
    "on-target",
    "blocked",
    "missed",
    "weak-gk",
    "pk-goal",
    "pk-missed",
  ]);

  const IN_BOX_RANGES = new Set(["0-9", "9-18"]);

  function isWeakToGk(ev) {
    if (!ev) return false;
    return (
      ev.result === "weak-gk" ||
      (ev.result === "missed" && (ev.missDirection || ev.miss_direction) === "weak-gk")
    );
  }

  function pkOutcomeOf(ev) {
    return ev?.pkOutcome || ev?.pk_outcome || "";
  }

  function isPkOnTarget(ev) {
    return ev?.result === "pk-missed" && pkOutcomeOf(ev) === "on-target";
  }

  function isPkMissedOffTarget(ev) {
    if (ev?.result !== "pk-missed") return false;
    const outcome = pkOutcomeOf(ev);
    return !outcome || outcome === "missed";
  }

  function isOnFrame(ev) {
    if (!ev) return false;
    if (isWeakToGk(ev) || isPkOnTarget(ev)) return true;
    return ev.result === "goal" || ev.result === "on-target" || ev.result === "pk-goal";
  }

  function isShot(ev) {
    return SHOT_RESULTS.has(ev?.result) || isWeakToGk(ev);
  }

  function teamOf(ev) {
    return ev && ev.team === "opp" ? "opp" : "us";
  }

  function emptySide() {
    return {
      goals: 0,
      shots: 0,
      onTarget: 0,
      onFrame: 0,
      blocked: 0,
      missed: 0,
      weakGk: 0,
      corners: 0,
      freeKicks: 0,
      pks: 0,
      pkGoals: 0,
      assists: 0,
      inBox: 0,
      outsideBox: 0,
      byLane: {},
      byRange: {},
    };
  }

  function bumpLocation(side, ev) {
    const shot = ev.shot || ev;
    const lane = shot.lane || shot.laneId || "";
    const range = shot.range || shot.rangeId || "";
    if (lane) side.byLane[lane] = (side.byLane[lane] || 0) + 1;
    if (range) {
      side.byRange[range] = (side.byRange[range] || 0) + 1;
      if (IN_BOX_RANGES.has(range)) side.inBox += 1;
      else side.outsideBox += 1;
    }
  }

  function accumulate(side, ev) {
    const result = ev.result;
    if (result === "foul") {
      side.freeKicks += 1;
      return;
    }
    if (result === "corner") {
      side.corners += 1;
      return;
    }
    if (!isShot(ev)) return;

    side.shots += 1;
    if (result === "goal" || result === "pk-goal") side.goals += 1;
    if (result === "on-target" || isPkOnTarget(ev)) side.onTarget += 1;
    if (isOnFrame(ev)) side.onFrame += 1;
    if (result === "blocked") side.blocked += 1;
    if ((result === "missed" && !isWeakToGk(ev)) || isPkMissedOffTarget(ev)) side.missed += 1;
    if (isWeakToGk(ev)) side.weakGk += 1;
    if (result === "pk-goal" || result === "pk-missed") {
      side.pks += 1;
      if (result === "pk-goal") side.pkGoals += 1;
    }
    if (ev.assist) side.assists += 1;
    bumpLocation(side, ev);
  }

  /**
   * @param {Array<object>} events
   * @param {{ laneOf?: (ev) => string|null, rangeOf?: (ev) => string|null }} [opts]
   */
  function buildGameSummaryStats(events, opts = {}) {
    const us = emptySide();
    const opp = emptySide();
    const players = {};

    (events || []).forEach((ev) => {
      const team = teamOf(ev);
      const side = team === "opp" ? opp : us;
      const enriched = { ...ev };
      if (opts.laneOf || opts.rangeOf) {
        const shot = { ...(ev.shot || {}) };
        if (opts.laneOf) {
          const lane = opts.laneOf(ev);
          if (lane) {
            shot.lane = lane.id || lane;
            shot.laneId = shot.lane;
          }
        }
        if (opts.rangeOf) {
          const range = opts.rangeOf(ev);
          if (range) {
            shot.range = range.id || range;
            shot.rangeId = shot.range;
          }
        }
        enriched.shot = shot;
      }
      accumulate(side, enriched);

      if (!isShot(enriched)) return;
      const label =
        enriched.playerLabel ||
        enriched.shooterName ||
        enriched.shooterShort ||
        (enriched.shooterNumber != null ? `#${enriched.shooterNumber}` : "Unknown");
      const key = `${team}:${label}`;
      if (!players[key]) {
        players[key] = {
          team,
          player: label,
          shots: 0,
          goals: 0,
          onFrame: 0,
          assists: 0,
        };
      }
      const row = players[key];
      row.shots += 1;
      if (enriched.result === "goal" || enriched.result === "pk-goal") row.goals += 1;
      if (isOnFrame(enriched)) row.onFrame += 1;
    });

    (events || []).forEach((ev) => {
      if (!ev?.assist) return;
      const team = teamOf(ev);
      const a = ev.assist;
      const label =
        a.playerLabel || a.name || a.short || (a.number != null ? `#${a.number}` : "Unknown");
      const key = `${team}:${label}`;
      if (!players[key]) {
        players[key] = { team, player: label, shots: 0, goals: 0, onFrame: 0, assists: 0 };
      }
      players[key].assists += 1;
    });

    const pct = (num, den) => (den > 0 ? Math.round((num / den) * 100) : null);

    const withRates = (side) => ({
      ...side,
      onTargetPct: pct(side.onTarget + side.goals, side.shots),
      onFramePct: pct(side.onFrame, side.shots),
      inBoxPct: pct(side.inBox, side.inBox + side.outsideBox),
    });

    return {
      us: withRates(us),
      opp: withRates(opp),
      players: Object.values(players)
        .sort((a, b) => b.shots + b.assists - (a.shots + a.assists) || b.goals - a.goals)
        .slice(0, 12),
      score: { us: us.goals, opp: opp.goals },
    };
  }

  /** Rows suitable for FOTMOB-style head-to-head bars. */
  function comparisonRows(stats) {
    if (!stats) return [];
    const us = stats.us;
    const opp = stats.opp;
    return [
      { key: "goals", label: "Goals", us: us.goals, opp: opp.goals },
      { key: "shots", label: "Total shots", us: us.shots, opp: opp.shots },
      { key: "onTarget", label: "Shots on target", us: us.onTarget + us.goals, opp: opp.onTarget + opp.goals },
      { key: "onFrame", label: "On frame", us: us.onFrame, opp: opp.onFrame },
      { key: "blocked", label: "Blocked", us: us.blocked, opp: opp.blocked },
      { key: "missed", label: "Missed", us: us.missed, opp: opp.missed },
      { key: "weakGk", label: "Weak to GK", us: us.weakGk, opp: opp.weakGk },
      { key: "inBox", label: "Shots in box", us: us.inBox, opp: opp.inBox },
      { key: "outsideBox", label: "Shots outside box", us: us.outsideBox, opp: opp.outsideBox },
      { key: "corners", label: "Corners", us: us.corners, opp: opp.corners },
      { key: "freeKicks", label: "Free kicks", us: us.freeKicks, opp: opp.freeKicks },
      { key: "pks", label: "Penalty kicks", us: us.pks, opp: opp.pks },
    ];
  }

  return {
    buildGameSummaryStats,
    comparisonRows,
    isShot,
    isOnFrame,
    isWeakToGk,
    IN_BOX_RANGES,
  };
});
