import axios from 'axios';
import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { backendApiBaseUrl } from './env-app-url.js';
import { parseProxyFromProcessEnv, proxyConfigured } from './proxy-env.js';
import { createProtocolSpec } from './imvu-protocol/spec.js';
import { createProxyAgents } from './imvu-protocol/proxy-agent.js';
import { createImvuSessionClient } from './imvu-protocol/session.js';
import { ImvuAccountWebSocketClient } from './imvu-protocol/account-ws-client.js';
import { ImvuRoomWebSocketClient } from './imvu-protocol/ws-client.js';
import { startProtocolUserTracking } from './user-tracker.js';
import { applySyncRoomSettings, patchRoomSettingsLocal, setGlobalLurkDefault } from './room-settings/store.js';
import {
    decodeChatEnvelope,
    decodeId,
    isEphemeralLegacyChatQueue,
    roomQueueBelongsToRoom,
} from './user-tracker-utils.js';
import { allRoomRuntimes, trackerRoomKey } from './room-runtime-registry.js';
import { processSyncActions, runBotSocialSync, isSocialSyncEnabled } from './sync-actions.js';
import { resolveBotImvuProfile } from './imvu-profile-sync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });
// Fallbacks for common local layouts: embedded Laravel parent, then sibling Laravel app.
dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', 'imvu-bot-laravel', '.env') });

if (!global.discordBridge) {
    global.discordBridge = new EventEmitter();
}
global.discordBridge.setMaxListeners(0);

const BACKEND_URL = backendApiBaseUrl('http://127.0.0.1:8000');
const BOT_NAME = process.env.BOT_NAME || process.env.BOT_PROFILE || 'S1VA';
const EXIT_PROXY_ROTATE = 2;
const MAX_ROOMS = Math.max(1, parseInt(process.env.IMVU_MAX_TABS || process.env.IMVU_MAX_ROOMS || '20', 10));

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function trackerRoomId(raw) {
    return trackerRoomKey(raw);
}

function parseRoomIds(roomString) {
    return String(roomString || '')
        .split(',')
        .map((entry) => trackerRoomId(entry.trim()))
        .filter(Boolean);
}

function applyMutedRooms(mutedRooms) {
    if (!Array.isArray(mutedRooms)) return;
    for (const raw of mutedRooms) {
        const roomId = trackerRoomId(raw);
        if (!roomId) continue;
        patchRoomSettingsLocal(roomId, { lurk_enabled: false });
    }
}

function applyBotAiEnabled(data) {
    if (data?.bot_ai_enabled == null) return;
    const on =
        data.bot_ai_enabled === true ||
        data.bot_ai_enabled === 1 ||
        String(data.bot_ai_enabled).trim().toLowerCase() === 'true' ||
        String(data.bot_ai_enabled).trim() === '1';
    setGlobalLurkDefault(on && !envDisabled('IMVU_LURK_ENABLED'));
}

function envTruthy(key) {
    const v = String(process.env[key] ?? '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function envDisabled(key) {
    const v = String(process.env[key] ?? '').trim().toLowerCase();
    return v === '0' || v === 'false' || v === 'no' || v === 'off';
}

function isDmJoinEnabled() {
    return envTruthy('IMVU_DM_JOIN_ENABLED');
}

function envInt(key, fallback) {
    const value = parseInt(process.env[key] || '', 10);
    return Number.isFinite(value) ? value : fallback;
}

function rememberRoomDiscordChannels(data, targetMap) {
    const channels = data?.room_discord_channels;
    if (!channels || typeof channels !== 'object' || Array.isArray(channels)) return;
    for (const [rawRoomId, rawChannelId] of Object.entries(channels)) {
        const roomId = trackerRoomId(rawRoomId);
        const channelId = String(rawChannelId || '').trim();
        if (roomId && channelId) targetMap.set(roomId, channelId);
    }
}

function frameShowsSelfRemovedFromRoom(action, roomId, selfUserId) {
    if (!action || typeof action !== 'object' || !selfUserId) return false;
    const self = String(selfUserId);
    const queue = String(action.queue || '');
    if (queue && !roomQueueBelongsToRoom(queue, roomId)) return false;

    if (action.record === 'msg_g2c_left_queue' || action.record === 'msg_g2c_user_exited') {
        const avatarId = decodeId(action.user_id || action.avatar_id);
        if (avatarId == null || String(avatarId) !== self) return false;
        // Legacy /chat/{id} subscription churn during visibility refresh is not a room leave.
        if (action.record === 'msg_g2c_left_queue' && isEphemeralLegacyChatQueue(queue)) {
            return false;
        }
        return true;
    }

    if (envDisabled('IMVU_SELF_REJOIN_ON_PARTICIPANT_DELETE')) return false;
    if (action.record !== 'msg_g2c_send_message') return false;
    if (!String(action.mount || '').toLowerCase().includes('participants')) return false;

    const envelope = decodeChatEnvelope(action.message);
    const deltaAction = String(envelope?.action || '').toLowerCase();
    if (deltaAction !== 'deleted' && deltaAction !== 'removed') return false;

    const objects = Array.isArray(envelope?.objects) ? envelope.objects : [];
    return objects.some((raw) => {
        const text = String(raw || '');
        return text.includes(`/participants/user-${self}`) && text.includes(`chat-${trackerRoomId(roomId)}`);
    });
}

function redactLoginName(name) {
    const value = String(name || '').trim();
    if (value.length <= 2) return value ? '**' : '(unknown)';
    return `${value.slice(0, 1)}***${value.slice(-1)}`;
}

/** Same relay contract as the browser runtime: discord-server POSTs here. */
function startDiscordRelayForBot(botLabel) {
    const portRaw = (process.env.IMVU_DISCORD_RELAY_PORT || '').trim();
    if (!portRaw) {
        console.log(`[${botLabel}] IMVU_DISCORD_RELAY_PORT unset; Discord to IMVU relay is off.`);
        return null;
    }
    const port = parseInt(portRaw, 10);
    if (!Number.isFinite(port) || port <= 0) return null;

    const app = express();
    app.use(express.json());
    app.post('/discord-relay', (req, res) => {
        try {
            const { targetRoomId, content } = req.body || {};
            if (targetRoomId != null && content != null && global.discordBridge) {
                global.discordBridge.emit('chat', {
                    targetRoomId: trackerRoomId(targetRoomId),
                    content: String(content),
                });
            }
            res.json({ ok: true });
        } catch {
            res.status(500).json({ ok: false });
        }
    });

    const server = app.listen(port, '127.0.0.1', () => {
        console.log(`[${botLabel}] Discord to IMVU relay on http://127.0.0.1:${port}/discord-relay`);
    });
    server.on('error', (error) => {
        console.error(`[${botLabel}] Discord relay :${port}: ${error.message}`);
    });
    return server;
}

async function fetchBotSettings(botName) {
    const response = await axios.get(`${BACKEND_URL}/api/bots/${encodeURIComponent(botName)}`);
    if (!response.data?.username) {
        throw new Error(`Bot not found or missing username: ${botName}`);
    }
    const fromApi = String(
        response.data.discord_guild_id ||
            response.data.discord_channel_id ||
            response.data.discord_channel ||
            ''
    ).trim();
    const fromEnv = String(
        process.env.DISCORD_GUILD_ID ||
            process.env.DISCORD_SHARED_GUILD_ID ||
            process.env.DISCORD_CHANNEL_ID ||
            ''
    ).trim();
    return {
        ...response.data,
        name: response.data.name || botName,
        username: response.data.username,
        password: response.data.password,
        profile: response.data.profile || response.data.name || botName,
        discordChannelId: fromApi || fromEnv || null,
    };
}

async function syncDashboardRooms({ roomClients, session, bot, botImvuUserId = null }) {
    const rooms = [];
    const runtimes = allRoomRuntimes();
    for (const [roomId, entry] of roomClients) {
        let details = entry.details;
        if (!details) {
            details = await session.fetchRoomDetails(roomId);
            entry.details = details;
        }
        const runtime = runtimes.get(roomId);
        const visitors = runtime?.getVisitors?.() || [];
        let moderators = entry.moderators;
        if (!moderators && session.fetchRoomModerators) {
            moderators = await session.fetchRoomModerators(roomId);
            entry.moderators = moderators;
        }
        rooms.push({
            id: roomId,
            name: details?.name || `Room ${roomId}`,
            description: details?.description || '',
            image_url: details?.image_url || '',
            visitors,
            moderators: moderators || [],
            population: visitors.length || details?.occupancy || 0,
            capacity: details?.capacity ?? null,
        });
    }

    const botProfile = await resolveBotImvuProfile(session, bot, botImvuUserId);

    const response = await axios.post(`${BACKEND_URL}/api/rooms/sync`, {
        rooms,
        bot_name: BOT_NAME,
        bot_username: bot.username,
        heartbeat_only: rooms.length === 0,
        ...(botProfile.userId && botProfile.profile
            ? {
                  bot_imvu_user_id: botProfile.userId,
                  bot_imvu_profile: botProfile.profile,
              }
            : {}),
    });
    return response.data || {};
}

async function main() {
    console.log(`[${BOT_NAME}] Pure WebSocket runtime starting; Chromium/Puppeteer is not used.`);

    const bot = await fetchBotSettings(BOT_NAME);
    const aiEnabledRaw = bot.ai_enabled;
    const aiGloballyOn =
        aiEnabledRaw == null ||
        aiEnabledRaw === true ||
        aiEnabledRaw === 1 ||
        String(aiEnabledRaw).trim().toLowerCase() === 'true' ||
        String(aiEnabledRaw).trim() === '1';
    setGlobalLurkDefault(aiGloballyOn && !envDisabled('IMVU_LURK_ENABLED'));
    const parsedProxy = parseProxyFromProcessEnv({ fallbackRaw: bot.proxy });
    const agents = createProxyAgents(parsedProxy);
    const session = createImvuSessionClient({ bot, agents });

    console.log(
        `[${BOT_NAME}] account=${bot.username} proxy=${agents.redacted}` +
            (proxyConfigured(parsedProxy) ? ' mode=node-proxy-agent' : '')
    );

    await session.ensureLoggedIn();

    if (envTruthy('IMVU_LOGIN_ONLY')) {
        const cookieNames = (await session.jar.getCookies(process.env.IMVU_WEB_ORIGIN || 'https://www.imvu.com'))
            .map((cookie) => cookie.key)
            .join(', ');
        console.log(
            `[${BOT_NAME}] Login-only check completed for ${redactLoginName(bot.username)}. ` +
                `Cookie names: ${cookieNames || '(none)'}`
        );
        return;
    }

    const imqIdentity = await session.resolveImqIdentity();
    bot.imqUserId = imqIdentity.userId;
    bot.imqConnectCookie = imqIdentity.connectCookie;
    if (!bot.imqUserId || !bot.imqConnectCookie) {
        throw new Error(
            'Could not derive IMVU IMQ identity dynamically from login. ' +
                'Need numeric user id in login/API payload and osCsid cookie for connect cookie.'
        );
    }

    const spec = createProtocolSpec(bot);
    const missing = spec.describeMissing();
    if (missing.length) {
        throw new Error(
            `Pure WebSocket mode needs protocol templates before it can connect: ${missing.join(', ')}. ` +
                'Set IMVU_WS_FRAME_SPEC_JSON or the IMVU_WS_* env vars from your authorized capture.'
        );
    }

    if (!spec.hasConnectFrames || !spec.hasJoinFrames) {
        console.warn(
            `[${BOT_NAME}] IMVU WebSocket URL is set, but connect/join frame templates are incomplete ` +
                `(connect=${spec.hasConnectFrames ? 'yes' : 'no'}, join=${spec.hasJoinFrames ? 'yes' : 'no'}). ` +
                `The bot can open the socket, but it will not fully join a room until IMVU_WS_CONNECT_FRAMES_JSON and IMVU_WS_JOIN_FRAMES_JSON are filled from your capture.`
        );
    }

    startDiscordRelayForBot(BOT_NAME);

    let configuredRoomIds = [...new Set(parseRoomIds(bot.room_ids))];

    try {
        const resume = await axios.post(
            `${BACKEND_URL}/api/bots/${encodeURIComponent(BOT_NAME)}/resume-rooms`
        );
        const resumed = Array.isArray(resume.data?.target_rooms) ? resume.data.target_rooms : [];
        if (resumed.length) {
            console.log(
                `[${BOT_NAME}] Dashboard has ${resumed.length} room(s) to join: ${resumed.join(', ')}`
            );
        }
        configuredRoomIds = [
            ...new Set([...configuredRoomIds, ...resumed.map((roomId) => trackerRoomId(roomId))]),
        ];
    } catch (error) {
        console.warn(`[${BOT_NAME}] resume-rooms failed: ${error?.message || error}`);
    }

    const roomClients = new Map();
    const roomDiscordChannelIds = new Map();
    /** Rooms paused on dashboard — do not auto-rejoin from sync until unpaused. */
    const locallyPausedRooms = new Set();
    let activeSpamRooms = [];
    const accountLevelWsEnabled = !envDisabled('IMVU_ACCOUNT_LEVEL_WS');
    const accountWs = accountLevelWsEnabled
        ? new ImvuAccountWebSocketClient({
              spec,
              session,
              agents,
              bot,
              logger: console,
          })
        : null;
    if (accountWs) {
        accountWs.on('error', (error) => {
            console.warn(
                `[${BOT_NAME}] account websocket error (reconnecting): ${error?.message || error}`,
            );
        });
    }

    process.on('unhandledRejection', (reason) => {
        const msg = reason instanceof Error ? reason.message : String(reason);
        console.error(`[${BOT_NAME}] unhandledRejection (bot stays up): ${msg}`);
    });
    const selfRejoinEnabled = !envDisabled('IMVU_SELF_REJOIN');
    const selfRejoinDelayMs = Math.max(1000, envInt('IMVU_SELF_REJOIN_DELAY_MS', 5000));
    const selfRejoinMaxPerRoom = Math.max(0, envInt('IMVU_SELF_REJOIN_MAX_PER_ROOM', 1));
    const selfRejoinWindowMs = Math.max(10000, envInt('IMVU_SELF_REJOIN_WINDOW_MS', 10 * 60 * 1000));
    const selfRejoinCooldownMs = Math.max(10000, envInt('IMVU_SELF_REJOIN_COOLDOWN_MS', 15 * 60 * 1000));

    let triggerSocialSync = () => {};

    const stopRoom = async (roomId) => {
        const id = trackerRoomId(roomId);
        const entry = roomClients.get(id);
        if (!entry || entry.leaving) return;
        entry.leaving = true;
        locallyPausedRooms.add(id);
        console.warn(`[BOT-ROOM-LEAVE][${id}] ${BOT_NAME}: intentional leave (dashboard/stopRoom)`);
        if (entry.selfRejoinTimer) clearTimeout(entry.selfRejoinTimer);
        entry.selfRejoinTimer = null;
        // Prevent self-rejoin / force-refresh from undoing an intentional leave.
        entry.visibleRejoinPausedUntil = Date.now() + 365 * 24 * 60 * 60 * 1000;
        entry.client.closedByUser = true;
        entry.client.close();

        const botUserId = bot.imqUserId != null ? String(bot.imqUserId) : '';
        if (/^\d+$/.test(botUserId) && typeof session.removeChatParticipant === 'function') {
            const removed = await session.removeChatParticipant(id, botUserId);
            if (!removed?.ok) {
                console.warn(`[${BOT_NAME}] REST leave failed for ${id}; trying websocket leave only`);
            }
        }
        try {
            await entry.client.leave();
        } catch {}
        roomClients.delete(id);
        if (typeof session.watchRoomDmContacts === 'function' && isDmJoinEnabled()) {
            await session.watchRoomDmContacts(id).catch(() => {});
        }
        triggerSocialSync();
    };

    /** Close websocket only — keep IMVU participant so the avatar stays in-room after dev restart. */
    const disconnectRoom = (roomId) => {
        const id = trackerRoomId(roomId);
        const entry = roomClients.get(id);
        if (!entry || entry.leaving) return;
        entry.leaving = true;
        entry.client.closedByUser = true;
        try {
            entry.client.close();
        } catch {
            /* optional */
        }
        roomClients.delete(id);
        console.warn(
            `[BOT-ROOM-LEAVE][${id}] ${BOT_NAME}: websocket closed only — avatar may still show in IMVU room`
        );
    };

    const startRoom = async (roomId, { force = false } = {}) => {
        const id = trackerRoomId(roomId);
        if (!id || roomClients.has(id)) return roomClients.get(id) || null;
        if (!force && locallyPausedRooms.has(id)) {
            console.log(
                `[${BOT_NAME}] Skipping join to ${id} (paused on dashboard).`
            );
            return null;
        }
        if (force) locallyPausedRooms.delete(id);
        if (roomClients.size >= MAX_ROOMS) {
            console.warn(`[${BOT_NAME}] Max room count ${MAX_ROOMS} reached; skipping ${id}.`);
            return null;
        }

        const details = await session.fetchRoomDetails(id);
        if (typeof session.watchRoomDmContacts === 'function' && isDmJoinEnabled()) {
            await session.watchRoomDmContacts(id).catch(() => {});
        }
        const client = accountWs
            ? accountWs.createRoomClient(id)
            : new ImvuRoomWebSocketClient({
                  roomId: id,
                  spec,
                  session,
                  agents,
                  bot,
                  logger: console,
              });

        client.on('error', (error) => {
            console.warn(`[${BOT_NAME}][${id}] websocket error: ${error?.message || error}`);
        });
        client.on('fatal', (error) => {
            console.error(`[${BOT_NAME}][${id}] websocket fatal: ${error?.message || error}`);
            process.exitCode = EXIT_PROXY_ROTATE;
        });
        client.on('sent', ({ text }) => {
            const preview = String(text || '').slice(0, 120);
            console.log(`[${BOT_NAME}][${id}] sent: ${preview}`);
        });

        console.log(`[${BOT_NAME}] Connecting room ${id}${details?.name ? ` (${details.name})` : ''}`);
        await client.connect();
        let entry = null;
        client.on('frame', (action) => {
            if (!selfRejoinEnabled || !frameShowsSelfRemovedFromRoom(action, id, bot.imqUserId)) return;
            if (!entry) return;
            const now = Date.now();
            if (entry.visibleRejoinPausedUntil && now < entry.visibleRejoinPausedUntil) return;

            entry.selfRemovalEvents = entry.selfRemovalEvents.filter((timestamp) => {
                return now - timestamp < selfRejoinWindowMs;
            });
            entry.selfRemovalEvents.push(now);
            if (entry.selfRemovalEvents.length > selfRejoinMaxPerRoom) {
                entry.visibleRejoinPausedUntil = now + selfRejoinCooldownMs;
                if (entry.selfRejoinTimer) {
                    clearTimeout(entry.selfRejoinTimer);
                    entry.selfRejoinTimer = null;
                }
                console.warn(
                    `[${BOT_NAME}][${id}] Visible avatar is flapping; keeping monitoring in background for ` +
                        `${Math.round(selfRejoinCooldownMs / 60000)}m before another visible repair.`
                );
                return;
            }
            if (entry?.selfRejoinTimer) return;
            console.warn(
                `[${BOT_NAME}][${id}] IMVU reported this bot left the room; rejoining in ${selfRejoinDelayMs}ms.`
            );
            entry.selfRejoinTimer = setTimeout(() => {
                entry.selfRejoinTimer = null;
                if (roomClients.get(id) !== entry) return;
                if (entry.visibleRejoinPausedUntil && Date.now() < entry.visibleRejoinPausedUntil) return;
                if (typeof client.resetPresenceForRejoin === 'function') {
                    client.resetPresenceForRejoin();
                }
                void client.ensureVisible('self-removed').catch((error) => {
                    console.warn(`[${BOT_NAME}][${id}] self rejoin failed: ${error.message}`);
                });
            }, selfRejoinDelayMs);
        });
        await startProtocolUserTracking(client, id, {
            botName: BOT_NAME,
            botUsername: bot.username,
            discordGuildId: bot.discordChannelId,
            discordRoomChannelId: roomDiscordChannelIds.get(id) || null,
            sessionClient: session,
            roomName: details?.name || '',
        });

        entry = {
            client,
            details,
            startedAt: Date.now(),
            selfRejoinTimer: null,
            selfRemovalEvents: [],
            visibleRejoinPausedUntil: 0,
        };
        roomClients.set(id, entry);
        return entry;
    };

    const initial = await syncDashboardRooms({
        roomClients,
        session,
        bot,
        botImvuUserId: bot.imqUserId,
    }).catch((error) => {
        console.warn(`[${BOT_NAME}] Initial dashboard sync failed: ${error.message}`);
        return {};
    });
    applySyncRoomSettings(initial.room_settings);
    applyMutedRooms(initial.muted_rooms);
    applyBotAiEnabled(initial);
    rememberRoomDiscordChannels(initial, roomDiscordChannelIds);
    if (Array.isArray(initial.paused_room_ids)) {
        for (const raw of initial.paused_room_ids) {
            const pausedId = trackerRoomId(raw);
            if (pausedId) locallyPausedRooms.add(pausedId);
        }
    }
    configuredRoomIds = [
        ...new Set([
            ...configuredRoomIds,
            ...(Array.isArray(initial.configured_room_ids)
                ? initial.configured_room_ids.map((roomId) => trackerRoomId(roomId))
                : []),
            ...(Array.isArray(initial.paused_room_ids)
                ? initial.paused_room_ids.map((roomId) => trackerRoomId(roomId))
                : []),
        ]),
    ];
    const initialTargets = Array.isArray(initial.target_rooms) ? initial.target_rooms : [];
    const defaultRoom = String(process.env.IMVU_DEFAULT_ROOM || '').trim();
    const firstRooms = initialTargets.length
        ? initialTargets
        : defaultRoom
          ? [defaultRoom]
          : [];

    if (!firstRooms.length) {
        console.log(
            `[${BOT_NAME}] No active rooms to join — idle mode (add or unpause rooms on the dashboard).`
        );
    }

    for (const roomId of firstRooms) {
        await startRoom(roomId).catch((error) => {
            console.error(`[${BOT_NAME}] Failed to start room ${trackerRoomId(roomId)}: ${error.message}`);
        });
    }

    const syncBaseMs = Math.max(5000, envInt('IMVU_SYNC_INTERVAL_MS', 25000));
    const syncJitterMs = Math.max(0, envInt('IMVU_SYNC_JITTER_MS', 10000));
    const syncIntervalMs = syncBaseMs + Math.floor(Math.random() * syncJitterMs);
    const socialPollMs = Math.max(3000, envInt('IMVU_SOCIAL_SYNC_INTERVAL_MS', envInt('IMVU_DM_POLL_INTERVAL_MS', 4000)));

    const startRoomForced = (roomId) => startRoom(roomId, { force: true });

    const socialSyncCtx = {
        session,
        stopRoom,
        startRoom: startRoomForced,
        botName: BOT_NAME,
        logger: console,
        get configuredRoomIds() {
            return configuredRoomIds;
        },
        getPausedRoomIds() {
            return [...locallyPausedRooms];
        },
        isRoomConnected(roomId) {
            return roomClients.has(trackerRoomId(roomId));
        },
    };

    triggerSocialSync = () => {
        if (!isSocialSyncEnabled()) return;
        void runBotSocialSync(socialSyncCtx);
    };

    if (isSocialSyncEnabled()) {
        void runBotSocialSync(socialSyncCtx);

        setInterval(() => {
            void runBotSocialSync(socialSyncCtx);
        }, socialPollMs);
    } else {
        console.log(
            `[${BOT_NAME}] IMVU social sync off (invites/DM/friend polling disabled). Set IMVU_SOCIAL_SYNC_ENABLED=1 to enable.`
        );
    }

    setInterval(() => {
        void (async () => {
            let data = {};
            try {
                data = await syncDashboardRooms({
                    roomClients,
                    session,
                    bot,
                    botImvuUserId: bot.imqUserId,
                });
            } catch (error) {
                console.warn(`[${BOT_NAME}] Dashboard sync failed: ${error.message}`);
                return;
            }
            applySyncRoomSettings(data.room_settings);
            applyMutedRooms(data.muted_rooms);
            applyBotAiEnabled(data);
            rememberRoomDiscordChannels(data, roomDiscordChannelIds);

            activeSpamRooms = Array.isArray(data.spam_targets) ? data.spam_targets.map(trackerRoomId) : [];

            if (Array.isArray(data.paused_room_ids)) {
                for (const raw of data.paused_room_ids) {
                    const pausedId = trackerRoomId(raw);
                    if (pausedId) locallyPausedRooms.add(pausedId);
                }
            }
            if (Array.isArray(data.pending_leave_rooms)) {
                for (const raw of data.pending_leave_rooms) {
                    const pendingLeaveId = trackerRoomId(raw);
                    if (pendingLeaveId) locallyPausedRooms.add(pendingLeaveId);
                }
            }

            const targets = new Set((Array.isArray(data.target_rooms) ? data.target_rooms : []).map(trackerRoomId));
            configuredRoomIds = [
                ...new Set([
                    ...configuredRoomIds,
                    ...(Array.isArray(data.configured_room_ids)
                        ? data.configured_room_ids.map((roomId) => trackerRoomId(roomId))
                        : []),
                    ...(Array.isArray(data.paused_room_ids)
                        ? data.paused_room_ids.map((roomId) => trackerRoomId(roomId))
                        : []),
                    ...[...targets],
                ]),
            ];

            if (typeof session.watchRoomDmContacts === 'function' && isDmJoinEnabled()) {
                const watchRoomIds = new Set([
                    ...configuredRoomIds,
                    ...(Array.isArray(data.paused_room_ids)
                        ? data.paused_room_ids.map((roomId) => trackerRoomId(roomId))
                        : []),
                ]);
                for (const target of watchRoomIds) {
                    if (!target) continue;
                    await session.watchRoomDmContacts(target).catch(() => {});
                }
            }

            await processSyncActions(data, {
                roomClients,
                session,
                stopRoom,
                startRoom: startRoomForced,
                botName: BOT_NAME,
                logger: console,
            });

            for (const target of targets) {
                if (!target || roomClients.has(target) || locallyPausedRooms.has(target)) continue;
                await startRoom(target).catch((error) => {
                    console.error(`[${BOT_NAME}] Failed to start room ${target}: ${error.message}`);
                });
            }
        })();
    }, syncIntervalMs);

    const spamLibrary = [
        'Hey everyone!',
        'This room is pretty cool.',
        "How's everyone doing today?",
        'Yo, what is up?',
        'Nice vibes here.',
    ];

    setInterval(() => {
        if (!activeSpamRooms.length || !envTruthy('IMVU_ENABLE_PERIODIC_ENGAGEMENT')) return;
        void (async () => {
            for (const roomId of activeSpamRooms) {
                const entry = roomClients.get(trackerRoomId(roomId));
                if (!entry) continue;
                const text = spamLibrary[Math.floor(Math.random() * spamLibrary.length)];
                await delay(3000 + Math.random() * 7000);
                await entry.client.sendMessage(text);
            }
        })();
    }, 45000 + Math.random() * 50000);

    let shuttingDown = false;

    const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        const leaveRooms = envTruthy('IMVU_LEAVE_ROOMS_ON_SHUTDOWN');
        console.log(
            `[${BOT_NAME}] Shutting down ${roomClients.size} room client(s)` +
                (leaveRooms
                    ? ' — leaving IMVU rooms (IMVU_LEAVE_ROOMS_ON_SHUTDOWN=1).'
                    : ' — keeping avatar in room (websocket only). Set IMVU_LEAVE_ROOMS_ON_SHUTDOWN=1 to leave on exit.')
        );
        for (const roomId of [...roomClients.keys()]) {
            if (leaveRooms) {
                await stopRoom(roomId);
            } else {
                disconnectRoom(roomId);
            }
        }
        if (accountWs) {
            try {
                accountWs.close();
            } catch {
                /* optional */
            }
        }
        process.exit(0);
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
}

main().catch((error) => {
    console.error(`[${BOT_NAME}] Critical error: ${error.message}`);
    process.exitCode = 1;
});
