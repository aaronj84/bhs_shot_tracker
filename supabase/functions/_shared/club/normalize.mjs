/** Shared name / time helpers for club visitation (Node + Deno). */

export const CLUB_TZ = "America/Denver";

export function normalizeName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function namesMatch(a, b) {
  return normalizeName(a) === normalizeName(b);
}

/** Alias-aware team match: exact normalized name or alias list. */
export function teamMatchesRecord(label, team) {
  if (!team) return false;
  const n = normalizeName(label);
  if (!n) return false;
  if (normalizeName(team.normalized_name) === n) return true;
  if (normalizeName(team.team_name) === n) return true;
  const orgTeam = normalizeName(
    [team.organization_name, team.team_name].filter(Boolean).join(" ")
  );
  if (orgTeam === n) return true;
  const aliases = Array.isArray(team.aliases) ? team.aliases : [];
  return aliases.some((a) => normalizeName(a) === n);
}

export function denverParts(isoOrDate, timeZone = CLUB_TZ) {
  if (!isoOrDate) return null;
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return null;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    weekday: parts.weekday,
  };
}

export function formatLocalKickoff(iso, timeZone = CLUB_TZ) {
  if (!iso) return "TBD";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "TBD";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(d);
}

/** Inclusive local-date window helpers for “today”, “this weekend”, etc. */
export function localDateInTz(timeZone = CLUB_TZ, now = new Date()) {
  const parts = denverParts(now, timeZone);
  return parts?.date || now.toISOString().slice(0, 10);
}

export function addDaysIso(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function startOfLocalDayUtc(dateStr, timeZone = CLUB_TZ) {
  // Approximate: construct as noon UTC then adjust via formatter — for filters we use
  // timestamptz range with America/Denver civil midnight via offset guess.
  // Prefer explicit bounds: date at 00:00 Denver ≈ previous day 06:00–07:00 UTC.
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const parts = denverParts(probe, timeZone);
  // Difference between UTC noon label and local noon is unused; use Temporal-free approach:
  // binary-search hour offset for local midnight.
  for (let h = 0; h < 48; h++) {
    const candidate = new Date(Date.UTC(
      Number(dateStr.slice(0, 4)),
      Number(dateStr.slice(5, 7)) - 1,
      Number(dateStr.slice(8, 10)) - 1,
      h
    ));
    const p = denverParts(candidate, timeZone);
    if (p && p.date === dateStr && p.time === "00:00") return candidate.toISOString();
  }
  return `${dateStr}T06:00:00.000Z`;
}

export function endOfLocalDayUtc(dateStr, timeZone = CLUB_TZ) {
  const next = addDaysIso(dateStr, 1);
  return startOfLocalDayUtc(next, timeZone);
}

const MONTH_INDEX = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11,
  december: 12, dec: 12,
};

function calendarDay(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Parse one calendar day mention; returns YYYY-MM-DD or null. */
export function parseCalendarDayMention(text, timeZone = CLUB_TZ, now = new Date()) {
  const q = String(text || "").toLowerCase();
  const today = localDateInTz(timeZone, now);
  const year = Number(today.slice(0, 4));
  const iso = q.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const slash = q.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}))?\b/);
  if (slash) return calendarDay(Number(slash[3] || year), Number(slash[1]), Number(slash[2]));
  const named = q.match(
    /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(20\d{2}))?\b/
  );
  if (named) return calendarDay(Number(named[3] || year), MONTH_INDEX[named[1]], Number(named[2]));
  const ordinal = q.match(/\b(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/);
  if (ordinal) {
    const dayNum = Number(ordinal[1]);
    let y = year;
    let month = Number(today.slice(5, 7));
    const todayDay = Number(today.slice(8, 10));
    if (dayNum < todayDay) {
      month += 1;
      if (month > 12) {
        month = 1;
        y += 1;
      }
    }
    return calendarDay(y, month, dayNum);
  }
  return null;
}

/** Snap a YYYY-MM-DD into the current/next season year when the model drifts (e.g. 2024 vs 2026). */
export function snapDateYearToNow(dateStr, timeZone = CLUB_TZ, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ""))) return dateStr;
  const today = localDateInTz(timeZone, now);
  const yearNow = Number(today.slice(0, 4));
  const y = Number(dateStr.slice(0, 4));
  if (Math.abs(y - yearNow) <= 1) return dateStr;
  const snapped = `${yearNow}${dateStr.slice(4)}`;
  // If that day already passed by > ~2 months, prefer next year.
  if (snapped < addDaysIso(today, -60)) {
    return `${yearNow + 1}${dateStr.slice(4)}`;
  }
  return snapped;
}

/** A written calendar day in the question, ahead of weekday words like "saturday". */
export function explicitCalendarWindow(text, timeZone = CLUB_TZ, now = new Date()) {
  const day = parseCalendarDayMention(text, timeZone, now);
  if (!day) return null;
  return { date_from: day, date_to: day };
}

export function parseRelativeDateWindow(text, timeZone = CLUB_TZ, now = new Date()) {
  const q = String(text || "").toLowerCase();
  const today = localDateInTz(timeZone, now);

  // "through / until / til Oct 25" (optionally with "next week") → today..end, not a single day.
  const through = q.match(
    /\b(?:through|thru|until|til|till|by|ending(?:\s+on)?)\s+((?:january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*20\d{2})?|\d{1,2}\/\d{1,2}(?:\/20\d{2})?|20\d{2}-\d{2}-\d{2}|(?:the\s+)?\d{1,2}(?:st|nd|rd|th))\b/
  );
  if (through) {
    const end = parseCalendarDayMention(through[1], timeZone, now);
    if (end) {
      let start = today;
      if (/\bnext\s+(?:calendar\s+)?week\b/.test(q) || /\bover\s+the\s+next\b/.test(q)) {
        start = addDaysIso(today, 1);
      }
      if (start > end) return { date_from: end, date_to: end };
      return { date_from: start, date_to: end };
    }
  }

  if (/\bnext\s+(?:calendar\s+)?week\b|\bnext\s+7\s+days\b/.test(q)) {
    return { date_from: today, date_to: addDaysIso(today, 7) };
  }

  const explicit = explicitCalendarWindow(q, timeZone, now);
  if (explicit) return explicit;
  if (!q || /\bthis\s+week\b|\bupcoming\b/.test(q)) {
    return { date_from: today, date_to: addDaysIso(today, 7) };
  }
  if (/\btoday\b/.test(q)) return { date_from: today, date_to: today };
  if (/\btomorrow\b/.test(q)) {
    const t = addDaysIso(today, 1);
    return { date_from: t, date_to: t };
  }
  // Saturday / weekend relative to today (Denver weekday)
  const wd = denverParts(now, timeZone)?.weekday || "";
  const weekdayIndex = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const cur = weekdayIndex[wd] ?? 0;
  const daysUntilSaturday = cur === 6 ? 0 : (6 - cur + 7) % 7;
  if (/\bnext\s+saturday\b/.test(q)) {
    const sat = addDaysIso(today, daysUntilSaturday === 0 ? 7 : daysUntilSaturday);
    return { date_from: sat, date_to: sat };
  }
  if (/\bsaturday\b/.test(q)) {
    const sat = addDaysIso(today, daysUntilSaturday);
    return { date_from: sat, date_to: sat };
  }
  if (/\bnext\s+weekend\b/.test(q)) {
    const sat = addDaysIso(today, daysUntilSaturday === 0 || cur === 0 ? (cur === 0 ? 6 : 7) : daysUntilSaturday);
    return { date_from: sat, date_to: addDaysIso(sat, 1) };
  }
  if (/\bweekend\b/.test(q)) {
    // Sat–Sun of the coming/current weekend (if Sunday, treat as that weekend's Sunday only → prior Sat)
    if (cur === 0) {
      const sat = addDaysIso(today, -1);
      return { date_from: sat, date_to: today };
    }
    const sat = addDaysIso(today, daysUntilSaturday);
    return { date_from: sat, date_to: addDaysIso(sat, 1) };
  }
  return { date_from: today, date_to: addDaysIso(today, 7) };
}

export function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function mapsDirectionsUrl(lat, lng, label) {
  if (lat == null || lng == null) return null;
  const q = encodeURIComponent(label || `${lat},${lng}`);
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&destination_place_id=&travelmode=driving&q=${q}`;
}

export function osmDirectionsUrl(lat, lng) {
  if (lat == null || lng == null) return null;
  return `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=;${lat}%2C${lng}`;
}
