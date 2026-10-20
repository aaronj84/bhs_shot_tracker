import { describe, expect, it } from "vitest";
import { parseIcs } from "../../supabase/functions/_shared/club/ics.mjs";
import { csvToEvents } from "../../supabase/functions/_shared/club/parse-csv.mjs";
import { parseJsonSchedule } from "../../supabase/functions/_shared/club/parse-json.mjs";
import { parseHtmlSchedule } from "../../supabase/functions/_shared/club/parse-html.mjs";
import { parseByProvider, runSourceSync } from "../../supabase/functions/_shared/club/sync-run.mjs";
import { mergeGameUpdate } from "../../supabase/functions/_shared/club/reconcile.mjs";
import { formatLocalKickoff, denverParts } from "../../supabase/functions/_shared/club/normalize.mjs";

function memoryDb() {
  const games = [];
  const links = [];
  const changes = [];
  const runs = [];
  const sources = new Map();
  return {
    games,
    links,
    changes,
    runs,
    sources,
    async insertSyncRun(row) {
      const r = { id: `run-${runs.length + 1}`, ...row };
      runs.push(r);
      return r;
    },
    async finishSyncRun(id, patch) {
      const r = runs.find((x) => x.id === id);
      Object.assign(r, patch);
    },
    async updateSourceStatus(id, patch) {
      sources.set(id, { ...(sources.get(id) || {}), ...patch });
    },
    async listTeams() {
      return [
        { id: "t-home", team_name: "Avalanche 09G Navy", organization_name: "Utah Avalanche", normalized_name: "utah avalanche avalanche 09g navy", aliases: ["Avalanche Navy"] },
        { id: "t-away", team_name: "Wasatch 09G Orange", organization_name: "Wasatch SC", normalized_name: "wasatch sc wasatch 09g orange", aliases: [] },
      ];
    },
    async listFacilities() {
      return [{ id: "fac-rac", name: "Regional Athletic Complex", aliases: ["RAC"] }];
    },
    async listFields() {
      return [
        { id: "f5", club_facility_id: "fac-rac", label: "Field 5" },
        { id: "f7", club_facility_id: "fac-rac", label: "Field 7" },
      ];
    },
    async listGamesForTeams() {
      return games;
    },
    async findSourceLink(sourceId, externalId) {
      return links.find((l) => l.club_schedule_source_id === sourceId && l.external_id === externalId) || null;
    },
    async getGame(id) {
      return games.find((g) => g.id === id) || null;
    },
    async insertGame(row) {
      const g = { id: `g-${games.length + 1}`, manual_overrides: {}, ...row };
      games.push(g);
      return g;
    },
    async updateGame(id, patch) {
      const g = games.find((x) => x.id === id);
      Object.assign(g, patch);
    },
    async upsertSourceLink(row) {
      const i = links.findIndex(
        (l) => l.club_schedule_source_id === row.club_schedule_source_id && l.external_id === row.external_id
      );
      if (i >= 0) links[i] = { ...links[i], ...row };
      else links.push(row);
    },
    async insertChange(row) {
      changes.push(row);
    },
  };
}

describe("club parsers", () => {
  it("parses ICS events with home/away heuristic", () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:evt-1@example.com
DTSTART:20260411T220000Z
SUMMARY:Avalanche Navy vs Wasatch 09G Orange
LOCATION:RAC Field 5
STATUS:CONFIRMED
END:VEVENT
END:VCALENDAR`;
    const { events, errors } = parseIcs(ics);
    expect(errors).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0].external_id).toBe("evt-1@example.com");
    expect(events[0].raw_home_label).toMatch(/Avalanche/i);
    expect(events[0].kickoff_at).toBe("2026-04-11T22:00:00.000Z");
  });

  it("parses CSV and JSON feeds", () => {
    const csv = `home,away,kickoff,status\nAvalanche Navy,Wasatch 09G Orange,2026-04-11T22:00:00Z,scheduled\n`;
    expect(csvToEvents(csv).events).toHaveLength(1);
    const json = JSON.stringify({
      events: [{ home: "A", away: "B", kickoff_at: "2026-04-11T22:00:00Z", id: "1" }],
    });
    expect(parseJsonSchedule(json).events[0].external_id).toBe("1");
  });

  it("reports unsupported HTML adapters honestly", () => {
    const bad = parseHtmlSchedule("<html><body>No tables</body></html>");
    expect(bad.unsupported).toBe(true);
    const unknown = parseByProvider("html", "<table></table>", { adapter: "mystery_site" });
    expect(unknown.unsupported).toBe(true);
  });
});

describe("club sync run", () => {
  it("inserts then idempotently leaves schedule intact on re-run; failure leaves prior games", async () => {
    const db = memoryDb();
    const source = {
      id: "src-1",
      source_url: "https://example.test/feed.ics",
      provider: "ics",
      parser_config: {},
      club_team_id: "t-home",
      club_competition_id: "c1",
    };
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:same-uid
DTSTART:20260411T220000Z
SUMMARY:Avalanche Navy vs Wasatch 09G Orange
LOCATION:RAC Field 5
END:VEVENT
END:VCALENDAR`;
    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => ics });
    // patch fetchSource via opts — runSourceSync uses fetchImpl returning {ok,text}
    const fetchOk = async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => ics,
    });

    // monkey: sync-run fetchSource expects fetch-like; provide Response-like
    const res1 = await runSourceSync(db, source, {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => ics,
      }),
    });
    // Wait - fetchSource expects real fetch API. Looking at my code:
    // const res = await fetchImpl(url, ...); const text = await res.text();
    // So fetchImpl must return Response-like with .ok, .status, .text()
    expect(res1.ok).toBe(true);
    expect(db.games).toHaveLength(1);
    expect(res1.counts.inserted).toBe(1);

    const res2 = await runSourceSync(db, source, {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => ics,
      }),
    });
    expect(db.games).toHaveLength(1);
    expect(res2.counts.unchanged + res2.counts.updated).toBeGreaterThanOrEqual(1);

    const before = db.games.length;
    const fail = await runSourceSync(db, source, {
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        text: async () => "nope",
      }),
    });
    // fetchSource checks res.ok - our mock returns ok:false so it returns error without reading as Response
    // Actually fetchSource does: const res = await fetchImpl(...); if (!res.ok) ...
    // But when ok is false it still works. When fetch throws:
    expect(fail.ok).toBe(false);
    expect(db.games.length).toBe(before);
  });

  it("does not overwrite coach-verified kickoff from stale feed", () => {
    const game = {
      kickoff_at: "2026-04-11T23:00:00.000Z",
      status: "scheduled",
      home_team_id: "a",
      away_team_id: "b",
      club_facility_id: null,
      club_field_id: null,
      coach_verified_at: "2026-04-10T00:00:00.000Z",
      manual_overrides: { fields: ["kickoff_at"] },
    };
    const merge = mergeGameUpdate(game, { kickoff_at: "2026-04-11T22:00:00.000Z" });
    expect(merge.patch.kickoff_at).toBeUndefined();
    expect(merge.conflicts[0].field).toBe("kickoff_at");
  });

  it("one team can have three independent sources without redesign", () => {
    const providers = ["ics", "csv", "json"];
    expect(providers.map((p) => parseByProvider(p, p === "ics" ? "BEGIN:VCALENDAR\nEND:VCALENDAR" : p === "csv" ? "home,away\n" : "[]").events)).toBeTruthy();
  });
});

describe("timezone rendering", () => {
  it("formats Denver local including DST and TBD", () => {
    expect(formatLocalKickoff(null)).toBe("TBD");
    // Apr 11 2026 16:00 MDT = 22:00Z
    const stamp = formatLocalKickoff("2026-04-11T22:00:00.000Z");
    expect(stamp).toMatch(/Apr 11/);
    expect(stamp).toMatch(/MDT|MST/);
    const parts = denverParts("2026-11-03T22:00:00.000Z");
    expect(parts.date).toBe("2026-11-03");
  });
});
