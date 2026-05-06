import { execFile } from 'child_process';
import { promisify } from 'util';
import play from 'play-dl';

const execFileAsync = promisify(execFile);

/** @param {string} s */
function extractYoutubeId(s) {
    const m = String(s || '').match(
        /(?:v=|youtu\.be\/|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})\b|[?&]v=([\w-]{11})\b/,
    );
    return m ? m[1] || m[2] : null;
}

/**
 * Pasting a YouTube *web search* URL makes yt-dlp treat it like a page (slow / fails).
 * Turn it into plain search text so `ytsearchN:` works.
 * @param {string} raw
 * @returns {string | null}
 */
function queryFromYoutubeSearchPageUrl(raw) {
    const s = String(raw || '').trim();
    if (!/^https?:\/\//i.test(s)) return null;
    try {
        const u = new URL(s);
        const host = u.hostname.replace(/^www\./i, '').toLowerCase();
        if (host !== 'youtube.com' && host !== 'm.youtube.com') return null;
        const path = (u.pathname || '/').replace(/\/+$/, '') || '/';
        if (!path.endsWith('/results')) return null;
        const q =
            u.searchParams.get('search_query') ||
            u.searchParams.get('q') ||
            u.searchParams.get('query');
        /* URLSearchParams.get already decodes %xx and + in query strings. */
        const out = q != null ? String(q).trim() : '';
        return out || null;
    } catch {
        return null;
    }
}

/** music.youtube.com/search?q=… → same as above for the music client. */
function queryFromYoutubeMusicSearchPageUrl(raw) {
    const s = String(raw || '').trim();
    if (!/^https?:\/\//i.test(s)) return null;
    try {
        const u = new URL(s);
        const host = u.hostname.replace(/^www\./i, '').toLowerCase();
        if (host !== 'music.youtube.com') return null;
        const path = (u.pathname || '/').replace(/\/+$/, '') || '/';
        if (!path.endsWith('/search')) return null;
        const q = u.searchParams.get('q');
        const out = q != null ? String(q).trim() : '';
        return out || null;
    } catch {
        return null;
    }
}

/**
 * Strip `t=` / `start=` / other junk so decoding always starts at 0:00.
 * @param {string} urlOrAnything
 * @returns {string}
 */
export function canonicalYoutubeWatchUrl(urlOrAnything) {
    const raw = String(urlOrAnything || '').trim();
    const id = extractYoutubeId(raw);
    if (id && isYoutubeVideoId(id)) return `https://www.youtube.com/watch?v=${id}`;
    return raw;
}

/** YouTube video ids are 11 chars from [A-Za-z0-9_-]. */
function isYoutubeVideoId(s) {
    return /^[\w-]{11}$/.test(String(s || ''));
}

/**
 * yt-dlp search entries sometimes have `id` + thumbnails but no `webpage_url` / `url`.
 * @param {object} ent
 * @returns {string | null}
 */
function youtubeVideoIdFromEntry(ent) {
    if (!ent || typeof ent !== 'object') return null;
    const blob = [ent.webpage_url, ent.url, typeof ent.thumbnail === 'string' ? ent.thumbnail : '']
        .filter(Boolean)
        .join(' ');
    const fromUrls = extractYoutubeId(blob);
    if (fromUrls && isYoutubeVideoId(fromUrls)) return fromUrls;
    const sid = String(ent.id || '');
    if (isYoutubeVideoId(sid)) return sid;
    const thumbs = ent.thumbnails;
    if (Array.isArray(thumbs)) {
        for (const t of thumbs) {
            const u = String(t?.url || '');
            const m = u.match(/\/(?:vi|vi_webp)\/([\w-]{11})\//);
            if (m && isYoutubeVideoId(m[1])) return m[1];
        }
    }
    return null;
}

/** Prefer canonical watch URLs — play.stream handles these reliably. */
function toYoutubeWatchUrl(url, hintId) {
    const id = hintId || extractYoutubeId(url);
    if (id && /^[\w-]{11}$/.test(id)) return `https://www.youtube.com/watch?v=${id}`;
    const u = String(url || '').trim();
    return /^https?:\/\//i.test(u) ? u : '';
}

/** yt-dlp JSON for a watch URL — used to skip premieres / not-yet-live. */
async function ytDlpDumpWatchJson(watchUrl) {
    const bin = String(process.env.YTDLP_PATH || 'yt-dlp').trim() || 'yt-dlp';
    const url = String(watchUrl || '').trim();
    if (!url) throw new Error('empty url');
    const { stdout } = await execFileAsync(
        bin,
        [url, '--dump-single-json', '--no-download', '--no-warnings'],
        { maxBuffer: 14 * 1024 * 1024, timeout: 90000, encoding: 'utf8' },
    );
    return JSON.parse(stdout);
}

/**
 * play-dl search can return upcoming premieres that yt-dlp cannot stream yet.
 * @param {{ title: string, url: string }} candidate
 * @returns {Promise<boolean>}
 */
async function isYoutubeCandidateStreamable(candidate) {
    const url = String(candidate?.url || '').trim();
    if (!url) return false;
    try {
        const j = await ytDlpDumpWatchJson(url);
        if (j.live_status === 'is_upcoming') return false;
        return true;
    } catch (e) {
        const msg = String(e?.stderr || e?.message || '');
        if (
            /live event will begin|not currently live|premiere|is upcoming|upcoming live/i.test(
                msg,
            )
        ) {
            return false;
        }
        return true;
    }
}

/**
 * yt-dlp `ytsearchN:…` often returns `_type: "playlist"` with `entries[]`, not a flat video.
 * Top-level `id` can be the query string (e.g. "amsham") — must pick the first real video entry.
 * @param {object} j
 * @param {string} fallbackTitle
 * @returns {{ title: string, url: string } | null}
 */
function trackFromYtDlpJson(j, fallbackTitle) {
    if (!j || typeof j !== 'object') return null;
    const entries = Array.isArray(j.entries) ? j.entries : null;
    const candidates = entries?.length ? entries : [j];
    for (const ent of candidates) {
        if (!ent || typeof ent !== 'object') continue;
        const id = youtubeVideoIdFromEntry(ent);
        const url = toYoutubeWatchUrl(ent.webpage_url || ent.url || '', id);
        if (!url) continue;
        if (ent.live_status === 'is_upcoming') continue;
        const title = ent.title || j.title || fallbackTitle;
        return { title: String(title).slice(0, 500), url };
    }
    return null;
}

/**
 * When play-dl breaks against YouTube (e.g. browseId errors), yt-dlp still resolves.
 * Uses the user’s text as-is for ytsearch (no query rewriting).
 * @param {string} queryOrUrl
 * @returns {Promise<{ title: string, url: string } | null>}
 */
async function resolveViaYtDlp(queryOrUrl) {
    const bin = String(process.env.YTDLP_PATH || 'yt-dlp').trim() || 'yt-dlp';
    const raw = String(queryOrUrl || '').trim();
    if (!raw) return null;
    if (/^https?:\/\//i.test(raw)) {
        try {
            const { stdout } = await execFileAsync(
                bin,
                [raw, '--dump-single-json', '--no-download', '--no-warnings'],
                { maxBuffer: 14 * 1024 * 1024, timeout: 90000, encoding: 'utf8' },
            );
            const j = JSON.parse(stdout);
            return trackFromYtDlpJson(j, raw);
        } catch (e) {
            console.warn('[music] yt-dlp resolve URL:', e.message);
            return null;
        }
    }

    const limits = [1, 5, 10, 20, 30];
    const commonArgs = ['--no-download', '--no-warnings', '--flat-playlist'];
    for (const n of limits) {
        const arg = `ytsearch${n}:${raw}`;
        try {
            const { stdout } = await execFileAsync(
                bin,
                [arg, ...commonArgs, '--dump-single-json'],
                { maxBuffer: 14 * 1024 * 1024, timeout: 90000, encoding: 'utf8' },
            );
            const j = JSON.parse(stdout);
            const track = trackFromYtDlpJson(j, raw);
            if (track) return track;
        } catch (e) {
            console.warn(`[music] yt-dlp ytsearch${n}:`, e.message?.slice(0, 240) || e);
        }
    }
    /** Last resort: print path (sometimes behaves differently vs one big JSON). */
    for (const n of [15, 25]) {
        const arg = `ytsearch${n}:${raw}`;
        try {
            const { stdout } = await execFileAsync(
                bin,
                [arg, ...commonArgs, '--playlist-items', '1', '--print', '%(id)s\t%(title)s'],
                { maxBuffer: 256 * 1024, timeout: 90000, encoding: 'utf8' },
            );
            const line = String(stdout || '')
                .trim()
                .split('\n')[0];
            const tab = line.indexOf('\t');
            if (tab > 0) {
                const id = line.slice(0, tab).trim();
                const title = line.slice(tab + 1).trim() || raw;
                const url = toYoutubeWatchUrl('', id);
                if (url) return { title: String(title).slice(0, 500), url };
            }
        } catch (e) {
            console.warn(`[music] yt-dlp ytsearch${n} --print:`, e.message?.slice(0, 240) || e);
        }
    }
    return null;
}

/**
 * @param {string} queryOrUrl
 * @returns {Promise<{ title: string, url: string } | null>}
 */
export async function resolveYoutubePlayable(queryOrUrl) {
    let raw = String(queryOrUrl || '').trim();
    if (!raw) return null;
    const fromWeb = queryFromYoutubeSearchPageUrl(raw);
    const fromMusic = queryFromYoutubeMusicSearchPageUrl(raw);
    if (fromWeb) raw = fromWeb;
    else if (fromMusic) raw = fromMusic;

    // yt-dlp first — play-dl search often breaks (browseId) and streaming can throw Invalid URL.
    const viaYtdlp = await resolveViaYtDlp(raw);
    if (viaYtdlp) {
        return { ...viaYtdlp, url: canonicalYoutubeWatchUrl(viaYtdlp.url) };
    }

    /** @type {{ title: string, url: string } | null} */
    let candidate = null;
    try {
        const vKind = play.yt_validate(raw);
        if (vKind === 'video') {
            const info = await play.video_basic_info(raw);
            const vd = info?.video_details;
            const id = vd?.videoId || vd?.id || extractYoutubeId(raw);
            const url = toYoutubeWatchUrl(raw, id);
            if (url) {
                candidate = { title: vd?.title || 'YouTube', url };
            }
        } else {
            const results = await play.search(raw, { limit: 12 });
            for (const hit of results || []) {
                const id = hit?.id || extractYoutubeId(hit?.url || '');
                const url = toYoutubeWatchUrl(hit?.url || '', id);
                if (!url) continue;
                const one = { title: String(hit.title || raw).slice(0, 500), url };
                if (await isYoutubeCandidateStreamable(one)) {
                    return { ...one, url: canonicalYoutubeWatchUrl(one.url) };
                }
            }
        }
    } catch (e) {
        console.warn('[music] resolve (play-dl):', e.message);
    }

    if (!candidate) return null;
    if (!(await isYoutubeCandidateStreamable(candidate))) {
        console.warn('[music] skipping upcoming / not-yet-streamable:', candidate.url);
        return null;
    }
    return { ...candidate, url: canonicalYoutubeWatchUrl(candidate.url) };
}
