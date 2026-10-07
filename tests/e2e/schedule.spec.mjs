import { expect, test } from "@playwright/test";
import { createScheduleDb } from "../fixtures/schedule-pglite.mjs";

// RPCs are served from PGlite running the real migration, so this runs before
// the schedule schema exists on DEV and never writes parent data there.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

let sched;
let workerPokes;

test.beforeEach(async ({ page }) => {
  sched = await createScheduleDb();
  workerPokes = 0;
  const login = await sched.rpc("schedule_admin_login", { p_pin: "KEPPA" });
  await sched.rpc("schedule_admin_create_slots", {
    p_token: login.body.token,
    p_dates: [day(5)],
    p_start: "15:00",
    p_end: "16:00",
    p_duration: 20,
  });
  await page.addInitScript(() => {
    try {
      localStorage.clear();
    } catch (_) {
      /* ignore */
    }
  });
  await page.route(/\/rest\/v1\/rpc\/schedule_[a-z_]+/, async (route) => {
    const fn = new URL(route.request().url()).pathname.split("/").pop();
    const out = await sched.rpc(fn, route.request().postDataJSON() || {});
    await route.fulfill({ status: out.status, contentType: "application/json", body: JSON.stringify(out.body) });
  });
  await page.route(/\/functions\/v1\/schedule-worker/, async (route) => {
    workerPokes += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
});

test("parents book on the isolated page; slot and player disappear", async ({ page }) => {
  await page.goto("/blue26/schedule/");
  await expect(page.locator(".schedule-hero h1")).toHaveText("Postseason Meetings");
  await expect(page.locator(".schedule-standalone-header")).toContainText("Brighton Blue ’26");
  // No tracker chrome or links back into the app.
  await expect(page.locator("#shots-pin, #menu-btn, .nav-desktop, #nav-drawer")).toHaveCount(0);
  await expect(page.locator("a[href]")).toHaveCount(0);
  await expect(page.locator(".schedule-time")).toHaveCount(3);

  await page.selectOption("#sched-player", { label: "Lucy" });
  await page.locator(".schedule-time").nth(1).click();
  await expect(page.locator(".schedule-time").nth(1)).toHaveClass(/is-on/);
  await page.fill("#sched-email", "parent@example.com");
  await page.fill("#sched-phone1", "801 555 0123");
  await page.click(".schedule-submit-btn");
  await expect(page.locator("#sched-error")).toContainText("Check the box");
  await page.check("#sched-consent");
  await page.click(".schedule-submit-btn");

  await expect(page.locator(".schedule-done h1")).toHaveText("You’re booked");
  await expect(page.locator(".schedule-done-player")).toHaveText("Lucy");
  await expect(page.locator(".schedule-done-when")).toContainText("3:20 PM–3:40 PM");
  await expect.poll(() => workerPokes).toBeGreaterThan(0);

  await page.click("#sched-another");
  await expect(page.locator(".schedule-time.is-booked")).toHaveCount(1);
  await expect(page.locator(".schedule-time.is-booked")).toContainText("Booked");
  const names = await page.locator("#sched-player option").allTextContents();
  expect(names).not.toContain("Lucy");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("losing a race refreshes availability with a friendly message", async ({ page }) => {
  await page.goto("/blue26/schedule/");
  await page.selectOption("#sched-player", { label: "Skye" });
  await page.locator(".schedule-time").first().click();
  await page.fill("#sched-email", "skye@example.com");
  await page.check("#sched-consent");

  const state = await sched.rpc("schedule_public_state");
  const other = state.body.players.find((p) => p.name === "Beth");
  await sched.rpc("schedule_book", {
    p_player_id: other.id,
    p_slot_id: state.body.slots[0].id,
    p_email: "beth@example.com",
    p_consent: true,
  });

  await page.click(".schedule-submit-btn");
  await expect(page.locator("#sched-error")).toContainText("Another family just booked that time");
  await expect(page.locator(".schedule-time").first()).toHaveClass(/is-booked/);
  await expect(page.locator(".schedule-time.is-on")).toHaveCount(0);
});

test("coach signs in with the PIN, moves and cancels a booking", async ({ page }) => {
  const state = await sched.rpc("schedule_public_state");
  const player = state.body.players.find((p) => p.name === "Moira");
  await sched.rpc("schedule_book", {
    p_player_id: player.id,
    p_slot_id: state.body.slots[0].id,
    p_email: "moira@example.com",
    p_phone_1: "8015550144",
    p_consent: true,
  });

  // The tracker's Schedule tab is the coach view.
  await page.goto("/#schedule");
  await expect(page.locator(".schedule-hero")).toHaveCount(0);
  await page.fill("#sched-pin", "wrong");
  await page.click("#sched-pin-form button");
  await expect(page.locator(".shots-gate .shots-error")).toHaveText("Wrong PIN");
  await page.fill("#sched-pin", "keppa");
  await page.click("#sched-pin-form button");

  await expect(page.locator(".schedule-public-link")).toHaveAttribute("href", "blue26/schedule/");
  const booked = page.locator(".schedule-slot.is-booked");
  await expect(booked).toHaveCount(1);
  await expect(booked).toContainText("Moira");
  await expect(booked).toContainText("moira@example.com");
  await expect(booked).toContainText("(801) 555-0144");
  await expect(booked.locator(".schedule-slot-time")).toContainText("3:00 PM");

  await booked.locator('[data-act="move"]').click();
  await booked.locator('select[name="slot"]').selectOption({ index: 1 });
  await booked.locator('button[type="submit"]').click();
  await expect(page.locator(".schedule-slot.is-booked .schedule-slot-time")).toContainText("3:40 PM");

  page.once("dialog", (d) => d.accept());
  await page.locator('.schedule-slot.is-booked [data-act="cancel"]').click();
  await expect(page.locator(".schedule-slot.is-booked")).toHaveCount(0);
  await expect(page.locator(".schedule-cancelled summary")).toHaveText("Cancelled (1)");

  await page.click('[data-tab="add"]');
  await page.fill('#sched-add-form input[name="date"]', day(6));
  await page.fill('#sched-add-form input[name="end"]', "15:40");
  await expect(page.locator("#sched-add-preview")).toContainText("2 times");
  await page.click('#sched-add-form button[type="submit"]');
  await expect(page.locator(".schedule-admin-day")).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
