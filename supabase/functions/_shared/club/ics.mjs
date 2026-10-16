/**
 * Minimal ICS/iCalendar event parser for public club schedules.
 */

function unfold(text) {
  return String(text || "").replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
}

function icsUnescape(v) {
  return String(v || "")
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

/** Parse DTSTART / DTEND values (UTC Z, floating, or TZID). */
export function parseIcsDate(raw, tzid) {
  const v = String(raw || "").trim();
  if (!v) return null;
  // DATE only
  if (/^\d{8}$/.test(v)) {
    const y = v.slice(0, 4);
    const m = v.slice(4, 6);
    const d = v.slice(6, 8);
    return { iso: null, dateOnly: `${y}-${m}-${d}`, timezone: tzid || null };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  const [, Y, Mo, D, h, mi, s, z] = m;
  if (z) {
    return {
      iso: new Date(`${Y}-${Mo}-${D}T${h}:${mi}:${s}Z`).toISOString(),
      dateOnly: null,
      timezone: "UTC",
    };
  }
  // Floating / TZID — interpret as local civil time in tzid or America/Denver
  const zone = tzid || "America/Denver";
  // Encode as ISO without Z and let callers treat timezone separately; store as offset via hack:
  // Use Date parsing with explicit offset unknown → keep as `${Y}-${Mo}-${D}T${h}:${mi}:${s}` and
  // convert using a fixed approach: append 'Z' after adjusting is wrong. Prefer Temporal-free:
  // treat as Denver offset approx via Intl — see toUtcFromLocal.
  const local = `${Y}-${Mo}-${D}T${h}:${mi}:${s}`;
  return { iso: localCivilToUtcIso(local, zone), dateOnly: null, timezone: zone, local };
}

export function localCivilToUtcIso(local, timeZone) {
  // local: YYYY-MM-DDTHH:mm:ss
  const [date, time] = local.split("T");
  const [Y, Mo, D] = date.split("-").map(Number);
  const [h, mi, s] = time.split(":").map(Number);
  // Search UTC instant whose Denver parts match
  const guess = Date.UTC(Y, Mo - 1, D, h + 6, mi, s || 0); // MDT-ish
  for (let delta = -10 * 3600000; delta <= 10 * 3600000; delta += 15 * 60000) {
    const cand = new Date(guess + delta);
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(cand).map((p) => [p.type, p.value]));
    const hour = parts.hour === "24" ? "00" : parts.hour;
    if (
      parts.year === String(Y) &&
      parts.month === String(Mo).padStart(2, "0") &&
      parts.day === String(D).padStart(2, "0") &&
      hour === String(h).padStart(2, "0") &&
      parts.minute === String(mi).padStart(2, "0")
    ) {
      return cand.toISOString();
    }
  }
  return new Date(guess).toISOString();
}

function parseStatus(s) {
  const u = String(s || "").toUpperCase();
  if (u === "CANCELLED") return "cancelled";
  if (u === "CONFIRMED") return "scheduled";
  if (u === "TENTATIVE") return "tbd";
  return "scheduled";
}

/**
 * @returns {{ events: object[], errors: string[] }}
 */
export function parseIcs(text) {
  const errors = [];
  const src = unfold(text);
  const blocks = src.split(/BEGIN:VEVENT/i).slice(1);
  const events = [];
  for (const block of blocks) {
    const body = block.split(/END:VEVENT/i)[0] || "";
    const fields = {};
    const params = {};
    for (const line of body.split(/\r?\n/)) {
      if (!line || /^\s/.test(line)) continue;
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const left = line.slice(0, idx);
      const value = icsUnescape(line.slice(idx + 1));
      const [name, ...paramParts] = left.split(";");
      const key = name.toUpperCase();
      fields[key] = value;
      const p = {};
      for (const pp of paramParts) {
        const [pk, pv] = pp.split("=");
        if (pk) p[pk.toUpperCase()] = pv;
      }
      params[key] = p;
    }
    const tzid = params.DTSTART?.TZID || params.DTEND?.TZID || null;
    const start = parseIcsDate(fields.DTSTART, tzid);
    const end = fields.DTEND ? parseIcsDate(fields.DTEND, tzid) : null;
    const uid = fields.UID || null;
    const summary = fields.SUMMARY || "";
    const location = fields.LOCATION || "";
    const description = fields.DESCRIPTION || "";
    // Heuristic: "Home vs Away" or "A @ B"
    let home = null;
    let away = null;
    const vs = summary.match(/(.+?)\s+vs\.?\s+(.+)/i);
    const at = summary.match(/(.+?)\s+@\s+(.+)/i);
    if (vs) {
      home = vs[1].trim();
      away = vs[2].trim();
    } else if (at) {
      away = at[1].trim();
      home = at[2].trim();
    }
    events.push({
      external_id: uid,
      summary,
      location,
      description,
      kickoff_at: start?.iso || null,
      kickoff_date_only: start?.dateOnly || null,
      kickoff_timezone: start?.timezone || tzid || "America/Denver",
      ends_at: end?.iso || null,
      status: parseStatus(fields.STATUS),
      raw_home_label: home,
      raw_away_label: away,
      parse_confidence: home && away ? 0.7 : 0.4,
    });
  }
  if (!events.length && !/BEGIN:VCALENDAR/i.test(src)) {
    errors.push("Not a valid iCalendar document");
  }
  return { events, errors };
}
