import { describe, expect, it } from "vitest";
import {
  bookingPhones,
  denverDate,
  denverTime,
  last4,
  meetingDescription,
  prettyPhone,
  smsText,
} from "../../supabase/functions/_shared/schedule/format.ts";
import { buildCalendar, foldLine, icsEscape } from "../../supabase/functions/_shared/schedule/ics.ts";
import { sendSms, twilioConfigFromEnv } from "../../supabase/functions/_shared/schedule/twilio.ts";
import {
  eventBody,
  eventId,
  gcalConfigFromEnv,
  signedJwt,
  syncBooking,
} from "../../supabase/functions/_shared/schedule/gcal.ts";

// Tue Oct 27 2026 3:20 PM MDT
const booking = {
  id: "0f8fad5b-d9cb-469f-a165-70867728950e",
  status: "confirmed",
  starts_at: "2026-10-27T21:20:00Z",
  duration_minutes: 20,
  player_name: "Kali-Shea",
  parent_email: "parent@example.com",
  phone_1: "+18015550123",
  phone_2: "+13855550199",
  booked_at: "2026-10-07T15:42:00Z",
  updated_at: "2026-10-07T15:42:00Z",
  calendar_uid: "abc@bhs-shot-tracker",
  ics_sequence: 2,
};

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", body: init.body, headers: init.headers });
    const next = responses.shift();
    return new Response(JSON.stringify(next.body || {}), { status: next.status || 200 });
  };
  fn.calls = calls;
  return fn;
}

describe("schedule format", () => {
  it("formats Denver date/time across DST", () => {
    expect(denverDate(booking.starts_at)).toBe("Tuesday, October 27");
    expect(denverTime(booking.starts_at)).toBe("3:20 PM");
    // After DST ends (MST, UTC-7).
    expect(denverTime("2026-11-03T22:00:00Z")).toBe("3:00 PM");
  });

  it("builds the three SMS messages", () => {
    expect(smsText("confirmation", booking)).toBe(
      "Brighton Soccer: Kali-Shea's postseason meeting is scheduled for Tuesday, October 27 at 3:20 PM."
    );
    expect(smsText("update", booking)).toMatch(/has moved to Tuesday, October 27 at 3:20 PM\.$/);
    expect(smsText("reminder", booking)).toBe(
      "Reminder: Kali-Shea's Brighton Soccer postseason meeting starts at 3:20 PM today."
    );
  });

  it("handles phones", () => {
    expect(prettyPhone("+18015550123")).toBe("(801) 555-0123");
    expect(last4("+18015550123")).toBe("0123");
    expect(bookingPhones({ phone_1: "+18015550123", phone_2: "+18015550123" })).toEqual(["+18015550123"]);
    expect(bookingPhones({ phone_1: null, phone_2: "801" })).toEqual([]);
  });

  it("puts contact info in the event description", () => {
    const d = meetingDescription(booking);
    expect(d).toContain("Parent email: parent@example.com");
    expect(d).toContain("Mobile 1: (801) 555-0123");
    expect(d).toContain("Mobile 2: (385) 555-0199");
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
    expect(unfolded).toContain("DESCRIPTION:Player: Kali-Shea\\nParent email: parent@example.com");
    expect(unfolded).not.toContain("gone@x");
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });
});

describe("schedule twilio", () => {
  const env = { TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok", TWILIO_FROM_NUMBER: "+18015550000" };

  it("needs sid, token, and a sender", () => {
    expect(twilioConfigFromEnv((k) => ({ ...env, TWILIO_FROM_NUMBER: "" })[k])).toBeNull();
    expect(twilioConfigFromEnv((k) => env[k])).toMatchObject({ from: "+18015550000" });
  });

  it("posts form data and redacts numbers from errors", async () => {
    const cfg = twilioConfigFromEnv((k) => env[k]);
    const ok = fakeFetch([{ body: { sid: "SM1" } }]);
    expect(await sendSms(cfg, "+18015550123", "hi", ok)).toEqual({ ok: true, sid: "SM1" });
    expect(ok.calls[0].url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json");
    expect(String(ok.calls[0].body)).toBe("To=%2B18015550123&Body=hi&From=%2B18015550000");
    expect(ok.calls[0].headers.Authorization).toBe(`Basic ${btoa("AC1:tok")}`);

    const bad = fakeFetch([{ status: 400, body: { code: 21211, message: "Invalid 'To' +18015550123" } }]);
    const res = await sendSms(cfg, "+18015550123", "hi", bad);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Twilio 21211: Invalid 'To' [number]");
  });
});

describe("schedule gcal", () => {
  it("derives a valid base32hex event id", () => {
    expect(eventId(booking.id)).toBe("0f8fad5bd9cb469fa16570867728950e");
    expect(eventId(booking.id)).toMatch(/^[a-v0-9]{5,1024}$/);
    const body = eventBody(booking);
    expect(body.start).toEqual({ dateTime: "2026-10-27T21:20:00.000Z", timeZone: "America/Denver" });
    expect(body.end.dateTime).toBe("2026-10-27T21:40:00.000Z");
  });

  it("reads the service account from env", () => {
    const json = JSON.stringify({ client_email: "svc@p.iam.gserviceaccount.com", private_key: "k" });
    expect(gcalConfigFromEnv((k) => ({ GOOGLE_CALENDAR_ID: "cal", GOOGLE_SERVICE_ACCOUNT_JSON: json })[k])).toEqual({
      calendarId: "cal",
      clientEmail: "svc@p.iam.gserviceaccount.com",
      privateKey: "k",
    });
    expect(gcalConfigFromEnv(() => undefined)).toBeNull();
  });

  it("signs an RS256 JWT Google can verify", async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"]
    );
    const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der)).match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;
    const jwt = await signedJwt({ calendarId: "c", clientEmail: "svc@x", privateKey: pem }, 1000);
    const [h, c, s] = jwt.split(".");
    const dec = (v) => Uint8Array.from(atob(v.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(dec(c)));
    expect(claims).toMatchObject({ iss: "svc@x", aud: "https://oauth2.googleapis.com/token", iat: 1000, exp: 4600 });
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pair.publicKey, dec(s), new TextEncoder().encode(`${h}.${c}`));
    expect(valid).toBe(true);
  });

  const cfg = { calendarId: "team@group.calendar.google.com", clientEmail: "x", privateKey: "x" };
  const base = "https://www.googleapis.com/calendar/v3/calendars/team%40group.calendar.google.com/events";

  it("updates in place, falls back to insert on 404", async () => {
    const f = fakeFetch([{ status: 404 }, { status: 200 }]);
    expect(await syncBooking(cfg, "t", booking, f)).toBe("created");
    expect(f.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `PUT ${base}/0f8fad5bd9cb469fa16570867728950e?sendUpdates=none`,
      `POST ${base}?sendUpdates=none`,
    ]);
    const f2 = fakeFetch([{ status: 200 }]);
    expect(await syncBooking(cfg, "t", booking, f2)).toBe("updated");
  });

  it("deletes cancelled bookings and tolerates already-gone events", async () => {
    const f = fakeFetch([{ status: 410 }]);
    expect(await syncBooking(cfg, "t", { ...booking, status: "cancelled" }, f)).toBe("deleted");
    expect(f.calls[0].method).toBe("DELETE");
  });

  it("surfaces Google errors", async () => {
    const f = fakeFetch([{ status: 403, body: { error: { message: "Forbidden" } } }]);
    await expect(syncBooking(cfg, "t", booking, f)).rejects.toThrow("Google 403: Forbidden");
  });
});
