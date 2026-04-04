import axios from 'axios';
import { getWelcomeMessage } from './welcomeMessages.js';
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

/**
 * IMVU User Tracker Module - CDP WEBSOCKET MODE 🎯
 * High-precision tracking using Chrome DevTools Protocol.
 * Intercepts frames directly from the network layer.
 */

let globalMessageHandler = () => {};

export const attachToAllTargets = async (browser) => {
    const attachSession = async (target) => {
        try {
            const session = await target.createCDPSession();
            await session.send('Network.enable');

            session.on('Network.webSocketFrameReceived', ({ response }) => {
                try {
                    const data = JSON.parse(response.payloadData);
                    globalMessageHandler(data);
                } catch {}
            });

            session.on('Network.webSocketFrameSent', ({ response }) => {
                try {
                    const data = JSON.parse(response.payloadData);
                    globalMessageHandler(data);
                } catch {}
            });

        } catch (e) {}
    };

    // 1. Attach to existing targets (Service Workers, Main Page, etc)
    const targets = browser.targets();
    for (const target of targets) {
        attachSession(target);
    }

    // 2. Attach to future targets (Web Workers, Iframes, etc)
    browser.on('targetcreated', attachSession);
};

export async function startUserTracking(page, roomId, options = {}) {
    if (!page || page.isClosed()) return;

    console.log(`[TRACKER] 🎯 CDP WEBSOCKET MODE enabled for room: ${roomId}`);

    const lastUserMap = new Map(); // avatarId -> username
    const API_BASE_URL = process.env.APP_URL || 'http://localhost:8000';
    const syncBotName =
        (options.botName && String(options.botName).trim()) ||
        process.env.BOT_PROFILE ||
        process.env.BOT_NAME ||
        '';
    const syncBotUsername =
        (options.botUsername && String(options.botUsername).trim()) ||
        process.env.BOT_USERNAME ||
        '';
    const BOT_USERNAME = process.env.BOT_USERNAME || 'S1VA';
    const BOT_DISPLAY_NAME = (process.env.BOT_DISPLAY_NAME || BOT_USERNAME || '').trim();
    const processedJoins = new Set();
    /** Track active join sessions to prevent duplicate welcomes before leave */
    const activeJoinSessions = new Set();
    /** Cooldown timestamps to avoid rapid re‑welcome on same join */
    const welcomeTimestamps = new Map();
    const WELCOME_COOLDOWN_MS = 15000; // 15 s
    /** One backend /api/room-users join per avatar from join_queue resolve (even if chat welcome is deferred) */
    const joinQueueBackendAnnounced = new Set();
    const mentionReplyDedupe = new Set();
    const MENTION_REPLY_DEDUPE_CAP = 400;
    /** Avatar ids already in room at sync / bot join — no welcome DM */
    const skipWelcomeAvatarIds = new Set();

    /** Display title for welcome messages (from DOM after join). */
    let ROOM_NAME = 'this room';

    const fetchRoomTitleFromDom = async () => {
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
        if (!slug || !page || page.isClosed()) {
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
                    image_url: imageUrl || '',
                    visitors,
                    population,
                },
            ],
        };
        if (syncBotName) body.bot_name = syncBotName;
        if (syncBotUsername) body.bot_username = syncBotUsername;

        try {
            await axios.post(`${API_BASE_URL}/api/rooms/sync`, body);
            console.log(
                `[SYNC] room ${rid} · "${body.rooms[0].name}" · pop ${population} · ${visitors.length} visitors`
            );
        } catch (e) {
            console.log('[SYNC] dashboard failed:', e?.message || e);
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
    const sendMessage = createSendMessage({ page, logConversationTurn });

    // Listen to incoming messages from the dynamically generated Discord Room Channels
    if (global.discordBridge) {
        global.discordBridge.on('chat', async ({ targetRoomId, content }) => {
            if (!state.botJoinedChat) return;
            
            // We now map based on the absolute Room ID extracted from the Discord Channel Topic!
            if (targetRoomId === String(roomId)) {
                await sendMessage(content);
            }
        });
    }

    const onJoin = async (username) => {
        console.log(`[JOIN] ${username}`);

        try {
            await axios.post(`${API_BASE_URL}/api/room-users`, {
                username, room_id: roomId, event: 'join', timestamp: new Date().toISOString()
            });
        } catch (e) {}
    };

    const onLeave = async (username) => {
        console.log(`[LEAVE] ${username}`);

        // Skip bot itself
        if (username === BOT_USERNAME) return;

        try {
            await axios.post(`${API_BASE_URL}/api/room-users`, {
                username, room_id: roomId, event: 'leave', timestamp: new Date().toISOString()
            });
        } catch (e) {}
    };

    const state = {
        selfUserId: null,
        botJoinedChat: false,
        welcomeArrivalsEnabled: false,
        participantsRosterSynced: false,
        welcomeArrivalsEnableTimer: null,
    };

    const enableWelcomeForNewArrivals = () => {
        for (const aid of lastUserMap.keys()) {
            if (aid != null && aid !== undefined) {
                skipWelcomeAvatarIds.add(String(aid));
                // 🛡️ Also block backend onJoin for bootstrap users
                joinQueueBackendAnnounced.add(String(aid));
            }
        }
        // ✅ Mark roster as synced (covers fallback timer path)
        state.participantsRosterSynced = true;
        state.welcomeArrivalsEnabled = true;
        if (state.welcomeArrivalsEnableTimer) {
            clearTimeout(state.welcomeArrivalsEnableTimer);
            state.welcomeArrivalsEnableTimer = null;
        }
        console.log(`[SYNC] 🔓 Welcome gate OPEN — ${skipWelcomeAvatarIds.size} existing users blocked`);
    };

    const isSelfId = (id) =>
        id != null &&
        state.selfUserId != null &&
        String(id) === String(state.selfUserId);

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
     * @returns {boolean} true if a welcome was scheduled (caller may call onJoin once)
     */
    const scheduleWelcomeForAvatar = (avatarId, displayName, convMeta) => {
        if (
            !avatarId ||
            !state.botJoinedChat ||
            !state.welcomeArrivalsEnabled ||
            isSelfId(avatarId) ||
            skipWelcomeAvatarIds.has(avatarId)
        ) {
            return false;
        }
        const handleKey = welcomeHandleKey(displayName);
        if (!handleKey) return false;
        // 🚨 Allow rejoin if user is no longer in room
        if (!lastUserMap.has(avatarId)) {
            welcomeTimestamps.delete(avatarId);
        }

        // 🚨 HARD LOCK IMMEDIATELY
        if (activeJoinSessions.has(avatarId)) {
            return false;
        }
        activeJoinSessions.add(avatarId);

        // cooldown check AFTER lock
        const lastWelcome = welcomeTimestamps.get(avatarId);
        if (lastWelcome && (Date.now() - lastWelcome) < WELCOME_COOLDOWN_MS) {
            activeJoinSessions.delete(avatarId); // release lock
            return false;
        }

        welcomeTimestamps.set(avatarId, Date.now());
        if (activeJoinSessions.size > 200) {
            activeJoinSessions.clear();
        }
        if (welcomeTimestamps.size > 400) {
            welcomeTimestamps.clear();
        }
        setTimeout(async () => {
            try {
                if (ROOM_NAME === 'this room') {
                    await refreshRoomName();
                }

                await sendMessage(getWelcomeMessage(displayName, ROOM_NAME), convMeta);

            } finally {
                // 🔓 ALWAYS release lock after welcome
                activeJoinSessions.delete(avatarId);
            }
        }, 1500);
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

    const resolveImvuHandleFromNumericId = createImvuHandleResolver({ page });
    const handleIncomingMessage = createIncomingMessageHandler({
        API_BASE_URL,
        BOT_DISPLAY_NAME,
        BOT_USERNAME,
        discordChannelId: options.discordChannelId,
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
        roomId,
        scheduleWelcomeForAvatar,
        sendMessage,
        skipWelcomeAvatarIds,
        state,
        triggerCountUpdate,
        welcomeTimestamps,
    });

    if (process.env.DISCORD_BOT_API_URL) {
        // Wait until roomName is successfully scraped from IMVU before initializing Discord channel
        const checkRoomNameInterval = setInterval(async () => {
            const cleanName = (state.roomName || '').toLowerCase().replace(/[^a-z]/g, '');
            // Do not accept any variation of the generic loading page title
            if (state.roomName && !cleanName.includes('imvunext') && cleanName !== 'imvu' && state.roomName !== 'Unknown') {
                clearInterval(checkRoomNameInterval);
                axios.post(process.env.DISCORD_BOT_API_URL.replace('imvu-chat', 'imvu-init-room'), {
                    room_id: String(roomId),
                    room_name: state.roomName,
                    discord_channel_id: options.discordChannelId
                }).catch(()=>null);
            } else {
                // Manually trigger a refresh if it hasn't happened yet
                await refreshRoomName().catch(()=>null);
            }
        }, 1500);
    }

    setInterval(() => {
        if (state.botJoinedChat) {
            scheduleDashboardSync();
        }
    }, 45000);

    globalMessageHandler = (data) => {
        void handleIncomingMessage(data);
    };

    const runDOMFallback = createDomFallback({ page, lastUserMap, triggerCountUpdate });
    setTimeout(runDOMFallback, 5000);
}
