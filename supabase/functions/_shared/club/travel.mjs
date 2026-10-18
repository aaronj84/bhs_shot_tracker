/**
 * Server-side geocoding (Photon / optional OpenRouteService) + drive times (ORS Matrix).
 * Never invents drive times from straight-line distance.
 */

import { haversineMiles } from "./normalize.mjs";

const APP_UA = "bhs-shot-tracker-club/1.0 (Brighton varsity visitation; local coach tool)";
const ORS_MATRIX_URL = "https://api.openrouteservice.org/v2/matrix/driving-car";
const ORS_GEOCODE_URL = "https://api.openrouteservice.org/geocode/search";
const PHOTON_URL = "https://photon.komoot.io/api/";

function labelFromPhotonProps(p) {
  return [p.name, p.street, p.city || p.county, p.state, p.country].filter(Boolean).join(", ");
}

async function geocodeWithPhoton(query) {
  const url = new URL(PHOTON_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "5");
  url.searchParams.set("lang", "en");

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": APP_UA,
    },
  });
  if (!res.ok) {
    return { ok: false, error: `Geocode HTTP ${res.status}`, results: [], provider: "photon" };
  }
  const json = await res.json().catch(() => ({}));
  const features = Array.isArray(json.features) ? json.features : [];
  const results = features
    .map((f) => {
      const coords = f.geometry?.coordinates;
      const lng = Array.isArray(coords) ? Number(coords[0]) : null;
      const lat = Array.isArray(coords) ? Number(coords[1]) : null;
      const props = f.properties || {};
      return {
        label: labelFromPhotonProps(props) || query,
        place_id: props.osm_id != null ? String(props.osm_id) : null,
        lat,
        lng,
      };
    })
    .filter((r) => r.lat != null && r.lng != null && !Number.isNaN(r.lat) && !Number.isNaN(r.lng));

  return { ok: true, results, ambiguous: results.length > 1, provider: "photon" };
}

async function geocodeWithOrs(query, apiKey) {
  const url = new URL(ORS_GEOCODE_URL);
  url.searchParams.set("text", query);
  url.searchParams.set("size", "5");
  url.searchParams.set("boundary.country", "USA");

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: apiKey,
    },
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    return {
      ok: false,
      error: `ORS geocode HTTP ${res.status}: ${errText.slice(0, 160)}`,
      results: [],
      provider: "openrouteservice",
    };
  }
  const json = await res.json().catch(() => ({}));
  const features = Array.isArray(json.features) ? json.features : [];
  const results = features
    .map((f) => {
      const coords = f.geometry?.coordinates;
      const lng = Array.isArray(coords) ? Number(coords[0]) : null;
      const lat = Array.isArray(coords) ? Number(coords[1]) : null;
      return {
        label: f.properties?.label || f.properties?.name || query,
        place_id: f.properties?.gid || f.properties?.id || null,
        lat,
        lng,
      };
    })
    .filter((r) => r.lat != null && r.lng != null && !Number.isNaN(r.lat) && !Number.isNaN(r.lng));

  return { ok: true, results, ambiguous: results.length > 1, provider: "openrouteservice" };
}

/** Place lookup: ORS when a key is set, otherwise Photon (no key). */
export async function geocodePlace(query, apiKey = "") {
  const q = String(query || "").trim();
  if (!q) return { ok: false, error: "Empty geocode query", results: [] };

  if (apiKey) {
    const ors = await geocodeWithOrs(q, apiKey);
    if (ors.ok && ors.results.length) return ors;
  }

  return geocodeWithPhoton(q);
}

/**
 * One-to-many drive durations via OpenRouteService Matrix.
 * Returns minutes per destination index; null when unavailable.
 */
export async function routeMatrix(origin, destinations, apiKey) {
  const dests = destinations || [];
  if (!apiKey) {
    return {
      ok: false,
      error: "OPENROUTESERVICE_API_KEY is not configured",
      durations_minutes: dests.map(() => null),
    };
  }
  if (!origin || origin.lat == null || origin.lng == null) {
    return { ok: false, error: "Origin coordinates required", durations_minutes: dests.map(() => null) };
  }
  if (!dests.length) {
    return { ok: true, durations_minutes: [], raw_count: 0 };
  }

  const validIdx = [];
  const locations = [[Number(origin.lng), Number(origin.lat)]];
  for (let i = 0; i < dests.length; i++) {
    const d = dests[i];
    if (d?.lat == null || d?.lng == null) continue;
    validIdx.push(i);
    locations.push([Number(d.lng), Number(d.lat)]);
  }
  if (locations.length < 2) {
    return { ok: false, error: "Destination coordinates required", durations_minutes: dests.map(() => null) };
  }

  const body = {
    locations,
    sources: [0],
    destinations: validIdx.map((_, j) => j + 1),
    metrics: ["duration"],
  };

  const res = await fetch(ORS_MATRIX_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    return {
      ok: false,
      error: `OpenRouteService HTTP ${res.status}: ${errText.slice(0, 200)}`,
      durations_minutes: dests.map(() => null),
    };
  }

  const json = await res.json().catch(() => ({}));
  const row = Array.isArray(json.durations) ? json.durations[0] : null;
  const durations = dests.map(() => null);
  if (Array.isArray(row)) {
    for (let j = 0; j < validIdx.length; j++) {
      const sec = Number(row[j]);
      if (!Number.isNaN(sec) && sec >= 0) {
        durations[validIdx[j]] = Math.round(sec / 60);
      }
    }
  }
  return { ok: true, durations_minutes: durations, raw_count: validIdx.length };
}

export async function travelMinutesBetween(from, to, apiKey) {
  if (from?.facility_id && to?.facility_id && from.facility_id === to.facility_id) {
    return { minutes: null, same_facility: true };
  }
  if (!apiKey) {
    return { minutes: null, unavailable: true, note: "Routing not configured" };
  }
  if (from.lat == null || to.lat == null) {
    return { minutes: null, unavailable: true, note: "Missing coordinates" };
  }
  const matrix = await routeMatrix(from, [to], apiKey);
  const minutes = matrix.durations_minutes?.[0];
  if (minutes == null) {
    return { minutes: null, unavailable: true, note: matrix.error || "No route" };
  }
  return { minutes, unavailable: false, note: "Estimated drive time" };
}

/** Nearby filter using haversine radius only as a geographic prefilter — not drive time. */
export function filterByRadiusMiles(items, origin, radiusMiles) {
  if (origin?.lat == null || origin?.lng == null) return items;
  return (items || []).filter((it) => {
    if (it.lat == null || it.lng == null) return false;
    return haversineMiles(origin.lat, origin.lng, it.lat, it.lng) <= radiusMiles;
  });
}
