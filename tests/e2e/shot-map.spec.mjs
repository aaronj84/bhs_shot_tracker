import { expect, test } from "@playwright/test";
import { createFriendlyAndOpenTracker, openRecordModal, signIn } from "./helpers.mjs";

test.describe("Shot map markers", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.clear();
      } catch (_) {
        /* ignore */
      }
    });
  });

  test("white on-target circles keep a dark jersey number", async ({ page }) => {
    test.setTimeout(90000);
    await signIn(page);
    await createFriendlyAndOpenTracker(page);

    await openRecordModal(page, "opp");
    await page.locator('[data-action-id="on-target"]').click();
    const pick = page.locator("#shot-opp-pick");
    await expect(pick).toBeVisible({ timeout: 10000 });
    const value = await pick.locator("option[value]:not([value=''])").first().getAttribute("value");
    expect(value).toBeTruthy();
    await pick.selectOption(value);
    await expect(page.locator("#shot-event-modal")).toBeHidden({ timeout: 15000 });

    const num = page.locator("#tracker-pitch-opp .tracker-event.is-opp .tracker-shot-num");
    await expect(num).toBeVisible({ timeout: 15000 });
    const fill = await num.evaluate((el) => getComputedStyle(el).fill);
    expect(fill).not.toMatch(/rgb\(\s*255\s*,\s*255\s*,\s*255\s*\)|#fff(fff)?/i);
  });

  test("already-shot numbers sit above the player picker for a repeat tap", async ({ page }) => {
    test.setTimeout(90000);
    await signIn(page);
    await createFriendlyAndOpenTracker(page);

    await openRecordModal(page, "opp");
    await page.locator('[data-action-id="goal"]').click();
    const pick = page.locator("#shot-opp-pick");
    await expect(pick).toBeVisible({ timeout: 10000 });
    const value = await pick.locator("option[value]:not([value=''])").first().getAttribute("value");
    await pick.selectOption(value);
    await expect(page.locator("#shot-event-modal")).toBeHidden({ timeout: 15000 });

    await openRecordModal(page, "opp");
    await page.locator('[data-action-id="blocked"]').click();
    const chip = page.locator(".shot-recent-num").first();
    await expect(chip).toBeVisible({ timeout: 10000 });
    await chip.click();
    await expect(page.locator("#shot-event-modal")).toBeHidden({ timeout: 15000 });
    await expect(page.locator("#tracker-log .shot-result-pill.blocked")).toHaveCount(1);
    await expect(page.locator("#tracker-log .shot-result-pill.goal")).toHaveCount(1);
  });
});
