# Railway: Docker image with PHP + Node so scripts/railway-web-and-bot.sh works.
# (Nixpacks PHP-only images often have no `node` on PATH even with nixpacks.toml.)
FROM php:8.4-cli

RUN apt-get update && apt-get install -y \
    git \
    unzip \
    libzip-dev \
    zip \
    libicu-dev \
    default-libmysqlclient-dev \
    curl \
    ca-certificates \
    ffmpeg \
    && docker-php-ext-install intl zip pdo_mysql \
    && rm -rf /var/lib/apt/lists/*

# IMVU music relay: yt-dlp + cloudflared (Icecast should be reachable at ICECAST_HOST:ICECAST_PORT — e.g. a second Railway service from infra/icecast).
RUN set -eux; \
    curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) cf="cloudflared-linux-amd64" ;; \
      arm64) cf="cloudflared-linux-arm64" ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/${cf}" -o /usr/local/bin/cloudflared \
    && chmod a+rx /usr/local/bin/cloudflared

# IMVU music: optional Railway private Icecast — set ICECAST_HOST + ICECAST_HOST_SUFFIX on the service (see .env.example).
ENV FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    YTDLP_PATH=/usr/local/bin/yt-dlp \
    CLOUDFLARED_PATH=/usr/local/bin/cloudflared

RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

COPY --from=composer:latest /usr/bin/composer /usr/bin/composer

WORKDIR /app

COPY . .

# Laravel expects these dirs at runtime (pre-deploy migrate + artisan serve).
RUN mkdir -p bootstrap/cache \
    storage/framework/sessions \
    storage/framework/views \
    storage/framework/cache/data \
    storage/logs \
    && chmod -R a+rwX bootstrap/cache storage

RUN composer install --no-dev --optimize-autoloader --no-interaction --no-scripts \
    && npm ci \
    && npm run build

ENV PORT=8080
EXPOSE 8080

CMD ["bash", "scripts/railway-web-and-bot.sh"]
