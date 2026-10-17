import { describe, expect, it } from "vitest";
import {
  mergeGameUpdate,
  pickBestMatch,
  isFieldLocked,
  uniquePlayers,
  playersOnBothSides,
  shouldCancelFromAbsence,
} from "../../supabase/functions/_shared/club/reconcile.mjs";

describe("club reconcile overrides", () => {
  it("protects coach-verified fields from silent overwrite", () => {
    const game = {
      kickoff_at: "2026-04-11T22:00:00.000Z",
      status: "scheduled",
      club_facility_id: "fac-1",
      club_field_id: "field-5",
      home_team_id: "a",
      away_team_id: "b",
      coach_verified_at: "2026-04-01T00:00:00.000Z",
      manual_overrides: {},
    };
    expect(isFieldLocked(game, "kickoff_at")).toBe(true);
    const merge = mergeGameUpdate(game, {
      kickoff_at: "2026-04-11T23:00:00.000Z",
      club_field_id: "field-7",
    });
    expect(merge.action).toBe("conflict");
    expect(merge.patch).toEqual({});
    expect(merge.conflicts.map((c) => c.field).sort()).toEqual(["club_field_id", "kickoff_at"]);
  });

  it("updates unlocked fields and records changes", () => {
    const game = {
      kickoff_at: "2026-04-11T22:00:00.000Z",
      status: "scheduled",
      club_facility_id: "fac-1",
      club_field_id: "field-5",
      home_team_id: "a",
      away_team_id: "b",
      manual_overrides: { fields: ["status"] },
    };
    const merge = mergeGameUpdate(game, {
      kickoff_at: "2026-04-11T23:00:00.000Z",
      status: "cancelled",
    });
    expect(merge.action).toBe("conflict");
    expect(merge.changes).toContain("kickoff_at");
    expect(merge.patch.kickoff_at).toBe("2026-04-11T23:00:00.000Z");
    expect(merge.conflicts.some((c) => c.field === "status")).toBe(true);
  });
});

describe("club dedupe matching", () => {
  it("merges two sources listing the same match into one candidate", () => {
    const parsed = {
      home_team_id: "a",
      away_team_id: "b",
      kickoff_at: "2026-04-11T22:00:00.000Z",
      club_competition_id: "c1",
      club_facility_id: "fac",
    };
    const candidates = [
      {
        id: "g1",
        home_team_id: "a",
        away_team_id: "b",
        kickoff_at: "2026-04-11T22:05:00.000Z",
        club_competition_id: "c1",
        club_facility_id: "fac",
      },
    ];
    const { match } = pickBestMatch(parsed, candidates);
    expect(match?.id).toBe("g1");
  });
});

describe("brighton both sides + counts", () => {
  it("counts distinct players on one team", () => {
    const home = [
      { player_id: "1", name: "Jackie" },
      { player_id: "2", name: "Jane" },
      { player_id: "1", name: "Jackie" },
    ];
    expect(uniquePlayers(home)).toHaveLength(2);
    expect(playersOnBothSides(home, [])).toBe(false);
  });

  it("detects Brighton players on opposing teams", () => {
    const home = [{ player_id: "1", name: "Susie", side: "home" }];
    const away = [{ player_id: "2", name: "Jackie", side: "away" }];
    expect(playersOnBothSides(home, away)).toBe(true);
    expect(uniquePlayers([...home, ...away])).toHaveLength(2);
  });
});

describe("absence policy", () => {
  it("never auto-cancels from a missing source event", () => {
    expect(shouldCancelFromAbsence()).toBe(false);
  });
});
