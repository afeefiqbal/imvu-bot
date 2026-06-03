import axios from 'axios';
import { bulkPost } from './api-queue.js';
import { createConversationLogger, createSendMessage } from './user-tracker-chat.js';
import {
    createDomFallback,
    createImvuHandleResolver,
    createIncomingMessageHandler,
} from './user-tracker-events.js';
import {
    collectBotMentionAliases,
    getVisitorListForSync,
    normalizeImvuUsername,
    normalizeRoomApiSlug,
    welcomeHandleKey,
} from './user-tracker-utils.js';
import {
    findRosterEntryByHandle,
    parseDiscordKickLine,
    roomBootOwnerIdFromRoomId,
} from './imvu-discord-kick.js';
import { backendApiBaseUrl } from './env-app-url.js';
import {
    buildWelcomeText,
    createRoomChatCommandHandler,
    isLurkEnabledForRoom,
    maybeWarnMinAgeOnJoin,
    maybeWarnScalerOnJoin,
} from './room-commands/index.js';
import { getRoomSettings } from './room-settings/store.js';
import { registerRoomRuntime, unregisterRoomRuntime } from './room-runtime-registry.js';
import { tryVerificationCodeFromChat } from './imvu-verification-sync.js';

const envFlag = (name, defaultValue = false) => {
    const raw = process.env[name];
    if (raw == null || String(raw).trim() === '') return defaultValue;
    const v = String(raw).trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
};

const envList = (name, fallback = '') =>
    String(process.env[name] ?? fallback)
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);

const envNumber = (name, defaultValue = 0) => {
    const n = Number(process.env[name]);
    return Number.isFinite(n) ? n : defaultValue;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * IMVU User Tracker Module.
 * The pure runtime feeds direct WebSocket frames here; the CDP adapter remains for old frame consumers.
 */

/**
 * Attach CDP Network listeners for WebSocket frames on a browser page target.
 * This is retained only as a compatibility adapter; the default runtime uses direct WSS.
 */
export const attachToPageCDP = async (page, onMessage) => {
    const browser = page.browser();
    const sessions = [];
    const attachedTargets = new WeakSet();
    /** Drop duplicate frames when multiple targets observe the same WS payload. */
    const recentRaw = new Map();
    const DEDUPE_MS = 250;
    const pruneRecent = () => {
        const now = Date.now();
        for (const [k, t] of recentRaw) {
            if (now - t > DEDUPE_MS * 8) recentRaw.delete(k);
        }
    };

    const forwardPayload = (raw) => {
        if (raw == null || raw === '') return;
        pruneRecent();
        const now = Date.now();
        const key = raw.length > 4000 ? `${raw.slice(0, 2000)}…${raw.slice(-500)}` : raw;
        const prev = recentRaw.get(key);
        if (prev != null && now - prev < DEDUPE_MS) return;
        recentRaw.set(key, now);
        try {
            const data = JSON.parse(raw);
            onMessage(data);
        } catch {
            /* non-JSON WS payload */
        }
    };

    const wireSession = (session) => {
        session.on('Network.webSocketFrameReceived', ({ response }) => {
            forwardPayload(response?.payloadData);
        });
        session.on('Network.webSocketFrameSent', ({ response }) => {
            forwardPayload(response?.payloadData);
        });
    };

    const tryAttachTarget = async (target) => {
        if (attachedTargets.has(target)) return;
        try {
            const url = target.url() || '';
            if (url && !url.includes('imvu.com')) return;
            const typ = target.type();
            if (typ === 'browser') return;
            const session = await target.createCDPSession();
            await session.send('Network.enable');
            wireSession(session);
            sessions.push(session);
            attachedTargets.add(target);
        } catch {
            /* service workers / unsupported targets */
        }
    };

    try {
        await tryAttachTarget(page.target());
        for (const t of browser.targets()) {
            if (t === page.target()) continue;
            await tryAttachTarget(t);
        }

        const onTargetCreated = (t) => {
            void tryAttachTarget(t);
        };
        browser.on('targetcreated', onTargetCreated);

        const detachAll = async () => {
            browser.off('targetcreated', onTargetCreated);
            for (const s of sessions) {
                try {
                    await s.detach();
                } catch {
                    /* ignore */
                }
            }
            sessions.length = 0;
        };

        page.once('close', () => {
            void detachAll();
        });
    } catch (e) {
        console.error(`[TRACKER] CDP attach failed:`, e.message);
    }
};

export async function startProtocolUserTracking(protocolClient, roomId, options = {}) {
    return startUserTracking(
        {
            __imvuProtocolClient: protocolClient,
            isClosed: () => false,
            on: (event, handler) => protocolClient.on(event, handler),
        },
        roomId,
        { ...options, protocolClient, sessionClient: options.sessionClient || protocolClient?.session }
    );
}

export async function startUserTracking(page, roomId, options = {}) {
    const protocolClient = options.protocolClient || page?.__imvuProtocolClient || null;
    const sessionClient = options.sessionClient || protocolClient?.session || null;
    const protocolMode = Boolean(protocolClient);
    if (!protocolMode && (!page || page.isClosed())) return;

    console.log(
        `[TRACKER] ${protocolMode ? 'DIRECT WEBSOCKET' : 'CDP WEBSOCKET'} MODE enabled for room: ${roomId}`
    );

    const lastUserMap = new Map(); // avatarId -> username
    const API_BASE_URL = backendApiBaseUrl('http://127.0.0.1:8000');
    const syncBotName =
        (options.botName && String(options.botName).trim()) ||
        process.env.BOT_NAME ||
        process.env.BOT_PROFILE ||
        '';
    const syncBotUsername =
        (options.botUsername && String(options.botUsername).trim()) ||
        process.env.BOT_USERNAME ||
        '';
    const syncLogPrefix = syncBotName ? `[${syncBotName}][SYNC]` : '[SYNC]';
    const BOT_USERNAME = syncBotUsername || 'S1VA';
    const BOT_DISPLAY_NAME = (process.env.BOT_DISPLAY_NAME || BOT_USERNAME || '').trim();
    const processedJoins = new Set();
    /** Track active join sessions to prevent duplicate welcomes before leave */
    const activeJoinSessions = new Set();
    /** Delayed welcome timers keyed by avatar id, cancelled when a user leaves/is kicked. */
    const pendingWelcomeTimers = new Map();
    /** Cooldown timestamps to avoid rapid re‑welcome on same join */
    const welcomeTimestamps = new Map();
    const WELCOME_COOLDOWN_MS = 15000; // 15 s per avatar (rapid duplicate join_queue)
    const WELCOME_HANDLE_COOLDOWN_MS = parseInt(process.env.IMVU_WELCOME_REJOIN_MS || '600000', 10); // default 10 min per username
    const welcomeByHandleLastAt = new Map();
    /** One backend /api/room-users join per avatar from join_queue resolve (even if chat welcome is deferred) */
    const joinQueueBackendAnnounced = new Set();
    const mentionReplyDedupe = new Set();
    const MENTION_REPLY_DEDUPE_CAP = 400;
    /** Recently kicked/autobooted IDs whose queued chat frames should be ignored. */
    const suppressedAvatarIds = new Map();
    /** Avatar ids already in room at sync / bot join — no welcome DM */
    const skipWelcomeAvatarIds = new Set();
    /** Avoid opening the welcome gate while IMVU has not reported anyone yet (empty roster → false "new" joins). */
    let welcomeGateEmptyRetries = 0;
    const MAX_WELCOME_GATE_EMPTY_RETRIES = 6;
    const WELCOME_GATE_EMPTY_RETRY_MS = 2500;

    /** Display title for welcome messages (from DOM after join). */
    let ROOM_NAME = 'this room';

    const fetchRoomTitleFromDom = async () => {
        if (protocolMode) return options.roomName || null;
        try {
            if (!page || page.isClosed()) return null;
            return await page.evaluate(() => {
                const UI_LINE =
                    /scroll to latest|all messages|^send$|loading\s*\d*\s*%|is in the chat|joined the chat/i;

                const normalize = (raw) => {
                    if (!raw || typeof raw !== 'string') return null;
                    const lines = raw
                        .split(/\r?\n/)
                        .map((l) => l.trim())
                        .filter(Boolean);
                    for (const line of lines) {
                        if (line.length > 100) continue;
                        if (UI_LINE.test(line)) continue;
                        if (/^[\p{Emoji}\s\ufe0f]+$/u.test(line) && line.length < 4) continue;
                        return line;
                    }
                    return null;
                };

                const nameEl =
                    document.querySelector('.room-info-name') ||
                    document.querySelector('.room-name');
                if (nameEl) {
                    const t = normalize(nameEl.innerText || '');
                    if (t) return t;
                }

                let fromDocTitle = (document.title || '').trim();
                fromDocTitle = fromDocTitle
                    .replace(/^IMVU\s*Next\s*-\s*Chat\s*-\s*/i, '')
                    .replace(/\s*-\s*IMVU(?:\s+Next)?.*$/i, '')
                    .trim();

                return normalize(fromDocTitle);
            });
        } catch {
            return null;
        }
    };

    let roomDetailsFromApiCache = null;

    /**
     * Room name + poster from https://api.imvu.com/room/room-{id}-{subId}
     * (session cookies, same origin as chat).
     */
    const fetchRoomDetailsFromApi = async () => {
        if (roomDetailsFromApiCache) {
            return roomDetailsFromApiCache;
        }
        const slug = normalizeRoomApiSlug(roomId);
        if (!slug) {
            return null;
        }
        if (sessionClient?.fetchRoomDetails) {
            const details = await sessionClient.fetchRoomDetails(slug);
            if (details && (details.name || details.image_url)) {
                roomDetailsFromApiCache = {
                    name: details.name || '',
                    image_url: details.image_url || '',
                };
                return roomDetailsFromApiCache;
            }
            return null;
        }
        if (!page || page.isClosed()) {
            return null;
        }
        try {
            const details = await page.evaluate(async (roomSlug) => {
                try {
                    const apiUrl = `https://api.imvu.com/room/${roomSlug}`;
                    const res = await fetch(apiUrl, {
                        credentials: 'include',
                        mode: 'cors',
                        headers: { Accept: 'application/json' },
                    });
                    if (!res.ok) return null;
                    const json = await res.json();
                    const denorm = json.denormalized || {};
                    const entry =
                        (json.id && denorm[json.id]) ||
                        Object.values(denorm)[0];
                    const d = entry?.data;
                    if (!d) return null;
                    const pickUrl = (u) => {
                        if (typeof u !== 'string') return '';
                        const t = u.trim();
                        return /^https?:\/\//i.test(t) ? t : '';
                    };
                    const n = typeof d.name === 'string' ? d.name.trim() : '';
                    const image_url =
                        pickUrl(d.poster_url) ||
                        pickUrl(d.thumbnail_url) ||
                        pickUrl(d.image_url) ||
                        pickUrl(d.preview_url) ||
                        pickUrl(d.properties?.poster_url) ||
                        '';
                    return {
                        name: n || null,
                        image_url: image_url || null,
                    };
                } catch {
                    return null;
                }
            }, slug);
            if (details && (details.name || details.image_url)) {
                roomDetailsFromApiCache = {
                    name: details.name || '',
                    image_url: details.image_url || '',
                };
                return roomDetailsFromApiCache;
            }
        } catch {
            /* ignore */
        }
        return null;
    };

    const fetchRoomPosterFromDom = async () => {
        try {
            if (!page || page.isClosed()) return '';
            return await page.evaluate(() => {
                const imgEl =
                    document.querySelector('.room-img img') ||
                    document.querySelector('.room-poster img');
                let src = imgEl?.src || imgEl?.getAttribute?.('data-src') || '';
                if (typeof src !== 'string') return '';
                src = src.trim();
                return /^https?:\/\//i.test(src) ? src : '';
            });
        } catch {
            return '';
        }
    };

    let dashboardSyncTimer = null;
    /** Skip console spam when population / visitors / title unchanged (multi-bot shared terminal). */
    let lastDashboardSyncLogSig = '';
    const scheduleDashboardSync = () => {
        clearTimeout(dashboardSyncTimer);
        dashboardSyncTimer = setTimeout(() => {
            void pushDashboardRoomSync();
        }, 2000);
    };

    const pushDashboardRoomSync = async () => {
        const rid = String(roomId).trim().replace(/^room-/i, '');
        if (!rid) return;

        let displayName = ROOM_NAME;
        if (!displayName || displayName === 'this room') {
            const domName = await fetchRoomTitleFromDom();
            if (domName) displayName = domName;
        }

        const apiDetails = await fetchRoomDetailsFromApi();
        let imageUrl = apiDetails?.image_url || '';
        if (apiDetails?.name) {
            displayName = apiDetails.name;
        }

        if (!imageUrl) {
            imageUrl = await fetchRoomPosterFromDom();
        }

        const visitors = getVisitorListForSync(lastUserMap);
        const population = lastUserMap.size;

        const body = {
            rooms: [
                {
                    id: rid,
                    name:
                        displayName && displayName !== 'this room'
                            ? displayName
                            : 'Unknown',
                    description: apiDetails?.description || '',
                    image_url: imageUrl || '',
                    visitors,
                    population,
                },
            ],
        };
        if (syncBotName) body.bot_name = syncBotName;
        if (syncBotUsername) body.bot_username = syncBotUsername;

        try {
            bulkPost('/api/rooms/sync', body);
            const visitorSig = visitors
                .slice()
                .sort()
                .join('\u001f');
            const sig = `${rid}|${body.rooms[0].name}|${population}|${visitorSig}`;
            if (sig !== lastDashboardSyncLogSig) {
                lastDashboardSyncLogSig = sig;
                console.log(
                    `${syncLogPrefix} room ${rid} · "${body.rooms[0].name}" · pop ${population} · ${visitors.length} visitors`
                );
            }
        } catch (e) {
            console.log(`${syncLogPrefix} dashboard failed:`, e?.message || e);
        }
    };

    const refreshRoomName = async () => {
        const fromApi = await fetchRoomDetailsFromApi();
        if (fromApi?.name) {
            ROOM_NAME = fromApi.name;
            state.roomName = ROOM_NAME;
            console.log(`[ROOM] ${ROOM_NAME} (api)`);
        } else {
            const fromDom = await fetchRoomTitleFromDom();
            if (fromDom) {
                ROOM_NAME = fromDom;
                state.roomName = ROOM_NAME;
                console.log(`[ROOM] ${ROOM_NAME} (dom)`);
            }
        }
        scheduleDashboardSync();
    };

    const botMentionAliases = collectBotMentionAliases(BOT_USERNAME, BOT_DISPLAY_NAME);
    const logConversationTurn = createConversationLogger({ apiBaseUrl: API_BASE_URL, roomId });
    const sendMessage = createSendMessage({ page, protocolClient, logConversationTurn });

    const state = {
        selfUserId: protocolClient?.bot?.imqUserId || null,
        botJoinedChat: false,
        welcomeArrivalsEnabled: false,
        participantsRosterSynced: false,
        welcomeArrivalsEnableTimer: null,
        initialLegacyRosterStarted: false,
        initialLegacyRosterUntil: 0,
    };

    /** One listener per tab; remove on page close to avoid MaxListenersExceeded / leaks. */
    let onDiscordRelayChat = null;
    if (global.discordBridge) {
        onDiscordRelayChat = async ({ targetRoomId, content }) => {
            if (!state.botJoinedChat) return;
            if (targetRoomId === String(roomId)) {
                await sendMessage(content);
            }
        };
        global.discordBridge.on('chat', onDiscordRelayChat);
    }

    const onJoin = async (username) => {
        console.log(`[JOIN] ${username}`);

        try {
            bulkPost('/api/room-users', {
                username, room_id: roomId, event: 'join', timestamp: new Date().toISOString()
            });
        } catch (e) {}
    };

    const onLeave = async (username) => {
        console.log(`[LEAVE] ${username}`);

        // Skip bot itself
        if (String(username || '').trim().toLowerCase() === String(BOT_USERNAME || '').trim().toLowerCase()) return;

        try {
            bulkPost('/api/room-users', {
                username, room_id: roomId, event: 'leave', timestamp: new Date().toISOString()
            });
        } catch (e) {}
    };

    const hasResolvedOccupantName = (v) =>
        v !== null && v !== undefined && String(v).trim() !== '';

    const enableWelcomeForNewArrivals = () => {
        if (
            lastUserMap.size === 0 &&
            skipWelcomeAvatarIds.size === 0 &&
            welcomeGateEmptyRetries < MAX_WELCOME_GATE_EMPTY_RETRIES
        ) {
            welcomeGateEmptyRetries++;
            if (state.welcomeArrivalsEnableTimer) {
                clearTimeout(state.welcomeArrivalsEnableTimer);
            }
            state.welcomeArrivalsEnableTimer = setTimeout(() => {
                state.welcomeArrivalsEnableTimer = null;
                enableWelcomeForNewArrivals();
            }, WELCOME_GATE_EMPTY_RETRY_MS);
            return;
        }
        welcomeGateEmptyRetries = 0;

        // Skip self always. Skip others only when we already know their handle — those are true
        // "already here" occupants (roster or resolved join_queue). Co-arrivals often sit in
        // lastUserMap as join_queue bootstrap with label null until /user resolves; if we skip
        // them here they never get a welcome (see bootstrap + gate OPEN in the same second).
        const selfSid = state.selfUserId != null ? String(state.selfUserId) : null;
        for (const aid of lastUserMap.keys()) {
            if (aid == null || aid === undefined) continue;
            const sid = String(aid);
            if (selfSid != null && sid === selfSid) {
                skipWelcomeAvatarIds.add(sid);
                continue;
            }
            const label = lastUserMap.get(aid);
            if (hasResolvedOccupantName(label)) {
                skipWelcomeAvatarIds.add(sid);
                joinQueueBackendAnnounced.add(sid);
            }
        }
        // ✅ Mark roster as synced (covers fallback timer path)
        state.participantsRosterSynced = true;
        state.welcomeArrivalsEnabled = true;
        if (state.welcomeArrivalsEnableTimer) {
            clearTimeout(state.welcomeArrivalsEnableTimer);
            state.welcomeArrivalsEnableTimer = null;
        }
        console.log(
            `${syncLogPrefix} 🔓 Welcome gate OPEN — ${skipWelcomeAvatarIds.size} existing users blocked`
        );
    };

    const isSelfId = (id) =>
        id != null &&
        state.selfUserId != null &&
        String(id) === String(state.selfUserId);

    const rosterHasUserId = (id) => lastUserMap.has(String(id));
    const waitUntilRosterAbsent = async (targetId, timeoutMs = 8000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (!rosterHasUserId(targetId)) return true;
            await sleep(350);
        }
        return !rosterHasUserId(targetId);
    };

    const kickCommandsEnabled = envFlag('IMVU_KICK_ENABLED', true);
    const kickAllowAll = envFlag('IMVU_KICK_ALLOW_ALL', false);
    const kickAllowRoomOwner = envFlag('IMVU_KICK_ALLOW_ROOM_OWNER', true);
    const kickAllowRoomMods = envFlag('IMVU_KICK_ALLOW_ROOM_MODS', true);
    const kickRestFirst = envFlag('IMVU_KICK_REST_FIRST', true);
    const kickCommanderIds = new Set(envList('IMVU_KICK_COMMANDER_IDS').filter((v) => /^\d+$/.test(v)));
    const kickCommanderHandles = new Set(
        envList('IMVU_KICK_COMMANDER_HANDLES')
            .map((v) => welcomeHandleKey(v))
            .filter(Boolean)
    );
    const autobootEnabled = envFlag('IMVU_AUTOBOOT_ENABLED', false);
    const autobootAvatarIds = new Set(envList('IMVU_AUTOBOOT_AVATAR_IDS').filter((v) => /^\d+$/.test(v)));
    const autobootAvatarIdPrefixes = envList('IMVU_AUTOBOOT_AVATAR_ID_PREFIXES')
        .filter((v) => /^\d+$/.test(v));
    const autobootAvatarIdRanges = envList('IMVU_AUTOBOOT_AVATAR_ID_RANGES')
        .map((raw) => {
            const match = String(raw).match(/^(\d+)\s*-\s*(\d+)$/);
            if (!match) return null;
            const start = Number(match[1]);
            const end = Number(match[2]);
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
            return start <= end ? { start, end } : { start: end, end: start };
        })
        .filter(Boolean);
    const autobootHandles = new Set(
        envList('IMVU_AUTOBOOT_HANDLES')
            .map((v) => welcomeHandleKey(v))
            .filter(Boolean)
    );
    const autobootPatterns = envList('IMVU_AUTOBOOT_PATTERNS')
        .map((v) => v.toLowerCase())
        .filter(Boolean);
    const autobootAccountMaxAgeHours = Math.max(
        0,
        envNumber('IMVU_AUTOBOOT_ACCOUNT_MAX_AGE_HOURS', 0)
    );
    const kickInflight = new Set();
    const freshAccountChecks = new Map();
    const lastSpokeAt = new Map();
    const minAgeWarned = new Set();
    const scalerWarnedAt = new Map();
    const roomCommandsEnabled = envFlag('IMVU_ROOM_COMMANDS_ENABLED', true);
    let cachedRoomOwnerId = null;
    let cachedRoomModeratorIds = null;
    let cachedRoomOwnerUsername = null;

    const getRoomOwnerId = async () => {
        if (cachedRoomOwnerId !== null) return cachedRoomOwnerId;
        cachedRoomOwnerId =
            (await sessionClient?.fetchRoomOwnerId?.(roomId)) ||
            roomBootOwnerIdFromRoomId(roomId) ||
            '';
        return cachedRoomOwnerId;
    };

    const getRoomOwnerUsername = async () => {
        if (cachedRoomOwnerUsername !== null) return cachedRoomOwnerUsername;
        const details = await sessionClient?.fetchRoomDetails?.(roomId);
        cachedRoomOwnerUsername =
            welcomeHandleKey(details?.owner_username || details?.owner_avatarname || '') || '';
        return cachedRoomOwnerUsername;
    };

    const getRoomModeratorIds = async () => {
        if (cachedRoomModeratorIds) return cachedRoomModeratorIds;
        cachedRoomModeratorIds = new Set((await sessionClient?.fetchRoomModeratorIds?.(roomId)) || []);
        return cachedRoomModeratorIds;
    };

    const canUseRoomManageCommand = async ({ senderId, senderLabel }) => {
        const sid = senderId != null ? String(senderId) : '';
        const ownerId = String(await getRoomOwnerId());
        if (sid && ownerId && sid === ownerId) return true;
        if (sid && (await getRoomModeratorIds()).has(sid)) return true;

        const handleKey = welcomeHandleKey(senderLabel);
        if (!handleKey) return false;
        if (handleKey === (await getRoomOwnerUsername())) return true;

        const moderators = await sessionClient?.fetchRoomModerators?.(roomId);
        if (Array.isArray(moderators)) {
            for (const mod of moderators) {
                if (welcomeHandleKey(mod?.username || mod?.avatarname) === handleKey) return true;
            }
        }
        return false;
    };

    const canUseKickCommand = async ({ senderId, senderLabel }) => {
        if (!kickCommandsEnabled) return false;
        if (kickAllowAll) return true;

        const sid = senderId != null ? String(senderId) : '';
        if (sid && kickCommanderIds.has(sid)) return true;

        const handleKey = welcomeHandleKey(senderLabel);
        if (handleKey && kickCommanderHandles.has(handleKey)) return true;

        if (sid && kickAllowRoomOwner && sid === String(await getRoomOwnerId())) return true;
        if (sid && kickAllowRoomMods && (await getRoomModeratorIds()).has(sid)) return true;

        return false;
    };

    const cancelPendingWelcome = (avatarId) => {
        const id = String(avatarId || '');
        const timer = pendingWelcomeTimers.get(id);
        if (timer) clearTimeout(timer);
        pendingWelcomeTimers.delete(id);
    };

    const suppressAvatarChat = (avatarId, ttlMs = 5 * 60 * 1000) => {
        const id = String(avatarId || '');
        if (!/^\d+$/.test(id)) return;
        suppressedAvatarIds.set(id, Date.now() + ttlMs);
    };

    const isSuppressedAvatarId = (avatarId) => {
        const id = String(avatarId || '');
        const until = suppressedAvatarIds.get(id);
        if (!until) return false;
        if (Date.now() > until) {
            suppressedAvatarIds.delete(id);
            return false;
        }
        return true;
    };

    const markUserRemovedLocally = (target) => {
        const avatarId = String(target?.avatarId || '');
        if (!avatarId) return;
        const label = target?.label ? String(target.label) : '';
        suppressAvatarChat(avatarId);
        cancelPendingWelcome(avatarId);
        lastUserMap.delete(avatarId);
        joinQueueBackendAnnounced.delete(avatarId);
        activeJoinSessions.delete(avatarId);
        processedJoins.delete(avatarId);
        if (label && !isSelfId(avatarId)) void onLeave(label);
        triggerCountUpdate();
    };

    const bootAvatar = async (target, reason, { reply = false } = {}) => {
        const avatarId = String(target?.avatarId || '');
        const label = String(target?.label || avatarId || 'user');
        const logPrefix = reason === 'autoboot' ? '[AUTOBOOT]' : '[KICK]';
        if (!/^\d+$/.test(avatarId)) return false;
        if (isSelfId(avatarId)) {
            if (reply) await sendMessage('Cannot kick myself.');
            return true;
        }
        suppressAvatarChat(avatarId);
        cancelPendingWelcome(avatarId);
        if (kickInflight.has(avatarId)) return true;
        kickInflight.add(avatarId);

        try {
            let removed = false;
            let restAttempts = [];

            if (kickRestFirst && typeof sessionClient?.removeChatParticipant === 'function') {
                const rest = await sessionClient.removeChatParticipant(roomId, avatarId);
                restAttempts = rest.attempts || [];
                removed = Boolean(rest.ok);
                if (removed) {
                    markUserRemovedLocally(target);
                    console.log(`${logPrefix} removed ${label} (${avatarId}) via REST participant DELETE`);
                } else if (restAttempts.length) {
                    console.log(`${logPrefix} REST participant DELETE failed: ${JSON.stringify(restAttempts)}`);
                }
            }

            const ownerId = await getRoomOwnerId();
            if (!removed && ownerId) {
                await sendMessage(`*boot ${ownerId} ${avatarId}`);
                removed = await waitUntilRosterAbsent(avatarId, 10000);
                if (!removed) {
                    await sendMessage(`*imvu:txnBoot ${avatarId}`);
                    removed = await waitUntilRosterAbsent(avatarId, 10000);
                }
                if (removed) {
                    markUserRemovedLocally(target);
                    console.log(`${logPrefix} removed ${label} (${avatarId}) via legacy boot fallback`);
                }
            }

            if (reply) {
                await sendMessage(
                    removed
                        ? `Removed ${label}.`
                        : `Kick failed for ${label}; IMVU did not remove them.`
                );
            }
            if (!removed) {
                console.log(`${logPrefix} failed for ${label} (${avatarId}) reason=${reason}`);
            }
            return removed;
        } finally {
            kickInflight.delete(avatarId);
        }
    };

    const autobootTargetFromIdentity = (avatarId, label) => {
        if (!autobootEnabled) return null;
        const id = String(avatarId || '');
        const handleKey = welcomeHandleKey(label);
        if (id && autobootAvatarIds.has(id)) return { avatarId: id, label: String(label || id) };
        if (id && autobootAvatarIdPrefixes.some((prefix) => id.startsWith(prefix))) {
            return { avatarId: id, label: String(label || id) };
        }
        const numericId = Number(id);
        if (
            Number.isSafeInteger(numericId) &&
            autobootAvatarIdRanges.some((range) => numericId >= range.start && numericId <= range.end)
        ) {
            return { avatarId: id, label: String(label || id) };
        }
        if (handleKey && autobootHandles.has(handleKey) && id) return { avatarId: id, label: String(label || id) };
        return null;
    };

    const maybeAutobootJoin = (avatarId, label) => {
        const target = autobootTargetFromIdentity(avatarId, label);
        if (!target) return false;
        void bootAvatar(target, 'autoboot', { reply: false });
        return true;
    };

    const profileCreatedAtMs = (profile) => {
        if (!profile || typeof profile !== 'object') return null;
        if (profile.created) {
            const parsed = Date.parse(profile.created);
            if (Number.isFinite(parsed)) return parsed;
        }
        const registered = Number(profile.registered);
        if (Number.isFinite(registered) && registered > 0) {
            return registered > 9999999999 ? registered : registered * 1000;
        }
        return null;
    };

    const maybeAutobootFreshAccount = async (avatarId, label) => {
        const id = String(avatarId || '');
        if (maybeAutobootJoin(id, label)) {
            return true;
        }
        if (
            !autobootEnabled ||
            autobootAccountMaxAgeHours <= 0 ||
            !/^\d+$/.test(id) ||
            isSelfId(id) ||
            typeof sessionClient?.fetchUserProfile !== 'function'
        ) {
            return false;
        }

        const existing = freshAccountChecks.get(id);
        if (existing) return existing;

        const promise = (async () => {
            const profile = await sessionClient.fetchUserProfile(id);
            const createdAtMs = profileCreatedAtMs(profile);
            if (!createdAtMs) return false;

            const ageMs = Date.now() - createdAtMs;
            const maxAgeMs = autobootAccountMaxAgeHours * 60 * 60 * 1000;
            if (ageMs < 0 || ageMs > maxAgeMs) return false;

            const ageHours = Math.max(0, ageMs / (60 * 60 * 1000));
            const name = profile?.username || label || id;
            await bootAvatar(
                { avatarId: id, label: name },
                `autoboot fresh account ${ageHours.toFixed(1)}h old`,
                { reply: false }
            );
            return true;
        })().finally(() => {
            freshAccountChecks.delete(id);
        });

        freshAccountChecks.set(id, promise);
        return promise;
    };

    const handleAutoBootMessage = async ({ text, senderId, senderLabel }) => {
        if (!autobootEnabled || !senderId || isSelfId(senderId)) return false;
        const lower = String(text || '').toLowerCase();
        const matched = autobootPatterns.find((pattern) => pattern && lower.includes(pattern));
        if (!matched) return false;
        await bootAvatar(
            { avatarId: String(senderId), label: senderLabel || String(senderId) },
            `autoboot pattern "${matched}"`,
            { reply: false }
        );
        return true;
    };

    const handleKickCommand = async ({ text, senderId, senderLabel }) => {
        const parsed = parseDiscordKickLine(text);
        if (!parsed) return false;

        if (!(await canUseKickCommand({ senderId, senderLabel }))) {
            console.log(`[KICK] refused command from ${senderLabel || senderId || 'unknown'} in room ${roomId}`);
            await sendMessage('Kick command refused; only configured commanders, room owner, or room mods can use it.');
            return true;
        }

        const target = findRosterEntryByHandle(lastUserMap, parsed.handle);
        if (!target) {
            await sendMessage(`No one in this room matches "${parsed.handle}".`);
            return true;
        }

        await bootAvatar(target, `command by ${senderLabel || senderId || 'unknown'}`, { reply: true });
        return true;
    };

    const announceJoinQueuePresence = (avatarId, label) => {
        if (!avatarId || isSelfId(avatarId)) return;

        // 🚫 BLOCK if still in initial sync phase
        if (!state.participantsRosterSynced || !state.welcomeArrivalsEnabled) {
            return;
        }

        const n = String(label ?? '').trim();
        if (!n) return;

        if (joinQueueBackendAnnounced.has(avatarId)) return;

        joinQueueBackendAnnounced.add(avatarId);
        void onJoin(normalizeImvuUsername(n) || n);
    };


    /**
     * @returns {boolean} true if welcome was scheduled (keep processedJoins); false to allow retry / duplicate join_queue coalescing
     */
    const scheduleWelcomeForAvatar = (avatarId, displayName, convMeta) => {
        if (
            !avatarId ||
            !state.botJoinedChat ||
            !state.welcomeArrivalsEnabled ||
            isSelfId(avatarId)
        ) {
            return false;
        }
        if (skipWelcomeAvatarIds.has(String(avatarId))) {
            console.log(
                `${syncLogPrefix} welcome skipped for ${displayName || avatarId} (already in room when bot joined)`
            );
            return true;
        }
        if (options.visibilityEnabled === false) {
            return true;
        }
        if (maybeAutobootJoin(avatarId, displayName)) {
            return true;
        }
        const handleKey = welcomeHandleKey(displayName);
        if (!handleKey) return false;
        // 🚨 HARD LOCK IMMEDIATELY
        if (activeJoinSessions.has(avatarId)) {
            return false;
        }
        activeJoinSessions.add(avatarId);

        // cooldown check AFTER lock
        const lastWelcome = welcomeTimestamps.get(avatarId);
        if (lastWelcome && (Date.now() - lastWelcome) < WELCOME_COOLDOWN_MS) {
            activeJoinSessions.delete(avatarId); // release lock
            console.log(
                `${syncLogPrefix} welcome skipped for ${displayName || avatarId} (avatar cooldown ${Math.round((WELCOME_COOLDOWN_MS - (Date.now() - lastWelcome)) / 1000)}s left)`
            );
            return false;
        }

        if (WELCOME_HANDLE_COOLDOWN_MS > 0) {
            const lastByHandle = welcomeByHandleLastAt.get(handleKey);
            if (
                lastByHandle != null &&
                Date.now() - lastByHandle < WELCOME_HANDLE_COOLDOWN_MS
            ) {
                activeJoinSessions.delete(avatarId);
                console.log(
                    `${syncLogPrefix} welcome skipped for ${displayName || avatarId} (handle cooldown ${Math.round((WELCOME_HANDLE_COOLDOWN_MS - (Date.now() - lastByHandle)) / 60000)}m left)`
                );
                return false;
            }
        }

        welcomeTimestamps.set(avatarId, Date.now());
        welcomeByHandleLastAt.set(handleKey, Date.now());
        if (activeJoinSessions.size > 200) {
            activeJoinSessions.clear();
        }
        if (welcomeTimestamps.size > 400) {
            welcomeTimestamps.clear();
        }
        if (welcomeByHandleLastAt.size > 400) {
            welcomeByHandleLastAt.clear();
        }
        cancelPendingWelcome(avatarId);
        const settingsForWelcome = buildWelcomeText(roomId, displayName, ROOM_NAME);
        if (!settingsForWelcome) {
            const settings = getRoomSettings(roomId);
            const reason = settings.auto_greet ? 'empty greeting' : 'auto_greet off — use !autogreet on';
            console.log(`${syncLogPrefix} welcome skipped for ${displayName || avatarId} (${reason})`);
            activeJoinSessions.delete(avatarId);
            void maybeWarnMinAgeOnJoin({
                roomId,
                avatarId,
                displayName,
                sessionClient,
                minAgeWarned,
                sendMessage,
            });
            void maybeWarnScalerOnJoin({
                roomId,
                avatarId,
                displayName,
                sessionClient,
                scalerWarnedAt,
                sendMessage,
            });
            return true;
        }
        const welcomeTimer = setTimeout(async () => {
            try {
                if (!lastUserMap.has(String(avatarId))) {
                    return;
                }
                if (ROOM_NAME === 'this room') {
                    await refreshRoomName();
                }
                if (!lastUserMap.has(String(avatarId))) {
                    return;
                }

                const welcomeText =
                    buildWelcomeText(roomId, displayName, ROOM_NAME) || settingsForWelcome;
                await sendMessage(welcomeText, convMeta);
                void maybeWarnMinAgeOnJoin({
                    roomId,
                    avatarId,
                    displayName,
                    sessionClient,
                    minAgeWarned,
                    sendMessage,
                });
                void maybeWarnScalerOnJoin({
                    roomId,
                    avatarId,
                    displayName,
                    sessionClient,
                    scalerWarnedAt,
                    sendMessage,
                });

            } finally {
                // 🔓 ALWAYS release lock after welcome
                activeJoinSessions.delete(avatarId);
                pendingWelcomeTimers.delete(String(avatarId));
            }
        }, 1500);
        pendingWelcomeTimers.set(String(avatarId), welcomeTimer);
        return true;
    };

    const updateCount = () => {
        // Occupancy should reflect active avatar IDs even before name resolution.
        const phase = state.botJoinedChat ? 'AFTER_JOIN' : 'BEFORE_JOIN';
        console.log(`[COUNT][${phase}] 👥 Total Occupants: ${lastUserMap.size}`);
        scheduleDashboardSync();
    };

    let countTimer = null;
    const triggerCountUpdate = () => {
        clearTimeout(countTimer);
        countTimer = setTimeout(updateCount, 300);
    };

    const resolveImvuHandleFromNumericId = createImvuHandleResolver({ page, sessionClient });

    let roomChatCommandHandler = null;
    if (roomCommandsEnabled) {
        roomChatCommandHandler = createRoomChatCommandHandler({
            roomId,
            botName: syncBotName,
            apiBaseUrl: API_BASE_URL,
            sendMessage,
            getRoomName: () => ROOM_NAME,
            getSelfUserId: () => (state.selfUserId != null ? String(state.selfUserId) : null),
            canUseRoomCommand: canUseRoomManageCommand,
            watchDirectMessageUser:
                typeof sessionClient?.watchDirectMessageUser === 'function'
                    ? (userId) => sessionClient.watchDirectMessageUser(userId)
                    : undefined,
            sessionClient,
            getRoomModerators: async () => sessionClient?.fetchRoomModerators?.(roomId) || [],
            lastUserMap,
            lastSpokeAt,
            minAgeWarned,
            scalerWarnedAt,
        });
        console.log(`${syncLogPrefix} room commands on (!help !info !roomid !move …)`);
    }

    const handleIncomingMessage = createIncomingMessageHandler({
        API_BASE_URL,
        BOT_DISPLAY_NAME,
        BOT_USERNAME,
        discordGuildId: options.discordGuildId || options.discordChannelId,
        discordRoomChannelId: options.discordRoomChannelId || null,
        MENTION_REPLY_DEDUPE_CAP,
        activeJoinSessions,
        announceJoinQueuePresence,
        botMentionAliases,
        enableWelcomeForNewArrivals,
        isSelfId,
        joinQueueBackendAnnounced,
        lastUserMap,
        logConversationTurn,
        mentionReplyDedupe,
        onJoin,
        onLeave,
        processedJoins,
        refreshRoomName,
        resolveImvuHandleFromNumericId,
        maybeAutobootFreshAccount,
        cancelPendingWelcome,
        isSuppressedAvatarId,
        roomChatCommandHandler,
        isLurkEnabled: () => isLurkEnabledForRoom(roomId),
        roomKickCommandHandler: handleKickCommand,
        autoBootMessageHandler: handleAutoBootMessage,
        lastSpokeAt,
        roomId,
        getRoomChatQueue: () => protocolClient?.chatQueue || '',
        isPresenceRepairInFlight: () => Boolean(protocolClient?.presenceRepairInFlight),
        scheduleWelcomeForAvatar,
        sendMessage,
        skipWelcomeAvatarIds,
        state,
        triggerCountUpdate,
        welcomeByHandleLastAt,
        welcomeTimestamps,
        tryVerificationCodeFromChat: ({ senderLabel, senderId, text }) =>
            tryVerificationCodeFromChat({
                senderLabel,
                senderId,
                text,
                botName: syncBotName || syncBotUsername || BOT_USERNAME,
            }),
    });

    let roomNameRetries = 0;
    let checkRoomNameInterval = null;
    if (process.env.DISCORD_BOT_API_URL) {
        // Wait until roomName is successfully scraped from IMVU before initializing Discord channel
        checkRoomNameInterval = setInterval(async () => {
            roomNameRetries++;
            const cleanName = (state.roomName || '').toLowerCase().replace(/[^a-z]/g, '');
            const isGeneric = cleanName.includes('imvunext') || cleanName === 'imvu' || cleanName.includes('avatarsocialapp');
            // Do not accept any variation of the generic loading page title
            if ((state.roomName && !isGeneric && state.roomName !== 'Unknown') || roomNameRetries >= 40) {
                clearInterval(checkRoomNameInterval);
                checkRoomNameInterval = null;
                axios.post(process.env.DISCORD_BOT_API_URL.replace('imvu-chat', 'imvu-init-room'), {
                    room_id: String(roomId),
                    room_name: state.roomName || 'Unknown Room',
                    discord_channel_id: options.discordGuildId || options.discordChannelId,
                    discord_room_channel_id: options.discordRoomChannelId || undefined,
                }).catch(()=>null);
            } else {
                // Manually trigger a refresh if it hasn't happened yet
                await refreshRoomName().catch(()=>null);
            }
        }, 1500);
    }

    const syncIntervalId = setInterval(() => {
        if (state.botJoinedChat) {
            scheduleDashboardSync();
        }
    }, 45000);

    const cleanupIntervalId = setInterval(() => {
        if (processedJoins.size > 500) processedJoins.clear();
        if (mentionReplyDedupe.size > 500) mentionReplyDedupe.clear();
        if (welcomeTimestamps.size > 500) welcomeTimestamps.clear();
        if (welcomeByHandleLastAt.size > 500) welcomeByHandleLastAt.clear();
        for (const [id, until] of suppressedAvatarIds.entries()) {
            if (Date.now() > until) suppressedAvatarIds.delete(id);
        }
    }, 60000);

    const cleanupTracker = () => {
        unregisterRoomRuntime(roomId);
        if (roomChatCommandHandler?.stopScaleInterval) {
            roomChatCommandHandler.stopScaleInterval();
        }
        if (onDiscordRelayChat && global.discordBridge) {
            global.discordBridge.off('chat', onDiscordRelayChat);
        }
        if (checkRoomNameInterval) clearInterval(checkRoomNameInterval);
        clearInterval(syncIntervalId);
        clearInterval(cleanupIntervalId);
        if (dashboardSyncTimer) clearTimeout(dashboardSyncTimer);
        if (countTimer) clearTimeout(countTimer);
        for (const timer of pendingWelcomeTimers.values()) clearTimeout(timer);
        pendingWelcomeTimers.clear();
        if (state.welcomeArrivalsEnableTimer) clearTimeout(state.welcomeArrivalsEnableTimer);
    };

    // CRITICAL FIX: Ensure intervals are cleared and page/client references dropped when closed.
    if (protocolMode) {
        protocolClient.once('close', cleanupTracker);
    } else {
        page.on('close', cleanupTracker);
    }

    if (protocolMode) {
        protocolClient.on('frame', (data) => {
            void handleIncomingMessage(data);
        });
    } else {
        await attachToPageCDP(page, (data) => {
            void handleIncomingMessage(data);
        });

        const runDOMFallback = createDomFallback({ page, lastUserMap, triggerCountUpdate });
        setTimeout(runDOMFallback, 5000);
    }

    registerRoomRuntime(roomId, {
        roomId,
        sendMessage: (text) => sendMessage(String(text || '').slice(0, 500)),
        kickByUsername: async (username, opts = {}) => {
            const target = findRosterEntryByHandle(lastUserMap, username);
            if (!target) return { ok: false, reason: 'not-in-room' };
            const removed = await bootAvatar(target, opts.reason || 'dashboard-kick', { reply: false });
            return { ok: Boolean(removed), reason: removed ? undefined : 'kick-failed' };
        },
        getVisitors: () => getVisitorListForSync(lastUserMap),
    });
}
