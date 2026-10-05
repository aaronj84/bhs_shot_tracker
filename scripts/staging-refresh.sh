#!/usr/bin/env bash
# Refresh the long-lived STAGING Supabase project from a PROD logical dump,
# deploy edge functions, and optionally assemble the staging frontend.
#
# Does NOT touch PROD writes. Dump source is either:
#   --archive FILE          local .tar.gz / .tar.gz.enc
#   --from-latest-artifact  (CI) download newest Backup PROD artifact
#   --dump-prod-first       run backup-db.sh --env prod --encrypt then restore
#
#   ./scripts/staging-refresh.sh --archive backups/….tar.gz.enc --wipe
#   ./scripts/staging-refresh.sh --dry-run --archive backups/….tar.gz
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ARCHIVE=""
FROM_ARTIFACT=0
DUMP_PROD=0
WIPE=1
DRY_RUN=0
SKIP_FUNCTIONS=0
SKIP_SITE=0
OUT_DIR="_staging_site"

usage() {
  cat <<'EOF'
Usage:
  scripts/staging-refresh.sh (--archive FILE | --from-latest-artifact | --dump-prod-first)
                             [--no-wipe] [--skip-functions] [--skip-site] [--out DIR] [--dry-run]

Orchestrates: decrypt → restore into STAGING → deploy edge functions → assemble site.

  --archive FILE            Local backup archive (.tar.gz or .tar.gz.enc)
  --from-latest-artifact    CI only: gh run download of latest successful Backup PROD
  --dump-prod-first         Run backup-db.sh --env prod (read-only dump) then restore
  --no-wipe                 Do not DROP public before restore (default is wipe)
  --skip-functions          Skip edge function deploy
  --skip-site               Skip frontend assemble
  --out DIR                 Site output (default _staging_site)
  --dry-run                 Plan only (restore --dry-run; no deploy)

Required env for a real restore:
  SUPABASE_DB_URL_STAGING  or  SUPABASE_PROJECT_REF_STAGING + SUPABASE_DB_PASSWORD_STAGING
  SUPABASE_ACCESS_TOKEN    (functions + optional dump)
  BACKUP_ENCRYPTION_KEY or SUPABASE_DB_PASSWORD_PROD  (decrypt)
Optional site assemble:
  SHOTS_SUPABASE_URL / SHOTS_SUPABASE_ANON_KEY  (staging anon values)
  SHOTS_PIN, SHOTS_BRAND_SUB (e.g. "Staging")
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --archive)
      ARCHIVE="${2:-}"
      shift 2
      ;;
    --from-latest-artifact)
      FROM_ARTIFACT=1
      shift
      ;;
    --dump-prod-first)
      DUMP_PROD=1
      shift
      ;;
    --no-wipe)
      WIPE=0
      shift
      ;;
    --skip-functions)
      SKIP_FUNCTIONS=1
      shift
      ;;
    --skip-site)
      SKIP_SITE=1
      shift
      ;;
    --out)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

sources=0
[[ -n "$ARCHIVE" ]] && sources=$((sources + 1))
[[ "$FROM_ARTIFACT" -eq 1 ]] && sources=$((sources + 1))
[[ "$DUMP_PROD" -eq 1 ]] && sources=$((sources + 1))
if [[ "$sources" -ne 1 ]]; then
  echo "Choose exactly one of --archive, --from-latest-artifact, --dump-prod-first." >&2
  usage >&2
  exit 1
fi

if [[ "$DUMP_PROD" -eq 1 ]]; then
  echo "Dumping PROD (read-only logical backup)…"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "Dry-run: would run ./scripts/backup-db.sh --env prod --encrypt"
  else
    ARCHIVE="$("$ROOT/scripts/backup-db.sh" --env prod --encrypt | tee /dev/stderr | tail -n1)"
  fi
fi

if [[ "$FROM_ARTIFACT" -eq 1 ]]; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "Dry-run: would download latest Backup PROD artifact via gh"
  else
    if ! command -v gh >/dev/null 2>&1; then
      echo "gh CLI required for --from-latest-artifact" >&2
      exit 1
    fi
    mkdir -p backups
    ART_DIR="$(mktemp -d "${TMPDIR:-/tmp}/bhs-backup-art.XXXXXX")"
    trap 'rm -rf "$ART_DIR"' EXIT
    RUN_ID="$(gh run list --workflow=backup-prod.yml --status=success --limit 1 --json databaseId --jq '.[0].databaseId')"
    if [[ -z "$RUN_ID" || "$RUN_ID" == "null" ]]; then
      echo "No successful Backup PROD run found." >&2
      exit 1
    fi
    echo "Downloading artifacts from Backup PROD run $RUN_ID…"
    gh run download "$RUN_ID" --dir "$ART_DIR"
    ARCHIVE="$(find "$ART_DIR" \( -name '*.enc' -o -name 'bhs-shot-tracker-prod-*.tar.gz' \) | head -n1)"
    if [[ -z "$ARCHIVE" ]]; then
      echo "No backup archive in artifact." >&2
      exit 1
    fi
    cp "$ARCHIVE" "backups/$(basename "$ARCHIVE")"
    ARCHIVE="backups/$(basename "$ARCHIVE")"
  fi
fi

if [[ -n "$ARCHIVE" ]]; then
  RESTORE_ARGS=(--archive "$ARCHIVE")
  # --env staging resolves DB URL; dry-run does not need a live URL
  if [[ "$DRY_RUN" -eq 1 ]]; then
    RESTORE_ARGS+=(--dry-run)
  else
    RESTORE_ARGS+=(--env staging)
  fi
  if [[ "$WIPE" -eq 1 ]]; then
    RESTORE_ARGS+=(--wipe)
  fi
  echo "Restoring into STAGING…"
  "$ROOT/scripts/restore-db.sh" "${RESTORE_ARGS[@]}"
elif [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry-run: restore skipped (no local archive resolved yet)."
fi

if [[ "$SKIP_FUNCTIONS" -eq 0 ]]; then
  FN_ARGS=(--env staging)
  if [[ "$DRY_RUN" -eq 1 ]]; then
    FN_ARGS+=(--dry-run)
  fi
  "$ROOT/scripts/deploy-edge-functions.sh" "${FN_ARGS[@]}"
fi

if [[ "$SKIP_SITE" -eq 0 ]]; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "Dry-run: would assemble site into $OUT_DIR with staging config env"
  else
    export SHOTS_SUPABASE_URL="${SHOTS_SUPABASE_URL:-${SHOTS_SUPABASE_URL_STAGING:-}}"
    export SHOTS_SUPABASE_ANON_KEY="${SHOTS_SUPABASE_ANON_KEY:-${SHOTS_SUPABASE_ANON_KEY_STAGING:-}}"
    export SHOTS_BRAND_SUB="${SHOTS_BRAND_SUB:-Staging}"
    if [[ -z "$SHOTS_SUPABASE_URL" || -z "$SHOTS_SUPABASE_ANON_KEY" ]]; then
      echo "Skipping site assemble: set SHOTS_SUPABASE_URL_STAGING + SHOTS_SUPABASE_ANON_KEY_STAGING." >&2
    else
      "$ROOT/scripts/assemble-site.sh" --out "$OUT_DIR"
    fi
  fi
fi

echo "Staging refresh finished."
