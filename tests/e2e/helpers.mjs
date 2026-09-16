import { expect } from "@playwright/test";

export const pin = process.env.SHOTS_PIN || "KEPPA";

export async function signIn(page) {
  await page.goto("/#shots");
  await expect(page.locator("#shots-pin")).toBeVisible({ timeout: 15000 });
  await page.fill("#shots-pin", pin);
  await page.click('button:has-text("Open tracker")');
  await expect(page.locator(".shots-admin h1, .tracker-page, .shots-gate h1").first()).toBeVisible({
    timeout: 20000,
  });
}

/** Swap is disabled until a slot has a player (DEV has no Brighton default XI). */
export async function assignTwoUsLineupPlayers(page) {
  const sel = page.locator('select[data-lineup-team="us"][data-lineup-slot="10"]');
  await expect(sel).toBeVisible({ timeout: 15000 });
  const options = sel.locator("option[value]:not([value=''])");
  await expect(options.first()).toBeAttached({ timeout: 20000 });
  const values = await options.evaluateAll((opts) => opts.map((o) => o.value).filter(Boolean));
  expect(values.length).toBeGreaterThanOrEqual(2);
  await sel.selectOption(values[0]);
  await page.locator('select[data-lineup-team="us"][data-lineup-slot="9"]').selectOption(values[1]);
}

/** Tracker records pointerdown, then treats a nearby pointerup as a tap (drag if moved > 14px). */
export async function doubleTapPitch(page, team = "us", fracX = 0.55, fracY = 0.4) {
  const sel = team === "opp" ? "#tracker-pitch-opp .pitch-svg" : "#tracker-pitch-us .pitch-svg";
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const svg = page.locator(sel);
    try {
      await expect(svg).toBeVisible({ timeout: 15000 });
      await svg.scrollIntoViewIfNeeded();
      const box = await svg.boundingBox();
      expect(box).toBeTruthy();
      const clientX = box.x + box.width * fracX;
      const clientY = box.y + box.height * fracY;
      const pointerEvent = (type) =>
        svg.dispatchEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
        });
      await pointerEvent("pointerdown");
      await pointerEvent("pointerup");
      await page.waitForTimeout(120);
      await pointerEvent("pointerdown");
      await pointerEvent("pointerup");
      return;
    } catch (err) {
      lastErr = err;
      await page.waitForTimeout(250);
    }
  }
  throw lastErr;
}

export async function doubleTapUsPitch(page) {
  await doubleTapPitch(page, "us");
}

export async function createFriendlyAndOpenTracker(page) {
  await page.goto("/#shots-games");
  await expect(page.locator("#new-game-form")).toBeVisible({ timeout: 15000 });

  const away = page.locator("#new-game-away");
  await expect(away).toBeVisible();
  const values = await away.locator("option").evaluateAll((opts) =>
    opts.map((o) => ({ value: o.value, text: (o.textContent || "").trim() }))
  );
  const existing = values.find(
    (o) => o.value && o.value !== "__new__" && !/brighton/i.test(o.text) && o.text !== "Select…"
  );
  if (existing) {
    await away.selectOption(existing.value);
  } else {
    await away.selectOption("__new__");
    await expect(page.locator("#new-away-name")).toBeVisible();
    await page.locator("#new-away-name").fill(`E2E Opp ${Date.now()}`);
  }

  await page.locator("#new-game-type").selectOption("friendly");
  await page.locator("#new-game-form button[type=submit]").click();
  await expect(page.locator(".tracker-page")).toBeVisible({ timeout: 20000 });
  await expect(page.locator("#tracker-pitch-us .pitch-svg")).toBeVisible();
  await expect(page.locator("#tracker-pitch-opp .pitch-svg")).toBeVisible();
  await page.waitForTimeout(400);
}

let tapSeq = 0;

export async function openRecordModal(page, team) {
  const modal = page.locator("#shot-event-modal");
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const i = tapSeq;
    tapSeq += 1;
    const fracX = 0.2 + (i % 5) * 0.14;
    const fracY = 0.2 + (Math.floor(i / 5) % 5) * 0.12;
    await doubleTapPitch(page, team, fracX, fracY);
    try {
      await expect(modal).toBeVisible({ timeout: 2500 });
      await expect(modal).not.toHaveAttribute("hidden", "");
      return;
    } catch {
      const inspect = page.locator("[data-inspect-close]");
      if (await inspect.count()) await inspect.first().click();
    }
  }
  throw new Error(`Could not open record modal on ${team} pitch`);
}

async function finishTaker(page, team) {
  const modal = page.locator("#shot-event-modal");
  if (team === "us") {
    await expect(page.locator("#shot-modal-title")).toHaveText("Which position?", { timeout: 10000 });
    await page.locator("[data-pick-position]").first().click();
  } else {
    await expect(modal.locator("[data-player-skip]")).toBeVisible({ timeout: 10000 });
    await modal.locator("[data-player-skip]").click();
  }
}

/**
 * Record one play through the shot modal. `restartResult` is the follow-up after a
 * free kick or corner (`goal`, `missed`, `foul` for FK-only, etc.).
 */
export async function recordPlay(page, { team, actionId, restartResult, missDir = "over" }) {
  const modal = page.locator("#shot-event-modal");
  await openRecordModal(page, team);
  await page.locator(`[data-action-id="${actionId}"]`).click();

  const needsFouler = actionId === "foul" || actionId === "pk-goal" || actionId === "pk-missed";
  if (needsFouler) {
    await expect(page.locator("#shot-modal-title")).toHaveText("Who committed the infringement?", {
      timeout: 10000,
    });
    await modal.locator("[data-player-skip]").click();
  }

  const isRestart = actionId === "foul" || actionId === "corner";
  if (isRestart) {
    await finishTaker(page, team);
    const heading = actionId === "corner" ? "Corner — what next?" : "Free kick — what next?";
    await expect(page.locator("#shot-modal-title")).toHaveText(heading, { timeout: 10000 });
    const outcome = restartResult || actionId;
    await page.locator(`[data-restart-result="${outcome}"]`).click();
    if (outcome === "missed") {
      await expect(page.locator("#shot-modal-title")).toHaveText("Where did it miss?", { timeout: 10000 });
      await page.locator(`[data-miss-dir="${missDir}"]`).click();
    }
  } else {
    if (actionId === "missed" || actionId === "pk-missed") {
      await expect(page.locator("#shot-modal-title")).toHaveText("Where did it miss?", { timeout: 10000 });
      await page.locator(`[data-miss-dir="${missDir}"]`).click();
    }
    await finishTaker(page, team);
  }

  await expect(modal).toBeHidden({ timeout: 15000 });
}
