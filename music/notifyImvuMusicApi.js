import axios from 'axios';

/**
 * @param {{ apiBaseUrl: string, roomId: string, botName?: string, track: { title: string, url: string } | null, state: string }} p
 */
export async function notifyImvuMusicState(p) {
    if (/^(0|false|no|off)$/i.test(String(process.env.DASHBOARD_SYNC_ENABLED ?? '1').trim())) {
        return;
    }
    const base = String(p.apiBaseUrl || '').replace(/\/+$/, '');
    if (!base) return;
    try {
        await axios.post(
            `${base}/api/imvu-music-state`,
            {
                room_id: String(p.roomId),
                bot_name: p.botName || null,
                state: p.state,
                track: p.track,
            },
            { timeout: 8000, validateStatus: () => true }
        );
    } catch (e) {
        console.warn('[music] notify state:', e.message);
    }
}
