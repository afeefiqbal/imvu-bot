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
    && docker-php-ext-install intl zip pdo_mysql \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

COPY --from=composer:latest /usr/bin/composer /usr/bin/composer

WORKDIR /app

COPY . .

RUN composer install --no-dev --optimize-autoloader --no-interaction --no-scripts \
    && npm ci \
    && npm run build

ENV PORT=8080
EXPOSE 8080

CMD ["bash", "scripts/railway-web-and-bot.sh"]
