import net from 'net';
import { spawn, spawnSync } from 'child_process';
import { icecastConnectFamily, resolvedIcecastHost } from './resolvedIcecastHost.js';

/** @returns {boolean} */
export function cloudflaredAvailable() {
    const bin = String(process.env.CLOUDFLARED_PATH || 'cloudflared').trim() || 'cloudflared';
    const r = spawnSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
    return r.status === 0;
}

function truthy(v) {
    const s = String(v ?? '')
        .trim()
        .toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/** @returns {Promise<boolean>} */
function tcpAccepts(host, port, timeoutMs = 2000) {
    return new Promise((resolve) => {
        const sock = net.createConnection({ host, port, family: icecastConnectFamily(host) }, () => {
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

function templateLooksLikeTryCloudflare(tpl) {
    return /\.trycloudflare\.com\b/i.test(String(tpl || ''));
}

function extractHttpsUrlFromLogs(s) {
    const m = String(s || '').match(/https:\/\/[a-z0-9.-]+(?:\.trycloudflare\.com|\.cloudflareaccess\.com)\b/i);
    return m ? m[0].replace(/\/$/, '') : null;
}

/**
 * Quick Tunnel registration can return HTTP 500 / non-JSON from Cloudflare (e.g. datacenter egress,
 * rate limits). Detect and retry instead of waiting the full READY timeout.
 */
function quickTunnelLooksFatal(log) {
    const s = String(log || '');
    return (
        /failed to unmarshal quick Tunnel/i.test(s) ||
        /Error unmarshaling QuickTunnel/i.test(s) ||
        /error code:\s*1101/i.test(s) ||
        /status_code="500 Internal Server Error"/i.test(s) ||
        /Unable to reach the Cloudflare API/i.test(s)
    );
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * HTTPS URL via cloudflared (`cloudflared tunnel --url http://127.0.0.1:8001`).
 * Sets MUSIC_PUBLIC_STREAM_URL_TEMPLATE for this process (children inherit).
 *
 * - CLOUDFLARE_TUNNEL_AUTO=1 with empty template starts tunnel and injects URL.
 * - CLOUDFLARE_TUNNEL_FORCE=1 always replaces current template.
 *
 * Optional:
 * - CLOUDFLARED_PATH (default: cloudflared)
 * - CLOUDFLARED_HOSTNAME (fixed domain, skips log parsing when set)
 * - CLOUDFLARED_EXTRA_ARGS (appended raw args)
 * - CLOUDFLARE_QUICK_TUNNEL_RETRIES (default 4) — Quick Tunnel API is flaky from some hosts
 * - CLOUDFLARE_QUICK_TUNNEL_RETRY_MS (default 6000) — pause between attempts
 */
export async function maybeStartCloudflareTunnelForIcecast() {
    const force = truthy(process.env.CLOUDFLARE_TUNNEL_FORCE);
    const templateNow = String(process.env.MUSIC_PUBLIC_STREAM_URL_TEMPLATE || '').trim();
    const autoDesired = truthy(process.env.CLOUDFLARE_TUNNEL_AUTO);
    const autoWhenEmpty = autoDesired && !templateNow;
    const autoRefreshDead = autoDesired && templateNow && templateLooksLikeTryCloudflare(templateNow);

    if (!force && !autoWhenEmpty && !autoRefreshDead) {
        return false;
    }

    // Stable Railway (or other) HTTPS URL already configured — no quick tunnel or TCP probe needed.
    if (
        !force &&
        templateNow &&
        /^https:\/\//i.test(templateNow) &&
        !templateLooksLikeTryCloudflare(templateNow)
    ) {
        return false;
    }

    if (!cloudflaredAvailable()) {
        console.warn(
            '[music/cloudflare] cloudflared not installed — skipping quick tunnel. ' +
                'Set CLOUDFLARE_TUNNEL_AUTO=0 and MUSIC_PUBLIC_STREAM_URL_TEMPLATE to your Icecast HTTPS URL.',
        );
        return false;
    }

    const prevTemplate = templateNow;
    const host = resolvedIcecastHost();
    const port = parseInt(String(process.env.ICECAST_PORT || '8001'), 10) || 8001;
    const loopHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    const localTarget = `http://${loopHost}:${port}`;

    const waitSec = Math.max(
        0,
        parseInt(String(process.env.MUSIC_TUNNEL_WAIT_ICECAST_SECONDS || '30'), 10) || 0,
    );
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
            console.warn(`[music/cloudflare] Icecast not accepting TCP on ${loopHost}:${port} yet — retrying...`);
            await sleep(2000);
        }
    }
    if (!icecastUp) {
        console.warn(
            `[music/cloudflare] No listener on ${loopHost}:${port} yet. Tunnel will still start; fix Icecast if stream 502/404 at origin.`,
        );
    }

    const bin = String(process.env.CLOUDFLARED_PATH || 'cloudflared').trim() || 'cloudflared';
    const baseArgs = ['tunnel', '--no-autoupdate', '--url', localTarget];
    const fixedHost = String(process.env.CLOUDFLARED_HOSTNAME || '').trim();
    if (fixedHost) baseArgs.push('--hostname', fixedHost);
    const extra = String(process.env.CLOUDFLARED_EXTRA_ARGS || '').trim();
    if (extra) baseArgs.push(...extra.split(/\s+/).filter(Boolean));

    const maxAttempts = Math.max(1, parseInt(String(process.env.CLOUDFLARE_QUICK_TUNNEL_RETRIES || '4'), 10) || 4);
    const retryPauseMs = Math.max(
        500,
        parseInt(String(process.env.CLOUDFLARE_QUICK_TUNNEL_RETRY_MS || '6000'), 10) || 6000,
    );
    const readyMs = Math.min(
        120000,
        Math.max(15000, parseInt(String(process.env.CLOUDFLARE_TUNNEL_READY_MS || '45000'), 10) || 45000),
    );

    let lastBuf = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (attempt > 1) {
            console.warn(
                `[music/cloudflare] Quick Tunnel attempt ${attempt}/${maxAttempts} (previous failure — ${retryPauseMs}ms backoff).`,
            );
            await sleep(retryPauseMs);
        }

        console.log(`[music/cloudflare] cloudflared tunnel --url ${localTarget}`);
        const proc = spawn(bin, baseArgs, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env },
        });

        let outputBuf = '';
        let publicBase = fixedHost
            ? `https://${fixedHost.replace(/^https?:\/\//i, '').replace(/\/$/, '')}`
            : null;

        const capture = (buf) => {
            const text = String(buf || '');
            outputBuf += text;
            if (outputBuf.length > 8000) outputBuf = outputBuf.slice(-4000);
            if (!publicBase) {
                const found = extractHttpsUrlFromLogs(text);
                if (found) publicBase = found;
            }
        };
        proc.stdout?.on('data', capture);
        proc.stderr?.on('data', capture);

        proc.on('error', (err) => {
            console.warn(
                '[music/cloudflare] cloudflared spawn failed (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/):',
                err.message,
            );
        });

        let procExited = false;
        proc.on('exit', () => {
            procExited = true;
        });

        const deadline = Date.now() + (publicBase && fixedHost ? 2000 : readyMs);
        while (Date.now() < deadline) {
            if (!publicBase) {
                const found = extractHttpsUrlFromLogs(outputBuf);
                if (found) publicBase = found;
            }
            if (publicBase) {
                break;
            }
            if (quickTunnelLooksFatal(outputBuf)) {
                break;
            }
            if (procExited) {
                break;
            }
            await sleep(250);
        }

        lastBuf = outputBuf;

        if (publicBase) {
            const mountTpl = String(process.env.ICECAST_MOUNT_TEMPLATE || '/imvu-{room}.mp3').trim();
            const pathSeg = mountTpl.startsWith('/') ? mountTpl : `/${mountTpl}`;
            process.env.MUSIC_PUBLIC_STREAM_URL_TEMPLATE = `${publicBase}${pathSeg}`;
            console.log(
                `[music/cloudflare] MUSIC_PUBLIC_STREAM_URL_TEMPLATE → ${process.env.MUSIC_PUBLIC_STREAM_URL_TEMPLATE}`,
            );
            console.warn(
                '[music/cloudflare] Keep this process running. Stopping cloudflared or multi-launcher invalidates this URL.',
            );
            if (attempt > 1) {
                console.log(`[music/cloudflare] Quick Tunnel succeeded on attempt ${attempt}.`);
            }
            return true;
        }

        try {
            proc.kill('SIGTERM');
        } catch {}
        await sleep(500);

        if (attempt === maxAttempts) {
            console.warn(
                '[music/cloudflare] Quick Tunnel failed after',
                maxAttempts,
                'attempt(s). Cloudflare often returns HTTP 500 from cloud/datacenter egress — use a named tunnel (Zero Trust), set MUSIC_PUBLIC_STREAM_URL_TEMPLATE to a stable HTTPS URL, or MUSIC_TUNNEL_FALLBACK_NGROK=1 with ngrok + NGROK_AUTHTOKEN.',
                lastBuf ? `cloudflared output (tail): ${lastBuf.slice(-800)}` : '',
            );
            if (prevTemplate) process.env.MUSIC_PUBLIC_STREAM_URL_TEMPLATE = prevTemplate;
            return false;
        }
    }

    if (prevTemplate) process.env.MUSIC_PUBLIC_STREAM_URL_TEMPLATE = prevTemplate;
    return false;
}
