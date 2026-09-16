import { expect, test } from "@playwright/test";
import { createFriendlyAndOpenTracker, recordPlay, signIn } from "./helpers.mjs";

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
      await expect(pills).toHaveCount(SHOT_TYPES.length);
    });
  }
});
