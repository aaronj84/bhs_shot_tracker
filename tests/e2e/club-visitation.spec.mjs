import { test, expect } from "@playwright/test";
import { pin } from "./helpers.mjs";

test.describe("Club Player Visitation Planner", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("top-level Club visits nav opens Agenda shell", async ({ page }) => {
    await page.goto("/#club");
    await expect(page.locator(".club-shell")).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("heading", { name: /Club visits|Staff access/i })).toBeVisible();
    // Tabs or PIN gate both count as module loaded
    const tabs = page.locator(".club-tabs .prep-tab");
    const pinForm = page.locator("#club-pin-form");
    await expect(tabs.or(pinForm).first()).toBeVisible();
  });

  test("drawer includes Club visits destination", async ({ page }) => {
    await page.goto("/#shots");
    await page.locator("#menu-btn").click();
    await expect(page.locator("#nav-drawer a[data-nav='club']")).toBeVisible();
    await page.locator("#nav-drawer a[data-nav='club']").click();
    await expect(page).toHaveURL(/#club/);
    await expect(page.locator(".club-shell")).toBeVisible();
  });

  test("itinerary Add to calendar builds an importable ICS link", async ({ page }) => {
    await page.goto("/#club-itinerary");
    await expect(page.locator(".club-shell")).toBeVisible({ timeout: 15000 });
    const pinInput = page.locator("#club-pin");
    if (await pinInput.isVisible().catch(() => false)) {
      await pinInput.fill(pin);
      await page.locator("#club-pin-form button[type=submit]").click();
      await expect(page.locator(".club-tabs")).toBeVisible({ timeout: 20000 });
    }
    await expect(page).toHaveURL(/#club-itinerary/);
    await expect(page.locator("#club-itin-ics")).toBeHidden();

    const ics = await page.evaluate(() => {
      const { buildItineraryIcs, itineraryIcsFilename } = window.ClubVisitation;
      const body = buildItineraryIcs(
        { id: "e2e", name: "E2E Saturday" },
        [
          {
            game_id: "g1",
            team_line: "Avalanche vs Wasatch",
            brighton_line: "Jackie",
            kickoff_at: "2026-04-11T22:00:00.000Z",
            planned_arrival_at: "2026-04-11T21:40:00.000Z",
            planned_departure_at: "2026-04-11T22:10:00.000Z",
            facility_name: "RAC",
            field_label: "Field 5",
          },
        ]
      );
      return { body, filename: itineraryIcsFilename({ name: "E2E Saturday" }) };
    });
    expect(ics.filename).toBe("e2e-saturday.ics");
    expect(ics.body).toContain("BEGIN:VEVENT");
    expect(ics.body).toContain("LOCATION:RAC · Field 5");
    expect(ics.body).toContain("TRIGGER:-PT15M");
    expect(ics.body).toContain("UID:e2e-g1@bhs-club-visits");
  });
});
