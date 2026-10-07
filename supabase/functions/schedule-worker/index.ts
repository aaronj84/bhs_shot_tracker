/**
 * schedule-worker — sends postseason meeting texts and syncs Google Calendar.
 *
 * Invoked every minute by pg_cron (schedule_kick_worker, only when work is due)
 * and poked by the booking page right after a booking. Safe to call any time:
 * schedule_worker_claim() atomically marks rows before anything is sent, so
 * overlapping runs never double-text. SMS failures are logged to
 * meeting_sms_log and never touch the booking itself.
 *
 * Secrets (optional — missing ones are skipped, not fatal):
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
 *   TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID
 *   GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_CALENDAR_ID
 * Auto: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { type Booking, bookingPhones, last4, type NoticeKind, smsText } from "../_shared/schedule/format.ts";
import { sendSms, twilioConfigFromEnv } from "../_shared/schedule/twilio.ts";
import { accessToken, gcalConfigFromEnv, syncBooking } from "../_shared/schedule/gcal.ts";
import { sendBookingEmail } from "../_shared/schedule/email.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Notice = Booking & { kind: NoticeKind };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const env = (k: string) => Deno.env.get(k);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const sb = createClient(env("SUPABASE_URL") || "", env("SUPABASE_SERVICE_ROLE_KEY") || "", {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const twilio = twilioConfigFromEnv(env);
  const gcal = gcalConfigFromEnv(env);

  const { data, error } = await sb.rpc("schedule_worker_claim", { p_include_gcal: !!gcal });
  if (error) {
    console.error("schedule-worker: claim failed", error.message);
    return jsonResponse({ error: "claim failed" }, 500);
  }

  const notices: Notice[] = [...(data?.notices || []), ...(data?.reminders || [])];
  const smsLog: Record<string, unknown>[] = [];
  let smsSent = 0;
  let smsFailed = 0;

  for (const n of notices) {
    if (n.kind !== "reminder") {
      try {
        await sendBookingEmail(n, n.kind);
      } catch (err) {
        console.error(`schedule-worker: email ${n.kind} failed for booking ${n.id}`, (err as Error).message);
      }
    }
    for (const phone of bookingPhones(n)) {
      const base = { booking_id: n.id, kind: n.kind, to_last4: last4(phone) };
      if (!twilio) {
        smsLog.push({ ...base, status: "skipped", error: "Twilio not configured" });
        continue;
      }
      const res = await sendSms(twilio, phone, smsText(n.kind, n));
      if (res.ok) {
        smsSent += 1;
        smsLog.push({ ...base, status: "sent", provider_id: res.sid });
      } else {
        smsFailed += 1;
        smsLog.push({ ...base, status: "failed", error: res.error });
        console.error(`schedule-worker: sms ${n.kind} failed for booking ${n.id} (…${base.to_last4}): ${res.error}`);
      }
    }
  }
  if (smsLog.length) {
    const { error: logErr } = await sb.from("meeting_sms_log").insert(smsLog);
    if (logErr) console.error("schedule-worker: sms log insert failed", logErr.message);
  }

  let gcalSynced = 0;
  let gcalFailed = 0;
  const gcalRows: Booking[] = data?.gcal || [];
  if (gcal && gcalRows.length) {
    let token = "";
    let authError = "";
    try {
      token = await accessToken(gcal);
    } catch (err) {
      authError = (err as Error).message;
      console.error("schedule-worker:", authError);
    }
    for (const b of gcalRows) {
      try {
        if (authError) throw new Error(authError);
        await syncBooking(gcal, token, b);
        gcalSynced += 1;
        await sb
          .from("meeting_bookings")
          .update({ gcal_synced_at: new Date().toISOString(), gcal_error: null })
          .eq("id", b.id);
      } catch (err) {
        gcalFailed += 1;
        const msg = String((err as Error).message || "sync failed").slice(0, 300);
        console.error(`schedule-worker: gcal sync failed for booking ${b.id}: ${msg}`);
        // Re-queue; the 5-minute claim lease spaces out retries.
        await sb.from("meeting_bookings").update({ gcal_dirty: true, gcal_error: msg }).eq("id", b.id);
      }
    }
  }

  return jsonResponse({
    notices: (data?.notices || []).length,
    reminders: (data?.reminders || []).length,
    sms_sent: smsSent,
    sms_failed: smsFailed,
    sms_configured: !!twilio,
    gcal_configured: !!gcal,
    gcal_synced: gcalSynced,
    gcal_failed: gcalFailed,
  });
});
