import { execFile } from 'child_process';
import { promisify } from 'util';
import { canonicalYoutubeWatchUrl } from './resolvePlay.js';
import { ytDlpExtraArgs } from './ytDlpArgs.js';

const execFileAsync = promisify(execFile);

/**
 * Expand a YouTube playlist URL into video URLs (best effort).
 * Prefer yt-dlp — play-dl often fails from datacenter IPs and only adds noise.
 * @param {string} listUrl
 * @returns {Promise<{ title: string, url: string }[]>}
 */
/** Radio/mix links often look like watch?v=…&list=RD… — still expand via list= when present. */
function youtubeUrlHasListParam(u) {
    return /\blist=[^&\s]+/i.test(String(u || ''));
}

function looksLikeYoutubePlaylist(u) {
    const s = String(u || '');
    return (
        youtubeUrlHasListParam(s) ||
        /youtube\.com\/playlist\?/i.test(s) ||
        /youtu\.be\/.*[?&]list=/i.test(s)
    );
}

function fallbackSingleVideoFromWatchUrl(listUrl) {
    const m = /[?&]v=([a-zA-Z0-9_-]{11})/.exec(String(listUrl || ''));
    if (!m) return [];
    const url = `https://www.youtube.com/watch?v=${m[1]}`;
    return [{ title: 'Track', url: canonicalYoutubeWatchUrl(url) }];
}

function autoplayMaxItems() {
    const rawMax = parseInt(String(process.env.MUSIC_AUTOPLAY_PLAYLIST_MAX_ITEMS || '100'), 10);
    return Number.isFinite(rawMax) ? Math.min(Math.max(rawMax, 1), 500) : 100;
}

/**
 * @param {string} listUrl
 * @param {number} maxItems
 * @returns {Promise<{ title: string, url: string }[]>}
 */
async function expandViaYtDlp(listUrl, maxItems) {
    const bin = String(process.env.YTDLP_PATH || 'yt-dlp').trim() || 'yt-dlp';
    const { stdout } = await execFileAsync(
        bin,
        [
            String(listUrl),
            ...ytDlpExtraArgs(),
            '--flat-playlist',
            '--no-warnings',
            '--no-download',
            '--playlist-end',
            String(maxItems),
            '--print',
            '%(id)s\t%(title)s',
        ],
        { maxBuffer: 12 * 1024 * 1024, timeout: 180000 },
    );
    const out = [];
    for (const line of String(stdout || '').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        const tab = t.indexOf('\t');
        const id = (tab >= 0 ? t.slice(0, tab) : t).trim();
        const title = (tab >= 0 ? t.slice(tab + 1) : 'Track').trim() || 'Track';
        if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) continue;
        out.push({
            title,
            url: canonicalYoutubeWatchUrl(`https://www.youtube.com/watch?v=${id}`),
        });
    }
    return out;
}

export async function expandYoutubePlaylist(listUrl) {
    const u = String(listUrl || '').trim();
    if (!u) return [];
    if (!looksLikeYoutubePlaylist(u)) {
        return fallbackSingleVideoFromWatchUrl(u);
    }

    const maxItems = autoplayMaxItems();

    try {
        const viaYt = await expandViaYtDlp(u, maxItems);
        if (viaYt.length > 0) {
            console.log(`[music] playlist: yt-dlp expanded ${viaYt.length} track(s)`);
            return viaYt;
        }
    } catch (e) {
        console.warn('[music] playlist (yt-dlp):', e?.message?.slice?.(0, 240) || e);
    }

    const fb = fallbackSingleVideoFromWatchUrl(u);
    if (fb.length) {
        console.warn('[music] playlist: expansion failed — falling back to single video from URL');
    }
    return fb;
}
