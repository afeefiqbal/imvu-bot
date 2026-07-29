import { createTrackQueue } from './queue.js';
import { applyRoomMediaStreamUrl, waitForRoomMediaPlayback } from './imvuRoomMediaDom.js';
import { notifyImvuMusicState } from './notifyImvuMusicApi.js';
import {
    fetchRandomVibeversePlayable,
    playVibeverseTrack,
    refreshVibeverseStream,
} from './vibeverseClient.js';
import { createFfmpegFileToIcecast, createFfmpegHttpToIcecast } from './ffmpegIcecast.js';
import { downloadToTemp } from './downloadToTemp.js';
import { loadStreamConfig, withPerPlayStreamMount } from './loadStreamConfig.js';
import { withIcecastMountEncodeLock } from './icecastMountLock.js';
import {
    icecastDestFromConfig,
    icecastStatusJsonShowsSource,
    waitForIcecastMountLive,
} from './icecastLive.js';

function envFlagTrue(name, defaultOn = false) {
    const raw = process.env[name];
    if (raw == null || String(raw).trim() === '') return defaultOn;
    return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

/** Optional comma/space allowlist — empty means any room may use autoplay once armed. */
function roomAllowedForAutoplay(roomId) {
    const raw = String(process.env.MUSIC_AUTOPLAY_ROOMS || '').trim();
    if (!raw) return true;
    const want = new Set(
        raw
            .split(/[,\s]+/)
            .map((s) => s.trim())
            .filter(Boolean),
    );
    return want.has(String(roomId || '').trim());
}

/**
 * Hybrid room player: VibeVerse search/stream URL → ffmpeg → Icecast live mount → IMVU radio.
 * Cold-restarts encode before setting the room URL so new !play starts near t=0; late joiners
 * still hear the live edge after that.
 *
 * After a user !play/!add arms the room, when the queue empties the player picks a random
 * VibeVerse track and keeps going until !stop (manual !play replaces the current song and
 * leaves autoplay armed).
 *
 * @param {{
 *   roomId: string,
 *   apiBaseUrl: string,
 *   botName?: string,
 *   page?: object | null,
 *   sessionClient?: object | null,
 *   onAnnounce?: (text: string) => void | Promise<void>,
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
    /** @type {ReturnType<typeof setTimeout> | null} */
    let endTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let autoplayRetryTimer = null;
    /** @type {Promise<void>} */
    let drainTail = Promise.resolve();
    let generation = 0;
    /** @type {object | null} */
    let activeStreamCfg = null;
    /** Idle autoplay only after user music activity (!play / !add). */
    let autoplayArmed = false;
    /** @type {string[]} */
    const recentAutoplayIds = [];
    let autoplayFailStreak = 0;

    const clearEndTimer = () => {
        if (endTimer) {
            clearTimeout(endTimer);
            endTimer = null;
        }
    };

    const clearAutoplayRetry = () => {
        if (autoplayRetryTimer) {
            clearTimeout(autoplayRetryTimer);
            autoplayRetryTimer = null;
        }
    };

    const scheduleAutoplayRetry = () => {
        clearAutoplayRetry();
        if (!autoplayArmed || paused) return;
        const ms = Math.max(
            5000,
            parseInt(String(process.env.MUSIC_AUTOPLAY_RETRY_MS || '15000'), 10) || 15000,
        );
        autoplayRetryTimer = setTimeout(() => {
            autoplayRetryTimer = null;
            if (!autoplayArmed || paused) return;
            if (playing || ffProc || queue.getCurrent() || queue.peek()) return;
            console.log(`[music] autoplay retry (${roomId})`);
            void enqueueDrain();
        }, ms);
    };

    const announce = (text) => {
        const msg = String(text || '').trim();
        if (!msg || typeof onAnnounce !== 'function') return;
        void Promise.resolve(onAnnounce(msg)).catch((e) => {
            console.warn('[music] autoplay announce:', e?.message || e);
        });
    };

    const clearTempFile = () => {
        const fn = tempCleanup;
        tempCleanup = null;
        if (fn) void fn().catch(() => {});
    };

    const killFf = () => {
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

    /** Best-effort: stop IMVU room radio so the current song cuts immediately. */
    const stopRoomRadioQuiet = () => {
        if (typeof sessionClient?.stopRoomRadioStream !== 'function') return;
        void sessionClient.stopRoomRadioStream(roomId).catch(() => {});
    };

    /**
     * Invalidate any in-flight encode/wait, kill ffmpeg, drop the queue head/pending.
     * Used by !play so a new request preempts whatever is currently playing.
     */
    const cutForReplace = () => {
        clearEndTimer();
        generation += 1;
        killFf();
        queue.clearPending();
        queue.setCurrent(null);
        playing = false;
        paused = false;
        notify(null, 'idle');
        stopRoomRadioQuiet();
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

    const armAutoplay = (reason = 'user') => {
        if (!autoplayArmed) {
            autoplayArmed = true;
            console.log(`[music] autoplay armed (${roomId}): ${reason}`);
        } else {
            autoplayArmed = true;
        }
    };

    const disarmAutoplay = () => {
        if (autoplayArmed) {
            console.log(`[music] autoplay disarmed (${roomId})`);
        }
        autoplayArmed = false;
        autoplayFailStreak = 0;
        clearAutoplayRetry();
    };

    const rememberAutoplayId = (trackId) => {
        const id = String(trackId || '').trim();
        if (!id) return;
        recentAutoplayIds.push(id);
        while (recentAutoplayIds.length > 24) recentAutoplayIds.shift();
    };

    /** When the queue is empty and armed, fetch a random READY/trending track. */
    const maybeEnqueueAutoplayTrack = async () => {
        if (queue.peek()) return true;
        if (paused) {
            console.log(`[music] autoplay skip (${roomId}): paused`);
            return false;
        }
        // Default on for VibeVerse idle fill. Set MUSIC_AUTOPLAY=0 to disable.
        if (!envFlagTrue('MUSIC_AUTOPLAY', true)) {
            console.warn(
                `[music] autoplay skip (${roomId}): MUSIC_AUTOPLAY is off — set MUSIC_AUTOPLAY=1 in .env`,
            );
            return false;
        }
        if (!autoplayArmed) {
            console.log(`[music] autoplay skip (${roomId}): not armed (need !play/!add first)`);
            return false;
        }
        if (!roomAllowedForAutoplay(roomId)) {
            console.warn(
                `[music] autoplay skip (${roomId}): room not in MUSIC_AUTOPLAY_ROOMS`,
            );
            return false;
        }
        if (autoplayFailStreak >= 5) {
            console.warn(
                `[music] autoplay paused in ${roomId} after ${autoplayFailStreak} failed picks`,
            );
            scheduleAutoplayRetry();
            return false;
        }

        console.log(`[music] autoplay filling empty queue (${roomId})…`);
        let pick = null;
        try {
            pick = await fetchRandomVibeversePlayable({ excludeIds: recentAutoplayIds });
        } catch (e) {
            console.warn(`[music] autoplay fetch failed (${roomId}):`, e?.message || e);
            autoplayFailStreak += 1;
            scheduleAutoplayRetry();
            return false;
        }
        if (!pick?.streamUrl) {
            autoplayFailStreak += 1;
            console.warn(`[music] autoplay: no playable track for ${roomId}`);
            scheduleAutoplayRetry();
            return false;
        }

        autoplayFailStreak = 0;
        clearAutoplayRetry();
        rememberAutoplayId(pick.trackId);
        console.log(`[music] idle autoplay (${roomId}): ${pick.title}`);
        queue.enqueue({
            trackId: pick.trackId,
            title: pick.title,
            artistName: pick.artistName,
            artworkUrl: pick.artworkUrl,
            durationMs: pick.durationMs,
            streamUrl: pick.streamUrl,
            autoplay: true,
        });
        return true;
    };

    const applyPublicUrlToRoom = async (publicUrl, track) => {
        const url = String(publicUrl || '').trim();
        if (!/^https:\/\//i.test(url)) {
            return { ok: false, reason: 'no-public-url', detail: 'Icecast HTTPS public URL is not configured.' };
        }
        console.log(`[music] applying live Icecast URL to room ${roomId}: ${url}`);
        const applied = await applyRoomMediaStreamUrl(page, url, {
            sessionClient,
            roomId,
            stationName: String(track?.title || '').trim(),
        });
        if (!applied.ok) return applied;
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

    const playCurrentOrNext = async () => {
        const gen = ++generation;
        clearEndTimer();
        killFf();

        let track = queue.getCurrent();
        if (!track) {
            track = queue.dequeue();
            if (track) queue.setCurrent(track);
        }
        if (!track) {
            const filled = await maybeEnqueueAutoplayTrack();
            if (filled) {
                track = queue.dequeue();
                if (track) queue.setCurrent(track);
            }
        }
        if (!track) {
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
            if (fresh?.streamUrl) Object.assign(track, fresh);
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
            // Keep filling if autoplay is armed (bad mount / download on one pick).
            if (autoplayArmed && gen === generation) {
                return playCurrentOrNext();
            }
            return applied;
        }
        if (track?.autoplay) {
            const label = [track.title, track.artistName].filter(Boolean).join(' — ');
            announce(`Now playing: ${label || track.title || 'Track'}`);
        }
        return { ok: true, track };
    };

    const enqueueDrain = () => {
        const run = async () => {
            try {
                if (paused) return;
                if (queue.getCurrent() && playing && ffProc) return;
                await playCurrentOrNext();
            } catch (e) {
                console.warn(`[music] drain error (${roomId}):`, e?.message || e);
                scheduleAutoplayRetry();
            }
        };
        const next = drainTail.then(run, run);
        drainTail = next.catch(() => {});
        return next;
    };

    return {
        getQueue: () => queue,
        isPlaying: () => playing && !paused && ffProc != null,
        isPaused: () => paused,
        hasActive: () =>
            playing || paused || ffProc != null || queue.getCurrent() != null || queue.peek() != null,
        isAutoplayArmed: () => autoplayArmed,
        armAutoplay: (reason) => armAutoplay(reason || 'manual'),
        disarmAutoplay,
        /** After cut/pending lookup failure — drain queue or start idle autoplay if armed. */
        ensurePlaying: () => enqueueDrain(),

        /**
         * Stop current encode + radio immediately (keeps nothing queued).
         * Call at the start of !play so the old song cuts while the new one is looked up.
         * Does not disarm autoplay — a following !play keeps the idle loop.
         */
        cutForReplace,

        /** Replace whatever is playing/queued with this track and start it now. */
        async playNow(track) {
            armAutoplay('!play');
            clearEndTimer();
            generation += 1;
            killFf();
            queue.clearPending();
            queue.setCurrent(track);
            playing = false;
            paused = false;
            // Do not stopRoomRadio here — cutForReplace already stopped it for !play,
            // and setRoomRadioStreamUrl does stop→clear→update→start when the mount is live.
            // A second fire-and-forget stop raced the URL set and could swallow it.
            console.log(`[music] !play replace — starting “${track?.title || '?'}”`);
            return playCurrentOrNext();
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
