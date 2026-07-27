import axios from 'axios';

/** @type {string | null} null = not resolved yet; '' = no proxy */
let cachedProxy = null;
/** @type {Promise<string> | null} */
let inflight = null;
let loggedOnce = false;

function envFlagTrue(name, defaultOn) {
    const raw = process.env[name];
    if (raw == null || String(raw).trim() === '') return defaultOn;
    return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

function redactProxyUrl(url) {
    return String(url || '').replace(/\/\/([^/:@]+):([^@/]+)@/i, '//$1:***@');
}

function proxyUrlFromParts(username, password, host, port) {
    const h = String(host || '').trim();
    const pt = String(port || '').trim();
    if (!h || !pt) return null;
    const u = username != null && String(username) !== '' ? String(username) : '';
    const p = password != null && String(password) !== '' ? String(password) : '';
    if (u) {
        return `http://${encodeURIComponent(u)}:${encodeURIComponent(p)}@${h}:${pt}`;
    }
    return `http://${h}:${pt}`;
}

/**
 * Fetch one Webshare proxy URL for yt-dlp.
 * Prefer backbone (p.webshare.io) for YouTube — direct/datacenter free tier often still bot-blocks.
 * @param {string} token
 * @returns {Promise<string>}
 */
async function fetchOneWebshareProxy(token) {
    const modeRaw = String(
        process.env.YTDLP_WEBSHARE_MODE || process.env.WEBSHARE_PROXY_MODE || 'backbone',
    )
        .trim()
        .toLowerCase();
    const mode = modeRaw === 'direct' ? 'direct' : 'backbone';

    const res = await axios.get('https://proxy.webshare.io/api/v2/proxy/list/', {
        params: { mode, page: 1, page_size: 10 },
        headers: { Authorization: `Token ${token.trim()}` },
        timeout: 25000,
        validateStatus: () => true,
    });
    if (res.status !== 200) {
        const body =
            typeof res.data === 'object' && res.data !== null
                ? JSON.stringify(res.data).slice(0, 200)
                : String(res.data || res.statusText);
        throw new Error(`Webshare HTTP ${res.status}: ${body}`);
    }
    const results = Array.isArray(res.data?.results) ? res.data.results : [];
    for (const row of results) {
        const host =
            mode === 'backbone' ? 'p.webshare.io' : row.proxy_address && String(row.proxy_address).trim();
        const url = proxyUrlFromParts(row.username, row.password, host, row.port);
        if (url) return url;
    }
    throw new Error('Webshare returned no usable proxies');
}

/**
 * Sync snapshot for CLI flags (call ensureYtDlpProxy first when possible).
 * @returns {string}
 */
export function getYtDlpProxyUrlSync() {
    if (cachedProxy != null) return cachedProxy;
    return String(process.env.YTDLP_PROXY || '').trim();
}

/** Drop cache so the next ensure fetches a fresh Webshare endpoint (after bot-block). */
export function clearYtDlpProxyCache() {
    cachedProxy = null;
    loggedOnce = false;
}

/**
 * Resolve yt-dlp HTTP(S) proxy once per process (or after clear).
 * Precedence: YTDLP_PROXY → Webshare API (when YTDLP_WEBSHARE=1 and WEBSHARE_API_TOKEN set).
 * @returns {Promise<string>} proxy URL or ''
 */
export async function ensureYtDlpProxy() {
    if (cachedProxy != null) return cachedProxy;
    if (inflight) return inflight;

    inflight = (async () => {
        const explicit = String(process.env.YTDLP_PROXY || '').trim();
        if (explicit) {
            cachedProxy = explicit;
            if (!loggedOnce) {
                console.log(`[music] yt-dlp proxy (YTDLP_PROXY): ${redactProxyUrl(explicit)}`);
                loggedOnce = true;
            }
            return cachedProxy;
        }

        // Default on when a Webshare token exists — set YTDLP_WEBSHARE=0 to force direct IP.
        const token = String(
            process.env.YTDLP_WEBSHARE_TOKEN || process.env.WEBSHARE_API_TOKEN || '',
        ).trim();
        const useWebshare = envFlagTrue('YTDLP_WEBSHARE', Boolean(token));
        if (!useWebshare || !token) {
            cachedProxy = '';
            if (!loggedOnce && useWebshare && !token) {
                console.warn(
                    '[music] YTDLP_WEBSHARE on but WEBSHARE_API_TOKEN / YTDLP_WEBSHARE_TOKEN missing — YouTube uses server IP',
                );
                loggedOnce = true;
            }
            return cachedProxy;
        }

        try {
            const url = await fetchOneWebshareProxy(token);
            cachedProxy = url;
            if (!loggedOnce) {
                const mode = String(
                    process.env.YTDLP_WEBSHARE_MODE || process.env.WEBSHARE_PROXY_MODE || 'backbone',
                ).trim();
                console.log(
                    `[music] yt-dlp proxy (Webshare ${mode || 'backbone'}): ${redactProxyUrl(url)}`,
                );
                loggedOnce = true;
            }
            return cachedProxy;
        } catch (e) {
            console.warn(`[music] Webshare yt-dlp proxy failed: ${e?.message || e}`);
            cachedProxy = '';
            return cachedProxy;
        }
    })();

    try {
        return await inflight;
    } finally {
        inflight = null;
    }
}
