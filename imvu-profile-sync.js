import axios from 'axios';
import { bulkPost } from './api-queue.js';
import { backendApiBaseUrl } from './env-app-url.js';

const BACKEND_URL = backendApiBaseUrl('http://127.0.0.1:8000');
const syncedAt = new Map();
const dashboardInflight = new Set();

const envFlag = (name, defaultValue = false) => {
    const raw = process.env[name];
    if (raw == null || String(raw).trim() === '') return defaultValue;
    const v = String(raw).trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
};

const envNumber = (name, defaultValue = 0) => {
    const n = Number(process.env[name]);
    return Number.isFinite(n) ? n : defaultValue;
};

const PROFILE_SYNC_ENABLED = envFlag('IMVU_PROFILE_SYNC_ENABLED', true);
const PROFILE_SYNC_COOLDOWN_MS = Math.max(
    0,
    envNumber('IMVU_PROFILE_SYNC_COOLDOWN_MS', 6 * 60 * 60 * 1000)
);

function postDashboardFulfill(payload) {
    return axios.post(`${BACKEND_URL}/api/imvu-profile/dashboard-fulfill`, payload);
}

/**
 * Resolve the logged-in bot account profile for POST /api/rooms/sync.
 *
 * @param {{ fetchFullUserProfile?: Function, resolveUserIdFromUsername?: Function } | null | undefined} sessionClient
 * @param {{ username?: string }} bot
 * @param {string | number | null | undefined} cachedUserId
 */
export async function resolveBotImvuProfile(sessionClient, bot, cachedUserId = null) {
    if (typeof sessionClient?.fetchFullUserProfile !== 'function') {
        return { userId: null, profile: null };
    }

    let userId = cachedUserId != null ? String(cachedUserId).trim() : '';
    if (!/^\d+$/.test(userId) && typeof sessionClient.resolveUserIdFromUsername === 'function') {
        userId = String((await sessionClient.resolveUserIdFromUsername(bot?.username, { log: true })) || '');
    }
    if (!/^\d+$/.test(userId)) {
        return { userId: null, profile: null };
    }

    const profile = await sessionClient.fetchFullUserProfile(userId);
    if (!profile || typeof profile !== 'object') {
        return { userId: null, profile: null };
    }

    return {
        userId: Number(profile.legacy_cid || userId),
        profile,
    };
}

/**
 * Fetch full IMVU profile via bot session and POST to Laravel /api/imvu-profile.
 */
export function queueImvuProfileSync({ sessionClient, userId, username, roomId, botName, isSelf = false }) {
    if (!PROFILE_SYNC_ENABLED) return;

    const id = String(userId || '').trim();
    if (!/^\d+$/.test(id)) return;
    if (isSelf) return;
    if (typeof sessionClient?.fetchFullUserProfile !== 'function') return;

    const last = syncedAt.get(id) || 0;
    if (Date.now() - last < PROFILE_SYNC_COOLDOWN_MS) return;
    syncedAt.set(id, Date.now());

    void (async () => {
        try {
            const profile = await sessionClient.fetchFullUserProfile(id);
            if (!profile || typeof profile !== 'object') return;

            bulkPost('/api/imvu-profile', {
                user_id: Number(profile.legacy_cid || id),
                username: profile.username || username || null,
                profile,
                room_id: roomId ? String(roomId) : null,
                bot_name: botName ? String(botName) : null,
            });
        } catch (e) {
            syncedAt.delete(id);
            console.warn(`[PROFILE-SYNC] failed for user-${id}:`, e?.message || e);
        }
    })();
}

/**
 * Dashboard queued fetch: resolve username -> user id, GET /user/user-{id}, POST back with dashboard_user_id.
 *
 * @param {import('./imvu-protocol/session.js').ImvuSessionClient | null | undefined} sessionClient
 * @param {{ dashboard_user_id?: number, username?: string, user_id?: number | string | null }} item
 * @param {string} botName
 */
export async function fetchAndPostDashboardProfile(sessionClient, item, botName) {
    const dashboardUserId = Number(item?.dashboard_user_id);
    const username = String(item?.username || '').trim();
    const key = `${dashboardUserId}:${username}`;
    if (!Number.isFinite(dashboardUserId) || dashboardUserId <= 0 || !username) {
        return { ok: false, reason: 'invalid request' };
    }
    if (dashboardInflight.has(key)) {
        return { ok: false, reason: 'inflight' };
    }
    if (typeof sessionClient?.fetchFullUserProfile !== 'function') {
        return { ok: false, reason: 'session unavailable' };
    }

    dashboardInflight.add(key);
    try {
        let userId = item?.user_id != null ? String(item.user_id).trim() : '';
        if (!/^\d+$/.test(userId) && typeof sessionClient.resolveUserIdFromUsername === 'function') {
            userId = String((await sessionClient.resolveUserIdFromUsername(username, { log: true })) || '');
        }
        if (!/^\d+$/.test(userId)) {
            return { ok: false, reason: `could not resolve user id for ${username}` };
        }

        const profile = await sessionClient.fetchFullUserProfile(userId);
        if (!profile || typeof profile !== 'object') {
            return { ok: false, reason: `fetch failed for user-${userId}` };
        }

        await postDashboardFulfill({
            dashboard_user_id: dashboardUserId,
            username: profile.username || username,
            bot_name: botName ? String(botName) : null,
            profile,
        });

        return { ok: true, user_id: Number(profile.legacy_cid || userId), username: profile.username || username };
    } catch (error) {
        return { ok: false, reason: error?.message || String(error) };
    } finally {
        dashboardInflight.delete(key);
    }
}
