import { describe, expect, it } from "vitest";
import {
  normalizePin,
  defaultPin,
  pinForTeam,
  pinMatches,
  readUnlock,
  writeUnlock,
  clearUnlock,
  unlockCoversTeam,
  UNLOCK_KEY,
} from "../../staff-access.js";

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

describe("staff-access", () => {
  it("normalizes pins", () => {
    expect(normalizePin(" keppa ")).toBe("KEPPA");
    expect(normalizePin("")).toBe("");
  });

  it("uses default pin when team has no override", () => {
    const cfg = { pin: "KEPPA", teamPins: { "CFC G10 BD": "cotton" } };
    expect(defaultPin(cfg)).toBe("KEPPA");
    expect(pinForTeam(cfg, { id: "b1", name: "Brighton" })).toBe("KEPPA");
    expect(pinMatches(cfg, { name: "Brighton" }, "keppa")).toBe(true);
    expect(pinMatches(cfg, { name: "Brighton" }, "cotton")).toBe(false);
  });

  it("resolves teamPins by name then id", () => {
    const cfg = {
      pin: "KEPPA",
      teamPins: {
        "CFC G10 BD": "cotton",
        "uuid-cfc": "by-id",
      },
    };
    expect(pinForTeam(cfg, { id: "other", name: "CFC G10 BD" })).toBe("COTTON");
    expect(pinForTeam(cfg, { id: "uuid-cfc", name: "CFC G10 BD" })).toBe("BY-ID");
    expect(pinMatches(cfg, { name: "CFC G10 BD" }, "cotton")).toBe(true);
    expect(pinMatches(cfg, { name: "CFC G10 BD" }, "keppa")).toBe(false);
  });

  it("persists unlock coverage per team", () => {
    const store = memoryStorage();
    expect(readUnlock(store)).toBe(null);
    writeUnlock({ id: "cfc", name: "CFC G10 BD" }, store);
    expect(store.getItem(UNLOCK_KEY)).toContain("cfc");
    const unlock = readUnlock(store);
    expect(unlockCoversTeam(unlock, { id: "cfc", name: "CFC G10 BD" })).toBe(true);
    expect(unlockCoversTeam(unlock, { id: "bri", name: "Brighton" })).toBe(false);
    clearUnlock(store);
    expect(readUnlock(store)).toBe(null);
  });
});
