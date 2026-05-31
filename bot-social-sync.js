import { backendApiBaseUrl } from './env-app-url.js';
import { postBotRoomJoin } from './room-commands/api.js';
import { JOIN_COMMAND_USAGE } from './room-commands/parseCommand.js';

const BACKEND_URL = backendApiBaseUrl('http://127.0.0.1:8000');
const processedDmMessageIds = new Set();
const processedInviteActivityKeys = new Set();
const JOIN_COMMAND = /^!join(?:\s+(?:room-)?["']?([\d-]+)["']?)?/i;
let lastDmWatchRefreshAt = 0;
const DM_WATCH_REFRESH_MS = 60_000;

function isDmJoinEnabled() {
    const raw = String(process.env.IMVU_DM_JOIN_ENABLED || '0').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes';
}

export function isSocialSyncEnabled() {
    const raw = String(process.env.IMVU_SOCIAL_SYNC_ENABLED || '0').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes';
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
            const result = await session.acceptFriendRequest(userId);
            if (result?.ok) {
                if (isDmJoinEnabled() && typeof session.watchDirectMessageUser === 'function') {
                    session.watchDirectMessageUser(userId);
                }
                logger.log(`${logPrefix} accepted friend request from user-${userId}`);
            }
        }
    } catch (error) {
        logger.warn(`${logPrefix} friend accept pass failed: ${error?.message || error}`);
    }
}

/**
 * Handle `!join room-id` sent via IMVU direct message.
 */
export async function processDirectMessageJoinCommands(ctx) {
    const session = ctx.session;
    const logger = ctx.logger || console;
    const logPrefix = `[${ctx.botName || 'BOT'}][DM]`;

    if (typeof session?.listRecentDirectMessages !== 'function') return;

    try {
        if (typeof session.refreshDirectMessageWatchList === 'function') {
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

        const conversations = await session.listRecentDirectMessages(25);
        if (!conversations.length) {
            logger.log(`${logPrefix} no inbound DM commands (${watchedDmUserIdsLabel(session)})`);
        }

        for (const conversation of conversations) {
            const messageId = String(conversation.messageId || '');
            const text = String(conversation.text || '').trim();
            let senderUserId = String(conversation.senderUserId || '');
            let senderUsername = String(conversation.senderUsername || '').trim();

            if (!messageId || processedDmMessageIds.has(messageId)) continue;
            processedDmMessageIds.add(messageId);
            if (processedDmMessageIds.size > 500) {
                processedDmMessageIds.clear();
            }

            ({ senderId: senderUserId, senderUsername } = await resolveDmSender(
                session,
                senderUserId,
                senderUsername
            ));

            if (senderUserId && typeof session.watchDirectMessageUser === 'function') {
                session.watchDirectMessageUser(senderUserId);
            }

            const roomId = parseJoinRoomId(text);
            if (!roomId) {
                if (/^!join\b/i.test(text) && typeof session.sendDirectMessage === 'function') {
                    if (!senderUserId) {
                        logger.warn(`${logPrefix} !join without room id but sender id unknown (${text})`);
                        continue;
                    }
                    await session.sendDirectMessage(
                        senderUserId,
                        `${JOIN_COMMAND_USAGE} (quotes optional)`,
                        senderUsername
                    );
                }
                continue;
            }

            if (!senderUserId) {
                logger.warn(
                    `${logPrefix} join command from ${senderUsername || '?'} missing sender id — cannot authorize (${text})`
                );
                continue;
            }

            logger.log(`${logPrefix} join command from ${senderUsername || senderUserId}: ${text}`);

            const result = await postBotRoomJoin(BACKEND_URL, ctx.botName, roomId, {
                senderId: senderUserId,
                senderLabel: senderUsername,
            });

            if (typeof session.sendDirectMessage === 'function') {
                const dm = await session.sendDirectMessage(
                    senderUserId,
                    `${result.message || (result.ok ? 'Join queued.' : 'Join failed.')}`,
                    senderUsername
                );
                if (!dm?.ok) {
                    logger.warn(`${logPrefix} reply failed: ${dm?.reason || 'unknown'}`);
                }
            }

            if (result.ok) {
                logger.log(`${logPrefix} queued join to ${roomId} from ${senderUsername || senderUserId}`);
                if (typeof ctx.startRoom === 'function') {
                    await ctx.startRoom(roomId).catch((error) => {
                        logger.warn(`${logPrefix} startRoom failed for ${roomId}: ${error?.message || error}`);
                    });
                }
            } else {
                logger.warn(`${logPrefix} join to ${roomId} rejected: ${result.message || 'unknown'}`);
            }
        }
    } catch (error) {
        logger.warn(`${logPrefix} DM command pass failed: ${error?.message || error}`);
    }
}

/**
 * Join rooms when the bot receives a chat_invite / chat_invite_v2 activity.
 */
function quickRoomIdFromRef(roomRef) {
    const ref = String(roomRef || '').trim();
    const roomMatch = ref.match(/\/room\/room-([\d-]+)/i);
    if (roomMatch) return roomMatch[1];
    const chatMatch = ref.match(/\/chat\/chat-([\d-]+)/i);
    if (chatMatch && chatMatch[1].includes('-')) return chatMatch[1];
    return null;
}

function normalizeRoomIdList(values) {
    if (!Array.isArray(values)) return [];
    return values
        .map((value) =>
            String(value || '')
                .trim()
                .replace(/^room-/i, '')
        )
        .filter((value) => /^\d+-\d+$/.test(value));
}

async function dismissInvite(session, activityKey) {
    processedInviteActivityKeys.add(activityKey);
    if (processedInviteActivityKeys.size > 500) {
        processedInviteActivityKeys.clear();
    }
    if (typeof session?.markChatInviteRead === 'function') {
        void session.markChatInviteRead(activityKey).catch(() => {});
    }
}

export async function processChatRoomInvites(ctx) {
    const session = ctx.session;
    const logger = ctx.logger || console;
    const logPrefix = `[${ctx.botName || 'BOT'}][INVITE]`;

    if (typeof session?.listUnreadChatInvites !== 'function') return;

    try {
        const invites = await session.listUnreadChatInvites();
        if (!invites.length) return;

        const configured = new Set(normalizeRoomIdList(ctx.configuredRoomIds));
        const paused = new Set(normalizeRoomIdList(ctx.getPausedRoomIds?.()));
        const isConnected =
            typeof ctx.isRoomConnected === 'function' ? ctx.isRoomConnected : () => false;

        for (const invite of invites) {
            const activityKey = String(invite.activityKey || '');
            if (!activityKey || processedInviteActivityKeys.has(activityKey)) continue;

            const activityType = String(invite.activityType || 'chat_invite');
            let roomId = quickRoomIdFromRef(invite.roomRef);
            if (!roomId && typeof session.resolveRoomIdFromChatRef === 'function') {
                roomId = await session.resolveRoomIdFromChatRef(invite.roomRef);
            }

            if (!roomId) continue;

            if (isConnected(roomId)) {
                await dismissInvite(session, activityKey);
                continue;
            }

            if (configured.size > 0 && !configured.has(roomId)) continue;
            if (paused.size > 0 && !paused.has(roomId)) continue;

            const senderUserId = String(invite.actorUserId || '');
            const senderUsername = String(invite.actorUsername || '').trim();

            logger.log(
                `${logPrefix} ${activityType} from ${senderUsername || senderUserId || '?'} -> ${roomId}`
            );

            const result = await postBotRoomJoin(BACKEND_URL, ctx.botName, roomId, {
                senderId: senderUserId,
                senderLabel: senderUsername,
            });

            if (!result.ok) {
                logger.warn(`${logPrefix} join to ${roomId} rejected: ${result.message || 'unknown'}`);
                continue;
            }

            logger.log(`${logPrefix} joining ${roomId} after invite`);
            if (typeof ctx.startRoom === 'function') {
                await ctx.startRoom(roomId).catch((error) => {
                    logger.warn(`${logPrefix} startRoom failed for ${roomId}: ${error?.message || error}`);
                });
            }

            await dismissInvite(session, activityKey);
            break;
        }
    } catch (error) {
        logger.warn(`${logPrefix} invite pass failed: ${error?.message || error}`);
    }
}

export { extractMessageText, extractSenderUserId, extractParticipantUserIds, parseJoinRoomId };
