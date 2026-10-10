import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (dir, f) => readFileSync(path.join(ROOT, "supabase", dir, f), "utf8");
const BASE = read("migrations", "20261007160000_postseason_schedule.sql");
const MANUAL = read("migrations", "20261010150000_schedule_manual_reminders.sql");
const MANUAL_DOWN = read("down", "20261010150000_schedule_manual_reminders.sql");
const DOWN = read("down", "20261007160000_postseason_schedule.sql");

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

async function bookingColumns() {
  const { rows } = await db.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'meeting_bookings'`
  );
  return rows.map((r) => r.column_name);
}

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;
    grant usage on schema public to anon, authenticated, service_role;
  `);
  await db.exec(BASE);
  await db.exec(MANUAL);
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

  it("keeps mobile numbers but no email or text state", async () => {
    const cols = await bookingColumns();
    for (const gone of ["parent_email", "pending_notice", "reminder_sent_at"]) {
      expect(cols).not.toContain(gone);
    }
    expect(cols).toEqual(expect.arrayContaining(["phone_1", "phone_2"]));
    expect(await one("select to_regclass('public.meeting_sms_log')")).toBeNull();
    expect(await one("select count(*)::int from pg_proc where proname = 'schedule_admin_resend'")).toBe(0);
  });

  it("re-running the latest migration is a no-op", async () => {
    await db.exec(MANUAL);
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

  it("books a slot and normalizes mobile numbers", async () => {
    const res = await rpc("schedule_book", {
      p_player_id: players[0].id,
      p_slot_id: slots[0].id,
      p_phone_1: "",
      p_phone_2: "(801) 555-0123",
      p_confirm: true,
    });
    expect(Object.keys(res).sort()).toEqual(["booking_id", "duration_minutes", "player_name", "starts_at"]);
    expect(res.player_name).toBe(players[0].name);
    const row = (await db.query("select phone_1, phone_2 from meeting_bookings")).rows[0];
    expect(row).toEqual({ phone_1: "+18015550123", phone_2: null });
  });

  it("requires the confirmation box and valid numbers", async () => {
    const base = { p_player_id: players[1].id, p_slot_id: slots[1].id, p_confirm: true };
    expect(await rejects(rpc("schedule_book", { ...base, p_confirm: false }))).toMatch(/check the box/);
    expect(await rejects(rpc("schedule_book", { ...base, p_phone_1: "555-1234" }))).toMatch(/10-digit/);
    expect(await rejects(rpc("schedule_book", { ...base, p_phone_2: "123-456-7890" }))).toMatch(/10-digit/);
  });

  it("blocks double booking of a slot and of a player", async () => {
    const base = { p_confirm: true };
    expect(
      await rejects(rpc("schedule_book", { ...base, p_player_id: players[1].id, p_slot_id: slots[0].id }))
    ).toMatch(/just booked that time/);
    expect(
      await rejects(rpc("schedule_book", { ...base, p_player_id: players[0].id, p_slot_id: slots[1].id }))
    ).toMatch(/already has a meeting/);
    // Backstop if two transactions race past the checks.
    expect(
      await rejects(
        db.query(`insert into meeting_bookings (slot_id, player_id) values ($1, $2)`, [slots[0].id, players[2].id])
      )
    ).toMatch(/meeting_bookings_one_per_slot/);
  });

  it("hides booked players and shows booked slots publicly without numbers", async () => {
    const state = await rpc("schedule_public_state");
    expect(state.players.map((p) => p.id)).not.toContain(players[0].id);
    expect(state.slots[0]).toEqual({ ...slots[0], booked: true });
    expect(JSON.stringify(state)).not.toMatch(/8015550123/);
  });

  it("keeps tables and internal functions away from anon/authenticated", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      try {
        expect(await rejects(db.query("select * from meeting_bookings"))).toMatch(/permission denied/);
        expect(await rejects(db.query("select * from schedule_settings"))).toMatch(/permission denied/);
        expect(await rejects(db.query("select public._schedule_booking_json(gen_random_uuid())"))).toMatch(/permission denied/);
        expect(await rejects(db.query("select public._schedule_require_admin('x')"))).toMatch(/permission denied/);
        const state = await rpc("schedule_public_state");
        expect(state.slots).toHaveLength(3);
        expect(
          await rejects(rpc("schedule_book", { p_player_id: players[5].id, p_slot_id: slots[1].id }))
        ).toMatch(/check the box/);
      } finally {
        await db.exec("reset role");
      }
    }
  });

  it("admin state exposes bookings", async () => {
    const state = await rpc("schedule_admin_state", { p_token: token });
    const booked = state.slots.find((s) => s.booking);
    expect(booked.booking.player_name).toBe(players[0].name);
    expect(booked.booking.phone_1).toBe("+18015550123");
    expect(booked.booking).not.toHaveProperty("parent_email");
    expect(state).not.toHaveProperty("sms");
    expect(state.settings.feed_token).toHaveLength(48);
    expect(state.players.find((p) => p.id === players[0].id).booked).toBe(true);
  });

  it("has no worker, sync state, or Google Calendar hooks", async () => {
    const cols = await bookingColumns();
    expect(cols.some((c) => c.startsWith("gcal_"))).toBe(false);
    expect(
      await one(
        "select count(*)::int from pg_proc where proname in ('schedule_worker_claim', 'schedule_worker_has_work', 'schedule_kick_worker', 'schedule_admin_set_worker_url')"
      )
    ).toBe(0);
    const state = await rpc("schedule_admin_state", { p_token: token });
    expect(state.settings).not.toHaveProperty("worker_url");
  });

  it("moves, edits, and cancels", async () => {
    const id = await one("select id from meeting_bookings where status = 'confirmed'");
    const moved = await rpc("schedule_admin_move_booking", { p_token: token, p_booking_id: id, p_slot_id: slots[2].id });
    expect(moved.slot_id).toBe(slots[2].id);

    const edited = await rpc("schedule_admin_update_booking", {
      p_token: token,
      p_booking_id: id,
      p_player_id: players[1].id,
      p_phone_1: "801.555.0199",
      p_phone_2: "8015550199",
    });
    expect(edited.player_id).toBe(players[1].id);
    expect([edited.phone_1, edited.phone_2]).toEqual(["+18015550199", null]);

    const seqBefore = await one("select ics_sequence from meeting_bookings where id = $1", [id]);
    await rpc("schedule_admin_cancel_booking", { p_token: token, p_booking_id: id });
    const row = (await db.query("select status, ics_sequence from meeting_bookings where id = $1", [id])).rows[0];
    expect(row).toEqual({ status: "cancelled", ics_sequence: seqBefore + 1 });

    const state = await rpc("schedule_public_state");
    expect(state.players.map((p) => p.id)).toContain(players[1].id);
    expect(state.slots.every((s) => !s.booked)).toBe(true);

    const coachBooked = await rpc("schedule_admin_book", {
      p_token: token,
      p_player_id: players[0].id,
      p_slot_id: slots[0].id,
    });
    expect(coachBooked.player_name).toBe(players[0].name);
    expect(
      await rejects(rpc("schedule_admin_delete_slot", { p_token: token, p_slot_id: slots[2].id }))
    ).toMatch(/history/);
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

  it("rolls back and forward with bookings in place", async () => {
    await db.exec(MANUAL_DOWN);
    expect(await bookingColumns()).toEqual(expect.arrayContaining(["parent_email", "phone_1", "pending_notice"]));
    expect(await one("select to_regclass('public.meeting_sms_log')")).toBe("meeting_sms_log");
    expect(await one("select count(*)::int from pg_proc where proname = 'schedule_admin_resend'")).toBe(1);
    expect(await one("select count(*)::int from pg_proc where proname = 'schedule_kick_worker'")).toBe(1);
    expect(await bookingColumns()).toContain("gcal_dirty");
    expect(await one("select count(*)::int from meeting_bookings where parent_email = ''")).toBeGreaterThan(0);

    await db.exec(MANUAL);
    expect(await bookingColumns()).not.toContain("parent_email");
    expect(await one("select count(*)::int from pg_proc where proname = 'schedule_book'")).toBe(1);
    expect(await one("select count(*)::int from meeting_bookings where phone_1 = '+18015550199'")).toBe(1);
  });

  it("down migration removes everything", async () => {
    await db.exec(DOWN);
    expect(await one("select to_regclass('public.meeting_bookings')")).toBeNull();
    expect(await one("select count(*)::int from pg_proc where proname like 'schedule%'")).toBe(0);
  });
});
