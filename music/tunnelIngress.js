import { maybeStartNgrokTunnelForIcecast } from './ngrokIcecastTunnel.js';
import { cloudflaredAvailable, maybeStartCloudflareTunnelForIcecast } from './cloudflareIcecastTunnel.js';
import { verifyTunnelImvuCompatible } from './verifyImvuStreamUrl.js';

function truthy(v) {
    const s = String(v ?? '')
        .trim()
        .toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

async function verifyAndWarnTunnelImvuCompat() {
    if (!truthy(process.env.MUSIC_TUNNEL_IMVU_COMPAT ?? '1')) return true;
    const tpl = String(process.env.MUSIC_PUBLIC_STREAM_URL_TEMPLATE || '').trim();
    if (!tpl) return true;
    const { compatible, message, probe } = await verifyTunnelImvuCompatible(tpl);
    if (compatible) return true;
    console.error(`[music/tunnel] IMVU-incompatible public stream URL: ${message}`);
    if (probe?.ngrokError) console.error(`[music/tunnel] ngrok-error-code: ${probe.ngrokError}`);
    return false;
}

async function startCloudflareWithForce() {
    const savedForce = process.env.CLOUDFLARE_TUNNEL_FORCE;
    const savedAuto = process.env.CLOUDFLARE_TUNNEL_AUTO;
    process.env.CLOUDFLARE_TUNNEL_FORCE = '1';
    process.env.CLOUDFLARE_TUNNEL_AUTO = '1';
    try {
        return await maybeStartCloudflareTunnelForIcecast();
    } finally {
        if (savedForce === undefined) delete process.env.CLOUDFLARE_TUNNEL_FORCE;
        else process.env.CLOUDFLARE_TUNNEL_FORCE = savedForce;
        if (savedAuto === undefined) delete process.env.CLOUDFLARE_TUNNEL_AUTO;
        else process.env.CLOUDFLARE_TUNNEL_AUTO = savedAuto;
    }
}

/**
 * Start public HTTPS ingress for Icecast.
 * Provider priority:
 * - MUSIC_TUNNEL_PROVIDER=cloudflare|ngrok (explicit)
 * - CLOUDFLARE_TUNNEL_AUTO=1 (auto) — preferred for IMVU (ngrok free returns HTML interstitial)
 * - NGROK_TUNNEL_AUTO=1 (auto)
 * Otherwise: use MUSIC_PUBLIC_STREAM_URL_TEMPLATE from .env / Laravel.
 *
 * If Cloudflare quick tunnel fails: MUSIC_TUNNEL_FALLBACK_NGROK=1 tries ngrok after CF.
 * If ngrok free blocks IMVU: MUSIC_TUNNEL_FALLBACK_CLOUDFLARE=1 (default) tries Cloudflare.
 */
export async function maybeStartMusicIngressTunnel() {
    const provider = String(process.env.MUSIC_TUNNEL_PROVIDER || '')
        .trim()
        .toLowerCase();
    const cfAuto = truthy(process.env.CLOUDFLARE_TUNNEL_AUTO);
    const ngAuto = truthy(process.env.NGROK_TUNNEL_AUTO);
    const fallbackCf = truthy(process.env.MUSIC_TUNNEL_FALLBACK_CLOUDFLARE ?? '1');

    if (provider === 'cloudflare' || cfAuto) {
        if (!cloudflaredAvailable()) {
            console.warn(
                '[music/tunnel] CLOUDFLARE_TUNNEL_AUTO is on but cloudflared is not in this container — skipped. ' +
                    'Set CLOUDFLARE_TUNNEL_AUTO=0 and MUSIC_PUBLIC_STREAM_URL_TEMPLATE=https://your-icecast-host/imvu-{room}.mp3',
            );
            return false;
        }
        const cfOk = await maybeStartCloudflareTunnelForIcecast();
        if (cfOk) return true;
        if (truthy(process.env.MUSIC_TUNNEL_FALLBACK_NGROK)) {
            const savedNg = process.env.NGROK_TUNNEL_AUTO;
            process.env.NGROK_TUNNEL_AUTO = '1';
            console.warn(
                '[music/tunnel] Cloudflare quick tunnel failed — trying ngrok (MUSIC_TUNNEL_FALLBACK_NGROK=1). Note: ngrok free tier may not work in IMVU rooms.',
            );
            try {
                const ngOk = await maybeStartNgrokTunnelForIcecast();
                if (ngOk && !(await verifyAndWarnTunnelImvuCompat()) && fallbackCf) {
                    console.warn('[music/tunnel] ngrok URL blocked for IMVU — no Cloudflare fallback left.');
                }
                return ngOk;
            } finally {
                if (savedNg === undefined) delete process.env.NGROK_TUNNEL_AUTO;
                else process.env.NGROK_TUNNEL_AUTO = savedNg;
            }
        }
        return false;
    }
    if (provider === 'ngrok' || ngAuto) {
        const ngOk = await maybeStartNgrokTunnelForIcecast();
        if (!ngOk) return false;
        if (await verifyAndWarnTunnelImvuCompat()) return true;
        if (!fallbackCf) {
            console.error(
                '[music/tunnel] ngrok free tier cannot serve IMVU radio. Set CLOUDFLARE_TUNNEL_AUTO=1 or MUSIC_TUNNEL_FALLBACK_CLOUDFLARE=1.',
            );
            return true;
        }
        console.warn(
            '[music/tunnel] ngrok URL returns HTML interstitial for IMVU clients — starting Cloudflare quick tunnel instead.',
        );
        const cfOk = await startCloudflareWithForce();
        if (cfOk) return true;
        console.error(
            '[music/tunnel] Cloudflare fallback failed. IMVU will not play audio through ngrok free URLs. Install cloudflared or use ngrok paid/static domain.',
        );
        return true;
    }
    if (provider) {
        console.warn(
            `[music/tunnel] Unsupported MUSIC_TUNNEL_PROVIDER="${provider}". Using MUSIC_PUBLIC_STREAM_URL_TEMPLATE as-is.`,
        );
        return false;
    }
    if (!cfAuto && !ngAuto) {
        const tpl = String(process.env.MUSIC_PUBLIC_STREAM_URL_TEMPLATE || '').trim();
        if (tpl && !(await verifyAndWarnTunnelImvuCompat())) {
            console.error(
                '[music/tunnel] Static MUSIC_PUBLIC_STREAM_URL_TEMPLATE is not IMVU-compatible (likely ngrok free). Use trycloudflare.com or a real audio HTTPS URL.',
            );
        } else {
            console.log(
                '[music/tunnel] Auto tunnel is off — using MUSIC_PUBLIC_STREAM_URL_TEMPLATE from .env / Laravel only.',
            );
        }
        return false;
    }
    return false;
}
