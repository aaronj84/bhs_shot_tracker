#!/usr/bin/env node
/**
 * Apply or roll back timestamped SQL migrations on the linked Supabase database.
 *
 *   node scripts/migrate.mjs status
 *   node scripts/migrate.mjs up [--dry-run] [--limit N]
 *   node scripts/migrate.mjs down [N] [--dry-run] --yes
 *   node scripts/migrate.mjs new <name>
 *   node scripts/migrate.mjs sync-history [--dry-run] --yes
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  loadLocalMigrations,
  missingDowns,
  classifyMigrations,
  pendingUps,
  rollbackPlan,
  formatStatusTable,
  extractJsonObject,
  remoteRowsFromQuery,
  isProdProject,
} from "./lib/migrate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HISTORY_SQL =
  "select version, name from supabase_migrations.schema_migrations order by version";
const BOOTSTRAP_HISTORY_SQL = `
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  statements text[],
  name text,
  created_by text,
  idempotency_key text,
  rollback text[]
);
`.trim();

function printHelp() {
  process.stdout.write(`Usage: node scripts/migrate.mjs <command> [options]

Commands:
  status                 Show local files vs versions on the linked database
  up [--limit N]         Apply pending ups (missing versions / names)
  down [N]               Run the last N downs (default 1) and mark reverted
  new <name>             Scaffold a matching up + down pair
  sync-history           Rewrite remote timestamps that match a local name

Options:
  --dry-run              Print the plan; do not execute SQL
  --yes, -y              Required for down and sync-history
  --allow-prod           Allow down / sync-history against PROD
  --project-ref <ref>    Target a project instead of the currently linked one
  -h, --help             Show this help

Ups:  supabase/migrations/<version>_<name>.sql
Downs: supabase/down/<version>_<name>.sql
`);
}

function parseArgs(argv) {
  const flags = {
    yes: false,
    dryRun: false,
    allowProd: false,
    limit: null,
    projectRef: null,
    help: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--yes" || arg === "-y") flags.yes = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--allow-prod") flags.allowProd = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--limit") {
      flags.limit = Number(argv[(i += 1)]);
      if (!Number.isFinite(flags.limit) || flags.limit < 0) {
        throw new Error("--limit must be a non-negative number");
      }
    } else if (arg === "--project-ref") {
      flags.projectRef = argv[(i += 1)];
      if (!flags.projectRef) throw new Error("--project-ref needs a value");
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0] || "status", positional, flags };
}

function targetArgs(flags) {
  if (flags.projectRef) return ["--project-ref", flags.projectRef];
  return ["--linked"];
}

function runSupabase(args) {
  const result = spawnSync("supabase", args, {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(
      `supabase ${args.join(" ")} failed (exit ${result.status})\n${detail}`
    );
  }
  return result.stdout || "";
}

function linkedProjectRef(flags) {
  if (flags.projectRef) return flags.projectRef;
  const file = path.join(ROOT, "supabase", ".temp", "project-ref");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  return "";
}

function assertNotProd(flags, action) {
  const ref = linkedProjectRef(flags);
  if (isProdProject(ref) && !flags.allowProd) {
    throw new Error(
      `Refusing to ${action} on PROD (${ref}). Pass --allow-prod if you meant to.`
    );
  }
}

function loadRemote(flags) {
  try {
    const stdout = runSupabase([
      "--yes",
      "db",
      "query",
      ...targetArgs(flags),
      "--output-format",
      "json",
      HISTORY_SQL,
    ]);
    return remoteRowsFromQuery(extractJsonObject(stdout));
  } catch (err) {
    const text = String(err.message || err);
    if (/schema_migrations|does not exist|relation .* does not exist/i.test(text)) {
      return [];
    }
    throw err;
  }
}

function requireDowns(local) {
  const missing = missingDowns(local);
  if (missing.length) {
    const list = missing.map((row) => `  ${row.version}_${row.name}.sql`).join("\n");
    throw new Error(`Every up needs a matching down in supabase/down/:\n${list}`);
  }
}

function applySqlFile(flags, filePath) {
  runSupabase(["--yes", "db", "query", ...targetArgs(flags), "-f", filePath]);
}

function repair(flags, status, version) {
  runSupabase([
    "--yes",
    "migration",
    "repair",
    ...targetArgs(flags),
    "--status",
    status,
    version,
  ]);
}

function cmdStatus(local, classified) {
  const missing = missingDowns(local);
  process.stdout.write(`${formatStatusTable(classified)}\n`);
  process.stdout.write(
    `\npending ${classified.pending.length}  alias ${classified.aliases.length}  remote-only ${classified.remoteOnly.length}  missing-downs ${missing.length}\n`
  );
  if (classified.aliases.length) {
    process.stdout.write(
      "Alias: same name already recorded on the database under a different timestamp. `up` skips those files.\n"
    );
  }
  if (classified.remoteOnly.length) {
    process.stdout.write(
      "Remote-only versions have no local file. Inspect before pushing; `sync-history` only rewrites name matches.\n"
    );
  }
  if (missing.length) {
    process.stderr.write(
      `Missing down files:\n${missing.map((row) => `  ${row.version}_${row.name}`).join("\n")}\n`
    );
    return 1;
  }
  return 0;
}

function ensureHistoryTable(flags) {
  runSupabase([
    "--yes",
    "db",
    "query",
    ...targetArgs(flags),
    BOOTSTRAP_HISTORY_SQL,
  ]);
}

function cmdUp(local, classified, flags) {
  requireDowns(local);
  const toApply = pendingUps(classified, flags.limit);
  if (!toApply.length) {
    process.stdout.write("Database is up to date.\n");
    return 0;
  }
  process.stdout.write(
    `Applying ${toApply.length} pending migration(s):\n${toApply
      .map((row) => `  ${row.version} ${row.name}`)
      .join("\n")}\n`
  );
  if (flags.dryRun) {
    process.stdout.write("Dry run; nothing applied.\n");
    return 0;
  }
  ensureHistoryTable(flags);
  for (const row of toApply) {
    process.stdout.write(`→ up ${row.version} ${row.name}\n`);
    applySqlFile(flags, row.upPath);
    repair(flags, "applied", row.version);
  }
  process.stdout.write("Done.\n");
  return 0;
}

function cmdDown(local, classified, flags, count) {
  requireDowns(local);
  assertNotProd(flags, "roll back");
  const plan = rollbackPlan(classified, count);
  if (!plan.length) {
    process.stdout.write("Nothing to roll back.\n");
    return 0;
  }
  const missing = plan.filter((row) => !row.downPath);
  if (missing.length) {
    throw new Error(
      `No down file for:\n${missing.map((row) => `  ${row.version} ${row.name}`).join("\n")}`
    );
  }
  process.stdout.write(
    `Rolling back ${plan.length} migration(s):\n${plan
      .map((row) => `  ${row.repairVersion} ${row.name}`)
      .join("\n")}\n`
  );
  if (flags.dryRun) {
    process.stdout.write("Dry run; nothing reverted.\n");
    return 0;
  }
  if (!flags.yes) {
    throw new Error("down is destructive. Re-run with --yes to execute.");
  }
  for (const row of plan) {
    process.stdout.write(`→ down ${row.repairVersion} ${row.name}\n`);
    applySqlFile(flags, row.downPath);
    repair(flags, "reverted", row.repairVersion);
  }
  process.stdout.write("Done.\n");
  return 0;
}

function cmdSyncHistory(classified, flags) {
  assertNotProd(flags, "rewrite migration history");
  if (!classified.aliases.length) {
    process.stdout.write("No timestamp aliases to rewrite.\n");
    return 0;
  }
  process.stdout.write(
    `Rewrite remote versions to match git:\n${classified.aliases
      .map((row) => `  ${row.aliasVersion} ${row.name} → ${row.version}`)
      .join("\n")}\n`
  );
  if (flags.dryRun) {
    process.stdout.write("Dry run; history unchanged.\n");
    return 0;
  }
  if (!flags.yes) {
    throw new Error("sync-history rewrites the version table. Re-run with --yes.");
  }
  for (const row of classified.aliases) {
    repair(flags, "reverted", row.aliasVersion);
    repair(flags, "applied", row.version);
  }
  process.stdout.write("Done.\n");
  return 0;
}

function cmdNew(name) {
  if (!name) throw new Error("new needs a migration name, e.g. add_foo");
  runSupabase(["migration", "new", name]);
  const local = loadLocalMigrations(ROOT);
  const created = local.filter((row) => row.name === name).at(-1);
  if (!created) {
    throw new Error(`Created up for ${name} but could not find the new file.`);
  }
  const downDir = path.join(ROOT, "supabase", "down");
  fs.mkdirSync(downDir, { recursive: true });
  const downFile = path.join(downDir, created.filename);
  if (!fs.existsSync(downFile)) {
    fs.writeFileSync(
      downFile,
      `-- Down: ${created.version}_${created.name}\n-- Reverse the matching up. Keep this reversible on DEV before it ships.\n`,
      "utf8"
    );
  }
  process.stdout.write(`Up:   ${created.upPath}\nDown: ${downFile}\n`);
  return 0;
}

function main() {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    return 0;
  }

  if (command === "new") {
    return cmdNew(positional.slice(1).join("_"));
  }

  const local = loadLocalMigrations(ROOT);
  if (command === "status" || command === "up" || command === "down" || command === "sync-history") {
    const remote = loadRemote(flags);
    const classified = classifyMigrations(local, remote);
    if (command === "status") return cmdStatus(local, classified);
    if (command === "up") return cmdUp(local, classified, flags);
    if (command === "down") {
      const count = positional[1] != null ? Number(positional[1]) : 1;
      if (!Number.isFinite(count) || count < 1) {
        throw new Error("down count must be a positive number");
      }
      return cmdDown(local, classified, flags, count);
    }
    if (command === "sync-history") return cmdSyncHistory(classified, flags);
  }

  throw new Error(`Unknown command: ${command}`);
}

try {
  process.exitCode = main();
} catch (err) {
  process.stderr.write(`${err.message || err}\n`);
  process.exitCode = 1;
}
