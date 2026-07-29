import axios from 'axios';

/**
 * VibeVerse API client for IMVU room music.
 * Search → POST /play → wait for durable file URL → ffmpeg → Icecast.
 * Progressive trycloudflare /stream/ proxies are not used (often 0 bytes from the bot host).
 */

function apiBase() {
    return String(process.env.VIBEVERSE_API_URL || '')
        .trim()
        .replace(/\/$/, '');
}

export function vibeverseEnabled() {
    return Boolean(apiBase());
}

function isPlayableAudioUrl(url) {
    if (!url) return false;
    return /^https?:\/\//i.test(String(url));
}

/** VibeVerse “live stream — caching in background” proxy — often unusable from OCI. */
export function isVibeverseProgressiveStreamUrl(url) {
    const u = String(url || '');
    return /\/stream\//i.test(u) && /\.trycloudflare\.com\b/i.test(u);
}

/** Signed R2 / direct file URLs that ffmpeg can pull reliably. */
export function isVibeverseDurableStreamUrl(url) {
    const u = String(url || '').trim();
    if (!isPlayableAudioUrl(u) || isVibeverseProgressiveStreamUrl(u)) return false;
    if (/cloudflarestorage\.com|\.r2\.cloudflarestorage\.|\/vibeverse-audio\//i.test(u)) return true;
    if (/\.(mp3|m4a|aac|ogg|opus|wav)(\?|$)/i.test(u)) return true;
    return /^https:\/\//i.test(u) && !/\.trycloudflare\.com\b/i.test(u);
}

function readyWaitMs() {
    return Math.max(
        15_000,
        parseInt(String(process.env.VIBEVERSE_READY_WAIT_MS || '90000'), 10) || 90_000,
    );
}

/**
 * @param {string} query
 * @returns {Promise<{
 *   trackId: string,
 *   title: string,
 *   artistName: string,
 *   artworkUrl?: string,
 *   durationMs: number,
 *   streamUrl: string,
 * } | null>}
 */
export async function resolveVibeversePlayable(query) {
    const base = apiBase();
    if (!base) return null;
    const q = String(query || '').trim();
    if (!q) return null;

    const search = await axios.get(`${base}/search`, {
        params: { q, source: 'youtube' },
        timeout: 20_000,
        validateStatus: () => true,
    });
    if (search.status >= 400 || !search.data) {
        console.warn(`[vibeverse] search HTTP ${search.status}`);
        return null;
    }

    const tracks = Array.isArray(search.data.tracks) ? search.data.tracks : [];
    const track =
        search.data.top ||
        tracks.find((t) => t?.provider === 'YOUTUBE') ||
        tracks[0] ||
        null;
    if (!track?.id) return null;

    return playVibeverseTrack(track);
}

/**
 * @param {{
 *   id: string,
 *   title?: string,
 *   artistName?: string,
 *   artworkUrl?: string,
 *   durationMs?: number,
 * }} track
 */
export async function playVibeverseTrack(track) {
    const base = apiBase();
    if (!base || !track?.id) return null;

    const playRes = await axios.post(
        `${base}/play`,
        {
            trackId: track.id,
            title: track.title,
            artistName: track.artistName,
            artworkUrl: track.artworkUrl,
            durationMs: track.durationMs,
            source: 'QUEUE',
            // Prefer mp3 when VibeVerse can provide it; m4a is re-encoded via Icecast.
            format: 'mp3',
            container: 'mp3',
            preferMp3: true,
        },
        {
            timeout: 45_000,
            validateStatus: () => true,
            headers: { 'Content-Type': 'application/json' },
        },
    );

    if (playRes.status >= 400 || !playRes.data) {
        console.warn(`[vibeverse] play HTTP ${playRes.status}:`, playRes.data?.error || playRes.data || '');
        return null;
    }

    let streamUrl = String(playRes.data.streamUrl || '').trim();
    let status = String(playRes.data.status || '').toUpperCase();
    const resolvedTrack = playRes.data.track || track;
    const trackId = String(resolvedTrack.id || track.id);
    const cached = playRes.data.cached === true;
    const message = String(playRes.data.message || '');

    const needsDurableWait =
        !isVibeverseDurableStreamUrl(streamUrl) ||
        status === 'PREPARING' ||
        status === 'DOWNLOADING' ||
        (!cached && isVibeverseProgressiveStreamUrl(streamUrl)) ||
        /caching in background/i.test(message);

    if (needsDurableWait) {
        console.log(
            `[vibeverse] waiting for durable file URL for ${trackId}` +
                (message ? ` (${message})` : '') +
                `… up to ${Math.round(readyWaitMs() / 1000)}s`,
        );
        const ready = await waitForVibeverseReady(trackId, readyWaitMs(), { preferDurable: true });
        if (ready?.failed) {
            console.warn(`[vibeverse] download failed for ${trackId}`);
            return null;
        }
        if (ready?.streamUrl && isVibeverseDurableStreamUrl(ready.streamUrl)) {
            streamUrl = String(ready.streamUrl).trim();
            status = String(ready.status || 'READY').toUpperCase();
        } else {
            console.warn(
                `[vibeverse] timed out waiting for durable stream for ${trackId} (last status=${status})`,
            );
            return null;
        }
    }

    if (!isVibeverseDurableStreamUrl(streamUrl)) {
        console.warn(`[vibeverse] no durable stream for ${trackId} (status=${status})`);
        return null;
    }

    if (/\.m4a(\?|$)/i.test(streamUrl) || /audio\/(mp4|aac|x-m4a)/i.test(streamUrl)) {
        console.warn(`[vibeverse] stream is m4a/AAC — re-encoding to Icecast MP3 for IMVU.`);
    }

    console.log(
        `[music] stream URL for “${String(resolvedTrack.title || track.title || trackId)}”: ${streamUrl}`,
    );

    return {
        trackId,
        title: String(resolvedTrack.title || track.title || 'Track'),
        artistName: String(resolvedTrack.artistName || track.artistName || ''),
        artworkUrl: resolvedTrack.artworkUrl || track.artworkUrl,
        durationMs: Number(resolvedTrack.durationMs || track.durationMs || 0) || 0,
        streamUrl,
    };
}

/**
 * Re-mint a stream URL for a known track id (e.g. resume after pause).
 * @param {string} trackId
 * @param {{ title?: string, artistName?: string, artworkUrl?: string, durationMs?: number }} [hint]
 */
export async function refreshVibeverseStream(trackId, hint = {}) {
    return playVibeverseTrack({
        id: trackId,
        title: hint.title,
        artistName: hint.artistName,
        artworkUrl: hint.artworkUrl,
        durationMs: hint.durationMs,
    });
}

/**
 * @param {string} trackId
 * @param {number} [timeoutMs]
 * @param {{ preferDurable?: boolean }} [opts]
 */
async function waitForVibeverseReady(trackId, timeoutMs = 90_000, opts = {}) {
    const base = apiBase();
    const preferDurable = opts.preferDurable !== false;
    const started = Date.now();
    let lastLog = 0;
    while (Date.now() - started < timeoutMs) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
            const res = await axios.get(`${base}/tracks/${encodeURIComponent(trackId)}/status`, {
                timeout: 10_000,
                validateStatus: () => true,
            });
            if (res.status >= 400 || !res.data) continue;
            const status = String(res.data.status || '').toUpperCase();
            if (status === 'FAILED') {
                console.warn(`[vibeverse] download failed: ${res.data.error || 'unknown'}`);
                return { failed: true, status: 'FAILED', error: res.data.error };
            }
            const url = String(res.data.streamUrl || '').trim();
            const now = Date.now();
            if (now - lastLog > 10_000) {
                lastLog = now;
                console.log(
                    `[vibeverse] still preparing ${trackId}: status=${status || '?'} ` +
                        `(${Math.round((now - started) / 1000)}s)`,
                );
            }
            if (!isPlayableAudioUrl(url)) continue;
            if (preferDurable && !isVibeverseDurableStreamUrl(url)) continue;
            if (status === 'READY' || isVibeverseDurableStreamUrl(url)) {
                return res.data;
            }
        } catch (e) {
            console.warn('[vibeverse] status poll:', e?.message || e);
        }
    }
    return null;
}
