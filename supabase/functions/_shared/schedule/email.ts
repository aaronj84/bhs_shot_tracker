/**
 * Parent email hook. The worker calls this for every confirmation/update notice.
 * There is no email provider yet; wire one here (e.g. a fetch to Resend/Postmark
 * using an API key from Deno.env) and return "sent"/"failed".
 */
import type { Booking, NoticeKind } from "./format.ts";

export type EmailResult = { status: "sent" | "failed" | "skipped"; error?: string };

export function sendBookingEmail(_booking: Booking, _kind: NoticeKind): Promise<EmailResult> {
  return Promise.resolve({ status: "skipped" });
}
