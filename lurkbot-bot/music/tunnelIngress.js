import { maybeStartNgrokTunnelForIcecast } from './ngrokIcecastTunnel.js';
import { maybeStartCloudflareTunnelForIcecast } from './cloudflareIcecastTunnel.js';

function truthy(v) {
    const s = String(v ?? '')
        .trim()
        .toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * Start public HTTPS ingress for Icecast.
 * Provider priority:
 * - MUSIC_TUNNEL_PROVIDER=cloudflare|ngrok (explicit)
 * - CLOUDFLARE_TUNNEL_AUTO=1 (auto)
 * - NGROK_TUNNEL_AUTO=1 (auto)
 * Otherwise: use MUSIC_PUBLIC_STREAM_URL_TEMPLATE from .env / Laravel.
 *
 * If Cloudflare quick tunnel fails: MUSIC_TUNNEL_FALLBACK_NGROK=1 tries ngrok after CF (needs ngrok binary + NGROK_AUTHTOKEN).
 */
export async function maybeStartMusicIngressTunnel() {
    const provider = String(process.env.MUSIC_TUNNEL_PROVIDER || '')
        .trim()
        .toLowerCase();
    const cfAuto = truthy(process.env.CLOUDFLARE_TUNNEL_AUTO);
    const ngAuto = truthy(process.env.NGROK_TUNNEL_AUTO);

    if (provider === 'cloudflare' || cfAuto) {
        const cfOk = await maybeStartCloudflareTunnelForIcecast();
        if (cfOk) return true;
        if (truthy(process.env.MUSIC_TUNNEL_FALLBACK_NGROK)) {
            const savedNg = process.env.NGROK_TUNNEL_AUTO;
            process.env.NGROK_TUNNEL_AUTO = '1';
            console.warn(
                '[music/tunnel] Cloudflare quick tunnel failed — trying ngrok (MUSIC_TUNNEL_FALLBACK_NGROK=1). Install ngrok and set NGROK_AUTHTOKEN if needed.',
            );
            try {
                return await maybeStartNgrokTunnelForIcecast();
            } finally {
                if (savedNg === undefined) delete process.env.NGROK_TUNNEL_AUTO;
                else process.env.NGROK_TUNNEL_AUTO = savedNg;
            }
        }
        return false;
    }
    if (provider === 'ngrok' || ngAuto) {
        return maybeStartNgrokTunnelForIcecast();
    }
    if (provider) {
        console.warn(
            `[music/tunnel] Unsupported MUSIC_TUNNEL_PROVIDER="${provider}". Using MUSIC_PUBLIC_STREAM_URL_TEMPLATE as-is.`,
        );
        return false;
    }
    if (!cfAuto && !ngAuto) {
        console.log(
            '[music/tunnel] Auto tunnel is off — using MUSIC_PUBLIC_STREAM_URL_TEMPLATE from .env / Laravel only.',
        );
        return false;
    }
    return false;
}
