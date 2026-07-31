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

function normalizeSearchText(s) {
    return String(s || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function editDistance(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const prev = new Array(b.length + 1);
    const cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
        cur[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        }
        for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
    }
    return prev[b.length];
}

function fuzzyContains(hay, needle) {
    if (!needle || !hay) return false;
    if (hay.includes(needle)) return true;
    const n = needle.length;
    if (n < 5) return false;
    const maxDist = n >= 10 ? 2 : 1;
    for (let len = n - maxDist; len <= n + maxDist; len++) {
        if (len < 5) continue;
        for (let i = 0; i <= hay.length - len; i++) {
            if (editDistance(hay.slice(i, i + len), needle) <= maxDist) return true;
        }
    }
    return false;
}

/** Prefer titles that match the user query (demote unrelated OST fillers). */
function queryMatchScore(query, title, artistName = '', albumTitle = '') {
    const q = normalizeSearchText(query);
    const hay = normalizeSearchText(
        `${title || ''} ${artistName || ''} ${albumTitle || ''}`,
    );
    if (!q || !hay) return 0;
    if (hay.includes(q) || q.includes(hay)) return 1;
    const qC = q.replace(/\s/g, '');
    const hC = hay.replace(/\s/g, '');
    if (qC.length >= 5 && fuzzyContains(hC, qC)) return 0.92;
    const qt = q.split(' ').filter((t) => t.length >= 2);
    const ht = hay.split(' ').filter((t) => t.length >= 2);
    if (!qt.length) return 0;
    let hit = 0;
    for (const t of qt) {
        if (ht.some((h) => h === t || h.includes(t) || t.includes(h) || fuzzyContains(h, t))) {
            hit += 1;
        }
    }
    return hit / qt.length;
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
 * Parse !play / !add query:
 * - `...` / dots only → silent (no reply)
 * - `.song name` (dot then a letter) → smart AI search
 * - otherwise → direct YouTube Music
 * @param {string} raw
 * @returns {{ kind: 'silent' } | { kind: 'empty' } | { kind: 'direct'|'smart', query: string, display: string }}
 */
export function parseMusicSearchQuery(raw) {
    const s = String(raw || '').trim();
    if (!s) return { kind: 'empty' };
    // Only dots / punctuation — e.g. "..." — ignore completely.
    if (!/[a-zA-Z0-9\u0D00-\u0D7F]/.test(s)) return { kind: 'silent' };
    // Leading dot(s): AI/smart search only if a letter follows.
    const dotted = /^\.+\s*(.*)$/s.exec(s);
    if (dotted) {
        const rest = String(dotted[1] || '').trim();
        if (!rest || !/^[a-zA-Z\u0D00-\u0D7F]/.test(rest)) return { kind: 'silent' };
        return { kind: 'smart', query: rest, display: rest };
    }
    return { kind: 'direct', query: s, display: s };
}

/**
 * @param {string} query
 * @param {{ roomId?: string, onPicked?: (track: object) => void | Promise<void>, smart?: boolean }} [opts]
 * @returns {Promise<VibeversePlayable | VibeversePending | { failed: true, trackId?: string, title?: string, detail?: string } | null>}
 */
export async function resolveVibeversePlayable(query, opts = {}) {
    const base = apiBase();
    if (!base) return null;
    const q = String(query || '').trim();
    if (!q) return null;
    const t0 = Date.now();

    const search = await axios.get(`${base}/search`, {
        params: {
            q,
            source: 'youtube',
            limit: 8,
            ...(opts.smart ? { smart: '1' } : {}),
        },
        timeout: opts.smart ? 18_000 : 12_000,
        validateStatus: () => true,
    });
    const searchMs = Date.now() - t0;
    if (search.status >= 400 || !search.data) {
        console.warn(`[vibeverse] search HTTP ${search.status}`);
        return null;
    }

    const tracks = Array.isArray(search.data.tracks) ? search.data.tracks : [];
    const ranked = [];
    // Trust API order (direct YTM, or smart-ranked when smart=1).
    if (search.data.top?.id) ranked.push(search.data.top);
    for (const t of tracks) {
        if (t?.id && !ranked.some((x) => x.id === t.id)) ranked.push(t);
    }
    if (!ranked.length) return null;

    /** @type {{ failed: true, trackId?: string, title?: string, detail?: string } | null} */
    let lastFail = null;
    // Keep YouTube Music order. READY (R2) top hits naturally land under ~10s.
    const playOrder = ranked.slice(0, 5);
    if (playOrder[0]?.ready) {
        console.log(`[vibeverse] top hit READY (cached) — fast path: ${playOrder[0].title || '?'}`);
    }
    let announced = false;
    for (const track of playOrder) {
        const tPlay = Date.now();
        const playable = await playVibeverseTrack(track, { roomId: opts.roomId });
        console.log(
            `[vibeverse] timing search=${searchMs}ms play=${Date.now() - tPlay}ms total=${Date.now() - t0}ms smart=${!!opts.smart} title=${track.title || '?'}`,
        );
        if (playable?.streamUrl) {
            // Announce only after we actually have a stream — avoids false "Now playing".
            if (!announced && typeof opts.onPicked === 'function') {
                announced = true;
                try {
                    await opts.onPicked(track);
                } catch {
                    /* ignore */
                }
            }
            return playable;
        }
        if (playable?.pending) return playable;
        if (playable?.failed) {
            lastFail = {
                ...playable,
                detail: cleanPlayFailDetail(playable.detail),
            };
            console.warn(
                `[vibeverse] search hit failed (${track.id}): ${lastFail.detail || 'FAILED'} — trying next`,
            );
            continue;
        }
    }
    return lastFail;
}

function cleanPlayFailDetail(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (/unavailable|not available/i.test(s)) return 'YouTube video unavailable';
    if (/bot.?check|sign in to confirm/i.test(s)) return 'YouTube bot-check (cookies)';
    if (/error code:\s*502/i.test(s)) return 'extractor briefly unavailable';
    // Strip yt-dlp binary prefix noise
    const m = s.match(/ERROR:\s*\[youtube\]\s*[\w-]+:\s*(.+)/i);
    if (m) return m[1].slice(0, 160);
    return s.slice(0, 160);
}

function vibeverseLiveEnabled() {
    return /^(1|true|yes|on)$/i.test(String(process.env.MUSIC_VIBEVERSE_LIVE || '').trim());
}

/**
 * @param {{
 *   id: string,
 *   title?: string,
 *   artistName?: string,
 *   artworkUrl?: string,
 *   durationMs?: number,
 * }} track
 * @param {{ waitMs?: number, forceDurable?: boolean, roomId?: string }} [opts]
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
    const live = vibeverseLiveEnabled();
    const roomId = String(opts.roomId || process.env.MUSIC_ROOM_ID || '').trim();

    const body = {
        trackId: track.id,
        title: track.title,
        artistName: track.artistName,
        artworkUrl: track.artworkUrl,
        durationMs: track.durationMs,
        source: 'QUEUE',
        preferMp3: true,
        requireCached: live ? false : true,
        allowProgressive: live ? true : undefined,
        delivery: live ? 'hls' : undefined,
        roomId: live && roomId ? roomId : undefined,
    };
    if (opts.forceDurable && !live) {
        body.requireCached = true;
        body.preferMp3 = true;
    }

    const playRes = await axios.post(`${base}/play`, body, {
        timeout: live ? 90_000 : 45_000,
        validateStatus: () => true,
        headers: { 'Content-Type': 'application/json' },
    });

    if (playRes.status >= 400 || !playRes.data) {
        console.warn(`[vibeverse] play HTTP ${playRes.status}:`, playRes.data?.error || playRes.data || '');
        return null;
    }

    let streamUrl = String(playRes.data.streamUrl || '').trim();
    let status = String(playRes.data.status || '').toUpperCase();
    const delivery = String(playRes.data.delivery || (live ? 'hls' : 'source'));
    const resolvedTrack = playRes.data.track || track;
    const trackId = String(resolvedTrack.id || track.id);
    const title = String(resolvedTrack.title || track.title || 'Track');

    const needsWait =
        !live &&
        (!isPlayableAudioUrl(streamUrl) ||
            isProgressiveExtractorUrl(streamUrl) ||
            status === 'PREPARING' ||
            status === 'DOWNLOADING' ||
            status === 'PENDING');

    if (needsWait && waitMs > 0) {
        const ready = await waitForVibeverseReady(trackId, waitMs);
        if (ready?.streamUrl) {
            streamUrl = ready.streamUrl;
            status = 'READY';
        }
    }

    if (!isPlayableAudioUrl(streamUrl)) {
        if (status === 'FAILED') {
            const detail = String(playRes.data.message || playRes.data.error || '').trim();
            console.warn(
                `[vibeverse] play FAILED for ${trackId}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
            );
            return {
                failed: true,
                trackId,
                title,
                detail: detail || 'Could not resolve a playable stream',
            };
        }
        if (waitMs > 0) {
            console.warn(`[vibeverse] no stream for ${trackId} (status=${status})`);
        }
        return { pending: true, trackId, title };
    }

    // Live HLS from extractor is the playable URL (m3u8). Progressive pipes still blocked
    // for local Icecast path.
    if (!live && isProgressiveExtractorUrl(streamUrl)) {
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
        cached: playRes.data.cached === true,
        progressiveReady: playRes.data.progressiveReady === true,
        delivery,
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
 * @param {{ excludeIds?: Iterable<string>, roomId?: string }} [opts]
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
            // Pass roomId so live HLS delivery is used (same as !play).
            const playable = await playVibeverseTrack(raw, {
                waitMs: 0,
                roomId: opts.roomId,
            });
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
