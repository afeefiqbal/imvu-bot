import play from 'play-dl';
import { canonicalYoutubeWatchUrl } from './resolvePlay.js';

/**
 * Expand a YouTube playlist URL into video URLs (best effort).
 * @param {string} listUrl
 * @returns {Promise<{ title: string, url: string }[]>}
 */
export async function expandYoutubePlaylist(listUrl) {
    const u = String(listUrl || '').trim();
    if (!u) return [];
    try {
        if (play.yt_validate(u) !== 'playlist') return [];
        const pl = await play.playlist_info(u, { incomplete: true });
        const videos = await pl.next(50);
        return (videos || [])
            .filter((v) => v?.url)
            .map((v) => ({
                title: v.title || 'Track',
                url: canonicalYoutubeWatchUrl(v.url),
            }));
    } catch (e) {
        console.warn('[music] playlist:', e.message);
        return [];
    }
}
