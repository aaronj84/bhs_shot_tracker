/** Minimal Twilio Messages API client (no SDK). */

export type TwilioConfig = {
  accountSid: string;
  authToken: string;
  from: string;
  messagingServiceSid: string;
};

export type SmsResult = { ok: true; sid: string } | { ok: false; error: string };

export function twilioConfigFromEnv(get: (k: string) => string | undefined): TwilioConfig | null {
  const accountSid = get("TWILIO_ACCOUNT_SID") || "";
  const authToken = get("TWILIO_AUTH_TOKEN") || "";
  const from = get("TWILIO_FROM_NUMBER") || "";
  const messagingServiceSid = get("TWILIO_MESSAGING_SERVICE_SID") || "";
  if (!accountSid || !authToken || (!from && !messagingServiceSid)) return null;
  return { accountSid, authToken, from, messagingServiceSid };
}

export async function sendSms(
  cfg: TwilioConfig,
  to: string,
  body: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SmsResult> {
  const form = new URLSearchParams({ To: to, Body: body });
  if (cfg.messagingServiceSid) form.set("MessagingServiceSid", cfg.messagingServiceSid);
  else form.set("From", cfg.from);
  try {
    const res = await fetchImpl(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${cfg.accountSid}:${cfg.authToken}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
      },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Twilio error messages can echo the To number; keep code + generic text.
      const code = data?.code ? `Twilio ${data.code}` : `HTTP ${res.status}`;
      return { ok: false, error: `${code}: ${String(data?.message || "send failed").replace(/\+?\d{10,}/g, "[number]")}` };
    }
    return { ok: true, sid: String(data.sid || "") };
  } catch (err) {
    return { ok: false, error: `Network: ${(err as Error).message || "send failed"}` };
  }
}
