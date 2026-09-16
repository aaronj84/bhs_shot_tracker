import { expect, test } from "@playwright/test";
import { assignTwoUsLineupPlayers, createFriendlyAndOpenTracker, doubleTapUsPitch, signIn } from "./helpers.mjs";

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
    await expect(page.locator("#prep-config-open")).toBeVisible();
    await expect(page.locator(".prep-empty")).toBeVisible();
    await expect(page.locator(".prep-gemini")).toHaveCount(0);
    await page.locator("#prep-config-open").click();
    await expect(page.locator("#prep-config-modal")).toBeVisible();
    const opp = page.locator("#prep-opponent");
    await expect(opp).toBeVisible();
    const values = await opp.locator("option").evaluateAll((opts) =>
      opts.map((o) => o.value).filter(Boolean)
    );
    if (values.length) {
      await opp.selectOption(values[0]);
      await page.locator("#prep-config-modal .btn-primary").click();
      await expect(page.locator("#prep-config-modal")).toBeHidden();
      await expect(page.locator(".prep-pitch-wrap")).toBeVisible({ timeout: 20000 });
      await expect(page.locator(".prep-gemini")).toBeVisible();
      await expect(page.locator(".prep-notes")).toBeVisible();
      await expect(page.locator("#prep-note-form")).toHaveCount(0);
      await page.locator("#prep-filter-toggle").click();
      await expect(page.locator("#prep-filter-panel")).toBeVisible();
      await page.locator("#prep-stats-toggle").click();
      await expect(page.locator("#prep-stats-panel")).toBeVisible();
      await expect(page.locator("#prep-filter-panel")).toHaveCount(0);
      await page.locator("#prep-note-add").click();
      await expect(page.locator("#prep-note-form")).toBeVisible();
    } else {
      await page.locator("#prep-config-modal .btn-primary").click();
      await expect(page.locator("#prep-config-modal")).toBeHidden();
    }
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
    await createFriendlyAndOpenTracker(page);

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
