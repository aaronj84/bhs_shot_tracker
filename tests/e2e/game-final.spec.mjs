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
    // Wait for the play to land so a late save redraw does not close the menu mid-click.
    await expect(page.locator("#tracker-log .shot-result-pill.goal")).toBeVisible({ timeout: 20000 });

    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("[data-score-strip-menu]").click();
    const finalBtn = page.locator('[data-tracker-action="final"]');
    await expect(finalBtn).toBeVisible({ timeout: 5000 });
    await finalBtn.click();

    await expect(page.locator(".score-clock-face")).toHaveText("FINAL", { timeout: 15000 });
    await expect(page.locator("[data-clock-toggle]")).toBeDisabled();

    await page.goto("/#shots-games");
    await expect(page.locator(".shots-game-list")).toContainText(/ · Final/i, { timeout: 15000 });
  });
});
