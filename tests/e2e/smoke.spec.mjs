import { expect, test } from "@playwright/test";

const pin = process.env.SHOTS_PIN || "KEPPA";

async function signIn(page) {
  await page.goto("/#shots");
  await expect(page.locator("#shots-pin")).toBeVisible({ timeout: 15000 });
  await page.fill("#shots-pin", pin);
  await page.click('button:has-text("Open tracker")');
  await expect(page.locator(".shots-admin h1, .tracker-page, .shots-gate h1").first()).toBeVisible({
    timeout: 20000,
  });
}

/** Swap is disabled until a slot has a player (DEV has no Brighton default XI). */
async function assignTwoUsLineupPlayers(page) {
  const sel = page.locator('select[data-lineup-team="us"][data-lineup-slot="10"]');
  await expect(sel).toBeVisible({ timeout: 15000 });
  const options = sel.locator('option[value]:not([value=""])');
  await expect(options.first()).toBeAttached({ timeout: 20000 });
  const values = await options.evaluateAll((opts) => opts.map((o) => o.value).filter(Boolean));
  expect(values.length).toBeGreaterThanOrEqual(2);
  await sel.selectOption(values[0]);
  await page.locator('select[data-lineup-team="us"][data-lineup-slot="9"]').selectOption(values[1]);
}

/** Tracker listens for pointerup with a custom double-tap window (not click/dblclick). */
async function doubleTapUsPitch(page) {
  const svg = page.locator("#tracker-pitch-us .pitch-svg");
  await svg.scrollIntoViewIfNeeded();
  const box = await svg.boundingBox();
  expect(box).toBeTruthy();
  const clientX = box.x + box.width * 0.55;
  const clientY = box.y + box.height * 0.4;
  const pointerUp = () =>
    svg.dispatchEvent("pointerup", {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    });
  await pointerUp();
  await page.waitForTimeout(120);
  await pointerUp();
}

test.describe("Shot tracker smoke", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.clear();
      } catch (_) {
        /* ignore */
      }
    });
  });

  test("PIN gate opens Games", async ({ page }) => {
    await signIn(page);
    await page.goto("/#shots-games");
    await expect(page.locator(".shots-admin h1")).toHaveText("Games", { timeout: 15000 });
    await expect(page.locator("#new-game-form")).toBeVisible();
  });

  test("Prep tab opens Opponent Prep", async ({ page }) => {
    await signIn(page);
    await page.goto("/#shots-prep");
    await expect(page.locator(".shots-admin h1")).toHaveText("Prep", { timeout: 15000 });
    await expect(page.locator(".prep-tab.is-on")).toHaveText("Opponent Prep");
    await page.locator(".prep-tab", { hasText: "Explore" }).click();
    await expect(page.locator(".prep-tab.is-on")).toHaveText("Explore");
    await expect(page.locator("#explore-form")).toBeVisible();
  });

  test("Record footer opens this-game Opponent Prep", async ({ page }) => {
    test.setTimeout(60000);
    await signIn(page);
    await page.goto("/#shots-games");
    const gameBtn = page.locator("[data-open-game]").first();
    await expect(gameBtn).toBeVisible({ timeout: 15000 });
    await gameBtn.click();
    await page.locator("[data-open-mode=track]").click();
    await expect(page.locator(".tracker-page")).toBeVisible({ timeout: 20000 });
    await page.locator(".prep-game-link a").click();
    await expect(page.locator(".shots-admin h1")).toHaveText("Prep", { timeout: 15000 });
    await expect(page.locator(".prep-tab.is-on")).toHaveText("Opponent Prep");
    await expect(page.locator(".prep-locked-banner, .prep-pitch-wrap").first()).toBeVisible({
      timeout: 20000,
    });
  });

  test("add game, record shot, edit shot, lineup swap", async ({ page }) => {
    test.setTimeout(120000);
    await signIn(page);
    await page.goto("/#shots-games");
    await expect(page.locator("#new-game-form")).toBeVisible({ timeout: 15000 });

    const away = page.locator("#new-game-away");
    await expect(away).toBeVisible();
    const values = await away.locator("option").evaluateAll((opts) =>
      opts.map((o) => ({ value: o.value, text: (o.textContent || "").trim() }))
    );
    const existing = values.find(
      (o) => o.value && o.value !== "__new__" && !/brighton/i.test(o.text) && o.text !== "Select…"
    );
    if (existing) {
      await away.selectOption(existing.value);
    } else {
      await away.selectOption("__new__");
      await expect(page.locator("#new-away-name")).toBeVisible();
      await page.locator("#new-away-name").fill(`E2E Opp ${Date.now()}`);
    }

    await page.locator("#new-game-type").selectOption("friendly");
    await page.locator("#new-game-form button[type=submit]").click();

    await expect(page.locator(".tracker-page")).toBeVisible({ timeout: 20000 });
    await expect(page.locator("#tracker-pitch-us .pitch-svg")).toBeVisible();

    // Lineup swap control (needs two filled slots; DEV roster ≠ DEFAULT_XI_JERSEYS)
    await assignTwoUsLineupPlayers(page);
    const swapBtn = page.locator('[data-swap-slot][data-swap-team="us"]:not([disabled])').first();
    await expect(swapBtn).toBeEnabled();
    await swapBtn.click();
    await expect(page.locator(".lineup-swap.is-on, [data-lineup-gesture-cancel]").first()).toBeVisible();
    const cancel = page.locator("[data-lineup-gesture-cancel]");
    if (await cancel.count()) await cancel.first().click();

    // Double-tap pitch to open record modal (pointerup-based gesture in shots.js)
    await doubleTapUsPitch(page);

    const shotModal = page.locator("#shot-event-modal");
    await expect(shotModal).toBeVisible({ timeout: 10000 });
    await page.locator('[data-action-id="goal"]').click();

    // Position phase: tapping a formation card completes the shot (player optional)
    await expect(page.locator("[data-pick-position]").first()).toBeVisible({ timeout: 10000 });
    await page.locator("[data-pick-position]").first().click();

    await expect(page.locator("#tracker-log")).toContainText(/Goal/i, { timeout: 20000 });

    // Edit existing shot
    await page.locator("[data-edit-shot]").first().click();
    const editModal = page.locator("#shot-edit-modal");
    await expect(editModal).toBeVisible();
    await expect(editModal).not.toHaveAttribute("hidden", "");
    await page.locator("#shot-edit-result").selectOption("blocked");
    await page.locator("#shot-edit-save").click();
    await expect(page.locator("#tracker-log")).toContainText(/Blocked/i, { timeout: 15000 });
  });
});
