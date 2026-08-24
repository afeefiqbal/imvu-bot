/**
 * Gated IMVU radio cutover mode selection + orchestration helpers.
 *
 * IMVU_RADIO_CUTOVER_MODE=forceRestart|update  (default: forceRestart)
 * IMVU_RADIO_UPDATE_ROOMS=roomId1,roomId2     (empty ⇒ no rooms use update)
 */

/**
 * @param {string|undefined|null} raw
 * @returns {Set<string>}
 */
export function parseUpdateRooms(raw) {
    return new Set(
        String(raw || '')
            .split(/[,\s]+/)
            .map((s) => s.trim())
            .filter(Boolean),
    );
}

/**
 * @param {string} roomId
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [env]
 * @returns {'forceRestart'|'update'}
 */
export function resolveRadioCutoverMode(roomId, env = process.env) {
    const mode = String(env?.IMVU_RADIO_CUTOVER_MODE || 'forceRestart')
        .trim()
        .toLowerCase();
    if (mode !== 'update') return 'forceRestart';

    const rooms = parseUpdateRooms(env?.IMVU_RADIO_UPDATE_ROOMS);
    if (!rooms.size) return 'forceRestart';

    const rid = String(roomId || '').trim();
    if (!rid) return 'forceRestart';
    if (rooms.has(rid)) return 'update';
    return 'forceRestart';
}

/**
 * Update-only is only attempted when the room is already playing/paused.
 * @param {string} status
 * @returns {boolean}
 */
export function canAttemptUpdateOnly(status) {
    const s = String(status || '').trim().toLowerCase();
    return s === 'playing' || s === 'paused';
}

/**
 * Decide which cutover path to attempt for a track change.
 * @param {{ forceRestart?: boolean, roomId?: string, status?: string, env?: Record<string, string|undefined> }} opts
 * @returns {'skip'|'forceRestart'|'update'}
 */
export function planRadioCutover(opts = {}) {
    if (!opts.forceRestart) return 'forceRestart';
    const configured = resolveRadioCutoverMode(opts.roomId, opts.env || process.env);
    if (configured === 'update' && canAttemptUpdateOnly(opts.status)) return 'update';
    return 'forceRestart';
}

/**
 * Run update-only with forceRestart fallback on API failure.
 * Short A/B request overlap is NOT a fallback trigger.
 *
 * @param {{
 *   roomId: string,
 *   mode: 'update'|'forceRestart',
 *   runUpdateOnly: () => Promise<{ ok: boolean, reason?: string, status?: number }>,
 *   runForceRestart: () => Promise<{ ok: boolean, reason?: string }>,
 *   log?: (event: string, fields?: Record<string, unknown>) => void,
 * }} args
 */
export async function runGatedRadioCutover(args) {
    const log = typeof args.log === 'function' ? args.log : () => {};
    const t0 = Date.now();
    const mode = args.mode === 'update' ? 'update' : 'forceRestart';
    log('radio_cutover_start', { roomId: args.roomId, mode });
    log('radio_cutover_mode', { roomId: args.roomId, mode });

    if (mode === 'update') {
        log('radio_update_start', { roomId: args.roomId });
        let updateRes;
        try {
            updateRes = await args.runUpdateOnly();
        } catch (error) {
            updateRes = {
                ok: false,
                reason: error instanceof Error ? error.message : String(error),
            };
        }
        log('radio_update_end', {
            roomId: args.roomId,
            success: Boolean(updateRes?.ok),
            httpStatus: updateRes?.status ?? null,
            errorClass: updateRes?.ok ? null : updateRes?.reason || 'update-failed',
            durationMs: Date.now() - t0,
        });

        if (updateRes?.ok) {
            const durationMs = Date.now() - t0;
            log('radio_cutover_success', {
                roomId: args.roomId,
                mode: 'update',
                radio_cutover_duration_ms: durationMs,
                durationMs,
            });
            return {
                ok: true,
                reason: 'api-update-radio',
                mode: 'update',
                fellBack: false,
                durationMs,
            };
        }

        const fallbackReason = updateRes?.reason || 'update-failed';
        log('radio_cutover_fallback', {
            roomId: args.roomId,
            reason: fallbackReason,
            fromMode: 'update',
            toMode: 'forceRestart',
        });
        const fb = await args.runForceRestart();
        const durationMs = Date.now() - t0;
        if (fb?.ok) {
            log('radio_cutover_success', {
                roomId: args.roomId,
                mode: 'forceRestart',
                fellBack: true,
                fallbackReason,
                radio_cutover_duration_ms: durationMs,
                durationMs,
            });
        }
        return {
            ok: Boolean(fb?.ok),
            reason: fb?.reason || 'api-restart-radio',
            mode: 'forceRestart',
            fellBack: true,
            fallbackReason,
            durationMs,
        };
    }

    const fr = await args.runForceRestart();
    const durationMs = Date.now() - t0;
    if (fr?.ok) {
        log('radio_cutover_success', {
            roomId: args.roomId,
            mode: 'forceRestart',
            radio_cutover_duration_ms: durationMs,
            durationMs,
        });
    }
    return {
        ok: Boolean(fr?.ok),
        reason: fr?.reason || (fr?.ok ? 'api-restart-radio' : 'forceRestart-failed'),
        mode: 'forceRestart',
        fellBack: false,
        durationMs,
    };
}
