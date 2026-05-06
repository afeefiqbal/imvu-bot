import net from 'net';
import http from 'http';
import { spawn } from 'child_process';

function truthy(v) {
    const s = String(v ?? '')
        .trim()
        .toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/** @returns {Promise<boolean>} */
function tcpAccepts(host, port, timeoutMs = 2000) {
    return new Promise((resolve) => {
        const sock = net.createConnection({ host, port }, () => {
            sock.destroy();
            resolve(true);
        });
        sock.on('error', () => resolve(false));
        sock.setTimeout(timeoutMs, () => {
            try {
                sock.destroy();
            } catch {}
            resolve(false);
        });
    });
}

function templateLooksLikeNgrok(tpl) {
    return /ngrok-free\.(app|dev)|\.ngrok\.io|\.ngrok\.app\b/i.test(String(tpl || ''));
}

/**
 * Poll local ngrok agent API for the HTTPS URL forwarding to our Icecast port.
 * @param {number} port
 * @param {string} apiBase e.g. http://127.0.0.1:4040
 */
function fetchNgrokHttpsUrl(port, apiBase) {
    const base = String(apiBase || 'http://127.0.0.1:4040').replace(/\/+$/, '');
    const path = '/api/tunnels';
    return new Promise((resolve) => {
        const req = http.get(
            `${base}${path}`,
            { timeout: 2500 },
            (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (c) => {
                    body += c;
                    if (body.length > 500_000) {
                        try {
                            res.destroy();
                        } catch {}
                    }
                });
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        resolve(null);
                        return;
                    }
                    try {
                        const j = JSON.parse(body);
                        const tunnels = Array.isArray(j?.tunnels) ? j.tunnels : [];
                        const portStr = String(port);
                        const https = tunnels.filter((t) => String(t?.proto || '').toLowerCase() === 'https');
                        for (const t of https) {
                            const pub = String(t?.public_url || '').trim().replace(/\/$/, '');
                            if (!/^https:\/\//i.test(pub)) continue;
                            const addr = String(t?.config?.addr || t?.config?.Addr || '');
                            if (addr.includes(`:${portStr}`) || addr.endsWith(portStr)) {
                                resolve(pub);
                                return;
                            }
                        }
                        const first = https[0]?.public_url;
                        resolve(first ? String(first).trim().replace(/\/$/, '') : null);
                    } catch {
                        resolve(null);
                    }
                });
            },
        );
        req.on('error', () => resolve(null));
        req.on('timeout', () => {
            try {
                req.destroy();
            } catch {}
            resolve(null);
        });
    });
}

/**
 * HTTPS URL via ngrok (`ngrok http ICECAST_PORT`). Sets MUSIC_PUBLIC_STREAM_URL_TEMPLATE for this process (children inherit).
 *
 * - NGROK_TUNNEL_AUTO=1 → when template empty, or when it still points at *.ngrok* (hostname dies after ngrok exits).
 * - NGROK_TUNNEL_FORCE=1 → always replace template with a new tunnel.
 *
 * Requires `ngrok` on PATH and auth: `ngrok config add-authtoken` or `NGROK_AUTHTOKEN` in env (free account).
 * Optional: NGROK_PATH, NGROK_AGENT_API (default http://127.0.0.1:4040).
 */
export async function maybeStartNgrokTunnelForIcecast() {
    const force = truthy(process.env.NGROK_TUNNEL_FORCE);
    const templateNow = String(process.env.MUSIC_PUBLIC_STREAM_URL_TEMPLATE || '').trim();
    const autoDesired = truthy(process.env.NGROK_TUNNEL_AUTO);
    const autoWhenEmpty = autoDesired && !templateNow;
    const autoRefreshDead = autoDesired && templateNow && templateLooksLikeNgrok(templateNow);

    if (!force && !autoWhenEmpty && !autoRefreshDead) {
        return false;
    }

    if (force && templateNow) {
        console.log('[music/ngrok] NGROK_TUNNEL_FORCE=1 — replacing MUSIC_PUBLIC_STREAM_URL_TEMPLATE with new ngrok URL');
    } else if (autoRefreshDead && !force) {
        console.log(
            '[music/ngrok] NGROK_TUNNEL_AUTO=1: template is an ngrok host — starting a new tunnel (old ngrok URLs stop after ngrok exits).',
        );
    }

    const prevTemplate = templateNow;
    const host = String(process.env.ICECAST_HOST || '127.0.0.1').trim();
    const port = parseInt(String(process.env.ICECAST_PORT || '8001'), 10) || 8001;
    const loopHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    const localTarget = `${loopHost}:${port}`;
    const apiBase = String(process.env.NGROK_AGENT_API || 'http://127.0.0.1:4040').trim() || 'http://127.0.0.1:4040';

    const waitSec = Math.max(
        0,
        parseInt(String(process.env.MUSIC_TUNNEL_WAIT_ICECAST_SECONDS || '30'), 10) || 0,
    );
    console.log(`[music/ngrok] ngrok http ${localTarget} (ICECAST_PORT=${port}) — agent API ${apiBase}/api/tunnels`);
    let icecastUp = false;
    if (waitSec <= 0) {
        icecastUp = await tcpAccepts(loopHost, port, 2000);
    } else {
        const deadline = Date.now() + waitSec * 1000;
        while (Date.now() < deadline) {
            if (await tcpAccepts(loopHost, port, 1800)) {
                icecastUp = true;
                break;
            }
            console.warn(`[music/ngrok] Icecast not accepting TCP on ${loopHost}:${port} yet — retrying…`);
            await new Promise((r) => setTimeout(r, 2000));
        }
    }
    if (!icecastUp) {
        console.warn(
            `[music/ngrok] No listener on ${loopHost}:${port} yet. ngrok will still start; fix Icecast if stream 502/404 at origin.`,
        );
    }

    const bin = String(process.env.NGROK_PATH || 'ngrok').trim() || 'ngrok';
    const proc = spawn(bin, ['http', localTarget], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
    });

    let stderrBuf = '';
    const logErr = (buf) => {
        stderrBuf += String(buf || '');
        if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-4000);
    };
    proc.stderr?.on('data', logErr);
    proc.stdout?.on('data', logErr);

    proc.on('error', (err) => {
        console.warn('[music/ngrok] ngrok spawn failed (https://ngrok.com/download):', err.message);
    });

    const deadline = Date.now() + Math.min(60000, Math.max(15000, parseInt(String(process.env.NGROK_TUNNEL_READY_MS || '45000'), 10) || 45000));
    let publicBase = null;
    while (Date.now() < deadline) {
        publicBase = await fetchNgrokHttpsUrl(port, apiBase);
        if (publicBase) break;
        await new Promise((r) => setTimeout(r, 400));
    }

    if (!publicBase) {
        console.warn(
            '[music/ngrok] Timed out waiting for ngrok HTTPS URL. Is `ngrok` installed and `ngrok config add-authtoken` set? Another ngrok using the same agent API port?',
            stderrBuf ? `ngrok output (tail): ${stderrBuf.slice(-600)}` : '',
        );
        try {
            proc.kill('SIGTERM');
        } catch {}
        if (prevTemplate) process.env.MUSIC_PUBLIC_STREAM_URL_TEMPLATE = prevTemplate;
        return false;
    }

    const mountTpl = String(process.env.ICECAST_MOUNT_TEMPLATE || '/imvu-{room}.mp3').trim();
    const pathSeg = mountTpl.startsWith('/') ? mountTpl : `/${mountTpl}`;
    process.env.MUSIC_PUBLIC_STREAM_URL_TEMPLATE = `${publicBase}${pathSeg}`;
    console.log(`[music/ngrok] MUSIC_PUBLIC_STREAM_URL_TEMPLATE → ${process.env.MUSIC_PUBLIC_STREAM_URL_TEMPLATE}`);
    console.warn(
        '[music/ngrok] Keep this process running. Stopping ngrok or multi-launcher invalidates the hostname.',
    );

    return true;
}
