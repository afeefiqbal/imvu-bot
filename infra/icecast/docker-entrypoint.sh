#!/bin/sh
set -eu

# Listen port: ICECAST_PORT wins, then Railway PORT, then 8001.
# Set ICECAST_PORT=8001 and PORT=8001 on Railway so public domain + private DNS match the bot.
export ICECAST_PORT="${ICECAST_PORT:-${PORT:-8001}}"
export ICECAST_SOURCE_PASSWORD="${ICECAST_SOURCE_PASSWORD:?Set ICECAST_SOURCE_PASSWORD (must match bot + Laravel)}"
export ICECAST_ADMIN_PASSWORD="${ICECAST_ADMIN_PASSWORD:-changeme}"

if ! getent passwd icecast >/dev/null 2>&1; then
    groupadd -r icecast
    useradd -r -g icecast -d /usr/share/icecast2 -s /usr/sbin/nologin icecast
fi

mkdir -p /var/log/icecast2
chown -R icecast:icecast /var/log/icecast2

envsubst '${ICECAST_PORT} ${ICECAST_SOURCE_PASSWORD} ${ICECAST_ADMIN_PASSWORD}' \
    < /opt/icecast/icecast.production.xml > /etc/icecast2/icecast.xml
chmod 644 /etc/icecast2/icecast.xml

echo "[icecast] listening on 0.0.0.0:${ICECAST_PORT}"

exec icecast2 -c /etc/icecast2/icecast.xml
