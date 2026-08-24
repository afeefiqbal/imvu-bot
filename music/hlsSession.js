import fs from 'fs/promises';
import path from 'path';
import { createFfmpegHttpToHls } from './createFfmpegHls.js';
import { resolveIcecastWebroot } from './mp3FileExport.js';

function hlsEnabled() {
    return !/^(0|false|no|off)$/i.test(String(process.env.MUSIC_HLS_COLD ?? '1').trim());
}

export function isHlsColdEnabled() {
    return hlsEnabled();
}

/** IMVU radio uses only HLS m3u8 (no Icecast mount). Default on when MUSIC_HLS_COLD is on. */
export function isHlsOnlyEnabled() {
    const raw = String(process.env.MUSIC_HLS_ONLY ?? '').trim();
    if (/^(1|true|yes|on)$/i.test(raw)) return true;
    if (/^(0|false|no|off)$/i.test(raw)) return false;
    // Default: if cold HLS is enabled, IMVU is HLS-only.
    return hlsEnabled();
}

/**
 * Stable per-room live playlist: …/hls/{room}/live/index.m3u8
 * Song changes swap ffmpeg into that path; IMVU radio URL stays put.
 * Default on. Set MUSIC_HLS_STABLE_LIVE=0 for legacy per-play URLs.
 */
export function isHlsStableLiveEnabled() {
    return !/^(0|false|no|off)$/i.test(String(process.env.MUSIC_HLS_STABLE_LIVE ?? '1').trim());
}

/**
 * Public HLS playlist URL under the same HTTPS origin as Icecast public URL.
 * Stable live: /hls/{room}/live/index.m3u8
 * Legacy: /hls/{room}/{playToken}/index.m3u8
 */
export function buildHlsPublicUrl(publicStreamUrl, roomId, playToken) {
    const pub = String(publicStreamUrl || '').trim();
    if (!/^https:\/\//i.test(pub)) return '';
    const origin = new URL(pub).origin;
    const template = String(process.env.MUSIC_PUBLIC_HLS_URL_TEMPLATE || '').trim();
    const rid = String(roomId || 'room').replace(/[^0-9A-Za-z_-]/g, '') || 'room';
    const play = isHlsStableLiveEnabled()
        ? 'live'
        : String(playToken || Date.now()).replace(/[^0-9A-Za-z_-]/g, '') || String(Date.now());
    if (template) {
        return template
            .replaceAll('{room}', rid)
            .replaceAll('{play}', play)
            .replaceAll('{live}', 'live');
    }
    return `${origin}/hls/${rid}/${play}/index.m3u8`;
}

async function resolveHlsWebroot() {
    const explicit = String(process.env.MUSIC_HLS_WEBROOT || '').trim();
    if (explicit) {
        await fs.mkdir(explicit, { recursive: true });
        return explicit;
    }
    const ice = await resolveIcecastWebroot();
    if (ice) return ice;
    const fallback = path.join('/tmp', 'vibeverse-hls');
    await fs.mkdir(fallback, { recursive: true });
    return fallback;
}

/**
 * Atomically replace liveDir with prepDir contents (rename dance).
 * Caller must have stopped any ffmpeg still writing to liveDir.
 */
export async function promoteHlsPrepToLive(prepDir, liveDir) {
    const prep = String(prepDir || '').trim();
    const live = String(liveDir || '').trim();
    if (!prep || !live) throw new Error('promoteHlsPrepToLive requires prepDir + liveDir');
    const old = `${live}.old`;
    await fs.rm(old, { recursive: true, force: true }).catch(() => {});
    try {
        await fs.rename(live, old);
    } catch {
        await fs.rm(live, { recursive: true, force: true }).catch(() => {});
    }
    await fs.rename(prep, live);
    await fs.rm(old, { recursive: true, force: true }).catch(() => {});
}

/**
 * Wait until playlist exists and lists at least minSegments.
 * @param {string} playlistPath
 * @param {{ timeoutMs?: number, minSegments?: number, isStale?: () => boolean }} [opts]
 */
export async function waitForHlsPlaylist(playlistPath, opts = {}) {
    const timeoutMs = Math.max(3000, Number(opts.timeoutMs) || 12_000);
    const minSegments = Math.max(1, Number(opts.minSegments) || 1);
    const isStale = typeof opts.isStale === 'function' ? opts.isStale : () => false;
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
        if (isStale()) return false;
        try {
            const text = await fs.readFile(playlistPath, 'utf8');
            const segs = (text.match(/\.ts\b/g) || []).length;
            if (segs >= minSegments && /#EXTM3U/i.test(text)) return true;
        } catch {
            /* not ready */
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    return false;
}

/**
 * Start HLS from a validated audio URL (R2 signed or yt-dlp direct CDN).
 * Never starts ffmpeg without a real http(s) source — no poke-and-hope.
 *
 * Stable-live mode encodes into `live-next/`, then caller promotes to `live/`
 * after stopping the previous encode so IMVU keeps the same m3u8 URL.
 *
 * @param {{
 *   sourceUrl: string,
 *   roomId: string,
 *   publicStreamUrl: string,
 *   playToken?: string | number,
 *   isStale?: () => boolean,
 *   waitMs?: number,
 * }} opts
 */
export async function startHlsColdSession(opts) {
    if (!hlsEnabled()) {
        return { ok: false, reason: 'hls-disabled', detail: 'MUSIC_HLS_COLD is off' };
    }

    const sourceUrl = String(opts.sourceUrl || '').trim();
    const roomId = opts.roomId;
    const publicStreamUrl = opts.publicStreamUrl;
    const playToken = opts.playToken || Date.now();
    const isStale = typeof opts.isStale === 'function' ? opts.isStale : () => false;
    const stable = isHlsStableLiveEnabled();

    if (!/^https?:\/\//i.test(sourceUrl)) {
        return { ok: false, reason: 'bad-source', detail: 'HLS needs an http(s) source URL' };
    }

    // Unresolved extractor progressive URLs must not reach ffmpeg.
    if (/\/stream\/[\w-]{11}(\?|$)/i.test(sourceUrl) && opts.requireResolved !== false) {
        if (opts.resolved !== true && opts.progressiveReady !== true) {
            return {
                ok: false,
                reason: 'unresolved-source',
                detail: 'Refusing ffmpeg on unresolved progressive /stream URL',
            };
        }
    }

    const publicUrl = buildHlsPublicUrl(publicStreamUrl, roomId, playToken);
    if (!publicUrl) {
        return {
            ok: false,
            reason: 'no-public-url',
            detail: 'Need MUSIC_PUBLIC_STREAM_URL_TEMPLATE (or MUSIC_PUBLIC_HLS_URL_TEMPLATE) for HLS HTTPS URL',
        };
    }

    if (isStale()) return { ok: false, reason: 'stale' };

    const webroot = await resolveHlsWebroot();
    const rid = String(roomId || 'room').replace(/[^0-9A-Za-z_-]/g, '') || 'room';
    const liveDir = path.join(webroot, 'hls', rid, 'live');
    const prepDir = path.join(webroot, 'hls', rid, 'live-next');
    const legacyPlay = String(playToken).replace(/[^0-9A-Za-z_-]/g, '');
    const outDir = stable ? prepDir : path.join(webroot, 'hls', rid, legacyPlay);

    if (stable) {
        await fs.rm(prepDir, { recursive: true, force: true }).catch(() => {});
    }
    await fs.mkdir(outDir, { recursive: true });

    if (isStale()) {
        await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
        return { ok: false, reason: 'stale' };
    }

    console.log(
        JSON.stringify({
            event: 'ffmpeg_hls_start',
            roomId: rid,
            stable,
            outDir: stable ? 'live-next' : legacyPlay,
            source: sourceUrl.slice(0, 96),
        }),
    );

    let proc;
    try {
        // Always realtime-paced live HLS. VOD-without--re races ahead and
        // deletes segments before IMVU starts → silent radio URL.
        ({ proc } = createFfmpegHttpToHls({
            sourceUrl,
            outDir,
            segmentSeconds: Number(process.env.MUSIC_HLS_SEGMENT_SEC) || 2,
            playlistMode: 'live',
        }));
    } catch (e) {
        await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
        return {
            ok: false,
            reason: 'ffmpeg-spawn',
            detail: e?.message || 'ffmpeg HLS spawn failed',
        };
    }

    const playlistPath = path.join(outDir, 'index.m3u8');
    const defaultWait = /\/stream\//i.test(String(opts.sourceUrl || '')) ? 50_000 : 25_000;
    const waitMs = Math.max(
        4000,
        Number(opts.waitMs) ||
            parseInt(String(process.env.MUSIC_HLS_WAIT_MS || String(defaultWait)), 10) ||
            defaultWait,
    );
    const ready = await waitForHlsPlaylist(playlistPath, {
        timeoutMs: waitMs,
        // One complete segment is enough for first audio; waiting for 2 doubles cold start.
        minSegments: Math.max(1, Number(process.env.MUSIC_HLS_MIN_SEGMENTS) || 1),
        isStale,
    });

    if (isStale() || !ready) {
        try {
            proc.kill('SIGKILL');
        } catch {}
        await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
        return {
            ok: false,
            reason: isStale() ? 'stale' : 'hls-not-ready',
            detail: isStale()
                ? 'Superseded'
                : 'HLS playlist did not become ready in time (check source URL + webroot HTTPS).',
        };
    }

    console.log(
        JSON.stringify({
            event: 'ffmpeg_hls_first_segment',
            roomId: rid,
            publicUrl,
            stable,
        }),
    );

    /** Kill encode; only delete prep/legacy dirs — never wipe active `live/` mid-listen. */
    const cleanup = async () => {
        try {
            proc.kill('SIGKILL');
        } catch {}
        if (stable) {
            // If promote already moved prep→live, prep is gone; if not, drop abandoned prep.
            await fs.rm(prepDir, { recursive: true, force: true }).catch(() => {});
        } else {
            await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
        }
    };

    const promote = stable
        ? async () => {
              await promoteHlsPrepToLive(prepDir, liveDir);
              console.log(
                  JSON.stringify({
                      event: 'hls_live_promoted',
                      roomId: rid,
                      publicUrl,
                  }),
              );
          }
        : null;

    console.log(`[music] HLS ready: ${publicUrl}${stable ? ' (stable /live — promote on cutover)' : ''}`);
    return { ok: true, publicUrl, proc, cleanup, promote, stable };
}
