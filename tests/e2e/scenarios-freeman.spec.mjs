/**
 * Prep → Scenarios (Freeman what-if) smoke at iPhone portrait.
 * Uses placeholder config + local demo PIN session + bundled Freeman math.
 */
import { test, expect } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

test("Prep Scenarios add and swap produce Freeman seed deltas", async ({ page }) => {
  await page.goto("/#shots-prep?tab=scenarios");
  await page.getByLabel("PIN").fill("KEPPA");
  await page.getByRole("button", { name: /open tracker/i }).click();

  await expect(page.getByRole("tab", { name: "Scenarios" })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("heading", { name: /what if/i })).toBeVisible();

  // Add: beat Lone Peak 2-1
  await page.getByRole("button", { name: /add a result/i }).click();
  await page.locator("#scenario-opponent").fill("Lone Peak");
  await page.locator("#scenario-gf").fill("2");
  await page.locator("#scenario-ga").fill("1");
  await page.getByRole("button", { name: /run scenario/i }).click();
  await expect(page.getByText(/Freeman outcome/i)).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/Seed/i).first()).toBeVisible();
  await page.screenshot({
    path: "/opt/cursor/artifacts/scenarios-add-lone-peak.png",
    fullPage: true,
  });

  // Swap: drop Orem win for Lone Peak 1-2 loss
  await page.getByRole("button", { name: /swap a result/i }).click();
  await page.locator("#scenario-drop").fill("Orem");
  await page.locator("#scenario-add").fill("Lone Peak");
  await page.locator("#scenario-gf").fill("1");
  await page.locator("#scenario-ga").fill("2");
  await page.getByRole("button", { name: /run scenario/i }).click();
  await expect(page.getByText(/Freeman outcome/i)).toBeVisible({ timeout: 15000 });
  await page.screenshot({
    path: "/opt/cursor/artifacts/scenarios-swap-orem-lone-peak.png",
    fullPage: true,
  });

  // No horizontal overflow at phone width
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390 + 1);
});
