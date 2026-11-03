#!/usr/bin/env node
/**
 * Local equivalent of .github/workflows/ci.yml (DEV only).
 *
 *   node scripts/ci-local.mjs            # api, then e2e
 *   node scripts/ci-local.mjs --api
 *   node scripts/ci-local.mjs --e2e
 *   node scripts/ci-local.mjs --fresh    # npm ci even if node_modules is current
 *
 * Credentials: SHOTS_SUPABASE_URL + SHOTS_SUPABASE_ANON_KEY, or shots-config.js.
 * Refuses the PROD project. Does not print keys.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEV_REF = "fmiymqnfezkqagpbrmoi";
const PROD_REF = "sczdnalqmymhdornhkbn";

const args = process.argv.slice(2);
const known = new Set(["--api", "--e2e", "--fresh"]);
const unknown = args.filter((arg) => !known.has(arg));
if (unknown.length) {
  console.error(`Unknown argument: ${unknown.join(" ")}`);
  console.error("Usage: node scripts/ci-local.mjs [--api | --e2e] [--fresh]");
  process.exit(1);
}
if (args.includes("--api") && args.includes("--e2e")) {
  console.error("Pass only one of --api or --e2e");
  process.exit(1);
}

const runApi = !args.includes("--e2e");
const runE2e = !args.includes("--api");
const fresh = args.includes("--fresh");

function pick(src, key) {
  return (src.match(new RegExp(`${key}:\\s*"([^"]*)"`)) || [])[1] || "";
}

function credsFromConfig() {
  const file = path.join(ROOT, "shots-config.js");
  if (!fs.existsSync(file)) return null;
  const src = fs.readFileSync(file, "utf8");
  return {
    url: pick(src, "supabaseUrl"),
    anon: pick(src, "supabaseAnonKey"),
    pin: pick(src, "pin"),
    env: pick(src, "env"),
    source: "shots-config.js",
  };
}

function resolveCreds() {
  const url = process.env.SHOTS_SUPABASE_URL || "";
  const anon = process.env.SHOTS_SUPABASE_ANON_KEY || "";
  if (url && anon) {
    return {
      url,
      anon,
      pin: process.env.SHOTS_PIN || "",
      env: "",
      source: "environment",
    };
  }
  return credsFromConfig();
}

function assertDev(creds) {
  if (!creds?.url || !creds?.anon) {
    console.error(
      "Missing DEV credentials. Export SHOTS_SUPABASE_URL and SHOTS_SUPABASE_ANON_KEY, or fill shots-config.js with the DEV project."
    );
    process.exit(1);
  }
  if (creds.url.includes(PROD_REF) || creds.env === "prod") {
    console.error(
      `Refusing to run. Credentials are for PROD (${PROD_REF}). Local CI uses DEV only.`
    );
    process.exit(1);
  }
  if (!creds.url.includes(DEV_REF)) {
    console.error(`Refusing to run. Local CI targets DEV (${DEV_REF}) only.`);
    process.exit(1);
  }
}

function run(cmd, cmdArgs, extraEnv = {}) {
  const result = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function depsCurrent() {
  const installed = path.join(ROOT, "node_modules", ".package-lock.json");
  const lock = path.join(ROOT, "package-lock.json");
  if (!fs.existsSync(installed) || !fs.existsSync(path.join(ROOT, "node_modules", "vitest"))) {
    return false;
  }
  return fs.statSync(installed).mtimeMs >= fs.statSync(lock).mtimeMs;
}

const creds = resolveCreds();
assertDev(creds);

const testEnv = {
  SHOTS_SUPABASE_URL: creds.url,
  SHOTS_SUPABASE_ANON_KEY: creds.anon,
  CI: "true",
};
if (creds.pin) testEnv.SHOTS_PIN = creds.pin;

const suites = [runApi ? "test:api" : null, runE2e ? "test:e2e" : null].filter(Boolean);
console.log(`Local CI against DEV (${DEV_REF})`);
console.log(`Credentials: ${creds.source}`);
console.log(`Suites: ${suites.join(", ")}`);

if (fresh || !depsCurrent()) {
  console.log("\n== npm ci ==");
  run("npm", ["ci"]);
} else {
  console.log("Dependencies match package-lock.json (pass --fresh to reinstall).");
}

if (creds.source === "environment") {
  console.log("\n== write shots-config.js ==");
  run("node", ["scripts/write-shots-config.js"], testEnv);
}

if (runApi) {
  console.log("\n== npm run test:api ==");
  run("npm", ["run", "test:api"], testEnv);
}

if (runE2e) {
  console.log("\n== playwright install chromium ==");
  run("npx", ["playwright", "install", "chromium"], testEnv);
  console.log("\n== npm run test:e2e ==");
  run("npm", ["run", "test:e2e"], testEnv);
}

console.log("\nLocal CI passed.");
