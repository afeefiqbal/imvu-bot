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
import { backendApiBaseUrl } from './env-app-url.js';

const getDefaultWelcomeMessage = (name, roomName = 'the room') =>
    `Hey ${name || 'there'} 👋 welcome to ${roomName}!`;

/**
 * IMVU User Tracker Module - CDP WEBSOCKET MODE 🎯
 * High-precision tracking using Chrome DevTools Protocol.
 * Intercepts frames directly from the network layer.
 */

export const attachToPageCDP = async (page, onMessage) => {
    try {
        const session = await page.target().createCDPSession();
        await session.send('Network.enable');

        session.on('Network.webSocketFrameReceived', ({ response }) => {
            try {
                const data = JSON.parse(response.payloadData);
                onMessage(data);
            } catch {}
        });

        session.on('Network.webSocketFrameSent', ({ response }) => {
            try {
                const data = JSON.parse(response.payloadData);
                onMessage(data);
            } catch {}
        });

    } catch (e) {
        console.error(`[TRACKER] CDP attach failed:`, e.message);
    }
};

export async function startUserTracking(page, roomId, options = {}) {
    if (!page || page.isClosed()) return;

    console.log(`[TRACKER] 🎯 CDP WEBSOCKET MODE enabled for room: ${roomId}`);

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
    /** Cooldown timestamps to avoid rapid re‑welcome on same join */
    const welcomeTimestamps = new Map();
    const WELCOME_COOLDOWN_MS = 15000; // 15 s per avatar (rapid duplicate join_queue)
    const WELCOME_HANDLE_COOLDOWN_MS = parseInt(process.env.IMVU_WELCOME_REJOIN_MS || '600000', 10); // default 10 min per username
    const welcomeByHandleLastAt = new Map();
    /** One backend /api/room-users join per avatar from join_queue resolve (even if chat welcome is deferred) */
    const joinQueueBackendAnnounced = new Set();
    const mentionReplyDedupe = new Set();
    const MENTION_REPLY_DEDUPE_CAP = 400;
    /** Avatar ids already in room at sync / bot join — no welcome DM */
    const skipWelcomeAvatarIds = new Set();
    /** Avoid opening the welcome gate while IMVU has not reported anyone yet (empty roster → false "new" joins). */
    let welcomeGateEmptyRetries = 0;
    const MAX_WELCOME_GATE_EMPTY_RETRIES = 6;
    const WELCOME_GATE_EMPTY_RETRY_MS = 2500;

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
    const sendMessage = createSendMessage({ page, logConversationTurn });

    const state = {
        selfUserId: null,
        botJoinedChat: false,
        welcomeArrivalsEnabled: false,
        participantsRosterSynced: false,
        welcomeArrivalsEnableTimer: null,
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
        if (username === BOT_USERNAME) return;

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

        // Everyone already in lastUserMap when the gate opens was present during bootstrap
        // (join_queue or roster). Skip welcome for all of them, including rows still `null`
        // until IMVU profile resolves — otherwise late name resolution looks like a "new" join.
        for (const aid of lastUserMap.keys()) {
            if (aid == null || aid === undefined) continue;
            const sid = String(aid);
            skipWelcomeAvatarIds.add(sid);
            const label = lastUserMap.get(aid);
            if (hasResolvedOccupantName(label)) {
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
            return true;
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

        if (WELCOME_HANDLE_COOLDOWN_MS > 0) {
            const lastByHandle = welcomeByHandleLastAt.get(handleKey);
            if (
                lastByHandle != null &&
                Date.now() - lastByHandle < WELCOME_HANDLE_COOLDOWN_MS
            ) {
                activeJoinSessions.delete(avatarId);
                // Same handle flapping in-room without a leave — suppress. Real leaves clear this map.
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
        setTimeout(async () => {
            try {
                if (ROOM_NAME === 'this room') {
                    await refreshRoomName();
                }

                await sendMessage(getDefaultWelcomeMessage(displayName, ROOM_NAME), convMeta);

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
    let roomChatCommandHandler = null;
    if (
        process.env.IMVU_MUSIC_ENABLED === '1' ||
        process.env.IMVU_MUSIC_ENABLED === 'true'
    ) {
        try {
            const { createMusicRoomChatCommandHandler } = await import('./music/index.js');
            roomChatCommandHandler = await createMusicRoomChatCommandHandler({
                page,
                roomId,
                apiBaseUrl: API_BASE_URL,
                botName: syncBotName || undefined,
                sendMessage,
            });
            console.log(`${syncLogPrefix} room music commands on (play … / !play / *play / !music · *music)`);
        } catch (e) {
            console.warn(`${syncLogPrefix} music init failed:`, e?.message || e);
        }
    }

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
        roomChatCommandHandler,
        roomId,
        scheduleWelcomeForAvatar,
        sendMessage,
        skipWelcomeAvatarIds,
        state,
        triggerCountUpdate,
        welcomeByHandleLastAt,
        welcomeTimestamps,
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
                    discord_channel_id: options.discordChannelId
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
    }, 60000);

    // CRITICAL FIX: Ensure intervals are cleared and page references dropped when page closes!
    page.on('close', () => {
        if (onDiscordRelayChat && global.discordBridge) {
            global.discordBridge.off('chat', onDiscordRelayChat);
        }
        if (checkRoomNameInterval) clearInterval(checkRoomNameInterval);
        clearInterval(syncIntervalId);
        clearInterval(cleanupIntervalId);
        if (dashboardSyncTimer) clearTimeout(dashboardSyncTimer);
        if (countTimer) clearTimeout(countTimer);
        if (state.welcomeArrivalsEnableTimer) clearTimeout(state.welcomeArrivalsEnableTimer);
    });

    await attachToPageCDP(page, (data) => {
        void handleIncomingMessage(data);
    });

    const runDOMFallback = createDomFallback({ page, lastUserMap, triggerCountUpdate });
    setTimeout(runDOMFallback, 5000);
}
