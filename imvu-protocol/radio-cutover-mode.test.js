import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    canAttemptUpdateOnly,
    parseUpdateRooms,
    planRadioCutover,
    resolveRadioCutoverMode,
    runGatedRadioCutover,
} from './radio-cutover-mode.js';

describe('parseUpdateRooms', () => {
    it('returns empty set for blank allowlist', () => {
        assert.equal(parseUpdateRooms('').size, 0);
        assert.equal(parseUpdateRooms(undefined).size, 0);
    });

    it('parses comma/space separated room ids', () => {
        const rooms = parseUpdateRooms('261755692-980, 375718790-35');
        assert.ok(rooms.has('261755692-980'));
        assert.ok(rooms.has('375718790-35'));
        assert.equal(rooms.size, 2);
    });
});

describe('resolveRadioCutoverMode', () => {
    it('defaults to forceRestart', () => {
        assert.equal(resolveRadioCutoverMode('261755692-980', {}), 'forceRestart');
    });

    it('keeps forceRestart when mode is forceRestart', () => {
        assert.equal(
            resolveRadioCutoverMode('261755692-980', {
                IMVU_RADIO_CUTOVER_MODE: 'forceRestart',
                IMVU_RADIO_UPDATE_ROOMS: '261755692-980',
            }),
            'forceRestart',
        );
    });

    it('uses update only for allowlisted rooms when mode=update', () => {
        const env = {
            IMVU_RADIO_CUTOVER_MODE: 'update',
            IMVU_RADIO_UPDATE_ROOMS: '261755692-980',
        };
        assert.equal(resolveRadioCutoverMode('261755692-980', env), 'update');
        assert.equal(resolveRadioCutoverMode('999999999-1', env), 'forceRestart');
    });

    it('never uses update when allowlist is empty', () => {
        assert.equal(
            resolveRadioCutoverMode('261755692-980', {
                IMVU_RADIO_CUTOVER_MODE: 'update',
                IMVU_RADIO_UPDATE_ROOMS: '',
            }),
            'forceRestart',
        );
    });
});

describe('canAttemptUpdateOnly / planRadioCutover', () => {
    it('allows playing/paused only', () => {
        assert.equal(canAttemptUpdateOnly('playing'), true);
        assert.equal(canAttemptUpdateOnly('paused'), true);
        assert.equal(canAttemptUpdateOnly('stopped'), false);
    });

    it('plans update for allowlisted playing room', () => {
        assert.equal(
            planRadioCutover({
                forceRestart: true,
                roomId: '261755692-980',
                status: 'playing',
                env: {
                    IMVU_RADIO_CUTOVER_MODE: 'update',
                    IMVU_RADIO_UPDATE_ROOMS: '261755692-980',
                },
            }),
            'update',
        );
    });

    it('plans forceRestart for other rooms even when mode=update', () => {
        assert.equal(
            planRadioCutover({
                forceRestart: true,
                roomId: '111-1',
                status: 'playing',
                env: {
                    IMVU_RADIO_CUTOVER_MODE: 'update',
                    IMVU_RADIO_UPDATE_ROOMS: '261755692-980',
                },
            }),
            'forceRestart',
        );
    });

    it('plans forceRestart when radio is stopped', () => {
        assert.equal(
            planRadioCutover({
                forceRestart: true,
                roomId: '261755692-980',
                status: 'stopped',
                env: {
                    IMVU_RADIO_CUTOVER_MODE: 'update',
                    IMVU_RADIO_UPDATE_ROOMS: '261755692-980',
                },
            }),
            'forceRestart',
        );
    });
});

describe('runGatedRadioCutover', () => {
    it('succeeds on update-only without calling forceRestart', async () => {
        const events = [];
        let forceCalls = 0;
        const res = await runGatedRadioCutover({
            roomId: '261755692-980',
            mode: 'update',
            runUpdateOnly: async () => ({ ok: true, status: 200 }),
            runForceRestart: async () => {
                forceCalls += 1;
                return { ok: true, reason: 'api-restart-radio' };
            },
            log: (event, fields) => events.push({ event, ...fields }),
        });
        assert.equal(res.ok, true);
        assert.equal(res.mode, 'update');
        assert.equal(res.fellBack, false);
        assert.equal(forceCalls, 0);
        assert.ok(events.some((e) => e.event === 'radio_cutover_start'));
        assert.ok(events.some((e) => e.event === 'radio_update_start'));
        assert.ok(events.some((e) => e.event === 'radio_update_end' && e.success === true));
        assert.ok(events.some((e) => e.event === 'radio_cutover_success' && e.mode === 'update'));
    });

    it('falls back to forceRestart when update API fails', async () => {
        const events = [];
        let forceCalls = 0;
        const res = await runGatedRadioCutover({
            roomId: '261755692-980',
            mode: 'update',
            runUpdateOnly: async () => ({ ok: false, status: 412, reason: 'etag-mismatch' }),
            runForceRestart: async () => {
                forceCalls += 1;
                return { ok: true, reason: 'api-restart-radio' };
            },
            log: (event, fields) => events.push({ event, ...fields }),
        });
        assert.equal(res.ok, true);
        assert.equal(res.mode, 'forceRestart');
        assert.equal(res.fellBack, true);
        assert.equal(res.fallbackReason, 'etag-mismatch');
        assert.equal(forceCalls, 1);
        assert.ok(events.some((e) => e.event === 'radio_cutover_fallback'));
        assert.ok(
            events.some((e) => e.event === 'radio_cutover_success' && e.fellBack === true),
        );
    });

    it('uses forceRestart path directly when mode is forceRestart', async () => {
        let updateCalls = 0;
        let forceCalls = 0;
        const res = await runGatedRadioCutover({
            roomId: '111-1',
            mode: 'forceRestart',
            runUpdateOnly: async () => {
                updateCalls += 1;
                return { ok: true };
            },
            runForceRestart: async () => {
                forceCalls += 1;
                return { ok: true, reason: 'api-restart-radio' };
            },
        });
        assert.equal(res.ok, true);
        assert.equal(res.mode, 'forceRestart');
        assert.equal(updateCalls, 0);
        assert.equal(forceCalls, 1);
    });
});
