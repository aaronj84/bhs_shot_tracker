import { test, expect } from "@playwright/test";

test.describe("Club Player Visitation Planner", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("top-level Club visits nav opens Agenda shell", async ({ page }) => {
    await page.goto("/#club");
    await expect(page.locator(".club-shell")).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("heading", { name: /Club visits|Staff access/i })).toBeVisible();
    // Tabs or PIN gate both count as module loaded
    const tabs = page.locator(".club-tabs .prep-tab");
    const pin = page.locator("#club-pin-form");
    await expect(tabs.or(pin).first()).toBeVisible();
  });

  test("drawer includes Club visits destination", async ({ page }) => {
    await page.goto("/#shots");
    await page.locator("#menu-btn").click();
    await expect(page.locator("#nav-drawer a[data-nav='club']")).toBeVisible();
    await page.locator("#nav-drawer a[data-nav='club']").click();
    await expect(page).toHaveURL(/#club/);
    await expect(page.locator(".club-shell")).toBeVisible();
  });
});
