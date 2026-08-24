import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { nextTrackForPrefetch } from './vibeverseClient.js';

/**
 * Lightweight unit coverage for forQueue body shaping + prefetch gate.
 * Mirrors vibeverseClient play/prefetch rules without hitting the network.
 */

function buildPlayBody(track, opts = {}) {
    const live = /^(1|true|yes|on)$/i.test(String(process.env.MUSIC_VIBEVERSE_LIVE || '').trim());
    const forQueue = opts.forQueue === true;
    const roomId = forQueue
        ? ''
        : String(opts.roomId || process.env.MUSIC_ROOM_ID || '').trim();

    return {
        trackId: track.id,
        preferMp3: true,
        requireCached: forQueue ? false : live ? false : true,
        allowProgressive: forQueue || live ? true : undefined,
        delivery: forQueue ? 'source' : live ? 'hls' : undefined,
        roomId: !forQueue && live && roomId ? roomId : undefined,
    };
}

function prefetchAllowed(roomId, env = process.env) {
    if (!/^(1|true|yes|on)$/i.test(String(env.MUSIC_PREFETCH || '').trim())) return false;
    const allow = new Set(
        String(env.MUSIC_PREFETCH_ROOMS || '')
            .split(/[,\s]+/)
            .map((s) => s.trim())
            .filter(Boolean),
    );
    return allow.has(String(roomId || '').trim());
}

describe('forQueue play body', () => {
    const prev = {};
    beforeEach(() => {
        for (const k of ['MUSIC_VIBEVERSE_LIVE', 'MUSIC_ROOM_ID']) {
            prev[k] = process.env[k];
        }
        process.env.MUSIC_VIBEVERSE_LIVE = '1';
        process.env.MUSIC_ROOM_ID = '261755692-980';
    });
    afterEach(() => {
        for (const [k, v] of Object.entries(prev)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    it('omits roomId and uses source delivery when forQueue', () => {
        const body = buildPlayBody(
            { id: 'yt_dQw4w9WgXcQ' },
            { forQueue: true, roomId: '261755692-980' },
        );
        assert.equal(body.delivery, 'source');
        assert.equal(body.roomId, undefined);
        assert.equal(body.allowProgressive, true);
        assert.equal(body.requireCached, false);
    });

    it('uses hls + roomId for live play (not forQueue)', () => {
        const body = buildPlayBody(
            { id: 'yt_dQw4w9WgXcQ' },
            { roomId: '261755692-980' },
        );
        assert.equal(body.delivery, 'hls');
        assert.equal(body.roomId, '261755692-980');
    });
});

describe('playCurrentOrNext peek prewarm', () => {
    const current = { id: 'yt_aaaaaaaaaaa', title: 'A' };
    const peek = { id: 'yt_bbbbbbbbbbb', title: 'B' };

    it('prewarms queue.peek() once current is established', () => {
        const next = nextTrackForPrefetch(current, peek);
        assert.equal(next, peek);
        assert.equal(next.id, 'yt_bbbbbbbbbbb');
    });

    it('skips prefetch when the queue has no next track', () => {
        assert.equal(nextTrackForPrefetch(current, null), null);
        assert.equal(nextTrackForPrefetch(current, undefined), null);
    });

    it('skips prefetch when peek is the current track', () => {
        assert.equal(nextTrackForPrefetch(current, { id: 'yt_aaaaaaaaaaa' }), null);
        assert.equal(
            nextTrackForPrefetch(
                { trackId: 'yt_aaaaaaaaaaa' },
                { trackId: 'yt_aaaaaaaaaaa' },
            ),
            null,
        );
    });
});

describe('prefetch gate', () => {
    it('requires MUSIC_PREFETCH + allowlisted room', () => {
        assert.equal(
            prefetchAllowed('261755692-980', {
                MUSIC_PREFETCH: '1',
                MUSIC_PREFETCH_ROOMS: '261755692-980',
            }),
            true,
        );
        assert.equal(
            prefetchAllowed('261755692-980', {
                MUSIC_PREFETCH: '0',
                MUSIC_PREFETCH_ROOMS: '261755692-980',
            }),
            false,
        );
        assert.equal(
            prefetchAllowed('other', {
                MUSIC_PREFETCH: '1',
                MUSIC_PREFETCH_ROOMS: '261755692-980',
            }),
            false,
        );
    });
});
