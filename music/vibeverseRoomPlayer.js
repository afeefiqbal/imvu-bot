import { createTrackQueue } from './queue.js';
import { applyRoomMediaStreamUrl, waitForRoomMediaPlayback } from './imvuRoomMediaDom.js';
import { notifyImvuMusicState } from './notifyImvuMusicApi.js';
import { playVibeverseTrack, refreshVibeverseStream } from './vibeverseClient.js';
import { createFfmpegHttpToIcecast } from './ffmpegIcecast.js';
import { loadStreamConfig, withPerPlayStreamMount } from './loadStreamConfig.js';
import { withIcecastMountEncodeLock } from './icecastMountLock.js';
import {
    icecastDestFromConfig,
    icecastStatusJsonShowsSource,
    waitForIcecastMountLive,
} from './icecastLive.js';

/**
 * Hybrid room player: VibeVerse search/stream URL → ffmpeg → Icecast live mount → IMVU radio.
 * Late joiners hear the current live point (not a progressive file from t=0).
 *
 * @param {{
 *   roomId: string,
 *   apiBaseUrl: string,
 *   botName?: string,
 *   page?: object | null,
 *   sessionClient?: object | null,
 * }} opts
 */
export function createVibeverseRoomPlayer(opts) {
    const { roomId, apiBaseUrl, botName, page, sessionClient } = opts;
    const queue = createTrackQueue();

    let playing = false;
    let paused = false;
    /** @type {import('child_process').ChildProcess | null} */
    let ffProc = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let endTimer = null;
    /** @type {Promise<void>} */
    let drainTail = Promise.resolve();
    let generation = 0;
    /** @type {object | null} */
    let activeStreamCfg = null;

    const clearEndTimer = () => {
        if (endTimer) {
            clearTimeout(endTimer);
            endTimer = null;
        }
    };

    const killFf = () => {
        if (!ffProc) return;
        try {
            ffProc.kill('SIGKILL');
        } catch {}
        ffProc = null;
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
        await waitForRoomMediaPlayback(page, {
            roomId,
            expectedUrl: url,
            timeoutMs: 12_000,
            intervalMs: 1500,
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
            if (fresh) Object.assign(track, fresh);
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
            `[music] live encode: source → Icecast ${mountPath} → ${pub.slice(0, 120)}`,
        );

        /** @type {{ ok: boolean, reason?: string, detail?: string }} */
        let applied = { ok: false, reason: 'encode-failed' };

        // Serialize connect to this mount; return to chat as soon as the live URL is pushed
        // (do not wait for the whole track — ffmpeg keeps running in the background).
        await withIcecastMountEncodeLock(mountLockKey, async () => {
            if (isStale()) return;

            let proc;
            try {
                ({ proc } = createFfmpegHttpToIcecast({
                    sourceUrl: track.streamUrl,
                    icecastDestUrl: iceDest,
                }));
            } catch (e) {
                console.error('[music] ffmpeg http→icecast failed:', e?.message || e);
                applied = { ok: false, reason: 'ffmpeg-spawn', detail: e?.message || 'ffmpeg failed' };
                return;
            }
            if (isStale()) {
                try {
                    proc.kill('SIGKILL');
                } catch {}
                return;
            }
            ffProc = proc;

            setTimeout(async () => {
                if (isStale()) return;
                const up = await icecastStatusJsonShowsSource(loopHost, icePort, mountPath);
                if (isStale()) return;
                if (!up) {
                    console.warn(
                        `[music] Icecast has no SOURCE on ${mountPath} at ${loopHost}:${icePort} ~12s after start.`,
                    );
                } else {
                    console.log(`[music] Icecast confirms source on ${mountPath} (${loopHost}:${icePort}).`);
                }
            }, 12000);

            const waitMs = Math.max(
                8000,
                parseInt(String(process.env.MUSIC_CHAT_WAIT_MOUNT_MS || '25000'), 10) || 25000,
            );
            const live = await waitForIcecastMountLive(activeStreamCfg, waitMs, { isStale });
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
        isPlaying: () => playing && !paused && ffProc != null,
        isPaused: () => paused,
        hasActive: () =>
            playing || paused || ffProc != null || queue.getCurrent() != null || queue.peek() != null,

        /**
         * Stop current encode + radio immediately (keeps nothing queued).
         * Call at the start of !play so the old song cuts while the new one is looked up.
         */
        cutForReplace,

        /** Replace whatever is playing/queued with this track and start it now. */
        async playNow(track) {
            clearEndTimer();
            generation += 1;
            killFf();
            queue.clearPending();
            queue.setCurrent(track);
            playing = false;
            paused = false;
            stopRoomRadioQuiet();
            console.log(`[music] !play replace — starting “${track?.title || '?'}”`);
            return playCurrentOrNext();
        },

        async enqueue(track) {
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
