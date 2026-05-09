import http from 'http';
import play from 'play-dl';
import { createTrackQueue } from './queue.js';
import { createFfmpegIcecastPipe } from './ffmpegIcecast.js';
import { notifyImvuMusicState } from './notifyImvuMusicApi.js';
import { applyRoomMediaStreamUrl } from './imvuRoomMediaDom.js';
import { spawnYtDlpAudioStdout } from './ytDlpAudioStdout.js';
import { cacheBustHttpsStreamUrl } from './loadStreamConfig.js';
import { canonicalYoutubeWatchUrl } from './resolvePlay.js';
import { withIcecastMountEncodeLock } from './icecastMountLock.js';

/** @returns {Promise<number>} HTTP status (0 on failure). */
function httpGetStatus(host, port, path) {
    return new Promise((resolve) => {
        const req = http.request(
            {
                hostname: host,
                port: Number(port),
                path: path.startsWith('/') ? path : `/${path}`,
                method: 'GET',
                timeout: 2800,
            },
            (res) => {
                const code = res.statusCode || 0;
                try {
                    res.destroy();
                } catch {}
                resolve(code);
            },
        );
        req.on('error', () => resolve(0));
        req.on('timeout', () => {
            try {
                req.destroy();
            } catch {}
            resolve(0);
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
 * After local Icecast shows a source, optional check that the public HTTPS URL answers (tunnel origin correct).
 * @param {string} pubUrl
 * @param {number} timeoutMs
 */
async function waitForPublicHttpsStream(pubUrl, timeoutMs) {
    const deadline = Date.now() + Math.max(2000, timeoutMs);
    while (Date.now() < deadline) {
        try {
            const ac = AbortSignal.timeout(4500);
            const res = await fetch(pubUrl, {
                method: 'GET',
                signal: ac,
                redirect: 'follow',
                headers: {
                    'User-Agent': 'lurkbot-stream-check/1',
                    Accept: '*/*',
                    'Icy-Metadata': '1',
                    'ngrok-skip-browser-warning': 'true',
                },
            });
            const code = res.status;
            const ct = String(res.headers.get('content-type') || '');
            try {
                await res.body?.cancel();
            } catch {}
            // ngrok free tier can return 200 + text/html interstitial without this header — not a live Icecast mount.
            if (code === 200 && /text\/html/i.test(ct)) continue;
            if (code === 200) return true;
        } catch {}
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
                        '[music] Icecast source is up locally, but HTTPS stream URL still not HTTP 200. ' +
                            'Check ngrok (or MUSIC_PUBLIC_STREAM_URL_TEMPLATE) targets the same ICECAST_PORT (e.g. host 8001 for Docker). URL:',
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
 *   page: import('puppeteer').Page | null,
 *   loadConfig: () => Promise<object | null>,
 * }} opts
 */
export function createRoomPlayer(opts) {
    const { roomId, apiBaseUrl, botName, page, loadConfig } = opts;
    const queue = createTrackQueue();
    /** @type {import('child_process').ChildProcess | null} */
    let ffProc = null;
    /** @type {import('child_process').ChildProcess | null} */
    let ytdlpProc = null;
    let drainLock = false;
    let stopFlag = false;
    /** When true, drain loop will not start the next track (after !pause). */
    let paused = false;
    /** Track that was playing when paused — resumed from the start (live stream has no mid-song seek). */
    /** @type {{ title: string, url: string } | null} */
    let pausedTrack = null;
    /** @type {Awaited<ReturnType<typeof loadConfig>> | null} */
    let cachedConfig = null;

    const killFf = () => {
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

    const pushDomUrl = async (cfg) => {
        if (cfg?.publicStreamUrl && page && !page.isClosed()) {
            await applyRoomMediaStreamUrl(page, cacheBustHttpsStreamUrl(cfg.publicStreamUrl));
        }
    };

    const playOne = async () => {
        const cfg = await loadConfig();
        cachedConfig = cfg;
        if (!cfg?.enabled) return;

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
        while (queue.peek()) {
            next = queue.dequeue();
        }

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
            const ytStream = await play.stream(track.url, { seek: 0 });
            audioIn = ytStream.stream;
            console.log('[music] decoder: play-dl → FFmpeg → Icecast');
        } catch (e) {
            console.warn(
                `[music] play.stream failed (${e.message}); using yt-dlp stdout → FFmpeg`,
            );
            try {
                const { proc: yp, stdout } = spawnYtDlpAudioStdout(track.url);
                ytdlpProc = yp;
                audioIn = stdout;
                console.log('[music] decoder: yt-dlp → FFmpeg → Icecast');
            } catch (e2) {
                console.error('[music] yt-dlp pipe setup failed:', e2.message);
                queue.setCurrent(null);
                return;
            }
        }

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
                return;
            }

            setTimeout(async () => {
                const up = await icecastStatusJsonShowsSource(loopHost, icePort, mountPath);
                if (!up) {
                    console.warn(
                        `[music] Icecast has no SOURCE on ${mountPath} at ${loopHost}:${icePort} ~5s after start — ` +
                            'nothing is registered on that mount (listeners/ngrok get 404). ' +
                            'Compare ICECAST_SOURCE_USER / ICECAST_SOURCE_PASSWORD in .env with icecast.xml <source-password>, ' +
                            'and ICECAST_PORT (Docker host is usually 8001). Watch [music] ffmpeg: lines above for auth/connection errors.',
                    );
                } else {
                    console.log(`[music] Icecast confirms source on ${mountPath} (${loopHost}:${icePort}).`);
                }
            }, 5000);

            const ms = Math.max(500, parseInt(String(process.env.MUSIC_DOM_STREAM_DELAY_MS || '2500'), 10) || 2500);
            setTimeout(() => {
                void pushDomUrl(cfg);
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
        queue.setCurrent(null);
    };

    const ensureDrain = async () => {
        if (drainLock || ffProc) return;
        drainLock = true;
        try {
            while (!stopFlag && !paused && queue.peek()) {
                await playOne();
            }
        } finally {
            drainLock = false;
        }
    };

    return {
        /** @returns {Promise<void>} */
        refreshConfig: async () => {
            cachedConfig = await loadConfig();
        },

        enqueue: (track) => {
            stopFlag = false;
            queue.enqueue(track);
            void ensureDrain();
        },

        /**
         * Drop the queue, stop the current encode, and play this track next.
         * (Plain enqueue() does nothing while FFmpeg is running — use this for !play / skip-replace.)
         */
        playNow: (track) => {
            stopFlag = false;
            paused = false;
            pausedTrack = null;
            queue.clearPending();
            queue.enqueue(track);
            if (ffProc || ytdlpProc) {
                killFf();
            }
            void ensureDrain();
        },

        /** Skip current song; play next in queue if any. */
        skip: () => {
            paused = false;
            pausedTrack = null;
            killFf();
            void ensureDrain();
        },

        /** Stop encoding; keep queue + current song for !resume (restarts current from beginning). */
        pause: () => {
            paused = true;
            const cur = queue.getCurrent();
            pausedTrack = cur ? { title: cur.title, url: cur.url } : null;
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
    };
}
