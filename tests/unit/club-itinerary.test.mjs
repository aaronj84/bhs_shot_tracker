import { describe, expect, it } from "vitest";
import {
  assessFeasibility,
  buildItineraryIcs,
  buildLegs,
  formatItineraryText,
  formatVisitSummary,
  icsDataUrl,
  icsEscape,
  itineraryFeedUrl,
  itineraryIcsFilename,
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

describe("club itinerary ICS", () => {
  it("escapes ICS text and builds a safe filename", () => {
    expect(icsEscape("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
    expect(itineraryIcsFilename({ name: "Saturday RAC Visits!" })).toBe("saturday-rac-visits.ics");
    expect(itineraryIcsFilename({})).toBe("club-visits.ics");
  });

  it("shortens visit SUMMARY to two names then +N", () => {
    expect(formatVisitSummary("", "A vs B")).toBe("Visit: A vs B");
    expect(formatVisitSummary("Jackie", "A vs B")).toBe("Visit: Jackie - A vs B");
    expect(formatVisitSummary("Jackie, Jane", "A vs B")).toBe("Visit: Jackie, Jane - A vs B");
    expect(formatVisitSummary("Jackie, Jane, Cara, Dan", "Avalanche vs Wasatch")).toBe(
      "Visit: Jackie, Jane +2 - Avalanche vs Wasatch"
    );
  });

  it("builds a subscribe URL only for a 48-hex feed token", () => {
    const tok = "a".repeat(48);
    expect(itineraryFeedUrl("https://x.supabase.co/", tok)).toBe(
      `https://x.supabase.co/functions/v1/club-itinerary-ics/${tok}.ics`
    );
    expect(itineraryFeedUrl("https://x.supabase.co", "short")).toBe("");
    expect(itineraryFeedUrl("", tok)).toBe("");
  });

  it("emits one VEVENT per stop with arrival window and reminder", () => {
    const ics = buildItineraryIcs(
      { id: "itin-1", name: "Saturday visits", notes: "Bring chairs" },
      [
        {
          game_id: "g1",
          team_line: "Avalanche vs Wasatch",
          brighton_line: "Jackie, Jane, Cara, Dan",
          kickoff_at: "2026-04-11T22:00:00.000Z",
          planned_arrival_at: "2026-04-11T21:40:00.000Z",
          planned_departure_at: "2026-04-11T22:10:00.000Z",
          facility_name: "RAC",
          field_label: "Field 5",
          lat: 40.5,
          lng: -112,
          visit_minutes: 105,
        },
        {
          game_id: "g2",
          team_line: "Storm vs United",
          kickoff_at: "2026-04-11T23:30:00.000Z",
          facility_name: "Layton",
          field_label: "Turf 2",
        },
      ],
      { now: new Date("2026-04-01T12:00:00.000Z") }
    );
    const unfolded = ics.replace(/\r\n /g, "");
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(unfolded).toContain("UID:itin-1-g1@bhs-club-visits");
    expect(unfolded).toContain("DTSTART:20260411T214000Z");
    // 21:40Z + 105m = 23:25Z
    expect(unfolded).toContain("DTEND:20260411T232500Z");
    expect(unfolded).toContain("SUMMARY:Visit: Jackie\\, Jane +2 - Avalanche vs Wasatch");
    expect(unfolded).toContain("Players: Jackie\\, Jane\\, Cara\\, Dan");
    expect(unfolded).toContain("LOCATION:RAC · Field 5");
    expect(unfolded).toContain("TRIGGER:-PT15M");
    expect(unfolded).toContain("Bring chairs");
    expect(unfolded).toMatch(/URL:https:\/\/www\.google\.com\/maps/);
    // Second stop: kickoff − 5m through default 105m visit
    expect(unfolded).toContain("DTSTART:20260411T232500Z");
    expect(unfolded).toContain("DTEND:20260412T011000Z");
    expect(unfolded).toContain("X-WR-CALNAME:Saturday visits");
    const dataUrl = icsDataUrl(ics);
    expect(dataUrl.startsWith("data:text/calendar;charset=utf-8;base64,")).toBe(true);
    const decoded = Buffer.from(dataUrl.split(",")[1], "base64").toString("utf8");
    expect(decoded).toContain("BEGIN:VCALENDAR");
    expect(decoded).toContain("BEGIN:VEVENT");
  });
});
