/**
 * Opt-in cold !play latency tracing (measurement only).
 * Enable with MUSIC_PLAY_TRACE=1. Default OFF.
 */

import { randomUUID } from 'node:crypto';

export function playTraceEnabled() {
    return /^(1|true|yes|on)$/i.test(String(process.env.MUSIC_PLAY_TRACE || '').trim());
}

export function newPlayTraceId() {
    try {
        return randomUUID();
    } catch {
        return `pt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    }
}

/**
 * @param {string} event
 * @param {Record<string, unknown>} fields
 */
export function playTraceLog(event, fields = {}) {
    if (!playTraceEnabled()) return;
    if (!fields.playTraceId) return;
    console.log(
        JSON.stringify({
            event,
            ts: Date.now(),
            ...fields,
        }),
    );
}

/**
 * @returns {{
 *   playTraceId: string,
 *   t0: number,
 *   roomId: string,
 *   mark: (event: string, extra?: Record<string, unknown>) => void,
 *   span: <T>(event: string, fn: () => Promise<T>) => Promise<T>,
 *   set: (key: string, value: unknown) => void,
 *   data: Record<string, unknown>,
 *   complete: (extra?: Record<string, unknown>) => void,
 * } | null}
 */
export function beginPlayTrace(opts = {}) {
    if (!playTraceEnabled()) return null;
    const playTraceId = String(opts.playTraceId || newPlayTraceId());
    const t0 = Date.now();
    const roomId = String(opts.roomId || '').trim();
    /** @type {Record<string, unknown>} */
    const data = {
        playTraceId,
        roomId,
        requestedText: opts.requestedText || null,
        userId: opts.userId || null,
    };

    const mark = (event, extra = {}) => {
        playTraceLog(event, {
            playTraceId,
            roomId,
            ...data,
            ...extra,
            elapsedMs: Date.now() - t0,
        });
    };

    const span = async (event, fn) => {
        const start = Date.now();
        mark(`${event}_start`);
        try {
            const out = await fn();
            mark(`${event}_end`, { durationMs: Date.now() - start, ok: true });
            return out;
        } catch (err) {
            mark(`${event}_end`, {
                durationMs: Date.now() - start,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
            });
            throw err;
        }
    };

    return {
        playTraceId,
        t0,
        roomId,
        mark,
        span,
        set(key, value) {
            data[key] = value;
        },
        data,
        complete(extra = {}) {
            playTraceLog('play_trace_complete', {
                playTraceId,
                roomId,
                youtubeId: data.youtubeId ?? null,
                stage: 'bot',
                r2: { hit: data.r2Hit === true },
                api: {
                    totalMs: data.apiTotalMs ?? null,
                    searchMs: data.searchMs ?? null,
                },
                imvu: {
                    cutoverMs: data.cutoverMs ?? null,
                    cutoverMode: data.cutoverMode ?? null,
                    cutApiMs: data.cutApiMs ?? null,
                },
                total: {
                    playCommandToApiResponseMs: data.playCommandToApiResponseMs ?? null,
                    playCommandToRadioAppliedMs: data.playCommandToRadioAppliedMs ?? null,
                },
                ...extra,
                elapsedMs: Date.now() - t0,
            });
        },
    };
}
