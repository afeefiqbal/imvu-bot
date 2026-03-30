import axios from 'axios';
import { getWelcomeMessage } from './welcomeMessages.js';
import {
    messageInvokesSivaCharacterAi,
    stripSivaCharacterAiTriggers,
} from './sivaCharacterAi.js';

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
    const EXCLUDED_HANDLES = ['you', 'unknown', 'guest', 'loading'];
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
    const welcomedAvatarIds = new Set();
    /** Same user can appear on join-queue vs profile-mount with mismatched ids — one welcome per handle per visit */
    const welcomedHandlesLower = new Set();
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

    /** IMVU room API slug: `room-276040627-198` */
    const normalizeRoomApiSlug = (rid) => {
        const s = String(rid ?? '')
            .trim()
            .replace(/^\/+|\/+$/g, '');
        if (!s) return null;
        if (/^room-[\d-]+$/i.test(s)) return s;
        if (/^\d+-\d+$/.test(s)) return `room-${s}`;
        return null;
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

    const fetchRoomNameFromApi = async () => {
        const d = await fetchRoomDetailsFromApi();
        return d?.name || null;
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

    /** IMVU guest accounts often use usernames like Guest_Tronox76 — strip prefix for display/storage */
    const normalizeImvuUsername = (name) => {
        if (name == null || typeof name !== 'string') return name;
        const t = name.trim();
        if (!t) return t;
        const stripped = t.replace(/^guest_/i, '');
        return stripped || t;
    };

    const getVisitorListForSync = () => {
        const out = new Set();
        for (const v of lastUserMap.values()) {
            if (v == null || v === '') continue;
            const s = String(normalizeImvuUsername(String(v)))
                .trim()
                .toLowerCase();
            if (!s || EXCLUDED_HANDLES.includes(s)) continue;
            out.add(s);
        }
        return [...out].slice(0, 50);
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

        const visitors = getVisitorListForSync();
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
            console.log(`[ROOM] ${ROOM_NAME} (api)`);
        } else {
            const fromDom = await fetchRoomTitleFromDom();
            if (fromDom) {
                ROOM_NAME = fromDom;
                console.log(`[ROOM] ${ROOM_NAME} (dom)`);
            }
        }
        scheduleDashboardSync();
    };

    const collectBotMentionAliases = () => {
        const aliases = new Set();
        const add = (raw) => {
            if (raw == null || typeof raw !== 'string') return;
            const t = raw.trim();
            if (!t) return;
            aliases.add(t.toLowerCase());
            const norm = normalizeImvuUsername(t);
            if (norm && typeof norm === 'string') {
                aliases.add(norm.toLowerCase());
            }
        };
        add(BOT_USERNAME);
        add(BOT_DISPLAY_NAME);
        return [...aliases].filter((a) => a.length > 0);
    };

    const messageMentionsBot = (chatText) => {
        const text = typeof chatText === 'string' ? chatText : '';
        if (!text.trim()) return false;
        const lower = text.toLowerCase();
        for (const alias of collectBotMentionAliases()) {
            if (lower.includes(`@${alias}`)) return true;
            if (alias.includes(' ')) {
                if (lower.includes(alias)) return true;
                continue;
            }
            const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) return true;
        }
        return false;
    };

    const logConversationTurn = async (payload) => {
        try {
            await axios.post(`${API_BASE_URL}/api/conversations/append`, {
                room_id: String(roomId),
                ...payload,
            });
        } catch (_) {}
    };

    const sendMessage = async (text, convMeta = null) => {
        const sendInFrame = (frame) =>
            frame.evaluate((msg) => {
                const setNativeValue = (el, value) => {
                    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
                        const proto =
                            el instanceof HTMLTextAreaElement
                                ? HTMLTextAreaElement.prototype
                                : HTMLInputElement.prototype;
                        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
                        if (desc?.set) {
                            desc.set.call(el, value);
                            return;
                        }
                    }
                    if (el.isContentEditable) el.textContent = value;
                    else el.value = value;
                };

                const trySubmit = (el) => {
                    el.dispatchEvent(
                        new InputEvent('input', {
                            bubbles: true,
                            inputType: 'insertText',
                            data: msg,
                        })
                    );
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    const form = el.closest && el.closest('form');
                    if (form && typeof form.requestSubmit === 'function') {
                        try {
                            form.requestSubmit();
                        } catch (_) {}
                    }
                    const btn =
                        (form &&
                            form.querySelector(
                                'button[type="submit"], [type="submit"], button.primary'
                            )) ||
                        document.querySelector('button[type="submit"]');
                    if (btn) btn.click();
                    el.dispatchEvent(
                        new KeyboardEvent('keydown', {
                            key: 'Enter',
                            code: 'Enter',
                            keyCode: 13,
                            which: 13,
                            bubbles: true,
                        })
                    );
                };

                const candidates = [
                    ...document.querySelectorAll('textarea:not([readonly])'),
                    ...document.querySelectorAll('input[type="text"]:not([readonly])'),
                    ...document.querySelectorAll('[contenteditable="true"]'),
                    document.querySelector('input[type="text"]'),
                ].filter(Boolean);

                const visible = (el) => {
                    const r = el.getBoundingClientRect?.();
                    return r && r.width > 0 && r.height > 0;
                };

                for (const el of candidates) {
                    if (!el || el.disabled) continue;
                    if (!visible(el) && candidates.some((c) => c !== el && visible(c))) continue;
                    try {
                        el.focus();
                        setNativeValue(el, msg);
                        trySubmit(el);
                        return true;
                    } catch (_) {
                        /* try next */
                    }
                }
                return false;
            }, text);

        try {
            const frames = page.frames();
            let ok = false;
            for (const frame of frames) {
                try {
                    if (ok) break;
                    ok = await sendInFrame(frame);
                } catch (_) {
                    /* cross-origin or unloaded */
                }
            }
            if (ok) {
                const preview = text.length > 100 ? `${text.slice(0, 100)}…` : text;
                console.log(`[CHAT][BOT] sent: ${preview}`);
                if (convMeta?.participantUsername) {
                    void logConversationTurn({
                        username: convMeta.participantUsername,
                        imvu_avatar_id: convMeta.participantAvatarId ?? null,
                        role: 'assistant',
                        content: text,
                    });
                }
            } else {
                console.log(
                    '[CHAT][BOT] send failed: no chat input in any frame (check IMVU UI / shadow DOM)'
                );
            }
        } catch (e) {
            console.log('[CHAT][BOT] send error:', e?.message || e);
        }
    };

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

    let selfUserId = null;
    let botJoinedChat = false;
    /** After participants roster is known (or fallback), allow chat welcomes for true join_queue arrivals only */
    let welcomeArrivalsEnabled = false;
    let participantsRosterSynced = false;
    let welcomeArrivalsEnableTimer = null;

    const enableWelcomeForNewArrivals = () => {
        for (const aid of lastUserMap.keys()) {
            if (aid != null && aid !== undefined) {
                skipWelcomeAvatarIds.add(String(aid));
            }
        }
        welcomeArrivalsEnabled = true;
        if (welcomeArrivalsEnableTimer) {
            clearTimeout(welcomeArrivalsEnableTimer);
            welcomeArrivalsEnableTimer = null;
        }
    };

    const isSelfId = (id) =>
        id != null &&
        selfUserId != null &&
        String(id) === String(selfUserId);

    const announceJoinQueuePresence = (avatarId, label) => {
        if (!avatarId || isSelfId(avatarId)) return;
        const n = String(label ?? '').trim();
        if (!n) return;
        if (joinQueueBackendAnnounced.has(avatarId)) return;
        joinQueueBackendAnnounced.add(avatarId);
        void onJoin(normalizeImvuUsername(n) || n);
    };

    const welcomeHandleKey = (displayName) => {
        const h = String(normalizeImvuUsername(displayName) || '')
            .trim()
            .toLowerCase();
        if (!h || EXCLUDED_HANDLES.includes(h)) return null;
        return h;
    };

    /**
     * @returns {boolean} true if a welcome was scheduled (caller may call onJoin once)
     */
    const scheduleWelcomeForAvatar = (avatarId, displayName, convMeta) => {
        if (
            !avatarId ||
            !botJoinedChat ||
            !welcomeArrivalsEnabled ||
            isSelfId(avatarId) ||
            skipWelcomeAvatarIds.has(avatarId)
        ) {
            return false;
        }
        const handleKey = welcomeHandleKey(displayName);
        if (!handleKey) return false;
        if (
            welcomedAvatarIds.has(avatarId) ||
            welcomedHandlesLower.has(handleKey)
        ) {
            return false;
        }
        welcomedAvatarIds.add(avatarId);
        welcomedHandlesLower.add(handleKey);
        if (welcomedAvatarIds.size > 100) {
            welcomedAvatarIds.clear();
            welcomedHandlesLower.clear();
        }
        setTimeout(async () => {
            if (ROOM_NAME === 'this room') {
                await refreshRoomName();
            }
            sendMessage(getWelcomeMessage(displayName, ROOM_NAME), convMeta);
        }, 1500);
        return true;
    };

    const updateCount = () => {
        // Occupancy should reflect active avatar IDs even before name resolution.
        const phase = botJoinedChat ? 'AFTER_JOIN' : 'BEFORE_JOIN';
        console.log(`[COUNT][${phase}] 👥 Total Occupants: ${lastUserMap.size}`);
        scheduleDashboardSync();
    };

    let countTimer = null;
    const triggerCountUpdate = () => {
        clearTimeout(countTimer);
        countTimer = setTimeout(updateCount, 300);
    };


    const decodeId = (id) => {
        if (id == null || id === '') return null;
        const s = String(id);

        if (/^\d+$/.test(s)) return s;

        // IMVU often sends unpadded base64 user IDs (e.g. Mzc4MTA5MTI4 -> 378109128)
        if (/^[A-Za-z0-9+/]+$/.test(s) && s.length >= 4) {
            try {
                const padded = s.padEnd(Math.ceil(s.length / 4) * 4, '=');
                const decoded = Buffer.from(padded, 'base64').toString('utf-8');
                if (/^\d+$/.test(decoded)) return decoded;
            } catch { /* ignore */ }
        }

        if (typeof s === 'string' && s.length > 10 && s.includes('=')) {
            try {
                return Buffer.from(s, 'base64').toString('utf-8');
            } catch (e) { }
        }
        return s;
    };

    const isImvuRoomProtocolLine = (msg) => {
        const t = (msg || '').trim();
        return t.startsWith('*');
    };

    const chatVerbose = () =>
        process.env.CHAT_VERBOSE === '1' || process.env.CHAT_VERBOSE === 'true';

    const decodeChatEnvelope = (rawMessage) => {
        if (!rawMessage || typeof rawMessage !== 'string') return null;
        try {
            const padded = rawMessage.padEnd(Math.ceil(rawMessage.length / 4) * 4, '=');
            const decoded = Buffer.from(padded, 'base64').toString('utf-8');
            return JSON.parse(decoded);
        } catch {
            return null;
        }
    };

    const displayNameFromEnvelope = (env) => {
        if (!env || typeof env !== 'object') return null;
        const asLabel = (v) => {
            if (typeof v !== 'string') return null;
            const t = v.trim();
            if (!t || /^\d+$/.test(t)) return null;
            return t;
        };
        const candidates = [
            env.username,
            env.user_name,
            env.display_name,
            env.displayName,
            env.screen_name,
            env.screenName,
            env.name,
            env.from_user,
            env.fromUser,
            env.senderName,
            env.sender_username,
            env.avatar_name,
            env.avatarName,
        ];
        for (const v of candidates) {
            const n = asLabel(v);
            if (n) return n;
        }
        if (env.user && typeof env.user === 'object') {
            const u = env.user;
            const n = asLabel(
                u.username || u.display_name || u.displayName || u.name || u.screen_name
            );
            if (n) return n;
        }
        if (env.sender && typeof env.sender === 'object') {
            const s = env.sender;
            const n = asLabel(
                s.username || s.display_name || s.displayName || s.name
            );
            if (n) return n;
        }
        return null;
    };

    const imvuAvNameCache = new Map();
    const imvuAvNameInflight = new Map();

    /**
     * Resolve username from numeric id via IMVU user API (session cookies).
     * API: https://api.imvu.com/user/user-{id} → denormalized[…].data.username
     */
    const resolveImvuHandleFromNumericId = async (uid) => {
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
                        if (/^[\u2800\s\u2000-\u200D\uFEFF]+$/.test(t)) {
                            return false;
                        }
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
                        const entry =
                            (json.id && denorm[json.id]) ||
                            Object.values(denorm)[0];
                        const d = entry?.data;
                        if (!d) return null;
                        const u =
                            typeof d.username === 'string'
                                ? d.username.trim()
                                : '';
                        if (u) return u;
                        const dn =
                            typeof d.display_name === 'string'
                                ? d.display_name.trim()
                                : '';
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

    async function handleIncomingMessage(msg) {
        const actions = Array.isArray(msg) ? msg : [msg];

        for (const action of actions) {
            const record = action.record || '';
            const props = action.properties || {};
            const queue = action.queue || '';
            const mount = action.mount || '';

            if (record === 'msg_c2g_connect' && action.user_id) {
                selfUserId = decodeId(action.user_id);
            }

            // 1. Initial Room Load (Create Mount: participants)
            if (
                record === 'msg_g2c_create_mount' &&
                (mount === 'participants' || mount === 'edge:participants')
            ) {
                const participants =
                    props.items ||
                    props.participants ||
                    props.users ||
                    [];

                // ⚠️ If it's a PATCH update (type 2), DO NOT reset
                const isPatch = action.type === 2;

                if (!isPatch) {
                    lastUserMap.clear(); // only clear on full load
                    skipWelcomeAvatarIds.clear();
                    joinQueueBackendAnnounced.clear();
                }

                participants.forEach(p => {
                    const rawId = p.avatar_id || p.user_id || p.id;
                    const avatarId = decodeId(rawId);

                    if (p.state === 'removed') {
                        if (avatarId && lastUserMap.has(avatarId)) {
                            const username = lastUserMap.get(avatarId);
                            lastUserMap.delete(avatarId);
                            if (username && typeof onLeave === 'function') {
                                onLeave(username);
                            }
                        }
                        return;
                    }

                    const rawUser =
                        p.username ||
                        p.display_name ||
                        p.name ||
                        p.screen_name;
                    const username = normalizeImvuUsername(rawUser);

                    if (
                        avatarId &&
                        username &&
                        !EXCLUDED_HANDLES.includes(username.toLowerCase())
                    ) {
                        const existing = lastUserMap.get(avatarId);
                        const existingNorm =
                            existing != null
                                ? normalizeImvuUsername(String(existing))
                                : existing;

                        if (existingNorm && existingNorm === username) {
                            return;
                        }

                        lastUserMap.set(avatarId, username);
                        if (!existing || existing === null) {
                            if (avatarId) joinQueueBackendAnnounced.add(avatarId);
                            onJoin(username);
                        }
                    }
                });

                if (!isPatch) {
                    participants.forEach((p) => {
                        if (p.state === 'removed') return;
                        const rawId = p.avatar_id || p.user_id || p.id;
                        const aid = decodeId(rawId);
                        if (aid) skipWelcomeAvatarIds.add(aid);
                    });
                    participantsRosterSynced = true;
                    if (botJoinedChat) {
                        enableWelcomeForNewArrivals();
                    }
                }

                triggerCountUpdate();
            }

            // 2. User Joined (Joined Queue)
            else if (record === 'msg_g2c_joined_queue' && queue.startsWith('/chat/')) {
                const avatarId = decodeId(action.user_id);
                const hadUser = avatarId ? lastUserMap.has(avatarId) : false;

                if (avatarId && !lastUserMap.has(avatarId)) {
                    lastUserMap.set(avatarId, null);
                    console.log(
                        `[JOIN][QUEUE] ${isSelfId(avatarId) ? 'bot' : 'occupant'} · resolving https://api.imvu.com/user/user-${avatarId}`
                    );
                    if (/^\d+$/.test(String(avatarId))) {
                        void resolveImvuHandleFromNumericId(avatarId).then(
                            (name) => {
                                if (!name || !lastUserMap.has(avatarId)) {
                                    return;
                                }
                                const cur = lastUserMap.get(avatarId);
                                if (
                                    cur !== null &&
                                    cur !== undefined &&
                                    String(cur).trim() !== ''
                                ) {
                                    const labelEarly = isSelfId(avatarId)
                                        ? BOT_USERNAME
                                        : normalizeImvuUsername(
                                              String(cur)
                                          );
                                    announceJoinQueuePresence(
                                        avatarId,
                                        labelEarly
                                    );
                                    void scheduleWelcomeForAvatar(
                                        avatarId,
                                        labelEarly,
                                        {
                                            participantUsername: labelEarly,
                                            participantAvatarId:
                                                String(avatarId),
                                        }
                                    );
                                    triggerCountUpdate();
                                    return;
                                }

                                const label = isSelfId(avatarId)
                                    ? BOT_USERNAME
                                    : name;

                                lastUserMap.set(avatarId, label);
                                console.log(
                                    `[JOIN][QUEUE] ${label} · profile API`
                                );

                                announceJoinQueuePresence(avatarId, label);
                                void scheduleWelcomeForAvatar(avatarId, label, {
                                    participantUsername: label,
                                    participantAvatarId: String(avatarId),
                                });

                                triggerCountUpdate();
                            }
                        );
                    }
                } else if (
                    avatarId &&
                    lastUserMap.has(avatarId) &&
                    welcomeArrivalsEnabled &&
                    botJoinedChat &&
                    !isSelfId(avatarId) &&
                    !skipWelcomeAvatarIds.has(avatarId)
                ) {
                    const cur = lastUserMap.get(avatarId);
                    const hasResolved =
                        cur != null &&
                        cur !== undefined &&
                        String(cur).trim() !== '';
                    if (hasResolved) {
                        const label = normalizeImvuUsername(String(cur));
                        if (label && String(label).trim()) {
                            announceJoinQueuePresence(avatarId, label);
                            void scheduleWelcomeForAvatar(avatarId, label, {
                                participantUsername: label,
                                participantAvatarId: String(avatarId),
                            });
                        }
                        triggerCountUpdate();
                    } else if (/^\d+$/.test(String(avatarId))) {
                        console.log(
                            `[JOIN][QUEUE] occupant · resolving https://api.imvu.com/user/user-${avatarId}`
                        );
                        void resolveImvuHandleFromNumericId(avatarId).then(
                            (name) => {
                                if (!name || !lastUserMap.has(avatarId)) {
                                    return;
                                }
                                const inner = lastUserMap.get(avatarId);
                                if (
                                    inner != null &&
                                    inner !== undefined &&
                                    String(inner).trim() !== ''
                                ) {
                                    const label = normalizeImvuUsername(
                                        String(inner)
                                    );
                                    void scheduleWelcomeForAvatar(
                                        avatarId,
                                        label,
                                        {
                                            participantUsername: label,
                                            participantAvatarId:
                                                String(avatarId),
                                        }
                                    );
                                    triggerCountUpdate();
                                    return;
                                }
                                const label = name;
                                lastUserMap.set(avatarId, label);
                                console.log(
                                    `[JOIN][QUEUE] ${label} · profile API`
                                );
                                announceJoinQueuePresence(avatarId, label);
                                void scheduleWelcomeForAvatar(avatarId, label, {
                                    participantUsername: label,
                                    participantAvatarId: String(avatarId),
                                });
                                triggerCountUpdate();
                            }
                        );
                    }
                }

                if (avatarId && isSelfId(avatarId) && !botJoinedChat) {
                    const beforeJoinCount = hadUser ? lastUserMap.size : Math.max(lastUserMap.size - 1, 0);
                    const afterJoinCount = lastUserMap.size;
                    console.log(`[COUNT][BEFORE_JOIN] 👥 Total Occupants: ${beforeJoinCount}`);
                    console.log(`[COUNT][AFTER_JOIN] 👥 Total Occupants: ${afterJoinCount}`);
                    botJoinedChat = true;
                    if (participantsRosterSynced) {
                        enableWelcomeForNewArrivals();
                    } else {
                        if (welcomeArrivalsEnableTimer) {
                            clearTimeout(welcomeArrivalsEnableTimer);
                        }
                        welcomeArrivalsEnableTimer = setTimeout(() => {
                            welcomeArrivalsEnableTimer = null;
                            enableWelcomeForNewArrivals();
                        }, 12000);
                    }
                    void refreshRoomName();
                }

                triggerCountUpdate();
            }

            // 3. User Left (Left Queue)
            else if (record === 'msg_g2c_left_queue' || record === 'msg_g2c_user_exited') {
                const avatarId = decodeId(action.user_id || action.avatar_id);

                if (avatarId && lastUserMap.has(avatarId)) {
                    if (isSelfId(avatarId)) {
                        lastUserMap.delete(avatarId);
                        skipWelcomeAvatarIds.delete(avatarId);
                        welcomedAvatarIds.delete(avatarId);
                        joinQueueBackendAnnounced.delete(avatarId);
                        {
                            const k = welcomeHandleKey(BOT_USERNAME);
                            if (k) welcomedHandlesLower.delete(k);
                        }
                        triggerCountUpdate();
                        continue;
                    }
                    const username = lastUserMap.get(avatarId);
                    lastUserMap.delete(avatarId);
                    skipWelcomeAvatarIds.delete(avatarId);
                    welcomedAvatarIds.delete(avatarId);
                    joinQueueBackendAnnounced.delete(avatarId);
                    const hk = username
                        ? welcomeHandleKey(username)
                        : null;
                    if (hk) welcomedHandlesLower.delete(hk);
                    if (username) {
                        onLeave(username);
                    }
                    triggerCountUpdate();
                }
            }

            // 4. Read room chat messages from websocket frames
            else if (
                (record === 'msg_g2c_send_message' || record === 'msg_c2g_send_message') &&
                queue.startsWith('/chat/') &&
                mount === 'messages'
            ) {
                const envelope = decodeChatEnvelope(action.message);
                const envelopeName = normalizeImvuUsername(
                    displayNameFromEnvelope(envelope)
                );
                const rawSender =
                    action.user_id ??
                    envelope?.userId ??
                    envelope?.user_id ??
                    envelope?.userID;
                const senderId = decodeId(rawSender != null ? String(rawSender) : null);
                if (senderId && isSelfId(senderId)) {
                    lastUserMap.set(senderId, BOT_USERNAME);
                }
                const wireName = normalizeImvuUsername(
                    typeof action.username === 'string'
                        ? action.username.trim()
                        : typeof action.display_name === 'string'
                          ? action.display_name.trim()
                          : null
                );

                if (senderId && envelopeName) {
                    const cur = lastUserMap.get(senderId);
                    if (cur == null || cur === '') {
                        lastUserMap.set(senderId, envelopeName);
                    }
                }
                if (senderId && wireName && /^\d+$/.test(wireName) === false) {
                    const cur = lastUserMap.get(senderId);
                    if (cur == null || cur === '') {
                        lastUserMap.set(senderId, wireName);
                    }
                }

                const resolvedName = senderId
                    ? normalizeImvuUsername(lastUserMap.get(senderId))
                    : null;
                let senderLabel =
                    (resolvedName && String(resolvedName)) ||
                    envelopeName ||
                    (wireName && !/^\d+$/.test(wireName) ? wireName : null);
                if (!senderLabel) {
                    senderLabel = isSelfId(senderId) ? BOT_USERNAME : 'Guest';
                }
                if (
                    senderLabel === 'Guest' &&
                    senderId &&
                    /^\d+$/.test(String(senderId))
                ) {
                    const fromAv = await resolveImvuHandleFromNumericId(
                        senderId
                    );
                    if (fromAv) {
                        const label = isSelfId(senderId)
                            ? BOT_USERNAME
                            : normalizeImvuUsername(fromAv);
                        lastUserMap.set(senderId, label);
                        senderLabel = label;
                    }
                }
                if (isSelfId(senderId)) {
                    senderLabel = BOT_USERNAME;
                }
                const text =
                    envelope?.message ||
                    envelope?.text ||
                    envelope?.body ||
                    envelope?.chat_message;
                if (typeof text === 'string' && text.trim()) {
                    if (!chatVerbose() && isImvuRoomProtocolLine(text)) return;
                    const direction =
                        record === 'msg_c2g_send_message' ? 'OUT' : 'IN';
                    const trimmed = text.trim();
                    console.log(`[CHAT][${direction}] ${senderLabel}: ${trimmed}`);
                    const avatarForLog =
                        senderId && /^\d+$/.test(String(senderId))
                            ? String(senderId)
                            : null;
                    void logConversationTurn({
                        username: senderLabel,
                        imvu_avatar_id: avatarForLog,
                        role: direction === 'OUT' ? 'assistant' : 'user',
                        content: trimmed,
                    });

                    if (
                        direction === 'IN' &&
                        senderId != null &&
                        !isSelfId(senderId) &&
                        (messageInvokesSivaCharacterAi(trimmed) ||
                            messageMentionsBot(trimmed))
                    ) {
                        const dedupeKey = `${roomId}:${senderId}:${trimmed}`;
                        if (!mentionReplyDedupe.has(dedupeKey)) {
                            mentionReplyDedupe.add(dedupeKey);
                            if (mentionReplyDedupe.size > MENTION_REPLY_DEDUPE_CAP) {
                                const first = mentionReplyDedupe
                                    .values()
                                    .next().value;
                                mentionReplyDedupe.delete(first);
                            }
                            const sivaHit = messageInvokesSivaCharacterAi(trimmed);
                            void (async () => {
                                try {
                                    const res = sivaHit
                                        ? await axios.post(
                                              `${API_BASE_URL}/api/siva-chat`,
                                              {
                                                  message:
                                                      stripSivaCharacterAiTriggers(
                                                          trimmed
                                                      ) || trimmed,
                                                  username: senderLabel,
                                                  room_id: String(roomId),
                                                  imvu_avatar_id: avatarForLog,
                                                  already_logged_user_message:
                                                      true,
                                              }
                                          )
                                        : await axios.post(
                                              `${API_BASE_URL}/api/lurk`,
                                              {
                                                  message: trimmed,
                                                  username: senderLabel,
                                                  room_id: String(roomId),
                                                  imvu_avatar_id: avatarForLog,
                                                  bot_username: BOT_USERNAME,
                                                  bot_display_name:
                                                      BOT_DISPLAY_NAME &&
                                                      BOT_DISPLAY_NAME.toLowerCase() !==
                                                          BOT_USERNAME.toLowerCase()
                                                          ? BOT_DISPLAY_NAME
                                                          : undefined,
                                                  already_logged_user_message:
                                                      true,
                                              }
                                          );
                                    const reply = res.data?.reply;
                                    if (
                                        reply &&
                                        typeof reply === 'string' &&
                                        reply.trim()
                                    ) {
                                        await sendMessage(reply.trim(), {
                                            participantUsername: senderLabel,
                                            participantAvatarId:
                                                avatarForLog ?? undefined,
                                        });
                                    }
                                } catch {
                                    /* ignore */
                                }
                            })();
                        }
                    }
                }
            }

            // 5. Resolve Real Username (Mount: node for user or profile inventory)
            else if (
                record === 'msg_g2c_create_mount' &&
                (queue.includes('inv:/user/user-') || queue.includes('inv:/profile/user-')) &&
                mount === 'node'
            ) {
                const userIdPart = queue.split('user-')[1] || '';
                const userId = decodeId(userIdPart.split('/')[0]);
                const data = props || {};

                const realName = data.username || data.user_name || data.display_name || data.screen_name;

                if (userId && realName && lastUserMap.has(userId)) {
                    const existing = lastUserMap.get(userId);
                    const displayName = isSelfId(userId)
                        ? BOT_USERNAME
                        : normalizeImvuUsername(realName);

                    if (existing === displayName) return;

                    lastUserMap.set(userId, displayName);

                    if (!existing || existing === null) {
                        onJoin(displayName);
                    } else {
                        console.log(`[UPDATE] ${existing} → ${displayName}`);
                    }

                    triggerCountUpdate();
                }
            }
        }
    }

    setInterval(() => {
        if (botJoinedChat) {
            scheduleDashboardSync();
        }
    }, 45000);

    globalMessageHandler = (data) => {
        void handleIncomingMessage(data);
    };

    // Helper: Static fallback check using DOM once (still runs in browser)
    const runDOMFallback = async () => {
        try {
            const domUsers = await page.evaluate(() => {
                const results = [];
                const links = document.querySelectorAll('a[href*="/next/av/"]');
                links.forEach(l => {
                    const parts = l.href.split('/next/av/')[1].split('/');
                    if (parts[0]) results.push(parts[0]);
                });
                return Array.from(new Set(results));
            });

            if (lastUserMap.size === 0 && domUsers.length > 0) {
                console.log(`[CDP-WS] 🛡️ DOM Baseline: ${domUsers.length} users`);
                domUsers.forEach(name => {
                    if (!Array.from(lastUserMap.values()).some(n => n.toLowerCase() === name.toLowerCase())) {
                        const dummyId = `dom_${name.toLowerCase()}`;
                        lastUserMap.set(dummyId, name);
                    }
                });
                triggerCountUpdate();
            }
        } catch (e) {}
    };

    setTimeout(runDOMFallback, 5000);
}
