import { describe, expect, it } from "vitest";
import {
  assessFeasibility,
  buildLegs,
  formatItineraryText,
  proposeOrder,
  sameFacility,
} from "../../supabase/functions/_shared/club/itinerary.mjs";

describe("club itinerary feasibility", () => {
  it("uses walk minutes for same-facility field transfers", async () => {
    const stops = [
      { game_id: "1", facility_id: "rac", lat: 40.5, lng: -112, kickoff_at: "2026-04-11T22:00:00.000Z" },
      { game_id: "2", facility_id: "rac", lat: 40.5, lng: -112, kickoff_at: "2026-04-11T23:30:00.000Z" },
    ];
    const legs = await buildLegs(stops, {
      walkMinutes: 8,
      travelMinutes: async () => ({ minutes: 25 }),
    });
    expect(legs).toHaveLength(1);
    expect(legs[0].mode).toBe("walk");
    expect(legs[0].minutes).toBe(8);
    expect(sameFacility(stops[0], stops[1])).toBe(true);
  });

  it("flags impossible consecutive stops and missing routes", async () => {
    const stops = [
      {
        game_id: "1",
        facility_id: "a",
        lat: 40.5,
        lng: -112,
        kickoff_at: "2026-04-11T22:00:00.000Z",
        visit_minutes: 60,
      },
      {
        game_id: "2",
        facility_id: "b",
        lat: 41.0,
        lng: -111.9,
        kickoff_at: "2026-04-11T22:20:00.000Z",
      },
    ];
    const legs = await buildLegs(stops, {
      travelMinutes: async () => ({ minutes: 40 }),
    });
    const { warnings } = assessFeasibility(stops, legs, { defaultVisitMinutes: 60 });
    expect(warnings.some((w) => w.type === "impossible")).toBe(true);

    const missing = await buildLegs(stops, {
      travelMinutes: async () => ({ minutes: null, unavailable: true }),
    });
    const miss = assessFeasibility(stops, missing);
    expect(miss.warnings.some((w) => w.type === "missing_route")).toBe(true);
  });

  it("preserves locked games when proposing order", () => {
    const candidates = [
      { game_id: "a", kickoff_at: "2026-04-11T23:00:00.000Z" },
      { game_id: "b", kickoff_at: "2026-04-11T21:00:00.000Z" },
      { game_id: "c", kickoff_at: "2026-04-11T22:00:00.000Z" },
    ];
    const ordered = proposeOrder(candidates, ["a"], {});
    expect(ordered.map((s) => s.game_id)).toContain("a");
    expect(ordered).toHaveLength(3);
  });

  it("formats copyable itinerary text with warnings", () => {
    const text = formatItineraryText(
      { name: "Saturday visits", target_date: "2026-04-11" },
      [
        {
          team_line: "Avalanche vs Wasatch",
          brighton_line: "Jackie, Jane",
          kickoff_at: "2026-04-11T22:00:00.000Z",
          facility_name: "RAC",
          field_label: "Field 5",
          lat: 40.5,
          lng: -112,
        },
      ],
      [],
      [{ message: "Tight timing" }],
      { staleWarning: "Field changed" }
    );
    expect(text).toContain("Saturday visits");
    expect(text).toContain("Jackie, Jane");
    expect(text).toContain("Warnings:");
    expect(text).toContain("Field changed");
  });
});
