import { expect, test } from "@playwright/test";
import {
  createFriendlyAndOpenTracker,
  finishTaker,
  signIn,
  singleTapPitch,
  startCornerFromFlag,
} from "./helpers.mjs";

test.describe("Corners", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.clear();
      } catch (_) {
        /* ignore */
      }
    });
  });

  test("flag buttons add another corner without tapping the occupied mark", async ({ page }) => {
    test.setTimeout(90000);
    await signIn(page);
    await createFriendlyAndOpenTracker(page);

    await startCornerFromFlag(page, "us", "left");
    await finishTaker(page, "us");
    await expect(page.locator("#shot-modal-title")).toHaveText("Corner — what next?");
    await page.locator('[data-restart-result="corner"]').click();
    await expect(page.locator("#shot-event-modal")).toBeHidden({ timeout: 15000 });
    await expect(page.locator("#tracker-log")).toContainText(/Corner/i, { timeout: 20000 });

    await startCornerFromFlag(page, "us", "left");
    await finishTaker(page, "us");
    await page.locator('[data-restart-result="corner"]').click();
    await expect(page.locator("#shot-event-modal")).toBeHidden({ timeout: 15000 });
    await expect(page.locator("#tracker-log .shot-result-pill.corner")).toHaveCount(2);
  });

  test("a shot off a corner requires a second tap for shot location", async ({ page }) => {
    test.setTimeout(90000);
    await signIn(page);
    await createFriendlyAndOpenTracker(page);

    await startCornerFromFlag(page, "us", "right");
    await finishTaker(page, "us");
    await expect(page.locator("#shot-modal-title")).toHaveText("Corner — what next?");
    await page.locator('[data-restart-result="goal"]').click();
    await expect(page.locator("#shot-event-modal")).toBeHidden({ timeout: 15000 });
    await expect(page.locator("#tracker-log")).toContainText(/Corner/i, { timeout: 20000 });
    await expect(page.locator(".tracker-recording-banner")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#tracker-status")).toContainText(/tap where the shot/i);

    await singleTapPitch(page, "us", 0.5, 0.3);
    await expect(page.locator("#shot-event-modal")).toBeVisible({ timeout: 10000 });
    await finishTaker(page, "us");
    await expect(page.locator("#shot-event-modal")).toBeHidden({ timeout: 15000 });
    await expect(page.locator("#tracker-log .shot-result-pill.corner")).toHaveCount(1);
    await expect(page.locator("#tracker-log .shot-result-pill.goal")).toHaveCount(1);
  });

  test("inspect popup can add another play on an occupied mark", async ({ page }) => {
    test.setTimeout(90000);
    await signIn(page);
    await createFriendlyAndOpenTracker(page);

    await startCornerFromFlag(page, "us", "left");
    await finishTaker(page, "us");
    await page.locator('[data-restart-result="corner"]').click();
    await expect(page.locator("#shot-event-modal")).toBeHidden({ timeout: 15000 });
    await expect(page.locator("#tracker-pitch-us [data-inspect-id]")).toBeVisible({ timeout: 15000 });

    await page.locator("#tracker-pitch-us [data-inspect-id]").first().click();
    await expect(page.locator("[data-inspect-add]")).toBeVisible({ timeout: 10000 });
    await page.locator("[data-inspect-add]").click();
    await expect(page.locator("#shot-event-modal")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#shot-event-modal")).not.toHaveAttribute("hidden", "");
  });
});
