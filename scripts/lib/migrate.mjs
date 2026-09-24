/**
 * Versioned up/down migrations for the linked Supabase database.
 *
 * Ups stay in supabase/migrations/ (Supabase CLI compatible).
 * Downs live in supabase/down/ with the same <version>_<name>.sql identity.
 */

import fs from "node:fs";
import path from "node:path";

export const MIGRATION_FILE_RE = /^(\d+)_([A-Za-z0-9_]+)\.sql$/;
export const PROD_PROJECT_REF = "sczdnalqmymhdornhkbn";

export function parseMigrationFilename(filename) {
  const match = MIGRATION_FILE_RE.exec(filename);
  if (!match) return null;
  return { version: match[1], name: match[2], filename };
}

export function listMigrationFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map(parseMigrationFilename)
    .filter(Boolean)
    .sort((a, b) => a.version.localeCompare(b.version) || a.name.localeCompare(b.name));
}

export function loadLocalMigrations(root) {
  const upDir = path.join(root, "supabase", "migrations");
  const downDir = path.join(root, "supabase", "down");
  const ups = listMigrationFiles(upDir);
  const downs = new Map(
    listMigrationFiles(downDir).map((row) => [`${row.version}_${row.name}`, row])
  );

  return ups.map((up) => {
    const down = downs.get(`${up.version}_${up.name}`) || null;
    return {
      version: up.version,
      name: up.name,
      filename: up.filename,
      upPath: path.join(upDir, up.filename),
      downPath: down ? path.join(downDir, down.filename) : null,
    };
  });
}

export function missingDowns(local) {
  return local.filter((row) => !row.downPath);
}

/**
 * @param {Array<{version: string, name: string, upPath: string, downPath: string|null}>} local
 * @param {Array<{version: string, name?: string|null}>} remote
 */
export function classifyMigrations(local, remote) {
  const remoteRows = (remote || []).map((row) => ({
    version: String(row.version),
    name: row.name ? String(row.name) : null,
  }));
  const remoteByVersion = new Map(remoteRows.map((row) => [row.version, row]));
  const remoteByName = new Map();
  for (const row of remoteRows) {
    if (!row.name) continue;
    const list = remoteByName.get(row.name) || [];
    list.push(row);
    remoteByName.set(row.name, list);
  }

  const localByVersion = new Map(local.map((row) => [row.version, row]));
  const rows = local.map((loc) => {
    const exact = remoteByVersion.get(loc.version) || null;
    const nameHits = (remoteByName.get(loc.name) || []).filter(
      (row) => row.version !== loc.version
    );
    const alias = !exact && nameHits[0] ? nameHits[0] : null;
    let status = "pending";
    if (exact) status = "applied";
    else if (alias) status = "alias";
    return {
      ...loc,
      status,
      remoteVersion: exact ? exact.version : alias ? alias.version : null,
      aliasVersion: alias ? alias.version : null,
    };
  });

  const remoteOnly = remoteRows
    .filter((row) => !localByVersion.has(row.version))
    .filter((row) => !local.some((loc) => loc.name && loc.name === row.name))
    .map((row) => ({
      version: row.version,
      name: row.name,
      status: "remote-only",
    }));

  const aliases = rows.filter((row) => row.status === "alias");
  const pending = rows.filter((row) => row.status === "pending");
  const applied = rows.filter((row) => row.status === "applied" || row.status === "alias");

  return { rows, pending, applied, aliases, remoteOnly };
}

export function pendingUps(classified, limit = null) {
  const pending = classified.pending.slice();
  if (limit == null || Number.isNaN(limit)) return pending;
  return pending.slice(0, Math.max(0, limit));
}

/**
 * Plan rollbacks for the last `count` applied migrations (newest first).
 * Uses the remote version for history repair, and the local down file for SQL.
 */
export function rollbackPlan(classified, count = 1) {
  const n = Math.max(0, Number(count) || 0);
  const appliedNewestFirst = classified.applied.slice().reverse();
  return appliedNewestFirst.slice(0, n).map((row) => ({
    ...row,
    repairVersion: row.remoteVersion || row.version,
  }));
}

export function formatStatusTable(classified) {
  const lines = [
    "version          name                            local  remote           down",
    "---------------- ------------------------------- ------ ---------------- ----",
  ];
  for (const row of classified.rows) {
    const remote =
      row.status === "applied"
        ? row.version
        : row.status === "alias"
          ? `${row.aliasVersion} (name)`
          : "-";
    lines.push(
      [
        row.version.padEnd(16),
        row.name.slice(0, 31).padEnd(31),
        "yes".padEnd(6),
        remote.padEnd(16),
        row.downPath ? "yes" : "NO",
      ].join(" ")
    );
  }
  for (const row of classified.remoteOnly) {
    lines.push(
      [
        row.version.padEnd(16),
        String(row.name || "?").slice(0, 31).padEnd(31),
        "-".padEnd(6),
        row.version.padEnd(16),
        "-",
      ].join(" ")
    );
  }
  return lines.join("\n");
}

function balancedJsonEnd(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function nextJsonStart(text, from) {
  const re = /[[{]/g;
  re.lastIndex = from;
  const m = re.exec(text);
  return m ? m.index : -1;
}

const isRowArray = (value) =>
  Array.isArray(value) && value.every((row) => row && typeof row === "object" && "version" in row);

/**
 * `supabase db query --output-format json` prints a bare array of rows, or (under AI agents)
 * `{ boundary, rows, warning }`; either may be surrounded by CLI notices. Returns `{ rows }`.
 */
export function extractJsonObject(text) {
  let i = nextJsonStart(text, 0);
  while (i !== -1) {
    const end = balancedJsonEnd(text, i);
    if (end === -1) break;
    let value;
    try {
      value = JSON.parse(text.slice(i, end + 1));
    } catch {
      i = nextJsonStart(text, i + 1);
      continue;
    }
    if (isRowArray(value)) return { rows: value };
    if (value && isRowArray(value.rows)) return value;
    i = nextJsonStart(text, end + 1);
  }
  throw new Error(`No migration rows in command output:\n${text}`);
}

export function remoteRowsFromQuery(payload) {
  const rows = payload?.rows;
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    version: String(row.version),
    name: row.name != null ? String(row.name) : null,
  }));
}

export function isProdProject(ref) {
  return String(ref || "") === PROD_PROJECT_REF;
}
