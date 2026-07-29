import { createTrackQueue } from './queue.js';
import { createFfmpegIcecastPipe } from './ffmpegIcecast.js';
import { notifyImvuMusicState } from './notifyImvuMusicApi.js';
import { applyRoomMediaStreamUrl } from './imvuRoomMediaDom.js';
import { spawnYtDlpAudioStdout } from './ytDlpAudioStdout.js';
import { clearYtDlpProxyCache, ensureYtDlpProxy } from './ytDlpArgs.js';
import { cacheBustHttpsStreamUrl, withPerPlayStreamMount } from './loadStreamConfig.js';
import { canonicalYoutubeWatchUrl } from './resolvePlay.js';
import { withIcecastMountEncodeLock } from './icecastMountLock.js';
import { withYtEncodeGate } from './ytEncodeGate.js';
import { loadAutoplayTracksFromEnv } from './autoplayPlaylist.js';
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
 * @param {string} trackUrl
 * @param {() => boolean} isStale
 * @param {(proc: import('child_process').ChildProcess) => void} [onSpawn]
 * @returns {Promise<{ audioIn: import('stream').Readable, decoder: string, ytdlpProc: import('child_process').ChildProcess }>}
 */
async function openYoutubeAudioStreamOnce(trackUrl, isStale, onSpawn) {
    const { proc: yp, stdout } = spawnYtDlpAudioStdout(trackUrl);
    onSpawn?.(yp);
    if (isStale()) {
        try {
            yp.kill('SIGKILL');
        } catch {}
        try {
            stdout.destroy?.();
        } catch {}
        throw new Error('play replaced');
    }
    // Wait until yt-dlp has audio ready (readable) without consuming bytes — keeps the
    // process-wide encode gate held until this download is actually flowing.
    const readyMs = Math.max(
        5000,
        parseInt(String(process.env.MUSIC_YT_READY_MS || '90000'), 10) || 90000,
    );
    try {
        await new Promise((resolve, reject) => {
            let settled = false;
            const finish = (err) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try {
                    stdout.off('readable', onReadable);
                } catch {}
                try {
                    yp.off('error', onErr);
                } catch {}
                try {
                    yp.off('exit', onExit);
                } catch {}
                if (err) reject(err);
                else resolve();
            };
            const onReadable = () => finish();
            const onErr = (e) => finish(e || new Error('yt-dlp error'));
            const onExit = (code) => {
                if (!settled && code !== 0 && code != null) {
                    finish(new Error(`yt-dlp exited before audio (code=${code})`));
                }
            };
            const timer = setTimeout(() => finish(new Error('yt-dlp audio ready timeout')), readyMs);
            if (isStale()) {
                finish(new Error('play replaced'));
                return;
            }
            stdout.once('readable', onReadable);
            yp.once('error', onErr);
            yp.once('exit', onExit);
            // Already buffered?
            if (stdout.readableLength > 0) finish();
        });
    } catch (e) {
        try {
            yp.kill('SIGKILL');
        } catch {}
        try {
            stdout.destroy?.();
        } catch {}
        throw e;
    }
    if (isStale()) {
        try {
            yp.kill('SIGKILL');
        } catch {}
        try {
            stdout.destroy?.();
        } catch {}
        throw new Error('play replaced');
    }
    return { audioIn: stdout, decoder: 'yt-dlp', ytdlpProc: yp };
}

/**
 * @param {string} trackUrl
 * @param {() => boolean} isStale
 * @param {(proc: import('child_process').ChildProcess) => void} [onSpawn]
 * @returns {Promise<{ audioIn: import('stream').Readable, decoder: string, ytdlpProc: import('child_process').ChildProcess }>}
 */
async function openYoutubeAudioStream(trackUrl, isStale, onSpawn) {
    await ensureYtDlpProxy();
    try {
        return await openYoutubeAudioStreamOnce(trackUrl, isStale, onSpawn);
    } catch (e) {
        const msg = String(e?.message || e);
        if (isStale() || msg === 'play replaced') throw e;
        const retryable = /youtube-bot-block|exited before audio|audio ready timeout|yt-dlp error/i.test(
            msg,
        );
        if (!retryable) throw e;
        console.warn('[music] yt-dlp stream failed — rotating Webshare/proxy and retrying once');
        clearYtDlpProxyCache();
        await ensureYtDlpProxy();
        return await openYoutubeAudioStreamOnce(trackUrl, isStale, onSpawn);
    }
}

/** Logs: prefer HTTPS stream URL only when set (matches chat — no localhost in shared output). */
function logPlaybackUrls(next, cfg) {
    const mount = cfg.icecastMount.startsWith('/') ? cfg.icecastMount : `/${cfg.icecastMount}`;
    const listenLocal = `http://${cfg.icecastHost}:${cfg.icecastPort}${mount}`;
    const pub = String(cfg.publicStreamUrl || '').trim();
    const hasHttps = /^https:\/\//i.test(pub);
    console.log('[music] ─── playback URLs ───');
    console.log(`[music] Track: ${next.title}`);
    console.log(`[music] YouTube watch URL: ${next.url}`);
    console.log(
        `[music] Icecast SOURCE (FFmpeg connects here — status UI must be SAME host:port): http://${cfg.icecastHost}:${cfg.icecastPort}/`,
    );
    console.log(`[music] Icecast mount: ${mount}`);
    if (hasHttps) {
        console.log(`[music] Stream (HTTPS): ${pub}`);
        console.log('[music] FFmpeg → Icecast (password hidden in logs).');
    } else {
        console.log(`[music] Listen (Icecast LAN): ${listenLocal}`);
        console.log(
            `[music] FFmpeg publishes to Icecast as: icecast://source:***@${cfg.icecastHost}:${cfg.icecastPort}${mount}`,
        );
        console.log('[music] HTTPS: set MUSIC_PUBLIC_STREAM_URL_TEMPLATE or NGROK_TUNNEL_AUTO=1.');
    }
    console.log('[music] ─────────────────────');
}

/**
 * @param {{
 *   roomId: string,
 *   apiBaseUrl: string,
 *   botName?: string,
 *   page: { isClosed?: () => boolean } | null,
 *   sessionClient?: { setRoomRadioStreamUrl?: Function } | null,
 *   loadConfig: () => Promise<object | null>,
 * }} opts
 */
export function createRoomPlayer(opts) {
    const { roomId, apiBaseUrl, botName, page, sessionClient, loadConfig } = opts;
    const queue = createTrackQueue();
    /** @type {{ title: string, url: string }[]} */
    let autoplayTracks = [];
    /** @type {Promise<void> | null} */
    let autoplayLoadPromise = null;
    /** Next index into autoplayTracks for idle playback (0-based). */
    let nextAutoplayIndex = 0;
    /**
     * Idle playlist only after user music activity (!play/!add/…) or MUSIC_AUTOPLAY_ON_JOIN.
     * Prevents every joined room from starting yt-dlp at once when the bot boots.
     */
    let autoplayArmed = false;

    const armAutoplay = (reason) => {
        if (!roomAllowedForAutoplay(roomId)) return false;
        if (!autoplayArmed) {
            autoplayArmed = true;
            if (reason) {
                console.log(`[music] autoplay armed (${roomId}): ${reason}`);
            }
        }
        return true;
    };

    /** When commandHandler already synced room media for this track, skip the delayed player push. */
    let skipMountDomPush = false;
    /** Survives playOne start — commandHandler often claims sync before drain begins. */
    let skipMountDomPushForNextPlay = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let domPushTimer = null;

    const notifyRoomMediaSynced = () => {
        skipMountDomPush = true;
        skipMountDomPushForNextPlay = true;
        if (domPushTimer) {
            clearTimeout(domPushTimer);
            domPushTimer = null;
        }
    };

    const bumpAutoplayAfterTrack = (t) => {
        if (t && typeof t.autoplaySlot === 'number' && autoplayTracks.length > 0) {
            nextAutoplayIndex = (t.autoplaySlot + 1) % autoplayTracks.length;
        }
    };

    const ensureAutoplayTracksLoaded = async () => {
        if (autoplayTracks.length > 0) return;
        if (!autoplayLoadPromise) {
            autoplayLoadPromise = loadAutoplayTracksFromEnv()
                .then((rows) => {
                    autoplayTracks = Array.isArray(rows) ? rows.filter((r) => r?.url) : [];
                    if (autoplayTracks.length) {
                        console.log(
                            `[music] autoplay: idle rotation ready (${autoplayTracks.length} track(s) from .env only — users cannot edit this list)`,
                        );
                    }
                })
                .catch(() => {
                    autoplayTracks = [];
                })
                .then(() => {});
        }
        await autoplayLoadPromise;
    };

    /** @type {import('child_process').ChildProcess | null} */
    let ffProc = null;
    /** @type {import('child_process').ChildProcess | null} */
    let ytdlpProc = null;
    /** yt-dlp started in openYoutubeAudioStream before playOne assigns ytdlpProc */
    /** @type {import('child_process').ChildProcess | null} */
    let setupYtdlpProc = null;
    let drainLock = false;
    /** Bumped on every playNow — in-flight playOne aborts when this changes. */
    let playEpoch = 0;
    let stopFlag = false;
    /** When true, drain loop will not start the next track (after !pause). */
    let paused = false;
    /** Track that was playing when paused — resumed from the start (live stream has no mid-song seek). */
    /** @type {{ title: string, url: string } | null} */
    let pausedTrack = null;
    /** @type {Awaited<ReturnType<typeof loadConfig>> | null} */
    let cachedConfig = null;
    /** @type {ReturnType<typeof withPerPlayStreamMount> | null} */
    let activeStreamCfg = null;

    /** When the queue is empty, enqueue the next autoplay slot if configured. */
    const maybeEnqueueAutoplayTrack = async () => {
        if (queue.peek()) return;
        if (stopFlag || paused) return;
        // Master off switch (default on when playlist URL is set). Set MUSIC_AUTOPLAY=0 to disable.
        if (!envFlagTrue('MUSIC_AUTOPLAY', true)) return;
        if (!autoplayArmed) return;
        if (!roomAllowedForAutoplay(roomId)) return;
        const cfg = await loadConfig();
        if (!cfg?.enabled) return;
        await ensureAutoplayTracksLoaded();
        if (!autoplayTracks.length) return;
        const slot = nextAutoplayIndex % autoplayTracks.length;
        const row = autoplayTracks[slot];
        queue.enqueue({
            title: row.title || 'Track',
            url: row.url,
            autoplaySlot: slot,
        });
    };

    const killFf = () => {
        if (domPushTimer) {
            clearTimeout(domPushTimer);
            domPushTimer = null;
        }
        if (setupYtdlpProc) {
            try {
                setupYtdlpProc.kill('SIGKILL');
            } catch {}
            setupYtdlpProc = null;
        }
        if (ytdlpProc) {
            try {
                ytdlpProc.kill('SIGKILL');
            } catch {}
            ytdlpProc = null;
        }
        if (!ffProc) return;
        try {
            ffProc.kill('SIGKILL');
        } catch {}
        ffProc = null;
    };

    /** @param {number} committedEpoch @param {import('stream').Readable | null} [audioIn] */
    const abortIfStale = (committedEpoch, audioIn = null) => {
        if (playEpoch === committedEpoch) return false;
        try {
            audioIn?.destroy?.();
        } catch {}
        killFf();
        queue.setCurrent(null);
        return true;
    };

    const pushDomUrl = async (cfg) => {
        if (!cfg?.publicStreamUrl) return;
        const cur = queue.getCurrent();
        const url = cfg?.perPlayMount
            ? String(cfg.publicStreamUrl)
            : cacheBustHttpsStreamUrl(cfg.publicStreamUrl);
        await applyRoomMediaStreamUrl(page, url, {
            sessionClient,
            roomId,
            stationName: String(cur?.title || '').trim(),
        });
    };

    const playOne = async () => {
        // Honor commandHandler claim from before drain started (do not wipe skipMountDomPush).
        if (skipMountDomPushForNextPlay) {
            skipMountDomPush = true;
            skipMountDomPushForNextPlay = false;
        } else {
            skipMountDomPush = false;
        }
        const baseCfg = cachedConfig || (await loadConfig());
        cachedConfig = baseCfg;
        if (!baseCfg?.enabled) return;
        // Prefer mount prepared by !play; otherwise mint a fresh one (skip / queue advance).
        if (activeStreamCfg?.perPlayMount && activeStreamCfg.consumeOnPlay) {
            activeStreamCfg.consumeOnPlay = false;
        } else {
            activeStreamCfg = withPerPlayStreamMount(baseCfg, roomId, Date.now());
        }
        const cfg = activeStreamCfg;

        let next = queue.dequeue();
        if (!next) {
            queue.setCurrent(null);
            void notifyImvuMusicState({
                apiBaseUrl,
                roomId,
                botName,
                track: null,
                state: 'idle',
            });
            return;
        }

        const committedEpoch = playEpoch;

        const track = {
            ...next,
            url: canonicalYoutubeWatchUrl(next.url),
        };
        queue.setCurrent(track);
        void notifyImvuMusicState({
            apiBaseUrl,
            roomId,
            botName,
            track: { title: track.title, url: track.url },
            state: 'playing',
        });

        logPlaybackUrls(track, cfg);

        /** @type {import('stream').Readable | null} */
        let audioIn = null;
        try {
            // One yt-dlp spawn at a time — concurrent downloads from OCI starve each other.
            const opened = await withYtEncodeGate(() =>
                openYoutubeAudioStream(
                    track.url,
                    () => playEpoch !== committedEpoch,
                    (proc) => {
                        setupYtdlpProc = proc;
                    },
                ),
            );
            setupYtdlpProc = null;
            if (abortIfStale(committedEpoch)) return;
            audioIn = opened.audioIn;
            ytdlpProc = opened.ytdlpProc;
            console.log(`[music] decoder: ${opened.decoder} → FFmpeg → Icecast`);
        } catch (e) {
            if (String(e?.message || e) === 'play replaced' || abortIfStale(committedEpoch)) return;
            console.error('[music] audio stream setup failed:', e?.message || e);
            bumpAutoplayAfterTrack(track);
            queue.setCurrent(null);
            return;
        }

        if (abortIfStale(committedEpoch, audioIn)) return;

        if (paused) {
            try {
                audioIn?.destroy?.();
            } catch {}
            if (ytdlpProc) {
                try {
                    ytdlpProc.kill('SIGKILL');
                } catch {}
                ytdlpProc = null;
            }
            queue.setCurrent(null);
            return;
        }

        const iceDest = icecastDestFromConfig(cfg);
        const loopHost = cfg.icecastHost === '0.0.0.0' ? '127.0.0.1' : String(cfg.icecastHost || '127.0.0.1');
        const icePort = Number(cfg.icecastPort) || 8001;
        const mountPath = cfg.icecastMount.startsWith('/') ? cfg.icecastMount : `/${cfg.icecastMount}`;
        const mountLockKey = `${loopHost}:${icePort}${mountPath}`;

        await withIcecastMountEncodeLock(mountLockKey, async () => {
            const { proc, stdin } = createFfmpegIcecastPipe({
                icecastDestUrl: iceDest,
            });
            ffProc = proc;
            audioIn.on('error', () => {});
            stdin.on('error', (e) => {
                console.warn('[music] FFmpeg stdin:', e?.message || e);
            });

            try {
                audioIn.pipe(stdin);
            } catch (e) {
                console.error('[music] pipe:', e.message);
                killFf();
                queue.setCurrent(null);
                return;
            }

            setTimeout(async () => {
                const up = await icecastStatusJsonShowsSource(loopHost, icePort, mountPath);
                if (!up) {
                    console.warn(
                        `[music] Icecast has no SOURCE on ${mountPath} at ${loopHost}:${icePort} ~12s after start — ` +
                            'nothing is registered on that mount (listeners/ngrok get 404). ' +
                            'Often yt-dlp/YouTube bot-block (refresh YTDLP_COOKIES_FILE). Also compare ICECAST_SOURCE_PASSWORD with icecast.xml.',
                    );
                } else {
                    console.log(`[music] Icecast confirms source on ${mountPath} (${loopHost}:${icePort}).`);
                }
            }, 12000);

            // Never push the room radio URL on a fixed delay — that was the first-play 404 / RADIO STREAM ERROR.
            // Wait until Icecast actually has a SOURCE (or commandHandler already synced and set skipMountDomPush).
            const waitMs = Math.max(
                8000,
                parseInt(String(process.env.MUSIC_CHAT_WAIT_MOUNT_MS || '25000'), 10) || 25000,
            );
            const initialDelay = Math.max(
                500,
                parseInt(String(process.env.MUSIC_DOM_STREAM_DELAY_MS || '2500'), 10) || 2500,
            );
            domPushTimer = setTimeout(() => {
                domPushTimer = null;
                void (async () => {
                    if (skipMountDomPush || playEpoch !== committedEpoch) return;
                    const live = await waitForIcecastMountLive(cfg, waitMs);
                    if (skipMountDomPush || playEpoch !== committedEpoch) return;
                    if (!live || !ffProc) {
                        console.warn(
                            '[music] Mount never went live — not pushing room radio URL (avoids IMVU caching 404).',
                        );
                        return;
                    }
                    await pushDomUrl(cfg);
                    console.log('[music] Mount live — room radio URL pushed / HTTPS stream ready.');
                })();
            }, initialDelay);

            await new Promise((resolve) => {
                proc.once('exit', (code, sig) => {
                    console.log(
                        `[music] FFmpeg ended (code=${code}, signal=${sig || 'none'}) — Icecast drops this mount; listeners see 404 until the next !play.`,
                    );
                    resolve();
                });
            });
            killFf();
        });
        if (abortIfStale(committedEpoch, audioIn)) return;
        bumpAutoplayAfterTrack(track);
        queue.setCurrent(null);
    };

    const ensureDrain = async () => {
        if (drainLock || ffProc) return;
        drainLock = true;
        try {
            while (!stopFlag && !paused) {
                await maybeEnqueueAutoplayTrack();
                if (!queue.peek()) break;
                try {
                    await playOne();
                } catch (e) {
                    console.error('[music] playOne failed:', e?.message || e);
                    queue.setCurrent(null);
                    killFf();
                }
            }
        } finally {
            drainLock = false;
        }
    };

    const prepareStreamForNextTrack = async () => {
        const baseCfg = cachedConfig || (await loadConfig());
        cachedConfig = baseCfg;
        if (!baseCfg?.enabled) return null;
        activeStreamCfg = withPerPlayStreamMount(baseCfg, roomId, Date.now());
        // playOne consumes this once so !play sync + encode share the same mount.
        activeStreamCfg.consumeOnPlay = true;
        return activeStreamCfg;
    };

    const playNow = (track) => {
        playEpoch += 1;
        const epoch = playEpoch;
        stopFlag = false;
        paused = false;
        pausedTrack = null;
        armAutoplay('!play');
        queue.clearAll();
        queue.enqueue(track);
        killFf();
        void (async () => {
            const gap = Math.max(
                0,
                parseInt(String(process.env.MUSIC_ICECAST_RECONNECT_MS || '1000'), 10) || 1000
            );
            if (gap > 0) await new Promise((r) => setTimeout(r, gap));
            void ensureDrain();
        })();
        return epoch;
    };

    return {
        /** @returns {Promise<void>} */
        refreshConfig: async () => {
            cachedConfig = await loadConfig();
        },

        /** Config for the current/last started track (unique mount when MUSIC_PER_PLAY_MOUNT=1). */
        getActiveStreamConfig: () => activeStreamCfg || cachedConfig,

        prepareStreamForNextTrack,

        enqueue: (track) => {
            // Real queue: never steal the current encode (!add while playing).
            stopFlag = false;
            paused = false;
            armAutoplay('!add');
            queue.enqueue(track);
            void ensureDrain();
        },

        /** Drop the queue, stop the current encode, and play this track immediately. */
        playNow,

        /** Skip current song; play next in queue if any. */
        skip: () => {
            paused = false;
            pausedTrack = null;
            playEpoch += 1;
            armAutoplay('!skip');
            killFf();
            void (async () => {
                const gap = Math.max(
                    0,
                    parseInt(String(process.env.MUSIC_ICECAST_RECONNECT_MS || '1000'), 10) || 1000
                );
                if (gap > 0) await new Promise((r) => setTimeout(r, gap));
                void ensureDrain();
            })();
        },

        /** Stop encoding; keep queue + current song for !resume (restarts current from beginning). */
        pause: () => {
            paused = true;
            const cur = queue.getCurrent();
            pausedTrack = cur
                ? {
                      title: cur.title,
                      url: cur.url,
                      ...(typeof cur.autoplaySlot === 'number' ? { autoplaySlot: cur.autoplaySlot } : {}),
                  }
                : null;
            killFf();
            void notifyImvuMusicState({
                apiBaseUrl,
                roomId,
                botName,
                track: pausedTrack ? { title: pausedTrack.title, url: pausedTrack.url } : null,
                state: 'paused',
            });
        },

        /** Continue after !pause (current track from start, then any queued tracks). */
        resume: () => {
            if (!paused) return;
            paused = false;
            armAutoplay('!resume');
            const rest = queue.pending();
            queue.clearPending();
            if (pausedTrack) {
                queue.enqueue(pausedTrack);
                pausedTrack = null;
            }
            for (const t of rest) {
                queue.enqueue(t);
            }
            const next = queue.peek();
            void notifyImvuMusicState({
                apiBaseUrl,
                roomId,
                botName,
                track: next ? { title: next.title, url: next.url } : null,
                state: next ? 'playing' : 'idle',
            });
            void ensureDrain();
        },

        isPaused: () => paused,

        stop: () => {
            stopFlag = true;
            paused = false;
            pausedTrack = null;
            killFf();
            queue.clearAll();
            void notifyImvuMusicState({
                apiBaseUrl,
                roomId,
                botName,
                track: null,
                state: 'stopped',
            });
            // Resume idle playlist only in rooms that already used music (armed).
            const afterStop = envFlagTrue('MUSIC_AUTOPLAY_AFTER_STOP', true);
            if (afterStop && autoplayArmed && roomAllowedForAutoplay(roomId)) {
                const delay = Math.max(
                    500,
                    parseInt(String(process.env.MUSIC_AUTOPLAY_AFTER_STOP_MS || '2500'), 10) || 2500,
                );
                setTimeout(() => {
                    if (!stopFlag) return;
                    stopFlag = false;
                    void ensureDrain();
                }, delay);
            }
        },

        /**
         * Start idle autoplay / drain. Default: no-op until a user !play/!add arms this room
         * (avoids every joined room encoding the playlist at boot). Set MUSIC_AUTOPLAY_ON_JOIN=1
         * to restore old “autoplay as soon as the room mounts” behavior.
         */
        kickAutoplayDrain: () => {
            if (envFlagTrue('MUSIC_AUTOPLAY_ON_JOIN', false)) {
                if (armAutoplay('on join')) void ensureDrain();
                return;
            }
            // Do not start encoding just because the bot entered the room.
        },

        armAutoplay: () => armAutoplay('manual'),

        /** @returns {ReturnType<createTrackQueue>} */
        getQueue: () => queue,

        isPlaying: () => ffProc != null,

        /** Current play generation — bumps on !play / !skip. */
        getPlayEpoch: () => playEpoch,

        /**
         * True after !stop, or when a newer !play/!skip replaced the sync that captured `epoch`.
         * @param {number} epoch
         */
        isSyncSuperseded: (epoch) => stopFlag || playEpoch !== Number(epoch),

        /**
         * After enqueue, wait until Icecast serves this mount (source connected).
         * Also requires FFmpeg still running — dead encode + stale probe used to claim "live".
         * @param {NonNullable<Awaited<ReturnType<typeof loadConfig>>>} cfg
         * @param {number} [timeoutMs]
         * @returns {Promise<boolean>}
         */
        waitForMountLive: async (cfg, timeoutMs) => {
            const ok = await waitForIcecastMountLive(cfg, timeoutMs);
            if (!ok) return false;
            if (!ffProc) {
                console.warn(
                    '[music] Icecast probe looked ready but FFmpeg already exited — not treating mount as live.',
                );
                return false;
            }
            return true;
        },

        /** Skip the delayed mount-time room media push (commandHandler already synced). */
        notifyRoomMediaSynced,
    };
}
