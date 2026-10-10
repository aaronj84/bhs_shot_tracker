import { describe, expect, it } from "vitest";
import { denverStamp, meetingDescription } from "../../supabase/functions/_shared/schedule/format.ts";
import { alertMinutes, buildCalendar, foldLine, icsEscape } from "../../supabase/functions/_shared/schedule/ics.ts";

// Tue Oct 27 2026 3:20 PM MDT
const booking = {
  id: "0f8fad5b-d9cb-469f-a165-70867728950e",
  status: "confirmed",
  starts_at: "2026-10-27T21:20:00Z",
  duration_minutes: 20,
  player_name: "Kali-Shea",
  booked_at: "2026-10-07T15:42:00Z",
  updated_at: "2026-10-07T15:42:00Z",
  calendar_uid: "abc@bhs-shot-tracker",
  ics_sequence: 2,
};

describe("schedule format", () => {
  it("formats Denver stamps across DST", () => {
    expect(denverStamp(booking.starts_at)).toBe("Oct 27, 3:20 PM MDT");
    // After DST ends (MST, UTC-7).
    expect(denverStamp("2026-11-03T22:00:00Z")).toBe("Nov 3, 3:00 PM MST");
  });

  it("describes the meeting with any mobile numbers", () => {
    expect(meetingDescription(booking)).toBe(
      "Player: Kali-Shea\nBooked: Oct 7, 9:42 AM MDT\nBrighton Blue '26 postseason player/parent meeting."
    );
    expect(meetingDescription({ ...booking, phone_1: "+18015550123", phone_2: "+13855550199" })).toContain(
      "Player: Kali-Shea\nMobile 1: (801) 555-0123\nMobile 2: (385) 555-0199\nBooked:"
    );
  });
});

describe("schedule ics", () => {
  it("escapes and folds per RFC 5545", () => {
    expect(icsEscape("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
    const long = `SUMMARY:${"é".repeat(60)}`;
    const folded = foldLine(long);
    for (const line of folded.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    expect(folded.replace(/\r\n /g, "")).toBe(long);
  });

  it("emits a stable UID, sequence, and UTC times; drops cancelled", () => {
    const ics = buildCalendar(
      [booking, { ...booking, id: "x", calendar_uid: "gone@x", status: "cancelled" }],
      new Date("2026-10-07T16:00:00Z")
    );
    const unfolded = ics.replace(/\r\n /g, "");
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(unfolded).toContain("UID:abc@bhs-shot-tracker\r\n");
    expect(unfolded).toContain("SEQUENCE:2\r\n");
    expect(unfolded).toContain("DTSTART:20261027T212000Z\r\n");
    expect(unfolded).toContain("DTEND:20261027T214000Z\r\n");
    expect(unfolded).toContain("SUMMARY:Postseason Meeting – Kali-Shea\r\n");
    expect(unfolded).toContain("LOCATION:Shed @ Game Field\r\n");
    expect(unfolded).toContain("DESCRIPTION:Player: Kali-Shea\\nBooked:");
    expect(unfolded).not.toContain("gone@x");
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });
});

describe("schedule alerts", () => {
  const at = (id, iso, minutes = 20) => ({ ...booking, id, calendar_uid: `${id}@x`, starts_at: iso, duration_minutes: minutes });
  // Oct 27 (MDT): 3:00, 3:20, 3:40, then 5:00 after a 1h break; 4:30 PM Oct 28; 6:00 PM Oct 28 Denver = 00:00Z Oct 29.
  const day = [
    at("a", "2026-10-27T21:00:00Z"),
    at("b", "2026-10-27T21:20:00Z"),
    at("c", "2026-10-27T21:40:00Z"),
    at("d", "2026-10-27T23:00:00Z"),
    at("e", "2026-10-28T22:30:00Z"),
    at("f", "2026-10-29T00:00:00Z"),
  ];

  it("warns early for each day's first meeting and after long breaks", () => {
    const m = alertMinutes([...day].reverse());
    expect(Object.fromEntries(m)).toEqual({
      a: [60, 15],
      b: [5],
      c: [5],
      d: [30, 5],
      e: [60, 15],
      f: [30, 5],
    });
  });

  it("treats a 59-minute break as back-to-back and skips cancelled meetings", () => {
    const m = alertMinutes([
      at("a", "2026-10-27T21:00:00Z"),
      { ...at("x", "2026-10-27T21:20:00Z"), status: "cancelled" },
      at("b", "2026-10-27T22:19:00Z"),
    ]);
    expect(m.get("b")).toEqual([5]);
    expect(m.has("x")).toBe(false);
  });

  it("writes the alerts into the feed", () => {
    const ics = buildCalendar(day.slice(0, 2), new Date("2026-10-07T16:00:00Z"));
    const events = ics.split("BEGIN:VEVENT").slice(1);
    expect(events[0].match(/TRIGGER:[^\r]+/g)).toEqual(["TRIGGER:-PT60M", "TRIGGER:-PT15M"]);
    expect(events[1].match(/TRIGGER:[^\r]+/g)).toEqual(["TRIGGER:-PT5M"]);
    expect(events[0]).toContain("BEGIN:VALARM\r\nACTION:DISPLAY\r\n");
  });
});
