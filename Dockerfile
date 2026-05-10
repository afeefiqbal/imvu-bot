# Railway: Docker image with PHP + Node so scripts/railway-web-and-bot.sh works.
# (Nixpacks PHP-only images often have no `node` on PATH even with nixpacks.toml.)
FROM php:8.4-cli

# Puppeteer’s bundled Chrome needs NSS/GBM/X11 stack; php-cli image is too minimal without these.
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
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    xdg-utils \
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

# Laravel + IMVU bot: writable dirs at runtime (volume may replace lurkbot-bot/profiles at deploy).
RUN mkdir -p bootstrap/cache \
    storage/framework/sessions \
    storage/framework/views \
    storage/framework/cache/data \
    storage/logs \
    lurkbot-bot/profiles \
    && chmod -R a+rwX bootstrap/cache storage lurkbot-bot/profiles

RUN composer install --no-dev --optimize-autoloader --no-interaction --no-scripts \
    && npm ci \
    && npm run build \
    && (cd lurkbot-bot && npm ci)

ENV PORT=8080
EXPOSE 8080

CMD ["bash", "scripts/railway-web-and-bot.sh"]
