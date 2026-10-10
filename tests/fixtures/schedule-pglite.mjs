/**
 * In-process stand-in for the Supabase RPC endpoint, backed by PGlite running
 * the real postseason_schedule migration. Lets e2e tests (and local UI work)
 * exercise schedule_* RPCs without touching DEV.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATIONS = ["20261007160000_postseason_schedule.sql", "20261010150000_schedule_manual_reminders.sql"].map((f) =>
  path.join(ROOT, "supabase/migrations", f)
);

export async function createScheduleDb() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;
    grant usage on schema public to anon, authenticated, service_role;
  `);
  for (const file of MIGRATIONS) await db.exec(readFileSync(file, "utf8"));
  const argTypes = new Map();

  async function typesFor(fn) {
    if (!argTypes.has(fn)) {
      const { rows } = await db.query(
        `select p.proargnames as names, array(select format_type(t, null) from unnest(p.proargtypes) t) as types
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = $1`,
        [fn]
      );
      if (!rows.length) return null;
      const map = {};
      (rows[0].names || []).forEach((n, i) => (map[n] = rows[0].types[i]));
      argTypes.set(fn, map);
    }
    return argTypes.get(fn);
  }

  /** PostgREST-shaped call: returns { status, body }. Runs as `anon` like the browser. */
  async function rpc(fn, args = {}) {
    if (!/^schedule_[a-z_]+$/.test(fn)) return { status: 404, body: { message: "not found" } };
    const types = await typesFor(fn);
    if (!types) return { status: 404, body: { message: `function ${fn} not found` } };
    const keys = Object.keys(args || {});
    const params = keys.map((k) => {
      const v = args[k];
      if (Array.isArray(v)) return `{${v.join(",")}}`;
      return v;
    });
    const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}::${types[k] || "text"}`).join(", ")}) as r`;
    try {
      await db.exec("set role anon");
      const { rows } = await db.query(sql, params);
      return { status: 200, body: rows[0]?.r ?? null };
    } catch (err) {
      return {
        status: 400,
        body: { code: err.code || "P0001", message: err.message, details: null, hint: err.hint || null },
      };
    } finally {
      await db.exec("reset role");
    }
  }

  return { db, rpc };
}
