import http from 'http';
import { createTrackQueue } from './queue.js';
import { createFfmpegIcecastPipe } from './ffmpegIcecast.js';
import { notifyImvuMusicState } from './notifyImvuMusicApi.js';
import { applyRoomMediaStreamUrl } from './imvuRoomMediaDom.js';
import { spawnYtDlpAudioStdout } from './ytDlpAudioStdout.js';
import { cacheBustHttpsStreamUrl, withPerPlayStreamMount } from './loadStreamConfig.js';
import { icecastConnectFamily } from './resolvedIcecastHost.js';
import { canonicalYoutubeWatchUrl } from './resolvePlay.js';
import { withIcecastMountEncodeLock } from './icecastMountLock.js';
import { loadAutoplayTracksFromEnv } from './autoplayPlaylist.js';
import { probePublicStreamForImvu, isImvuBlockingStreamProbe } from './verifyImvuStreamUrl.js';

/**
 * @param {string} trackUrl
 * @param {() => boolean} isStale
 * @param {(proc: import('child_process').ChildProcess) => void} [onSpawn]
 * @returns {Promise<{ audioIn: import('stream').Readable, decoder: string, ytdlpProc: import('child_process').ChildProcess }>}
 */
async function openYoutubeAudioStream(trackUrl, isStale, onSpawn) {
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
    return { audioIn: stdout, decoder: 'yt-dlp', ytdlpProc: yp };
}

/** @returns {Promise<number>} HTTP status (0 on failure). */
function httpGetStatus(host, port, path) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (code) => {
            if (settled) return;
            settled = true;
            resolve(code);
        };
        const req = http.request(
            {
                hostname: host,
                port: Number(port),
                family: icecastConnectFamily(host),
                path: path.startsWith('/') ? path : `/${path}`,
                method: 'GET',
                timeout: 4000,
            },
            (res) => {
                const code = res.statusCode || 0;
                // Streaming mounts never "end"; status headers are enough.
                try {
                    res.destroy();
                } catch {}
                finish(code);
            },
        );
        req.on('error', () => finish(0));
        req.on('timeout', () => {
            try {
                req.destroy();
            } catch {}
            finish(0);
        });
        req.end();
    });
}

/**
 * Icecast status-json: true when a *source* is connected on this mount (GET on .mp3 can stay 404 in some setups).
 * @param {string} loopHost
 * @param {number} port
 * @param {string} mount
 * @returns {Promise<boolean>}
 */
async function icecastStatusJsonShowsSource(loopHost, port, mount) {
    return new Promise((resolve) => {
        const path = '/status-json.xsl';
        const req = http.request(
            {
                hostname: loopHost,
                port: Number(port),
                family: icecastConnectFamily(loopHost),
                path,
                method: 'GET',
                timeout: 3200,
            },
            (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (c) => {
                    body += c;
                    if (body.length > 2_000_000) {
                        try {
                            res.destroy();
                        } catch {}
                    }
                });
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        resolve(false);
                        return;
                    }
                    try {
                        const data = JSON.parse(body);
                        const raw = data?.icestats?.source;
                        if (raw == null) {
                            resolve(false);
                            return;
                        }
                        const sources = Array.isArray(raw) ? raw : [raw];
                        const want = mount.startsWith('/') ? mount : `/${mount}`;
                        const pathOk = (p) => {
                            const x = String(p || '').trim();
                            if (!x.startsWith('/')) return false;
                            return x === want || x.split('?')[0] === want;
                        };
                        const ok = sources.some((s) => {
                            const lu = String(s.listenurl || '').trim();
                            if (lu) {
                                try {
                                    if (pathOk(new URL(lu).pathname)) return true;
                                } catch {
                                    /* non-URL listenurl */
                                }
                            }
                            const mp = String(s.mountpoint || s.mount || '').trim();
                            if (mp && pathOk(mp.startsWith('/') ? mp : `/${mp}`)) return true;
                            return false;
                        });
                        resolve(ok);
                    } catch {
                        resolve(false);
                    }
                });
            },
        );
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            try {
                req.destroy();
            } catch {}
            resolve(false);
        });
        req.end();
    });
}


/**
 * After local Icecast shows a source, check public HTTPS URL is reachable AND IMVU-compatible.
 * Bot-only ngrok bypass header is not enough — IMVU's audio element cannot send it.
 * @param {string} pubUrl
 * @param {number} timeoutMs
 */
async function waitForPublicHttpsStream(pubUrl, timeoutMs) {
    const deadline = Date.now() + Math.max(2000, timeoutMs);
    let warnedNgrok = false;
    while (Date.now() < deadline) {
        const imvu = await probePublicStreamForImvu(pubUrl, 4500);
        if (imvu.ok && imvu.reason !== 'mount-empty') return true;
        if (isImvuBlockingStreamProbe(imvu, pubUrl)) {
            if (!warnedNgrok) {
                warnedNgrok = true;
                console.error(
                    '[music] Public stream URL blocked for IMVU browser clients (ngrok interstitial). URL:',
                    String(pubUrl).slice(0, 120),
                );
            }
            return false;
        }
        await new Promise((r) => setTimeout(r, 900));
    }
    return false;
}

/**
 * Poll until FFmpeg has connected as a source (status-json) and/or mount GET returns 200.
 * If publicStreamUrl is HTTPS, also wait until that URL returns 200 (tunnel must point at same Icecast port).
 */
async function waitForIcecastMountLive(cfg, timeoutMs) {
    if (!cfg?.enabled) return false;
    const loopHost = cfg.icecastHost === '0.0.0.0' ? '127.0.0.1' : String(cfg.icecastHost || '127.0.0.1');
    const mount = cfg.icecastMount.startsWith('/') ? cfg.icecastMount : `/${cfg.icecastMount}`;
    const port = Number(cfg.icecastPort) || 8001;
    const deadline = Date.now() + Math.max(3000, timeoutMs);
    let lastGet = 0;
    while (Date.now() < deadline) {
        const fromJson = await icecastStatusJsonShowsSource(loopHost, port, mount);
        lastGet = await httpGetStatus(loopHost, port, mount);
        if (fromJson || lastGet === 200) {
            const pub = String(cfg.publicStreamUrl || '').trim();
            if (/^https:\/\//i.test(pub)) {
                const httpsOk = await waitForPublicHttpsStream(pub, 22000);
                if (!httpsOk) {
                    console.warn(
                        '[music] Icecast source is up locally, but HTTPS stream URL still not returning audio. ' +
                            'Tunnel may still be warming up after a track change — retry !play in a few seconds. URL:',
                        pub.slice(0, 120),
                    );
                    return false;
                }
            }
            return true;
        }
        await new Promise((r) => setTimeout(r, 450));
    }
    console.warn(
        `[music] Timed out waiting for Icecast source on http://${loopHost}:${port}${mount} (last GET ${lastGet}).`,
    );
    return false;
}

function icecastDestFromConfig(cfg) {
    const u = encodeURIComponent(cfg.sourceUser);
    const p = encodeURIComponent(cfg.sourcePassword);
    const mount = cfg.icecastMount.startsWith('/') ? cfg.icecastMount : `/${cfg.icecastMount}`;
    const host = cfg.icecastHost === '0.0.0.0' ? '127.0.0.1' : String(cfg.icecastHost || '127.0.0.1');
    return `icecast://${u}:${p}@${host}:${cfg.icecastPort}${mount}`;
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

    /** When commandHandler already synced room media for this track, skip the delayed player push. */
    let skipMountDomPush = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let domPushTimer = null;

    const notifyRoomMediaSynced = () => {
        skipMountDomPush = true;
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
        skipMountDomPush = false;
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
            const opened = await openYoutubeAudioStream(
                track.url,
                () => playEpoch !== committedEpoch,
                (proc) => {
                    setupYtdlpProc = proc;
                },
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
                            'Compare ICECAST_SOURCE_USER / ICECAST_SOURCE_PASSWORD in .env with icecast.xml <source-password>, ' +
                            'and ICECAST_PORT (Docker host is usually 8001). Watch [music] ffmpeg: lines above for auth/connection errors.',
                    );
                } else {
                    console.log(`[music] Icecast confirms source on ${mountPath} (${loopHost}:${icePort}).`);
                }
            }, 12000);

            const ms = Math.max(500, parseInt(String(process.env.MUSIC_DOM_STREAM_DELAY_MS || '2500'), 10) || 2500);
            domPushTimer = setTimeout(() => {
                domPushTimer = null;
                if (!skipMountDomPush) {
                    void pushDomUrl(cfg);
                }
                console.log('[music] Mount should be live — listeners can use HTTPS stream URL (reload if you saw 404).');
            }, ms);

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
        stopFlag = false;
        paused = false;
        pausedTrack = null;
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
        },

        /** Start idle autoplay / drain loop (call once when the room music handler mounts). */
        kickAutoplayDrain: () => {
            void ensureDrain();
        },

        /** @returns {ReturnType<createTrackQueue>} */
        getQueue: () => queue,

        isPlaying: () => ffProc != null,

        /**
         * After enqueue, wait until Icecast serves this mount (source connected).
         * @param {NonNullable<Awaited<ReturnType<typeof loadConfig>>>} cfg
         * @param {number} [timeoutMs]
         * @returns {Promise<boolean>}
         */
        waitForMountLive: (cfg, timeoutMs) => waitForIcecastMountLive(cfg, timeoutMs),

        /** Skip the delayed mount-time room media push (commandHandler already synced). */
        notifyRoomMediaSynced,
    };
}
