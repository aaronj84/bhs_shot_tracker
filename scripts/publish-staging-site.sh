#!/usr/bin/env bash
# Publish the assembled staging static site.
#
# Always safe: copies/verifies OUT_DIR.
# Optional live URL when SURGE_TOKEN (+ SURGE_LOGIN) are set:
#   npx surge OUT_DIR DOMAIN
#
#   ./scripts/publish-staging-site.sh --dir _staging_site
#   ./scripts/publish-staging-site.sh --dir _staging_site --dry-run
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SITE_DIR="_staging_site"
DOMAIN="${STAGING_SURGE_DOMAIN:-bhs-shot-tracker-staging.surge.sh}"
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage:
  scripts/publish-staging-site.sh [--dir DIR] [--domain HOST] [--dry-run]

Publishes DIR (default _staging_site) to surge.sh when SURGE_TOKEN is set.
Without surge credentials, exits 0 after verifying the site folder exists
(so CI can still upload it as an Actions artifact).

Environment:
  SURGE_LOGIN / SURGE_TOKEN   optional; enables public staging URL
  STAGING_SURGE_DOMAIN        default bhs-shot-tracker-staging.surge.sh
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      SITE_DIR="${2:-}"
      shift 2
      ;;
    --domain)
      DOMAIN="${2:-}"
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

if [[ ! -d "$SITE_DIR" ]]; then
  echo "Site directory not found: $SITE_DIR (run assemble-site / staging-refresh first)." >&2
  exit 1
fi

if [[ ! -f "$SITE_DIR/index.html" || ! -f "$SITE_DIR/shots-config.js" ]]; then
  echo "Site directory incomplete (need index.html + shots-config.js)." >&2
  exit 1
fi

# Guard: staging config must not point at known PROD ref.
PROD_REF="${SUPABASE_PROJECT_REF_PROD:-sczdnalqmymhdornhkbn}"
if grep -q "$PROD_REF" "$SITE_DIR/shots-config.js"; then
  echo "Refusing publish: shots-config.js references PROD project $PROD_REF." >&2
  exit 1
fi

echo "Site OK: $SITE_DIR ($(du -sh "$SITE_DIR" | awk '{print $1}'))"

if [[ "$DRY_RUN" -eq 1 ]]; then
  if [[ -z "${SURGE_TOKEN:-}" ]]; then
    echo "Dry-run: SURGE_TOKEN not set — would skip live publish (artifact-only)."
  else
    echo "Dry-run: would run npx surge $SITE_DIR $DOMAIN"
  fi
  exit 0
fi

if [[ -z "${SURGE_TOKEN:-}" ]]; then
  echo "SURGE_TOKEN not set — skipping live publish (artifact-only mode)."
  echo "Set SURGE_LOGIN + SURGE_TOKEN for https://$DOMAIN"
  exit 0
fi

export SURGE_LOGIN="${SURGE_LOGIN:-}"
export SURGE_TOKEN

npx --yes surge "$SITE_DIR" "$DOMAIN"

echo "Published https://$DOMAIN"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "staging_url=https://$DOMAIN" >> "$GITHUB_OUTPUT"
fi
