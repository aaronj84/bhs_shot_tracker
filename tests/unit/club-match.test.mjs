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
const { shotTrackerMatches, renderClubMarkdown } = context.ClubVisitation;

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
