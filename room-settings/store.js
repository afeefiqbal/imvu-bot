import { defaultRoomSettings, normalizeRoomSettings } from './defaults.js';

/** @type {Map<string, import('./defaults.js').RoomSettings>} */
const byRoom = new Map();

function roomKey(roomId) {
    return String(roomId || '')
        .trim()
        .replace(/^room-/i, '');
}

function asBool(value, fallback = true) {
    if (value == null) return fallback;
    if (typeof value === 'boolean') return value;
    if (value === 1 || value === 0) return value === 1;
    const s = String(value).trim().toLowerCase();
    if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
    if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
    return fallback;
}

function envDisabled(key) {
    const v = String(process.env[key] ?? '').trim().toLowerCase();
    return v === '0' || v === 'false' || v === 'no' || v === 'off';
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

let globalLurkDefault = true;
let globalMusicDefault = true;
let globalCommandsDefault = true;
let globalWelcomeDefault = true;
let globalIntroDefault = true;

/** @param {boolean} enabled */
export function setGlobalLurkDefault(enabled) {
    globalLurkDefault = enabled;
}

/** @param {boolean} enabled */
export function setGlobalMusicDefault(enabled) {
    globalMusicDefault = enabled;
}

/** @param {boolean} enabled */
export function setGlobalCommandsDefault(enabled) {
    globalCommandsDefault = enabled;
}

/** @param {boolean} enabled */
export function setGlobalWelcomeDefault(enabled) {
    globalWelcomeDefault = enabled;
}

/** @param {boolean} enabled */
export function setGlobalIntroDefault(enabled) {
    globalIntroDefault = enabled;
}

/**
 * Apply bot-level feature flags from /api/rooms/sync (and startup).
 * Env vars remain hard kill-switches when set to 0/false/off.
 * @param {Record<string, unknown> | null | undefined} data
 */
export function applyBotFeatureFlags(data) {
    if (!data || typeof data !== 'object') return;

    if (data.bot_ai_enabled != null) {
        setGlobalLurkDefault(asBool(data.bot_ai_enabled, true) && !envDisabled('IMVU_LURK_ENABLED'));
    }
    if (data.bot_music_enabled != null) {
        setGlobalMusicDefault(asBool(data.bot_music_enabled, true));
    }
    if (data.bot_commands_enabled != null) {
        setGlobalCommandsDefault(
            asBool(data.bot_commands_enabled, true) && !envDisabled('IMVU_ROOM_COMMANDS_ENABLED')
        );
    }
    if (data.bot_welcome_enabled != null) {
        setGlobalWelcomeDefault(asBool(data.bot_welcome_enabled, true));
    }
    if (data.bot_intro_enabled != null) {
        setGlobalIntroDefault(
            asBool(data.bot_intro_enabled, true) && !envDisabled('IMVU_WS_INTRO_ENABLED')
        );
    }
}

/** @param {string} roomId */
export function isLurkEnabledForRoom(roomId) {
    return getRoomSettings(roomId).lurk_enabled !== false && globalLurkDefault !== false;
}

/** @param {string} roomId */
export function isMusicEnabledForRoom(roomId) {
    return getRoomSettings(roomId).music_enabled !== false && globalMusicDefault !== false;
}

/** @param {string} roomId */
export function isCommandsEnabledForRoom(roomId) {
    return getRoomSettings(roomId).commands_enabled !== false && globalCommandsDefault !== false;
}

/** @param {string} roomId */
export function isWelcomeEnabledForRoom(roomId) {
    return getRoomSettings(roomId).auto_greet !== false && globalWelcomeDefault !== false;
}

/** @param {string} roomId */
export function isIntroEnabledForRoom(roomId) {
    return getRoomSettings(roomId).intro_enabled !== false && globalIntroDefault !== false;
}
