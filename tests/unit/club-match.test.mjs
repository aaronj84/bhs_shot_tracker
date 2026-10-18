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
const { shotTrackerMatches, renderClubMarkdown, shouldDriveFromPrior, CHAIN_GAP_MS } =
  context.ClubVisitation;

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

describe("club gemini markdown", () => {
  it("renders headings, lists, bold, and code without leaving the marks", () => {
    const html = renderClubMarkdown(
      [
        "Here are your options:",
        "",
        "### Option 1: Maximum Players (13 Players)",
        "— **Single Game in South Weber**",
        "* **4:15 PM MDT** | `d18888c2-658a-555b-adf0-53ac41ab2035`",
        "* **Players (13):** Henry, Miles",
        "",
        "---",
        "",
        "**Recommendation:** Attending **Game `d18888c2-658a-555b-adf0-53ac41ab2035`** at La Roca.",
        "",
        "*Note: suggestions only.*",
      ].join("\n")
    );
    expect(html).toContain("<h3>Option 1: Maximum Players (13 Players)</h3>");
    expect(html).toContain("<strong>Single Game in South Weber</strong>");
    expect(html).toContain("<li><strong>4:15 PM MDT</strong>");
    expect(html).toContain('data-add-itin="d18888c2-658a-555b-adf0-53ac41ab2035">Add</button>');
    expect(html).toContain("<hr>");
    expect(html).toContain("<em>Note: suggestions only.</em>");
    expect(html).not.toContain("Game ID");
    expect(html).not.toContain("###");
    expect(html).not.toContain("**");
    expect(html).not.toContain("<code>");
    expect(html).not.toContain("<script>");
    const visible = html.replace(/data-add-itin="[^"]*"/g, "");
    expect(visible).not.toContain("d18888c2");
  });

  it("marks a game that is already on the itinerary", () => {
    const html = renderClubMarkdown(
      "* **4:15 PM MDT** | `d18888c2-658a-555b-adf0-53ac41ab2035`",
      new Set(["d18888c2-658a-555b-adf0-53ac41ab2035"])
    );
    expect(html).toContain(">Added</button>");
    expect(html).not.toContain("data-add-itin");
  });

  it("drops a parenthetical ID label from a one-line game summary", () => {
    const html = renderClubMarkdown(
      "**Zander's Game (ID: `d18888c2-658a-555b-adf0-53ac41ab2035`): 1:00 PM MDT at Butler M.S.**"
    );
    expect(html).toContain('data-add-itin="d18888c2-658a-555b-adf0-53ac41ab2035"');
    expect(html).toContain("Zander's Game");
    expect(html).toContain("1:00 PM MDT at Butler M.S.");
    expect(html.toLowerCase()).not.toContain("id");
  });

  it("does not leave empty parentheses when the model wraps the game id", () => {
    const html = renderClubMarkdown(
      "1. **Zander** (`d18888c2-658a-555b-adf0-53ac41ab2035`)\n   - **Kickoff:** 1:00 PM\n   - **Facility:** Butler M.S."
    );
    expect(html).toContain('data-add-itin="d18888c2-658a-555b-adf0-53ac41ab2035"');
    expect(html).toContain("<strong>Zander</strong>");
    expect(html).not.toMatch(/Zander\s*\(\s*\)/);
    expect(html).not.toMatch(/\(\s*\)/);
  });

  it("keeps player-name bold when the game id follows on the same line", () => {
    const html = renderClubMarkdown(
      "1. **Calvin** `d18888c2-658a-555b-adf0-53ac41ab2035`\n   - **Kickoff:** 3:30 PM\n   - **Includes:** Jason S., Weston"
    );
    expect(html).toContain("<strong>Calvin</strong>");
    expect(html).toContain("<strong>Kickoff:</strong>");
    expect(html).toContain("<strong>Includes:</strong>");
    expect(html).toContain('data-add-itin="d18888c2-658a-555b-adf0-53ac41ab2035"');
    expect(html).not.toContain("**Calvin");
    expect(html).not.toContain("**");
  });

  it("drops a Game ID label and keeps the Add button", () => {
    const html = renderClubMarkdown("**Game ID:** `d18888c2-658a-555b-adf0-53ac41ab2035`");
    expect(html).toContain('data-add-itin="d18888c2-658a-555b-adf0-53ac41ab2035"');
    expect(html.toLowerCase()).not.toContain("game id");
    expect(html).not.toContain("**");
  });

  it("escapes HTML in the model text", () => {
    const html = renderClubMarkdown("### <img src=x onerror=alert(1)>\n\n<script>alert(1)</script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img");
  });
});

describe("itinerary drive origin rules", () => {
  const morning = { kickoff_at: "2026-10-24T19:00:00.000Z" }; // 1:00 PM MDT
  const afternoon = { kickoff_at: "2026-10-24T22:15:00.000Z" }; // 4:15 PM MDT (~3h15)
  const close = { kickoff_at: "2026-10-24T21:00:00.000Z" }; // 3:00 PM MDT (~2h)
  const nextDay = { kickoff_at: "2026-10-25T19:00:00.000Z" };

  it("chains same-day games within 3 hours", () => {
    expect(shouldDriveFromPrior(morning, close)).toBe(true);
  });

  it("resets to home when the kickoff gap is over 3 hours", () => {
    expect(CHAIN_GAP_MS).toBe(3 * 60 * 60 * 1000);
    expect(shouldDriveFromPrior(morning, afternoon)).toBe(false);
  });

  it("resets to home on a different day even if close in clock time", () => {
    expect(shouldDriveFromPrior(morning, nextDay)).toBe(false);
  });
});
