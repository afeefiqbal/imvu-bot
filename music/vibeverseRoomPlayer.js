import { createTrackQueue } from './queue.js';
import { applyRoomMediaStreamUrl, waitForRoomMediaPlayback } from './imvuRoomMediaDom.js';
import { notifyImvuMusicState } from './notifyImvuMusicApi.js';
import { playVibeverseTrack, refreshVibeverseStream } from './vibeverseClient.js';
import { createFfmpegFileToIcecast, createFfmpegHttpToIcecast } from './ffmpegIcecast.js';
import { downloadToTemp } from './downloadToTemp.js';
import { loadStreamConfig, withPerPlayStreamMount } from './loadStreamConfig.js';
import { withIcecastMountEncodeLock } from './icecastMountLock.js';
import {
    icecastDestFromConfig,
    icecastStatusJsonShowsSource,
    waitForIcecastMountLive,
} from './icecastLive.js';
import { isHlsColdEnabled, isHlsOnlyEnabled, startHlsColdSession } from './hlsSession.js';

/**
 * IMVU room player (hybrid HLS when MUSIC_HLS_COLD):
 *   - R2 warm → ffmpeg → m3u8 (fast)
 *   - Cold → progressive URL → ffmpeg → m3u8 ASAP (R2 fills in background)
 * Icecast mount encode is skipped in HLS-only mode.
 */
/**
 * @param {{
 *   roomId: string,
 *   apiBaseUrl: string,
 *   botName?: string,
 *   page?: object | null,
 *   sessionClient?: object | null,
 * }} opts
 */
export function createVibeverseRoomPlayer(opts) {
    const { roomId, apiBaseUrl, botName, page, sessionClient, onAnnounce } = opts;
    const queue = createTrackQueue();

    let playing = false;
    let paused = false;
    /** @type {import('child_process').ChildProcess | null} */
    let ffProc = null;
    /** @type {(() => Promise<void>) | null} */
    let tempCleanup = null;
    /** @type {(() => Promise<void>) | null} */
    let hlsCleanup = null;
    /**
     * Previous encode kept alive during !play lookup/HLS warmup so room audio
     * does not go silent until the new m3u8 is ready to apply.
     * @type {import('child_process').ChildProcess | null}
     */
    let outgoingProc = null;
    /** @type {(() => Promise<void>) | null} */
    let outgoingCleanup = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let endTimer = null;
    /** @type {Promise<void>} */
    let drainTail = Promise.resolve();
    let generation = 0;
    /** @type {object | null} */
    let activeStreamCfg = null;
    /** Last IMVU radio URL we successfully applied (stable /live skips rewrite). */
    let lastRoomRadioUrl = '';
    /** Idle autoplay flag (compat with origin commandHandler). Full idle pick TBD. */
    let autoplayArmed = false;

    const clearEndTimer = () => {
        if (endTimer) {
            clearTimeout(endTimer);
            endTimer = null;
        }
    };

    const armAutoplay = (reason = 'user') => {
        if (!autoplayArmed) {
            console.log(`[music] autoplay armed (${roomId}): ${reason}`);
        }
        autoplayArmed = true;
    };

    const disarmAutoplay = () => {
        if (autoplayArmed) {
            console.log(`[music] autoplay disarmed (${roomId})`);
        }
        autoplayArmed = false;
    };

    const clearTempFile = () => {
        const fn = tempCleanup;
        tempCleanup = null;
        if (fn) void fn().catch(() => {});
        const h = hlsCleanup;
        hlsCleanup = null;
        if (h) void h().catch(() => {});
    };

    const discardOutgoing = () => {
        const proc = outgoingProc;
        const cleanup = outgoingCleanup;
        outgoingProc = null;
        outgoingCleanup = null;
        if (proc) {
            try {
                proc.kill('SIGKILL');
            } catch {}
        }
        if (cleanup) void cleanup().catch(() => {});
    };

    /** Park the live encode without killing it (room keeps hearing the old m3u8). */
    const parkCurrentEncode = () => {
        discardOutgoing();
        if (!ffProc && !hlsCleanup) return;
        outgoingProc = ffProc;
        outgoingCleanup = hlsCleanup;
        ffProc = null;
        hlsCleanup = null;
        // tempCleanup belongs to the outgoing encode's lifecycle via hlsCleanup/ffmpeg exit.
    };

    /** Restore a parked encode after a failed replace so the old song keeps playing. */
    const restoreOutgoing = () => {
        if (!outgoingProc && !outgoingCleanup) return false;
        killCurrentEncodeOnly();
        ffProc = outgoingProc;
        hlsCleanup = outgoingCleanup;
        outgoingProc = null;
        outgoingCleanup = null;
        return true;
    };

    const killCurrentEncodeOnly = () => {
        if (!ffProc) {
            clearTempFile();
            return;
        }
        try {
            ffProc.kill('SIGKILL');
        } catch {}
        ffProc = null;
        clearTempFile();
    };

    const killFf = () => {
        discardOutgoing();
        killCurrentEncodeOnly();
    };

    /** Best-effort: stop IMVU room radio so the current song cuts immediately. */
    const stopRoomRadioQuiet = () => {
        if (typeof sessionClient?.stopRoomRadioStream !== 'function') return;
        void sessionClient.stopRoomRadioStream(roomId).catch(() => {});
    };

    /**
     * Soft-preempt for !play: invalidate in-flight work and clear the queue,
     * but keep the current encode + room radio until the new track's HLS is live.
     * Hard stop still happens in stop()/skip() and at URL cutover in playViaHls.
     */
    const cutForReplace = () => {
        clearEndTimer();
        generation += 1;
        queue.clearPending();
        paused = false;
        // Re-arm natural end advance under the new generation so a failed !play
        // still advances when the parked/current encode finishes.
        if (ffProc && queue.getCurrent()) {
            scheduleAdvanceOnFfExit(queue.getCurrent(), generation, ffProc);
        } else if (outgoingProc && queue.getCurrent()) {
            scheduleAdvanceOnFfExit(queue.getCurrent(), generation, outgoingProc);
        }
    };

    const notify = (track, state) => {
        void notifyImvuMusicState({
            apiBaseUrl,
            roomId,
            botName,
            track: track
                ? {
                      title: track.title,
                      url: track.streamUrl || track.url || '',
                  }
                : null,
            state,
        });
    };

    const loadConfig = () => loadStreamConfig({ apiBaseUrl, roomId });

    const urlsMatch = (a, b) => {
        const norm = (u) =>
            String(u || '')
                .trim()
                .replace(/\/+$/, '')
                .toLowerCase();
        return Boolean(norm(a) && norm(a) === norm(b));
    };

    const applyPublicUrlToRoom = async (publicUrl, track, opts = {}) => {
        const url = String(publicUrl || '').trim();
        if (!/^https:\/\//i.test(url)) {
            return { ok: false, reason: 'no-public-url', detail: 'Icecast HTTPS public URL is not configured.' };
        }

        // Stable /live: if IMVU is already on this URL, skip stop→clear→update→start (~8–10s).
        if (opts.skipIfSame !== false) {
            if (urlsMatch(lastRoomRadioUrl, url)) {
                console.log(`[music] room ${roomId} already on stable URL — skip radio rewrite`);
                return { ok: true, reason: 'url-unchanged-cached' };
            }
            if (typeof sessionClient?.fetchRoomMediaPlaybackState === 'function') {
                try {
                    const st = await sessionClient.fetchRoomMediaPlaybackState(roomId);
                    if (st?.ok && urlsMatch(st.stationUrl, url) && /playing/i.test(String(st.status || ''))) {
                        lastRoomRadioUrl = url;
                        console.log(`[music] room ${roomId} already playing stable URL — skip radio rewrite`);
                        return { ok: true, reason: 'url-unchanged-live' };
                    }
                } catch {
                    /* fall through to apply */
                }
            }
        }

        console.log(`[music] applying live stream URL to room ${roomId}: ${url}`);
        const applied = await applyRoomMediaStreamUrl(page, url, {
            sessionClient,
            roomId,
            stationName: String(track?.title || '').trim(),
        });
        if (!applied.ok) return applied;
        lastRoomRadioUrl = url;
        // Don't block chat on IMVU playback confirmation — announce as soon as the URL is set.
        void waitForRoomMediaPlayback(page, {
            roomId,
            expectedUrl: url,
            timeoutMs: 4_000,
            intervalMs: 1000,
            sessionClient,
        }).catch(() => ({ ok: false }));
        return applied;
    };

    const useHlsPath = (track) => {
        if (isHlsOnlyEnabled()) return true;
        if (!isHlsColdEnabled()) return false;
        if (track?.delivery === 'hls') return true;
        if (track?.cached === false) return true;
        const url = String(track?.streamUrl || '');
        return /\/stream\/[\w-]{11}(\?|$)/i.test(url);
    };

    const playViaHls = async (track, gen, pub) => {
        const isStale = () => gen !== generation;
        const src = String(track?.streamUrl || '');
        const kind = track?.cached
            ? 'R2'
            : track?.progressiveReady
              ? 'resolved'
              : /\/stream\//i.test(src)
                ? 'progressive'
                : 'direct';
        console.log(`[music] HLS: ${kind} → m3u8 for “${track?.title || '?'}”`);
        const session = await startHlsColdSession({
            sourceUrl: track.streamUrl,
            roomId,
            publicStreamUrl: pub,
            playToken: Date.now(),
            isStale,
            progressiveReady: track?.progressiveReady === true,
            resolved: track?.progressiveReady === true || track?.cached === true,
            waitMs:
                Number(process.env.MUSIC_HLS_WAIT_READY_MS) ||
                (track?.progressiveReady || track?.cached ? 12_000 : 25_000),
        });
        if (isStale()) {
            if (session.cleanup) await session.cleanup().catch(() => {});
            return { ok: false, reason: 'stale' };
        }
        if (!session.ok || !session.publicUrl || !session.proc) {
            // Keep previous song playing if we parked it during !play.
            if (outgoingProc || outgoingCleanup) {
                restoreOutgoing();
                playing = true;
                console.log('[music] HLS failed — restored previous encode (room radio unchanged)');
            }
            return {
                ok: false,
                reason: session.reason || 'hls-failed',
                detail: session.detail || 'HLS start failed',
            };
        }

        // Cut over only when the new playlist is ready.
        console.log(
            `[music] HLS ready — cutting over${session.stable ? ' (promote live-next → live)' : ' room radio URL'}`,
        );
        discardOutgoing();
        killCurrentEncodeOnly();
        if (typeof session.promote === 'function') {
            try {
                await session.promote();
            } catch (e) {
                if (session.cleanup) await session.cleanup().catch(() => {});
                return {
                    ok: false,
                    reason: 'hls-promote-failed',
                    detail: e?.message || 'Failed to promote HLS live dir',
                };
            }
        }
        hlsCleanup = session.cleanup || null;
        ffProc = session.proc;

        const applied = await applyPublicUrlToRoom(session.publicUrl, track);
        if (isStale()) {
            killFf();
            return { ok: false, reason: 'stale' };
        }
        if (!applied.ok) {
            killFf();
            return applied;
        }

        console.log(
            JSON.stringify({
                event: 'room_url_updated',
                roomId,
                publicUrl: session.publicUrl,
                skippedRewrite: /url-unchanged/i.test(String(applied.reason || '')),
            }),
        );
        console.log(
            `[music] HLS live — room radio ${/url-unchanged/i.test(String(applied.reason || '')) ? 'unchanged at' : 'set to'} ${session.publicUrl}`,
        );
        scheduleAdvanceOnFfExit(track, gen, session.proc);
        return { ok: true, track };
    };

    const scheduleAdvanceOnFfExit = (track, gen, proc) => {
        clearEndTimer();
        const ms = Number(track?.durationMs) || 0;
        // Safety net if ffmpeg hangs after the track; primary advance is proc exit.
        const waitMs = Math.max(30_000, (ms > 0 ? ms : 180_000) + 15_000);
        endTimer = setTimeout(() => {
            if (gen !== generation || paused) return;
            console.log(`[music] track timer elapsed — advancing: ${track?.title || '?'}`);
            killFf();
            queue.setCurrent(null);
            playing = false;
            notify(null, 'idle');
            void enqueueDrain();
        }, waitMs);

        proc.once('exit', (code, sig) => {
            if (gen !== generation) return;
            console.log(
                `[music] live encode ended (code=${code}, signal=${sig || 'none'}): ${track?.title || '?'}`,
            );
            if (ffProc === proc) ffProc = null;
            clearTempFile();
            clearEndTimer();
            if (paused) return;
            queue.setCurrent(null);
            playing = false;
            notify(null, 'idle');
            void enqueueDrain();
        });
    };

    const playCurrentOrNext = async (opts = {}) => {
        const gen = ++generation;
        clearEndTimer();
        const keepOutgoing = opts.keepOutgoing === true;
        if (!keepOutgoing) {
            killFf();
        }
        // When keepOutgoing, previous encode is already parked in outgoingProc.

        let track = queue.getCurrent();
        if (!track) {
            track = queue.dequeue();
            if (track) queue.setCurrent(track);
        }
        if (!track) {
            killFf();
            playing = false;
            paused = false;
            notify(null, 'idle');
            return { ok: true, empty: true };
        }

        if (!track.streamUrl && track.trackId) {
            const fresh = await playVibeverseTrack({
                id: track.trackId,
                title: track.title,
                artistName: track.artistName,
                artworkUrl: track.artworkUrl,
                durationMs: track.durationMs,
            });
            if (gen !== generation) return { ok: false, reason: 'stale' };
            if (fresh?.ok && fresh.track) Object.assign(track, fresh.track);
            else if (fresh?.streamUrl) Object.assign(track, fresh);
        }

        if (!track.streamUrl) {
            console.warn('[music] skip unplayable track:', track.title);
            if (gen !== generation) return { ok: false, reason: 'stale' };
            queue.setCurrent(null);
            return playCurrentOrNext();
        }

        if (gen !== generation) return { ok: false, reason: 'stale' };

        const baseCfg = await loadConfig();
        if (gen !== generation) return { ok: false, reason: 'stale' };
        if (!baseCfg?.enabled) {
            playing = false;
            queue.setCurrent(null);
            notify(null, 'idle');
            return {
                ok: false,
                reason: 'icecast-disabled',
                detail: 'Live radio needs Icecast enabled (MUSIC_ENABLED / ICECAST_*).',
            };
        }

        activeStreamCfg = withPerPlayStreamMount(baseCfg, roomId, Date.now());
        const pub = String(activeStreamCfg.publicStreamUrl || '').trim();
        if (!/^https:\/\//i.test(pub)) {
            playing = false;
            queue.setCurrent(null);
            notify(null, 'idle');
            return {
                ok: false,
                reason: 'no-public-url',
                detail:
                    'Live radio needs MUSIC_PUBLIC_STREAM_URL_TEMPLATE or an Icecast HTTPS tunnel (CLOUDFLARE_TUNNEL_AUTO=1).',
            };
        }

        paused = false;
        playing = true;
        notify(track, 'playing');

        // Hybrid HLS (default): R2 or progressive → m3u8. No Icecast mount in HLS-only mode.
        if (useHlsPath(track)) {
            let hlsResult = await playViaHls(track, gen, pub);
            if (hlsResult?.ok || hlsResult?.reason === 'stale') return hlsResult;

            // Retry once with a fresh durable URL if the first source failed.
            if (track.trackId) {
                console.warn(
                    `[music] HLS failed (${hlsResult?.reason || 'unknown'}) — refreshing durable URL and retrying HLS`,
                );
                const durable = await playVibeverseTrack(
                    {
                        id: track.trackId,
                        title: track.title,
                        artistName: track.artistName,
                        artworkUrl: track.artworkUrl,
                        durationMs: track.durationMs,
                    },
                    { forceDurable: true },
                );
                if (gen !== generation) return { ok: false, reason: 'stale' };
                const t = durable?.track || (durable?.streamUrl ? durable : null);
                if (durable?.ok && t?.streamUrl && !/\/stream\/[\w-]{11}(\?|$)/i.test(String(t.streamUrl))) {
                    Object.assign(track, t, { delivery: 'hls', cached: true });
                    hlsResult = await playViaHls(track, gen, pub);
                    if (hlsResult?.ok || hlsResult?.reason === 'stale') return hlsResult;
                }
            }

            // playViaHls already restored outgoing on failure when parked.
            if (!(outgoingProc || ffProc)) {
                playing = false;
                queue.setCurrent(null);
                notify(null, 'idle');
            }
            return hlsResult || { ok: false, reason: 'hls-failed' };
        }

        // Leaving HLS path — drop any parked encode before Icecast.
        discardOutgoing();
        killCurrentEncodeOnly();

        if (isHlsOnlyEnabled()) {
            playing = false;
            queue.setCurrent(null);
            notify(null, 'idle');
            return {
                ok: false,
                reason: 'hls-failed',
                detail: 'HLS-only mode is on but HLS path was skipped',
            };
        }

        const iceDest = icecastDestFromConfig(activeStreamCfg);
        const loopHost =
            activeStreamCfg.icecastHost === '0.0.0.0'
                ? '127.0.0.1'
                : String(activeStreamCfg.icecastHost || '127.0.0.1');
        const icePort = Number(activeStreamCfg.icecastPort) || 8001;
        const mountPath = activeStreamCfg.icecastMount.startsWith('/')
            ? activeStreamCfg.icecastMount
            : `/${activeStreamCfg.icecastMount}`;
        const mountLockKey = `${loopHost}:${icePort}${mountPath}`;
        const isStale = () => gen !== generation;

        console.log(
            `[music] live encode: VibeVerse → local file → Icecast ${mountPath} → ${pub.slice(0, 120)}`,
        );

        /** @type {{ ok: boolean, reason?: string, detail?: string }} */
        let applied = { ok: false, reason: 'encode-failed' };

        // Serialize connect to this mount; return to chat as soon as the live URL is pushed
        // (do not wait for the whole track — ffmpeg keeps running in the background).
        await withIcecastMountEncodeLock(mountLockKey, async () => {
            if (isStale()) return;

            // Download durable URL first so -re never underruns on remote HTTP stalls.
            /** @type {string | null} */
            let localFile = null;
            try {
                const dl = await downloadToTemp({
                    url: track.streamUrl,
                    roomId,
                    label: 'vv',
                });
                if (isStale()) {
                    await dl.cleanup();
                    return;
                }
                localFile = dl.filePath;
                tempCleanup = dl.cleanup;
            } catch (e) {
                console.error('[music] durable download failed:', e?.message || e);
                applied = {
                    ok: false,
                    reason: 'download-failed',
                    detail: e?.message || 'Could not download track audio',
                };
                return;
            }

            // Local file opens instantly; keep enough wait for Icecast SOURCE handshake.
            const waitMs = Math.max(
                8000,
                parseInt(String(process.env.MUSIC_CHAT_WAIT_MOUNT_MS || '20000'), 10) || 20000,
            );
            const coldRestart = !/^(0|false|no|off)$/i.test(
                String(process.env.MUSIC_ICECAST_COLD_RESTART ?? '1').trim(),
            );

            const spawnEncode = () => {
                try {
                    if (localFile) {
                        console.log(`[music] live encode: local file → Icecast (${localFile})`);
                        return createFfmpegFileToIcecast({
                            filePath: localFile,
                            icecastDestUrl: iceDest,
                        }).proc;
                    }
                    return createFfmpegHttpToIcecast({
                        sourceUrl: track.streamUrl,
                        icecastDestUrl: iceDest,
                    }).proc;
                } catch (e) {
                    console.error('[music] ffmpeg →icecast failed:', e?.message || e);
                    return null;
                }
            };

            const waitMount = (timeout) =>
                waitForIcecastMountLive(activeStreamCfg, timeout, {
                    isStale,
                    localOnly: true,
                    pollMs: 100,
                    isEncodeAlive: () =>
                        Boolean(ffProc) && ffProc.exitCode == null && ffProc.signalCode == null,
                });

            let proc = spawnEncode();
            if (!proc) {
                clearTempFile();
                applied = { ok: false, reason: 'ffmpeg-spawn', detail: 'ffmpeg failed' };
                return;
            }
            if (isStale()) {
                try {
                    proc.kill('SIGKILL');
                } catch {}
                clearTempFile();
                return;
            }
            ffProc = proc;

            const diagAt = Math.min(8000, Math.max(3000, Math.floor(waitMs / 2)));
            setTimeout(async () => {
                if (isStale()) return;
                const up = await icecastStatusJsonShowsSource(loopHost, icePort, mountPath);
                if (isStale()) return;
                if (!up) {
                    const ffGone = !ffProc || ffProc.exitCode != null || ffProc.signalCode != null;
                    console.warn(
                        `[music] Icecast has no SOURCE on ${mountPath} at ${loopHost}:${icePort} ~${Math.round(diagAt / 1000)}s after start` +
                            (ffGone ? ' (ffmpeg already exited).' : '.'),
                    );
                } else {
                    console.log(`[music] Icecast confirms source on ${mountPath} (${loopHost}:${icePort}).`);
                }
            }, diagAt);

            let live = await waitMount(waitMs);
            if (isStale()) return;
            if (!live || !ffProc) {
                console.warn('[music] Mount never went live — not pushing room radio URL.');
                killFf();
                applied = {
                    ok: false,
                    reason: 'mount-not-live',
                    detail: 'Live Icecast mount did not become ready. Check Icecast and the public HTTPS tunnel.',
                };
                return;
            }

            // Warm-up encode often burns 5–15s before we set IMVU radio → listeners join mid-song.
            // Kill and restart so the live edge is near t=0 when we push the URL.
            // Keep the same local temp file across cold-restart (only kill ffmpeg).
            if (coldRestart && !isStale()) {
                console.log('[music] cold-restart encode so IMVU radio joins near track start');
                if (ffProc) {
                    try {
                        ffProc.kill('SIGKILL');
                    } catch {}
                    ffProc = null;
                }
                await new Promise((r) => setTimeout(r, 200));
                if (isStale()) return;
                proc = spawnEncode();
                if (!proc) {
                    clearTempFile();
                    applied = { ok: false, reason: 'ffmpeg-spawn', detail: 'ffmpeg cold-restart failed' };
                    return;
                }
                ffProc = proc;
                // Second start usually has CDN/TCP warm; short wait is enough.
                const restartWait = Math.min(
                    waitMs,
                    Math.max(5000, parseInt(String(process.env.MUSIC_ICECAST_COLD_RESTART_WAIT_MS || '12000'), 10) || 12000),
                );
                live = await waitMount(restartWait);
                if (isStale()) return;
                if (!live || !ffProc) {
                    console.warn('[music] Cold-restart mount never went live — not pushing room radio URL.');
                    killFf();
                    applied = {
                        ok: false,
                        reason: 'mount-not-live',
                        detail: 'Live Icecast mount did not become ready after cold restart.',
                    };
                    return;
                }
            }

            applied = await applyPublicUrlToRoom(pub, track);
            if (isStale()) return;
            if (!applied.ok) {
                killFf();
                return;
            }

            console.log('[music] Mount live — room radio URL set to shared Icecast stream.');
            scheduleAdvanceOnFfExit(track, gen, proc);
        });

        if (isStale()) return { ok: false, reason: 'stale' };
        if (!applied.ok) {
            playing = false;
            queue.setCurrent(null);
            notify(null, 'idle');
            return applied;
        }
        return { ok: true, track };
    };

    const enqueueDrain = () => {
        const run = async () => {
            if (paused) return;
            if (queue.getCurrent() && playing && ffProc) return;
            await playCurrentOrNext();
        };
        const next = drainTail.then(run, run);
        drainTail = next.catch(() => {});
        return next;
    };

    return {
        getQueue: () => queue,
        isPlaying: () => playing && !paused && (ffProc != null || outgoingProc != null),
        isPaused: () => paused,
        hasActive: () =>
            playing ||
            paused ||
            ffProc != null ||
            outgoingProc != null ||
            queue.getCurrent() != null ||
            queue.peek() != null,
        isAutoplayArmed: () => autoplayArmed,
        armAutoplay: (reason) => armAutoplay(reason || 'manual'),
        disarmAutoplay,
        ensurePlaying: () => enqueueDrain(),

        /**
         * Soft-preempt for !play: bump generation / clear pending queue, but keep
         * current encode + room radio until the replacement HLS URL is applied.
         */
        cutForReplace,

        /** Replace whatever is playing/queued with this track and start it now. */
        async playNow(track) {
            armAutoplay('!play');
            clearEndTimer();
            generation += 1;
            queue.clearPending();
            // Park (don't kill) current encode so listeners keep hearing it while
            // the new track resolves + HLS warms. Cutover happens in playViaHls.
            parkCurrentEncode();
            queue.setCurrent(track);
            paused = false;
            console.log(`[music] !play replace — starting “${track?.title || '?'}” (keep current until HLS ready)`);
            return playCurrentOrNext({ keepOutgoing: true });
        },

        async enqueue(track) {
            armAutoplay('!add');
            const wasIdle =
                !queue.getCurrent() && !playing && !paused && !ffProc && !queue.peek();
            queue.enqueue(track);
            if (wasIdle) return enqueueDrain();
            return { ok: true, queued: true };
        },

        async skip() {
            clearEndTimer();
            generation += 1;
            killFf();
            queue.setCurrent(null);
            playing = false;
            paused = false;
            notify(null, 'idle');
            stopRoomRadioQuiet();
            return playCurrentOrNext();
        },

        stop() {
            disarmAutoplay();
            clearEndTimer();
            generation += 1;
            killFf();
            queue.clearAll();
            playing = false;
            paused = false;
            lastRoomRadioUrl = '';
            notify(null, 'idle');
            stopRoomRadioQuiet();
        },

        pause() {
            if (!queue.getCurrent() && !playing && !ffProc) return false;
            paused = true;
            playing = false;
            clearEndTimer();
            killFf();
            notify(queue.getCurrent(), 'paused');
            return true;
        },

        async resume() {
            const track = queue.getCurrent();
            if (!paused || !track) return { ok: false, reason: 'not-paused' };
            if (track.trackId) {
                const fresh = await refreshVibeverseStream(track.trackId, track);
                if (fresh?.streamUrl) Object.assign(track, fresh);
            }
            paused = false;
            return playCurrentOrNext();
        },
    };
}
