import http from 'http';
import { icecastConnectFamily } from './resolvedIcecastHost.js';
import { probePublicStreamForImvu, isImvuBlockingStreamProbe } from './verifyImvuStreamUrl.js';

/** @returns {Promise<number>} HTTP status (0 on failure). */
export function httpGetStatus(host, port, path) {
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
 * Icecast status-json: true when a source is connected on this mount.
 * @param {string} loopHost
 * @param {number} port
 * @param {string} mount
 * @returns {Promise<boolean>}
 */
export async function icecastStatusJsonShowsSource(loopHost, port, mount) {
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
 * @param {string} pubUrl
 * @param {number} timeoutMs
 * @param {{ isStale?: () => boolean }} [opts]
 */
export async function waitForPublicHttpsStream(pubUrl, timeoutMs, opts = {}) {
    const isStale = typeof opts.isStale === 'function' ? opts.isStale : () => false;
    const deadline = Date.now() + Math.max(2000, timeoutMs);
    let warnedNgrok = false;
    while (Date.now() < deadline) {
        if (isStale()) return false;
        const imvu = await probePublicStreamForImvu(pubUrl, 4500);
        if (isStale()) return false;
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
 * Poll until FFmpeg has connected as a source. If publicStreamUrl is HTTPS, also wait until that URL returns audio.
 * @param {{ enabled?: boolean, icecastHost?: string, icecastPort?: number, icecastMount?: string, publicStreamUrl?: string }} cfg
 * @param {number} timeoutMs
 * @param {{ isStale?: () => boolean }} [opts]
 */
export async function waitForIcecastMountLive(cfg, timeoutMs, opts = {}) {
    if (!cfg?.enabled) return false;
    const isStale = typeof opts.isStale === 'function' ? opts.isStale : () => false;
    const loopHost = cfg.icecastHost === '0.0.0.0' ? '127.0.0.1' : String(cfg.icecastHost || '127.0.0.1');
    const mount = cfg.icecastMount.startsWith('/') ? cfg.icecastMount : `/${cfg.icecastMount}`;
    const port = Number(cfg.icecastPort) || 8001;
    const deadline = Date.now() + Math.max(3000, timeoutMs);
    let lastGet = 0;
    const requireJson =
        !/^(0|false|no|off)$/i.test(String(process.env.MUSIC_REQUIRE_ICECAST_SOURCE_JSON ?? '1').trim());
    while (Date.now() < deadline) {
        if (isStale()) return false;
        const fromJson = await icecastStatusJsonShowsSource(loopHost, port, mount);
        if (isStale()) return false;
        lastGet = await httpGetStatus(loopHost, port, mount);
        if (isStale()) return false;
        const mountOk = requireJson ? fromJson : fromJson || lastGet === 200;
        if (mountOk) {
            const pub = String(cfg.publicStreamUrl || '').trim();
            if (/^https:\/\//i.test(pub)) {
                const httpsOk = await waitForPublicHttpsStream(pub, 22000, { isStale });
                if (isStale()) return false;
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

/** @param {{ sourceUser?: string, sourcePassword?: string, icecastMount?: string, icecastHost?: string, icecastPort?: number }} cfg */
export function icecastDestFromConfig(cfg) {
    const u = encodeURIComponent(cfg.sourceUser);
    const p = encodeURIComponent(cfg.sourcePassword);
    const mount = cfg.icecastMount.startsWith('/') ? cfg.icecastMount : `/${cfg.icecastMount}`;
    const host = cfg.icecastHost === '0.0.0.0' ? '127.0.0.1' : String(cfg.icecastHost || '127.0.0.1');
    return `icecast://${u}:${p}@${host}:${cfg.icecastPort}${mount}`;
}
