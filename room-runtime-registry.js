/** @typedef {{ roomId: string, sendMessage: (text: string) => Promise<void>, kickByUsername: (username: string, opts?: { reason?: string }) => Promise<{ ok: boolean, reason?: string }>, getVisitors: () => string[] }} RoomRuntime */

/** @type {Map<string, RoomRuntime>} */
const byRoom = new Map();

export function trackerRoomKey(raw) {
    const s = String(raw ?? '').trim();
    const m = s.match(/room-([\d-]+)/i);
    if (m) return m[1];
    const m2 = s.match(/(\d+-\d+)/);
    return m2 ? m2[1] : s.replace(/[^\d-]/g, '') || s;
}

/** @param {string} roomId @param {RoomRuntime} runtime */
export function registerRoomRuntime(roomId, runtime) {
    const key = trackerRoomKey(roomId);
    if (!key) return;
    byRoom.set(key, runtime);
}

/** @param {string} roomId */
export function unregisterRoomRuntime(roomId) {
    byRoom.delete(trackerRoomKey(roomId));
}

/** @param {string} roomId @returns {RoomRuntime | undefined} */
export function getRoomRuntime(roomId) {
    return byRoom.get(trackerRoomKey(roomId));
}

/** @returns {Map<string, RoomRuntime>} */
export function allRoomRuntimes() {
    return byRoom;
}
