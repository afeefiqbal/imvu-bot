import axios from 'axios';
import { resolvedIcecastHost } from './resolvedIcecastHost.js';

/** Same slug rules as Laravel `LurkController::streamAudioConfig`. */
export function slugForIcecastMount(roomRaw) {
    let s = String(roomRaw || '')
        .trim()
        .toLowerCase()
        .replace(/^room-/i, '');
    s = s.replace(/[^0-9-]/g, '');
    return s || 'default';
}

function truthyEnvFlag(name) {
    const v = String(process.env[name] || '')
        .trim()
        .toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function truthyProcessEnvMusicEnabled() {
    return truthyEnvFlag('MUSIC_ENABLED') || truthyEnvFlag('IMVU_MUSIC_ENABLED');
}

/** Stale `php artisan config:cache` built without config/music.php → JSON often has enabled:false and missing host/port. */
function streamAudioConfigLooksIncomplete(d) {
    const hostOk = String(d.icecast_host ?? '').trim() !== '';
    const port = Number(d.icecast_port);
    const portOk = Number.isFinite(port) && port > 0;
    return !hostOk || !portOk;
}

/**
 * When Laravel config cache omits `music` or the API fails, use ICECAST_* from the bot process env
 * (multi-launcher loads repo `.env` into the child).
 * @param {string} roomId
 */
export function streamConfigFromProcessEnv(roomId) {
    if (!truthyProcessEnvMusicEnabled()) return null;
    const slug = slugForIcecastMount(roomId);
    let mountTpl = String(process.env.ICECAST_MOUNT_TEMPLATE || '/imvu-{room}.mp3').trim();
    let mount = mountTpl.replace(/\{room\}/g, slug);
    if (mount && mount[0] !== '/') mount = `/${mount}`;
    const host = resolvedIcecastHost();
    const port = parseInt(String(process.env.ICECAST_PORT || '8001'), 10) || 8001;
    const pubTpl = String(process.env.MUSIC_PUBLIC_STREAM_URL_TEMPLATE || '').trim();
    const publicStreamUrl = pubTpl ? pubTpl.replace(/\{room\}/g, slug) : '';
    return {
        enabled: true,
        icecastHost: host,
        icecastPort: port,
        icecastMount: mount,
        sourceUser: String(process.env.ICECAST_SOURCE_USER || 'source').trim(),
        sourcePassword: String(process.env.ICECAST_SOURCE_PASSWORD || ''),
        publicStreamUrl,
    };
}

/**
 * Laravel often has an empty MUSIC_PUBLIC_STREAM_URL_TEMPLATE while multi-launcher sets ngrok (or .env)
 * on process.env — prefer that expanded HTTPS URL for chat/DOM.
 */
/**
 * Append `?_play=…` so browsers/IMVU open a fresh HTTP connection each track (same Icecast mount).
 * Set MUSIC_STREAM_URL_CACHE_BUST=0 to disable. Does not change the Icecast path Icecast matches on.
 */
/**
 * Unique Icecast mount + public URL per track so IMVU room radio `station_url` changes for every
 * listener (same mount path often leaves in-room clients on a stale HTTP connection).
 * @param {NonNullable<ReturnType<typeof streamConfigFromProcessEnv>>} cfg
 * @param {string} roomId
 * @param {number} [playToken]
 */
export function withPerPlayStreamMount(cfg, roomId, playToken = Date.now()) {
    const off = /^(0|false|no|off)$/i.test(String(process.env.MUSIC_PER_PLAY_MOUNT ?? '1').trim());
    if (off || !cfg) return cfg;
    const slug = slugForIcecastMount(roomId);
    const token = String(playToken || Date.now());
    const mount = `/imvu-${slug}-${token}.mp3`;
    let publicStreamUrl = String(cfg.publicStreamUrl || '').trim();
    if (publicStreamUrl) {
        try {
            const u = new URL(publicStreamUrl);
            u.pathname = mount;
            u.search = '';
            u.hash = '';
            publicStreamUrl = u.toString();
        } catch {
            publicStreamUrl = '';
        }
    }
    if (!publicStreamUrl) {
        const pubTpl = String(process.env.MUSIC_PUBLIC_STREAM_URL_TEMPLATE || '').trim();
        if (pubTpl) {
            publicStreamUrl = pubTpl.includes('{play}')
                ? pubTpl.replace(/\{room\}/g, slug).replace(/\{play\}/g, token)
                : pubTpl.replace(/\{room\}/g, slug).replace(/\.mp3$/i, `-${token}.mp3`);
        }
    }
    return { ...cfg, icecastMount: mount, publicStreamUrl, perPlayMount: true };
}

export function cacheBustHttpsStreamUrl(url, seed = Date.now()) {
    const u = String(url || '').trim();
    if (!/^https:\/\//i.test(u)) return u;
    const v = String(process.env.MUSIC_STREAM_URL_CACHE_BUST ?? '1')
        .trim()
        .toLowerCase();
    if (v === '0' || v === 'false' || v === 'off' || v === 'no') return u;
    const sep = u.includes('?') ? '&' : '?';
    return `${u}${sep}_play=${Number(seed) || Date.now()}`;
}

export function finalizePublicStreamUrl(cfg, roomId) {
    if (!cfg?.enabled) return cfg;
    const slug = slugForIcecastMount(roomId);
    const tpl = String(process.env.MUSIC_PUBLIC_STREAM_URL_TEMPLATE || '').trim();
    if (!tpl) return cfg;
    const expanded = tpl.replace(/\{room\}/g, slug);
    if (!/^https:\/\//i.test(expanded)) return cfg;
    return { ...cfg, publicStreamUrl: expanded };
}

/**
 * @param {{ apiBaseUrl: string, roomId: string }} opts
 * @returns {Promise<{
 *   enabled: boolean,
 *   icecastHost: string,
 *   icecastPort: number,
 *   icecastMount: string,
 *   sourceUser: string,
 *   sourcePassword: string,
 *   publicStreamUrl: string
 * } | null>}
 */
export async function loadStreamConfig(opts) {
    const cfg = await loadStreamConfigInner(opts);
    return finalizePublicStreamUrl(cfg, opts.roomId);
}

async function loadStreamConfigInner({ apiBaseUrl, roomId }) {
    const base = String(apiBaseUrl || '').replace(/\/+$/, '');
    if (!base) return streamConfigFromProcessEnv(roomId);
    const rid = String(roomId || '').trim();
    if (!rid) return null;
    try {
        const res = await axios.get(`${base}/api/stream-audio-config`, {
            params: { room_id: rid },
            timeout: 12000,
            validateStatus: (s) => s < 500,
        });
        const d = res.data || {};
        if (d.enabled) {
            return {
                enabled: true,
                icecastHost: String(d.icecast_host || ''),
                icecastPort: Number(d.icecast_port) || 8001,
                icecastMount: String(d.icecast_mount || '/stream.mp3'),
                sourceUser: String(d.source_user || 'source'),
                sourcePassword: String(d.source_password || ''),
                publicStreamUrl: String(d.public_stream_url || '').trim(),
            };
        }
        if (res.status !== 200) {
            console.warn(`[music] stream-audio-config HTTP ${res.status}`);
        }
        if (
            truthyProcessEnvMusicEnabled() &&
            streamAudioConfigLooksIncomplete(d)
        ) {
            const fallback = streamConfigFromProcessEnv(rid);
            if (fallback) {
                console.warn(
                    '[music] Laravel returned incomplete stream config (often stale config cache). Using MUSIC_ENABLED + ICECAST_* from env. Fix: `php artisan config:clear` or `php artisan config:cache` after config/music.php exists.'
                );
                return fallback;
            }
        }
        return null;
    } catch (e) {
        console.warn('[music] loadStreamConfig:', e.message);
        const fallback = streamConfigFromProcessEnv(rid);
        if (fallback) {
            console.warn('[music] Using MUSIC_ENABLED + ICECAST_* from env after API error.');
            return fallback;
        }
        return null;
    }
}
