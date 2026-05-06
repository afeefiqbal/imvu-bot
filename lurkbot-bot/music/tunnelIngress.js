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
 */
export async function maybeStartMusicIngressTunnel() {
    const provider = String(process.env.MUSIC_TUNNEL_PROVIDER || '')
        .trim()
        .toLowerCase();
    const cfAuto = truthy(process.env.CLOUDFLARE_TUNNEL_AUTO);
    const ngAuto = truthy(process.env.NGROK_TUNNEL_AUTO);

    if (provider === 'cloudflare' || cfAuto) {
        return maybeStartCloudflareTunnelForIcecast();
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
