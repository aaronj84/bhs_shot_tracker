import { describe, expect, it } from "vitest";
import {
  parseRelativeDateWindow,
  snapDateYearToNow,
} from "../../supabase/functions/_shared/club/normalize.mjs";
import { executeClubTool } from "../../supabase/functions/_shared/club/tools.mjs";

const NOW = new Date("2026-10-17T18:00:00.000Z"); // Sat Oct 17, 2026 Denver afternoon-ish

describe("club date windows", () => {
  it("treats 'through Oct 25' as a range from today, not a single day", () => {
    const w = parseRelativeDateWindow(
      "build me a route over the next calendar week, through Oct 25th",
      "America/Denver",
      NOW
    );
    expect(w.date_from).toBe("2026-10-18");
    expect(w.date_to).toBe("2026-10-25");
  });

  it("keeps a bare 'Oct 25' as a single day", () => {
    const w = parseRelativeDateWindow("what games are on Oct 25?", "America/Denver", NOW);
    expect(w.date_from).toBe("2026-10-25");
    expect(w.date_to).toBe("2026-10-25");
  });

  it("snaps a drifted model year back to the current season", () => {
    expect(snapDateYearToNow("2024-10-18", "America/Denver", NOW)).toBe("2026-10-18");
    expect(snapDateYearToNow("2026-10-18", "America/Denver", NOW)).toBe("2026-10-18");
  });

  it("search_club_games uses the through-date range from the question", async () => {
    let seen = null;
    const result = await executeClubTool(
      "search_club_games",
      { date_from: "2024-10-18", date_to: "2024-10-25" },
      {
        db: {
          async searchGames(filters) {
            seen = filters;
            return [];
          },
        },
        mapsApiKey: "",
        question: "build me a route to see as many different players as possible over the next calendar week, through Oct 25th",
        now: NOW,
      }
    );
    expect(seen.date_from).toBe("2026-10-18");
    expect(seen.date_to).toBe("2026-10-25");
    expect(result.date_from).toBe("2026-10-18");
    expect(result.date_to).toBe("2026-10-25");
  });
});
