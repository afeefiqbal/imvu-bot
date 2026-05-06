import { loadStreamConfig } from './loadStreamConfig.js';
import { resolveYoutubePlayable } from './resolvePlay.js';
import { exportYoutubeToStaticMp3Url } from './mp3FileExport.js';

const HELP = `Music: play … · !play … · *play … (static mp3 starts at 0:00) · !music`;

function parseCmdLine(text) {
    const t = String(text || '').trim();
    if (!t) return null;

    // Natural: "play song name" (search YouTube → ffmpeg → Icecast MP3 URL on room)
    const naturalPlay = /^play\s+(.+)$/i.exec(t);
    if (naturalPlay) {
        return { cmd: '*play', rest: naturalPlay[1].trim(), raw: t };
    }
    if (/^play$/i.test(t)) {
        return { cmd: '*play', rest: '', raw: t };
    }

    // IMVU users often type !play … — normalize !foo → *foo like *foo
    const firstChar = t[0];
    if (firstChar !== '*' && firstChar !== '!') return null;
    const parts = t.split(/\s+/);
    const head = parts[0].toLowerCase();
    const cmd = '*' + head.slice(1);
    const rest = parts.slice(1).join(' ').trim();
    return { cmd, rest, raw: t };
}

/**
 * @param {{
 *   page: import('puppeteer').Page,
 *   roomId: string,
 *   apiBaseUrl: string,
 *   botName?: string,
 *   sendMessage: (text: string, meta?: object) => Promise<void>,
 * }} opts
 */
export async function createMusicRoomChatCommandHandler(opts) {
    const { roomId, apiBaseUrl, sendMessage } = opts;

    /**
     * @returns {Promise<boolean>} true if this message was a music command (consumed)
     */
    return async ({ text, senderLabel, senderId, isSelf }) => {
        if (isSelf) return false;
        const parsed = parseCmdLine(text);
        if (!parsed) return false;

        const { cmd, rest } = parsed;
        const reply = async (msg) => {
            try {
                await sendMessage(msg, {
                    participantUsername: senderLabel ?? undefined,
                    participantAvatarId: senderId != null ? String(senderId) : undefined,
                });
            } catch (e) {
                console.warn('[music] sendMessage:', e.message);
            }
        };

        if (cmd === '*music' || cmd === '*m') {
            await reply(HELP);
            return true;
        }

        if (cmd === '*play' || cmd === '*p' || cmd === '*playmp3' || cmd === '*mp3') {
            if (!rest) {
                await reply('Usage: !play <song or YouTube URL>');
                return true;
            }

            const one = await resolveYoutubePlayable(rest);
            if (!one) {
                await reply('Could not find that track for mp3 export.');
                return true;
            }

            const cfgNow = await loadStreamConfig({ apiBaseUrl, roomId });
            const pubNow = String(cfgNow?.publicStreamUrl || '').trim();
            if (!/^https:\/\//i.test(pubNow)) {
                await reply('No HTTPS public URL available. Configure tunnel first, then try !play again.');
                return true;
            }

            await reply(`Preparing mp3 file for "${one.title}"...`);
            try {
                const fileUrl = await exportYoutubeToStaticMp3Url({
                    youtubeUrl: one.url,
                    publicStreamUrl: pubNow,
                    roomId,
                });
                await reply(fileUrl);
            } catch (e) {
                console.warn('[music] playmp3 export failed:', e?.message || e);
                await reply(`Could not export mp3 right now: ${e?.message || 'unknown error'}`);
            }
            return true;
        }

        return false;
    };
}
