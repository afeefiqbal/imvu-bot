import { defaultRoomSettings, normalizeRoomSettings } from './defaults.js';

/** @type {Map<string, import('./defaults.js').RoomSettings>} */
const byRoom = new Map();

function roomKey(roomId) {
    return String(roomId || '')
        .trim()
        .replace(/^room-/i, '');
}

/** @param {string} roomId */
export function getRoomSettings(roomId) {
    const key = roomKey(roomId);
    if (!key) return { ...defaultRoomSettings() };
    const cur = byRoom.get(key);
    return cur ? { ...cur } : { ...defaultRoomSettings() };
}

/**
 * @param {string} roomId
 * @param {Partial<import('./defaults.js').RoomSettings>} patch
 */
export function patchRoomSettingsLocal(roomId, patch) {
    const key = roomKey(roomId);
    const next = normalizeRoomSettings({ ...getRoomSettings(roomId), ...patch });
    byRoom.set(key, next);
    return next;
}

/**
 * Merge settings from POST /api/rooms/sync `room_settings` map.
 * @param {Record<string, unknown> | null | undefined} map
 */
export function applySyncRoomSettings(map) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) return;
    for (const [rawId, rawSettings] of Object.entries(map)) {
        const key = roomKey(rawId);
        if (!key) continue;
        byRoom.set(key, normalizeRoomSettings(rawSettings));
    }
}

/** @param {boolean} enabled */
export function setGlobalLurkDefault(enabled) {
    globalLurkDefault = enabled;
}

let globalLurkDefault = true;

/** @param {string} roomId */
export function isLurkEnabledForRoom(roomId) {
    return getRoomSettings(roomId).lurk_enabled !== false && globalLurkDefault !== false;
}
