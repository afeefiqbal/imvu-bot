import axios from 'axios';
import { expandYoutubePlaylist } from './playlistFetch.js';

function isYoutubePlaylistUrl(u) {
    const s = String(u || '');
    return (
        /youtube\.com\/.*(\blist=|\/playlist)/i.test(s) ||
        /^https?:\/\/[^/]*youtube\.com\/playlist\?/i.test(s)
    );
}

function normalizeItems(items) {
    return items
        .map((row) => {
            if (typeof row === 'string') return { title: 'Track', url: row.trim() };
            const url = row?.url || row?.youtube_url || row?.href;
            const title = row?.title || row?.name || 'Track';
            if (!url || typeof url !== 'string') return null;
            return { title: String(title).trim(), url: String(url).trim() };
        })
        .filter(Boolean);
}

async function fetchJsonPlaylist(url) {
    const { data } = await axios.get(url.trim(), { timeout: 45000 });
    const items = Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data?.tracks)
          ? data.tracks
          : Array.isArray(data)
            ? data
            : [];
    return normalizeItems(items);
}

/**
 * Idle playlist from `.env` only (operators); IMVU users cannot change this list via chat.
 * @param {string} raw
 * @returns {{ title: string, url: string }[]}
 */
function parseInlinePlaylistFromEnv(raw) {
    const s = String(raw || '').trim();
    if (!s) return [];
    try {
        const data = JSON.parse(s);
        const items = Array.isArray(data?.items)
            ? data.items
            : Array.isArray(data?.tracks)
              ? data.tracks
              : Array.isArray(data)
                ? data
                : [];
        return normalizeItems(items);
    } catch (e) {
        console.warn('[music] MUSIC_AUTOPLAY_TRACKS_JSON invalid JSON:', e?.message || e);
        return [];
    }
}

/**
 * Tracks when the queue is idle — loaded only from process env / `.env` (not from users).
 * Precedence: MUSIC_AUTOPLAY_TRACKS_JSON → MUSIC_AUTOPLAY_TRACKS_JSON_URL → YouTube playlist URL → MUSIC_PLAYLIST_URL (JSON or YouTube).
 * @returns {Promise<{ title: string, url: string }[]>}
 */
export async function loadAutoplayTracksFromEnv() {
    try {
        const inlineJson = String(process.env.MUSIC_AUTOPLAY_TRACKS_JSON || '').trim();
        if (inlineJson) {
            return parseInlinePlaylistFromEnv(inlineJson);
        }

        const jsonPrimary = String(process.env.MUSIC_AUTOPLAY_TRACKS_JSON_URL || '').trim();
        const legacyList = String(process.env.MUSIC_PLAYLIST_URL || '').trim();
        const ytOnly = String(process.env.MUSIC_AUTOPLAY_PLAYLIST_URL || '').trim();

        if (jsonPrimary) {
            return await fetchJsonPlaylist(jsonPrimary);
        }

        const ytCandidate = ytOnly || legacyList;
        if (ytCandidate && isYoutubePlaylistUrl(ytCandidate)) {
            return await expandYoutubePlaylist(ytCandidate);
        }

        if (legacyList && !isYoutubePlaylistUrl(legacyList)) {
            return await fetchJsonPlaylist(legacyList);
        }

        return [];
    } catch (e) {
        console.warn('[music] autoplay playlist load:', e?.message || e);
        return [];
    }
}
