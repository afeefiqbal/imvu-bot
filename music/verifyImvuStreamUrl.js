/**
 * IMVU's in-room radio player loads station_url like a browser — no custom headers.
 * ngrok free tier returns an HTML interstitial (ERR_NGROK_6024) instead of audio/mpeg.
 */

export function urlLooksLikeNgrokFree(url) {
    return /ngrok-free\.(app|dev)\b/i.test(String(url || ''));
}

/** True when IMVU clients cannot play this URL (ngrok browser warning), not a transient empty mount. */
export function isImvuBlockingStreamProbe(probe, url) {
    if (!probe) return false;
    if (probe.reason === 'ngrok-interstitial') return true;
    const u = String(url || '');
    return urlLooksLikeNgrokFree(u) && probe.reason === 'html-not-audio' && probe.status === 200;
}

function looksLikeHlsUrl(url, contentType = '') {
    return (
        /\.m3u8(\?|#|$)/i.test(String(url || '')) ||
        /mpegurl|x-mpegURL|vnd\.apple\.mpegurl/i.test(String(contentType || ''))
    );
}

/** True when playlist text has at least one media segment (not an empty/stale shell). */
export function hlsPlaylistHasMedia(body) {
    const text = String(body || '');
    if (!/#EXTM3U/i.test(text)) return false;
    if (/#EXTINF:/i.test(text)) return true;
    // Master playlist — at least one variant line that isn't a comment.
    return /^[^#\s].+\.m3u8(\?.*)?$/im.test(text);
}

/**
 * Fetch a public HTTPS stream URL the way IMVU's client would (no ngrok-skip-browser-warning).
 * @param {string} pubUrl
 * @param {number} timeoutMs
 */
export async function probePublicStreamForImvu(pubUrl, timeoutMs = 6000) {
    const url = String(pubUrl || '').trim();
    if (!/^https:\/\//i.test(url)) {
        return { ok: false, reason: 'not-https', contentType: '', status: 0 };
    }
    try {
        const ac = AbortSignal.timeout(Math.max(2000, timeoutMs));
        const res = await fetch(url, {
            method: 'GET',
            signal: ac,
            redirect: 'follow',
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                Accept: '*/*',
                'Icy-Metadata': '1',
            },
        });
        const status = res.status;
        const ct = String(res.headers.get('content-type') || '');
        const ngrokErr = String(res.headers.get('ngrok-error-code') || '').trim();
        const asHls = looksLikeHlsUrl(url, ct);

        if (ngrokErr) {
            try {
                await res.body?.cancel();
            } catch {}
            return { ok: false, reason: 'ngrok-interstitial', contentType: ct, status, ngrokError: ngrokErr };
        }
        // Empty Icecast mount (tunnel OK) — Cloudflare often returns 400 + text/html, Icecast 404 + html.
        if (status === 404 || status === 400) {
            try {
                await res.body?.cancel();
            } catch {}
            return { ok: false, reason: 'mount-empty', contentType: ct, status };
        }
        if (/text\/html/i.test(ct) && !asHls) {
            try {
                await res.body?.cancel();
            } catch {}
            if (urlLooksLikeNgrokFree(url) && status === 200) {
                return { ok: false, reason: 'ngrok-interstitial', contentType: ct, status };
            }
            return { ok: false, reason: 'mount-empty', contentType: ct, status };
        }

        // HLS: 200 + m3u8 shell is common after encode dies — require real segments.
        if (asHls) {
            let body = '';
            try {
                body = await res.text();
            } catch {
                body = '';
            }
            if (status !== 200) {
                return { ok: false, reason: 'hls-bad-status', contentType: ct, status };
            }
            if (!hlsPlaylistHasMedia(body)) {
                return { ok: false, reason: 'hls-empty', contentType: ct, status };
            }
            return { ok: true, reason: 'hls', contentType: ct, status };
        }

        try {
            await res.body?.cancel();
        } catch {}

        if (
            status === 200 &&
            (/audio\//i.test(ct) ||
                /mpeg/i.test(ct) ||
                /octet-stream/i.test(ct) ||
                /^application\/ogg/i.test(ct))
        ) {
            return { ok: true, reason: 'audio', contentType: ct, status };
        }
        if (status === 200) {
            return { ok: true, reason: 'non-html-200', contentType: ct, status };
        }
        return { ok: false, reason: 'unexpected', contentType: ct, status };
    } catch (e) {
        return { ok: false, reason: e?.message || 'fetch-failed', contentType: '', status: 0 };
    }
}

/**
 * Probe a MUSIC_PUBLIC_STREAM_URL_TEMPLATE (with {room}) for IMVU client compatibility.
 * Empty Icecast mount (404) is OK — ngrok HTML interstitial is not.
 */
export async function verifyTunnelImvuCompatible(templateOrUrl) {
    const tpl = String(templateOrUrl || '').trim();
    if (!tpl) return { compatible: false, probe: null, message: 'empty-template' };
    const probeUrl = tpl.replace(/\{room\}/g, 'probe-imvu-compat');
    const probe = await probePublicStreamForImvu(probeUrl, 8000);

    if (probe.reason === 'ngrok-interstitial') {
        return {
            compatible: false,
            probe,
            message:
                'ngrok free tier blocks IMVU radio (ERR_NGROK_6024 HTML interstitial). Use CLOUDFLARE_TUNNEL_AUTO=1, ngrok paid/static domain, or another HTTPS URL IMVU can fetch without custom headers.',
        };
    }
    if (urlLooksLikeNgrokFree(probeUrl) && probe.reason === 'html-not-audio') {
        return {
            compatible: false,
            probe,
            message:
                'ngrok URL returns HTML instead of audio for browser clients. IMVU cannot play this stream — switch to Cloudflare quick tunnel.',
        };
    }
    if (probe.reason === 'mount-empty') {
        return { compatible: true, probe, message: 'tunnel-ok-mount-empty' };
    }
    return { compatible: probe.ok, probe, message: probe.ok ? 'ok' : probe.reason };
}
