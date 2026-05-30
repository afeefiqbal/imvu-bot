/**
 * @typedef {Object} RoomSettings
 * @property {string | null} greeting
 * @property {boolean} auto_greet
 * @property {boolean} auto_scale_check
 * @property {number} max_scaler
 * @property {number | null} min_age
 * @property {number | null} max_occupancy
 * @property {boolean} lurk_enabled
 * @property {string | null} description
 * @property {string | null} music_url
 * @property {boolean} autoboot_on_kick
 */

/** @returns {RoomSettings} */
export function defaultRoomSettings() {
    return {
        greeting: null,
        auto_greet: true,
        auto_scale_check: false,
        max_scaler: 120,
        min_age: null,
        max_occupancy: null,
        lurk_enabled: true,
        description: null,
        music_url: null,
        autoboot_on_kick: false,
    };
}

/**
 * @param {unknown} raw
 * @returns {RoomSettings}
 */
export function normalizeRoomSettings(raw) {
    const base = defaultRoomSettings();
    if (!raw || typeof raw !== 'object') return { ...base };

    const o = /** @type {Record<string, unknown>} */ (raw);

    if (o.greeting != null) {
        const g = String(o.greeting).trim();
        base.greeting = g.length ? g.slice(0, 300) : null;
    }
    if (o.auto_greet != null) base.auto_greet = Boolean(o.auto_greet);
    if (o.auto_scale_check != null) base.auto_scale_check = Boolean(o.auto_scale_check);
    if (o.max_scaler != null) {
        const n = Number(o.max_scaler);
        if (Number.isFinite(n) && n > 0) base.max_scaler = Math.min(500, Math.round(n));
    }
    if (o.min_age != null) {
        const n = Number(o.min_age);
        if (Number.isFinite(n) && n >= 0) base.min_age = Math.min(120, Math.round(n));
    }
    if (o.max_occupancy != null) {
        const n = Number(o.max_occupancy);
        if (Number.isFinite(n) && n > 0) base.max_occupancy = Math.min(100, Math.round(n));
    }
    if (o.lurk_enabled != null) base.lurk_enabled = Boolean(o.lurk_enabled);
    if (o.description != null) {
        const d = String(o.description).trim();
        base.description = d.length ? d.slice(0, 500) : null;
    }
    if (o.music_url != null) {
        const u = String(o.music_url).trim();
        base.music_url = u.length ? u.slice(0, 2048) : null;
    }
    if (o.autoboot_on_kick != null) base.autoboot_on_kick = Boolean(o.autoboot_on_kick);

    return base;
}

/**
 * @param {string} template
 * @param {{ user?: string, room?: string }} vars
 */
export function formatGreeting(template, { user = 'there', room = 'the room' } = {}) {
    const t = String(template || '').trim();
    if (!t) return null;
    return t.replace(/\{user\}/gi, user || 'there').replace(/\{room\}/gi, room || 'the room');
}

export function defaultGreetingText(user, room) {
    return `Hey ${user || 'there'} 👋 welcome to ${room || 'the room'}!`;
}
