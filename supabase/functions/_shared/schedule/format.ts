/** Postseason meeting text + time formatting. All times shown in America/Denver. */

export const TZ = "America/Denver";

export type Booking = {
  id: string;
  status: "confirmed" | "cancelled";
  starts_at: string;
  duration_minutes: number;
  player_name: string;
  parent_email: string;
  phone_1: string | null;
  phone_2: string | null;
  booked_at: string;
  updated_at?: string;
  calendar_uid?: string;
  ics_sequence?: number;
};

export type NoticeKind = "confirmation" | "update" | "reminder";

export function denverDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(iso));
}

export function denverTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function denverStamp(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

export function endsAt(b: Pick<Booking, "starts_at" | "duration_minutes">): string {
  return new Date(new Date(b.starts_at).getTime() + b.duration_minutes * 60000).toISOString();
}

export function smsText(kind: NoticeKind, b: Pick<Booking, "player_name" | "starts_at">): string {
  const name = b.player_name;
  const date = denverDate(b.starts_at);
  const time = denverTime(b.starts_at);
  if (kind === "reminder") {
    return `Reminder: ${name}'s Brighton Soccer postseason meeting starts at ${time} today.`;
  }
  if (kind === "update") {
    return `Brighton Soccer: ${name}'s postseason meeting has moved to ${date} at ${time}.`;
  }
  return `Brighton Soccer: ${name}'s postseason meeting is scheduled for ${date} at ${time}.`;
}

/** E.164 US number → (801) 555-0123. Anything else passes through. */
export function prettyPhone(e164: string | null | undefined): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(String(e164 || ""));
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : String(e164 || "");
}

export function last4(phone: string | null | undefined): string {
  return String(phone || "").replace(/\D/g, "").slice(-4);
}

export function bookingPhones(b: Pick<Booking, "phone_1" | "phone_2">): string[] {
  const out: string[] = [];
  for (const p of [b.phone_1, b.phone_2]) {
    if (p && /^\+1\d{10}$/.test(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

export function meetingTitle(b: Pick<Booking, "player_name">): string {
  return `Postseason Meeting – ${b.player_name}`;
}

export function meetingDescription(b: Booking): string {
  const lines = [`Player: ${b.player_name}`, `Parent email: ${b.parent_email}`];
  if (b.phone_1) lines.push(`Mobile 1: ${prettyPhone(b.phone_1)}`);
  if (b.phone_2) lines.push(`Mobile 2: ${prettyPhone(b.phone_2)}`);
  lines.push(`Booked: ${denverStamp(b.booked_at)}`);
  lines.push("Brighton Soccer postseason player/parent meeting.");
  return lines.join("\n");
}
