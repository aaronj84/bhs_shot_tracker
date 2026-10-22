import {
  alternatingRecordingTeam,
  createFriendlyAndOpenTracker,
  expect,
  finishTaker,
  recordPlay,
  signIn,
  singleTapPitch,
  startCornerFromFlag,
  teamSideLabel,
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

  test("a shot off a long corner uses the corner as the assist / setup pass", async ({ page }) => {
    test.setTimeout(90000);
    const team = alternatingRecordingTeam();
    test.info().annotations.push({ type: "team", description: teamSideLabel(team) });

    await signIn(page);
    await createFriendlyAndOpenTracker(page);

    await startCornerFromFlag(page, team, "right");
    await finishTaker(page, team);
    await expect(page.locator("#shot-modal-title")).toHaveText("What type of corner?");
    await page.locator('[data-corner-type="long"]').click();
    await expect(page.locator("#shot-modal-title")).toHaveText(/after the long pass/i);
    await page.locator('[data-setpiece-follow="shot"]').click();
    await expect(page.locator("#shot-event-modal")).toBeHidden({ timeout: 15000 });
    await expect(page.locator("#tracker-log")).toContainText(/Corner/i, { timeout: 20000 });
    await expect(page.locator(".tracker-recording-banner")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#tracker-status")).toContainText(/tap where the shot/i);

    await singleTapPitch(page, team, 0.5, 0.3);
    await expect(page.locator("#shot-event-modal")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#shot-modal-title")).toHaveText("Shot result?", { timeout: 10000 });
    await page.locator('[data-action-id="goal"]').click();
    await finishTaker(page, team);
    await expect(page.locator("#shot-event-modal")).toBeHidden({ timeout: 15000 });
    await expect(page.locator("#tracker-log .shot-result-pill.corner")).toHaveCount(1);
    await expect(page.locator("#tracker-log .shot-result-pill.goal")).toHaveCount(1);
    await expect(page.locator("#tracker-log")).toContainText(/Long/i);
  });

  test("corner taken as a direct shot records shot result from the flag", async ({ page }) => {
    test.setTimeout(90000);
    const team = alternatingRecordingTeam();
    test.info().annotations.push({ type: "team", description: teamSideLabel(team) });

    await signIn(page);
    await createFriendlyAndOpenTracker(page);

    await startCornerFromFlag(page, team, "left");
    await finishTaker(page, team);
    await page.locator('[data-corner-type="shot"]').click();
    await expect(page.locator("#shot-modal-title")).toHaveText("Shot result?");
    await expect(page.locator(".tracker-recording-banner")).toBeHidden();
    await page.locator('[data-restart-result="goal"]').click();
    await expect(page.locator("#shot-event-modal")).toBeHidden({ timeout: 15000 });
    await expect(page.locator("#tracker-log .shot-result-pill.corner")).toHaveCount(1);
    await expect(page.locator("#tracker-log .shot-result-pill.goal")).toHaveCount(1);
  });

  test("inspect popup can add another play on an occupied shot mark", async ({ page }) => {
    test.setTimeout(90000);
    await signIn(page);
    await createFriendlyAndOpenTracker(page);

    // Use a shot (visible in default shots-only mode), not a corner square.
    await recordPlay(page, { team: "us", actionId: "goal" });
    await expect(page.locator("#tracker-log .shot-result-pill.goal")).toHaveCount(1, { timeout: 20000 });
    await expect(page.locator("#tracker-pitch-us [data-inspect-id]")).toBeVisible({ timeout: 15000 });

    await page.locator("#tracker-pitch-us [data-inspect-id]").first().click();
    await expect(page.locator("[data-inspect-add]")).toBeVisible({ timeout: 10000 });
    await page.locator("[data-inspect-add]").click();
    await expect(page.locator("#shot-event-modal")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#shot-event-modal")).not.toHaveAttribute("hidden", "");
  });
});
