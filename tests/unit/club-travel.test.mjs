import { describe, expect, it, vi, afterEach } from "vitest";
import { geocodePlace, routeMatrix, travelMinutesBetween } from "../../supabase/functions/_shared/club/travel.mjs";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("club travel (Photon + OpenRouteService)", () => {
  it("geocodes via Photon without an API key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        async json() {
          return {
            features: [
              {
                geometry: { coordinates: [-111.9711, 41.0602] },
                properties: { name: "Layton", state: "Utah", country: "United States", osm_id: 1 },
              },
            ],
          };
        },
      }))
    );

    const result = await geocodePlace("Layton, UT");
    expect(result.ok).toBe(true);
    expect(result.provider).toBe("photon");
    expect(result.results[0].lat).toBeCloseTo(41.0602);
    expect(result.results[0].lng).toBeCloseTo(-111.9711);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, opts] = fetch.mock.calls[0];
    expect(String(url)).toContain("photon.komoot.io");
    expect(opts.headers["User-Agent"]).toMatch(/bhs-shot-tracker/);
  });

  it("returns unavailable drive times when ORS key is missing", async () => {
    const result = await travelMinutesBetween(
      { lat: 40.5, lng: -112 },
      { lat: 41.0, lng: -111.9 },
      ""
    );
    expect(result.unavailable).toBe(true);
    expect(result.minutes).toBeNull();
  });

  it("parses ORS matrix durations into minutes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        async json() {
          // sources:[0] destinations:[1] → one duration (seconds) per destination
          return { durations: [[1500]] };
        },
        async text() {
          return "";
        },
      }))
    );

    const matrix = await routeMatrix(
      { lat: 41.06, lng: -111.96 },
      [{ lat: 40.56, lng: -111.94 }],
      "test-ors-key"
    );
    expect(matrix.ok).toBe(true);
    expect(matrix.durations_minutes[0]).toBe(25);

    const [url, opts] = fetch.mock.calls[0];
    expect(String(url)).toContain("openrouteservice.org/v2/matrix/driving-car");
    expect(opts.headers.Authorization).toBe("test-ors-key");
    const body = JSON.parse(opts.body);
    expect(body.locations[0]).toEqual([-111.96, 41.06]);
    expect(body.sources).toEqual([0]);
    expect(body.destinations).toEqual([1]);
  });
});
