/** Lightweight CSV parse (quoted fields) → objects via header row or column map. */

export function parseCsvText(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;
  const src = String(text || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(cur);
      cur = "";
      continue;
    }
    if (ch === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
      continue;
    }
    if (ch === "\r") continue;
    cur += ch;
  }
  if (cur.length || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

/**
 * Map rows to events using parser_config.columns:
 * { home, away, kickoff, status, venue, field, external_id }
 */
export function csvToEvents(text, parserConfig = {}) {
  const rows = parseCsvText(text);
  if (!rows.length) return { events: [], errors: ["Empty CSV"] };
  const cols = parserConfig.columns || {};
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const dataRows = parserConfig.has_header === false ? rows : rows.slice(1);

  function idx(key, fallbacks) {
    if (cols[key] != null && typeof cols[key] === "number") return cols[key];
    if (cols[key]) {
      const i = header.indexOf(String(cols[key]).toLowerCase());
      if (i >= 0) return i;
    }
    for (const f of fallbacks) {
      const i = header.indexOf(f);
      if (i >= 0) return i;
    }
    return -1;
  }

  const iHome = idx("home", ["home", "home_team", "home team"]);
  const iAway = idx("away", ["away", "away_team", "away team"]);
  const iKick = idx("kickoff", ["kickoff", "kickoff_at", "start", "datetime", "date"]);
  const iStatus = idx("status", ["status"]);
  const iVenue = idx("venue", ["venue", "facility", "location"]);
  const iField = idx("field", ["field"]);
  const iExt = idx("external_id", ["id", "external_id", "uid"]);

  const events = [];
  const errors = [];
  dataRows.forEach((r, n) => {
    const home = iHome >= 0 ? r[iHome] : "";
    const away = iAway >= 0 ? r[iAway] : "";
    const kick = iKick >= 0 ? r[iKick] : "";
    let kickoff_at = null;
    if (kick) {
      const d = new Date(kick);
      if (!Number.isNaN(d.getTime())) kickoff_at = d.toISOString();
      else errors.push(`Row ${n + 2}: unparseable kickoff "${kick}"`);
    }
    events.push({
      external_id: iExt >= 0 ? r[iExt] : null,
      raw_home_label: home || null,
      raw_away_label: away || null,
      kickoff_at,
      status: (iStatus >= 0 ? String(r[iStatus] || "scheduled").toLowerCase() : "scheduled") || "scheduled",
      venue_label: iVenue >= 0 ? r[iVenue] : null,
      field_label: iField >= 0 ? r[iField] : null,
      parse_confidence: 0.85,
    });
  });
  return { events, errors };
}
