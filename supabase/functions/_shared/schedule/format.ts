/** Postseason meeting calendar text + time formatting. All times shown in America/Denver. */

export const TZ = "America/Denver";
export const MEETING_LOCATION = "Shed @ Game Field";

export type Booking = {
  id: string;
  status: "confirmed" | "cancelled";
  starts_at: string;
  duration_minutes: number;
  player_name: string;
  phone_1?: string | null;
  phone_2?: string | null;
  booked_at: string;
  updated_at?: string;
  calendar_uid?: string;
  ics_sequence?: number;
};

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

export function meetingTitle(b: Pick<Booking, "player_name">): string {
  return `Postseason Meeting – ${b.player_name}`;
}

/** E.164 US number → (801) 555-0123. Anything else passes through. */
export function prettyPhone(e164: string | null | undefined): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(String(e164 || ""));
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : String(e164 || "");
}

export function meetingDescription(b: Booking): string {
  const lines = [`Player: ${b.player_name}`];
  if (b.phone_1) lines.push(`Mobile 1: ${prettyPhone(b.phone_1)}`);
  if (b.phone_2) lines.push(`Mobile 2: ${prettyPhone(b.phone_2)}`);
  lines.push(`Booked: ${denverStamp(b.booked_at)}`);
  lines.push("Brighton Blue '26 postseason player/parent meeting.");
  return lines.join("\n");
}
