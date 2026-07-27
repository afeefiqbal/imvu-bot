/**
 * Serialize YouTube → FFmpeg starts across all room players in one process.
 * Concurrent yt-dlp on the same IP (OCI) slows every room and triggers bot challenges.
 */

/** @type {Promise<void>} */
let endOfChain = Promise.resolve();

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withYtEncodeGate(fn) {
    const prev = endOfChain;
    /** @type {(() => void) | undefined} */
    let done;
    endOfChain = prev.then(
        () =>
            new Promise((resolve) => {
                done = resolve;
            }),
    );
    await prev;
    try {
        return await fn();
    } finally {
        done?.();
    }
}
