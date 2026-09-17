import { expect, test } from "@playwright/test";
import { createFriendlyAndOpenTracker, recordPlay, signIn } from "./helpers.mjs";

test.describe("Mark game final", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.clear();
      } catch (_) {
        /* ignore */
      }
    });
  });

  test("Mark final freezes the strip to FINAL and lists the game as Final", async ({ page }) => {
    test.setTimeout(90000);
    await signIn(page);
    await createFriendlyAndOpenTracker(page);
    await recordPlay(page, { team: "us", actionId: "goal" });

    await page.locator("[data-score-strip-menu]").click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator('[data-tracker-action="final"]').click();

    await expect(page.locator(".score-clock-face")).toHaveText("FINAL", { timeout: 15000 });
    await expect(page.locator("[data-clock-toggle]")).toBeDisabled();

    await page.goto("/#shots-games");
    await expect(page.locator(".shots-game-list")).toContainText(/ · Final/i, { timeout: 15000 });
  });
});
