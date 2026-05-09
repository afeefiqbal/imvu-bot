/**
 * Icecast allows one source per mount. Overlapping FFmpeg connects to the same mount → HTTP 403.
 * Queue encode sessions per mount across all room players in one Node process.
 */

/** @type {Map<string, Promise<void>>} */
const endOfChain = new Map();

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
    try {
        await fn();
    } finally {
        done?.();
    }
}
