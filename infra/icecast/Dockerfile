FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends debconf \
    && echo "icecast2 icecast2/hostname string icecast" | debconf-set-selections \
    && echo "icecast2 icecast2/source_password password placeholder" | debconf-set-selections \
    && echo "icecast2 icecast2/relay_password password placeholder" | debconf-set-selections \
    && echo "icecast2 icecast2/admin_password password placeholder" | debconf-set-selections \
    && apt-get install -y --no-install-recommends \
        icecast2 \
        gettext-base \
        media-types \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/* \
    && (getent group icecast >/dev/null || groupadd -r icecast) \
    && (getent passwd icecast >/dev/null \
        || useradd -r -g icecast -d /usr/share/icecast2 -s /usr/sbin/nologin icecast) \
    && mkdir -p /var/log/icecast2 \
    && chown icecast:icecast /var/log/icecast2

COPY icecast.production.xml /opt/icecast/icecast.production.xml
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV ICECAST_PORT=8001
ENV PORT=8001

EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8001/status-json.xsl >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
