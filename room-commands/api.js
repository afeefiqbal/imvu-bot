import axios from 'axios';

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

/**
 * @param {string} apiBaseUrl
 * @param {string} botName
 * @param {string} roomId
 * @param {{ senderId?: string, senderLabel?: string }} sender
 */
export async function postBotRoomLeave(apiBaseUrl, botName, roomId, sender = {}) {
    const base = String(apiBaseUrl || '').replace(/\/$/, '');
    if (!base || !botName || !roomId) return { ok: false, message: 'missing params' };

    try {
        const response = await axios.post(
            `${base}/api/bot-room/leave`,
            {
                room_id: roomId,
                bot_name: botName,
                sender_user_id: sender.senderId && /^\d+$/.test(String(sender.senderId))
                    ? Number(sender.senderId)
                    : null,
                sender_username: sender.senderLabel ? String(sender.senderLabel) : null,
            },
            { timeout: 12000 }
        );
        return response.data || { ok: false, message: 'empty response' };
    } catch (error) {
        return {
            ok: false,
            message: error.response?.data?.message || error.message || 'leave failed',
        };
    }
}

/**
 * @param {string} apiBaseUrl
 * @param {string} botName
 * @param {string} roomId
 * @param {{ senderId?: string, senderLabel?: string }} sender
 */
export async function postBotRoomJoin(apiBaseUrl, botName, roomId, sender = {}) {
    const base = String(apiBaseUrl || '').replace(/\/$/, '');
    if (!base || !botName || !roomId) return { ok: false, message: 'missing params' };

    try {
        const response = await axios.post(
            `${base}/api/bot-room/join`,
            {
                room_id: roomId,
                bot_name: botName,
                sender_user_id: sender.senderId && /^\d+$/.test(String(sender.senderId))
                    ? Number(sender.senderId)
                    : null,
                sender_username: sender.senderLabel ? String(sender.senderLabel) : null,
            },
            { timeout: 12000 }
        );
        return response.data || { ok: false, message: 'empty response' };
    } catch (error) {
        return {
            ok: false,
            message: error.response?.data?.message || error.message || 'join failed',
        };
    }
}
