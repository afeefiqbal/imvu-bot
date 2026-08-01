import { loadStreamConfig } from './loadStreamConfig.js';
import { resolveYoutubePlayable } from './resolvePlay.js';
import { exportYoutubeToStaticMp3Url } from './mp3FileExport.js';
import { applyRoomMediaStreamUrl, waitForRoomMediaPlayback } from './imvuRoomMediaDom.js';
import { createRoomPlayer } from './player.js';
import { cacheBustHttpsStreamUrl } from './loadStreamConfig.js';
import { probePublicStreamForImvu, urlLooksLikeNgrokFree, isImvuBlockingStreamProbe } from './verifyImvuStreamUrl.js';
import {
    resolveVibeversePlayable,
    parseMusicSearchQuery,
    vibeverseEnabled,
} from './vibeverseClient.js';
import { createVibeverseRoomPlayer } from './vibeverseRoomPlayer.js';

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

function formatTrackLabel(track) {
    const title = String(track?.title || '').trim() || 'Unknown track';
    // Strip album suffix if an older search path stuffed it into artistName.
    let artist = String(track?.artistName || '').trim();
    artist = artist.replace(/\s*[·•]\s*.+$/, '').trim();
    return artist ? `${title} — ${artist}` : title;
}

async function replyRoomMediaFailure(reply, result, track = null) {
    const label = track ? formatTrackLabel(track) : '';
    const reason = String(result?.reason || '');
    if (reason === 'icecast-disabled') {
        await reply(
            'Live radio needs Icecast enabled on the bot host (MUSIC_ENABLED + ICECAST_*). Ask an admin to check the server config.',
        );
        return;
    }
    if (reason === 'no-public-url') {
        await reply(
            'Live radio needs a public HTTPS stream URL. Set MUSIC_PUBLIC_STREAM_URL_TEMPLATE or CLOUDFLARE_TUNNEL_AUTO=1, then restart.',
        );
        return;
    }
    if (reason === 'mount-not-live' || reason === 'ffmpeg-spawn') {
        await reply(
            label
                ? `Found “${label}”, but the live stream did not start. Try again in a moment.`
                : 'The live stream did not start. Try again in a moment.',
        );
        return;
    }
    if (roomMediaNotModerator(result)) {
        await reply(
            label
                ? `Queued “${label}”, but I need host or mod in this room to change the radio URL. Ask the room owner to mod me.`
                : 'Music is queued, but I need host or mod in this room to change the radio URL. Ask the room owner to mod me.',
        );
        return;
    }
    await reply(
        label
            ? `Found “${label}”, but could not update the room radio URL right now.`
            : 'Could not update the room radio URL right now.',
    );
}

const HELP_VIBEVERSE = `Music: !play/!p · !add/!a · !queue/!q · !skip/!next · !stop · !pause · !resume · !autoplay-off · !music · when radio is off, autoplay starts in ~3s · !autoplay-off keeps music off · radio https://vibeverse-web.vvpz.workers.dev/radio`;
const HELP_ICECAST = `Music: !play/!p · !add/!a · !queue/!q · !skip · !stop · !pause · !resume · !music · idle playlist is server .env only (not set by chat)`;

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

async function syncLiveStreamToRoom({
    player,
    page,
    sessionClient,
    roomId,
    loadConfig,
    track,
    reply,
    statusPrefix,
    playEpoch,
}) {
    const stream = await loadPublicStreamConfig(loadConfig, player, reply);
    if (!stream) return false;
    const { cfgNow, pubNow } = stream;
    const mediaOpts = { sessionClient, roomId, stationName: String(track?.title || '').trim() };
    const liveUrl = cfgNow?.perPlayMount ? pubNow : cacheBustHttpsStreamUrl(pubNow);
    const mountWaitMs = Math.max(
        8000,
        parseInt(String(process.env.MUSIC_CHAT_WAIT_MOUNT_MS || '25000'), 10) || 25000
    );
    const epoch =
        playEpoch != null
            ? Number(playEpoch)
            : typeof player.getPlayEpoch === 'function'
              ? player.getPlayEpoch()
              : null;

    try {
        // Own the room-URL update so the player does not push a 404 at MUSIC_DOM_STREAM_DELAY_MS.
        player.notifyRoomMediaSynced();

        // Wait for a real Icecast SOURCE before touching IMVU radio URL (early 404 → RADIO STREAM ERROR).
        const mountLive = await player.waitForMountLive(cfgNow, mountWaitMs);
        if (!mountLive) {
            // !stop cleared the queue, or a newer !play/!skip replaced this sync — stay silent.
            if (
                epoch != null &&
                typeof player.isSyncSuperseded === 'function' &&
                player.isSyncSuperseded(epoch)
            ) {
                return false;
            }
            if (urlLooksLikeNgrokFree(pubNow)) {
                await reply(
                    'Stream tunnel is ngrok free tier — IMVU gets HTML instead of MP3 (ERR_NGROK_6024). Set CLOUDFLARE_TUNNEL_AUTO=1 in .env and restart.',
                );
            } else {
                await reply('Could not find that track.');
            }
            return false;
        }

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
    const useVibeverse = vibeverseEnabled();

    if (useVibeverse) {
        console.log(
            `[music] stream API + Icecast live — ${String(process.env.VIBEVERSE_API_URL).replace(/\/$/, '')}`,
        );
        return createVibeverseCommandHandler({
            page,
            roomId,
            apiBaseUrl,
            sendMessage,
            sessionClient,
            botName: opts.botName,
        });
    }

    console.log('[music] Icecast/yt-dlp mode (set VIBEVERSE_API_URL for search + live Icecast)');
    return createIcecastCommandHandler(opts);
}

function createVibeverseCommandHandler({
    page,
    roomId,
    apiBaseUrl,
    sendMessage,
    sessionClient,
    botName,
}) {
    const player = createVibeverseRoomPlayer({
        roomId,
        apiBaseUrl,
        botName,
        page,
        sessionClient,
        onAnnounce: (text) => sendMessage(String(text || '').trim()),
    });

    let mediaSyncTail = Promise.resolve();
    const queueMediaSync = (fn) => {
        const next = mediaSyncTail.then(fn, fn);
        mediaSyncTail = next.catch(() => {});
        return next;
    };

    const handler = async ({ text, senderLabel, senderId, isSelf }) => {
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
            await reply(HELP_VIBEVERSE);
            return true;
        }

        if (cmd === '*autoplay-off' || cmd === '*autoplayoff') {
            if (player.isAutoplayOptedOut?.()) {
                await reply('Autoplay is already off. Say !play <song> to start music again.');
                return true;
            }
            player.autoplayOff?.();
            await reply('Autoplay off. Music will stay stopped until someone uses !play.');
            return true;
        }

        if (cmd === '*s' && rest) return false;

        if (cmd === '*skip' || cmd === '*s' || cmd === '*next') {
            if (!hasActivePlayback(player)) {
                await reply('Nothing to skip.');
                return true;
            }
            await queueMediaSync(async () => {
                const result = await player.skip();
                if (result?.empty) {
                    await reply('Skipped. Queue empty.');
                    return;
                }
                if (!result?.ok) {
                    await replyRoomMediaFailure(reply, result);
                    return;
                }
                const t = result.track;
                await reply(`Now playing: ${formatTrackLabel(t)}`);
            });
            return true;
        }

        if (cmd === '*stop') {
            if (!hasActivePlayback(player) && !player.isAutoplayArmed?.() && !player.isAutoplayOptedOut?.()) {
                await reply('Nothing playing.');
                return true;
            }
            if (player.isAutoplayOptedOut?.() && !hasActivePlayback(player)) {
                await reply('Nothing playing. Autoplay is off — say !play to start.');
                return true;
            }
            player.stop();
            await reply('Stopped. Autoplay resumes in ~3s — say !autoplay-off to keep music off.');
            return true;
        }

        if (cmd === '*queue' || cmd === '*q') {
            await reply(formatQueueReply(player));
            return true;
        }

        if (cmd === '*pause' || cmd === '*hold') {
            if (!hasActivePlayback(player)) {
                await reply('Nothing playing.');
                return true;
            }
            player.pause();
            await reply('Paused. Say !resume to continue.');
            return true;
        }

        if (cmd === '*resume' || cmd === '*unpause' || cmd === '*continue') {
            if (!player.isPaused()) {
                await reply('Not paused.');
                return true;
            }
            await queueMediaSync(async () => {
                const result = await player.resume();
                if (!result?.ok) {
                    await reply('Could not resume.');
                    return;
                }
                const t = result.track || player.getQueue().getCurrent();
                await reply(`Now playing: ${formatTrackLabel(t)}`);
            });
            return true;
        }

        if (cmd === '*play' || cmd === '*p' || cmd === '*playmp3' || cmd === '*mp3') {
            if (!rest) {
                await reply('Usage: !play <song or YouTube URL> · !play .typo for smart search');
                return true;
            }

            const parsed = parseMusicSearchQuery(rest);
            if (parsed.kind === 'silent') return true; // e.g. !play ...
            if (parsed.kind === 'empty') {
                await reply('Usage: !play <song or YouTube URL>');
                return true;
            }

            // Soft-preempt: keep current audio until new HLS is ready (cutForReplace must not stop radio early).
            player.cutForReplace();

            const label = parsed.display;
            await reply(
                parsed.kind === 'smart'
                    ? `Looking up “${label}” (smart)…`
                    : `Looking up “${label}”…`,
            );
            // Overlap IMVU media-player discovery with search+HLS (hides ~2–8s on cold cache).
            void sessionClient?.warmRoomRadioPlayer?.(roomId)?.catch?.(() => null);
            const one = await resolveVibeversePlayable(parsed.query, {
                roomId,
                smart: parsed.kind === 'smart',
                // Right after search (~1–3s) so chat isn't silent during 15–30s stream prep.
                onFound: async (track) => {
                    await reply(`Added to queue: ${formatTrackLabel(track)} — starting soon…`);
                },
            });
            if (one?.failed) {
                await reply(
                    `Couldn’t play that track${one.detail ? ` (${String(one.detail).slice(0, 120)})` : ''}.`,
                );
                return true;
            }
            if (one?.pending) {
                await reply(
                    'That track is still preparing in the library — try again in a moment.',
                );
                return true;
            }
            if (!one?.streamUrl) {
                if (!vibeverseEnabled()) {
                    await reply('Music lookup is not configured.');
                } else {
                    await reply('Could not find that track.');
                }
                // Never kick idle autoplay on a miss — leave whatever is already playing alone.
                return true;
            }

            await queueMediaSync(async () => {
                const result = await player.playNow(one);
                if (!result?.ok) {
                    if (result?.reason === 'stale') {
                        // Superseded by a newer !play — that request will announce itself.
                        return;
                    }
                    await replyRoomMediaFailure(reply, result, one);
                    return;
                }
                await reply(`Now playing: ${formatTrackLabel(one)}`);
            });
            return true;
        }

        if (cmd === '*add' || cmd === '*a') {
            if (!rest) {
                await reply('Usage: !add <song or YouTube URL>');
                return true;
            }

            const parsed = parseMusicSearchQuery(rest);
            if (parsed.kind === 'silent') return true;
            if (parsed.kind === 'empty') {
                await reply('Usage: !add <song or YouTube URL>');
                return true;
            }

            await reply(
                parsed.kind === 'smart'
                    ? `Looking up “${parsed.display}” (smart)…`
                    : `Looking up “${parsed.display}”…`,
            );
            let announcedQueued = false;
            const one = await resolveVibeversePlayable(parsed.query, {
                roomId,
                smart: parsed.kind === 'smart',
                onFound: async (track) => {
                    announcedQueued = true;
                    await reply(`Added to queue: ${formatTrackLabel(track)} — starting soon…`);
                },
            });
            if (one?.failed) {
                await reply(
                    `Couldn’t add that track${one.detail ? ` (${String(one.detail).slice(0, 120)})` : ''}.`,
                );
                return true;
            }
            if (one?.pending) {
                player.armAutoplay?.('!add');
                void player.ensurePlaying?.();
                await reply(
                    'That track is still preparing — keeping music going meanwhile.',
                );
                return true;
            }
            if (!one?.streamUrl) {
                if (!vibeverseEnabled()) {
                    await reply('Music lookup is not configured.');
                } else {
                    await reply('Could not find that track.');
                }
                return true;
            }

            const wasActive = hasActivePlayback(player);
            await queueMediaSync(async () => {
                const result = await player.enqueue(one);
                if (result?.queued) {
                    if (!announcedQueued) {
                        await reply(`Added to queue: ${formatTrackLabel(one)}`);
                    }
                    return;
                }
                if (!result?.ok) {
                    await replyRoomMediaFailure(reply, result, one);
                    return;
                }
                const playing = result.track || one;
                await reply(
                    wasActive
                        ? `Added — now playing: ${formatTrackLabel(playing)}`
                        : `Now playing: ${formatTrackLabel(playing)}`,
                );
            });
            return true;
        }

        return false;
    };

    handler.player = player;
    return handler;
}

function createIcecastCommandHandler(opts) {
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

    /** Serialize room-radio API updates; drop superseded syncs when !play races. */
    let mediaSyncTail = Promise.resolve();
    let mediaSyncGen = 0;
    const queueMediaSync = (fn) => {
        const gen = ++mediaSyncGen;
        const next = mediaSyncTail.then(
            async () => {
                if (gen !== mediaSyncGen) return false;
                return fn();
            },
            async () => {
                if (gen !== mediaSyncGen) return false;
                return fn();
            },
        );
        mediaSyncTail = next.catch(() => {});
        return next;
    };

    /**
     * @returns {Promise<boolean>} true if this message was a music command (consumed)
     */
    const handler = async ({ text, senderLabel, senderId, isSelf }) => {
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
            await reply(HELP_ICECAST);
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
            await reply('Paused. Say !resume to continue.');
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

            // ACK immediately so room chat isn't blocked on Icecast/yt-dlp/mod checks.
            await reply(`Playing ${one.title}…`);

            try {
                await player.prepareStreamForNextTrack();
                const playEpoch = player.playNow({
                    title: one.title,
                    url: one.url,
                });
                void queueMediaSync(() =>
                    syncLiveStreamToRoom({
                        player,
                        page,
                        sessionClient,
                        roomId,
                        loadConfig,
                        track: one,
                        reply,
                        statusPrefix: 'playing ',
                        playEpoch,
                    }),
                ).catch((e) => {
                    console.warn('[music] live play failed:', e?.message || e);
                    void reply(`Could not start live stream right now: ${e?.message || 'unknown error'}`);
                });
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
            if (wasActive) {
                // Queue only — do not kill the current Icecast encode or change the radio URL.
                player.enqueue({
                    title: one.title,
                    url: one.url,
                });
                await reply(`Added: ${one.title}`);
                return true;
            }

            await reply(`Playing ${one.title}…`);
            await player.prepareStreamForNextTrack();
            player.enqueue({
                title: one.title,
                url: one.url,
            });
            const playEpoch =
                typeof player.getPlayEpoch === 'function' ? player.getPlayEpoch() : null;

            void queueMediaSync(() =>
                syncLiveStreamToRoom({
                    player,
                    page,
                    sessionClient,
                    roomId,
                    loadConfig,
                    track: one,
                    playEpoch,
                    reply,
                    statusPrefix: 'Added — now playing: ',
                }),
            ).catch((e) => {
                console.warn('[music] add failed:', e?.message || e);
                void reply(`Could not start live stream right now: ${e?.message || 'unknown error'}`);
            });
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

    handler.player = player;
    return handler;
}
