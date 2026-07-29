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
 * @typedef {{
 *   trackId: string,
 *   title: string,
 *   artistName: string,
 *   artworkUrl?: string,
 *   durationMs: number,
 *   streamUrl: string,
 * }} VibeversePlayable
 *
 * @typedef {{ pending: true, trackId?: string, title?: string }} VibeversePending
 */

/**
 * @param {string} query
 * @returns {Promise<VibeversePlayable | VibeversePending | null>}
 *   playable track | `{ pending: true }` (found, still caching) | null (not found)
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
 * @param {{ waitMs?: number }} [opts]
 *   `waitMs: 0` = never poll for PREPARING (autoplay). Default waits up to 90s.
 * @returns {Promise<VibeversePlayable | VibeversePending | null>}
 */
export async function playVibeverseTrack(track, opts = {}) {
    const base = apiBase();
    if (!base || !track?.id) return null;
    const waitMs =
        opts.waitMs != null
            ? Math.max(0, Number(opts.waitMs) || 0)
            : 90_000;

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
    const title = String(resolvedTrack.title || track.title || 'Track');

    const needsWait =
        !isPlayableAudioUrl(streamUrl) ||
        isProgressiveExtractorUrl(streamUrl) ||
        status === 'PREPARING' ||
        status === 'DOWNLOADING' ||
        status === 'PENDING';

    if (needsWait && waitMs > 0) {
        const ready = await waitForVibeverseReady(trackId, waitMs);
        if (ready?.streamUrl) {
            streamUrl = ready.streamUrl;
            status = 'READY';
        }
    }

    if (!isPlayableAudioUrl(streamUrl) || isProgressiveExtractorUrl(streamUrl)) {
        // Track exists; durable cache just isn't ready yet — not a "not found".
        if (waitMs > 0) {
            console.warn(`[vibeverse] no durable stream for ${trackId} (status=${status})`);
        }
        return { pending: true, trackId, title };
    }

    console.log(`[music] stream URL for “${title}”: ${streamUrl}`);

    return {
        trackId,
        title,
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

const AUTOPLAY_CATALOG_CATEGORIES = ['english', 'hindi', 'tamil', 'malayalam'];
const AUTOPLAY_FALLBACK_QUERIES = [
    'trending songs',
    'popular hits',
    'top songs',
    'chill pop hits',
    'dance hits',
];

function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

/**
 * Pick a random playable track for idle autoplay.
 * Prefers VibeVerse READY catalog downloads (already cached), then trending.
 * Never waits on PREPARING — skip cold tracks so the room doesn't go silent for minutes.
 *
 * @param {{ excludeIds?: Iterable<string> }} [opts]
 * @returns {Promise<VibeversePlayable | null>}
 */
export async function fetchRandomVibeversePlayable(opts = {}) {
    const base = apiBase();
    if (!base) return null;

    const exclude = new Set(
        [...(opts.excludeIds || [])].map((id) => String(id || '').trim()).filter(Boolean),
    );
    const maxTries = Math.max(
        3,
        parseInt(String(process.env.MUSIC_AUTOPLAY_MAX_TRIES || '12'), 10) || 12,
    );
    let tries = 0;

    /** @param {object[]} candidates @param {string} source */
    const tryCandidates = async (candidates, source) => {
        for (const raw of candidates) {
            if (tries >= maxTries) return null;
            const id = String(raw?.id || '').trim();
            if (!id || exclude.has(id)) continue;
            tries += 1;
            // Instant only — never block autoplay on a 90s PREPARING poll.
            const playable = await playVibeverseTrack(raw, { waitMs: 0 });
            if (playable?.streamUrl) {
                console.log(`[music] autoplay pick via ${source}: “${playable.title}”`);
                return playable;
            }
        }
        return null;
    };

    console.log('[music] autoplay: fetching READY catalog / trending…');

    // 1) READY pinned catalog (best for Icecast — already durable).
    const categories = shuffleInPlace([...AUTOPLAY_CATALOG_CATEGORIES]);
    for (const category of categories) {
        if (tries >= maxTries) break;
        try {
            const page = 1 + Math.floor(Math.random() * 4);
            const res = await axios.get(`${base}/catalog/downloads`, {
                params: { category, limit: 24, page },
                timeout: 12_000,
                validateStatus: () => true,
            });
            if (res.status < 400 && Array.isArray(res.data?.items) && res.data.items.length) {
                const tracks = shuffleInPlace(
                    res.data.items.map((row) => row?.track).filter((t) => t?.id),
                );
                const hit = await tryCandidates(tracks, `catalog:${category}`);
                if (hit) return hit;
            } else {
                console.warn(
                    `[vibeverse] autoplay catalog ${category}: HTTP ${res.status} items=${res.data?.items?.length ?? 0}`,
                );
            }
        } catch (e) {
            console.warn(`[vibeverse] autoplay catalog ${category}:`, e?.message || e);
        }
    }

    // 2) Trending list (instant READY only).
    try {
        const res = await axios.get(`${base}/tracks/trending`, {
            timeout: 12_000,
            validateStatus: () => true,
        });
        const tracks = Array.isArray(res.data) ? res.data : [];
        if (tracks.length) {
            const hit = await tryCandidates(shuffleInPlace([...tracks]), 'trending');
            if (hit) return hit;
        }
    } catch (e) {
        console.warn('[vibeverse] autoplay trending:', e?.message || e);
    }

    // 3) One quick search — still no long PREPARING wait.
    const queries = shuffleInPlace([...AUTOPLAY_FALLBACK_QUERIES]);
    for (const q of queries.slice(0, 1)) {
        try {
            const search = await axios.get(`${base}/search`, {
                params: { q, source: 'youtube' },
                timeout: 12_000,
                validateStatus: () => true,
            });
            const tracks = Array.isArray(search.data?.tracks) ? search.data.tracks : [];
            const top = search.data?.top ? [search.data.top, ...tracks] : tracks;
            const hit = await tryCandidates(
                top.filter((t) => t?.id),
                `search:${q}`,
            );
            if (hit) return hit;
        } catch (e) {
            console.warn(`[vibeverse] autoplay search “${q}”:`, e?.message || e);
        }
    }

    console.warn(`[music] autoplay: no READY stream after ${tries} tries`);
    return null;
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
