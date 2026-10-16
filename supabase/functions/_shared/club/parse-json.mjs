/** JSON schedule feeds: array of events or { events: [...] }. */

export function parseJsonSchedule(text, parserConfig = {}) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { events: [], errors: [`Invalid JSON: ${e.message}`] };
  }
  const map = parserConfig.field_map || {};
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.events)
      ? data.events
      : Array.isArray(data?.games)
        ? data.games
        : null;
  if (!list) {
    return { events: [], errors: ["JSON must be an array or {events|games:[]}"] };
  }
  const get = (row, key, fallbacks) => {
    const k = map[key];
    if (k && row[k] != null) return row[k];
    for (const f of fallbacks) {
      if (row[f] != null) return row[f];
    }
    return null;
  };
  const events = list.map((row) => {
    const kick = get(row, "kickoff", ["kickoff_at", "start", "startTime", "datetime"]);
    let kickoff_at = null;
    if (kick) {
      const d = new Date(kick);
      if (!Number.isNaN(d.getTime())) kickoff_at = d.toISOString();
    }
    return {
      external_id: get(row, "external_id", ["id", "uid", "externalId"]),
      raw_home_label: get(row, "home", ["home", "home_team", "homeTeam"]),
      raw_away_label: get(row, "away", ["away", "away_team", "awayTeam"]),
      kickoff_at,
      status: String(get(row, "status", ["status"]) || "scheduled").toLowerCase(),
      venue_label: get(row, "venue", ["venue", "facility", "location"]),
      field_label: get(row, "field", ["field"]),
      parse_confidence: 0.9,
    };
  });
  return { events, errors: [] };
}
