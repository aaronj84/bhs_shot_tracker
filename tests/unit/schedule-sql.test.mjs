import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATION = readFileSync(
  path.join(ROOT, "supabase/migrations/20261007160000_postseason_schedule.sql"),
  "utf8"
);
const DOWN = readFileSync(path.join(ROOT, "supabase/down/20261007160000_postseason_schedule.sql"), "utf8");

let db;

async function one(sql, params = []) {
  const { rows } = await db.query(sql, params);
  return rows[0] ? Object.values(rows[0])[0] : undefined;
}

async function rpc(fn, args = {}) {
  const keys = Object.keys(args);
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`;
  return one(sql, keys.map((k) => args[k]));
}

async function rejects(promise) {
  try {
    await promise;
  } catch (err) {
    return err.message;
  }
  throw new Error("expected rejection");
}

function futureDate(days) {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
}

async function adminToken() {
  const res = await rpc("schedule_admin_login", { p_pin: "keppa" });
  expect(res.ok).toBe(true);
  return res.token;
}

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;
    grant usage on schema public to anon, authenticated, service_role;
  `);
  await db.exec(MIGRATION);
});

describe("postseason schedule SQL", () => {
  let token;
  let slots;
  let players;

  it("seeds the Brighton Blue roster and settings", async () => {
    const state = await rpc("schedule_public_state");
    expect(state.players).toHaveLength(17);
    expect(state.players.map((p) => p.name)).toContain("Kali-Shea");
    expect(state.slots).toEqual([]);
    expect(await one("select length(feed_token) from schedule_settings")).toBe(48);
  });

  it("re-running the migration is a no-op", async () => {
    await db.exec(MIGRATION);
    expect(await one("select count(*)::int from schedule_players")).toBe(17);
    expect(await one("select count(*)::int from schedule_settings")).toBe(1);
  });

  it("checks the PIN server-side", async () => {
    const bad = await rpc("schedule_admin_login", { p_pin: "nope" });
    expect(bad).toEqual({ ok: false, error: "Wrong PIN" });
    token = await adminToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const msg = await rejects(rpc("schedule_admin_state", { p_token: "deadbeef" }));
    expect(msg).toMatch(/session expired/i);
  });

  it("creates a batch of Denver-time slots and skips duplicates", async () => {
    const date = futureDate(30);
    const res = await rpc("schedule_admin_create_slots", {
      p_token: token,
      p_dates: [date],
      p_start: "15:00",
      p_end: "16:00",
      p_duration: 20,
      p_gap: 0,
    });
    expect(res).toEqual({ created: 3, skipped: 0 });
    const again = await rpc("schedule_admin_create_slots", {
      p_token: token,
      p_dates: [date],
      p_start: "15:00",
      p_end: "16:00",
      p_duration: 20,
    });
    expect(again).toEqual({ created: 0, skipped: 3 });

    const local = await one(
      `select to_char(min(starts_at) at time zone 'America/Denver', 'YYYY-MM-DD HH24:MI') from meeting_slots`
    );
    expect(local).toBe(`${date} 15:00`);

    const state = await rpc("schedule_public_state");
    slots = state.slots;
    players = state.players;
    expect(slots.map((s) => s.booked)).toEqual([false, false, false]);
  });

  it("books a slot and normalizes contact info", async () => {
    const res = await rpc("schedule_book", {
      p_player_id: players[0].id,
      p_slot_id: slots[0].id,
      p_email: "  Parent@Example.COM ",
      p_phone_1: "",
      p_phone_2: "(801) 555-0123",
      p_consent: true,
    });
    expect(res.player_name).toBe(players[0].name);
    expect(res.phone_count).toBe(1);
    const row = (await db.query("select parent_email, phone_1, phone_2, pending_notice from meeting_bookings")).rows[0];
    expect(row).toEqual({
      parent_email: "parent@example.com",
      phone_1: "+18015550123",
      phone_2: null,
      pending_notice: "confirmation",
    });
  });

  it("blocks double booking of a slot and of a player", async () => {
    const base = { p_email: "a@b.co", p_consent: true };
    expect(
      await rejects(rpc("schedule_book", { ...base, p_player_id: players[1].id, p_slot_id: slots[0].id }))
    ).toMatch(/just booked that time/);
    expect(
      await rejects(rpc("schedule_book", { ...base, p_player_id: players[0].id, p_slot_id: slots[1].id }))
    ).toMatch(/already has a meeting/);
    // Backstop if two transactions race past the checks.
    expect(
      await rejects(
        db.query(
          `insert into meeting_bookings (slot_id, player_id, parent_email) values ($1, $2, 'x@y.co')`,
          [slots[0].id, players[2].id]
        )
      )
    ).toMatch(/meeting_bookings_one_per_slot/);
  });

  it("validates consent, email, and phone numbers", async () => {
    const base = { p_player_id: players[1].id, p_slot_id: slots[1].id, p_email: "a@b.co", p_consent: true };
    expect(await rejects(rpc("schedule_book", { ...base, p_consent: false }))).toMatch(/check the box/);
    expect(await rejects(rpc("schedule_book", { ...base, p_email: "nope" }))).toMatch(/valid parent/);
    expect(await rejects(rpc("schedule_book", { ...base, p_phone_1: "555-1234" }))).toMatch(/10-digit/);
    expect(await rejects(rpc("schedule_book", { ...base, p_phone_1: "123-456-7890" }))).toMatch(/10-digit/);
  });

  it("hides booked players and shows booked slots publicly without contact info", async () => {
    const state = await rpc("schedule_public_state");
    expect(state.players.map((p) => p.id)).not.toContain(players[0].id);
    expect(state.slots[0]).toEqual({ ...slots[0], booked: true });
    expect(JSON.stringify(state)).not.toMatch(/example\.com|8015550123/);
  });

  it("keeps tables and worker functions away from anon/authenticated", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      try {
        expect(await rejects(db.query("select * from meeting_bookings"))).toMatch(/permission denied/);
        expect(await rejects(db.query("select * from schedule_settings"))).toMatch(/permission denied/);
        expect(await rejects(db.query("select public.schedule_worker_claim()"))).toMatch(/permission denied/);
        expect(await rejects(db.query("select public._schedule_require_admin('x')"))).toMatch(/permission denied/);
        const state = await rpc("schedule_public_state");
        expect(state.slots).toHaveLength(3);
      } finally {
        await db.exec("reset role");
      }
    }
  });

  it("admin state exposes bookings with contact info", async () => {
    const state = await rpc("schedule_admin_state", { p_token: token });
    const booked = state.slots.find((s) => s.booking);
    expect(booked.booking.parent_email).toBe("parent@example.com");
    expect(booked.booking.player_name).toBe(players[0].name);
    expect(state.settings.feed_token).toHaveLength(48);
    expect(state.players.find((p) => p.id === players[0].id).booked).toBe(true);
  });

  it("claims notices exactly once", async () => {
    const first = await rpc("schedule_worker_claim", { p_include_gcal: true });
    expect(first.notices).toHaveLength(1);
    expect(first.notices[0].kind).toBe("confirmation");
    expect(first.notices[0].phone_1).toBe("+18015550123");
    expect(first.gcal).toHaveLength(1);
    const second = await rpc("schedule_worker_claim", { p_include_gcal: true });
    expect(second.notices).toHaveLength(0);
    expect(second.gcal).toHaveLength(0);
    expect(await rpc("schedule_worker_has_work")).toBe(false);
  });

  it("moves, edits, resends, and cancels", async () => {
    const id = await one("select id from meeting_bookings where status = 'confirmed'");
    const moved = await rpc("schedule_admin_move_booking", { p_token: token, p_booking_id: id, p_slot_id: slots[2].id });
    expect(moved.slot_id).toBe(slots[2].id);
    expect(moved.pending_notice).toBe("update");
    expect(moved.gcal_dirty).toBe(true);

    const edited = await rpc("schedule_admin_update_booking", {
      p_token: token,
      p_booking_id: id,
      p_player_id: players[0].id,
      p_email: "new@example.com",
      p_phone_1: "801.555.0199",
      p_phone_2: "8015550199",
    });
    expect(edited.parent_email).toBe("new@example.com");
    expect(edited.phone_1).toBe("+18015550199");
    expect(edited.phone_2).toBeNull();

    const claim = await rpc("schedule_worker_claim");
    expect(claim.notices.map((n) => n.kind)).toEqual(["update"]);
    await rpc("schedule_admin_resend", { p_token: token, p_booking_id: id });
    expect((await rpc("schedule_worker_claim")).notices.map((n) => n.kind)).toEqual(["confirmation"]);

    const seqBefore = await one("select ics_sequence from meeting_bookings where id = $1", [id]);
    await rpc("schedule_admin_cancel_booking", { p_token: token, p_booking_id: id });
    const row = (await db.query("select status, ics_sequence, gcal_dirty from meeting_bookings where id = $1", [id])).rows[0];
    expect(row).toEqual({ status: "cancelled", ics_sequence: seqBefore + 1, gcal_dirty: true });

    const state = await rpc("schedule_public_state");
    expect(state.players.map((p) => p.id)).toContain(players[0].id);
    expect(state.slots.every((s) => !s.booked)).toBe(true);

    // Player can rebook after a cancel.
    await rpc("schedule_book", {
      p_player_id: players[0].id,
      p_slot_id: slots[0].id,
      p_email: "a@b.co",
      p_consent: true,
    });
    expect(
      await rejects(rpc("schedule_admin_delete_slot", { p_token: token, p_slot_id: slots[2].id }))
    ).toMatch(/history/);
  });

  it("sends a reminder once, 30 minutes out, and skips last-minute bookings", async () => {
    await db.exec(`
      insert into meeting_slots (starts_at, duration_minutes) values
        (now() + interval '20 minutes', 20),
        (now() + interval '25 minutes', 20);
    `);
    const early = await one(`select id from meeting_slots where starts_at = (select min(starts_at) from meeting_slots where starts_at < now() + interval '1 hour')`);
    const late = await one(`select id from meeting_slots where starts_at = (select max(starts_at) from meeting_slots where starts_at < now() + interval '1 hour')`);
    await db.query(
      `insert into meeting_bookings (slot_id, player_id, parent_email, phone_1, scheduled_at)
       values ($1, $2, 'r@x.co', '+18015550111', now() - interval '2 days'),
              ($3, $4, 'r@x.co', '+18015550112', now())`,
      [early, players[3].id, late, players[4].id]
    );
    const claim = await rpc("schedule_worker_claim");
    expect(claim.reminders).toHaveLength(1);
    expect(claim.reminders[0].phone_1).toBe("+18015550111");
    expect((await rpc("schedule_worker_claim")).reminders).toHaveLength(0);
  });

  it("rate limits PIN guesses", async () => {
    for (let i = 0; i < 9; i += 1) await rpc("schedule_admin_login", { p_pin: `bad${i}` });
    const locked = await rpc("schedule_admin_login", { p_pin: "KEPPA" });
    expect(locked.ok).toBe(false);
    expect(locked.error).toMatch(/Too many tries/);
    await db.exec("delete from schedule_admin_attempts");
  });

  it("changing the PIN signs out other sessions", async () => {
    const other = await adminToken();
    await rpc("schedule_admin_change_pin", { p_token: token, p_new_pin: "bengals26" });
    expect(await rejects(rpc("schedule_admin_state", { p_token: other }))).toMatch(/expired/);
    expect((await rpc("schedule_admin_login", { p_pin: "BENGALS26" })).ok).toBe(true);
    expect(await rpc("schedule_admin_state", { p_token: token })).toBeTruthy();
  });

  it("down migration removes everything", async () => {
    await db.exec(DOWN);
    expect(await one("select to_regclass('public.meeting_bookings')")).toBeNull();
    expect(await one("select count(*)::int from pg_proc where proname like 'schedule%'")).toBe(0);
  });
});
