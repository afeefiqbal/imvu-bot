/**
 * Icecast allows one source per mount. Overlapping FFmpeg connects to the same mount → HTTP 403.
 * Queue encode sessions per mount across all room players in one Node process.
 *
 * After a source disconnects, Icecast often needs a short window before accepting the next
 * icecast:// login on the same mount — otherwise FFmpeg sees "403 Forbidden (access denied)".
 */

/** @type {Map<string, Promise<void>>} */
const endOfChain = new Map();

function reconnectDelayMs() {
    const raw = process.env.MUSIC_ICECAST_RECONNECT_MS;
    if (raw === '0' || raw === 'false') return 0;
    if (raw == null || String(raw).trim() === '') return 1000;
    const v = parseInt(String(raw), 10);
    return Number.isFinite(v) && v >= 0 ? v : 1000;
}

/**
 * @param {string} key e.g. 127.0.0.1:8001/imvu-261755692-875.mp3
 * @param {() => Promise<void>} fn
 */
export async function withIcecastMountEncodeLock(key, fn) {
    const k = String(key || '').trim() || 'default';
    const prev = endOfChain.get(k) ?? Promise.resolve();
    /** @type {(() => void) | undefined} */
    let done;
    const mine = prev.then(
        () =>
            new Promise((resolve) => {
                done = resolve;
            }),
    );
    endOfChain.set(k, mine);
    await prev;
    const gap = reconnectDelayMs();
    if (gap > 0) {
        await new Promise((r) => setTimeout(r, gap));
    }
    try {
        await fn();
    } finally {
        done?.();
    }
}
