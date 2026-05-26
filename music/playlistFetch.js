import play from 'play-dl';
import { canonicalYoutubeWatchUrl } from './resolvePlay.js';

/**
 * Expand a YouTube playlist URL into video URLs (best effort).
 * @param {string} listUrl
 * @returns {Promise<{ title: string, url: string }[]>}
 */
/** Radio/mix links often look like watch?v=…&list=RD… — play-dl may validate as `video` but playlist_info still works. */
function youtubeUrlHasListParam(u) {
    return /\blist=[^&\s]+/i.test(String(u || ''));
}

function fallbackSingleVideoFromWatchUrl(listUrl) {
    const m = /[?&]v=([a-zA-Z0-9_-]{11})/.exec(String(listUrl || ''));
    if (!m) return [];
    const url = `https://www.youtube.com/watch?v=${m[1]}`;
    return [{ title: 'Track', url: canonicalYoutubeWatchUrl(url) }];
}

export async function expandYoutubePlaylist(listUrl) {
    const u = String(listUrl || '').trim();
    if (!u) return [];
    try {
        const validated = play.yt_validate(u);
        if (validated !== 'playlist' && !youtubeUrlHasListParam(u)) {
            return [];
        }
        const pl = await play.playlist_info(u, { incomplete: true });
        const rawMax = parseInt(String(process.env.MUSIC_AUTOPLAY_PLAYLIST_MAX_ITEMS || '100'), 10);
        const maxItems = Number.isFinite(rawMax) ? Math.min(Math.max(rawMax, 1), 500) : 100;
        const videos = await pl.next(maxItems);
        const out = (videos || [])
            .filter((v) => v?.url)
            .map((v) => ({
                title: v.title || 'Track',
                url: canonicalYoutubeWatchUrl(v.url),
            }));
        if (out.length > 0) return out;
    } catch (e) {
        console.warn('[music] playlist:', e.message);
    }
    const fb = fallbackSingleVideoFromWatchUrl(u);
    if (fb.length) {
        console.warn('[music] playlist: mix/RD expansion failed — falling back to single video from URL');
    }
    return fb;
}
