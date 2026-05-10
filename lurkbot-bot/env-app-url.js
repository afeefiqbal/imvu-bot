/**
 * Strip trailing slashes from APP_URL so `${base}/api/...` never becomes `//api/...`
 * (Laravel's HTTP server returns 404 for paths like `//api/bots`).
 */
export function appBaseUrl(fallback = 'http://127.0.0.1:8000') {
    const raw = process.env.APP_URL;
    const s =
        raw != null && String(raw).trim() !== '' ? String(raw).trim() : String(fallback).trim();
    return s.replace(/\/+$/, '');
}

/**
 * URL for Node → Laravel HTTP calls on the **same** machine/container.
 * Railway: `php artisan serve` binds `PORT` (e.g. 8080); using public `APP_URL` from inside the
 * container often hits the wrong host or path → 404 on `/api/bots`. Prefer loopback + PORT.
 *
 * Override: BOT_API_BASE_URL or INTERNAL_APP_URL (no trailing slash).
 */
export function backendApiBaseUrl(fallback = 'http://127.0.0.1:8000') {
    const explicit = String(process.env.BOT_API_BASE_URL || process.env.INTERNAL_APP_URL || '').trim();
    if (explicit) {
        return explicit.replace(/\/+$/, '');
    }
    const port = String(process.env.PORT || '').trim();
    const passthroughHost =
        process.env.RAILWAY_ENVIRONMENT ||
        process.env.RAILWAY_PROJECT_ID ||
        process.env.DYNO ||
        process.env.FLY_APP_NAME ||
        process.env.RENDER;
    if (port && passthroughHost) {
        return `http://127.0.0.1:${port}`;
    }
    return appBaseUrl(fallback);
}
