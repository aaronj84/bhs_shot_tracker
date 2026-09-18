import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseMigrationFilename,
  loadLocalMigrations,
  classifyMigrations,
  pendingUps,
  rollbackPlan,
  extractJsonObject,
  remoteRowsFromQuery,
  isProdProject,
  missingDowns,
  formatStatusTable,
} from "../../scripts/lib/migrate.mjs";

function writePair(root, version, name, { down = true } = {}) {
  const upDir = path.join(root, "supabase", "migrations");
  const downDir = path.join(root, "supabase", "down");
  mkdirSync(upDir, { recursive: true });
  mkdirSync(downDir, { recursive: true });
  writeFileSync(path.join(upDir, `${version}_${name}.sql`), `-- up ${name}\n`);
  if (down) {
    writeFileSync(path.join(downDir, `${version}_${name}.sql`), `-- down ${name}\n`);
  }
}

describe("parseMigrationFilename", () => {
  it("parses timestamp + name", () => {
    expect(parseMigrationFilename("20260916120000_miss_woodwork.sql")).toEqual({
      version: "20260916120000",
      name: "miss_woodwork",
      filename: "20260916120000_miss_woodwork.sql",
    });
  });

  it("ignores unrelated files", () => {
    expect(parseMigrationFilename("README.md")).toBeNull();
    expect(parseMigrationFilename("20260916120000_miss_woodwork.down.sql")).toBeNull();
    expect(parseMigrationFilename("fix_shots.sql")).toBeNull();
  });
});

describe("loadLocalMigrations", () => {
  it("pairs ups with downs and reports missing downs", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bhs-migrate-"));
    try {
      writePair(root, "20260831100000", "baseline_schema");
      writePair(root, "20260916120000", "miss_woodwork", { down: false });
      const local = loadLocalMigrations(root);
      expect(local.map((row) => row.name)).toEqual(["baseline_schema", "miss_woodwork"]);
      expect(local[0].downPath).toContain(`${path.sep}down${path.sep}`);
      expect(local[1].downPath).toBeNull();
      expect(missingDowns(local).map((row) => row.name)).toEqual(["miss_woodwork"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("classifyMigrations", () => {
  const local = [
    {
      version: "20260831100000",
      name: "baseline_schema",
      upPath: "up/a.sql",
      downPath: "down/a.sql",
    },
    {
      version: "20260913140000",
      name: "mp_maxpreps",
      upPath: "up/b.sql",
      downPath: "down/b.sql",
    },
    {
      version: "20260916120000",
      name: "miss_woodwork",
      upPath: "up/c.sql",
      downPath: "down/c.sql",
    },
  ];

  it("treats matching versions as applied and name matches as aliases", () => {
    const classified = classifyMigrations(local, [
      { version: "20260831100000", name: "baseline_schema" },
      { version: "20260913145733", name: "mp_maxpreps" },
    ]);
    expect(classified.rows.map((row) => row.status)).toEqual([
      "applied",
      "alias",
      "pending",
    ]);
    expect(pendingUps(classified).map((row) => row.name)).toEqual(["miss_woodwork"]);
    expect(classified.remoteOnly).toEqual([]);
  });

  it("surfaces remote-only versions that have no local name", () => {
    const classified = classifyMigrations(local, [
      { version: "20260831100000", name: "baseline_schema" },
      { version: "20990101000000", name: "mystery" },
    ]);
    expect(classified.remoteOnly).toEqual([
      { version: "20990101000000", name: "mystery", status: "remote-only" },
    ]);
  });

  it("limits pending ups", () => {
    const classified = classifyMigrations(local, []);
    expect(pendingUps(classified, 1).map((row) => row.name)).toEqual(["baseline_schema"]);
  });
});

describe("rollbackPlan", () => {
  it("rolls back newest applied first using the remote version", () => {
    const classified = classifyMigrations(
      [
        {
          version: "20260913140000",
          name: "mp_maxpreps",
          downPath: "down/mp.sql",
        },
        {
          version: "20260916120000",
          name: "miss_woodwork",
          downPath: "down/miss.sql",
        },
      ],
      [
        { version: "20260913145733", name: "mp_maxpreps" },
        { version: "20260916120000", name: "miss_woodwork" },
      ]
    );
    const plan = rollbackPlan(classified, 2);
    expect(plan.map((row) => row.repairVersion)).toEqual([
      "20260916120000",
      "20260913145733",
    ]);
    expect(plan[1].downPath).toBe("down/mp.sql");
  });
});

describe("helpers", () => {
  it("extracts JSON mixed with CLI chatter", () => {
    const payload = extractJsonObject(
      'Initialising login role...\n{"rows":[{"version":"1","name":"a"}]}\nA new version of Supabase CLI\n'
    );
    expect(remoteRowsFromQuery(payload)).toEqual([{ version: "1", name: "a" }]);
  });

  it("recognizes prod", () => {
    expect(isProdProject("sczdnalqmymhdornhkbn")).toBe(true);
    expect(isProdProject("fmiymqnfezkqagpbrmoi")).toBe(false);
  });

  it("renders a status table", () => {
    const classified = classifyMigrations(
      [{ version: "20260831100000", name: "baseline_schema", downPath: "x" }],
      [{ version: "20260831100000", name: "baseline_schema" }]
    );
    expect(formatStatusTable(classified)).toContain("baseline_schema");
    expect(formatStatusTable(classified)).toContain("yes");
  });
});

describe("repo migrations", () => {
  it("pairs every committed up with a down", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const local = loadLocalMigrations(root);
    expect(local.length).toBeGreaterThan(0);
    expect(missingDowns(local)).toEqual([]);
  });
});
