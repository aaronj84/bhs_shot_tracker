---
name: integrate
description: >-
  Run the GitHub Actions CI suite locally against the DEV Supabase project
  (Vitest API tests, then Playwright smokes) and fix failures until they pass.
  Use only when the user invokes /integrate or explicitly asks to run CI
  locally before a push. Never run it on your own, and never add a git hook.
disable-model-invocation: true
---

# Integrate (local CI)

On-demand local run of `.github/workflows/ci.yml`. Optional. Do not install a pre-push hook, do not run this unless the user asked, and do not commit or push unless asked.

## Run

From the repo root:

```bash
npm run test:ci
```

That is `node scripts/ci-local.mjs`. It needs outbound network. If Chromium fails to launch inside the sandbox, rerun the same command with the sandbox disabled.

The script reads `SHOTS_SUPABASE_URL` and `SHOTS_SUPABASE_ANON_KEY` from the environment, or from `shots-config.js` when those variables are unset. It refuses the PROD project (`sczdnalqmymhdornhkbn`). Steps, in Actions order:

1. `npm ci` when `node_modules` is missing, older than `package-lock.json`, or `--fresh` is passed
2. `node scripts/write-shots-config.js` when credentials came from the environment
3. `npm run test:api`
4. `npx playwright install chromium` (no `--with-deps`; that flag is for the Ubuntu runner)
5. `npm run test:e2e` with `CI=true` (one retry, fresh server on port 4173)

Allow about 10 minutes for a full run. After a failure, rerun one suite:

```bash
npm run test:ci -- --api
npm run test:ci -- --e2e
```

If `ci.yml` gains or drops a test step, update `scripts/ci-local.mjs` to match before trusting the result.

## When it fails

1. Read the failure and fix the cause in the working tree.
2. Rerun only the suite that failed.
3. Keep going while the failure is a clear product or test bug.
4. Stop and report if the same failure comes back unchanged, or if the blocker is missing DEV credentials, DEV auth, or network. Do not point the run at PROD. Do not print keys.

A team-specific smoke failure can be reproduced with `E2E_TEAM=us` or `E2E_TEAM=opp`. Leave that unset for a normal run.

## When it passes

Say that API and Playwright passed against DEV. This check is optional.
