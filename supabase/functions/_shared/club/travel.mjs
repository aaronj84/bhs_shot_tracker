/**
 * Server-side geocoding + route matrix via Google Maps when configured.
 * Never invents drive times from straight-line distance.
 */

import { haversineMiles } from "./normalize.mjs";

export async function geocodePlace(query, apiKey) {
  if (!apiKey) {
    return { ok: false, error: "GOOGLE_MAPS_API_KEY is not configured", results: [] };
  }
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", query);
  url.searchParams.set("key", apiKey);
  const res = await fetch(url);
  if (!res.ok) {
    return { ok: false, error: `Geocode HTTP ${res.status}`, results: [] };
  }
  const json = await res.json();
  if (json.status !== "OK" && json.status !== "ZERO_RESULTS") {
    return { ok: false, error: `Geocode status ${json.status}`, results: [] };
  }
  const results = (json.results || []).slice(0, 5).map((r) => ({
    label: r.formatted_address,
    place_id: r.place_id,
    lat: r.geometry?.location?.lat,
    lng: r.geometry?.location?.lng,
  }));
  return { ok: true, results, ambiguous: results.length > 1 };
}

/**
 * Compute Route Matrix (v2) between origin and destinations.
 * Returns minutes per destination index; null when unavailable.
 */
export async function routeMatrix(origin, destinations, apiKey, departureTime) {
  if (!apiKey) {
    return {
      ok: false,
      error: "GOOGLE_MAPS_API_KEY is not configured",
      durations_minutes: destinations.map(() => null),
    };
  }
  if (!origin || origin.lat == null || origin.lng == null) {
    return { ok: false, error: "Origin coordinates required", durations_minutes: destinations.map(() => null) };
  }
  const body = {
    origins: [{ waypoint: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } } }],
    destinations: destinations.map((d) => ({
      waypoint: { location: { latLng: { latitude: d.lat, longitude: d.lng } } },
    })),
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE",
  };
  if (departureTime) {
    body.departureTime = new Date(departureTime).toISOString();
  }
  const res = await fetch("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "originIndex,destinationIndex,duration,condition,status",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    return {
      ok: false,
      error: `Routes API HTTP ${res.status}: ${errText.slice(0, 200)}`,
      durations_minutes: destinations.map(() => null),
    };
  }
  const rows = await res.json();
  const durations = destinations.map(() => null);
  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    const di = row.destinationIndex;
    if (di == null) continue;
    if (row.duration) {
      const sec = Number(String(row.duration).replace(/s$/, ""));
      if (!Number.isNaN(sec)) durations[di] = Math.round(sec / 60);
    }
  }
  return { ok: true, durations_minutes: durations, raw_count: list.length };
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
