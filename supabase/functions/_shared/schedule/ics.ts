/**
 * RFC 5545 feed for the coaching staff's subscribed calendars.
 * Times are emitted in UTC (no VTIMEZONE needed); clients display local time.
 * Cancelled bookings are omitted: subscribed feeds are replaced wholesale on
 * refresh, so a missing UID is how clients learn the event is gone.
 */
import { type Booking, endsAt, MEETING_LOCATION, meetingDescription, meetingTitle, TZ } from "./format.ts";

export const CALENDAR_NAME = "Brighton Postseason Meetings";

/** A break this long between same-day meetings counts as starting over. */
export const LARGE_GAP_MINUTES = 60;

const denverDay = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/**
 * Minutes-before alerts per booking id. First meeting of a Denver day: 60 + 15.
 * After a gap of LARGE_GAP_MINUTES or more: 30 + 5. Back-to-back: 5.
 */
export function alertMinutes(bookings: Booking[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const sorted = bookings.filter((b) => b.status === "confirmed").sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  let prev: Booking | null = null;
  for (const b of sorted) {
    const sameDay = prev && denverDay.format(new Date(prev.starts_at)) === denverDay.format(new Date(b.starts_at));
    if (!prev || !sameDay) {
      out.set(b.id, [60, 15]);
    } else {
      const gap = (new Date(b.starts_at).getTime() - new Date(endsAt(prev)).getTime()) / 60000;
      out.set(b.id, gap >= LARGE_GAP_MINUTES ? [30, 5] : [5]);
    }
    prev = b;
  }
  return out;
}

function alarmLines(minutes: number[], title: string): string[] {
  return minutes.flatMap((m) => [
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `TRIGGER:-PT${m}M`,
    `DESCRIPTION:${icsEscape(title)}`,
    "END:VALARM",
  ]);
}

export function icsDate(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function icsEscape(text: string): string {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

/** Fold to 75 octets per line (continuations start with a space). */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let cur = "";
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (curBytes + n > limit) {
      parts.push(cur);
      cur = "";
      curBytes = 0;
      limit = 74;
    }
    cur += ch;
    curBytes += n;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

export function buildCalendar(bookings: Booking[], now: Date = new Date()): string {
  const stamp = icsDate(now.toISOString());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Brighton Soccer//Postseason Meetings//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(CALENDAR_NAME)}`,
    "X-WR-TIMEZONE:America/Denver",
    "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
    "X-PUBLISHED-TTL:PT15M",
  ];
  const alerts = alertMinutes(bookings);
  for (const b of bookings) {
    if (b.status !== "confirmed") continue;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${b.calendar_uid || `${b.id}@bhs-shot-tracker`}`,
      `DTSTAMP:${stamp}`,
      `LAST-MODIFIED:${icsDate(b.updated_at || b.booked_at)}`,
      `SEQUENCE:${b.ics_sequence || 0}`,
      `DTSTART:${icsDate(b.starts_at)}`,
      `DTEND:${icsDate(endsAt(b))}`,
      `SUMMARY:${icsEscape(meetingTitle(b))}`,
      `DESCRIPTION:${icsEscape(meetingDescription(b))}`,
      `LOCATION:${icsEscape(MEETING_LOCATION)}`,
      "STATUS:CONFIRMED",
      "TRANSP:OPAQUE",
      ...alarmLines(alerts.get(b.id) || [], meetingTitle(b)),
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
