FROM php:8.4-cli

RUN apt-get update && apt-get install -y \
    git \
    unzip \
    libzip-dev \
    zip \
    libicu-dev \
    default-libmysqlclient-dev \
    curl \
    && docker-php-ext-install intl zip pdo_mysql \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

COPY --from=composer:latest /usr/bin/composer /usr/bin/composer

WORKDIR /app

COPY . .

RUN composer install --optimize-autoloader --no-scripts --no-interaction

RUN npm install && npm run build

# Railway sets PORT; must listen on 0.0.0.0 (not 127.0.0.1) or the edge returns 502.
CMD ["sh", "-c", "bash scripts/railway-web-and-bot.sh"]
