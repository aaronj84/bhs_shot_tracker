import {
  createFriendlyAndOpenTracker,
  expect,
  openTrackerPanel,
  signIn,
  test,
} from "./helpers.mjs";

test.describe("Game Summary tab", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.clear();
      } catch (_) {
        /* ignore */
      }
    });
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test("opens on-demand summary with FOTMOB-style cards after refresh", async ({ page }) => {
    test.setTimeout(90000);
    await signIn(page);
    await createFriendlyAndOpenTracker(page);

    await openTrackerPanel(page, "summary");
    await expect(page.locator("#tracker-summary-panel")).toBeVisible();
    await expect(page.locator("#gs-refresh")).toBeVisible();
    await expect(page.locator("#gs-refreshed-at")).toContainText(/Not refreshed|Last refreshed/i);
    await expect(page.locator(".gs-empty")).toBeVisible();

    await page.locator("#gs-refresh").click();
    await expect(page.locator(".gs-empty")).toHaveCount(0, { timeout: 45000 });
    await expect(page.locator(".gs-period-filters")).toBeVisible();
    await expect(page.locator(".gs-card h2", { hasText: "Top stats" })).toBeVisible();
    await expect(page.locator(".gs-card h2", { hasText: "Attacking zones" })).toBeVisible();
    await expect(page.locator(".gs-card h2", { hasText: /^Shots$/ })).toBeVisible();
    await expect(page.locator(".gs-card h2", { hasText: "Shot map" })).toBeVisible();
    await expect(page.locator(".gs-card h2", { hasText: "Narrative" })).toBeVisible();

    await page.locator('[data-gs-period="1"]').click();
    await expect(page.locator('[data-gs-period="1"]')).toHaveClass(/is-on/);
    await page.locator('[data-gs-period="all"]').click();
    await expect(page.locator('[data-gs-period="all"]')).toHaveClass(/is-on/);
  });
});
