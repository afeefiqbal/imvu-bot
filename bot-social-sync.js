import { backendApiBaseUrl } from './env-app-url.js';
import { postBotRoomJoin } from './room-commands/api.js';

const BACKEND_URL = backendApiBaseUrl('http://127.0.0.1:8000');
const processedDmMessageIds = new Set();
const processedInviteActivityKeys = new Set();
const processedFriendAcceptIds = new Set();
const JOIN_COMMAND = /^!join(?:\s+(?:room-)?["']?([\d-]+)["']?)?/i;
let lastDmWatchRefreshAt = 0;
const DM_WATCH_REFRESH_MS = 60_000;
/** senderUserId:roomId → last invite attempt ms */
const recentDmRoomInvites = new Map();
let dmJoinFullPassInFlight = null;
let dmJoinFastPassInFlight = null;
let dmHintDebounceTimer = null;
let dmHintPendingCtx = null;
/** user ids from recent web_msg messageReceived hints */
const dmHintPendingSenderIds = new Set();
let dmHintRetryTimer = null;

function rememberFriendAccept(userId) {
    const id = String(userId || '').trim();
    if (!/^\d+$/.test(id)) return false;
    if (processedFriendAcceptIds.has(id)) return false;
    processedFriendAcceptIds.add(id);
    if (processedFriendAcceptIds.size > 500) processedFriendAcceptIds.clear();
    return true;
}

function isDmJoinEnabled() {
    const raw = String(process.env.IMVU_DM_JOIN_ENABLED || '0').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes';
}

export function isSocialSyncEnabled() {
    const raw = String(process.env.IMVU_SOCIAL_SYNC_ENABLED || '0').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes';
}

/** Realtime IMQ social queues; defaults on whenever social sync is on. Set IMVU_SOCIAL_WS_ENABLED=0 to force poll-only. */
export function isSocialWsEnabled() {
    const raw = String(process.env.IMVU_SOCIAL_WS_ENABLED || '').trim().toLowerCase();
    if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
    if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
    return isSocialSyncEnabled();
}

/**
 * Poll IMVU social surfaces for room rejoin signals (invite-first; DM optional).
 */
export async function runBotSocialSync(ctx) {
    if (!isSocialSyncEnabled()) return;
    await acceptInboundFriendRequests(ctx);
    await processChatRoomInvites(ctx);
    if (isDmJoinEnabled()) {
        await processDirectMessageJoinCommands(ctx);
    }
}

function extractMessageText(lastMessage) {
    const payloads = lastMessage?.payloads;
    if (!Array.isArray(payloads)) return '';
    return payloads
        .map((entry) => (entry?.type === 'text' ? String(entry.content || '') : ''))
        .filter(Boolean)
        .join(' ')
        .trim();
}

function extractSenderUserId(lastMessage) {
    const sentBy = String(lastMessage?.sent_by || lastMessage?.sender || '');
    const match = sentBy.match(/user-(\d+)/i);
    return match ? match[1] : null;
}

function extractParticipantUserIds(conversationData, botUserId) {
    const participants = conversationData?.participants;
    if (!Array.isArray(participants)) return [];

    return participants
        .map((entry) => {
            const user = String(entry?.user || '');
            const match = user.match(/user-(\d+)/i);
            return match ? match[1] : null;
        })
        .filter((id) => id && id !== String(botUserId));
}

function parseJoinRoomId(text) {
    const raw = String(text || '').trim();
    const match = raw.match(JOIN_COMMAND);
    if (!match) return null;
    const roomId = String(match[1] || '')
        .trim()
        .replace(/^room-/i, '')
        .replace(/["']/g, '');
    return /^\d+(?:-\d+)*$/.test(roomId) ? roomId : null;
}

function watchedDmUserIdsLabel(session) {
    if (typeof session?.getWatchedDirectMessageUserIds !== 'function') {
        return 'watched users unknown';
    }
    const ids = session.getWatchedDirectMessageUserIds();
    return ids.length ? `${ids.length} watched user(s)` : 'no watched users yet';
}

async function resolveDmSender(session, senderUserId, senderUsername) {
    let senderId = String(senderUserId || '').trim();
    if (/^\d+$/.test(senderId)) return { senderId, senderUsername };

    const label = String(senderUsername || '').trim();
    if (label && typeof session?.resolveUserIdFromUsername === 'function') {
        const resolved = await session.resolveUserIdFromUsername(label);
        if (resolved && /^\d+$/.test(String(resolved))) {
            return { senderId: String(resolved), senderUsername: label };
        }
    }

    return { senderId: /^\d+$/.test(senderId) ? senderId : '', senderUsername: label };
}

async function acceptFriendFromUserId(ctx, userId, { source = 'rest' } = {}) {
    const session = ctx.session;
    const logger = ctx.logger || console;
    const logPrefix = `[${ctx.botName || 'BOT'}][FRIEND]`;
    const id = String(userId || '').trim();
    if (!/^\d+$/.test(id)) return false;
    if (typeof session?.acceptFriendRequest !== 'function') return false;
    if (!rememberFriendAccept(id)) return false;

    const result = await session.acceptFriendRequest(id);
    if (result?.ok) {
        if (isDmJoinEnabled() && typeof session.watchDirectMessageUser === 'function') {
            session.watchDirectMessageUser(id);
        }
        logger.log(`${logPrefix} accepted friend request from user-${id} (${source})`);
        return true;
    }

    // Permanent IMVU reject — don't retry-spam this id every poll.
    const err = String(result?.error || '');
    const reason = String(result?.reason || '');
    const permanent =
        err.includes('INBOUND_FRIENDS_REQUEST') ||
        err.includes('INBOUND VALIDATION') ||
        /Invalid status update/i.test(reason) ||
        /does not match one of the enumerated values/i.test(reason);
    if (!permanent) {
        processedFriendAcceptIds.delete(id);
    }
    logger.warn(
        `${logPrefix} accept failed for user-${id} (${source}): ${result?.reason || 'unknown'}`
    );
    return false;
}

/**
 * Fast path: accept from IMQ edge frames without waiting for REST list+debounce.
 * inbound created → accept; friends created → already friends (watch DM); inbound deleted → done.
 */
export async function handleSocialWsFriendHint(ctx, hint) {
    if (!isSocialSyncEnabled()) return;
    const logger = ctx.logger || console;
    const logPrefix = `[${ctx.botName || 'BOT'}][FRIEND]`;
    const mount = String(hint?.mount || '');
    const action = String(hint?.action || '').toLowerCase();
    const userIds = Array.isArray(hint?.userIds) ? hint.userIds : [];
    const session = ctx.session;

    if (mount === 'edge:friends' && action === 'created') {
        for (const userId of userIds) {
            if (isDmJoinEnabled() && typeof session?.watchDirectMessageUser === 'function') {
                session.watchDirectMessageUser(userId);
            }
            logger.log(`${logPrefix} friendship created with user-${userId} (ws)`);
        }
        return;
    }

    if (mount === 'edge:inbound_friend_requests' && action === 'deleted') {
        for (const userId of userIds) {
            rememberFriendAccept(userId);
            if (isDmJoinEnabled() && typeof session?.watchDirectMessageUser === 'function') {
                session.watchDirectMessageUser(userId);
            }
        }
        return;
    }

    // New inbound request: edge created, or web_msg fanRequests with user ids.
    const isInboundCreated =
        mount === 'edge:inbound_friend_requests' && (!action || action === 'created');
    const isFanRequestMsg = mount === 'web_msg';

    if (!isInboundCreated && !isFanRequestMsg) return;

    if (!userIds.length) {
        await acceptInboundFriendRequests(ctx);
        return;
    }

    for (const userId of userIds) {
        await acceptFriendFromUserId(ctx, userId, { source: 'ws' });
    }
}

/**
 * Accept pending friend requests so owners/mods can invite or DM the bot.
 */
export async function acceptInboundFriendRequests(ctx) {
    const session = ctx.session;
    const logger = ctx.logger || console;
    const logPrefix = `[${ctx.botName || 'BOT'}][FRIEND]`;

    if (typeof session?.listInboundFriendRequests !== 'function') return;
    if (typeof session?.acceptFriendRequest !== 'function') return;

    try {
        const pending = await session.listInboundFriendRequests();
        for (const userId of pending) {
            await acceptFriendFromUserId(ctx, userId, { source: 'rest' });
        }
    } catch (error) {
        logger.warn(`${logPrefix} friend accept pass failed: ${error?.message || error}`);
    }
}

function dmInviteCooldownMs() {
    const n = parseInt(String(process.env.IMVU_DM_JOIN_COOLDOWN_MS || '90000'), 10);
    return Number.isFinite(n) && n >= 0 ? n : 90_000;
}

function rememberProcessedDmMessage(messageId) {
    const id = String(messageId || '').trim();
    if (!id) return false;
    if (processedDmMessageIds.has(id)) return false;
    processedDmMessageIds.add(id);
    if (processedDmMessageIds.size > 500) {
        const first = processedDmMessageIds.values().next().value;
        processedDmMessageIds.delete(first);
    }
    return true;
}

function claimDmRoomInvite(senderUserId, roomId) {
    const key = `${senderUserId}:${roomId}`;
    const now = Date.now();
    const last = recentDmRoomInvites.get(key) || 0;
    const cooldown = dmInviteCooldownMs();
    if (cooldown > 0 && now - last < cooldown) return false;
    recentDmRoomInvites.set(key, now);
    if (recentDmRoomInvites.size > 500) {
        const first = recentDmRoomInvites.keys().next().value;
        recentDmRoomInvites.delete(first);
    }
    return true;
}

/**
 * Handle `!join [room-id]` via IMVU DM: invite the sender into a room the bot is already in.
 * Does not make the bot join a new room.
 * @param {object} ctx
 * @param {{ preferUserIds?: string[], preferOnly?: boolean }} [options]
 */
export async function processDirectMessageJoinCommands(ctx, options = {}) {
    for (const raw of Array.isArray(options.preferUserIds) ? options.preferUserIds : []) {
        const id = String(raw || '').trim();
        if (/^\d+$/.test(id)) dmHintPendingSenderIds.add(id);
    }
    if (ctx) dmHintPendingCtx = ctx;

    const preferOnly = options.preferOnly === true;

    // Fast path (WS sender): never block behind the slow full inbox scan.
    if (preferOnly) {
        if (dmJoinFastPassInFlight) return dmJoinFastPassInFlight;

        const preferUserIds = [...dmHintPendingSenderIds];
        dmHintPendingSenderIds.clear();
        if (!preferUserIds.length) return { joinCommands: 0 };

        dmJoinFastPassInFlight = processDirectMessageJoinCommandsInner(ctx, {
            preferUserIds,
            preferOnly: true,
        }).finally(() => {
            dmJoinFastPassInFlight = null;
            if (dmHintPendingSenderIds.size > 0 && dmHintPendingCtx) {
                const pendingCtx = dmHintPendingCtx;
                const pendingIds = [...dmHintPendingSenderIds];
                dmHintPendingSenderIds.clear();
                void processDirectMessageJoinCommands(pendingCtx, {
                    preferUserIds: pendingIds,
                    preferOnly: true,
                });
            }
        });
        return dmJoinFastPassInFlight;
    }

    if (dmJoinFullPassInFlight) return dmJoinFullPassInFlight;

    // If a WS hint is waiting, kick the fast path immediately (don't make it wait for this scan).
    if (dmHintPendingSenderIds.size > 0 && !dmJoinFastPassInFlight) {
        void processDirectMessageJoinCommands(ctx, {
            preferUserIds: [...dmHintPendingSenderIds],
            preferOnly: true,
        });
    }

    dmJoinFullPassInFlight = processDirectMessageJoinCommandsInner(ctx, {
        preferUserIds: [],
        preferOnly: false,
    }).finally(() => {
        dmJoinFullPassInFlight = null;
    });
    return dmJoinFullPassInFlight;
}

async function processDirectMessageJoinCommandsInner(ctx, options = {}) {
    const session = ctx.session;
    const logger = ctx.logger || console;
    const logPrefix = `[${ctx.botName || 'BOT'}][DM]`;

    if (typeof session?.listRecentDirectMessages !== 'function') return { joinCommands: 0 };

    const preferUserIds = [
        ...new Set(
            (Array.isArray(options.preferUserIds) ? options.preferUserIds : [])
                .map((id) => String(id || '').trim())
                .filter((id) => /^\d+$/.test(id))
        ),
    ];
    let joinCommands = 0;
    /** sender:room already handled this pass — avoid replaying old !join history */
    const invitedThisPass = new Set();

    try {
        if (
            !options.preferOnly &&
            typeof session.refreshDirectMessageWatchList === 'function'
        ) {
            const now = Date.now();
            const roomIds = Array.isArray(ctx.configuredRoomIds) ? ctx.configuredRoomIds : [];
            if (now - lastDmWatchRefreshAt >= DM_WATCH_REFRESH_MS) {
                lastDmWatchRefreshAt = now;
                const watchedCount = await session.refreshDirectMessageWatchList(roomIds);
                if (watchedCount === 0) {
                    logger.warn(`${logPrefix} no DM contacts watched — add rooms or friend the bot`);
                }
            }
        }

        let conversations = [];
        if (
            preferUserIds.length &&
            typeof session.listRecentDirectMessagesFromUsers === 'function'
        ) {
            conversations = await session.listRecentDirectMessagesFromUsers(preferUserIds, 40);
            logger.log(
                `${logPrefix} fetched ${conversations.length} msg(s) for sender(s) ${preferUserIds.join(',')}`
            );
        }

        const hasJoin = conversations.some((entry) =>
            /^!join\b/i.test(String(entry?.text || ''))
        );
        if (!hasJoin && !options.preferOnly) {
            conversations = await session.listRecentDirectMessages(40, { preferUserIds });
        }

        if (!conversations.length) {
            logger.log(`${logPrefix} no inbound DM commands (${watchedDmUserIdsLabel(session)})`);
            return { joinCommands: 0 };
        }

        // Newest first when possible — historical !join spam should not all fire.
        conversations = [...conversations].reverse();

        for (const conversation of conversations) {
            const messageId = String(conversation.messageId || '');
            const text = String(conversation.text || '').trim();
            let senderUserId = String(conversation.senderUserId || '');
            let senderUsername = String(conversation.senderUsername || '').trim();

            if (!messageId || !rememberProcessedDmMessage(messageId)) continue;

            ({ senderId: senderUserId, senderUsername } = await resolveDmSender(
                session,
                senderUserId,
                senderUsername
            ));

            if (senderUserId && typeof session.watchDirectMessageUser === 'function') {
                session.watchDirectMessageUser(senderUserId);
            }

            if (!/^!join\b/i.test(text)) continue;
            joinCommands += 1;

            if (!senderUserId) {
                logger.warn(
                    `${logPrefix} join command from ${senderUsername || '?'} missing sender id (${text})`
                );
                continue;
            }

            const connectedRooms = listConnectedRoomIds(ctx);
            let roomId = parseJoinRoomId(text);

            if (!roomId) {
                if (connectedRooms.length === 1) {
                    roomId = connectedRooms[0];
                } else if (connectedRooms.length > 1) {
                    logger.log(
                        `${logPrefix} bare !join from ${senderUsername || senderUserId} — ` +
                            `bot in multiple rooms: ${connectedRooms.join(', ')}`
                    );
                    continue;
                } else {
                    logger.log(
                        `${logPrefix} bare !join from ${senderUsername || senderUserId} — bot not in any room`
                    );
                    continue;
                }
            }

            const inviteKey = `${senderUserId}:${roomId}`;
            if (invitedThisPass.has(inviteKey)) continue;
            invitedThisPass.add(inviteKey);

            logger.log(`${logPrefix} join command from ${senderUsername || senderUserId}: ${text}`);

            const present =
                typeof ctx.isRoomConnected === 'function'
                    ? ctx.isRoomConnected(roomId)
                    : connectedRooms.includes(roomId);
            if (!present) {
                logger.warn(
                    `${logPrefix} invite skipped — bot not in room ${roomId} (sender ${senderUsername || senderUserId})`
                );
                continue;
            }

            if (!claimDmRoomInvite(senderUserId, roomId)) {
                logger.log(
                    `${logPrefix} invite cooldown — skip ${senderUsername || senderUserId} → ${roomId}`
                );
                continue;
            }

            if (typeof session.inviteUserToRoom !== 'function') {
                logger.warn(`${logPrefix} inviteUserToRoom unavailable`);
                continue;
            }

            const invite = await session.inviteUserToRoom(roomId, senderUserId);
            if (!invite?.ok) {
                const errText = String(invite?.message || invite?.error || 'unknown');
                logger.warn(
                    `${logPrefix} invite to ${roomId} for ${senderUsername || senderUserId} failed: ${errText}`
                );
                continue;
            }

            // Invite only — no DM. Recipient toast is Next's chat_invite_v2 toaster.
            logger.log(
                `${logPrefix} invited ${senderUsername || senderUserId} to ${roomId}` +
                    ` (${invite.mode || 'chat'}` +
                    `${invite.inviteId ? ` invite-${invite.inviteId}` : ''})` +
                    ` — toast is on recipient Next client (no DM)`
            );
        }
    } catch (error) {
        logger.warn(`${logPrefix} DM command pass failed: ${error?.message || error}`);
    }

    return { joinCommands };
}

function listConnectedRoomIds(ctx) {
    if (typeof ctx.getConnectedRoomIds === 'function') {
        return [...new Set(ctx.getConnectedRoomIds().map((id) => String(id || '').replace(/^room-/i, '')).filter(Boolean))];
    }
    const configured = Array.isArray(ctx.configuredRoomIds) ? ctx.configuredRoomIds : [];
    if (typeof ctx.isRoomConnected === 'function') {
        return configured
            .map((id) => String(id || '').replace(/^room-/i, ''))
            .filter((id) => id && ctx.isRoomConnected(id));
    }
    return configured.map((id) => String(id || '').replace(/^room-/i, '')).filter(Boolean);
}

/**
 * Join rooms when the bot receives a chat_invite / chat_invite_v2 activity.
 * Official Next client has no separate "accept invite" POST — joining the room is accept.
 */
function quickRoomIdFromRef(roomRef) {
    const ref = String(roomRef || '').trim();
    const roomMatch = ref.match(/\/room\/room-([\d-]+)/i);
    if (roomMatch) return roomMatch[1];
    const chatMatch = ref.match(/\/chat\/chat-([\d-]+)/i);
    if (chatMatch && chatMatch[1].includes('-')) return chatMatch[1];
    return null;
}

function rememberInviteKey(key) {
    const id = String(key || '').trim();
    if (!id) return false;
    if (processedInviteActivityKeys.has(id)) return false;
    processedInviteActivityKeys.add(id);
    if (processedInviteActivityKeys.size > 500) {
        processedInviteActivityKeys.clear();
        processedInviteActivityKeys.add(id);
    }
    return true;
}

async function dismissInvite(session, activityKey) {
    rememberInviteKey(activityKey);
    if (typeof session?.markChatInviteRead === 'function') {
        void session.markChatInviteRead(activityKey).catch(() => {});
    }
}

function isPermanentInviteReject(message) {
    const text = String(message || '');
    return (
        /Only the room owner or a moderator/i.test(text) ||
        /No active IMVU bot/i.test(text)
    );
}

async function joinRoomFromInvite(ctx, {
    roomId,
    senderUserId = '',
    senderUsername = '',
    activityKey = '',
    source = 'rest',
} = {}) {
    const session = ctx.session;
    const logger = ctx.logger || console;
    const logPrefix = `[${ctx.botName || 'BOT'}][INVITE]`;
    const id = String(roomId || '')
        .trim()
        .replace(/^room-/i, '');
    if (!/^\d+-\d+$/.test(id)) return false;

    const isConnected =
        typeof ctx.isRoomConnected === 'function' ? ctx.isRoomConnected : () => false;
    if (isConnected(id)) {
        if (activityKey) await dismissInvite(session, activityKey);
        return true;
    }

    const dedupeKey = activityKey || `room:${id}:${senderUserId || senderUsername || 'unknown'}`;
    if (!rememberInviteKey(dedupeKey)) return false;

    logger.log(
        `${logPrefix} invite from ${senderUsername || senderUserId || '?'} -> ${id} (${source})`
    );

    const result = await postBotRoomJoin(BACKEND_URL, ctx.botName, id, {
        senderId: senderUserId,
        senderLabel: senderUsername,
        source: 'invite',
    });

    if (!result.ok) {
        const message = result.message || 'unknown';
        logger.warn(`${logPrefix} join to ${id} rejected: ${message}`);
        // Transient rejects can retry on the next poll / invite frame.
        if (!isPermanentInviteReject(message)) {
            processedInviteActivityKeys.delete(dedupeKey);
        } else if (activityKey) {
            await dismissInvite(session, activityKey);
        }
        return false;
    }

    logger.log(`${logPrefix} joining ${id} after invite (${source})`);
    if (typeof ctx.startRoom === 'function') {
        await ctx.startRoom(id).catch((error) => {
            logger.warn(`${logPrefix} startRoom failed for ${id}: ${error?.message || error}`);
            processedInviteActivityKeys.delete(dedupeKey);
        });
    }

    if (activityKey) await dismissInvite(session, activityKey);
    return true;
}

/**
 * Fast path: DM websocket hint — watch sender and process !join invite commands.
 * Only react to messageReceived (not conversation edge churn), and debounce bursts.
 */
export async function handleSocialWsDmHint(ctx, hint) {
    if (!isSocialSyncEnabled() || !isDmJoinEnabled()) return;
    const mount = String(hint?.mount || '');
    const action = String(hint?.action || '').toLowerCase();
    // Ignore conversation created/updated echoes from our own invite/DM traffic.
    if (mount.startsWith('edge:conversations') || mount === 'edge:messages') return;
    if (mount === 'web_msg' && action && action !== 'message') return;

    const session = ctx.session;
    const senderIds = Array.isArray(hint?.userIds) ? hint.userIds : [];
    for (const raw of senderIds) {
        const id = String(raw || '').trim();
        if (!/^\d+$/.test(id)) continue;
        dmHintPendingSenderIds.add(id);
        if (typeof session?.watchDirectMessageUser === 'function') {
            session.watchDirectMessageUser(id);
        }
    }

    dmHintPendingCtx = ctx;
    if (dmHintDebounceTimer) return;
    const waitMs = Math.max(100, parseInt(String(process.env.IMVU_DM_JOIN_DEBOUNCE_MS || '400'), 10) || 400);
    dmHintDebounceTimer = setTimeout(() => {
        dmHintDebounceTimer = null;
        const pending = dmHintPendingCtx;
        dmHintPendingCtx = null;
        const preferUserIds = [...dmHintPendingSenderIds];
        dmHintPendingSenderIds.clear();
        if (!pending) return;

        void (async () => {
            const result = await processDirectMessageJoinCommands(pending, {
                preferUserIds,
                preferOnly: true,
            });
            // IMVU often lags a second before last_message is readable — one retry.
            if ((result?.joinCommands || 0) > 0) return;
            if (dmHintRetryTimer) return;
            dmHintRetryTimer = setTimeout(() => {
                dmHintRetryTimer = null;
                void processDirectMessageJoinCommands(pending, {
                    preferUserIds,
                    preferOnly: true,
                });
            }, Math.max(500, parseInt(String(process.env.IMVU_DM_JOIN_RETRY_MS || '1500'), 10) || 1500));
        })();
    }, waitMs);
}

/**
 * Fast path: chatInvite web_msg already includes room id + inviter.
 * edge:invites without room id falls back to REST activity list.
 */
export async function handleSocialWsInviteHint(ctx, hint) {
    if (!isSocialSyncEnabled()) return;
    const mount = String(hint?.mount || '');
    const action = String(hint?.action || '').toLowerCase();
    if (mount === 'edge:invites' && action && action !== 'created') return;

    const roomId = String(hint?.roomId || '').trim();
    if (roomId) {
        const senderUserId = Array.isArray(hint?.userIds) ? String(hint.userIds[0] || '') : '';
        const senderUsername = String(hint?.inviterName || '').trim();
        const inviteKey = hint?.inviteId ? `invite:${hint.inviteId}` : '';
        await joinRoomFromInvite(ctx, {
            roomId,
            senderUserId,
            senderUsername,
            activityKey: inviteKey,
            source: 'ws',
        });
        return;
    }

    // No room on the frame — REST activity list has the room ref.
    await processChatRoomInvites(ctx);
}

export async function processChatRoomInvites(ctx) {
    const session = ctx.session;
    const logger = ctx.logger || console;
    const logPrefix = `[${ctx.botName || 'BOT'}][INVITE]`;

    if (typeof session?.listUnreadChatInvites !== 'function') return;

    try {
        const invites = await session.listUnreadChatInvites();
        if (!invites.length) return;

        for (const invite of invites) {
            const activityKey = String(invite.activityKey || '');
            if (!activityKey || processedInviteActivityKeys.has(activityKey)) continue;

            const activityType = String(invite.activityType || 'chat_invite');
            let roomId = quickRoomIdFromRef(invite.roomRef);
            if (!roomId && typeof session.resolveRoomIdFromChatRef === 'function') {
                roomId = await session.resolveRoomIdFromChatRef(invite.roomRef);
            }

            if (!roomId) {
                logger.warn(
                    `${logPrefix} unread invite has no resolvable room (${activityType}); dismissing ${activityKey.slice(0, 120)}`
                );
                await dismissInvite(session, activityKey);
                continue;
            }

            const senderUserId = String(invite.actorUserId || '');
            const senderUsername = String(invite.actorUsername || '').trim();

            // Backend authorizes owner/mod + bot-active-for-owner; invite can add or unpause a room.
            const joined = await joinRoomFromInvite(ctx, {
                roomId,
                senderUserId,
                senderUsername,
                activityKey,
                source: `rest:${activityType}`,
            });
            if (joined) break;
        }
    } catch (error) {
        logger.warn(`${logPrefix} invite pass failed: ${error?.message || error}`);
    }
}

export { extractMessageText, extractSenderUserId, extractParticipantUserIds, parseJoinRoomId };
