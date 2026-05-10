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
