/** @typedef {{ title: string, url: string, requestedBy?: string }} MusicTrack */

export function createTrackQueue() {
    /** @type {MusicTrack[]} */
    const pending = [];
    /** @type {MusicTrack | null} */
    let current = null;

    return {
        getCurrent: () => current,
        setCurrent: (t) => {
            current = t;
        },
        enqueue: (t) => {
            pending.push(t);
        },
        dequeue: () => pending.shift() ?? null,
        peek: () => pending[0] ?? null,
        pending: () => [...pending],
        clearPending: () => {
            pending.length = 0;
        },
        clearAll: () => {
            pending.length = 0;
            current = null;
        },
        size: () => pending.length,
    };
}
