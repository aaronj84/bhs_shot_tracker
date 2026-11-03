import { describe, expect, it } from "vitest";
import {
  PLANNING,
  normalize,
  fromTeam,
  has,
  isPlanningView,
  isPlanningHash,
} from "../../team-modules.js";

describe("team-modules", () => {
  it("normalizes modules to unique lowercase keys", () => {
    expect(normalize(null)).toEqual([]);
    expect(normalize("planning")).toEqual([]);
    expect(normalize(["Planning", " planning ", "planning", ""])).toEqual(["planning"]);
  });

  it("reads modules from a team row", () => {
    expect(fromTeam(null)).toEqual([]);
    expect(fromTeam({ modules: ["planning"] })).toEqual(["planning"]);
    expect(fromTeam({ is_ours: true, name: "CFC G10 BD", modules: [] })).toEqual([]);
    // Pre-migration / missing column: Brighton-branded owned teams still get planning.
    expect(fromTeam({ is_ours: true, name: "Brighton", modules: null })).toEqual(["planning"]);
    expect(
      fromTeam({ is_ours: true, name: "CFC G10 BD", organization: "Cottonwood FC", modules: null })
    ).toEqual([]);
  });

  it("has() works for team rows and raw arrays", () => {
    expect(has({ modules: ["planning"] }, PLANNING)).toBe(true);
    expect(has({ modules: [] }, PLANNING)).toBe(false);
    expect(has(["planning"], "planning")).toBe(true);
    expect(has([], "planning")).toBe(false);
  });

  it("identifies planning views and hashes", () => {
    expect(isPlanningView("shots-bracket")).toBe(true);
    expect(isPlanningView("schedule-admin")).toBe(true);
    expect(isPlanningView("club-agenda")).toBe(true);
    expect(isPlanningView("shots")).toBe(false);
    expect(isPlanningHash("#club")).toBe(true);
    expect(isPlanningHash("#club-itinerary")).toBe(true);
    expect(isPlanningHash("#schedule")).toBe(true);
    expect(isPlanningHash("#shots-prep")).toBe(false);
  });
});
