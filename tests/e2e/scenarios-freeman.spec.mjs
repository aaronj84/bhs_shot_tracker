/**
 * Prep → Scenarios NL dialogue smoke at iPhone portrait.
 * Full Gemini+Freeman answers need a live edge deploy; this checks the UI shell
 * and the MaxPreps freshness gate (mp-refresh is mocked).
 */
import { test, expect } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

const FRESH = {
  ok: true,
  state: "fresh",
  fresh: true,
  last_ok_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
  last_game_on: "2026-10-03",
  can_refresh: true,
};

function mockRefresh(page, handler) {
  return page.route("**/functions/v1/mp-refresh", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 200, body: "ok" });
    const body = route.request().postDataJSON() || {};
    const { status = 200, json } = handler(body);
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(json) });
  });
}

async function openScenarios(page) {
  await page.goto("/#shots-prep?tab=scenarios");
  await page.getByLabel("PIN").fill("KEPPA");
  await page.getByRole("button", { name: /open tracker/i }).click();
  await expect(page.getByRole("tab", { name: "Scenarios" })).toBeVisible({ timeout: 15000 });
}

test("Prep Scenarios shows natural-language dialogue", async ({ page }) => {
  await mockRefresh(page, () => ({ json: FRESH }));
  await openScenarios(page);

  await expect(page.getByPlaceholder(/what if we beat/i)).toBeEnabled();
  await expect(page.getByRole("button", { name: /What if we beat Lone Peak/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Ask$/i })).toBeEnabled();
  await expect(page.getByText(/MaxPreps data updated 2 hr ago · games through Oct 3/)).toBeVisible();

  // No structured opponent/score form
  await expect(page.locator("#scenario-opponent")).toHaveCount(0);
  await expect(page.locator("#scenario-gf")).toHaveCount(0);

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390 + 1);
});

test("Scenarios waits behind a modal while stale MaxPreps data refreshes", async ({ page }) => {
  test.setTimeout(60000);
  let polls = 0;
  await mockRefresh(page, (body) => {
    if (body.action === "start") {
      return {
        json: {
          ...FRESH,
          state: "running",
          fresh: false,
          started: true,
          requested_at: new Date().toISOString(),
          last_game_on: "2026-09-12",
          scrape_run: { status: "in_progress" },
        },
      };
    }
    if (body.since) {
      polls += 1;
      return { json: { ...FRESH, last_ok_at: new Date().toISOString() } };
    }
    return { json: { ...FRESH, state: "stale", fresh: false, last_game_on: "2026-09-12" } };
  });
  await openScenarios(page);

  const modal = page.getByRole("dialog", { name: /pull and save the latest scores/i });
  await expect(modal).toBeVisible();
  await expect(modal.getByText(/Reading MaxPreps scoreboards/)).toBeVisible();
  await expect(modal.getByText(/games through Sep 12/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Ask$/i })).toBeDisabled();

  const box = await modal.locator(".modal-panel").boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/scenarios-refresh-modal.png" });

  await expect(modal).toBeHidden({ timeout: 20000 });
  expect(polls).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: /^Ask$/i })).toBeEnabled();
});

test("Scenarios stays closed with a retry when the refresh cannot start", async ({ page }) => {
  await mockRefresh(page, (body) =>
    body.action === "start"
      ? { status: 500, json: { error: "MP_REFRESH_GITHUB_TOKEN is not configured" } }
      : { json: { ...FRESH, state: "stale", fresh: false, last_game_on: "2026-09-12" } },
  );
  await openScenarios(page);

  const modal = page.getByRole("alertdialog", { name: /Couldn’t update MaxPreps data/ });
  await expect(modal).toBeVisible();
  await expect(modal.getByText(/MP_REFRESH_GITHUB_TOKEN secret is missing/)).toBeVisible();
  await expect(modal.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Ask$/i })).toBeDisabled();
  await page.screenshot({ path: "test-results/scenarios-refresh-failed.png" });
});
