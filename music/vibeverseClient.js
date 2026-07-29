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
 * @typedef {{
 *   trackId: string,
 *   title: string,
 *   artistName: string,
 *   artworkUrl?: string,
 *   durationMs: number,
 *   streamUrl: string,
 * }} VibeversePlayable
 */

/**
 * @typedef {{
 *   ok: true,
 *   track: VibeversePlayable,
 * } | {
 *   ok: false,
 *   reason: 'not-found' | 'play-failed' | 'download-failed' | 'not-ready' | 'network' | 'disabled',
 *   detail?: string,
 *   title?: string,
 * }} VibeverseResolveResult
 */

/**
 * @param {string} query
 * @returns {Promise<VibeverseResolveResult>}
 */
export async function resolveVibeversePlayable(query) {
    const base = apiBase();
    if (!base) return { ok: false, reason: 'disabled' };
    const q = String(query || '').trim();
    if (!q) return { ok: false, reason: 'not-found' };

    try {
        const search = await axios.get(`${base}/search`, {
            params: { q, source: 'youtube' },
            timeout: 20_000,
            validateStatus: () => true,
        });
        if (search.status >= 400 || !search.data) {
            console.warn(`[vibeverse] search HTTP ${search.status}`);
            return {
                ok: false,
                reason: 'play-failed',
                detail: `search HTTP ${search.status}`,
            };
        }

        const tracks = Array.isArray(search.data.tracks) ? search.data.tracks : [];
        const track =
            search.data.top ||
            tracks.find((t) => t?.provider === 'YOUTUBE') ||
            tracks[0] ||
            null;
        if (!track?.id) {
            console.warn(`[vibeverse] search found no tracks for “${q.slice(0, 80)}”`);
            return { ok: false, reason: 'not-found' };
        }

        return playVibeverseTrack(track);
    } catch (e) {
        console.warn(`[vibeverse] search/play network error:`, e?.message || e);
        return { ok: false, reason: 'network', detail: e?.message || 'network error' };
    }
}

/**
 * Chat-friendly line for a failed resolve (keeps !play / !add messaging consistent).
 * @param {Extract<VibeverseResolveResult, { ok: false }>} result
 * @param {'play' | 'add'} [verb]
 */
export function formatVibeverseResolveFailure(result, verb = 'play') {
    const again = verb === 'add' ? '!add' : '!play';
    switch (result?.reason) {
        case 'not-found':
            return 'Could not find that track.';
        case 'download-failed':
            return `VibeVerse could not download that track${result.detail ? ` (${result.detail})` : ''}. Try another version or ${again} again later.`;
        case 'network':
            return 'Music lookup failed (network). Try again in a moment.';
        case 'disabled':
            return 'Music lookup is not configured.';
        case 'play-failed':
            return `Could not start that track on VibeVerse. Try ${again} again in a moment.`;
        case 'not-ready':
        default:
            return `VibeVerse has not finished preparing that track yet. Try ${again} again in a moment.`;
    }
}

/**
 * @param {{
 *   id: string,
 *   title?: string,
 *   artistName?: string,
 *   artworkUrl?: string,
 *   durationMs?: number,
 * }} track
 * @returns {Promise<VibeverseResolveResult>}
 */
export async function playVibeverseTrack(track) {
    const base = apiBase();
    if (!base || !track?.id) return { ok: false, reason: 'not-found' };

    const titleHint = String(track.title || '').trim();

    /** Prefer an already-cached R2 file before / after /play. */
    const tryStatusDurable = async (trackId) => {
        const st = await fetchVibeverseStatus(trackId);
        if (st?.failed) {
            return { failed: true, error: st.error };
        }
        const url = String(st?.streamUrl || '').trim();
        if (isVibeverseDurableStreamUrl(url)) {
            return { streamUrl: url, status: String(st.status || 'READY').toUpperCase(), data: st };
        }
        return null;
    };

    let playRes;
    try {
        playRes = await axios.post(
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
    } catch (e) {
        console.warn(`[vibeverse] play network error:`, e?.message || e);
        const cached = await tryStatusDurable(track.id);
        if (cached?.streamUrl) {
            return finishPlayable(track, track, cached.streamUrl);
        }
        return { ok: false, reason: 'network', detail: e?.message || 'play failed', title: titleHint };
    }

    if (playRes.status >= 400 || !playRes.data) {
        console.warn(`[vibeverse] play HTTP ${playRes.status}:`, playRes.data?.error || playRes.data || '');
        // Song may already be cached even when /play errors (e.g. extractor busy).
        const cached = await tryStatusDurable(track.id);
        if (cached?.streamUrl) {
            console.log(`[vibeverse] /play failed but durable cache hit for ${track.id}`);
            return finishPlayable(track, track, cached.streamUrl);
        }
        return {
            ok: false,
            reason: 'play-failed',
            detail: `play HTTP ${playRes.status}`,
            title: titleHint,
        };
    }

    let streamUrl = String(playRes.data.streamUrl || '').trim();
    let status = String(playRes.data.status || '').toUpperCase();
    const resolvedTrack = playRes.data.track || track;
    const trackId = String(resolvedTrack.id || track.id);
    const cached = playRes.data.cached === true;
    const message = String(playRes.data.message || '');

    // Already have a usable file URL — skip the wait.
    if (isVibeverseDurableStreamUrl(streamUrl) && status !== 'PREPARING' && status !== 'DOWNLOADING') {
        return finishPlayable(resolvedTrack, track, streamUrl);
    }

    // Cache may already be READY on /status while /play still returns a progressive URL.
    const pre = await tryStatusDurable(trackId);
    if (pre?.failed) {
        console.warn(`[vibeverse] download failed for ${trackId}`);
        return {
            ok: false,
            reason: 'download-failed',
            detail: String(pre.error || 'download failed'),
            title: String(resolvedTrack.title || titleHint || ''),
        };
    }
    if (pre?.streamUrl) {
        console.log(`[vibeverse] durable cache already ready for ${trackId}`);
        return finishPlayable(resolvedTrack, track, pre.streamUrl);
    }

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
            return {
                ok: false,
                reason: 'download-failed',
                detail: String(ready.error || 'download failed'),
                title: String(resolvedTrack.title || titleHint || ''),
            };
        }
        if (ready?.streamUrl && isVibeverseDurableStreamUrl(ready.streamUrl)) {
            streamUrl = String(ready.streamUrl).trim();
            status = String(ready.status || 'READY').toUpperCase();
        } else {
            console.warn(
                `[vibeverse] timed out waiting for durable stream for ${trackId} (last status=${status})`,
            );
            return {
                ok: false,
                reason: 'not-ready',
                detail: `last status=${status || '?'}`,
                title: String(resolvedTrack.title || titleHint || ''),
            };
        }
    }

    if (!isVibeverseDurableStreamUrl(streamUrl)) {
        console.warn(`[vibeverse] no durable stream for ${trackId} (status=${status})`);
        return {
            ok: false,
            reason: 'not-ready',
            detail: `status=${status || '?'}`,
            title: String(resolvedTrack.title || titleHint || ''),
        };
    }

    return finishPlayable(resolvedTrack, track, streamUrl);
}

/**
 * @param {object} resolvedTrack
 * @param {object} fallbackTrack
 * @param {string} streamUrl
 * @returns {Extract<VibeverseResolveResult, { ok: true }>}
 */
function finishPlayable(resolvedTrack, fallbackTrack, streamUrl) {
    const trackId = String(resolvedTrack.id || fallbackTrack.id);
    if (/\.mp3(\?|$)/i.test(streamUrl) || /audio\/mpeg/i.test(streamUrl)) {
        console.log(`[vibeverse] durable MP3 ready for IMVU encode.`);
    } else if (/\.m4a(\?|$)/i.test(streamUrl) || /audio\/(mp4|aac|x-m4a)/i.test(streamUrl)) {
        console.warn(`[vibeverse] stream is m4a/AAC — downloading locally then re-encoding to Icecast MP3.`);
    }
    console.log(
        `[music] stream URL for “${String(resolvedTrack.title || fallbackTrack.title || trackId)}”: ${streamUrl}`,
    );
    return {
        ok: true,
        track: {
            trackId,
            title: String(resolvedTrack.title || fallbackTrack.title || 'Track'),
            artistName: String(resolvedTrack.artistName || fallbackTrack.artistName || ''),
            artworkUrl: resolvedTrack.artworkUrl || fallbackTrack.artworkUrl,
            durationMs: Number(resolvedTrack.durationMs || fallbackTrack.durationMs || 0) || 0,
            streamUrl,
        },
    };
}

/**
 * Re-mint a stream URL for a known track id (e.g. resume after pause).
 * @param {string} trackId
 * @param {{ title?: string, artistName?: string, artworkUrl?: string, durationMs?: number }} [hint]
 */
export async function refreshVibeverseStream(trackId, hint = {}) {
    const result = await playVibeverseTrack({
        id: trackId,
        title: hint.title,
        artistName: hint.artistName,
        artworkUrl: hint.artworkUrl,
        durationMs: hint.durationMs,
    });
    return result.ok ? result.track : null;
}

async function fetchVibeverseStatus(trackId) {
    const base = apiBase();
    if (!base || !trackId) return null;
    try {
            const res = await axios.get(`${base}/tracks/${encodeURIComponent(trackId)}/status`, {
                params: { preferMp3: 1, format: 'mp3' },
                timeout: 10_000,
                validateStatus: () => true,
            });
        if (res.status >= 400 || !res.data) return null;
        const status = String(res.data.status || '').toUpperCase();
        if (status === 'FAILED') {
            return { failed: true, status: 'FAILED', error: res.data.error, streamUrl: '' };
        }
        return res.data;
    } catch (e) {
        console.warn('[vibeverse] status:', e?.message || e);
        return null;
    }
}

/**
 * @param {string} trackId
 * @param {number} [timeoutMs]
 * @param {{ preferDurable?: boolean }} [opts]
 */
async function waitForVibeverseReady(trackId, timeoutMs = 90_000, opts = {}) {
    const preferDurable = opts.preferDurable !== false;
    const started = Date.now();
    let lastLog = 0;
    let first = true;
    while (Date.now() - started < timeoutMs) {
        if (!first) {
            await new Promise((r) => setTimeout(r, 1000));
        }
        first = false;
        try {
            const data = await fetchVibeverseStatus(trackId);
            if (!data) continue;
            if (data.failed) {
                console.warn(`[vibeverse] download failed: ${data.error || 'unknown'}`);
                return { failed: true, status: 'FAILED', error: data.error };
            }
            const status = String(data.status || '').toUpperCase();
            const url = String(data.streamUrl || '').trim();
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
                return data;
            }
        } catch (e) {
            console.warn('[vibeverse] status poll:', e?.message || e);
        }
    }
    return null;
}
