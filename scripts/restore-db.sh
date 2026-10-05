#!/usr/bin/env bash
# Restore a logical dump (from scripts/backup-db.sh) into a target database.
#
# Prefer an empty or wipeable project — never live PROD.
# See docs/backup.md and docs/pr-preview.md.
#
# Examples:
#   ./scripts/restore-db.sh --archive backups/bhs-shot-tracker-prod-….tar.gz \
#     --db-url "$SUPABASE_DB_URL_STAGING" --wipe
#
#   ./scripts/restore-db.sh --archive backups/….tar.gz.enc --env staging --wipe
#
#   ./scripts/restore-db.sh --archive backups/….tar.gz --db-url "$URL" --dry-run
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ARCHIVE=""
ENV_NAME=""
DB_URL=""
WIPE=0
DRY_RUN=0
APPLY_ROLES=0
SKIP_HISTORY=0

usage() {
  cat <<'EOF'
Usage:
  scripts/restore-db.sh --archive FILE.tar.gz[.enc] (--db-url URL | --env staging)
                        [--wipe] [--roles] [--skip-history] [--dry-run]

Restore roles/schema/data (+ migration history) from a backup-db.sh archive.

  --archive FILE   Plain .tar.gz or encrypted .tar.gz.enc
  --db-url URL     Target Postgres URL (session / direct preferred over transaction pooler)
  --env staging    Resolve URL from SUPABASE_DB_URL_STAGING, or build from
                   SUPABASE_PROJECT_REF_STAGING + SUPABASE_DB_PASSWORD_STAGING
  --wipe           Drop public + supabase_migrations on the target before restore
  --roles          Apply roles.sql (often fails on hosted Supabase; off by default)
  --skip-history   Skip supabase_migrations history files
  --dry-run        Decrypt/unpack, print plan, do not connect or write

Environment:
  BACKUP_ENCRYPTION_KEY / SUPABASE_DB_PASSWORD_PROD  decrypt .enc archives
  SUPABASE_DB_URL_STAGING                            full postgres URL
  SUPABASE_PROJECT_REF_STAGING + SUPABASE_DB_PASSWORD_STAGING
                                                     alternate URL construction
  RESTORE_DNS_HOST                                   override db.<ref>.supabase.co host
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --archive)
      ARCHIVE="${2:-}"
      shift 2
      ;;
    --db-url)
      DB_URL="${2:-}"
      shift 2
      ;;
    --env)
      ENV_NAME="${2:-}"
      shift 2
      ;;
    --wipe)
      WIPE=1
      shift
      ;;
    --roles)
      APPLY_ROLES=1
      shift
      ;;
    --skip-history)
      SKIP_HISTORY=1
      shift
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

if [[ -z "$ARCHIVE" ]]; then
  echo "--archive is required" >&2
  usage >&2
  exit 1
fi

if [[ ! -f "$ARCHIVE" ]]; then
  echo "Archive not found: $ARCHIVE" >&2
  exit 1
fi

resolve_staging_url() {
  if [[ -n "${SUPABASE_DB_URL_STAGING:-}" ]]; then
    printf '%s' "$SUPABASE_DB_URL_STAGING"
    return
  fi
  local ref="${SUPABASE_PROJECT_REF_STAGING:-}"
  local pass="${SUPABASE_DB_PASSWORD_STAGING:-}"
  if [[ -z "$ref" || -z "$pass" ]]; then
    echo "Set SUPABASE_DB_URL_STAGING, or SUPABASE_PROJECT_REF_STAGING + SUPABASE_DB_PASSWORD_STAGING." >&2
    exit 1
  fi
  # Percent-encode password for URL (minimal: @ : / # ? % &)
  local enc
  enc="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$pass")"
  local host="${RESTORE_DNS_HOST:-db.${ref}.supabase.co}"
  printf 'postgresql://postgres:%s@%s:5432/postgres' "$enc" "$host"
}

if [[ -n "$ENV_NAME" ]]; then
  if [[ "$ENV_NAME" != "staging" ]]; then
    echo "--env only supports staging (refusing prod/dev to avoid accidents)." >&2
    exit 1
  fi
  if [[ -n "$DB_URL" ]]; then
    echo "Pass either --db-url or --env, not both." >&2
    exit 1
  fi
  DB_URL="$(resolve_staging_url)"
fi

if [[ -z "$DB_URL" && "$DRY_RUN" -eq 0 ]]; then
  echo "Provide --db-url or --env staging." >&2
  usage >&2
  exit 1
fi

# Refuse obvious PROD project refs in the URL when we can detect them.
PROD_REF="${SUPABASE_PROJECT_REF_PROD:-sczdnalqmymhdornhkbn}"
if [[ -n "$DB_URL" && "$DB_URL" == *"$PROD_REF"* ]]; then
  echo "Refusing restore: target URL looks like PROD ($PROD_REF)." >&2
  exit 1
fi

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/bhs-db-restore.XXXXXX")"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

ARCHIVE_PATH="$ARCHIVE"
case "$ARCHIVE" in
  *.enc)
    echo "Decrypting $ARCHIVE…"
    "$ROOT/scripts/backup-db.sh" --decrypt "$ARCHIVE"
    ARCHIVE_PATH="${ARCHIVE%.enc}"
    if [[ "$ARCHIVE_PATH" == "$ARCHIVE" ]]; then
      ARCHIVE_PATH="${ARCHIVE}.tar.gz"
    fi
    # backup-db.sh writes next to the .enc file
    if [[ ! -f "$ARCHIVE_PATH" ]]; then
      # might have been written relative to cwd with same basename
      local_guess="$(dirname "$ARCHIVE")/$(basename "${ARCHIVE%.enc}")"
      if [[ -f "$local_guess" ]]; then
        ARCHIVE_PATH="$local_guess"
      else
        echo "Decrypt did not produce $ARCHIVE_PATH" >&2
        exit 1
      fi
    fi
    ;;
esac

echo "Unpacking $ARCHIVE_PATH…"
tar -xzf "$ARCHIVE_PATH" -C "$WORKDIR"

for f in MANIFEST.txt schema.sql data.sql; do
  if [[ ! -s "$WORKDIR/$f" ]]; then
    echo "Archive missing $f" >&2
    exit 1
  fi
done

echo "── MANIFEST ──"
cat "$WORKDIR/MANIFEST.txt"
echo "──────────────"

plan() {
  echo "Plan:"
  if [[ "$WIPE" -eq 1 ]]; then
    echo "  1. DROP SCHEMA public CASCADE; recreate + grants"
    echo "  2. DROP SCHEMA IF EXISTS supabase_migrations CASCADE"
  else
    echo "  1. (no wipe)"
  fi
  local step=3
  if [[ "$APPLY_ROLES" -eq 1 ]]; then
    echo "  $step. psql roles.sql"
    step=$((step + 1))
  else
    echo "  $step. skip roles.sql (pass --roles to apply)"
    step=$((step + 1))
  fi
  echo "  $step. psql schema.sql + data.sql (session_replication_role=replica)"
  step=$((step + 1))
  if [[ "$SKIP_HISTORY" -eq 1 ]]; then
    echo "  $step. skip migration history"
  else
    echo "  $step. psql history_schema.sql + history_data.sql"
  fi
  if [[ -n "$DB_URL" ]]; then
    # redact password in log
    echo "  target: $(echo "$DB_URL" | sed -E 's#(postgresql://[^:]+:)[^@]+#\1***#')"
  else
    echo "  target: (none — dry-run)"
  fi
}

plan

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry-run complete; no database writes."
  exit 0
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "psql not found. Install postgresql-client." >&2
  exit 1
fi

run_psql() {
  psql --single-transaction --variable ON_ERROR_STOP=1 --dbname "$DB_URL" "$@"
}

if [[ "$WIPE" -eq 1 ]]; then
  echo "Wiping public + supabase_migrations on target…"
  run_psql <<'SQL'
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON SCHEMA public TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;
DROP SCHEMA IF EXISTS supabase_migrations CASCADE;
SQL
fi

if [[ "$APPLY_ROLES" -eq 1 ]]; then
  echo "Applying roles.sql…"
  if ! run_psql --file "$WORKDIR/roles.sql"; then
    echo "roles.sql failed (common on hosted Supabase). Continuing without roles." >&2
  fi
fi

echo "Applying schema + data…"
run_psql \
  --file "$WORKDIR/schema.sql" \
  --command 'SET session_replication_role = replica' \
  --file "$WORKDIR/data.sql"

if [[ "$SKIP_HISTORY" -eq 0 ]]; then
  if [[ -s "$WORKDIR/history_schema.sql" && -s "$WORKDIR/history_data.sql" ]]; then
    echo "Applying migration history…"
    run_psql \
      --file "$WORKDIR/history_schema.sql" \
      --file "$WORKDIR/history_data.sql"
  else
    echo "History files missing or empty; skipping." >&2
  fi
fi

echo "Restore complete."
