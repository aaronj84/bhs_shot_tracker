import {
  createFriendlyAndOpenTracker,
  expect,
  finishTaker,
  openRecordModal,
  recordPlay,
  signIn,
  singleTapPitch,
  test,
} from "./helpers.mjs";

const SHOT_TYPES = [
  { actionId: "goal", log: /Goal/i },
  { actionId: "on-target", log: /Shot on Goal|On Goal/i },
  { actionId: "blocked", log: /Blocked/i },
  { actionId: "missed", missDir: "crossbar", log: /Crossbar/i },
  { actionId: "foul", restartResult: "foul", log: /Free Kick/i },
  { actionId: "foul", restartResult: "goal", log: /Goal/i, name: "free-kick-then-goal" },
  { actionId: "foul", restartResult: "missed", log: /Missed/i, name: "free-kick-then-missed" },
  { actionId: "corner", restartResult: "corner", log: /Corner/i },
  { actionId: "pk-goal", log: /PK Goal/i },
  { actionId: "pk-missed", missDir: "post", log: /Post/i },
];

test.describe("Shot types home and visitor", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.clear();
      } catch (_) {
        /* ignore */
      }
    });
  });

  for (const team of ["us", "opp"]) {
    const side = team === "us" ? "home" : "visitor";
    test(`${side} records every shot type including free kick + shot`, async ({ page }) => {
      test.setTimeout(180000);
      await signIn(page);
      await createFriendlyAndOpenTracker(page);

      for (const kind of SHOT_TYPES) {
        await recordPlay(page, {
          team,
          actionId: kind.actionId,
          restartResult: kind.restartResult,
          missDir: kind.missDir,
        });
        await expect(page.locator("#tracker-log")).toContainText(kind.log, { timeout: 20000 });
      }

      const pills = page.locator("#tracker-log .shot-result-pill");
      // Set piece → shot saves the restart row plus the follow-up shot.
      const expectedPills = SHOT_TYPES.reduce((n, kind) => {
        const setPieceThenShot =
          (kind.actionId === "foul" || kind.actionId === "corner") &&
          kind.restartResult &&
          kind.restartResult !== kind.actionId;
        return n + (setPieceThenShot ? 2 : 1);
      }, 0);
      await expect(pills).toHaveCount(expectedPills);
    });
  }

  test("shot then assist uses Assist after a goal and Setup pass otherwise", async ({ page }) => {
    test.setTimeout(120000);
    await signIn(page);
    await createFriendlyAndOpenTracker(page);

    await openRecordModal(page, "us");
    await expect(page.locator("#shot-modal-title")).toHaveText("Shot or free kick?");
    await expect(page.locator(".shot-action-heading", { hasText: "Shot" })).toBeVisible();
    await expect(page.locator(".shot-action-heading", { hasText: "Set piece" })).toBeVisible();
    await expect(page.locator(".shot-action-heading", { hasText: /^Assist$/ })).toHaveCount(0);
    await page.locator('[data-action-id="goal"]').click();
    await finishTaker(page, "us");
    await expect(page.locator("#shot-modal-title")).toHaveText("Add an assist?");
    await page.locator('[data-offer-link="pass"]').click();
    await expect(page.locator(".tracker-recording-banner")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#tracker-status")).toContainText(/assist came from/i);

    await singleTapPitch(page, "us", 0.35, 0.55);
    await finishTaker(page, "us");
    await expect(page.locator("#shot-modal-title")).toHaveText("Add a second assist?");
    await page.locator("[data-offer-skip]").click();
    await expect(page.locator("#shot-event-modal")).toBeHidden({ timeout: 15000 });
    await expect(page.locator("#tracker-log .shot-result-pill.goal")).toHaveCount(1);
  });

  test("missed shot asks for a setup pass, not an assist", async ({ page }) => {
    test.setTimeout(90000);
    await signIn(page);
    await createFriendlyAndOpenTracker(page);
    await openRecordModal(page, "us");
    await page.locator('[data-action-id="missed"]').click();
    await page.locator('[data-miss-dir="over"]').click();
    await finishTaker(page, "us");
    await expect(page.locator("#shot-modal-title")).toHaveText("Add a setup pass?");
    await expect(page.locator(".shot-action-heading")).toHaveText("Setup pass");
    await page.locator("[data-offer-skip]").click();
    await expect(page.locator("#shot-event-modal")).toBeHidden({ timeout: 15000 });
  });
});
