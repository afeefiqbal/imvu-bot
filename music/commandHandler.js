import { loadStreamConfig } from './loadStreamConfig.js';
import { resolveYoutubePlayable } from './resolvePlay.js';
import { exportYoutubeToStaticMp3Url } from './mp3FileExport.js';
import { applyRoomMediaStreamUrl, waitForRoomMediaPlayback } from './imvuRoomMediaDom.js';
import { createRoomPlayer } from './player.js';
import { cacheBustHttpsStreamUrl } from './loadStreamConfig.js';
import { probePublicStreamForImvu, urlLooksLikeNgrokFree, isImvuBlockingStreamProbe } from './verifyImvuStreamUrl.js';

function roomMediaNotModerator(result) {
    const reason = String(result?.reason || '');
    const detail = String(result?.detail || '');
    return (
        reason === 'not-moderator' ||
        reason === 'not-authorized' ||
        /MEDIA_PLAYER_NODE-004|host or moderator|must be host/i.test(detail) ||
        /MEDIA_PLAYER_NODE-004|host or moderator|must be host/i.test(reason)
    );
}

async function replyRoomMediaFailure(reply, result) {
    if (roomMediaNotModerator(result)) {
        await reply(
            'Music is queued, but I need host or mod in this room to change the radio URL. Ask the room owner to mod me.',
        );
        return;
    }
    await reply('Could not update the room radio URL right now.');
}

const HELP = `Music: !play/!p · !add/!a · !queue/!q · !skip · !stop · !pause · !resume · !music · idle playlist is server .env only (not set by chat)`;

function parseCmdLine(text) {
    const t = String(text || '').trim();
    if (!t) return null;

    if (/^skip$/i.test(t)) return { cmd: '*skip', rest: '', raw: t };
    if (/^stop$/i.test(t)) return { cmd: '*stop', rest: '', raw: t };
    if (/^queue$/i.test(t)) return { cmd: '*queue', rest: '', raw: t };
    if (/^pause$/i.test(t)) return { cmd: '*pause', rest: '', raw: t };
    if (/^(resume|unpause)$/i.test(t)) return { cmd: '*resume', rest: '', raw: t };

    const naturalAdd = /^add\s+(.+)$/i.exec(t);
    if (naturalAdd) {
        return { cmd: '*add', rest: naturalAdd[1].trim(), raw: t };
    }

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

async function loadPublicStreamConfig(loadConfig, player, reply) {
    const cfgNow = (typeof player?.getActiveStreamConfig === 'function' && player.getActiveStreamConfig()) ||
        (await loadConfig());
    const pubNow = String(cfgNow?.publicStreamUrl || '').trim();
    if (!/^https:\/\//i.test(pubNow)) {
        await reply('No HTTPS public URL available. Configure tunnel first, then try again.');
        return null;
    }
    return { cfgNow, pubNow };
}

async function syncLiveStreamToRoom({ player, page, sessionClient, roomId, loadConfig, track, reply, statusPrefix }) {
    const stream = await loadPublicStreamConfig(loadConfig, player, reply);
    if (!stream) return false;
    const { cfgNow, pubNow } = stream;
    const mediaOpts = { sessionClient, roomId, stationName: String(track?.title || '').trim() };

    try {
        const mountLive = await player.waitForMountLive(cfgNow, 30000);
        if (!mountLive) {
            if (urlLooksLikeNgrokFree(pubNow)) {
                await reply(
                    'Stream tunnel is ngrok free tier — IMVU gets HTML instead of MP3 (ERR_NGROK_6024). Set CLOUDFLARE_TUNNEL_AUTO=1 in .env and restart.',
                );
            } else {
                const cookieHint =
                    process.env.YTDLP_COOKIES_FROM_BROWSER || process.env.YTDLP_COOKIES_FILE
                        ? ''
                        : ' If logs show YouTube “not a bot”, add YTDLP_COOKIES_FROM_BROWSER=chrome to .env and restart.';
                await reply(
                    `Track queued, but live stream is not ready yet. Check Icecast source/tunnel.${cookieHint}`,
                );
            }
            return false;
        }

        const liveUrl = cfgNow?.perPlayMount ? pubNow : cacheBustHttpsStreamUrl(pubNow);
        const imvuProbe = await probePublicStreamForImvu(liveUrl, 8000);
        if (isImvuBlockingStreamProbe(imvuProbe, liveUrl)) {
            await reply(
                'Room URL updated, but IMVU cannot play ngrok free streams (browser warning page). Use Cloudflare tunnel: CLOUDFLARE_TUNNEL_AUTO=1.',
            );
            return false;
        }
        const applied = await applyRoomMediaStreamUrl(page, liveUrl, mediaOpts);
        if (!applied.ok) {
            await replyRoomMediaFailure(reply, applied);
            return false;
        }
        const verified = await waitForRoomMediaPlayback(page, {
            roomId,
            expectedUrl: liveUrl,
            timeoutMs: 18000,
            intervalMs: 1500,
            sessionClient,
        });
        if (verified.ok) {
            player.notifyRoomMediaSynced();
            await reply(`${statusPrefix}${track.title} (live stream)`);
        } else if (applied.ok) {
            player.notifyRoomMediaSynced();
            await reply(
                `${statusPrefix}${track.title} — stream restarted on the room radio. If you still hear nothing, tap the radio icon once (no need to leave the room).`,
            );
        } else {
            await replyRoomMediaFailure(reply, applied);
        }
        return true;
    } catch (e) {
        console.warn('[music] live stream sync failed:', e?.message || e);
        await reply(`Could not start live stream right now: ${e?.message || 'unknown error'}`);
        return false;
    }
}

function formatQueueReply(player) {
    const q = player.getQueue();
    const cur = q.getCurrent();
    const pending = q.pending();
    const parts = [];

    if (cur) {
        const state = player.isPaused() ? ' (paused)' : player.isPlaying() ? ' (playing)' : '';
        parts.push(`Now: ${cur.title}${state}`);
    } else if (player.isPlaying()) {
        parts.push('Now: (loading...)');
    }

    if (pending.length === 0) {
        parts.push('Up next: (empty)');
    } else {
        parts.push(`Up next: ${pending.map((t, i) => `${i + 1}. ${t.title}`).join(' · ')}`);
    }

    if (parts.length === 0) return 'Queue is empty.';
    return parts.join(' · ');
}

function hasActivePlayback(player) {
    const q = player.getQueue();
    return (
        player.isPlaying() ||
        player.isPaused() ||
        q.getCurrent() != null ||
        q.peek() != null
    );
}

/**
 * @param {{
 *   page?: { isClosed?: () => boolean } | null,
 *   sessionClient?: { setRoomRadioStreamUrl?: Function, fetchRoomMediaPlaybackState?: Function } | null,
 *   roomId: string,
 *   apiBaseUrl: string,
 *   botName?: string,
 *   sendMessage: (text: string, meta?: object) => Promise<void>,
 * }} opts
 */
export async function createMusicRoomChatCommandHandler(opts) {
    const { page, roomId, apiBaseUrl, sendMessage, sessionClient } = opts;
    const loadConfig = async () => loadStreamConfig({ apiBaseUrl, roomId });
    const player = createRoomPlayer({
        roomId,
        apiBaseUrl,
        botName: opts.botName,
        page,
        sessionClient,
        loadConfig,
    });

    player.kickAutoplayDrain();

    /** Serialize room-radio API updates so rapid !play does not overlap stop/start pulses. */
    let mediaSyncTail = Promise.resolve();
    const queueMediaSync = (fn) => {
        const next = mediaSyncTail.then(fn, fn);
        mediaSyncTail = next.catch(() => {});
        return next;
    };

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

        // Bare !s = skip. "!s hi" is Character.AI (Siva) — do not consume it here.
        if (cmd === '*s' && rest) {
            return false;
        }
        if (cmd === '*skip' || cmd === '*s' || cmd === '*next') {
            if (!hasActivePlayback(player)) {
                await reply('Nothing to skip.');
                return true;
            }
            player.skip();
            await reply('Skipped.');
            return true;
        }

        if (cmd === '*stop') {
            if (!hasActivePlayback(player)) {
                await reply('Nothing playing.');
                return true;
            }
            player.stop();
            await reply('Stopped. Queue cleared.');
            return true;
        }

        if (cmd === '*queue' || cmd === '*q') {
            await reply(formatQueueReply(player));
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

            try {
                await player.prepareStreamForNextTrack();
                player.playNow({
                    title: one.title,
                    url: one.url,
                });
                await queueMediaSync(() =>
                    syncLiveStreamToRoom({
                        player,
                        page,
                        sessionClient,
                        roomId,
                        loadConfig,
                        track: one,
                        reply,
                        statusPrefix: 'playing ',
                    }),
                );
            } catch (e) {
                console.warn('[music] live play failed:', e?.message || e);
                await reply(`Could not start live stream right now: ${e?.message || 'unknown error'}`);
            }
            return true;
        }

        if (cmd === '*add' || cmd === '*a') {
            if (!rest) {
                await reply('Usage: !add <song or YouTube URL>');
                return true;
            }

            const one = await resolveYoutubePlayable(rest);
            if (!one) {
                await reply('Could not find that track.');
                return true;
            }

            const wasActive = hasActivePlayback(player);
            await player.prepareStreamForNextTrack();
            player.enqueue({
                title: one.title,
                url: one.url,
            });

            try {
                await queueMediaSync(() =>
                    syncLiveStreamToRoom({
                        player,
                        page,
                        sessionClient,
                        roomId,
                        loadConfig,
                        track: one,
                        reply,
                        statusPrefix: wasActive ? 'playing ' : 'Added — now playing: ',
                    }),
                );
            } catch (e) {
                console.warn('[music] add failed:', e?.message || e);
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
                const applied = await applyRoomMediaStreamUrl(page, fileUrl, { sessionClient, roomId });
                const verified = await waitForRoomMediaPlayback(page, {
                    roomId,
                    expectedUrl: fileUrl,
                    timeoutMs: 18000,
                    intervalMs: 1500,
                    sessionClient,
                });
                if (verified.ok) {
                    await reply(`playing ${one.title} (static mp3)`);
                } else if (applied.ok) {
                    await reply(
                        `Updated room media URL, but IMVU API confirmation is pending (last status: ${verified.status || 'unknown'}).`,
                    );
                } else {
                    await replyRoomMediaFailure(reply, applied);
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
