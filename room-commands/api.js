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
        const data = error.response?.data;
        return {
            ok: false,
            message: data?.error || data?.message || error.message || 'leave failed',
            send_dm: data?.send_dm === true,
        };
    }
}

/**
 * @param {string} apiBaseUrl
 * @param {string} botName
 * @param {string} roomId
 * @param {{ senderId?: string, senderLabel?: string, source?: 'dm'|'invite' }} sender
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
                source: sender.source === 'dm' ? 'dm' : 'invite',
            },
            { timeout: 12000 }
        );
        return response.data || { ok: false, message: 'empty response' };
    } catch (error) {
        const data = error.response?.data;
        return {
            ok: false,
            message: data?.error || data?.message || error.message || 'join failed',
            send_dm: data?.send_dm === true,
        };
    }
}

/**
 * Bot cannot enter IMVU room — delete from dashboard / bot lists / Discord.
 * @param {string} apiBaseUrl
 * @param {string} botName
 * @param {string} roomId
 * @param {string} [reason]
 */
export async function postBotRoomAbandon(apiBaseUrl, botName, roomId, reason = '') {
    const base = String(apiBaseUrl || '').replace(/\/$/, '');
    if (!base || !botName || !roomId) return { ok: false, message: 'missing params' };

    try {
        const response = await axios.post(
            `${base}/api/bot-room/abandon`,
            {
                room_id: roomId,
                bot_name: botName,
                reason: reason ? String(reason).slice(0, 255) : undefined,
            },
            { timeout: 15000 }
        );
        return response.data || { ok: false, message: 'empty response' };
    } catch (error) {
        const data = error.response?.data;
        return {
            ok: false,
            message: data?.error || data?.message || error.message || 'abandon failed',
            send_dm: false,
        };
    }
}
