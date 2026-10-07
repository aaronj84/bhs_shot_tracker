/**
 * RFC 5545 feed for the coaching staff's subscribed calendars.
 * Times are emitted in UTC (no VTIMEZONE needed); clients display local time.
 * Cancelled bookings are omitted: subscribed feeds are replaced wholesale on
 * refresh, so a missing UID is how clients learn the event is gone.
 */
import { type Booking, endsAt, meetingDescription, meetingTitle } from "./format.ts";

export const CALENDAR_NAME = "Brighton Postseason Meetings";

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
      "STATUS:CONFIRMED",
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
