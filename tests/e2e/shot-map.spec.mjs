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
});
