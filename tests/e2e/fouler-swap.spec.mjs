import { expect, test } from "@playwright/test";
import { assignTwoUsLineupPlayers, createFriendlyAndOpenTracker, finishTaker, openRecordModal, signIn } from "./helpers.mjs";

test.describe("Fouler swap", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.clear();
      } catch (_) {
        /* ignore */
      }
    });
  });

  test("can swap two Brighton players while tagging who committed the foul", async ({ page }) => {
    test.setTimeout(90000);
    await signIn(page);
    await createFriendlyAndOpenTracker(page);
    await assignTwoUsLineupPlayers(page);

    const slot10 = page.locator('select[data-lineup-team="us"][data-lineup-slot="10"]');
    const slot9 = page.locator('select[data-lineup-team="us"][data-lineup-slot="9"]');
    const before10 = await slot10.inputValue();
    const before9 = await slot9.inputValue();

    await openRecordModal(page, "us");
    await page.locator('[data-action-id="foul"]').click();
    await expect(page.locator("#shot-modal-title")).toHaveText("Who committed the infringement?");
    await page.locator('#shot-event-modal [data-shot-team="us"]').click();
    await expect(page.locator("#shot-event-modal [data-swap-slot]:not([disabled])").first()).toBeVisible();

    await page.locator('#shot-event-modal [data-swap-slot="10"]').click();
    await expect(page.locator("#shot-event-modal .lineup-swap.is-on")).toBeVisible();
    await page.locator('#shot-event-modal [data-lineup-slot-hit="9"]').click();

    await expect(page.locator("#shot-event-modal .lineup-swap.is-on")).toHaveCount(0);
    await expect(slot10).toHaveValue(before9);
    await expect(slot9).toHaveValue(before10);

    await page.locator('#shot-event-modal [data-player-number]').first().click();
    await finishTaker(page, "us");
    await expect(page.locator("#shot-modal-title")).toHaveText("Free kick — what next?");
    await page.locator('[data-setpiece-follow="none"]').click();
    await expect(page.locator("#shot-event-modal")).toBeHidden({ timeout: 15000 });
    await expect(page.locator("#tracker-log")).toContainText(/Free Kick/i);
  });
});
