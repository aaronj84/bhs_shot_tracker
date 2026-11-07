/**
 * Pure game-summary aggregates from Shot Tracker events.
 * Only stats derivable from recorded plays: shots (+ quality/location), corners, free kicks.
 * Shape mirrors FOTMOB Stats cards where the underlying data exists.
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
  const WOODWORK = new Set(["crossbar", "post"]);

  /** Collapse five pitch lanes into FOTMOB-style left / center / right. */
  const ZONE_LANES = {
    left: new Set(["LW", "LHS"]),
    center: new Set(["C"]),
    right: new Set(["RHS", "RW"]),
  };

  function isWeakToGk(ev) {
    if (!ev) return false;
    return (
      ev.result === "weak-gk" ||
      (ev.result === "missed" && (ev.missDirection || ev.miss_direction) === "weak-gk")
    );
  }

  function missDirOf(ev) {
    return ev?.missDirection || ev?.miss_direction || "";
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

  function isWoodwork(ev) {
    if (!ev) return false;
    if (WOODWORK.has(missDirOf(ev))) return true;
    return ev.result === "pk-missed" && WOODWORK.has(pkOutcomeOf(ev));
  }

  function isOnFrame(ev) {
    if (!ev) return false;
    if (isWeakToGk(ev) || isPkOnTarget(ev)) return true;
    return ev.result === "goal" || ev.result === "on-target" || ev.result === "pk-goal";
  }

  /** FOTMOB "shots on target" ≈ goals + on-target saves + weak-to-GK. */
  function isShotOnTarget(ev) {
    if (!ev) return false;
    if (isWeakToGk(ev) || isPkOnTarget(ev)) return true;
    return ev.result === "goal" || ev.result === "on-target" || ev.result === "pk-goal";
  }

  function isShotOffTarget(ev) {
    if (!ev || isWoodwork(ev) || isWeakToGk(ev)) return false;
    if (ev.result === "missed") return true;
    return isPkMissedOffTarget(ev) && !isWoodwork(ev);
  }

  function isShot(ev) {
    return SHOT_RESULTS.has(ev?.result) || isWeakToGk(ev);
  }

  function teamOf(ev) {
    return ev && ev.team === "opp" ? "opp" : "us";
  }

  function zoneOfLane(laneId) {
    if (!laneId) return "";
    if (ZONE_LANES.left.has(laneId)) return "left";
    if (ZONE_LANES.center.has(laneId)) return "center";
    if (ZONE_LANES.right.has(laneId)) return "right";
    return "";
  }

  function emptySide() {
    return {
      goals: 0,
      shots: 0,
      shotsOnTarget: 0,
      shotsOffTarget: 0,
      onFrame: 0,
      blocked: 0,
      woodwork: 0,
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
      byZone: { left: 0, center: 0, right: 0 },
    };
  }

  function bumpLocation(side, ev) {
    const shot = ev.shot || ev;
    const lane = shot.lane || shot.laneId || "";
    const range = shot.range || shot.rangeId || "";
    if (lane) {
      side.byLane[lane] = (side.byLane[lane] || 0) + 1;
      const zone = zoneOfLane(lane);
      if (zone) side.byZone[zone] = (side.byZone[zone] || 0) + 1;
    }
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
    if (isShotOnTarget(ev)) side.shotsOnTarget += 1;
    if (isShotOffTarget(ev)) side.shotsOffTarget += 1;
    if (isOnFrame(ev)) side.onFrame += 1;
    if (result === "blocked") side.blocked += 1;
    if (isWoodwork(ev)) side.woodwork += 1;
    if (isWeakToGk(ev)) side.weakGk += 1;
    if (result === "pk-goal" || result === "pk-missed") {
      side.pks += 1;
      if (result === "pk-goal") side.pkGoals += 1;
    }
    if (ev.assist) side.assists += 1;
    bumpLocation(side, ev);
  }

  function zonePercents(byZone) {
    const left = byZone.left || 0;
    const center = byZone.center || 0;
    const right = byZone.right || 0;
    const total = left + center + right;
    if (!total) return { left: 0, center: 0, right: 0, total: 0 };
    // Keep integers that sum to 100.
    const raw = [
      { key: "left", v: (left / total) * 100 },
      { key: "center", v: (center / total) * 100 },
      { key: "right", v: (right / total) * 100 },
    ];
    const rounded = raw.map((r) => ({ key: r.key, n: Math.floor(r.v), frac: r.v - Math.floor(r.v) }));
    let rem = 100 - rounded.reduce((s, r) => s + r.n, 0);
    rounded
      .slice()
      .sort((a, b) => b.frac - a.frac)
      .forEach((r) => {
        if (rem <= 0) return;
        r.n += 1;
        rem -= 1;
      });
    const out = { left: 0, center: 0, right: 0, total };
    rounded.forEach((r) => {
      out[r.key] = r.n;
    });
    return out;
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
      attackingZones: zonePercents(side.byZone),
      onTargetPct: pct(side.shotsOnTarget, side.shots),
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

  /**
   * FOTMOB "Top stats" — only metrics Shot Tracker can derive.
   * `preferLower` marks categories where the smaller number wins (none of ours today).
   */
  function topStatsRows(stats) {
    if (!stats) return [];
    const us = stats.us;
    const opp = stats.opp;
    return [
      { key: "goals", label: "Goals", us: us.goals, opp: opp.goals },
      { key: "shots", label: "Total shots", us: us.shots, opp: opp.shots },
      { key: "onTarget", label: "Shots on target", us: us.shotsOnTarget, opp: opp.shotsOnTarget },
      { key: "inBox", label: "Shots inside box", us: us.inBox, opp: opp.inBox },
      { key: "corners", label: "Corners", us: us.corners, opp: opp.corners },
      { key: "freeKicks", label: "Free kicks", us: us.freeKicks, opp: opp.freeKicks },
      { key: "pks", label: "Penalty kicks", us: us.pks, opp: opp.pks },
    ];
  }

  /** Nested FOTMOB Shots card rows. */
  function shotsCardRows(stats) {
    if (!stats) return null;
    const us = stats.us;
    const opp = stats.opp;
    return {
      total: { label: "Total shots", us: us.shots, opp: opp.shots },
      offTarget: { label: "Shots off target", us: us.shotsOffTarget, opp: opp.shotsOffTarget },
      onTarget: { label: "Shots on target", us: us.shotsOnTarget, opp: opp.shotsOnTarget },
      blocked: { label: "Blocked shots", us: us.blocked, opp: opp.blocked },
      woodwork: { label: "Hit woodwork", us: us.woodwork, opp: opp.woodwork },
      inBox: { label: "Shots inside box", us: us.inBox, opp: opp.inBox },
      outsideBox: { label: "Shots outside box", us: us.outsideBox, opp: opp.outsideBox },
    };
  }

  /** @deprecated use topStatsRows / shotsCardRows */
  function comparisonRows(stats) {
    return topStatsRows(stats);
  }

  function winnerSide(usVal, oppVal, preferLower) {
    const a = Number(usVal) || 0;
    const b = Number(oppVal) || 0;
    if (a === b) return "";
    if (preferLower) return a < b ? "us" : "opp";
    return a > b ? "us" : "opp";
  }

  return {
    buildGameSummaryStats,
    topStatsRows,
    shotsCardRows,
    comparisonRows,
    winnerSide,
    zoneOfLane,
    isShot,
    isOnFrame,
    isWeakToGk,
    isWoodwork,
    isShotOnTarget,
    isShotOffTarget,
    IN_BOX_RANGES,
  };
});
