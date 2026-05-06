import net from 'net';
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

function templateLooksLikeTryCloudflare(tpl) {
    return /\.trycloudflare\.com\b/i.test(String(tpl || ''));
}

function extractHttpsUrlFromLogs(s) {
    const m = String(s || '').match(/https:\/\/[a-z0-9.-]+(?:\.trycloudflare\.com|\.cloudflareaccess\.com)\b/i);
    return m ? m[0].replace(/\/$/, '') : null;
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

    const prevTemplate = templateNow;
    const host = String(process.env.ICECAST_HOST || '127.0.0.1').trim();
    const port = parseInt(String(process.env.ICECAST_PORT || '8001'), 10) || 8001;
    const loopHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    const localTarget = `http://${loopHost}:${port}`;

    const waitSec = Math.max(
        0,
        parseInt(String(process.env.MUSIC_TUNNEL_WAIT_ICECAST_SECONDS || '30'), 10) || 0,
    );
    console.log(`[music/cloudflare] cloudflared tunnel --url ${localTarget}`);
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
            await new Promise((r) => setTimeout(r, 2000));
        }
    }
    if (!icecastUp) {
        console.warn(
            `[music/cloudflare] No listener on ${loopHost}:${port} yet. Tunnel will still start; fix Icecast if stream 502/404 at origin.`,
        );
    }

    const bin = String(process.env.CLOUDFLARED_PATH || 'cloudflared').trim() || 'cloudflared';
    const args = ['tunnel', '--no-autoupdate', '--url', localTarget];
    const fixedHost = String(process.env.CLOUDFLARED_HOSTNAME || '').trim();
    if (fixedHost) args.push('--hostname', fixedHost);
    const extra = String(process.env.CLOUDFLARED_EXTRA_ARGS || '').trim();
    if (extra) args.push(...extra.split(/\s+/).filter(Boolean));

    const proc = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
    });

    let outputBuf = '';
    let publicBase = fixedHost ? `https://${fixedHost.replace(/^https?:\/\//i, '').replace(/\/$/, '')}` : null;
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
        console.warn('[music/cloudflare] cloudflared spawn failed (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/):', err.message);
    });

    if (!publicBase) {
        const deadline = Date.now() + Math.min(60000, Math.max(15000, parseInt(String(process.env.CLOUDFLARE_TUNNEL_READY_MS || '45000'), 10) || 45000));
        while (Date.now() < deadline) {
            if (publicBase) break;
            await new Promise((r) => setTimeout(r, 250));
        }
    }

    if (!publicBase) {
        console.warn(
            '[music/cloudflare] Timed out waiting for cloudflared HTTPS URL. Is `cloudflared` installed?',
            outputBuf ? `cloudflared output (tail): ${outputBuf.slice(-600)}` : '',
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
    console.log(`[music/cloudflare] MUSIC_PUBLIC_STREAM_URL_TEMPLATE → ${process.env.MUSIC_PUBLIC_STREAM_URL_TEMPLATE}`);
    console.warn('[music/cloudflare] Keep this process running. Stopping cloudflared or multi-launcher invalidates this URL.');
    return true;
}
