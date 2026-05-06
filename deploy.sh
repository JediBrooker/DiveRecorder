#!/usr/bin/env bash
#
# Deploy script. Run from the box hosting the live service.
#
# Order is intentional:
#   pull → install → test → build → migrate → restart → health-check
#
#   * Tests + build run BEFORE migrate so a code-side failure
#     (broken syntax, TDZ, missing import, build error) surfaces
#     before we touch the DB.
#   * Migrate runs BEFORE restart so the new code starts against
#     the new schema. Every migration in this repo is additive
#     (ADD COLUMN, CREATE INDEX, etc.) so the OLD code keeps
#     working against the new schema during the brief window
#     between migrate and restart. If you ever ship a destructive
#     migration (DROP COLUMN, RENAME), use a two-deploy dance
#     instead — don't change this script.
#   * Health check at the end fails the deploy script (non-zero
#     exit) if the service didn't actually come back up. CI / cron
#     wrappers will see the failure.
#
# Usage:
#     ./deploy.sh              — full deploy, fail closed on any error
#     ./deploy.sh --skip-tests — emergency hotfix path; tests skipped
#     ./deploy.sh --dry        — print every step, change nothing

set -euo pipefail
cd "$(dirname "$0")"

# ---- Config ---------------------------------------------------
# Adjust these to match your environment.
PM2_PROCESS_NAME="diverecorder"
HEALTH_URL="http://127.0.0.1:3000/api/health"
HEALTH_TIMEOUT_S=10            # max time to wait for the service to come up

# ---- Args -----------------------------------------------------
SKIP_TESTS=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=1 ;;
    --dry|--dry-run) DRY_RUN=1 ;;
    *) echo "[deploy] unknown arg: $arg"; exit 2 ;;
  esac
done

# ---- Helpers --------------------------------------------------
step() { echo "[deploy] $(date -u +%FT%TZ) — $*"; }
run()  {
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "          DRY: $*"
  else
    eval "$@"
  fi
}

# ---- Preflight ------------------------------------------------
# Capture the current commit so a rollback is one git command.
# Prints to stdout for the deploy log.
PREV_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
step "starting deploy from ${PREV_SHA}"

# ---- 1. Pull --------------------------------------------------
# --ff-only refuses non-fast-forward merges so a manually-edited
# file on the box can't silently produce a merge commit.
step "git pull --ff-only"
run "git fetch --quiet"
run "git pull --ff-only"

NEW_SHA="$(git rev-parse --short HEAD)"
# Skip the no-op shortcut on dry-run — the dry-run intentionally
# didn't pull, so HEAD hasn't moved. We still want to show every
# downstream step that *would* have run.
if [[ $DRY_RUN -eq 0 && "$PREV_SHA" == "$NEW_SHA" ]]; then
  step "no new commits — nothing to deploy"
  exit 0
fi
step "advancing ${PREV_SHA} → ${NEW_SHA}"

# ---- 2. Install dependencies ----------------------------------
# npm ci is faster, deterministic, and fails loud if package.json
# and package-lock.json drift. We keep dev deps (Vite is a dev
# dep that the build step needs).
step "npm ci"
run "npm ci"

# ---- 3. Tests --------------------------------------------------
# The boot test in test/syntax.test.js catches TDZ / missing-
# binding regressions that node --check misses. Worth ~1s of
# deploy time.
if [[ $SKIP_TESTS -eq 0 ]]; then
  step "npm test"
  run "npm test"
else
  step "tests skipped (--skip-tests)"
fi

# ---- 4. Build SPA ---------------------------------------------
# Build BEFORE migrate so a broken build doesn't leave the DB
# advanced past code we can't ship.
step "npm run build"
run "npm run build"

# ---- 5. Apply pending migrations ------------------------------
# --dry first so the deploy log shows exactly what's about to
# run before the writes happen. The runner is idempotent
# (schema_meta.version + IF NOT EXISTS guards) so an accidental
# re-run is a no-op.
step "migrate (preview)"
run "npm run migrate -- --dry"
step "migrate (apply)"
run "npm run migrate"

# ---- 6. Restart service ---------------------------------------
# Named process, not "all", so other PM2 processes on this box
# (cron workers, side services) aren't disturbed.
step "pm2 restart ${PM2_PROCESS_NAME}"
run "pm2 restart ${PM2_PROCESS_NAME}"

# ---- 7. Health check ------------------------------------------
# Poll /api/health until it returns 200 or HEALTH_TIMEOUT_S
# passes. The endpoint also issues a trivial DB query, so a 503
# means the process bound the port but the pool can't talk to
# Postgres — equally unsafe to declare "deployed".
step "health check (timeout ${HEALTH_TIMEOUT_S}s)"
if [[ $DRY_RUN -eq 1 ]]; then
  echo "          DRY: would curl ${HEALTH_URL}"
  exit 0
fi

deadline=$(( $(date +%s) + HEALTH_TIMEOUT_S ))
while true; do
  if curl --fail --silent --show-error --max-time 3 "${HEALTH_URL}" > /tmp/deploy-health.json 2>/dev/null; then
    schema=$(grep -oE '"schema_version":[0-9]+' /tmp/deploy-health.json || echo 'schema_version:?')
    step "ok — ${schema}"
    rm -f /tmp/deploy-health.json
    exit 0
  fi
  if (( $(date +%s) >= deadline )); then
    echo "[deploy] FAILED — ${HEALTH_URL} did not return 200 within ${HEALTH_TIMEOUT_S}s."
    echo "[deploy] To roll back: git reset --hard ${PREV_SHA} && pm2 restart ${PM2_PROCESS_NAME}"
    echo "[deploy] (note: any migrations applied in this run are additive and safe to leave)."
    exit 1
  fi
  sleep 1
done
