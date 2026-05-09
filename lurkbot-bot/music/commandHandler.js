import { loadStreamConfig } from './loadStreamConfig.js';
import { resolveYoutubePlayable } from './resolvePlay.js';
import { exportYoutubeToStaticMp3Url } from './mp3FileExport.js';
import { applyRoomMediaStreamUrl, waitForRoomMediaPlayback } from './imvuRoomMediaDom.js';
import { createRoomPlayer } from './player.js';
import { cacheBustHttpsStreamUrl } from './loadStreamConfig.js';

const HELP = `Music: !play … · !playmp3 … · !skip · !pause · !resume · !music`;

function parseCmdLine(text) {
    const t = String(text || '').trim();
    if (!t) return null;

    if (/^skip$/i.test(t)) return { cmd: '*skip', rest: '', raw: t };
    if (/^pause$/i.test(t)) return { cmd: '*pause', rest: '', raw: t };
    if (/^(resume|unpause)$/i.test(t)) return { cmd: '*resume', rest: '', raw: t };

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
    const { page, roomId, apiBaseUrl, sendMessage } = opts;
    const loadConfig = async () => loadStreamConfig({ apiBaseUrl, roomId });
    const player = createRoomPlayer({
        roomId,
        apiBaseUrl,
        botName: opts.botName,
        page,
        loadConfig,
    });

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

        if (cmd === '*skip' || cmd === '*s' || cmd === '*next') {
            const q = player.getQueue();
            const hasSomething =
                player.isPlaying() ||
                player.isPaused() ||
                q.getCurrent() != null ||
                q.peek() != null;
            if (!hasSomething) {
                await reply('Nothing to skip.');
                return true;
            }
            player.skip();
            await reply('Skipped.');
            return true;
        }

        if (cmd === '*pause' || cmd === '*hold') {
            const qP = player.getQueue();
            if (!player.isPlaying() && !qP.getCurrent() && !qP.peek()) {
                await reply('Nothing playing.');
                return true;
            }
            player.pause();
            await reply('Paused. Say !resume to continue (track restarts from the beginning).');
            return true;
        }

        if (cmd === '*resume' || cmd === '*unpause' || cmd === '*continue') {
            if (!player.isPaused()) {
                await reply('Not paused.');
                return true;
            }
            player.resume();
            await reply('Resumed.');
            return true;
        }

        if (cmd === '*play' || cmd === '*p') {
            if (!rest) {
                await reply('Usage: !play <song or YouTube URL>');
                return true;
            }

            const one = await resolveYoutubePlayable(rest);
            if (!one) {
                await reply('Could not find that track.');
                return true;
            }

            const cfgNow = await loadConfig();
            const pubNow = String(cfgNow?.publicStreamUrl || '').trim();
            if (!/^https:\/\//i.test(pubNow)) {
                await reply('No HTTPS public URL available. Configure tunnel first, then try !play again.');
                return true;
            }

            try {
                player.playNow({
                    title: one.title,
                    url: one.url,
                });
                const mountLive = await player.waitForMountLive(cfgNow, 30000);
                if (!mountLive) {
                    await reply('Track queued, but live stream is not ready yet. Check Icecast source/tunnel.');
                    return true;
                }

                const liveUrl = cacheBustHttpsStreamUrl(pubNow);
                const applied = await applyRoomMediaStreamUrl(page, liveUrl);
                const verified = await waitForRoomMediaPlayback(page, {
                    roomId,
                    expectedUrl: liveUrl,
                    timeoutMs: 18000,
                    intervalMs: 1500,
                });
                if (verified.ok) {
                    await reply(`playing ${one.title} (live stream)`);
                } else if (applied) {
                    await reply(
                        `Updated room media URL, but IMVU API confirmation is pending (last status: ${verified.status || 'unknown'}).`,
                    );
                } else {
                    await reply('Generated URL, but could not auto-update room media fields in this layout.');
                }
            } catch (e) {
                console.warn('[music] live play failed:', e?.message || e);
                await reply(`Could not start live stream right now: ${e?.message || 'unknown error'}`);
            }
            return true;
        }

        if (cmd === '*playmp3' || cmd === '*mp3') {
            if (!rest) {
                await reply('Usage: !playmp3 <song or YouTube URL>');
                return true;
            }

            const one = await resolveYoutubePlayable(rest);
            if (!one) {
                await reply('Could not find that track for mp3 export.');
                return true;
            }

            const cfgNow = await loadConfig();
            const pubNow = String(cfgNow?.publicStreamUrl || '').trim();
            if (!/^https:\/\//i.test(pubNow)) {
                await reply('No HTTPS public URL available. Configure tunnel first, then try !playmp3 again.');
                return true;
            }

            try {
                player.skip();
                const fileUrl = await exportYoutubeToStaticMp3Url({
                    youtubeUrl: one.url,
                    publicStreamUrl: pubNow,
                    roomId,
                });
                const applied = await applyRoomMediaStreamUrl(page, fileUrl);
                const verified = await waitForRoomMediaPlayback(page, {
                    roomId,
                    expectedUrl: fileUrl,
                    timeoutMs: 18000,
                    intervalMs: 1500,
                });
                if (verified.ok) {
                    await reply(`playing ${one.title} (static mp3)`);
                } else if (applied) {
                    await reply(
                        `Updated room media URL, but IMVU API confirmation is pending (last status: ${verified.status || 'unknown'}).`,
                    );
                } else {
                    await reply('Generated URL, but could not auto-update room media fields in this layout.');
                }
            } catch (e) {
                console.warn('[music] playmp3 export failed:', e?.message || e);
                await reply(`Could not export mp3 right now: ${e?.message || 'unknown error'}`);
            }
            return true;
        }

        return false;
    };
}
