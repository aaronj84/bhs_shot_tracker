import { expect, pickGateTeam, pin, signIn, test } from "./helpers.mjs";

test.describe("Staff PIN gate team switch", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch (_) {
        /* ignore */
      }
    });
  });

  test("gate lists teams and unlocks the selected program", async ({ page }) => {
    await page.goto("/#shots");
    await expect(page.locator("#shots-pin")).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".shots-gate-team-btn").first()).toBeVisible({ timeout: 15000 });
    await pickGateTeam(page, "Brighton");
    await page.fill("#shots-pin", "not-the-pin");
    await page.click('button:has-text("Open tracker")');
    await expect(page.locator(".shots-error")).toHaveText(/Wrong PIN/i);
    await page.fill("#shots-pin", pin);
    await page.click('button:has-text("Open tracker")');
    await expect(page.locator("#shots-pin")).toHaveCount(0);
    await expect(page.locator(".shots-admin h1, .tracker-page").first()).toBeVisible({ timeout: 20000 });
  });

  test("switching teams after unlock returns to the PIN gate", async ({ page }) => {
    await signIn(page);
    await page.locator("#menu-btn").click();
    const other = page.locator("#nav-team-pick .nav-team-btn:not(.is-active)").first();
    if (!(await other.count())) {
      test.skip(true, "Only one owned team in DEV — cannot exercise re-gate switch");
      return;
    }
    await other.click();
    await expect(page.locator("#shots-pin")).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".shots-gate-team-btn.is-active")).toBeVisible();
  });
});
