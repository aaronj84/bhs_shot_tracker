import { createFriendlyAndOpenTracker, expect, recordPlay, signIn, test } from "./helpers.mjs";

test.describe("Bulk edit play half", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.clear();
      } catch (_) {
        /* ignore */
      }
    });
  });

  test("move all 1st-half plays to 2nd, and move a selected play back", async ({ page }) => {
    test.setTimeout(120000);
    await signIn(page);
    await createFriendlyAndOpenTracker(page);
    await recordPlay(page, { team: "us", actionId: "goal" });
    await recordPlay(page, { team: "opp", actionId: "blocked" });

    const firstTable = page.locator("#tracker-log .tracker-table").nth(0);
    const secondTable = page.locator("#tracker-log .tracker-table").nth(1);
    await expect(firstTable.locator("tbody tr")).toHaveCount(2);
    await expect(secondTable.locator(".empty-state")).toBeVisible();

    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toMatch(/2nd Half/i);
      await dialog.accept();
    });
    await page.locator('[data-move-half-from="1"]').selectOption("2");

    await expect(firstTable.locator(".empty-state")).toBeVisible({ timeout: 15000 });
    await expect(secondTable.locator("tbody tr")).toHaveCount(2);

    await secondTable.locator('[data-select-shot]').first().check();
    await expect(page.locator(".plays-bulk-bar")).toBeVisible();
    await page.locator("#plays-bulk-period").selectOption("1");
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toMatch(/1st Half/i);
      await dialog.accept();
    });
    await page.locator("[data-bulk-period-apply]").click();

    await expect(firstTable.locator("tbody tr")).toHaveCount(1, { timeout: 15000 });
    await expect(secondTable.locator("tbody tr")).toHaveCount(1);
  });
});
