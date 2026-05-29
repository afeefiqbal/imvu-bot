#!/bin/sh
set -eu

export ICECAST_PORT="${ICECAST_PORT:-${PORT:-8001}}"
export ICECAST_SOURCE_PASSWORD="${ICECAST_SOURCE_PASSWORD:?Set ICECAST_SOURCE_PASSWORD (must match bot + Laravel)}"
export ICECAST_ADMIN_PASSWORD="${ICECAST_ADMIN_PASSWORD:-changeme}"

mkdir -p /var/log/icecast2
chown -R icecast:icecast /var/log/icecast2

envsubst '${ICECAST_PORT} ${ICECAST_SOURCE_PASSWORD} ${ICECAST_ADMIN_PASSWORD}' \
    < /opt/icecast/icecast.production.xml > /etc/icecast2/icecast.xml

echo "[icecast] listening on 0.0.0.0:${ICECAST_PORT}"

exec icecast2 -c /etc/icecast2/icecast.xml
