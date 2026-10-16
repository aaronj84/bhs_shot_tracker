import { describe, expect, it } from "vitest";
import { executeClubTool, TOOL_NAMES } from "../../supabase/functions/_shared/club/tools.mjs";

function fakeDb(games) {
  return {
    async searchGames(filters) {
      let rows = games;
      if (filters.both_sides) rows = rows.filter((g) => g.brighton_both_sides);
      if (filters.player_ids?.length) {
        rows = rows.filter((g) =>
          [...g.home_brighton_players, ...g.away_brighton_players].some((p) =>
            filters.player_ids.includes(p.player_id)
          )
        );
      }
      return rows;
    },
    async getGameDetails(id) {
      return games.find((g) => g.id === id) || null;
    },
    async getItinerary() {
      return null;
    },
    async listItineraries() {
      return [{ id: "i1", name: "Demo" }];
    },
  };
}

const sampleGames = [
  {
    id: "g-both",
    kickoff_at: "2026-04-12T16:00:00.000Z",
    status: "scheduled",
    home_team_id: "a",
    away_team_id: "b",
    home_team_name: "Avalanche",
    away_team_name: "La Roca",
    home_brighton_players: [{ player_id: "p1", name: "Susie", side: "home" }],
    away_brighton_players: [{ player_id: "p2", name: "Jackie", side: "away" }],
    brighton_both_sides: true,
    brighton_player_count: 2,
    facility_name: "Layton Commons",
    city: "Layton",
    latitude: 41.08,
    longitude: -111.97,
  },
  {
    id: "g-one",
    kickoff_at: "2026-04-11T22:00:00.000Z",
    status: "scheduled",
    home_team_id: "a",
    away_team_id: "c",
    home_team_name: "Avalanche",
    away_team_name: "Wasatch",
    home_brighton_players: [
      { player_id: "p1", name: "Susie", side: "home" },
      { player_id: "p3", name: "Jane", side: "home" },
    ],
    away_brighton_players: [],
    brighton_both_sides: false,
    brighton_player_count: 2,
    facility_name: "RAC",
    field_label: "Field 5",
    city: "South Jordan",
    latitude: 40.52,
    longitude: -111.98,
  },
];

describe("club gemini tools", () => {
  it("exposes the required tool names", () => {
    expect(TOOL_NAMES).toContain("search_club_games");
    expect(TOOL_NAMES).toContain("find_nearby_club_games");
    expect(TOOL_NAMES).toContain("propose_club_itinerary");
  });

  it("grounds both-sides search in home and away affiliations", async () => {
    const result = await executeClubTool(
      "search_club_games",
      { date_from: "2026-04-11", date_to: "2026-04-13", both_sides: true },
      { db: fakeDb(sampleGames), mapsApiKey: "" }
    );
    expect(result.count).toBe(1);
    expect(result.games[0].game_id).toBe("g-both");
    expect(result.games[0].home_brighton_players[0].name).toBe("Susie");
    expect(result.games[0].away_brighton_players[0].name).toBe("Jackie");
  });

  it("returns travel unavailable when maps key missing (no invented minutes)", async () => {
    const result = await executeClubTool(
      "get_travel_times",
      {
        origin: { lat: 40.5, lng: -112, facility_id: "a" },
        destinations: [{ lat: 41.0, lng: -111.9, facility_id: "b" }],
      },
      { db: fakeDb([]), mapsApiKey: "" }
    );
    expect(result.results[0].unavailable).toBe(true);
    expect(result.results[0].minutes).toBeNull();
  });

  it("proposes itinerary without dropping locked games", async () => {
    const result = await executeClubTool(
      "propose_club_itinerary",
      {
        candidate_game_ids: ["g-one", "g-both"],
        locked_game_ids: ["g-both"],
        viewing_minutes: 30,
      },
      { db: fakeDb(sampleGames), mapsApiKey: "" }
    );
    expect(result.proposal.ordered_game_ids).toContain("g-both");
    expect(result.proposal.ordered_game_ids).toHaveLength(2);
  });
});
