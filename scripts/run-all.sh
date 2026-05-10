#!/usr/bin/env bash
# Local dev: Laravel (composer dev) + bot. For Railway one-service deploy, use railway-web-and-bot.sh.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WITH_ICECAST="${1:-}"

cd "$ROOT_DIR"

echo "==> Lurkbot one-command runner"

get_env_value() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key {sub(/^[^=]*=/, "", $0); print $0; exit}' .env 2>/dev/null || true
}

if [[ ! -f ".env" ]]; then
  echo "==> .env missing. Copying from .env.example"
  cp ".env.example" ".env"
fi

if [[ ! -d "vendor" || ! -d "node_modules" ]]; then
  echo "==> First-time app setup (composer setup)"
  composer setup
else
  echo "==> App dependencies already installed"
fi

if [[ ! -d "lurkbot-bot/node_modules" ]]; then
  echo "==> Installing bot dependencies"
  npm --prefix lurkbot-bot install
else
  echo "==> Bot dependencies already installed"
fi

if [[ "$WITH_ICECAST" == "--with-icecast" ]]; then
  echo "==> Starting Icecast services in background"
  if docker info >/dev/null 2>&1; then
    docker compose -f infra/icecast/docker-compose.yml up --build -d
  else
    echo "==> Docker daemon not running; skipping --with-icecast startup"
    echo "==> Start Docker Desktop first, or run Homebrew Icecast manually:"
    echo "   icecast -c infra/icecast/icecast.homebrew.xml"
  fi
fi

db_conn="$(get_env_value DB_CONNECTION)"
if [[ "${db_conn:-sqlite}" == "sqlite" ]] && [[ ! -f database/database.sqlite ]]; then
  mkdir -p database
  touch database/database.sqlite
  echo "==> Created database/database.sqlite (sqlite)"
fi

APP_URL="${APP_URL:-$(get_env_value APP_URL)}"
APP_URL="${APP_URL%/}"
if [[ "$APP_URL" == "http://localhost" ]] || [[ "$APP_URL" == "https://localhost" ]]; then
  APP_URL="http://127.0.0.1:8000"
  echo "==> Normalized APP_URL → ${APP_URL} (matches php artisan serve)"
fi
APP_URL="${APP_URL:-http://127.0.0.1:8000}"
export APP_URL
echo "==> Backend health wait target: ${APP_URL} (exported for Node bot)"

echo "==> Starting Laravel + bot processes"
exec npx concurrently -k -n app,bot -c blue,green \
  "composer dev" \
  "bash -lc 'for i in {1..120}; do code=\$(curl -s -o /dev/null -w \"%{http_code}\" \"${APP_URL}\" || true); if [[ \"\$code\" != \"000\" ]]; then echo \"[run-all] Backend reachable at ${APP_URL} (http \$code). Launching bot...\"; exec env APP_URL=\"${APP_URL}\" node lurkbot-bot/multi-launcher.js; fi; sleep 1; done; echo \"[run-all] Backend not reachable at ${APP_URL} after 120s. Check APP_URL / port, then rerun.\"; exit 1'"
