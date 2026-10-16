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

export function parseRelativeDateWindow(text, timeZone = CLUB_TZ, now = new Date()) {
  const q = String(text || "").toLowerCase();
  const today = localDateInTz(timeZone, now);
  if (!q || /\bnext\s+7\s+days\b|\bthis\s+week\b|\bupcoming\b/.test(q)) {
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
