/**
 * Prep → Scenarios NL dialogue smoke at iPhone portrait.
 * Full Gemini+Freeman answers need a live edge deploy; this checks the UI shell.
 */
import { test, expect } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

test("Prep Scenarios shows natural-language dialogue", async ({ page }) => {
  await page.goto("/#shots-prep?tab=scenarios");
  await page.getByLabel("PIN").fill("KEPPA");
  await page.getByRole("button", { name: /open tracker/i }).click();

  await expect(page.getByRole("tab", { name: "Scenarios" })).toBeVisible({ timeout: 15000 });
  await expect(page.getByPlaceholder(/what if we beat/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /What if we beat Lone Peak/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Ask$/i })).toBeVisible();

  // No structured opponent/score form
  await expect(page.locator("#scenario-opponent")).toHaveCount(0);
  await expect(page.locator("#scenario-gf")).toHaveCount(0);

  await page.screenshot({
    path: "/opt/cursor/artifacts/scenarios-dialogue-ui.png",
    fullPage: true,
  });

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390 + 1);
});
