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

  it("searches the day named in the question, not the agenda week", async () => {
    let seen = null;
    const db = {
      async searchGames(filters) {
        seen = filters;
        return sampleGames;
      },
    };
    const result = await executeClubTool(
      "search_club_games",
      { date_from: "2026-10-16", date_to: "2026-10-23" },
      {
        db,
        mapsApiKey: "",
        question: "are there any games coming saturday?",
        now: new Date("2026-10-16T18:00:00.000Z"),
      }
    );
    expect(seen.date_from).toBe("2026-10-17");
    expect(seen.date_to).toBe("2026-10-17");
    expect(seen.brighton_only).toBe(false);
    expect(seen.both_sides).toBe(false);
    expect(result.count).toBe(sampleGames.length);
  });

  it("uses a written calendar day ahead of the weekday word", async () => {
    let seen = null;
    const db = {
      async searchGames(filters) {
        seen = filters;
        return [];
      },
    };
    await executeClubTool(
      "search_club_games",
      {},
      {
        db,
        mapsApiKey: "",
        question: "which saturday 10/24 games have the most players to visit?",
        now: new Date("2026-10-16T18:00:00.000Z"),
      }
    );
    expect(seen.date_from).toBe("2026-10-24");
    expect(seen.date_to).toBe("2026-10-24");
  });

  it("treats Saturday the 24th as the 24th, not the coming Saturday", async () => {
    let seen = null;
    const db = {
      async searchGames(filters) {
        seen = filters;
        return [];
      },
    };
    await executeClubTool(
      "search_club_games",
      { team_name: "Red TS" },
      {
        db,
        mapsApiKey: "",
        question:
          "i'm gonna go watch Red TS Saturday the 24th. How long will it take me to get from there to the game against La Roca for Red AJ?",
        now: new Date("2026-10-16T18:00:00.000Z"),
      }
    );
    expect(seen.date_from).toBe("2026-10-24");
    expect(seen.date_to).toBe("2026-10-24");
    expect(seen.team_ids == null || seen.team_ids.length === 0).toBe(true);
  });

  it("includes the other team named in the question, not only the player search", async () => {
    const games = [
      {
        id: "g-ts",
        kickoff_at: "2026-10-24T19:00:00.000Z",
        home_team_name: "Cottonwood FC B1415 Red TS",
        away_team_name: "Golden Eagles FC 14/15B Blue",
        home_brighton_players: [{ player_id: "z", name: "Zander", full_name: "Zander Friedman" }],
        away_brighton_players: [],
        facility_name: "Butler M.S.",
        street_address: "7530 S 2700 E",
        city: "Cottonwood Heights",
        latitude: 40.61,
        longitude: -111.81,
      },
      {
        id: "g-aj",
        kickoff_at: "2026-10-24T22:15:00.000Z",
        home_team_name: "La Roca U12B R. Rada",
        away_team_name: "Cottonwood FC B1415 Red AJ",
        home_brighton_players: [],
        away_brighton_players: [{ player_id: "h", name: "Henry", full_name: "Henry Luplow" }],
        facility_name: "La Roca Park",
        street_address: "128 E South Weber Dr",
        city: "South Weber",
        latitude: 41.13,
        longitude: -111.95,
      },
    ];
    const result = await executeClubTool(
      "search_club_games",
      { player_name: "Zander" },
      {
        db: {
          async searchGames() {
            return games;
          },
        },
        mapsApiKey: "",
        question:
          "next Saturday the 24th i'm going to watch Zander. Do i have time to drive to the Red AJ team against La Roca?",
        now: new Date("2026-10-16T18:00:00.000Z"),
      }
    );
    expect(result.games.map((g) => g.game_id)).toEqual(["g-ts", "g-aj"]);
    expect(result.games[1].address).toBe("128 E South Weber Dr");
    expect(result.games[1].facility).toBe("La Roca Park");
    expect(result.games[0].kickoff_local).toMatch(/Oct/);
    expect(result.games[0].kickoff_local).toMatch(/\d/);
    expect(result.travel).toHaveLength(1);
    expect(result.travel[0].from_game_id).toBe("g-ts");
    expect(result.travel[0].to_game_id).toBe("g-aj");
    expect(result.travel[0].from_place).toBe("Butler M.S.");
    expect(result.travel[0].to_place).toBe("La Roca Park");
    expect(result.travel[0].unavailable).toBe(true);
  });

  it("keeps both named players when a follow-up corrects the day", async () => {
    const games = [
      {
        id: "g-ts",
        kickoff_at: "2026-10-24T19:00:00.000Z",
        home_team_name: "Cottonwood FC B1415 Red TS",
        away_team_name: "Golden Eagles",
        home_brighton_players: [{ player_id: "z", name: "Zander", full_name: "Zander Friedman" }],
        away_brighton_players: [],
        facility_name: "Butler M.S.",
        latitude: 40.61,
        longitude: -111.81,
      },
      {
        id: "g-aj",
        kickoff_at: "2026-10-24T22:15:00.000Z",
        home_team_name: "La Roca U12B R. Rada",
        away_team_name: "Cottonwood FC B1415 Red AJ",
        home_brighton_players: [],
        away_brighton_players: [{ player_id: "r", name: "Rudi", full_name: "Rudi Johnson" }],
        facility_name: "La Roca Park",
        latitude: 41.13,
        longitude: -111.95,
      },
    ];
    const result = await executeClubTool(
      "search_club_games",
      { player_name: "Zander" },
      {
        db: { async searchGames() { return games; } },
        mapsApiKey: "",
        question: "sorry, i meant saturday the 24th. try again",
        historyText: "next saturday, Zander plays, and then Rudi plays. Do i have time to get to both games?",
        now: new Date("2026-10-16T18:00:00.000Z"),
      }
    );
    expect(result.date_from).toBe("2026-10-24");
    expect(result.games.map((g) => g.game_id)).toEqual(["g-ts", "g-aj"]);
    expect(result.travel[0].from_place).toBe("Butler M.S.");
    expect(result.travel[0].to_place).toBe("La Roca Park");
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

  it("resolves get_travel_times from origin_game_id / destination_game_id", async () => {
    const result = await executeClubTool(
      "get_travel_times",
      {
        origin_game_id: "g-one",
        destination_game_id: "g-both",
      },
      { db: fakeDb(sampleGames), mapsApiKey: "" }
    );
    expect(result.error).toBeUndefined();
    expect(result.origin.game_id).toBe("g-one");
    expect(result.results[0].from_place).toBe("RAC");
    expect(result.results[0].to_place).toBe("Layton Commons");
    expect(result.results[0].unavailable).toBe(true);
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
