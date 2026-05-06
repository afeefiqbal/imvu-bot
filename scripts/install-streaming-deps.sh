#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ICECAST_XML="$ROOT/infra/icecast/icecast.xml"

echo "==> ffmpeg + Icecast helpers for lurkbot music"
echo ""

if command -v brew >/dev/null 2>&1; then
  echo "Installing ffmpeg (required for YouTube → encode → Icecast)..."
  brew install ffmpeg
  echo "Installing cloudflared (recommended HTTPS tunnel for IMVU links)..."
  brew install cloudflared
  echo ""
  echo "Optional: native Icecast (or use Docker — see below):"
  echo "  brew install icecast"
  echo ""
  PREFIX="$(brew --prefix icecast 2>/dev/null || true)"
  if [[ -n "${PREFIX}" && -d "${PREFIX}/share/icecast" ]]; then
    echo "Homebrew Icecast share directory: ${PREFIX}/share/icecast"
    echo "Copy infra/icecast/icecast.xml, update <paths> to use that prefix, then:"
    echo "  icecast -c /path/to/patched-icecast.xml"
  fi
else
  echo "Homebrew not found. Install ffmpeg + Icecast via your OS package manager,"
  echo "or use Docker only for Icecast."
fi

echo ""
echo "==> Icecast via Docker (matches infra/icecast/icecast.xml paths)"
if command -v docker >/dev/null 2>&1; then
  echo "  cd \"$ROOT\" && docker compose -f infra/icecast/docker-compose.yml up --build"
else
  echo "  Install Docker Desktop, then:"
  echo "  cd \"$ROOT\" && docker compose -f infra/icecast/docker-compose.yml up --build"
fi

echo ""
echo "==> Laravel .env (must match icecast.xml listen port + source-password)"
echo "  MUSIC_ENABLED=true"
echo "  ICECAST_HOST=127.0.0.1"
echo "  ICECAST_PORT=8001   # Homebrew Icecast (8000 would clash with artisan serve on 8000)"
echo "  ICECAST_PORT=8000   # Docker Icecast only if Laravel is not on host:8000"
echo "  ICECAST_MOUNT_TEMPLATE=/imvu-{room}.mp3"
echo "  ICECAST_SOURCE_USER=source"
echo "  ICECAST_SOURCE_PASSWORD=lurkbot_dev"
echo "  IMVU_MUSIC_ENABLED=1"
echo "  MUSIC_PUBLIC_STREAM_URL_TEMPLATE=https://<your-tunnel>/imvu-{room}.mp3"
echo ""
echo "Config file: $ICECAST_XML"
