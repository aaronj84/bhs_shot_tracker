import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

export { expect };

export const pin = process.env.SHOTS_PIN || "KEPPA";

const createdGameIds = [];
const createdTeamNames = [];
let e2eClientPromise;

function loadSupabaseCreds() {
  let url = process.env.SHOTS_SUPABASE_URL || "";
  let anon = process.env.SHOTS_SUPABASE_ANON_KEY || "";
  if (url && anon) return { url, anon };
  try {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "shots-config.js"), "utf8");
    url = url || (src.match(/supabaseUrl:\s*"([^"]+)"/) || [])[1] || "";
    anon = anon || (src.match(/supabaseAnonKey:\s*"([^"]+)"/) || [])[1] || "";
  } catch {
    /* no local config */
  }
  return { url, anon };
}

async function e2eClient() {
  if (e2eClientPromise) return e2eClientPromise;
  e2eClientPromise = (async () => {
    const { url, anon } = loadSupabaseCreds();
    if (!url || !anon) return null;
    // Node 20 has no native WebSocket; we only need REST deletes, not realtime.
    const sb = createClient(url, anon, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { transport: class NoopWebSocket {} },
    });
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const { error } = await sb.auth.signInAnonymously();
      if (!error) return sb;
      lastErr = error;
      if (!/rate limit/i.test(error.message || "") || attempt === 3) break;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    throw new Error(`e2e cleanup auth failed: ${lastErr.message}`);
  })();
  try {
    return await e2eClientPromise;
  } catch (err) {
    e2eClientPromise = undefined;
    throw err;
  }
}

export async function deleteCreatedE2EGames() {
  const ids = createdGameIds.splice(0, createdGameIds.length);
  const teamNames = createdTeamNames.splice(0, createdTeamNames.length);
  if (!ids.length && !teamNames.length) return;
  const sb = await e2eClient();
  if (!sb) {
    console.warn(
      "e2e cleanup skipped: set SHOTS_SUPABASE_URL and SHOTS_SUPABASE_ANON_KEY (or write shots-config.js)"
    );
    return;
  }
  if (ids.length) {
    const { error } = await sb.from("games").delete().in("id", ids);
    if (error) throw new Error(`e2e game cleanup failed: ${error.message}`);
  }
  if (teamNames.length) {
    const { error } = await sb.from("teams").delete().in("name", teamNames);
    if (error) throw new Error(`e2e team cleanup failed: ${error.message}`);
  }
}

/** Auto-deletes games (and any E2E Opp teams) created during the test. */
export const test = base.extend({
  _e2eGameCleanup: [
    async ({}, use) => {
      await use();
      await deleteCreatedE2EGames();
    },
    { auto: true },
  ],
});

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

export async function doubleTapUsPitch(page, fracX = 0.55, fracY = 0.4) {
  return doubleTapPitch(page, "us", fracX, fracY);
}

export async function singleTapPitch(page, team = "us", fracX = 0.48, fracY = 0.32) {
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
      return;
    } catch (err) {
      lastErr = err;
      await page.waitForTimeout(250);
    }
  }
  throw lastErr;
}

export async function startCornerFromFlag(page, team, side = "left") {
  const btn = page.locator(`[data-record-corner="${side}"][data-record-team="${team}"]`);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  const modal = page.locator("#shot-event-modal");
  await expect(modal).toBeVisible({ timeout: 10000 });
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
    const teamName = `E2E Opp ${Date.now()}`;
    createdTeamNames.push(teamName);
    await away.selectOption("__new__");
    await expect(page.locator("#new-away-name")).toBeVisible();
    await page.locator("#new-away-name").fill(teamName);
  }

  await page.locator("#new-game-type").selectOption("friendly");
  await page.locator("#new-game-form button[type=submit]").click();
  await expect(page.locator(".tracker-page")).toBeVisible({ timeout: 20000 });
  await page.waitForFunction(() => !!sessionStorage.getItem("shots-game-id"), null, { timeout: 10000 });
  const gameId = await page.evaluate(() => sessionStorage.getItem("shots-game-id"));
  expect(gameId).toBeTruthy();
  createdGameIds.push(gameId);
  await expect(page.locator("#tracker-pitch-us .pitch-svg")).toBeVisible();
  await expect(page.locator("#tracker-pitch-opp .pitch-svg")).toBeVisible();
  await page.waitForTimeout(400);
  return gameId;
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

export async function finishTaker(page, team) {
  const modal = page.locator("#shot-event-modal");
  if (team === "us") {
    await expect(page.locator("#shot-modal-title")).toHaveText("Which position?", { timeout: 10000 });
    await page.locator("[data-pick-position]").first().click();
  } else {
    await expect(modal.locator("[data-player-skip]")).toBeVisible({ timeout: 10000 });
    await modal.locator("[data-player-skip]").click();
  }
}

const LINK_SHOT_RESULTS = new Set(["goal", "on-target", "blocked", "missed"]);

export async function skipLinkedPlayIfAsked(page) {
  const title = page.locator("#shot-modal-title");
  const modal = page.locator("#shot-event-modal");
  await expect(modal).toBeVisible({ timeout: 10000 });
  const text = (await title.textContent()) || "";
  if (!/Add an assist|Add a setup pass|Add a second/i.test(text)) return false;
  await page.locator("[data-offer-skip]").click();
  return true;
}

/**
 * Record one play through the shot modal. `restartResult` is the follow-up after a
 * free kick or corner (`foul`/`corner` for set-piece only; shot results use the
 * Shot path with a second tap and auto-link the set piece as assist).
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

  const outcome = restartResult || actionId;
  if (actionId === "foul" || actionId === "corner") {
    await finishTaker(page, team);
    const heading = actionId === "corner" ? "Corner — what next?" : "Free kick — what next?";
    const onlyResult = actionId === "corner" ? "corner" : "foul";
    await expect(page.locator("#shot-modal-title")).toHaveText(heading, { timeout: 10000 });
    if (!restartResult || restartResult === onlyResult) {
      await page.locator('[data-setpiece-follow="none"]').click();
    } else {
      await page.locator('[data-setpiece-follow="shot"]').click();
      await expect(page.locator("#shot-event-modal")).toBeHidden({ timeout: 15000 });
      await expect(page.locator(".tracker-recording-banner")).toBeVisible({ timeout: 10000 });
      await singleTapPitch(page, team, 0.5, 0.3);
      await expect(page.locator("#shot-event-modal")).toBeVisible({ timeout: 10000 });
      await expect(page.locator("#shot-modal-title")).toHaveText("Shot result?", { timeout: 10000 });
      await page.locator(`[data-action-id="${restartResult === "on-target" ? "on-target" : restartResult}"]`).click();
      if (restartResult === "missed") {
        await expect(page.locator("#shot-modal-title")).toHaveText("Where did it miss?", { timeout: 10000 });
        await page.locator(`[data-miss-dir="${missDir}"]`).click();
      }
      await finishTaker(page, team);
      const secondLink = restartResult === "goal" ? "Add a second assist?" : "Add a second setup pass?";
      await expect(page.locator("#shot-modal-title")).toHaveText(secondLink, { timeout: 10000 });
      await page.locator("[data-offer-skip]").click();
    }
    await expect(modal).toBeHidden({ timeout: 15000 });
    return;
  }

  if (actionId === "missed" || actionId === "pk-missed") {
    await expect(page.locator("#shot-modal-title")).toHaveText("Where did it miss?", { timeout: 10000 });
    await page.locator(`[data-miss-dir="${missDir}"]`).click();
  }
  await finishTaker(page, team);

  if (LINK_SHOT_RESULTS.has(outcome)) {
    const expected = outcome === "goal" ? "Add an assist?" : "Add a setup pass?";
    await expect(page.locator("#shot-modal-title")).toHaveText(expected, { timeout: 10000 });
    await page.locator("[data-offer-skip]").click();
  }

  await expect(modal).toBeHidden({ timeout: 15000 });
}
