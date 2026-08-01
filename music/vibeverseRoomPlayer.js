import { createTrackQueue } from './queue.js';
import { applyRoomMediaStreamUrl, waitForRoomMediaPlayback } from './imvuRoomMediaDom.js';
import { notifyImvuMusicState } from './notifyImvuMusicApi.js';
import {
    fetchRandomVibeversePlayable,
    playVibeverseTrack,
    refreshVibeverseStream,
} from './vibeverseClient.js';
import { createFfmpegFileToIcecast, createFfmpegHttpToIcecast } from './ffmpegIcecast.js';
import { downloadToTemp } from './downloadToTemp.js';
import { loadStreamConfig, withPerPlayStreamMount } from './loadStreamConfig.js';
import { withIcecastMountEncodeLock } from './icecastMountLock.js';
import {
    icecastDestFromConfig,
    icecastStatusJsonShowsSource,
    waitForIcecastMountLive,
} from './icecastLive.js';
import { isHlsColdEnabled, isHlsOnlyEnabled, startHlsColdSession } from './hlsSession.js';
import { probePublicStreamForImvu } from './verifyImvuStreamUrl.js';

function envFlagTrue(name, defaultOn = false) {
    const raw = process.env[name];
    if (raw == null || String(raw).trim() === '') return defaultOn;
    return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

/** Optional comma/space allowlist — empty means any room may use autoplay once armed. */
function roomAllowedForAutoplay(roomId) {
    const raw = String(process.env.MUSIC_AUTOPLAY_ROOMS || '').trim();
    if (!raw) return true;
    const want = new Set(
        raw
            .split(/[,\s]+/)
            .map((s) => s.trim())
            .filter(Boolean),
    );
    return want.has(String(roomId || '').trim());
}

/**
 * IMVU room player (hybrid HLS when MUSIC_HLS_COLD):
 *   - R2 warm → ffmpeg → m3u8 (fast)
 *   - Cold → progressive URL → ffmpeg → m3u8 ASAP (R2 fills in background)
 * Icecast mount encode is skipped in HLS-only mode.
 */
/**
 * @param {{
 *   roomId: string,
 *   apiBaseUrl: string,
 *   botName?: string,
 *   page?: object | null,
 *   sessionClient?: object | null,
 * }} opts
 */
export function createVibeverseRoomPlayer(opts) {
    const { roomId, apiBaseUrl, botName, page, sessionClient, onAnnounce } = opts;
    const queue = createTrackQueue();

    let playing = false;
    let paused = false;
    /** @type {import('child_process').ChildProcess | null} */
    let ffProc = null;
    /** @type {(() => Promise<void>) | null} */
    let tempCleanup = null;
    /** @type {(() => Promise<void>) | null} */
    let hlsCleanup = null;
    /**
     * Previous encode kept alive during !play lookup/HLS warmup so room audio
     * does not go silent until the new m3u8 is ready to apply.
     * @type {import('child_process').ChildProcess | null}
     */
    let outgoingProc = null;
    /** @type {(() => Promise<void>) | null} */
    let outgoingCleanup = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let endTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let autoplayRetryTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let idleKickTimer = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    let idleWatchInterval = null;
    /** @type {Promise<void>} */
    let drainTail = Promise.resolve();
    let generation = 0;
    /** @type {object | null} */
    let activeStreamCfg = null;
    /** Last IMVU radio URL we successfully applied (stable /live skips rewrite). */
    let lastRoomRadioUrl = '';
    /** Cache station_url liveness so idle polls don't hammer dead links. */
    let radioUrlProbe = { url: '', at: 0, alive: /** @type {boolean|null} */ (null) };
    /**
     * Idle autoplay fills the queue when armed. Armed by default (and after !play/!add);
     * only !autoplay-off opts out until the next !play/!add.
     */
    let autoplayArmed = envFlagTrue('MUSIC_AUTOPLAY', true) && roomAllowedForAutoplay(roomId);
    /** Chat `!autoplay-off` — do not auto-start until !play/!add. */
    let autoplayOptedOut = false;
    /** @type {string[]} */
    const recentAutoplayIds = [];
    let autoplayFailStreak = 0;
    /**
     * Cache whether this bot can set room radio (host/mod).
     * null = unknown, true/false = last check. Forbidden sticks until a successful radio set.
     * @type {{ at: number, ok: boolean|null, forbidden: boolean }}
     */
    let radioControl = { at: 0, ok: null, forbidden: false };

    const idleDelayMs = () =>
        Math.max(0, parseInt(String(process.env.MUSIC_AUTOPLAY_IDLE_MS || '3000'), 10) || 3000);

    const clearEndTimer = () => {
        if (endTimer) {
            clearTimeout(endTimer);
            endTimer = null;
        }
    };

    const clearAutoplayRetry = () => {
        if (autoplayRetryTimer) {
            clearTimeout(autoplayRetryTimer);
            autoplayRetryTimer = null;
        }
    };

    const clearIdleKick = () => {
        if (idleKickTimer) {
            clearTimeout(idleKickTimer);
            idleKickTimer = null;
        }
    };

    const botBusyLocally = () =>
        Boolean(
            paused ||
                playing ||
                ffProc ||
                outgoingProc ||
                endTimer ||
                queue.getCurrent() ||
                queue.peek(),
        );

    /** @returns {Promise<boolean|null>} true=playing, false=off, null=unknown */
    const roomRadioPlaying = async () => {
        if (typeof sessionClient?.fetchRoomMediaPlaybackState !== 'function') return null;
        try {
            const st = await sessionClient.fetchRoomMediaPlaybackState(roomId);
            if (!st?.ok) return null;
            const status = String(st.status || '').toLowerCase();
            const url = String(st.stationUrl || '').trim();
            if (status !== 'playing' || !url) return false;

            // We are actively encoding / draining — treat as playing.
            if (botBusyLocally()) return true;

            // IMVU often leaves status=playing with a stale station_url (dead tunnel / empty
            // mount) while the room is silent. Probe before blocking idle autoplay.
            const now = Date.now();
            const probeTtlMs = Math.max(
                5000,
                parseInt(String(process.env.MUSIC_RADIO_PROBE_CACHE_MS || '20000'), 10) || 20000,
            );
            if (
                radioUrlProbe.url === url &&
                radioUrlProbe.alive != null &&
                now - radioUrlProbe.at < probeTtlMs
            ) {
                return radioUrlProbe.alive;
            }

            const probe = await probePublicStreamForImvu(url, 4500);
            const alive = probe?.ok === true;
            radioUrlProbe = { url, at: now, alive };
            if (!alive) {
                console.log(
                    `[music] room radio link silent/stale (${roomId}): ${probe?.reason || 'unreachable'}` +
                        ` — allowing autoplay`,
                );
            }
            return alive;
        } catch {
            return null;
        }
    };

    const scheduleAutoplayRetry = () => {
        clearAutoplayRetry();
        if (autoplayOptedOut || !autoplayArmed || paused || radioControl.forbidden) return;
        const ms = Math.max(
            5000,
            parseInt(String(process.env.MUSIC_AUTOPLAY_RETRY_MS || '15000'), 10) || 15000,
        );
        autoplayRetryTimer = setTimeout(() => {
            autoplayRetryTimer = null;
            if (autoplayOptedOut || !autoplayArmed || paused || radioControl.forbidden) return;
            // Soft cutover parks prior encode in outgoingProc — still busy.
            if (botBusyLocally()) return;
            console.log(`[music] autoplay retry (${roomId})`);
            void enqueueDrain();
        }, ms);
    };

    const announce = (text) => {
        const msg = String(text || '').trim();
        if (!msg || typeof onAnnounce !== 'function') return;
        void Promise.resolve(onAnnounce(msg)).catch((e) => {
            console.warn('[music] autoplay announce:', e?.message || e);
        });
    };

    const armAutoplay = (reason = 'user') => {
        autoplayOptedOut = false;
        // Only explicit !play/!add may retry after a hard radio-control forbid.
        if (radioControl.forbidden && /^(!play|!add|manual)/i.test(String(reason || ''))) {
            radioControl = { at: 0, ok: null, forbidden: false };
        }
        if (!autoplayArmed) {
            console.log(`[music] autoplay armed (${roomId}): ${reason}`);
        }
        autoplayArmed = true;
    };

    const disarmAutoplay = () => {
        if (autoplayArmed) {
            console.log(`[music] autoplay disarmed (${roomId})`);
        }
        autoplayArmed = false;
        autoplayFailStreak = 0;
        clearAutoplayRetry();
        clearIdleKick();
    };

    const markRadioControlOk = () => {
        radioControl = { at: Date.now(), ok: true, forbidden: false };
    };

    const markRadioControlForbidden = (reason = 'not-moderator') => {
        if (!radioControl.forbidden) {
            console.log(`[music] autoplay disabled (${roomId}): bot is not host/mod (${reason})`);
        }
        radioControl = { at: Date.now(), ok: false, forbidden: true };
        disarmAutoplay();
    };

    const isRadioControlDeniedReason = (reason, detail = '') => {
        const r = String(reason || '');
        const d = String(detail || '');
        return (
            r === 'not-moderator' ||
            r === 'not-authorized' ||
            r === 'radio-player-not-found' ||
            /MEDIA_PLAYER_NODE-004|host or moderator|must be host/i.test(`${r} ${d}`)
        );
    };

    /**
     * Prefer a real host/mod roster check. Empty mod lists are treated as unknown
     * (allow one apply attempt); IMVU denials still mark forbidden.
     * @returns {Promise<boolean>}
     */
    const botCanSetRoomRadio = async () => {
        if (radioControl.forbidden) return false;
        const ttl = Math.max(
            15_000,
            parseInt(String(process.env.MUSIC_AUTOPLAY_MOD_CHECK_MS || '60000'), 10) || 60_000,
        );
        if (radioControl.ok === true && Date.now() - radioControl.at < ttl) {
            return true;
        }
        if (radioControl.ok === false && Date.now() - radioControl.at < ttl) {
            return false;
        }
        if (
            typeof sessionClient?.resolveBotUserId !== 'function' ||
            typeof sessionClient?.fetchRoomOwnerId !== 'function'
        ) {
            return true;
        }
        try {
            const botId = String((await sessionClient.resolveBotUserId()) || '').trim();
            if (!botId) return false;

            const roomOwnerPrefix = String(roomId || '')
                .trim()
                .replace(/^room-/i, '')
                .split('-')[0];
            if (roomOwnerPrefix && roomOwnerPrefix === botId) {
                radioControl = { at: Date.now(), ok: true, forbidden: false };
                return true;
            }

            const ownerId = String((await sessionClient.fetchRoomOwnerId(roomId)) || '').trim();
            if (ownerId && ownerId === botId) {
                radioControl = { at: Date.now(), ok: true, forbidden: false };
                return true;
            }

            const modIds =
                typeof sessionClient.fetchRoomModeratorIds === 'function'
                    ? await sessionClient.fetchRoomModeratorIds(roomId)
                    : [];
            const mods = Array.isArray(modIds) ? modIds.map(String) : [];
            if (mods.length > 0) {
                const ok = mods.includes(botId);
                radioControl = { at: Date.now(), ok, forbidden: !ok };
                if (!ok) {
                    console.log(
                        `[music] autoplay skip (${roomId}): bot ${botId} is not host/mod (roster)`,
                    );
                    disarmAutoplay();
                }
                return ok;
            }

            // Empty roster — unknown. Allow a quiet apply attempt (no chat until success).
            return true;
        } catch (e) {
            console.warn(`[music] host/mod check failed (${roomId}):`, e?.message || e);
            return !radioControl.forbidden;
        }
    };

    /** After music goes idle/off — wait 3s (cancellable via !autoplay-off), then fill. */
    const scheduleIdleAutoplay = (reason = 'idle') => {
        clearIdleKick();
        if (autoplayOptedOut || paused || radioControl.forbidden) return;
        if (!envFlagTrue('MUSIC_AUTOPLAY', true) || !roomAllowedForAutoplay(roomId)) return;
        if (botBusyLocally()) return;
        const ms = idleDelayMs();
        console.log(`[music] idle autoplay scheduled in ${ms}ms (${roomId}): ${reason}`);
        idleKickTimer = setTimeout(() => {
            idleKickTimer = null;
            void kickIdleAutoplay(reason);
        }, ms);
    };

    const kickIdleAutoplay = async (reason = 'idle') => {
        if (autoplayOptedOut || paused) return;
        if (!envFlagTrue('MUSIC_AUTOPLAY', true) || !roomAllowedForAutoplay(roomId)) return;
        if (botBusyLocally()) return;
        if (!(await botCanSetRoomRadio())) {
            console.log(`[music] idle autoplay skip (${roomId}): not host/mod`);
            return;
        }
        const radioOn = await roomRadioPlaying();
        if (radioOn === true) {
            console.log(`[music] idle autoplay skip (${roomId}): room radio already playing`);
            return;
        }
        armAutoplay(reason);
        console.log(`[music] idle autoplay kick (${roomId}): ${reason}`);
        void enqueueDrain();
    };

    const startIdleWatcher = () => {
        if (idleWatchInterval) return;
        const pollMs = Math.max(
            5000,
            parseInt(String(process.env.MUSIC_AUTOPLAY_IDLE_POLL_MS || '15000'), 10) || 15000,
        );
        idleWatchInterval = setInterval(() => {
            if (autoplayOptedOut || paused || radioControl.forbidden || botBusyLocally() || idleKickTimer) {
                return;
            }
            void (async () => {
                if (!(await botCanSetRoomRadio())) return;
                const radioOn = await roomRadioPlaying();
                if (radioOn === true) return;
                // Room radio off/unknown and bot idle → start after delay.
                scheduleIdleAutoplay(radioOn === false ? 'room-radio-off' : 'idle-poll');
            })();
        }, pollMs);
        if (typeof idleWatchInterval.unref === 'function') idleWatchInterval.unref();
    };

    const rememberAutoplayId = (trackId) => {
        const id = String(trackId || '').trim();
        if (!id) return;
        recentAutoplayIds.push(id);
        while (recentAutoplayIds.length > 24) recentAutoplayIds.shift();
    };

    /** When the queue is empty and armed, fetch a random READY/trending track. */
    const maybeEnqueueAutoplayTrack = async () => {
        if (queue.peek()) return true;
        if (paused) {
            console.log(`[music] autoplay skip (${roomId}): paused`);
            return false;
        }
        if (!envFlagTrue('MUSIC_AUTOPLAY', true)) {
            console.warn(
                `[music] autoplay skip (${roomId}): MUSIC_AUTOPLAY is off — set MUSIC_AUTOPLAY=1 in .env`,
            );
            return false;
        }
        if (autoplayOptedOut) {
            console.log(`[music] autoplay skip (${roomId}): !autoplay-off`);
            return false;
        }
        if (!autoplayArmed) {
            console.log(`[music] autoplay skip (${roomId}): not armed`);
            return false;
        }
        if (!roomAllowedForAutoplay(roomId)) {
            console.warn(
                `[music] autoplay skip (${roomId}): room not in MUSIC_AUTOPLAY_ROOMS`,
            );
            return false;
        }
        if (!(await botCanSetRoomRadio())) {
            console.log(`[music] autoplay skip (${roomId}): not host/mod`);
            return false;
        }
        if (autoplayFailStreak >= 5) {
            console.warn(
                `[music] autoplay paused in ${roomId} after ${autoplayFailStreak} failed picks`,
            );
            scheduleAutoplayRetry();
            return false;
        }

        console.log(`[music] autoplay filling empty queue (${roomId})…`);
        let pick = null;
        try {
            pick = await fetchRandomVibeversePlayable({
                excludeIds: recentAutoplayIds,
                roomId,
            });
        } catch (e) {
            console.warn(`[music] autoplay fetch failed (${roomId}):`, e?.message || e);
            autoplayFailStreak += 1;
            scheduleAutoplayRetry();
            return false;
        }
        if (!pick?.streamUrl) {
            autoplayFailStreak += 1;
            console.warn(`[music] autoplay: no playable track for ${roomId}`);
            scheduleAutoplayRetry();
            return false;
        }

        autoplayFailStreak = 0;
        clearAutoplayRetry();
        rememberAutoplayId(pick.trackId);
        console.log(`[music] idle autoplay (${roomId}): ${pick.title}`);
        queue.enqueue({
            trackId: pick.trackId,
            title: pick.title,
            artistName: pick.artistName,
            artworkUrl: pick.artworkUrl,
            durationMs: pick.durationMs,
            streamUrl: pick.streamUrl,
            cached: pick.cached,
            progressiveReady: pick.progressiveReady,
            delivery: pick.delivery,
            autoplay: true,
            // Announce only after room radio URL is actually set.
            announceOnRadioOk: true,
        });
        return true;
    };

    const clearTempFile = () => {
        const fn = tempCleanup;
        tempCleanup = null;
        if (fn) void fn().catch(() => {});
        const h = hlsCleanup;
        hlsCleanup = null;
        if (h) void h().catch(() => {});
    };

    const discardOutgoing = () => {
        const proc = outgoingProc;
        const cleanup = outgoingCleanup;
        outgoingProc = null;
        outgoingCleanup = null;
        if (proc) {
            try {
                proc.kill('SIGKILL');
            } catch {}
        }
        if (cleanup) void cleanup().catch(() => {});
    };

    /** Park the live encode without killing it (room keeps hearing the old m3u8). */
    const parkCurrentEncode = () => {
        discardOutgoing();
        if (!ffProc && !hlsCleanup) return;
        outgoingProc = ffProc;
        outgoingCleanup = hlsCleanup;
        ffProc = null;
        hlsCleanup = null;
        // tempCleanup belongs to the outgoing encode's lifecycle via hlsCleanup/ffmpeg exit.
    };

    /** Restore a parked encode after a failed replace so the old song keeps playing. */
    const restoreOutgoing = () => {
        if (!outgoingProc && !outgoingCleanup) return false;
        killCurrentEncodeOnly();
        ffProc = outgoingProc;
        hlsCleanup = outgoingCleanup;
        outgoingProc = null;
        outgoingCleanup = null;
        return true;
    };

    const killCurrentEncodeOnly = () => {
        if (!ffProc) {
            clearTempFile();
            return;
        }
        try {
            ffProc.kill('SIGKILL');
        } catch {}
        ffProc = null;
        clearTempFile();
    };

    const killFf = () => {
        discardOutgoing();
        killCurrentEncodeOnly();
    };

    /** Best-effort: stop IMVU room radio so the current song cuts immediately. */
    const stopRoomRadioQuiet = () => {
        if (typeof sessionClient?.stopRoomRadioStream !== 'function') return;
        void sessionClient.stopRoomRadioStream(roomId).catch(() => {});
    };

    /**
     * Soft-preempt for !play: invalidate in-flight work and clear the queue,
     * but keep the current encode + room radio until the new track's HLS is live.
     * Hard stop still happens in stop()/skip() and at URL cutover in playViaHls.
     */
    const cutForReplace = () => {
        clearEndTimer();
        generation += 1;
        queue.clearPending();
        paused = false;
        // Re-arm natural end advance under the new generation so a failed !play
        // still advances when the parked/current encode finishes.
        if (ffProc && queue.getCurrent()) {
            scheduleAdvanceOnFfExit(queue.getCurrent(), generation, ffProc);
        } else if (outgoingProc && queue.getCurrent()) {
            scheduleAdvanceOnFfExit(queue.getCurrent(), generation, outgoingProc);
        }
    };

    const notify = (track, state) => {
        void notifyImvuMusicState({
            apiBaseUrl,
            roomId,
            botName,
            track: track
                ? {
                      title: track.title,
                      url: track.streamUrl || track.url || '',
                  }
                : null,
            state,
        });
    };

    const loadConfig = () => loadStreamConfig({ apiBaseUrl, roomId });

    const urlsMatch = (a, b) => {
        const norm = (u) =>
            String(u || '')
                .trim()
                .replace(/\/+$/, '')
                .toLowerCase();
        return Boolean(norm(a) && norm(a) === norm(b));
    };

    const applyPublicUrlToRoom = async (publicUrl, track, opts = {}) => {
        const url = String(publicUrl || '').trim();
        if (!/^https:\/\//i.test(url)) {
            return { ok: false, reason: 'no-public-url', detail: 'Icecast HTTPS public URL is not configured.' };
        }

        // Stable /live: if IMVU is already on this URL, skip stop→clear→update→start (~8–10s).
        if (opts.skipIfSame !== false) {
            if (urlsMatch(lastRoomRadioUrl, url)) {
                console.log(`[music] room ${roomId} already on stable URL — skip radio rewrite`);
                return { ok: true, reason: 'url-unchanged-cached' };
            }
            if (typeof sessionClient?.fetchRoomMediaPlaybackState === 'function') {
                try {
                    const st = await sessionClient.fetchRoomMediaPlaybackState(roomId);
                    if (st?.ok && urlsMatch(st.stationUrl, url) && /playing/i.test(String(st.status || ''))) {
                        lastRoomRadioUrl = url;
                        console.log(`[music] room ${roomId} already playing stable URL — skip radio rewrite`);
                        return { ok: true, reason: 'url-unchanged-live' };
                    }
                } catch {
                    /* fall through to apply */
                }
            }
        }

        console.log(`[music] applying live stream URL to room ${roomId}: ${url}`);
        const applied = await applyRoomMediaStreamUrl(page, url, {
            sessionClient,
            roomId,
            stationName: String(track?.title || '').trim(),
            forceRestart: opts.forceRestart === true,
        });
        if (!applied.ok) {
            const reason = String(applied.reason || '');
            const detail = String(applied.detail || '');
            if (isRadioControlDeniedReason(reason, detail)) {
                markRadioControlForbidden(reason || 'not-moderator');
            }
            return applied;
        }
        markRadioControlOk();
        lastRoomRadioUrl = url;
        if (track?.announceOnRadioOk || track?.autoplay) {
            track.announceOnRadioOk = false;
            announce(`▶ Autoplay: ${track?.title || 'track'}`);
        }
        // Don't block chat on IMVU playback confirmation — announce as soon as the URL is set.
        void waitForRoomMediaPlayback(page, {
            roomId,
            expectedUrl: url,
            timeoutMs: 4_000,
            intervalMs: 1000,
            sessionClient,
        }).catch(() => ({ ok: false }));
        return applied;
    };

    const useHlsPath = (track) => {
        if (track?.delivery === 'hls' && /\.m3u8(\?|$)/i.test(String(track?.streamUrl || ''))) {
            // Extractor already produced live m3u8 — thin client path.
            return false;
        }
        if (isHlsOnlyEnabled()) return true;
        if (!isHlsColdEnabled()) return false;
        if (track?.delivery === 'hls') return true;
        if (track?.cached === false) return true;
        const url = String(track?.streamUrl || '');
        return /\/stream\/[\w-]{11}(\?|$)/i.test(url);
    };

    const vibeverseLiveMode = () =>
        /^(1|true|yes|on)$/i.test(String(process.env.MUSIC_VIBEVERSE_LIVE || '').trim());

    /**
     * Hit the live playlist once before radio apply so extractor can cold-restart
     * from 0 (encode otherwise runs ahead during search/cutover → mid-song).
     */
    const primeExtractorLiveHls = async (url) => {
        const u = String(url || '').trim();
        if (!/^https:\/\//i.test(u)) return;
        const started = Date.now();
        const timeoutMs = Math.max(
            8_000,
            parseInt(String(process.env.MUSIC_HLS_PRIME_TIMEOUT_MS || '20000'), 10) || 20_000,
        );
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        try {
            const res = await fetch(u, {
                method: 'GET',
                headers: {
                    Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
                    'Cache-Control': 'no-cache',
                },
                signal: ac.signal,
            });
            const text = res.ok ? await res.text() : '';
            const segs = (text.match(/\.ts\b/g) || []).length;
            console.log(
                `[music] primed live HLS (${Date.now() - started}ms, http=${res.status}, segs=${segs}): ${u}`,
            );
        } catch (e) {
            console.warn(`[music] live HLS prime failed:`, e?.message || e);
        } finally {
            clearTimeout(timer);
        }
    };

    /** Extractor owns ffmpeg; bot only sets IMVU room radio to the live m3u8. */
    const playViaExtractorLive = async (track, gen) => {
        const url = String(track?.streamUrl || '').trim();
        if (!/^https:\/\//i.test(url) || !/\.m3u8(\?|$)/i.test(url)) {
            return {
                ok: false,
                reason: 'not-live-hls',
                detail: 'Expected extractor live m3u8 URL',
            };
        }
        console.log(`[music] extractor live HLS — set room radio only: ${url}`);
        discardOutgoing();
        killCurrentEncodeOnly();
        // Restart encode near t=0, then force IMVU cutover (flash-clear) so
        // in-room clients reload without leaving/rejoining.
        await primeExtractorLiveHls(url);
        if (gen !== generation) return { ok: false, reason: 'stale' };
        const applied = await applyPublicUrlToRoom(url, track, {
            skipIfSame: false,
            forceRestart: true,
        });
        if (gen !== generation) return { ok: false, reason: 'stale' };
        if (!applied.ok) {
            if (track?.autoplay) {
                playing = false;
                queue.setCurrent(null);
                notify(null, 'idle');
                // Do not keep retrying autoplay when we cannot control room radio.
                if (isRadioControlDeniedReason(applied.reason, applied.detail)) {
                    clearAutoplayRetry();
                    clearIdleKick();
                }
            }
            return applied;
        }
        playing = true;
        // No local ffmpeg — advance on duration timer.
        clearEndTimer();
        const ms = Number(track?.durationMs) || 0;
        const waitMs = Math.max(30_000, (ms > 0 ? ms : 180_000) + 5_000);
        endTimer = setTimeout(() => {
            if (gen !== generation || paused) return;
            console.log(`[music] extractor-live timer — advancing: ${track?.title || '?'}`);
            queue.setCurrent(null);
            playing = false;
            notify(null, 'idle');
            void enqueueDrain();
        }, waitMs);
        return { ok: true, track };
    };

    const playViaHls = async (track, gen, pub) => {
        const isStale = () => gen !== generation;
        const src = String(track?.streamUrl || '');
        const kind = track?.cached
            ? 'R2'
            : track?.progressiveReady
              ? 'resolved'
              : /\/stream\//i.test(src)
                ? 'progressive'
                : 'direct';
        console.log(`[music] HLS: ${kind} → m3u8 for “${track?.title || '?'}”`);
        const session = await startHlsColdSession({
            sourceUrl: track.streamUrl,
            roomId,
            publicStreamUrl: pub,
            playToken: Date.now(),
            isStale,
            progressiveReady: track?.progressiveReady === true,
            resolved: track?.progressiveReady === true || track?.cached === true,
            waitMs:
                Number(process.env.MUSIC_HLS_WAIT_READY_MS) ||
                (track?.progressiveReady || track?.cached ? 12_000 : 25_000),
        });
        if (isStale()) {
            if (session.cleanup) await session.cleanup().catch(() => {});
            return { ok: false, reason: 'stale' };
        }
        if (!session.ok || !session.publicUrl || !session.proc) {
            // Keep previous song playing if we parked it during !play.
            if (outgoingProc || outgoingCleanup) {
                restoreOutgoing();
                playing = true;
                console.log('[music] HLS failed — restored previous encode (room radio unchanged)');
            }
            return {
                ok: false,
                reason: session.reason || 'hls-failed',
                detail: session.detail || 'HLS start failed',
            };
        }

        // Cut over only when the new playlist is ready.
        console.log(
            `[music] HLS ready — cutting over${session.stable ? ' (promote live-next → live)' : ' room radio URL'}`,
        );
        discardOutgoing();
        killCurrentEncodeOnly();
        if (typeof session.promote === 'function') {
            try {
                await session.promote();
            } catch (e) {
                if (session.cleanup) await session.cleanup().catch(() => {});
                return {
                    ok: false,
                    reason: 'hls-promote-failed',
                    detail: e?.message || 'Failed to promote HLS live dir',
                };
            }
        }
        hlsCleanup = session.cleanup || null;
        ffProc = session.proc;

        const applied = await applyPublicUrlToRoom(session.publicUrl, track);
        if (isStale()) {
            killFf();
            return { ok: false, reason: 'stale' };
        }
        if (!applied.ok) {
            killFf();
            return applied;
        }

        console.log(
            JSON.stringify({
                event: 'room_url_updated',
                roomId,
                publicUrl: session.publicUrl,
                skippedRewrite: /url-unchanged/i.test(String(applied.reason || '')),
            }),
        );
        console.log(
            `[music] HLS live — room radio ${/url-unchanged/i.test(String(applied.reason || '')) ? 'unchanged at' : 'set to'} ${session.publicUrl}`,
        );
        scheduleAdvanceOnFfExit(track, gen, session.proc);
        return { ok: true, track };
    };

    const scheduleAdvanceOnFfExit = (track, gen, proc) => {
        clearEndTimer();
        const ms = Number(track?.durationMs) || 0;
        // Safety net if ffmpeg hangs after the track; primary advance is proc exit.
        const waitMs = Math.max(30_000, (ms > 0 ? ms : 180_000) + 15_000);
        endTimer = setTimeout(() => {
            if (gen !== generation || paused) return;
            console.log(`[music] track timer elapsed — advancing: ${track?.title || '?'}`);
            killFf();
            queue.setCurrent(null);
            playing = false;
            notify(null, 'idle');
            void enqueueDrain();
        }, waitMs);

        proc.once('exit', (code, sig) => {
            if (gen !== generation) return;
            console.log(
                `[music] live encode ended (code=${code}, signal=${sig || 'none'}): ${track?.title || '?'}`,
            );
            if (ffProc === proc) ffProc = null;
            clearTempFile();
            clearEndTimer();
            if (paused) return;
            queue.setCurrent(null);
            playing = false;
            notify(null, 'idle');
            void enqueueDrain();
        });
    };

    const playCurrentOrNext = async (opts = {}) => {
        const gen = ++generation;
        clearEndTimer();
        const keepOutgoing = opts.keepOutgoing === true;
        if (!keepOutgoing) {
            killFf();
        }
        // When keepOutgoing, previous encode is already parked in outgoingProc.

        let track = queue.getCurrent();
        if (!track) {
            track = queue.dequeue();
            if (track) queue.setCurrent(track);
        }
        if (!track) {
            const filled = await maybeEnqueueAutoplayTrack();
            if (filled) {
                track = queue.dequeue();
                if (track) queue.setCurrent(track);
            }
        }
        if (!track) {
            if (!keepOutgoing) killFf();
            playing = false;
            paused = false;
            notify(null, 'idle');
            scheduleAutoplayRetry();
            return { ok: true, empty: true };
        }

        if (!track.streamUrl && track.trackId) {
            const fresh = await playVibeverseTrack(
                {
                    id: track.trackId,
                    title: track.title,
                    artistName: track.artistName,
                    artworkUrl: track.artworkUrl,
                    durationMs: track.durationMs,
                },
                { roomId },
            );
            if (gen !== generation) return { ok: false, reason: 'stale' };
            if (fresh?.ok && fresh.track) Object.assign(track, fresh.track);
            else if (fresh?.streamUrl) Object.assign(track, fresh);
        }

        if (!track.streamUrl) {
            console.warn('[music] skip unplayable track:', track.title);
            if (gen !== generation) return { ok: false, reason: 'stale' };
            queue.setCurrent(null);
            if (track.autoplay) {
                autoplayFailStreak += 1;
                scheduleAutoplayRetry();
            }
            return playCurrentOrNext();
        }

        if (gen !== generation) return { ok: false, reason: 'stale' };

        // Phase 3: extractor already returned live m3u8 — skip local ffmpeg/Icecast.
        if (
            vibeverseLiveMode() ||
            (track.delivery === 'hls' && /\.m3u8(\?|$)/i.test(String(track.streamUrl || '')))
        ) {
            paused = false;
            playing = true;
            notify(track, 'playing');
            return playViaExtractorLive(track, gen);
        }

        const baseCfg = await loadConfig();
        if (gen !== generation) return { ok: false, reason: 'stale' };
        if (!baseCfg?.enabled) {
            playing = false;
            queue.setCurrent(null);
            notify(null, 'idle');
            return {
                ok: false,
                reason: 'icecast-disabled',
                detail: 'Live radio needs Icecast enabled (MUSIC_ENABLED / ICECAST_*).',
            };
        }

        activeStreamCfg = withPerPlayStreamMount(baseCfg, roomId, Date.now());
        const pub = String(activeStreamCfg.publicStreamUrl || '').trim();
        if (!/^https:\/\//i.test(pub)) {
            playing = false;
            queue.setCurrent(null);
            notify(null, 'idle');
            return {
                ok: false,
                reason: 'no-public-url',
                detail:
                    'Live radio needs MUSIC_PUBLIC_STREAM_URL_TEMPLATE or an Icecast HTTPS tunnel (CLOUDFLARE_TUNNEL_AUTO=1).',
            };
        }

        paused = false;
        playing = true;
        notify(track, 'playing');

        // Hybrid HLS (default): R2 or progressive → m3u8. No Icecast mount in HLS-only mode.
        if (useHlsPath(track)) {
            let hlsResult = await playViaHls(track, gen, pub);
            if (hlsResult?.ok || hlsResult?.reason === 'stale') return hlsResult;

            // Retry once with a fresh durable URL if the first source failed.
            if (track.trackId) {
                console.warn(
                    `[music] HLS failed (${hlsResult?.reason || 'unknown'}) — refreshing durable URL and retrying HLS`,
                );
                const durable = await playVibeverseTrack(
                    {
                        id: track.trackId,
                        title: track.title,
                        artistName: track.artistName,
                        artworkUrl: track.artworkUrl,
                        durationMs: track.durationMs,
                    },
                    { forceDurable: true, roomId },
                );
                if (gen !== generation) return { ok: false, reason: 'stale' };
                const t = durable?.track || (durable?.streamUrl ? durable : null);
                if (durable?.ok && t?.streamUrl && !/\/stream\/[\w-]{11}(\?|$)/i.test(String(t.streamUrl))) {
                    Object.assign(track, t, { delivery: 'hls', cached: true });
                    hlsResult = await playViaHls(track, gen, pub);
                    if (hlsResult?.ok || hlsResult?.reason === 'stale') return hlsResult;
                }
            }

            // playViaHls already restored outgoing on failure when parked.
            if (!(outgoingProc || ffProc)) {
                playing = false;
                queue.setCurrent(null);
                notify(null, 'idle');
            }
            return hlsResult || { ok: false, reason: 'hls-failed' };
        }

        // Leaving HLS path — drop any parked encode before Icecast.
        discardOutgoing();
        killCurrentEncodeOnly();

        if (isHlsOnlyEnabled()) {
            playing = false;
            queue.setCurrent(null);
            notify(null, 'idle');
            return {
                ok: false,
                reason: 'hls-failed',
                detail: 'HLS-only mode is on but HLS path was skipped',
            };
        }

        const iceDest = icecastDestFromConfig(activeStreamCfg);
        const loopHost =
            activeStreamCfg.icecastHost === '0.0.0.0'
                ? '127.0.0.1'
                : String(activeStreamCfg.icecastHost || '127.0.0.1');
        const icePort = Number(activeStreamCfg.icecastPort) || 8001;
        const mountPath = activeStreamCfg.icecastMount.startsWith('/')
            ? activeStreamCfg.icecastMount
            : `/${activeStreamCfg.icecastMount}`;
        const mountLockKey = `${loopHost}:${icePort}${mountPath}`;
        const isStale = () => gen !== generation;

        console.log(
            `[music] live encode: VibeVerse → local file → Icecast ${mountPath} → ${pub.slice(0, 120)}`,
        );

        /** @type {{ ok: boolean, reason?: string, detail?: string }} */
        let applied = { ok: false, reason: 'encode-failed' };

        // Serialize connect to this mount; return to chat as soon as the live URL is pushed
        // (do not wait for the whole track — ffmpeg keeps running in the background).
        await withIcecastMountEncodeLock(mountLockKey, async () => {
            if (isStale()) return;

            // Download durable URL first so -re never underruns on remote HTTP stalls.
            /** @type {string | null} */
            let localFile = null;
            try {
                const dl = await downloadToTemp({
                    url: track.streamUrl,
                    roomId,
                    label: 'vv',
                });
                if (isStale()) {
                    await dl.cleanup();
                    return;
                }
                localFile = dl.filePath;
                tempCleanup = dl.cleanup;
            } catch (e) {
                console.error('[music] durable download failed:', e?.message || e);
                applied = {
                    ok: false,
                    reason: 'download-failed',
                    detail: e?.message || 'Could not download track audio',
                };
                return;
            }

            // Local file opens instantly; keep enough wait for Icecast SOURCE handshake.
            const waitMs = Math.max(
                8000,
                parseInt(String(process.env.MUSIC_CHAT_WAIT_MOUNT_MS || '20000'), 10) || 20000,
            );
            const coldRestart = !/^(0|false|no|off)$/i.test(
                String(process.env.MUSIC_ICECAST_COLD_RESTART ?? '1').trim(),
            );

            const spawnEncode = () => {
                try {
                    if (localFile) {
                        console.log(`[music] live encode: local file → Icecast (${localFile})`);
                        return createFfmpegFileToIcecast({
                            filePath: localFile,
                            icecastDestUrl: iceDest,
                        }).proc;
                    }
                    return createFfmpegHttpToIcecast({
                        sourceUrl: track.streamUrl,
                        icecastDestUrl: iceDest,
                    }).proc;
                } catch (e) {
                    console.error('[music] ffmpeg →icecast failed:', e?.message || e);
                    return null;
                }
            };

            const waitMount = (timeout) =>
                waitForIcecastMountLive(activeStreamCfg, timeout, {
                    isStale,
                    localOnly: true,
                    pollMs: 100,
                    isEncodeAlive: () =>
                        Boolean(ffProc) && ffProc.exitCode == null && ffProc.signalCode == null,
                });

            let proc = spawnEncode();
            if (!proc) {
                clearTempFile();
                applied = { ok: false, reason: 'ffmpeg-spawn', detail: 'ffmpeg failed' };
                return;
            }
            if (isStale()) {
                try {
                    proc.kill('SIGKILL');
                } catch {}
                clearTempFile();
                return;
            }
            ffProc = proc;

            const diagAt = Math.min(8000, Math.max(3000, Math.floor(waitMs / 2)));
            setTimeout(async () => {
                if (isStale()) return;
                const up = await icecastStatusJsonShowsSource(loopHost, icePort, mountPath);
                if (isStale()) return;
                if (!up) {
                    const ffGone = !ffProc || ffProc.exitCode != null || ffProc.signalCode != null;
                    console.warn(
                        `[music] Icecast has no SOURCE on ${mountPath} at ${loopHost}:${icePort} ~${Math.round(diagAt / 1000)}s after start` +
                            (ffGone ? ' (ffmpeg already exited).' : '.'),
                    );
                } else {
                    console.log(`[music] Icecast confirms source on ${mountPath} (${loopHost}:${icePort}).`);
                }
            }, diagAt);

            let live = await waitMount(waitMs);
            if (isStale()) return;
            if (!live || !ffProc) {
                console.warn('[music] Mount never went live — not pushing room radio URL.');
                killFf();
                applied = {
                    ok: false,
                    reason: 'mount-not-live',
                    detail: 'Live Icecast mount did not become ready. Check Icecast and the public HTTPS tunnel.',
                };
                return;
            }

            // Warm-up encode often burns 5–15s before we set IMVU radio → listeners join mid-song.
            // Kill and restart so the live edge is near t=0 when we push the URL.
            // Keep the same local temp file across cold-restart (only kill ffmpeg).
            if (coldRestart && !isStale()) {
                console.log('[music] cold-restart encode so IMVU radio joins near track start');
                if (ffProc) {
                    try {
                        ffProc.kill('SIGKILL');
                    } catch {}
                    ffProc = null;
                }
                await new Promise((r) => setTimeout(r, 200));
                if (isStale()) return;
                proc = spawnEncode();
                if (!proc) {
                    clearTempFile();
                    applied = { ok: false, reason: 'ffmpeg-spawn', detail: 'ffmpeg cold-restart failed' };
                    return;
                }
                ffProc = proc;
                // Second start usually has CDN/TCP warm; short wait is enough.
                const restartWait = Math.min(
                    waitMs,
                    Math.max(5000, parseInt(String(process.env.MUSIC_ICECAST_COLD_RESTART_WAIT_MS || '12000'), 10) || 12000),
                );
                live = await waitMount(restartWait);
                if (isStale()) return;
                if (!live || !ffProc) {
                    console.warn('[music] Cold-restart mount never went live — not pushing room radio URL.');
                    killFf();
                    applied = {
                        ok: false,
                        reason: 'mount-not-live',
                        detail: 'Live Icecast mount did not become ready after cold restart.',
                    };
                    return;
                }
            }

            applied = await applyPublicUrlToRoom(pub, track);
            if (isStale()) return;
            if (!applied.ok) {
                killFf();
                return;
            }

            console.log('[music] Mount live — room radio URL set to shared Icecast stream.');
            scheduleAdvanceOnFfExit(track, gen, proc);
        });

        if (isStale()) return { ok: false, reason: 'stale' };
        if (!applied.ok) {
            playing = false;
            queue.setCurrent(null);
            notify(null, 'idle');
            return applied;
        }
        return { ok: true, track };
    };

    const enqueueDrain = () => {
        const run = async () => {
            if (paused) return;
            // Soft cutover: outgoingProc means still busy — don't treat as idle.
            if (queue.getCurrent() && playing && (ffProc || outgoingProc)) return;
            await playCurrentOrNext();
        };
        const next = drainTail.then(run, run);
        drainTail = next.catch(() => {});
        return next;
    };

    // Start watching room radio; kick first song after idle delay if nothing is on.
    startIdleWatcher();
    if (autoplayArmed && !autoplayOptedOut) {
        scheduleIdleAutoplay('on-mount');
    }

    return {
        getQueue: () => queue,
        // Extractor-live HLS has no local ffmpeg — `playing` + current track is enough.
        isPlaying: () =>
            playing &&
            !paused &&
            (ffProc != null || outgoingProc != null || endTimer != null || queue.getCurrent() != null),
        isPaused: () => paused,
        hasActive: () =>
            playing ||
            paused ||
            ffProc != null ||
            outgoingProc != null ||
            endTimer != null ||
            queue.getCurrent() != null ||
            queue.peek() != null,
        isAutoplayArmed: () => autoplayArmed && !autoplayOptedOut,
        isAutoplayOptedOut: () => autoplayOptedOut,
        armAutoplay: (reason) => armAutoplay(reason || 'manual'),
        disarmAutoplay,
        ensurePlaying: () => enqueueDrain(),
        /** Soft kick used by command handler (same as idle schedule). */
        kickAutoplayDrain: () => scheduleIdleAutoplay('kick'),

        /**
         * Soft-preempt for !play: bump generation / clear pending queue, but keep
         * current encode + room radio until the replacement HLS URL is applied.
         */
        cutForReplace,

        /** Replace whatever is playing/queued with this track and start it now. */
        async playNow(track) {
            clearIdleKick();
            armAutoplay('!play');
            clearEndTimer();
            generation += 1;
            queue.clearPending();
            // Park (don't kill) current encode so listeners keep hearing it while
            // the new track resolves + HLS warms. Cutover happens in playViaHls.
            parkCurrentEncode();
            queue.setCurrent(track);
            paused = false;
            console.log(`[music] !play replace — starting “${track?.title || '?'}” (keep current until HLS ready)`);
            return playCurrentOrNext({ keepOutgoing: true });
        },

        async enqueue(track) {
            clearIdleKick();
            armAutoplay('!add');
            const wasIdle =
                !queue.getCurrent() && !playing && !paused && !ffProc && !queue.peek();
            queue.enqueue(track);
            if (wasIdle) return enqueueDrain();
            return { ok: true, queued: true };
        },

        async skip() {
            clearEndTimer();
            generation += 1;
            killFf();
            queue.setCurrent(null);
            playing = false;
            paused = false;
            notify(null, 'idle');
            stopRoomRadioQuiet();
            return playCurrentOrNext();
        },

        /**
         * Stop current song + clear queue. Autoplay stays armed and resumes after
         * the idle delay unless the room used !autoplay-off.
         */
        stop() {
            clearEndTimer();
            clearAutoplayRetry();
            clearIdleKick();
            generation += 1;
            killFf();
            queue.clearAll();
            playing = false;
            paused = false;
            lastRoomRadioUrl = '';
            notify(null, 'idle');
            stopRoomRadioQuiet();
            if (!autoplayOptedOut && envFlagTrue('MUSIC_AUTOPLAY', true)) {
                if (!autoplayArmed) armAutoplay('after-stop');
                scheduleIdleAutoplay('after-stop');
            }
        },

        /** Permanent opt-out until !play/!add — stops music and cancels idle kick. */
        autoplayOff() {
            autoplayOptedOut = true;
            disarmAutoplay();
            clearEndTimer();
            clearAutoplayRetry();
            clearIdleKick();
            generation += 1;
            killFf();
            queue.clearAll();
            playing = false;
            paused = false;
            lastRoomRadioUrl = '';
            notify(null, 'idle');
            stopRoomRadioQuiet();
            console.log(`[music] autoplay opted out (${roomId}): !autoplay-off`);
        },

        pause() {
            if (!queue.getCurrent() && !playing && !ffProc && !endTimer) return false;
            paused = true;
            playing = false;
            clearEndTimer();
            clearIdleKick();
            killFf();
            notify(queue.getCurrent(), 'paused');
            return true;
        },

        async resume() {
            const track = queue.getCurrent();
            if (!paused || !track) return { ok: false, reason: 'not-paused' };
            if (track.trackId) {
                const fresh = await refreshVibeverseStream(track.trackId, track);
                if (fresh?.streamUrl) Object.assign(track, fresh);
            }
            paused = false;
            return playCurrentOrNext();
        },
    };
}
