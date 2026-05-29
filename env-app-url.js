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

/** @returns {string} */
function railwayLaravelServiceUrl() {
    for (const [key, val] of Object.entries(process.env)) {
        if (!/^RAILWAY_SERVICE_.*_URL$/i.test(key) || !/laravel/i.test(key)) continue;
        const host = String(val || '')
            .trim()
            .replace(/^https?:\/\//i, '')
            .replace(/\/+$/, '');
        if (host) return `https://${host}`;
    }
    return '';
}

/**
 * URL for Node → Laravel HTTP API.
 *
 * Priority:
 * 1. BOT_API_BASE_URL / INTERNAL_APP_URL (always wins)
 * 2. Railway peer service URL (RAILWAY_SERVICE_*_LARAVEL*_URL) — bot-only deploy
 * 3. Same-container Laravel: LARAVEL_SAME_CONTAINER=1 → http://127.0.0.1:$PORT
 * 4. APP_URL or fallback
 */
export function backendApiBaseUrl(fallback = 'http://127.0.0.1:8000') {
    const explicit = String(process.env.BOT_API_BASE_URL || process.env.INTERNAL_APP_URL || '').trim();
    if (explicit) {
        return explicit.replace(/\/+$/, '');
    }

    const onPaaS =
        process.env.RAILWAY_ENVIRONMENT ||
        process.env.RAILWAY_PROJECT_ID ||
        process.env.DYNO ||
        process.env.FLY_APP_NAME ||
        process.env.RENDER;

    if (onPaaS) {
        const peer = railwayLaravelServiceUrl();
        if (peer) return peer;

        const sameContainer = /^(1|true|yes|on)$/i.test(
            String(process.env.LARAVEL_SAME_CONTAINER ?? '').trim(),
        );
        const port = String(process.env.PORT || '').trim();
        if (sameContainer && port) {
            return `http://127.0.0.1:${port}`;
        }
    }

    return appBaseUrl(fallback);
}
