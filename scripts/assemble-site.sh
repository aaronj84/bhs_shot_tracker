#!/usr/bin/env bash
# Assemble the static site into OUT_DIR (default _site), including shots-config.js.
#
# Expects shots-config.js already written (write-shots-config.js) or writes it
# when SHOTS_SUPABASE_URL + SHOTS_SUPABASE_ANON_KEY are set.
#
#   ./scripts/assemble-site.sh
#   ./scripts/assemble-site.sh --out _staging_site
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT_DIR="_site"

usage() {
  cat <<'EOF'
Usage:
  scripts/assemble-site.sh [--out DIR]

Copies the static frontend into DIR (default: _site).
Writes shots-config.js from env when SHOTS_SUPABASE_URL and
SHOTS_SUPABASE_ANON_KEY are set; otherwise requires an existing shots-config.js.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      OUT_DIR="${2:-}"
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

if [[ -n "${SHOTS_SUPABASE_URL:-}" && -n "${SHOTS_SUPABASE_ANON_KEY:-}" ]]; then
  node "$ROOT/scripts/write-shots-config.js"
elif [[ ! -f "$ROOT/shots-config.js" ]]; then
  echo "Need shots-config.js or SHOTS_SUPABASE_URL + SHOTS_SUPABASE_ANON_KEY." >&2
  exit 1
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/assets"

cp index.html styles.css app.js shots.js shots-api.js shots-config.js .nojekyll "$OUT_DIR/"
if [[ -d assets ]]; then
  cp -R assets/* "$OUT_DIR/assets/" 2>/dev/null || true
fi

# Optional brand hint for staging (no UI chrome required — config brandSub is enough).
echo "Assembled $OUT_DIR"
