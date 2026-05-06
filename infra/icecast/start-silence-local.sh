#!/usr/bin/env bash
# Run alongside Homebrew Icecast (icecast.homebrew.xml on port 8001) so /lurkbot-silence.mp3 exists for <fallback-mount>.
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
if [[ -f "$REPO_ROOT/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$REPO_ROOT/.env"
    set +a
fi
export ICECAST_SOURCE_PASSWORD="${ICECAST_SOURCE_PASSWORD:-lurkbot_dev}"
export ICECAST_SILENCE_HOST="${ICECAST_SILENCE_HOST:-127.0.0.1}"
export ICECAST_SILENCE_PORT="${ICECAST_SILENCE_PORT:-8001}"
export ICECAST_SILENCE_MOUNT="${ICECAST_SILENCE_MOUNT:-/lurkbot-silence.mp3}"
exec "$SCRIPT_DIR/silence-entrypoint.sh"
