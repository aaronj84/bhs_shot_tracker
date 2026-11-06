import { describe, expect, it } from "vitest";
import {
  buildGameSummaryStats,
  comparisonRows,
} from "../../game-summary-stats.js";

describe("game-summary-stats", () => {
  it("counts shots, corners, and free kicks per team", () => {
    const stats = buildGameSummaryStats([
      { team: "us", result: "goal", shot: { range: "9-18", lane: "C" }, shooterName: "Pip" },
      { team: "us", result: "on-target", shot: { range: "18-27", lane: "LHS" }, shooterName: "Pip" },
      { team: "us", result: "corner" },
      { team: "opp", result: "blocked", shot: { range: "0-9", lane: "RW" } },
      { team: "opp", result: "foul" },
      { team: "opp", result: "missed", missDirection: "weak-gk", shot: { range: "9-18", lane: "C" } },
    ]);

    expect(stats.score).toEqual({ us: 1, opp: 0 });
    expect(stats.us.shots).toBe(2);
    expect(stats.us.goals).toBe(1);
    expect(stats.us.onTarget).toBe(1);
    expect(stats.us.corners).toBe(1);
    expect(stats.us.inBox).toBe(1);
    expect(stats.us.outsideBox).toBe(1);
    expect(stats.opp.shots).toBe(2);
    expect(stats.opp.blocked).toBe(1);
    expect(stats.opp.weakGk).toBe(1);
    expect(stats.opp.freeKicks).toBe(1);
    expect(stats.opp.missed).toBe(0);
  });

  it("builds comparison rows for summary bars", () => {
    const stats = buildGameSummaryStats([
      { team: "us", result: "goal", shot: { range: "0-9", lane: "C" } },
      { team: "opp", result: "corner" },
    ]);
    const rows = comparisonRows(stats);
    const goals = rows.find((r) => r.key === "goals");
    const corners = rows.find((r) => r.key === "corners");
    expect(goals).toEqual({ key: "goals", label: "Goals", us: 1, opp: 0 });
    expect(corners).toEqual({ key: "corners", label: "Corners", us: 0, opp: 1 });
  });

  it("accepts laneOf/rangeOf helpers", () => {
    const stats = buildGameSummaryStats(
      [{ team: "us", result: "missed", shot: { x: 1, y: 2 } }],
      {
        laneOf: () => ({ id: "LW" }),
        rangeOf: () => ({ id: "27+" }),
      }
    );
    expect(stats.us.byLane.LW).toBe(1);
    expect(stats.us.byRange["27+"]).toBe(1);
    expect(stats.us.outsideBox).toBe(1);
  });
});
