import axios from 'axios';

/**
 * VibeVerse API client for IMVU room music (Option A).
 * Search → POST /play → signed/progressive stream URL → set as IMVU room media URL.
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

/** VibeVerse “live stream — caching in background” proxy — often 0 bytes / TLS fail from OCI. */
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
    // Non-proxy https that isn't the progressive tunnel host.
    return /^https:\/\//i.test(u) && !/\.trycloudflare\.com\b/i.test(u);
}

function youtubeIdFromPlayPayload(playRes, track) {
    const fromPlay = String(playRes?.youtubeVideoId || '').trim();
    if (fromPlay) return fromPlay;
    const id = String(playRes?.track?.id || track?.id || '').trim();
    const m = /^yt[_-](.+)$/i.exec(id);
    if (m) return m[1];
    if (/^[\w-]{6,}$/i.test(id) && !id.includes('://')) return id;
    return '';
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
            // IMVU room radio plays MP3/mpeg reliably; m4a/AAC often sets URL but stays silent.
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
    const youtubeVideoId = youtubeIdFromPlayPayload(playRes.data, resolvedTrack);
    const cached = playRes.data.cached === true;
    const message = String(playRes.data.message || '');

    // Progressive trycloudflare /stream/ is often unusable from the bot host (0 bytes / TLS I/O).
    // Skip a long R2 wait when we can fall back to yt-dlp immediately.
    const progressiveUncached =
        (!cached && isVibeverseProgressiveStreamUrl(streamUrl)) ||
        /caching in background/i.test(message);

    if (
        !isPlayableAudioUrl(streamUrl) ||
        status === 'PREPARING' ||
        status === 'DOWNLOADING'
    ) {
        const ready = await waitForVibeverseReady(trackId, 45_000, { preferDurable: true });
        if (ready?.streamUrl) {
            streamUrl = String(ready.streamUrl).trim();
            status = String(ready.status || 'READY').toUpperCase();
        } else if (ready?.failed) {
            status = 'FAILED';
        }
    } else if (progressiveUncached && !isVibeverseDurableStreamUrl(streamUrl)) {
        // Brief poll in case R2 finishes instantly; otherwise yt-dlp.
        console.log(
            `[vibeverse] progressive/uncached for ${trackId}` +
                (message ? ` (${message})` : '') +
                (youtubeVideoId ? ' — prefer yt-dlp if no R2 file' : ' — waiting briefly for file URL'),
        );
        const ready = await waitForVibeverseReady(
            trackId,
            youtubeVideoId ? 4_000 : 25_000,
            { preferDurable: true },
        );
        if (ready?.streamUrl && isVibeverseDurableStreamUrl(ready.streamUrl)) {
            streamUrl = String(ready.streamUrl).trim();
            status = String(ready.status || 'READY').toUpperCase();
        } else if (ready?.failed) {
            status = 'FAILED';
        }
    }

    const durable = isVibeverseDurableStreamUrl(streamUrl);
    const progressive = isVibeverseProgressiveStreamUrl(streamUrl);

    // Progressive trycloudflare /stream/ often returns 0 bytes from the bot host (TLS I/O error).
    // Prefer yt-dlp via youtubeVideoId when we only have that proxy URL.
    if (!durable && (progressive || status === 'FAILED' || !isPlayableAudioUrl(streamUrl))) {
        if (youtubeVideoId) {
            console.warn(
                `[vibeverse] no durable stream for ${trackId} (status=${status}) — will use yt-dlp for ${youtubeVideoId}`,
            );
            return {
                trackId,
                title: String(resolvedTrack.title || track.title || 'Track'),
                artistName: String(resolvedTrack.artistName || track.artistName || ''),
                artworkUrl: resolvedTrack.artworkUrl || track.artworkUrl,
                durationMs: Number(resolvedTrack.durationMs || track.durationMs || 0) || 0,
                streamUrl: '',
                youtubeVideoId,
                sourceMode: 'ytdlp',
            };
        }
        console.warn(`[vibeverse] no playable stream for ${trackId} (status=${status})`);
        return null;
    }

    if (/\.m4a(\?|$)/i.test(streamUrl) || /audio\/(mp4|aac|x-m4a)/i.test(streamUrl)) {
        console.warn(
            `[vibeverse] stream is m4a/AAC — re-encoding to Icecast MP3 for IMVU.`,
        );
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
        youtubeVideoId: youtubeVideoId || undefined,
        sourceMode: 'http',
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
async function waitForVibeverseReady(trackId, timeoutMs = 45_000, opts = {}) {
    const base = apiBase();
    const preferDurable = opts.preferDurable === true;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        await new Promise((r) => setTimeout(r, 800));
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
