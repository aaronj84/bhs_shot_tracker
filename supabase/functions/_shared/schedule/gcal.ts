/**
 * Push bookings to a shared Google Calendar with a service account.
 *
 * Event IDs are derived from the booking UUID (hex is valid base32hex), so a
 * retry after a lost response updates the same event instead of duplicating it.
 */
import { type Booking, endsAt, meetingDescription, meetingTitle, TZ } from "./format.ts";

export type GcalConfig = { calendarId: string; clientEmail: string; privateKey: string };

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export function gcalConfigFromEnv(get: (k: string) => string | undefined): GcalConfig | null {
  const calendarId = get("GOOGLE_CALENDAR_ID") || "";
  const raw = get("GOOGLE_SERVICE_ACCOUNT_JSON") || "";
  if (!calendarId || !raw) return null;
  try {
    const sa = JSON.parse(raw);
    if (!sa.client_email || !sa.private_key) return null;
    return { calendarId, clientEmail: sa.client_email, privateKey: sa.private_key };
  } catch {
    return null;
  }
}

export function eventId(bookingId: string): string {
  return bookingId.replace(/-/g, "").toLowerCase();
}

export function eventBody(b: Booking) {
  return {
    id: eventId(b.id),
    summary: meetingTitle(b),
    description: meetingDescription(b),
    start: { dateTime: new Date(b.starts_at).toISOString(), timeZone: TZ },
    end: { dateTime: endsAt(b), timeZone: TZ },
    status: "confirmed",
    transparency: "opaque",
    extendedProperties: { private: { bhsBookingId: b.id } },
  };
}

function b64url(bytes: Uint8Array | string): string {
  const bin = typeof bytes === "string" ? bytes : String.fromCharCode(...bytes);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\\n/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export async function signedJwt(cfg: GcalConfig, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({ iss: cfg.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 }),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(cfg.privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64url(new Uint8Array(sig))}`;
}

export async function accessToken(cfg: GcalConfig, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: await signedJwt(cfg),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Google auth failed: ${data.error_description || data.error || res.status}`);
  }
  return data.access_token;
}

async function googleError(res: Response): Promise<string> {
  const data = await res.json().catch(() => ({}));
  return `Google ${res.status}: ${data?.error?.message || res.statusText || "request failed"}`;
}

/** Create, update, or remove the booking's event. Throws with a short message on failure. */
export async function syncBooking(
  cfg: GcalConfig,
  token: string,
  b: Booking,
  fetchImpl: typeof fetch = fetch,
): Promise<"created" | "updated" | "deleted"> {
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cfg.calendarId)}/events`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const id = eventId(b.id);

  if (b.status !== "confirmed") {
    const res = await fetchImpl(`${base}/${id}?sendUpdates=none`, { method: "DELETE", headers });
    if (res.ok || res.status === 404 || res.status === 410) return "deleted";
    throw new Error(await googleError(res));
  }

  const body = JSON.stringify(eventBody(b));
  const put = await fetchImpl(`${base}/${id}?sendUpdates=none`, { method: "PUT", headers, body });
  if (put.ok) return "updated";
  if (put.status !== 404) throw new Error(await googleError(put));

  const post = await fetchImpl(`${base}?sendUpdates=none`, { method: "POST", headers, body });
  if (post.ok) return "created";
  if (post.status === 409) {
    const retry = await fetchImpl(`${base}/${id}?sendUpdates=none`, { method: "PUT", headers, body });
    if (retry.ok) return "updated";
    throw new Error(await googleError(retry));
  }
  throw new Error(await googleError(post));
}
