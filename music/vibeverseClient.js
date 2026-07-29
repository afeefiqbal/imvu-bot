import axios from 'axios';

/**
 * Thin VibeVerse client for IMVU room music.
 *
 * Ask VibeVerse → wait until durable cache is READY → return signed URL.
 * Bot then: downloadToTemp → ffmpeg → Icecast → set IMVU room radio.
 * YouTube / extract / queue / progressive cold-play stay in VibeVerse.
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

/** Extractor progressive pipes are for the web player — not durable for Icecast. */
function isProgressiveExtractorUrl(url) {
    const s = String(url || '');
    return /\/stream\/[\w-]{11}(\?|$)/i.test(s);
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
            // Durable R2 (+ mp3 when available). Never progressive extractor pipes.
            preferMp3: true,
            requireCached: true,
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

    const needsWait =
        !isPlayableAudioUrl(streamUrl) ||
        isProgressiveExtractorUrl(streamUrl) ||
        status === 'PREPARING' ||
        status === 'DOWNLOADING' ||
        status === 'PENDING';

    if (needsWait) {
        const ready = await waitForVibeverseReady(trackId, 90_000);
        if (ready?.streamUrl) {
            streamUrl = ready.streamUrl;
            status = 'READY';
        }
    }

    if (!isPlayableAudioUrl(streamUrl) || isProgressiveExtractorUrl(streamUrl)) {
        console.warn(`[vibeverse] no durable stream for ${trackId} (status=${status})`);
        return null;
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

async function waitForVibeverseReady(trackId, timeoutMs = 90_000) {
    const base = apiBase();
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
            const res = await axios.get(`${base}/tracks/${encodeURIComponent(trackId)}/status`, {
                params: { preferMp3: '1', requireCached: '1' },
                timeout: 10_000,
                validateStatus: () => true,
            });
            if (res.status >= 400 || !res.data) continue;
            const status = String(res.data.status || '').toUpperCase();
            if (status === 'FAILED') {
                console.warn(`[vibeverse] download failed: ${res.data.error || 'unknown'}`);
                return null;
            }
            const url = res.data.streamUrl;
            if (
                status === 'READY' &&
                isPlayableAudioUrl(url) &&
                !isProgressiveExtractorUrl(url)
            ) {
                return res.data;
            }
        } catch (e) {
            console.warn('[vibeverse] status poll:', e?.message || e);
        }
    }
    return null;
}
