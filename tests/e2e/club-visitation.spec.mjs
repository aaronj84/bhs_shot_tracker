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

  test("itinerary Add to calendar prefers iOS share sheet", async ({ page }) => {
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
      const { buildItineraryIcs, itineraryIcsFilename, icsDataUrl } = window.ClubVisitation;
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
            lat: 40.5,
            lng: -112,
          },
        ]
      );
      const dataUrl = icsDataUrl(body);
      return {
        body,
        filename: itineraryIcsFilename({ name: "E2E Saturday" }),
        dataUrlPrefix: dataUrl.slice(0, "data:text/calendar;charset=utf-8;base64,".length),
      };
    });
    expect(ics.filename).toBe("e2e-saturday.ics");
    expect(ics.body).toContain("BEGIN:VEVENT");
    expect(ics.body).toContain("LOCATION:RAC · Field 5");
    expect(ics.body).toContain("TRIGGER:-PT15M");
    expect(ics.body).toContain("UID:e2e-g1@bhs-club-visits");
    expect(ics.body).toMatch(/URL:https:\/\/www\.google\.com\/maps/);
    expect(ics.dataUrlPrefix).toBe("data:text/calendar;charset=utf-8;base64,");

    await page.addInitScript(() => {
      Object.defineProperty(navigator, "userAgent", {
        get: () =>
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      });
      Object.defineProperty(navigator, "platform", { get: () => "iPhone" });
    });
    await page.goto("/#club-itinerary");
    if (await page.locator("#club-pin").isVisible().catch(() => false)) {
      await page.locator("#club-pin").fill(pin);
      await page.locator("#club-pin-form button[type=submit]").click();
      await expect(page.locator(".club-tabs")).toBeVisible({ timeout: 20000 });
    }

    const shared = await page.evaluate(async () => {
      const body = window.ClubVisitation.buildItineraryIcs(
        { id: "ios", name: "iOS test" },
        [
          {
            game_id: "g1",
            team_line: "A vs B",
            kickoff_at: "2026-04-11T22:00:00.000Z",
            planned_arrival_at: "2026-04-11T21:40:00.000Z",
            planned_departure_at: "2026-04-11T22:10:00.000Z",
            facility_name: "RAC",
          },
        ]
      );
      const filename = window.ClubVisitation.itineraryIcsFilename({ name: "iOS test" });
      let sharedFile = null;
      navigator.canShare = () => true;
      navigator.share = async (data) => {
        sharedFile = data?.files?.[0] || null;
      };
      const ok = await window.ClubVisitation.tryIcsShare(body, filename);
      return {
        ok,
        name: sharedFile?.name || "",
        type: sharedFile?.type || "",
      };
    });
    expect(shared.ok).toBe(true);
    expect(shared.name).toBe("ios-test.ics");
    expect(shared.type).toMatch(/calendar|octet-stream/);
  });
});
