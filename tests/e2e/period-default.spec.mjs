import { expect, test } from "@playwright/test";
import { createFriendlyAndOpenTracker, openRecordModal, signIn } from "./helpers.mjs";

test.describe("Default first half", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.clear();
      } catch (_) {
        /* ignore */
      }
    });
  });

  test("new games start in 1st half and offer to switch back if you record in 2nd first", async ({ page }) => {
    test.setTimeout(90000);
    await signIn(page);
    await createFriendlyAndOpenTracker(page);
    const periodBtn = page.locator("button.score-strip-btn[data-open-clock-setup], button.scoreboard-period[data-open-clock-setup]");
    await expect(periodBtn.first()).toContainText(/1st Half/i);

    await periodBtn.first().click();
    await expect(page.locator("#clock-setup-modal")).toBeVisible();
    await page.locator('[data-clock-setup-period="2"]').click();
    await page.locator("#clock-setup-save").click();
    await expect(page.locator("#clock-setup-modal")).toBeHidden();
    await expect(periodBtn.first()).toContainText(/2nd Half/i);

    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toMatch(/1st-half/i);
      await dialog.accept();
    });
    await openRecordModal(page, "us");
    await expect(page.locator("#shot-event-modal")).toBeVisible();
    await expect(periodBtn.first()).toContainText(/1st Half/i);
  });
});
