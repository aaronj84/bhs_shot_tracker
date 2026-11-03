#!/usr/bin/env bash
# Wipe DEV and restore a fresh PROD logical dump, then apply any migrations
# PROD is missing (e.g. multi_team_seasons).
#
# Prerequisites:
#   - Docker running (supabase db dump uses a container)
#   - supabase CLI logged in
#   - psql on PATH (brew install libpq && brew link --force libpq)
#   - SUPABASE_DB_PASSWORD_PROD and SUPABASE_DB_PASSWORD_DEV
#
# Usage:
#   export SUPABASE_DB_PASSWORD_PROD='…'
#   export SUPABASE_DB_PASSWORD_DEV='…'
#   ./scripts/restore-prod-to-dev.sh
#   ./scripts/restore-prod-to-dev.sh --yes   # skip confirmation
#
# Or restore an existing archive:
#   ./scripts/restore-prod-to-dev.sh --from backups/bhs-shot-tracker-prod-….tar.gz --yes
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PROD_REF="${SUPABASE_PROJECT_REF_PROD:-sczdnalqmymhdornhkbn}"
DEV_REF="${SUPABASE_PROJECT_REF_DEV:-fmiymqnfezkqagpbrmoi}"
YES=0
FROM_ARCHIVE=""

usage() {
  cat <<'EOF'
Usage: scripts/restore-prod-to-dev.sh [--from ARCHIVE.tar.gz] [--yes]

Dumps PROD (unless --from), restores into DEV, then runs npm run db:up on DEV.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from)
      FROM_ARCHIVE="${2:-}"
      shift 2
      ;;
    --yes|-y)
      YES=1
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

if [[ -z "${SUPABASE_DB_PASSWORD_DEV:-}" ]]; then
  echo "Export SUPABASE_DB_PASSWORD_DEV and retry." >&2
  exit 1
fi

if [[ -z "${FROM_ARCHIVE}" && -z "${SUPABASE_DB_PASSWORD_PROD:-}" ]]; then
  echo "Export SUPABASE_DB_PASSWORD_PROD (or pass --from ARCHIVE) and retry." >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "psql not found. Install: brew install libpq && brew link --force libpq" >&2
  exit 1
fi

if [[ "${YES}" -ne 1 ]]; then
  echo "This will REPLACE all data in DEV (${DEV_REF}) with a copy of PROD (${PROD_REF})."
  read -r -p "Type 'restore' to continue: " answer
  if [[ "${answer:-}" != "restore" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/bhs-restore.XXXXXX")"
cleanup() { rm -rf "${WORKDIR}"; }
trap cleanup EXIT

if [[ -n "${FROM_ARCHIVE}" ]]; then
  if [[ ! -f "${FROM_ARCHIVE}" ]]; then
    echo "Archive not found: ${FROM_ARCHIVE}" >&2
    exit 1
  fi
  # Note: archive must be a plaintext .tar.gz (decrypt .enc first).
  case "${FROM_ARCHIVE}" in
    *.enc)
      echo "Refusing encrypted archive. Decrypt first:" >&2
      echo "  ./scripts/backup-db.sh --decrypt ${FROM_ARCHIVE}" >&2
      exit 1
      ;;
  esac
  echo "Unpacking ${FROM_ARCHIVE} ..."
  tar -xzf "${FROM_ARCHIVE}" -C "${WORKDIR}"
else
  echo "Dumping PROD ..."
  ./scripts/backup-db.sh --env prod --out "${WORKDIR}"
  ARCHIVE="$(ls -1t "${WORKDIR}"/bhs-shot-tracker-prod-*.tar.gz | head -1)"
  mkdir -p "${ROOT}/backups"
  cp "${ARCHIVE}" "${ROOT}/backups/"
  echo "Kept local copy: backups/$(basename "${ARCHIVE}")"
  tar -xzf "${ARCHIVE}" -C "${WORKDIR}"
fi

for f in schema.sql data.sql; do
  if [[ ! -s "${WORKDIR}/$f" ]]; then
    echo "Missing $f in archive" >&2
    exit 1
  fi
done

# Keep DEV's own GoTrue/auth/storage. Only load app tables from the dump.
# Otherwise COPY auth.refresh_tokens hits duplicate PKs against live DEV sessions.
echo "Filtering data.sql to public schema only (skip auth/storage/realtime) ..."
python3 - "${WORKDIR}/data.sql" "${WORKDIR}/data.public.sql" <<'PY'
import re, sys
src, dst = sys.argv[1], sys.argv[2]
# Allowlist: public app data only.
keep = re.compile(r'^COPY\s+"?(public)"?\.', re.I)
copy_any = re.compile(r'^COPY\s+', re.I)
skipping = False
kept = skipped = 0
with open(src, "r", encoding="utf-8", errors="replace") as fin, open(
    dst, "w", encoding="utf-8"
) as fout:
    fout.write("SET session_replication_role = replica;\n")
    for line in fin:
        if skipping:
            if line == "\\.\n" or line == "\\.\r\n":
                skipping = False
            continue
        if copy_any.match(line):
            if keep.match(line):
                fout.write(line)
                kept += 1
            else:
                skipping = True
                skipped += 1
            continue
        # Drop dump-wide SETs that restate replica role; keep comments/blank/other SQL.
        if line.startswith("SET session_replication_role"):
            continue
        fout.write(line)
print(f"Kept {kept} public COPY blocks; skipped {skipped} non-public blocks", file=sys.stderr)
PY

# Session pooler URI (transaction mode is wrong for multi-statement restore).
# Dashboard → Connect → Session mode (port 5432).
DEV_DB_URL="${SUPABASE_DB_URL_DEV:-}"
if [[ -z "$DEV_DB_URL" ]]; then
  # Default pooler host pattern for Supabase; password must be percent-encoded by the caller if needed.
  ENC_PW="$(python3 -c "import urllib.parse,os; print(urllib.parse.quote(os.environ['SUPABASE_DB_PASSWORD_DEV'], safe=''))")"
  DEV_DB_URL="postgresql://postgres.${DEV_REF}:${ENC_PW}@aws-0-us-west-2.pooler.supabase.com:5432/postgres"
  echo "Using default session-pooler URL for $DEV_REF (override with SUPABASE_DB_URL_DEV if this region/host differs)."
fi

echo "Wiping DEV public/explore/migration history (keeps auth/storage/extensions)…"
psql --variable ON_ERROR_STOP=1 --dbname "$DEV_DB_URL" <<'SQL'
DROP SCHEMA IF EXISTS explore CASCADE;
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON SCHEMA public TO postgres, service_role;
GRANT ALL ON SCHEMA public TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;
DROP SCHEMA IF EXISTS supabase_migrations CASCADE;
SQL

echo "Restoring schema + public data into DEV (skipping roles.sql and auth data)…"
psql --single-transaction --variable ON_ERROR_STOP=1 \
  --file "${WORKDIR}/schema.sql" \
  --command 'SET session_replication_role = replica' \
  --file "${WORKDIR}/data.public.sql" \
  --dbname "$DEV_DB_URL"

if [[ -s "$WORKDIR/history_schema.sql" && -s "$WORKDIR/history_data.sql" ]]; then
  echo "Restoring migration history…"
  psql --single-transaction --variable ON_ERROR_STOP=1 \
    --file "$WORKDIR/history_schema.sql" \
    --file "$WORKDIR/history_data.sql" \
    --dbname "$DEV_DB_URL"
fi

# schema.sql setval() can leave auth.refresh_tokens_id_seq behind existing rows
# (we keep DEV auth data). That breaks anonymous sign-in with refresh_tokens_pkey.
echo "Repairing auth.refresh_tokens sequence (keep ahead of max id)…"
psql --variable ON_ERROR_STOP=1 --dbname "$DEV_DB_URL" <<'SQL'
SELECT setval(
  'auth.refresh_tokens_id_seq',
  greatest(coalesce((SELECT max(id) FROM auth.refresh_tokens), 1), 1),
  true
);
SQL

echo "Linking CLI to DEV and applying any migrations PROD does not have yet…"
supabase link --project-ref "$DEV_REF" -p "$SUPABASE_DB_PASSWORD_DEV"
npm run db:up

echo "Done. DEV now has PROD data plus any newer local migrations."
echo "Open the app locally — you should see the orange DEV chrome."
