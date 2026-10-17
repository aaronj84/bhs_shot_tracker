import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const code = readFileSync(path.join(ROOT, "club-visitation.js"), "utf8");
const context = {
  window: {},
  document: {
    getElementById() {
      return null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  },
};
context.window = context;
vm.createContext(context);
vm.runInContext(code, context);
const { shotTrackerMatches } = context.ClubVisitation;

const shot = [
  { id: "s-jane", name: "Jane Thackeray", short_name: "Jane" },
  { id: "s-kate", name: "Kate Coccimiglio", short_name: "Kate" },
];

describe("shot tracker match suggestions", () => {
  it("suggests a club player whose full name matches a shot-tracker player", () => {
    const matches = shotTrackerMatches(
      [{ player_id: "c-jane", full_name: "Jane Thackeray", name: "Jane" }],
      shot,
      [],
      []
    );
    expect(matches).toEqual([
      {
        clubPlayerId: "c-jane",
        clubName: "Jane Thackeray",
        candidates: [{ id: "s-jane", name: "Jane Thackeray" }],
      },
    ]);
  });

  it("skips players who are already linked or dismissed, and first-name-only collisions", () => {
    const matches = shotTrackerMatches(
      [
        { player_id: "c-jane", full_name: "Jane Thackeray", name: "Jane", shot_player_id: "s-jane" },
        { player_id: "c-calvin", full_name: "Calvin Wheeler", name: "Calvin" },
        { player_id: "c-kate", full_name: "Kate Coccimiglio", name: "Kate" },
      ],
      shot,
      [],
      ["c-kate"]
    );
    expect(matches).toEqual([]);
  });
});
