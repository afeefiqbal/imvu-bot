import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { beginPlayTrace, playTraceEnabled, newPlayTraceId } from './playTrace.js';

describe('playTrace', () => {
    const prev = process.env.MUSIC_PLAY_TRACE;
    afterEach(() => {
        if (prev === undefined) delete process.env.MUSIC_PLAY_TRACE;
        else process.env.MUSIC_PLAY_TRACE = prev;
    });

    it('defaults off', () => {
        delete process.env.MUSIC_PLAY_TRACE;
        assert.equal(playTraceEnabled(), false);
        assert.equal(beginPlayTrace({ roomId: 'x' }), null);
    });

    it('begins when MUSIC_PLAY_TRACE=1', () => {
        process.env.MUSIC_PLAY_TRACE = '1';
        const t = beginPlayTrace({ roomId: '261755692-980', requestedText: 'test' });
        assert.ok(t);
        assert.ok(t.playTraceId.length >= 8);
        t.mark('play_trace_start');
        t.complete();
    });

    it('newPlayTraceId returns non-empty', () => {
        assert.ok(newPlayTraceId().length >= 8);
    });
});
