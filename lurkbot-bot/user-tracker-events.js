import axios from 'axios';
import {
    EXCLUDED_HANDLES,
    chatVerbose,
    decodeChatEnvelope,
    decodeId,
    displayNameFromEnvelope,
    isImvuMessagesMount,
    isImvuRoomChatQueue,
    isImvuRoomProtocolLine,
    isOnlyBotNameMention,
    messageMentionsBot,
    normalizeImvuUsername,
    roomQueueBelongsToRoom,
    welcomeHandleKey,
} from './user-tracker-utils.js';
import {
    messageInvokesSivaCharacterAi,
    stripSivaCharacterAiTriggers,
} from './sivaCharacterAi.js';

export const createImvuHandleResolver = ({ page }) => {
    const imvuAvNameCache = new Map();
    const imvuAvNameInflight = new Map();

    return async (uid) => {
        const id = String(uid);
        if (!/^\d+$/.test(id)) return null;
        if (imvuAvNameCache.has(id)) return imvuAvNameCache.get(id);
        const inflight = imvuAvNameInflight.get(id);
        if (inflight) return inflight;

        const promise = (async () => {
            if (!page || page.isClosed()) return null;
            try {
                const name = await page.evaluate(async (numericId) => {
                    const isRenderableName = (s) => {
                        if (typeof s !== 'string') return false;
                        const t = s.trim();
                        if (!t || /^\d+$/.test(t)) return false;
                        if (/^[\u2800\s\u2000-\u200D\uFEFF]+$/.test(t)) return false;
                        return true;
                    };
                    try {
                        const apiUrl = `https://api.imvu.com/user/user-${numericId}`;
                        const res = await fetch(apiUrl, {
                            credentials: 'include',
                            mode: 'cors',
                            headers: { Accept: 'application/json' },
                        });
                        if (!res.ok) return null;
                        const json = await res.json();
                        const denorm = json.denormalized || {};
                        const entry = (json.id && denorm[json.id]) || Object.values(denorm)[0];
                        const d = entry?.data;
                        if (!d) return null;
                        const u = typeof d.username === 'string' ? d.username.trim() : '';
                        if (u) return u;
                        const dn = typeof d.display_name === 'string' ? d.display_name.trim() : '';
                        if (isRenderableName(dn)) return dn;
                        return null;
                    } catch {
                        return null;
                    }
                }, id);
                const norm = name ? normalizeImvuUsername(name) : null;
                if (norm) imvuAvNameCache.set(id, norm);
                return norm || null;
            } catch {
                return null;
            } finally {
                imvuAvNameInflight.delete(id);
            }
        })();

        imvuAvNameInflight.set(id, promise);
        return promise;
    };
};

const hasResolvedName = (v) =>
    v !== null &&
    v !== undefined &&
    String(v).trim() !== '';

export const createIncomingMessageHandler = (ctx) => {
    const userLastReply = new Map();

    const handleFinalJoin = (avatarId) => {
        if (!avatarId) return;
        if (ctx.processedJoins.has(avatarId)) return;
        ctx.processedJoins.add(avatarId);

        const name = ctx.lastUserMap.get(avatarId);
        if (!name || String(name).trim() === '') {
            ctx.processedJoins.delete(avatarId);
            return;
        }

        const label = ctx.isSelfId(avatarId)
            ? ctx.BOT_USERNAME
            : normalizeImvuUsername(String(name));

        ctx.announceJoinQueuePresence(avatarId, label);

        const scheduled = ctx.scheduleWelcomeForAvatar(avatarId, label, {
            participantUsername: label,
            participantAvatarId: String(avatarId),
        });
        if (!scheduled) ctx.processedJoins.delete(avatarId);
    };

    return async (msg) => {
        if (process.env.WS_DEBUG === '1' || process.env.WS_DEBUG === 'true') {
            console.log('[WS_DEBUG]', JSON.stringify(msg, null, 2));
        }
        const actions = Array.isArray(msg) ? msg : [msg];

        for (const action of actions) {
            const record = action.record || '';
            const props = action.properties || {};
            const queue = action.queue || '';
            const mount = action.mount || '';

            if (record === 'msg_c2g_connect' && action.user_id) {
                ctx.state.selfUserId = decodeId(action.user_id);
            }

            if (
                record === 'msg_g2c_create_mount' &&
                (mount === 'participants' || mount === 'edge:participants')
            ) {
                const participants = props.items || props.participants || props.users || [];
                const isPatch = action.type === 2;

                if (!isPatch) {
                    ctx.lastUserMap.clear();
                    ctx.skipWelcomeAvatarIds.clear();
                    ctx.joinQueueBackendAnnounced.clear();
                }

                participants.forEach((p) => {
                    const rawId = p.avatar_id || p.user_id || p.id;
                    const avatarId = decodeId(rawId);

                    if (p.state === 'removed') {
                        if (avatarId && ctx.lastUserMap.has(avatarId)) {
                            const username = ctx.lastUserMap.get(avatarId);
                            ctx.welcomeTimestamps?.delete(avatarId);
                            if (username != null && String(username).trim() !== '') {
                                const hk = welcomeHandleKey(
                                    normalizeImvuUsername(String(username)) || String(username).trim(),
                                );
                                if (hk) ctx.welcomeByHandleLastAt?.delete(hk);
                            }
                            ctx.lastUserMap.delete(avatarId);
                            ctx.skipWelcomeAvatarIds.delete(avatarId);
                            ctx.joinQueueBackendAnnounced.delete(avatarId);
                            ctx.activeJoinSessions.delete(avatarId);
                            ctx.processedJoins.delete(avatarId);
                            if (username && typeof ctx.onLeave === 'function') ctx.onLeave(username);
                        }
                        return;
                    }

                    const rawUser = p.username || p.display_name || p.name || p.screen_name;
                    const username = normalizeImvuUsername(rawUser);

                    if (avatarId && username && !EXCLUDED_HANDLES.includes(username.toLowerCase())) {
                        const existing = ctx.lastUserMap.get(avatarId);
                        const existingNorm =
                            existing != null ? normalizeImvuUsername(String(existing)) : existing;
                        if (existingNorm && existingNorm === username) return;

                        ctx.lastUserMap.set(avatarId, username);
                        if (!existing || existing === null) {
                            if (!ctx.state.participantsRosterSynced) return;
                            if (avatarId) ctx.joinQueueBackendAnnounced.add(avatarId);
                            ctx.onJoin(username);
                        }
                    }
                });

                if (!isPatch) {
                    participants.forEach((p) => {
                        if (p.state === 'removed') return;
                        const rawId = p.avatar_id || p.user_id || p.id;
                        const aid = decodeId(rawId);
                        if (aid) ctx.skipWelcomeAvatarIds.add(aid);
                    });
                    ctx.state.participantsRosterSynced = true;
                    if (ctx.state.botJoinedChat && !ctx.state.welcomeArrivalsEnabled) {
                        if (ctx.state.welcomeArrivalsEnableTimer) {
                            clearTimeout(ctx.state.welcomeArrivalsEnableTimer);
                        }
                        ctx.state.welcomeArrivalsEnableTimer = setTimeout(() => {
                            ctx.state.welcomeArrivalsEnableTimer = null;
                            ctx.enableWelcomeForNewArrivals();
                        }, 5000);
                    }
                }

                ctx.triggerCountUpdate();
                continue;
            }

            if (record === 'msg_g2c_joined_queue' && typeof queue === 'string' && isImvuRoomChatQueue(queue)) {
                if (!ctx.state.welcomeArrivalsEnabled) {
                    const avatarId = decodeId(action.user_id);
                    if (avatarId && ctx.isSelfId(avatarId) && !ctx.state.botJoinedChat) {
                        if (!ctx.lastUserMap.has(avatarId)) ctx.lastUserMap.set(avatarId, null);
                        const beforeJoinCount = ctx.lastUserMap.size > 0 ? ctx.lastUserMap.size - 1 : 0;
                        console.log(`[COUNT][BEFORE_JOIN] 👥 Total Occupants: ${beforeJoinCount}`);
                        console.log(`[COUNT][AFTER_JOIN] 👥 Total Occupants: ${ctx.lastUserMap.size}`);
                        ctx.state.botJoinedChat = true;
                        if (ctx.state.welcomeArrivalsEnableTimer) {
                            clearTimeout(ctx.state.welcomeArrivalsEnableTimer);
                        }
                        ctx.state.welcomeArrivalsEnableTimer = setTimeout(() => {
                            ctx.state.welcomeArrivalsEnableTimer = null;
                            ctx.enableWelcomeForNewArrivals();
                        }, 5000);
                        void ctx.refreshRoomName();
                        ctx.triggerCountUpdate();
                    } else if (avatarId && !ctx.lastUserMap.has(avatarId)) {
                        ctx.lastUserMap.set(avatarId, null);
                        console.log(`[JOIN][QUEUE][BOOTSTRAP] silently tracking ${avatarId}`);
                        ctx.triggerCountUpdate();
                    }
                    continue;
                }

                const avatarId = decodeId(action.user_id);
                const hadUser = avatarId ? ctx.lastUserMap.has(avatarId) : false;

                if (avatarId && !ctx.lastUserMap.has(avatarId)) {
                    ctx.lastUserMap.set(avatarId, null);
                    console.log(
                        `[JOIN][QUEUE] ${ctx.isSelfId(avatarId) ? 'bot' : 'occupant'} · resolving https://api.imvu.com/user/user-${avatarId}`
                    );
                    if (/^\d+$/.test(String(avatarId))) {
                        void ctx.resolveImvuHandleFromNumericId(avatarId).then((name) => {
                            if (!name || !ctx.lastUserMap.has(avatarId)) return;
                            const cur = ctx.lastUserMap.get(avatarId);
                            if (hasResolvedName(cur)) {
                                handleFinalJoin(avatarId);
                                ctx.triggerCountUpdate();
                                return;
                            }
                            const label = ctx.isSelfId(avatarId) ? ctx.BOT_USERNAME : name;
                            ctx.lastUserMap.set(avatarId, label);
                            console.log(`[JOIN][QUEUE] ${label} · profile API`);
                            handleFinalJoin(avatarId);
                            ctx.triggerCountUpdate();
                        }).catch(e => console.error(`[JOIN][QUEUE] Error resolving avatar ${avatarId}:`, e.message));
                    }
                } else if (
                    avatarId &&
                    ctx.lastUserMap.has(avatarId) &&
                    ctx.state.welcomeArrivalsEnabled &&
                    ctx.state.botJoinedChat &&
                    !ctx.isSelfId(avatarId) &&
                    !ctx.skipWelcomeAvatarIds.has(avatarId) &&
                    !ctx.joinQueueBackendAnnounced.has(avatarId)
                ) {
                    const cur = ctx.lastUserMap.get(avatarId);
                    if (hasResolvedName(cur)) {
                        handleFinalJoin(avatarId);
                        ctx.triggerCountUpdate();
                    } else if (/^\d+$/.test(String(avatarId))) {
                        console.log(
                            `[JOIN][QUEUE] occupant · resolving https://api.imvu.com/user/user-${avatarId}`
                        );
                        void ctx.resolveImvuHandleFromNumericId(avatarId).then((name) => {
                            if (!name || !ctx.lastUserMap.has(avatarId)) return;
                            const inner = ctx.lastUserMap.get(avatarId);
                            if (hasResolvedName(inner)) {
                                handleFinalJoin(avatarId);
                                ctx.triggerCountUpdate();
                                return;
                            }
                            ctx.lastUserMap.set(avatarId, name);
                            console.log(`[JOIN][QUEUE] ${name} · profile API`);
                            handleFinalJoin(avatarId);
                            ctx.triggerCountUpdate();
                        }).catch(e => console.error(`[JOIN][QUEUE] Error resolving occupant ${avatarId}:`, e.message));
                    }
                }

                if (avatarId && ctx.isSelfId(avatarId) && !ctx.state.botJoinedChat) {
                    const beforeJoinCount = hadUser ? ctx.lastUserMap.size : Math.max(ctx.lastUserMap.size - 1, 0);
                    console.log(`[COUNT][BEFORE_JOIN] 👥 Total Occupants: ${beforeJoinCount}`);
                    console.log(`[COUNT][AFTER_JOIN] 👥 Total Occupants: ${ctx.lastUserMap.size}`);
                    ctx.state.botJoinedChat = true;
                    if (!ctx.state.welcomeArrivalsEnabled) {
                        if (ctx.state.welcomeArrivalsEnableTimer) {
                            clearTimeout(ctx.state.welcomeArrivalsEnableTimer);
                        }
                        ctx.state.welcomeArrivalsEnableTimer = setTimeout(() => {
                            ctx.state.welcomeArrivalsEnableTimer = null;
                            ctx.enableWelcomeForNewArrivals();
                        }, 5000);
                    }
                    void ctx.refreshRoomName();
                }
                ctx.triggerCountUpdate();
                continue;
            }

            if (record === 'msg_g2c_left_queue' || record === 'msg_g2c_user_exited') {
                const avatarId = decodeId(action.user_id || action.avatar_id);
                if (avatarId && ctx.lastUserMap.has(avatarId)) {
                    if (ctx.isSelfId(avatarId)) {
                        ctx.lastUserMap.delete(avatarId);
                        ctx.skipWelcomeAvatarIds.delete(avatarId);
                        ctx.joinQueueBackendAnnounced.delete(avatarId);
                        ctx.activeJoinSessions.delete(avatarId);
                        ctx.welcomeTimestamps.delete(avatarId);
                        ctx.processedJoins.delete(avatarId);
                        ctx.triggerCountUpdate();
                        continue;
                    }
                    const username = ctx.lastUserMap.get(avatarId);
                    ctx.welcomeTimestamps?.delete(avatarId);
                    if (username != null && String(username).trim() !== '') {
                        const hk = welcomeHandleKey(
                            normalizeImvuUsername(String(username)) || String(username).trim(),
                        );
                        if (hk) ctx.welcomeByHandleLastAt?.delete(hk);
                    }
                    ctx.lastUserMap.delete(avatarId);
                    ctx.skipWelcomeAvatarIds.delete(avatarId);
                    ctx.joinQueueBackendAnnounced.delete(avatarId);
                    ctx.activeJoinSessions.delete(avatarId);
                    ctx.processedJoins.delete(avatarId);
                    if (username) ctx.onLeave(username);
                    ctx.triggerCountUpdate();
                }
                continue;
            }

            if (
                (record === 'msg_g2c_send_message' || record === 'msg_c2g_send_message') &&
                isImvuRoomChatQueue(queue) &&
                isImvuMessagesMount(mount)
            ) {
                if (!roomQueueBelongsToRoom(queue, ctx.roomId)) {
                    if (
                        process.env.IMVU_CHAT_QUEUE_DEBUG === '1' ||
                        process.env.IMVU_CHAT_QUEUE_DEBUG === 'true'
                    ) {
                        console.log(
                            `[CHAT][skip-queue] room ${ctx.roomId} queue=${String(queue).slice(0, 160)}`,
                        );
                    }
                    continue;
                }
                const envelope = decodeChatEnvelope(action.message);
                const envelopeName = normalizeImvuUsername(displayNameFromEnvelope(envelope));
                const rawSender =
                    action.user_id ?? envelope?.userId ?? envelope?.user_id ?? envelope?.userID;
                const senderId = decodeId(rawSender != null ? String(rawSender) : null);
                if (senderId && ctx.isSelfId(senderId)) ctx.lastUserMap.set(senderId, ctx.BOT_USERNAME);

                const wireName = normalizeImvuUsername(
                    typeof action.username === 'string'
                        ? action.username.trim()
                        : typeof action.display_name === 'string'
                          ? action.display_name.trim()
                          : null
                );

                if (senderId && envelopeName) {
                    const cur = ctx.lastUserMap.get(senderId);
                    if (cur == null || cur === '') ctx.lastUserMap.set(senderId, envelopeName);
                }
                if (senderId && wireName && /^\d+$/.test(wireName) === false) {
                    const cur = ctx.lastUserMap.get(senderId);
                    if (cur == null || cur === '') ctx.lastUserMap.set(senderId, wireName);
                }

                const resolvedName = senderId ? normalizeImvuUsername(ctx.lastUserMap.get(senderId)) : null;
                let senderLabel =
                    (resolvedName && String(resolvedName)) ||
                    envelopeName ||
                    (wireName && !/^\d+$/.test(wireName) ? wireName : null);
                if (!senderLabel) senderLabel = ctx.isSelfId(senderId) ? ctx.BOT_USERNAME : 'Guest';

                if (senderLabel === 'Guest' && senderId && /^\d+$/.test(String(senderId))) {
                    const fromAv = await ctx.resolveImvuHandleFromNumericId(senderId);
                    if (fromAv) {
                        const label = ctx.isSelfId(senderId)
                            ? ctx.BOT_USERNAME
                            : normalizeImvuUsername(fromAv);
                        ctx.lastUserMap.set(senderId, label);
                        senderLabel = label;
                    }
                }
                if (ctx.isSelfId(senderId)) senderLabel = ctx.BOT_USERNAME;

                const text = envelope?.message || envelope?.text || envelope?.body || envelope?.chat_message;
                if (typeof text === 'string' && text.trim()) {
                    const direction = record === 'msg_c2g_send_message' ? 'OUT' : 'IN';
                    const trimmed = text.trim();
                    if (
                        direction === 'IN' &&
                        typeof ctx.roomChatCommandHandler === 'function'
                    ) {
                        const handled = await ctx.roomChatCommandHandler({
                            text: trimmed,
                            senderLabel,
                            senderId,
                            isSelf: ctx.isSelfId(senderId),
                        });
                        if (handled) continue;
                    }
                    if (!chatVerbose() && isImvuRoomProtocolLine(text)) return;
                    console.log(`[CHAT][${direction}] ${senderLabel}: ${trimmed}`);
                    const avatarForLog = senderId && /^\d+$/.test(String(senderId)) ? String(senderId) : null;
                    void ctx.logConversationTurn({
                        username: senderLabel,
                        imvu_avatar_id: avatarForLog,
                        role: direction === 'OUT' ? 'assistant' : 'user',
                        content: trimmed,
                    });

                    // Option 2: Forward chat event to external Discord Bot Server
                    if (process.env.DISCORD_BOT_API_URL) {
                        void axios.post(process.env.DISCORD_BOT_API_URL, {
                            event: 'imvu_chat',
                            direction: direction,   // 'IN' from user, 'OUT' from bot
                            username: senderLabel,
                            imvu_avatar_id: avatarForLog,
                            message: trimmed,
                            room_id: String(ctx.roomId),
                            room_name: ctx.state.roomName,
                            discord_channel_id: ctx.discordChannelId
                        }).catch(e => {
                            const detail = e.response?.data || e.message;
                            console.log(`[DISCORD-API] Error sending to bot server:`, detail);
                        });
                    }

                    const sivaHitIn = messageInvokesSivaCharacterAi(trimmed);
                    const mentionHit =
                        !sivaHitIn &&
                        messageMentionsBot(trimmed, ctx.botMentionAliases) &&
                        !isOnlyBotNameMention(trimmed, ctx.botMentionAliases);

                    if (
                        direction === 'IN' &&
                        senderId != null &&
                        !ctx.isSelfId(senderId) &&
                        (sivaHitIn || mentionHit)
                    ) {
                        const now = Date.now();
                        if (now - (userLastReply.get(senderId) || 0) < 15000) {
                            console.log(`[AI-CHAT] 🚦 Ignoring ${senderLabel} (15s cooldown limit)`);
                            continue; // Note: In a loop, continue instead of return since we want to process other records!
                        }
                        userLastReply.set(senderId, now);

                        // Clean up the map occasionally
                        if (userLastReply.size > 200) userLastReply.clear();

                        const dedupeKey = `${ctx.roomId}:${senderId}:${trimmed}`;
                        if (!ctx.mentionReplyDedupe.has(dedupeKey)) {
                            ctx.mentionReplyDedupe.add(dedupeKey);
                            setTimeout(() => {
                                ctx.mentionReplyDedupe.delete(dedupeKey);
                            }, 15000);
                            if (ctx.mentionReplyDedupe.size > ctx.MENTION_REPLY_DEDUPE_CAP) {
                                const first = ctx.mentionReplyDedupe.values().next().value;
                                ctx.mentionReplyDedupe.delete(first);
                            }
                            const sivaHit = sivaHitIn;
                            void (async () => {
                                try {
                                    const res = sivaHit
                                        ? await axios.post(`${ctx.API_BASE_URL}/api/siva-chat`, {
                                              message: stripSivaCharacterAiTriggers(trimmed) || trimmed,
                                              username: senderLabel,
                                              room_id: String(ctx.roomId),
                                              imvu_avatar_id: avatarForLog,
                                              already_logged_user_message: true,
                                          })
                                        : await axios.post(`${ctx.API_BASE_URL}/api/lurk`, {
                                              message: trimmed,
                                              username: senderLabel,
                                              room_id: String(ctx.roomId),
                                              imvu_avatar_id: avatarForLog,
                                              bot_username: ctx.BOT_USERNAME,
                                              bot_display_name:
                                                  ctx.BOT_DISPLAY_NAME &&
                                                  ctx.BOT_DISPLAY_NAME.toLowerCase() !==
                                                      ctx.BOT_USERNAME.toLowerCase()
                                                      ? ctx.BOT_DISPLAY_NAME
                                                      : undefined,
                                              already_logged_user_message: true,
                                          });
                                    const reply = res.data?.reply;
                                    if (reply && typeof reply === 'string' && reply.trim()) {
                                        await ctx.sendMessage(reply.trim(), {
                                            participantUsername: senderLabel,
                                            participantAvatarId: avatarForLog ?? undefined,
                                        });
                                    }
                                } catch (e) {
                                    console.error(`[AI-CHAT] Error communicating with AI backend:`, e.message);
                                }
                            })();
                        }
                    }
                }
                continue;
            }

            if (
                record === 'msg_g2c_create_mount' &&
                (queue.includes('inv:/user/user-') || queue.includes('inv:/profile/user-')) &&
                mount === 'node'
            ) {
                const userIdPart = queue.split('user-')[1] || '';
                const userId = decodeId(userIdPart.split('/')[0]);
                const data = props || {};
                const realName = data.username || data.user_name || data.display_name || data.screen_name;
                if (userId && realName && ctx.lastUserMap.has(userId)) {
                    const existing = ctx.lastUserMap.get(userId);
                    const displayName = ctx.isSelfId(userId)
                        ? ctx.BOT_USERNAME
                        : normalizeImvuUsername(realName);
                    if (existing === displayName) return;
                    ctx.lastUserMap.set(userId, displayName);
                    if (!existing || existing === null) {
                        if (!ctx.state.participantsRosterSynced) return;
                        ctx.onJoin(displayName);
                    } else {
                        console.log(`[UPDATE] ${existing} → ${displayName}`);
                    }
                    ctx.triggerCountUpdate();
                }
            }
        }
    };
};

export const createDomFallback = ({ page, lastUserMap, triggerCountUpdate }) => async () => {
    try {
        const domUsers = await page.evaluate(() => {
            const results = [];
            const links = document.querySelectorAll('a[href*="/next/av/"]');
            links.forEach((l) => {
                const parts = l.href.split('/next/av/')[1].split('/');
                if (parts[0]) results.push(parts[0]);
            });
            return Array.from(new Set(results));
        });

        if (lastUserMap.size === 0 && domUsers.length > 0) {
            console.log(`[CDP-WS] 🛡️ DOM Baseline: ${domUsers.length} users`);
            domUsers.forEach((name) => {
                if (!Array.from(lastUserMap.values()).some((n) => n.toLowerCase() === name.toLowerCase())) {
                    lastUserMap.set(`dom_${name.toLowerCase()}`, name);
                }
            });
            triggerCountUpdate();
        }
    } catch {}
};
