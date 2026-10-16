/**
 * HTML schedule adapters. Unsupported pages return { unsupported: true }.
 * Never claims success for unparsed HTML.
 */

function stripTags(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTables(html) {
  const tables = [];
  const re = /<table\b[\s\S]*?<\/table>/gi;
  let m;
  while ((m = re.exec(html))) tables.push(m[0]);
  return tables;
}

function tableToRows(tableHtml) {
  const rows = [];
  const trRe = /<tr\b[\s\S]*?<\/tr>/gi;
  let tr;
  while ((tr = trRe.exec(tableHtml))) {
    const cells = [];
    const cellRe = /<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi;
    let c;
    while ((c = cellRe.exec(tr[0]))) cells.push(stripTags(c[1]));
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/** generic_table: expects columns Date/Time, Home, Away, Location (flexible header match). */
export function parseGenericTable(html, parserConfig = {}) {
  const tables = extractTables(html);
  if (!tables.length) {
    return { events: [], errors: ["No HTML tables found"], unsupported: true };
  }
  const events = [];
  const errors = [];
  for (const table of tables) {
    const rows = tableToRows(table);
    if (rows.length < 2) continue;
    const header = rows[0].map((h) => h.toLowerCase());
    const find = (...names) => {
      for (const n of names) {
        const i = header.findIndex((h) => h.includes(n));
        if (i >= 0) return i;
      }
      return -1;
    };
    const iDate = find("date", "kickoff", "time");
    const iHome = find("home");
    const iAway = find("away", "opponent");
    const iLoc = find("location", "venue", "field", "facility");
    if (iHome < 0 || iAway < 0) continue;
    for (const r of rows.slice(1)) {
      const kickRaw = iDate >= 0 ? r[iDate] : "";
      let kickoff_at = null;
      if (kickRaw) {
        const d = new Date(kickRaw);
        if (!Number.isNaN(d.getTime())) kickoff_at = d.toISOString();
      }
      events.push({
        external_id: null,
        raw_home_label: r[iHome] || null,
        raw_away_label: r[iAway] || null,
        kickoff_at,
        venue_label: iLoc >= 0 ? r[iLoc] : null,
        status: "scheduled",
        parse_confidence: 0.5,
      });
    }
  }
  if (!events.length) {
    return {
      events: [],
      errors: ["HTML tables present but no recognizable home/away columns"],
      unsupported: true,
    };
  }
  return { events, errors, unsupported: false };
}

export function parseHtmlSchedule(html, parserConfig = {}) {
  const adapter = String(parserConfig.adapter || "generic_table").toLowerCase();
  if (adapter === "generic_table") return parseGenericTable(html, parserConfig);
  return {
    events: [],
    errors: [`Unknown HTML adapter "${adapter}". Add a parser adapter or use ICS/CSV/manual.`],
    unsupported: true,
  };
}
