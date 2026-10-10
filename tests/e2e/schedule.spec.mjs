import { expect, test } from "@playwright/test";
import { createScheduleDb } from "../fixtures/schedule-pglite.mjs";

// RPCs are served from PGlite running the real migration, so this runs before
// the schedule schema exists on DEV and never writes parent data there.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

let sched;

test.beforeEach(async ({ page }) => {
  sched = await createScheduleDb();
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
      if (!sessionStorage.getItem("e2e-cleared")) {
        localStorage.clear();
        sessionStorage.setItem("e2e-cleared", "1");
      }
    } catch (_) {
      /* ignore */
    }
  });
  await page.route(/\/rest\/v1\/rpc\/schedule_[a-z_]+/, async (route) => {
    const fn = new URL(route.request().url()).pathname.split("/").pop();
    const out = await sched.rpc(fn, route.request().postDataJSON() || {});
    await route.fulfill({ status: out.status, contentType: "application/json", body: JSON.stringify(out.body) });
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
  await expect(page.locator("input[type=email]")).toHaveCount(0);
  await page.fill("#sched-phone1", "801 555 0123");
  await page.click(".schedule-submit-btn");
  await expect(page.locator("#sched-error")).toContainText("Check the box");
  await page.check("#sched-consent");
  await page.click(".schedule-submit-btn");

  await expect(page.locator(".schedule-done h1")).toHaveText("You’re booked");
  await expect(page.locator(".schedule-done-player")).toHaveText("Lucy");
  await expect(page.locator(".schedule-done-when")).toContainText("3:20 PM–3:40 PM");
  await expect(page.locator(".schedule-done-notes")).toContainText("(801) 555-0123");
  const ics = decodeURIComponent((await page.locator("#sched-add-cal").getAttribute("href")).split(",")[1]);
  expect(ics).toContain("TRIGGER:-PT30M");
  expect(ics).toContain("LOCATION:Shed @ Game Field");
  await expect(page.locator(".schedule-done-when")).toContainText("Shed @ Game Field");

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
  await page.check("#sched-consent");

  const state = await sched.rpc("schedule_public_state");
  const other = state.body.players.find((p) => p.name === "Beth");
  await sched.rpc("schedule_book", {
    p_player_id: other.id,
    p_slot_id: state.body.slots[0].id,
    p_confirm: true,
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
    p_phone_1: "8015550144",
    p_confirm: true,
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
  await expect(booked.locator('[data-act="resend"]')).toHaveCount(0);
  await expect(booked.locator('a[href="tel:+18015550144"]')).toHaveText("(801) 555-0144");
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

  // A signed-in coach can tap the parent page's header to get back.
  await page.click(".schedule-public-link");
  await expect(page.locator(".schedule-hero h1")).toHaveText("Postseason Meetings");
  await page.click(".schedule-standalone-header a.schedule-coach-back");
  await expect(page).toHaveURL(/#schedule$/);
  await expect(page.locator(".schedule-public-link")).toBeVisible();
});

test("Calendar tab builds a copyable group text per day", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const state = await sched.rpc("schedule_public_state");
  const pick = (name) => state.body.players.find((p) => p.name === name).id;
  const book = (name, slot, p1, p2) =>
    sched.rpc("schedule_book", {
      p_player_id: pick(name),
      p_slot_id: state.body.slots[slot].id,
      p_phone_1: p1,
      p_phone_2: p2,
      p_confirm: true,
    });
  await book("Lucy", 0, "801-555-0123", "385-555-0199");
  await book("Moira", 1, null, null);
  await book("Skye", 2, "8015550123", null);

  await page.goto("/#schedule");
  await page.fill("#sched-pin", "keppa");
  await page.click("#sched-pin-form button");
  await page.click('[data-tab="calendar"]');

  const dayCard = page.locator(".schedule-text-day");
  await expect(dayCard).toHaveCount(1);
  await expect(dayCard.locator("h3")).toContainText("3 meetings");
  await expect(dayCard.locator("textarea")).toHaveValue("+18015550123, +13855550199");
  await expect(dayCard).toContainText("No number: Moira");

  await dayCard.getByRole("button", { name: "Copy 2 numbers" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("+18015550123, +13855550199");
  await dayCard.getByRole("button", { name: "Copy message" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/Lucy 3:00 PM, Moira 3:20 PM, Skye 3:40 PM/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);});
