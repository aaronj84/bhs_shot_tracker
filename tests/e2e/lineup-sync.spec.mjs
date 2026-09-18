import { expect, test } from "@playwright/test";
import { assignTwoUsLineupPlayers, createFriendlyAndOpenTracker, signIn } from "./helpers.mjs";

test.describe("Lineup sync", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.clear();
      } catch (_) {
        /* ignore */
      }
    });
  });

  test("Sync pushes lineup and reload restores it from the server", async ({ page }) => {
    test.setTimeout(120000);
    await signIn(page);
    await createFriendlyAndOpenTracker(page);
    await assignTwoUsLineupPlayers(page);

    const slot10 = page.locator('select[data-lineup-team="us"][data-lineup-slot="10"]');
    const slot9 = page.locator('select[data-lineup-team="us"][data-lineup-slot="9"]');
    const v10 = await slot10.inputValue();
    const v9 = await slot9.inputValue();
    expect(v10).toBeTruthy();
    expect(v9).toBeTruthy();

    await page.locator('.score-strip-controls [data-tracker-action="sync"]').click();
    await expect(page.locator("#role-toast")).toContainText(/Synced/i, { timeout: 20000 });

    await page.evaluate(() => {
      try {
        localStorage.removeItem("brighton-varsity-shot-tracker-lineup");
      } catch (_) {
        /* ignore */
      }
    });
    await page.reload();
    const pin = page.locator("#shots-pin");
    if (await pin.isVisible({ timeout: 4000 }).catch(() => false)) {
      await signIn(page);
    }
    await expect(page.locator(".tracker-page")).toBeVisible({ timeout: 20000 });
    await expect(page.locator('select[data-lineup-team="us"][data-lineup-slot="10"]')).toHaveValue(v10, {
      timeout: 20000,
    });
    await expect(page.locator('select[data-lineup-team="us"][data-lineup-slot="9"]')).toHaveValue(v9);
  });
});
