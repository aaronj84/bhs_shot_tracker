#!/usr/bin/env bash
# Deploy Edge Functions to a linked Supabase project (DEV / STAGING — never PROD by accident).
#
#   ./scripts/deploy-edge-functions.sh --env staging
#   ./scripts/deploy-edge-functions.sh --project-ref <ref>
#   ./scripts/deploy-edge-functions.sh --env staging --dry-run
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_NAME=""
PROJECT_REF=""
DRY_RUN=0
FUNCTIONS=(explore-shots prep-opponent)

usage() {
  cat <<'EOF'
Usage:
  scripts/deploy-edge-functions.sh (--env staging|dev | --project-ref REF) [--dry-run]

Deploys explore-shots and prep-opponent from supabase/functions/.

  --env staging|dev   Resolve project ref from SUPABASE_PROJECT_REF_STAGING / _DEV
  --project-ref REF   Explicit project ref (refuses known PROD ref)
  --dry-run           Print actions only

Environment:
  SUPABASE_ACCESS_TOKEN          required in CI (local: supabase login)
  SUPABASE_PROJECT_REF_STAGING
  SUPABASE_PROJECT_REF_DEV
  SUPABASE_PROJECT_REF_PROD      used only as a deny-list (default sczdnalqmymhdornhkbn)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      ENV_NAME="${2:-}"
      shift 2
      ;;
    --project-ref)
      PROJECT_REF="${2:-}"
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

PROD_REF="${SUPABASE_PROJECT_REF_PROD:-sczdnalqmymhdornhkbn}"

if [[ -n "$ENV_NAME" && -n "$PROJECT_REF" ]]; then
  echo "Pass either --env or --project-ref, not both." >&2
  exit 1
fi

if [[ -n "$ENV_NAME" ]]; then
  case "$ENV_NAME" in
    staging)
      PROJECT_REF="${SUPABASE_PROJECT_REF_STAGING:-}"
      ;;
    dev)
      PROJECT_REF="${SUPABASE_PROJECT_REF_DEV:-fmiymqnfezkqagpbrmoi}"
      ;;
    prod)
      echo "Refusing to deploy functions to prod via this script." >&2
      exit 1
      ;;
    *)
      echo "--env must be staging or dev" >&2
      exit 1
      ;;
  esac
fi

if [[ -z "$PROJECT_REF" ]]; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    PROJECT_REF="${PROJECT_REF:-<staging-ref-unset>}"
    echo "Dry-run: SUPABASE_PROJECT_REF_STAGING / --project-ref not set; using placeholder."
  else
    echo "Missing project ref. Pass --env staging|dev or --project-ref." >&2
    usage >&2
    exit 1
  fi
fi

if [[ "$PROJECT_REF" == "$PROD_REF" ]]; then
  echo "Refusing deploy: project ref matches PROD ($PROD_REF)." >&2
  exit 1
fi

echo "Target project: $PROJECT_REF"
echo "Functions: ${FUNCTIONS[*]}"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry-run: would link and deploy."
  for fn in "${FUNCTIONS[@]}"; do
    echo "  supabase functions deploy $fn --project-ref $PROJECT_REF"
  done
  exit 0
fi

if ! command -v supabase >/dev/null 2>&1; then
  echo "supabase CLI not found." >&2
  exit 1
fi

supabase link --project-ref "$PROJECT_REF"

for fn in "${FUNCTIONS[@]}"; do
  echo "Deploying $fn…"
  supabase functions deploy "$fn" --project-ref "$PROJECT_REF"
done

echo "Edge function deploy complete."
echo "If Explore/Prep need LLM keys on this project:"
echo "  supabase secrets set OPENAI_API_KEY=… --project-ref $PROJECT_REF"
echo "  supabase secrets set GEMINI_API_KEY=… --project-ref $PROJECT_REF"
