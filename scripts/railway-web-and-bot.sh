#!/usr/bin/env bash
# One Railway service: Laravel on $PORT + IMVU bot (multi-launcher).
# For local dev with Vite/queues, use scripts/run-all.sh instead.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:?PORT must be set (Railway provides this)}"

if [[ "${SKIP_DATABASE_MIGRATE:-}" != "1" ]]; then
  echo "==> [railway] Running database migrations (set SKIP_DATABASE_MIGRATE=1 to skip)"
  php artisan migrate --force
else
  echo "==> [railway] Skipping migrations (SKIP_DATABASE_MIGRATE=1)"
fi

php artisan storage:link >/dev/null 2>&1 || true

echo "==> [railway] Starting Laravel on 0.0.0.0:${PORT}"
php artisan serve --host=0.0.0.0 --port="${PORT}" &
PHP_PID=$!

cleanup() {
  if kill -0 "${PHP_PID}" 2>/dev/null; then
    kill "${PHP_PID}" 2>/dev/null || true
    wait "${PHP_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "==> [railway] Waiting for /up"
for _ in {1..90}; do
  if curl -sf "http://127.0.0.1:${PORT}/up" >/dev/null; then
    echo "==> [railway] Laravel is up"
    break
  fi
  sleep 1
done

if ! curl -sf "http://127.0.0.1:${PORT}/up" >/dev/null; then
  echo "==> [railway] Laravel did not become healthy on 127.0.0.1:${PORT}/up" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "==> [railway] ERROR: 'node' not in PATH. Use the repo-root Dockerfile on Railway (PHP + Node), or install Node in your image." >&2
  exit 127
fi

echo "==> [railway] Starting Node bot (multi-launcher)"
# Persistent volume keeps Chrome Singleton* symlinks from an old container hostname; new
# deploy then hits "profile in use on another computer". Strip those before Node starts.
if [[ -d lurkbot-bot/profiles ]]; then
  echo "==> [railway] Removing stale Chromium Singleton* locks under lurkbot-bot/profiles (volume + new hostname)"
  find lurkbot-bot/profiles \( -name SingletonLock -o -name SingletonCookie -o -name SingletonSocket \) \
    \( -type f -o -type l \) -delete 2>/dev/null || true
fi

# Same container as Laravel: bot must call loopback + PORT (not public APP_URL / not :8000).
export BOT_API_BASE_URL="http://127.0.0.1:${PORT}"
STATUS=0
node lurkbot-bot/multi-launcher.js || STATUS=$?
exit "${STATUS}"
