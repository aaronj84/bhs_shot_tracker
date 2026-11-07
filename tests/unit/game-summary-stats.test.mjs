import { describe, expect, it } from "vitest";
import {
  buildGameSummaryStats,
  shotsCardRows,
  topStatsRows,
  winnerSide,
} from "../../game-summary-stats.js";

describe("game-summary-stats", () => {
  it("counts shots, corners, free kicks, woodwork, and zones", () => {
    const stats = buildGameSummaryStats([
      { team: "us", result: "goal", shot: { range: "9-18", lane: "C" }, shooterName: "Pip" },
      { team: "us", result: "on-target", shot: { range: "18-27", lane: "LHS" }, shooterName: "Pip" },
      { team: "us", result: "missed", missDirection: "crossbar", shot: { range: "9-18", lane: "LW" } },
      { team: "us", result: "corner" },
      { team: "opp", result: "blocked", shot: { range: "0-9", lane: "RW" } },
      { team: "opp", result: "foul" },
      { team: "opp", result: "missed", missDirection: "weak-gk", shot: { range: "9-18", lane: "C" } },
      { team: "opp", result: "missed", missDirection: "over", shot: { range: "27+", lane: "RHS" } },
    ]);

    expect(stats.score).toEqual({ us: 1, opp: 0 });
    expect(stats.us.shots).toBe(3);
    expect(stats.us.goals).toBe(1);
    expect(stats.us.shotsOnTarget).toBe(2);
    expect(stats.us.woodwork).toBe(1);
    expect(stats.us.shotsOffTarget).toBe(0);
    expect(stats.us.corners).toBe(1);
    expect(stats.us.inBox).toBe(2);
    expect(stats.us.outsideBox).toBe(1);
    expect(stats.us.attackingZones).toEqual({ left: 67, center: 33, right: 0, total: 3 });
    expect(stats.opp.shots).toBe(3);
    expect(stats.opp.blocked).toBe(1);
    expect(stats.opp.weakGk).toBe(1);
    expect(stats.opp.shotsOnTarget).toBe(1);
    expect(stats.opp.shotsOffTarget).toBe(1);
    expect(stats.opp.freeKicks).toBe(1);
  });

  it("builds FOTMOB-style top stats and nested shots rows", () => {
    const stats = buildGameSummaryStats([
      { team: "us", result: "goal", shot: { range: "0-9", lane: "C" } },
      { team: "opp", result: "corner" },
    ]);
    const top = topStatsRows(stats);
    expect(top.find((r) => r.key === "goals")).toEqual({
      key: "goals",
      label: "Goals",
      us: 1,
      opp: 0,
    });
    expect(top.find((r) => r.key === "corners")).toEqual({
      key: "corners",
      label: "Corners",
      us: 0,
      opp: 1,
    });
    const shots = shotsCardRows(stats);
    expect(shots.total).toEqual({ label: "Total shots", us: 1, opp: 0 });
    expect(shots.onTarget.us).toBe(1);
    expect(winnerSide(1, 0)).toBe("us");
    expect(winnerSide(1, 1)).toBe("");
  });

  it("accepts laneOf/rangeOf helpers", () => {
    const stats = buildGameSummaryStats(
      [{ team: "us", result: "missed", missDirection: "wide-left", shot: { x: 1, y: 2 } }],
      {
        laneOf: () => ({ id: "LW" }),
        rangeOf: () => ({ id: "27+" }),
      }
    );
    expect(stats.us.byLane.LW).toBe(1);
    expect(stats.us.byRange["27+"]).toBe(1);
    expect(stats.us.outsideBox).toBe(1);
    expect(stats.us.shotsOffTarget).toBe(1);
    expect(stats.us.attackingZones.left).toBe(100);
  });
});
