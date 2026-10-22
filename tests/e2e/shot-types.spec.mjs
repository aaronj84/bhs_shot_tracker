import {
  alternatingRecordingTeam,
  createFriendlyAndOpenTracker,
  expect,
  finishTaker,
  openRecordModal,
  pickMissDirection,
  recordPlay,
  signIn,
  teamSideLabel,
  test,
} from "./helpers.mjs";

/** Core paths only — full matrix was slow and flaky against live DEV. */
const CORE_SHOT_TYPES = [
  { actionId: "goal", log: /Goal/i },
  { actionId: "on-target", log: /Shot on Goal|On Goal/i },
  { actionId: "missed", missDir: "crossbar", log: /Crossbar/i },
  { actionId: "foul", restartResult: "foul", log: /Free Kick/i },
  { actionId: "foul", restartResult: "goal", log: /Goal/i },
  { actionId: "corner", restartResult: "corner", log: /Corner/i },
  { actionId: "pk-goal", log: /PK Goal/i },
];

test.describe("Shot types", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.clear();
      } catch (_) {
        /* ignore */
      }
    });
  });

  test("records core shot types on alternating home/visitor", async ({ page }) => {
    test.setTimeout(180000);
    const team = alternatingRecordingTeam();
    const side = teamSideLabel(team);
    test.info().annotations.push({ type: "team", description: side });

    await signIn(page);
    await createFriendlyAndOpenTracker(page);

    for (const kind of CORE_SHOT_TYPES) {
      await recordPlay(page, {
        team,
        actionId: kind.actionId,
        restartResult: kind.restartResult,
        missDir: kind.missDir,
      });
      await expect(page.locator("#tracker-log")).toContainText(kind.log, { timeout: 20000 });
    }

    const pills = page.locator("#tracker-log .shot-result-pill");
    const expectedPills = CORE_SHOT_TYPES.reduce((n, kind) => {
      const setPieceThenShot =
        (kind.actionId === "foul" || kind.actionId === "corner") &&
        kind.restartResult &&
        kind.restartResult !== kind.actionId;
      return n + (setPieceThenShot ? 2 : 1);
    }, 0);
    await expect(pills).toHaveCount(expectedPills);
  });

  test("shot then assist uses Assist after a goal and Setup pass otherwise", async ({ page }) => {
    test.setTimeout(90000);
    await signIn(page);
    await createFriendlyAndOpenTracker(page);

    await openRecordModal(page, "us");
    await expect(page.locator("#shot-modal-title")).toHaveText("Shot or free kick?");
    await page.locator('[data-action-id="goal"]').click();
    await finishTaker(page, "us");
    await expect(page.locator("#shot-modal-title")).toHaveText("Add an assist?");
    await page.locator("[data-offer-skip]").click();
    await expect(page.locator("#shot-event-modal")).toBeHidden({ timeout: 15000 });

    await openRecordModal(page, "us");
    await page.locator('[data-action-id="missed"]').click();
    await pickMissDirection(page, "over");
    await finishTaker(page, "us");
    await expect(page.locator("#shot-modal-title")).toHaveText("Add a setup pass?");
    await page.locator("[data-offer-skip]").click();
    await expect(page.locator("#shot-event-modal")).toBeHidden({ timeout: 15000 });
  });

  test("free kick shot is taken from the free kick spot without a second tap", async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await createFriendlyAndOpenTracker(page);
    await openRecordModal(page, "us");
    await page.locator('[data-action-id="foul"]').click();
    await page.locator("#shot-event-modal [data-player-skip]").click();
    await finishTaker(page, "us");
    await page.locator('[data-setpiece-follow="shot"]').click();
    await expect(page.locator("#shot-modal-title")).toHaveText("Free kick shot result?");
    await expect(page.locator(".tracker-recording-banner")).toBeHidden();
    await page.locator('[data-restart-result="goal"]').click();
    await expect(page.locator("#shot-event-modal")).toBeHidden({ timeout: 15000 });
    await expect(page.locator("#tracker-log .shot-result-pill.goal")).toHaveCount(1);
    await expect(page.locator("#tracker-log")).toContainText(/Free Kick/i);
  });
});
