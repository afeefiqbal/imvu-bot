import { createTrackQueue } from './queue.js';
import { applyRoomMediaStreamUrl, waitForRoomMediaPlayback } from './imvuRoomMediaDom.js';
import { notifyImvuMusicState } from './notifyImvuMusicApi.js';
import { playVibeverseTrack, refreshVibeverseStream } from './vibeverseClient.js';

/**
 * Option A room player: each track is a VibeVerse stream URL pushed to IMVU media.
 * No Icecast / ffmpeg / yt-dlp on the bot host.
 *
 * @param {{
 *   roomId: string,
 *   apiBaseUrl: string,
 *   botName?: string,
 *   page?: object | null,
 *   sessionClient?: object | null,
 * }} opts
 */
export function createVibeverseRoomPlayer(opts) {
    const { roomId, apiBaseUrl, botName, page, sessionClient } = opts;
    const queue = createTrackQueue();

    let playing = false;
    let paused = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let endTimer = null;
    /** @type {Promise<void>} */
    let drainTail = Promise.resolve();
    let generation = 0;

    const clearEndTimer = () => {
        if (endTimer) {
            clearTimeout(endTimer);
            endTimer = null;
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

    const applyToRoom = async (track) => {
        const url = String(track?.streamUrl || '').trim();
        if (!/^https:\/\//i.test(url)) {
            return { ok: false, reason: 'invalid-url' };
        }
        console.log(`[music] applying stream URL to room ${roomId}: ${url}`);
        const applied = await applyRoomMediaStreamUrl(page, url, {
            sessionClient,
            roomId,
            stationName: String(track?.title || '').trim(),
        });
        if (!applied.ok) return applied;
        await waitForRoomMediaPlayback(page, {
            roomId,
            expectedUrl: url,
            timeoutMs: 12_000,
            intervalMs: 1500,
            sessionClient,
        }).catch(() => ({ ok: false }));
        return applied;
    };

    const scheduleEnd = (track, gen) => {
        clearEndTimer();
        const ms = Number(track?.durationMs) || 0;
        // Fallback 3 minutes if duration unknown; add a small buffer for load latency.
        const waitMs = Math.max(30_000, (ms > 0 ? ms : 180_000) + 2_000);
        endTimer = setTimeout(() => {
            if (gen !== generation || paused) return;
            console.log(`[vibeverse] track ended (timer): ${track?.title || '?'}`);
            queue.setCurrent(null);
            playing = false;
            notify(null, 'idle');
            void enqueueDrain();
        }, waitMs);
    };

    const playCurrentOrNext = async () => {
        const gen = ++generation;
        clearEndTimer();

        let track = queue.getCurrent();
        if (!track) {
            track = queue.dequeue();
            if (track) queue.setCurrent(track);
        }
        if (!track) {
            playing = false;
            paused = false;
            notify(null, 'idle');
            return { ok: true, empty: true };
        }

        // Ensure we have a fresh stream URL (re-mint if missing/stale).
        if (!track.streamUrl && track.trackId) {
            const fresh = await playVibeverseTrack({
                id: track.trackId,
                title: track.title,
                artistName: track.artistName,
                artworkUrl: track.artworkUrl,
                durationMs: track.durationMs,
            });
            if (fresh) Object.assign(track, fresh);
        }

        if (!track.streamUrl) {
            console.warn('[vibeverse] skip unplayable track:', track.title);
            queue.setCurrent(null);
            return playCurrentOrNext();
        }

        if (gen !== generation) return { ok: false, reason: 'stale' };

        paused = false;
        playing = true;
        notify(track, 'playing');
        const applied = await applyToRoom(track);
        if (gen !== generation) return { ok: false, reason: 'stale' };
        if (!applied.ok) {
            playing = false;
            queue.setCurrent(null);
            notify(null, 'idle');
            return applied;
        }
        scheduleEnd(track, gen);
        return { ok: true, track };
    };

    const enqueueDrain = () => {
        const run = async () => {
            if (paused) return;
            if (queue.getCurrent() && playing) return;
            await playCurrentOrNext();
        };
        const next = drainTail.then(run, run);
        drainTail = next.catch(() => {});
        return next;
    };

    return {
        getQueue: () => queue,
        isPlaying: () => playing && !paused,
        isPaused: () => paused,
        hasActive: () =>
            playing || paused || queue.getCurrent() != null || queue.peek() != null,

        /** @param {object} track */
        async playNow(track) {
            clearEndTimer();
            generation += 1;
            queue.clearPending();
            queue.setCurrent(track);
            playing = false;
            paused = false;
            return playCurrentOrNext();
        },

        async enqueue(track) {
            const wasIdle = !queue.getCurrent() && !playing && !paused && !queue.peek();
            queue.enqueue(track);
            if (wasIdle) return enqueueDrain();
            return { ok: true, queued: true };
        },

        async skip() {
            clearEndTimer();
            generation += 1;
            queue.setCurrent(null);
            playing = false;
            paused = false;
            notify(null, 'idle');
            return playCurrentOrNext();
        },

        stop() {
            clearEndTimer();
            generation += 1;
            queue.clearAll();
            playing = false;
            paused = false;
            notify(null, 'idle');
        },

        pause() {
            if (!queue.getCurrent() && !playing) return false;
            paused = true;
            playing = false;
            clearEndTimer();
            notify(queue.getCurrent(), 'paused');
            return true;
        },

        async resume() {
            const track = queue.getCurrent();
            if (!paused || !track) return { ok: false, reason: 'not-paused' };
            // Re-mint URL in case the signed link expired while paused.
            if (track.trackId) {
                const fresh = await refreshVibeverseStream(track.trackId, track);
                if (fresh?.streamUrl) Object.assign(track, fresh);
            }
            paused = false;
            return playCurrentOrNext();
        },
    };
}
