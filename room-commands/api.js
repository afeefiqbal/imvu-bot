import axios from 'axios';

/**
 * Best-effort persist to Laravel; in-memory store is updated regardless by caller.
 * @param {string} apiBaseUrl
 * @param {string} botName
 * @param {string} roomId
 * @param {Record<string, unknown>} patch
 */
export async function patchRoomSettingsRemote(apiBaseUrl, botName, roomId, patch) {
    const base = String(apiBaseUrl || '').replace(/\/$/, '');
    const bot = encodeURIComponent(String(botName || '').trim());
    const room = encodeURIComponent(
        String(roomId || '')
            .trim()
            .replace(/^room-/i, '')
    );
    if (!base || !bot || !room) return false;

    const paths = [
        `${base}/api/bots/${bot}/rooms/${room}/settings`,
        `${base}/api/rooms/${room}/settings?bot_name=${bot}`,
    ];

    for (const url of paths) {
        try {
            await axios.patch(url, patch, { timeout: 12000, validateStatus: (s) => s >= 200 && s < 300 });
            return true;
        } catch {
            /* try next path */
        }
    }
    return false;
}
