#!/usr/bin/env bash
# Logical backup of a Supabase Postgres database (roles + schema + data).
#
# On-demand (local, writes backups/*.tar.gz — gitignored):
#   export SUPABASE_DB_PASSWORD_PROD='…'
#   ./scripts/backup-db.sh --env prod
#
# GitHub Actions always encrypts the archive (public repo) before upload.
# See docs/backup.md for restore.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV="prod"
ENCRYPT=0
DECRYPT_PATH=""
OUT_DIR="$ROOT/backups"
DNS_RESOLVER="${BACKUP_DNS_RESOLVER:-https}"

usage() {
  cat <<'EOF'
Usage:
  scripts/backup-db.sh [--env prod|dev] [--encrypt] [--out DIR]
  scripts/backup-db.sh --decrypt FILE.tar.gz.enc

Dump a restorable archive of the remote database.

  --env prod|dev   Target (default: prod)
  --encrypt        Write FILE.tar.gz.enc instead of plaintext (always on in CI)
  --out DIR        Archive directory (default: ./backups)
  --decrypt FILE   Decrypt an archive using BACKUP_ENCRYPTION_KEY

Environment:
  SUPABASE_ACCESS_TOKEN          CLI token (CI; local `supabase login` is enough)
  SUPABASE_PROJECT_REF_PROD      default sczdnalqmymhdornhkbn
  SUPABASE_DB_PASSWORD_PROD      required for --env prod
  SUPABASE_PROJECT_REF_DEV
  SUPABASE_DB_PASSWORD_DEV       required for --env dev
  BACKUP_ENCRYPTION_KEY          openssl passphrase; falls back to the DB password
  BACKUP_DNS_RESOLVER            https (default) or native
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      ENV="${2:-}"
      shift 2
      ;;
    --encrypt)
      ENCRYPT=1
      shift
      ;;
    --out)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    --decrypt)
      DECRYPT_PATH="${2:-}"
      shift 2
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

if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  ENCRYPT=1
fi

encryption_key() {
  if [[ -n "${BACKUP_ENCRYPTION_KEY:-}" ]]; then
    printf '%s' "$BACKUP_ENCRYPTION_KEY"
  elif [[ -n "${PASSWORD:-}" ]]; then
    printf '%s' "$PASSWORD"
  elif [[ -n "${SUPABASE_DB_PASSWORD_PROD:-}" ]]; then
    printf '%s' "$SUPABASE_DB_PASSWORD_PROD"
  elif [[ -n "${SUPABASE_DB_PASSWORD_DEV:-}" ]]; then
    printf '%s' "$SUPABASE_DB_PASSWORD_DEV"
  elif [[ -n "${SUPABASE_DB_PASSWORD:-}" ]]; then
    printf '%s' "$SUPABASE_DB_PASSWORD"
  fi
}

decrypt_archive() {
  local src="$1"
  if [[ -z "$src" || ! -f "$src" ]]; then
    echo "Decrypt file not found: $src" >&2
    exit 1
  fi
  local key
  key="$(encryption_key)"
  if [[ -z "$key" ]]; then
    echo "Set BACKUP_ENCRYPTION_KEY (or SUPABASE_DB_PASSWORD_PROD) to decrypt." >&2
    exit 1
  fi
  local dest="${src%.enc}"
  if [[ "$dest" == "$src" ]]; then
    dest="${src}.tar.gz"
  fi
  BACKUP_ENCRYPTION_KEY="$key" openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
    -in "$src" -out "$dest" -pass env:BACKUP_ENCRYPTION_KEY
  echo "Wrote $dest"
}

if [[ -n "$DECRYPT_PATH" ]]; then
  decrypt_archive "$DECRYPT_PATH"
  exit 0
fi

if [[ "$ENV" != "prod" && "$ENV" != "dev" ]]; then
  echo "--env must be prod or dev" >&2
  exit 1
fi

if ! command -v supabase >/dev/null 2>&1; then
  echo "supabase CLI not found. Install: https://supabase.com/docs/guides/cli" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker must be running. supabase db dump executes pg_dump in a container." >&2
  exit 1
fi

if [[ "$ENV" == "prod" ]]; then
  PROJECT_REF="${SUPABASE_PROJECT_REF_PROD:-sczdnalqmymhdornhkbn}"
  PASSWORD="${SUPABASE_DB_PASSWORD_PROD:-${SUPABASE_DB_PASSWORD:-}}"
else
  PROJECT_REF="${SUPABASE_PROJECT_REF_DEV:-fmiymqnfezkqagpbrmoi}"
  PASSWORD="${SUPABASE_DB_PASSWORD_DEV:-${SUPABASE_DB_PASSWORD:-}}"
fi

if [[ -z "$PASSWORD" ]]; then
  echo "Missing database password for $ENV." >&2
  echo "Export SUPABASE_DB_PASSWORD_$(printf '%s' "$ENV" | tr '[:lower:]' '[:upper:]') and retry." >&2
  exit 1
fi

if [[ -z "$PROJECT_REF" ]]; then
  echo "Missing project ref for $ENV." >&2
  exit 1
fi

STAMP="$(date -u +%Y%m%d-%H%M%SZ)"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/bhs-db-backup.XXXXXX")"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

dump() {
  # shellcheck disable=SC2086
  supabase db dump \
    --workdir "$ROOT" \
    --dns-resolver "$DNS_RESOLVER" \
    --project-ref "$PROJECT_REF" \
    --password "$PASSWORD" \
    "$@"
}

echo "Dumping $ENV ($PROJECT_REF)…"

dump --role-only -f "$WORKDIR/roles.sql"
dump -f "$WORKDIR/schema.sql"
dump --data-only --use-copy \
  -x "storage.buckets_vectors" \
  -x "storage.vector_indexes" \
  -f "$WORKDIR/data.sql"
dump --schema supabase_migrations -f "$WORKDIR/history_schema.sql"
dump --data-only --use-copy --schema supabase_migrations -f "$WORKDIR/history_data.sql"

for f in roles schema data history_schema history_data; do
  if [[ ! -s "$WORKDIR/$f.sql" ]]; then
    echo "Dump produced empty $f.sql" >&2
    exit 1
  fi
done

GIT_SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
GIT_BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"

{
  echo "app: bhs_shot_tracker"
  echo "env: $ENV"
  echo "project_ref: $PROJECT_REF"
  echo "created_at_utc: $STAMP"
  echo "git_sha: $GIT_SHA"
  echo "git_branch: $GIT_BRANCH"
  echo "github_run_id: ${GITHUB_RUN_ID:-}"
  echo "github_event: ${GITHUB_EVENT_NAME:-}"
  echo
  echo "files:"
  wc -c "$WORKDIR"/*.sql | sed "s|$WORKDIR/||"
  echo
  echo "Restore (empty target DB, then):"
  echo "  tar -xzf archive.tar.gz"
  echo "  psql --single-transaction --variable ON_ERROR_STOP=1 \\"
  echo "    --file roles.sql --file schema.sql \\"
  echo "    --command 'SET session_replication_role = replica' \\"
  echo "    --file data.sql \\"
  echo "    --dbname \"\$SUPABASE_DB_URL\""
  echo "  psql --single-transaction --variable ON_ERROR_STOP=1 \\"
  echo "    --file history_schema.sql --file history_data.sql \\"
  echo "    --dbname \"\$SUPABASE_DB_URL\""
} > "$WORKDIR/MANIFEST.txt"

mkdir -p "$OUT_DIR"
ARCHIVE="$OUT_DIR/bhs-shot-tracker-${ENV}-${STAMP}.tar.gz"
tar -czf "$ARCHIVE" -C "$WORKDIR" \
  MANIFEST.txt roles.sql schema.sql data.sql history_schema.sql history_data.sql

echo "Wrote $ARCHIVE ($(wc -c < "$ARCHIVE" | tr -d ' ') bytes)"

if [[ "$ENCRYPT" -eq 1 ]]; then
  KEY="$(encryption_key)"
  if [[ -z "$KEY" ]]; then
    echo "Cannot encrypt: set BACKUP_ENCRYPTION_KEY." >&2
    exit 1
  fi
  ENC="${ARCHIVE}.enc"
  BACKUP_ENCRYPTION_KEY="$KEY" openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
    -in "$ARCHIVE" -out "$ENC" -pass env:BACKUP_ENCRYPTION_KEY
  rm -f "$ARCHIVE"
  ARCHIVE="$ENC"
  echo "Encrypted $ARCHIVE"
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "archive=$ARCHIVE" >> "$GITHUB_OUTPUT"
fi
echo "$ARCHIVE"
