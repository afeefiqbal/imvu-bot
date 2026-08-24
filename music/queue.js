/** @typedef {{ title: string, url: string, requestedBy?: string, autoplaySlot?: number }} MusicTrack */

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
            const cap = Math.max(1, parseInt(process.env.MUSIC_QUEUE_MAX || '25', 10) || 25);
            if (pending.length >= cap) return false;
            pending.push(t);
            return true;
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
