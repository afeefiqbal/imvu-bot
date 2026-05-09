#!/usr/bin/env bash
# One Railway service: Laravel on $PORT + IMVU bot (multi-launcher).
# For local dev with Vite/queues, use scripts/run-all.sh instead.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:?PORT must be set (Railway provides this)}"

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

echo "==> [railway] Starting Node bot (multi-launcher)"
STATUS=0
node lurkbot-bot/multi-launcher.js || STATUS=$?
exit "${STATUS}"
