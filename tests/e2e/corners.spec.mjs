import {
  createFriendlyAndOpenTracker,
  expect,
  finishTaker,
  signIn,
  singleTapPitch,
  startCornerFromFlag,
  test,
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
    await expect(page.locator('[data-setpiece-follow="shot"]')).toBeVisible();
    await expect(page.locator('[data-setpiece-follow="pass"]')).toBeVisible();
    await expect(page.locator('[data-setpiece-follow="none"]')).toBeVisible();
    await page.locator('[data-setpiece-follow="none"]').click();
    await expect(page.locator("#shot-event-modal")).toBeHidden({ timeout: 15000 });
    await expect(page.locator("#tracker-log")).toContainText(/Corner/i, { timeout: 20000 });

    await startCornerFromFlag(page, "us", "left");
    await finishTaker(page, "us");
    await page.locator('[data-setpiece-follow="none"]').click();
    await expect(page.locator("#shot-event-modal")).toBeHidden({ timeout: 15000 });
    await expect(page.locator("#tracker-log .shot-result-pill.corner")).toHaveCount(2);
  });

  test("a shot off a corner uses the corner as the assist / setup pass", async ({ page }) => {
    test.setTimeout(90000);
    await signIn(page);
    await createFriendlyAndOpenTracker(page);

    await startCornerFromFlag(page, "us", "right");
    await finishTaker(page, "us");
    await expect(page.locator("#shot-modal-title")).toHaveText("Corner — what next?");
    await page.locator('[data-setpiece-follow="shot"]').click();
    await expect(page.locator("#shot-event-modal")).toBeHidden({ timeout: 15000 });
    await expect(page.locator("#tracker-log")).toContainText(/Corner/i, { timeout: 20000 });
    await expect(page.locator(".tracker-recording-banner")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#tracker-status")).toContainText(/tap where the shot/i);

    await singleTapPitch(page, "us", 0.5, 0.3);
    await expect(page.locator("#shot-event-modal")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#shot-modal-title")).toHaveText("Shot result?", { timeout: 10000 });
    await page.locator('[data-action-id="goal"]').click();
    await finishTaker(page, "us");
    // Corner starts the play, so the shot completes it — no second assist prompt.
    await expect(page.locator("#shot-event-modal")).toBeHidden({ timeout: 15000 });
    await expect(page.locator("#tracker-log .shot-result-pill.corner")).toHaveCount(1);
    await expect(page.locator("#tracker-log .shot-result-pill.goal")).toHaveCount(1);
    // Corner delivery is stored as the goal's assist (type cross).
    await expect(page.locator("#tracker-log")).toContainText(/Cross/i);
  });

  test("pass off a corner keeps the corner as setup and asks for next pass or shot", async ({ page }) => {
    test.setTimeout(90000);
    await signIn(page);
    await createFriendlyAndOpenTracker(page);

    await startCornerFromFlag(page, "us", "left");
    await finishTaker(page, "us");
    await page.locator('[data-setpiece-follow="pass"]').click();
    await expect(page.locator("#shot-event-modal")).toBeHidden({ timeout: 15000 });
    await expect(page.locator(".tracker-recording-banner")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#tracker-status")).toContainText(/next pass or the shot/i);

    await singleTapPitch(page, "us", 0.45, 0.35);
    await expect(page.locator("#shot-event-modal")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#shot-modal-title")).toHaveText("Next pass or shot?", { timeout: 10000 });
    await page.locator('[data-action-id="on-target"]').click();
    await finishTaker(page, "us");
    await expect(page.locator("#shot-event-modal")).toBeHidden({ timeout: 15000 });
    await expect(page.locator("#tracker-log .shot-result-pill.corner")).toHaveCount(1);
    await expect(page.locator("#tracker-log .shot-result-pill.on-target")).toHaveCount(1);
    // Corner delivery is stored as the shot's setup pass (type pass).
    await expect(page.locator("#tracker-log")).toContainText(/Pass/i);
  });

  test("inspect popup can add another play on an occupied mark", async ({ page }) => {
    test.setTimeout(90000);
    await signIn(page);
    await createFriendlyAndOpenTracker(page);

    await startCornerFromFlag(page, "us", "left");
    await finishTaker(page, "us");
    await page.locator('[data-setpiece-follow="none"]').click();
    await expect(page.locator("#shot-event-modal")).toBeHidden({ timeout: 15000 });
    await expect(page.locator("#tracker-pitch-us [data-inspect-id]")).toBeVisible({ timeout: 15000 });

    await page.locator("#tracker-pitch-us [data-inspect-id]").first().click();
    await expect(page.locator("[data-inspect-add]")).toBeVisible({ timeout: 10000 });
    await page.locator("[data-inspect-add]").click();
    await expect(page.locator("#shot-event-modal")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#shot-event-modal")).not.toHaveAttribute("hidden", "");
  });
});
