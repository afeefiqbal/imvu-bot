import { EventEmitter } from 'events';
import WebSocket from 'ws';
import {
    roomQueueBelongsToRoom,
    isImvuRoomChatQueue,
    isEphemeralLegacyChatQueue,
    narrowChatFrameTargets,
} from '../user-tracker-utils.js';

function parseFrame(raw) {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function envInt(key, fallback) {
    const value = parseInt(process.env[key] || '', 10);
    return Number.isFinite(value) ? value : fallback;
}

function normalizeRoomId(roomId) {
    return String(roomId || '').trim().replace(/^room-/i, '');
}

function frameOpId(frame) {
    if (!frame || typeof frame !== 'object') return null;
    const opId = Number(frame.op_id);
    return Number.isFinite(opId) ? opId : null;
}

function serializeFrame(frame) {
    return typeof frame === 'string' || Buffer.isBuffer(frame) ? frame : JSON.stringify(frame);
}

function rewriteSubscriptionOpIds(frameText, allocateOpId) {
    let parsed;
    try {
        parsed = JSON.parse(String(frameText));
    } catch {
        return { frame: frameText, opIds: [] };
    }

    const opIds = [];
    const rewrite = (value) => {
        if (Array.isArray(value)) {
            for (const item of value) rewrite(item);
            return;
        }
        if (!value || typeof value !== 'object') return;
        if (value.record === 'subscription' && Object.prototype.hasOwnProperty.call(value, 'op_id')) {
            value.op_id = allocateOpId();
            opIds.push(value.op_id);
        }
        for (const child of Object.values(value)) rewrite(child);
    };

    rewrite(parsed);
    return { frame: serializeFrame(parsed), opIds };
}

function extractFrameOpIds(frameText) {
    let parsed;
    try {
        parsed = JSON.parse(String(frameText));
    } catch {
        return [];
    }
    const frames = Array.isArray(parsed) ? parsed : [parsed];
    return frames.map(frameOpId).filter((opId) => opId != null);
}

const SOCIAL_HINT_MOUNTS = new Set([
    'web_msg',
    'edge:inbound_friend_requests',
    'edge:conversations',
    'edge:messages',
    'edge:activity',
    'edge:friends',
    'edge:invites',
]);

function decodeImqPayload(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    try {
        return Buffer.from(text, 'base64').toString('utf8');
    } catch {
        return text;
    }
}

function classifySocialHint(mount, decoded) {
    const m = String(mount || '');
    const body = String(decoded || '');
    if (m === 'web_msg') {
        if (/^fanRequests\b/i.test(body)) return 'friend_request';
        if (/^chatInvite\b/i.test(body)) return 'invite';
        if (/^messageReceived\b/i.test(body)) return 'dm';
        return 'web_msg';
    }
    if (m === 'edge:inbound_friend_requests' || m === 'edge:friends') return 'friend_request';
    if (m === 'edge:invites') return 'invite';
    if (m === 'edge:conversations' || m === 'edge:messages') return 'dm';
    if (m === 'edge:activity') return 'activity';
    return 'social';
}

function roomIdFromInviteLocation(location) {
    if (!location || typeof location !== 'object') return '';
    for (const key of ['room_id', 'roomId', 'id', 'slug']) {
        const raw = String(location[key] || '')
            .trim()
            .replace(/^room-/i, '');
        if (/^\d+-\d+$/.test(raw)) return raw;
    }
    for (const key of ['url', 'imageUrl', 'image_url']) {
        const match = String(location[key] || '').match(/(\d+-\d+)/);
        if (match) return match[1];
    }
    return '';
}

/** Parse edge JSON / web_msg bodies for friend-request / invite action + ids. */
function parseSocialEdgePayload(mount, decoded) {
    const m = String(mount || '');
    const body = String(decoded || '').trim();
    const out = {
        action: '',
        userIds: [],
        objects: [],
        roomId: '',
        inviteId: '',
        inviterName: '',
        chatId: '',
    };
    if (!body) return out;

    const pushPeerId = (id) => {
        const peer = String(id || '').trim();
        if (/^\d+$/.test(peer)) out.userIds.push(peer);
    };

    // web_msg: fanRequests {"add":[261755692],"time":...}
    const fanMatch = body.match(/^fanRequests\s+(\{[\s\S]*\})\s*$/i);
    if (fanMatch) {
        try {
            const payload = JSON.parse(fanMatch[1]);
            const add = Array.isArray(payload?.add) ? payload.add : [];
            for (const id of add) pushPeerId(id);
            out.action = out.userIds.length ? 'created' : '';
            out.userIds = [...new Set(out.userIds)];
            return out;
        } catch {
            /* fall through */
        }
    }

    // web_msg: messageReceived {"from":261755692,"time":...}
    const messageReceivedMatch = body.match(/^messageReceived\s+(\{[\s\S]*\})\s*$/i);
    if (messageReceivedMatch) {
        try {
            const payload = JSON.parse(messageReceivedMatch[1]);
            out.action = 'message';
            pushPeerId(payload?.from || payload?.sender || payload?.userId || payload?.user_id);
            out.userIds = [...new Set(out.userIds)];
            return out;
        } catch {
            /* fall through */
        }
    }

    // web_msg: chatInvite {"inviteId":…,"chatId":…,"partnerId":…,"location":{…},"inviter":{…}}
    const chatInviteMatch = body.match(/^chatInvite\s+(\{[\s\S]*\})\s*$/i);
    if (chatInviteMatch) {
        try {
            const payload = JSON.parse(chatInviteMatch[1]);
            out.action = 'created';
            out.inviteId = String(payload?.inviteId || payload?.invite_id || '').trim();
            out.chatId = String(payload?.chatId || payload?.chat_id || '').trim();
            out.roomId = roomIdFromInviteLocation(payload?.location);
            out.inviterName = String(payload?.inviter?.name || payload?.inviter?.display_name || '').trim();
            pushPeerId(payload?.partnerId || payload?.partner_id);
            out.userIds = [...new Set(out.userIds)];
            return out;
        } catch {
            /* fall through */
        }
    }

    if (body.startsWith('{') || body.startsWith('[')) {
        try {
            const parsed = JSON.parse(body);
            const payload = Array.isArray(parsed) ? parsed[0] : parsed;
            if (payload && typeof payload === 'object') {
                out.action = String(payload.action || '').toLowerCase();
                const objects = Array.isArray(payload.objects) ? payload.objects : [];
                out.objects = objects.map((o) => String(o || ''));
                for (const obj of out.objects) {
                    const inbound = obj.match(/\/inbound_friend_requests\/user-(\d+)/i);
                    if (inbound) {
                        pushPeerId(inbound[1]);
                        continue;
                    }
                    const friend = obj.match(/\/friends\/user-(\d+)/i);
                    if (friend) {
                        pushPeerId(friend[1]);
                        continue;
                    }
                    const invite = obj.match(/\/invites\/invite-(\d+)/i);
                    if (invite) {
                        out.inviteId = invite[1];
                        continue;
                    }
                    // Prefer the last user- id in the path (peer), not the bot owner segment.
                    const all = [...obj.matchAll(/\/user-(\d+)/gi)];
                    if (all.length) pushPeerId(all[all.length - 1][1]);
                }
            }
        } catch {
            /* fall through */
        }
    }

    if (!out.userIds.length) {
        const inbound = [...body.matchAll(/inbound_friend_requests\/user-(\d+)/gi)];
        const friends = [...body.matchAll(/friends\/user-(\d+)/gi)];
        for (const match of inbound.length ? inbound : friends) {
            pushPeerId(match[1]);
        }
    }

    if (!out.inviteId) {
        const inviteMatch = body.match(/\/invites\/invite-(\d+)/i);
        if (inviteMatch) out.inviteId = inviteMatch[1];
    }

    out.userIds = [...new Set(out.userIds)];

    if (!out.action) {
        if (m === 'edge:inbound_friend_requests' || m === 'edge:friends' || m === 'edge:invites') {
            out.action = 'created';
        }
    }

    return out;
}

export class ImvuAccountWebSocketClient extends EventEmitter {
    constructor({ spec, session, agents = {}, logger = console, bot = {} }) {
        super();
        this.spec = spec;
        this.session = session;
        this.agents = agents;
        this.logger = logger;
        this.bot = bot;
        this.ws = null;
        this.rooms = new Map();
        this.opOwners = new Map();
        this.closedByUser = false;
        this.connecting = null;
        this.connectedOnce = false;
        this.reconnectAttempt = 0;
        this.nextRuntimeOpId = Number(process.env.IMVU_WS_RUNTIME_OP_ID_START || 45);
        this.pingTimer = null;
        this.lastConnectRoomId = '';
        this.socialSyncEnabled = false;
        this.socialFloodgatesOpened = false;
        this.socialSubscribeInFlight = false;
        this.socialSubscribedQueues = new Set();
        this.socialOpIds = new Set();
    }

    get isOpen() {
        return this.ws?.readyState === WebSocket.OPEN;
    }

    get #keepAlive() {
        return this.rooms.size > 0 || this.socialSyncEnabled;
    }

    #botUserId() {
        return String(this.bot.imqUserId || this.bot.user_id || this.bot.userId || '').trim();
    }

    #socialQueueNames() {
        const userId = this.#botUserId();
        if (!/^\d+$/.test(userId)) return [];
        return [`priv:/user/user-${userId}`, `/user/${userId}`, `inv:/user/user-${userId}`, `inv:/profile/${userId}`];
    }

    #isOurSocialQueue(queue) {
        const q = String(queue || '');
        if (!q) return false;
        if (this.socialSubscribedQueues.has(q)) return true;
        return this.#socialQueueNames().includes(q);
    }

    /**
     * Subscribe to account-level IMQ queues for friend requests / DMs / activity.
     * Safe to call before or after the socket is open; re-subscribes on reconnect.
     */
    setSocialSyncEnabled(enabled) {
        this.socialSyncEnabled = Boolean(enabled);
        if (this.socialSyncEnabled && this.isOpen) {
            void this.#subscribeSocialQueues();
        }
        return this.socialSyncEnabled;
    }

    createRoomClient(roomId, options = {}) {
        const id = normalizeRoomId(roomId);
        if (this.rooms.has(id)) return this.rooms.get(id);
        const room = new ImvuAccountRoomClient({
            account: this,
            roomId: id,
            visibilityEnabled: options.visibilityEnabled !== false,
        });
        this.rooms.set(id, room);
        return room;
    }

    allocateOpId(room) {
        const opId = this.nextRuntimeOpId++;
        if (room) this.opOwners.set(opId, room);
        return opId;
    }

    registerOpIds(room, opIds) {
        for (const opId of opIds || []) {
            if (opId != null) this.opOwners.set(Number(opId), room);
        }
    }

    async connect(roomId = '') {
        if (this.connecting) return this.connecting;
        if (this.isOpen) return true;
        this.closedByUser = false;
        this.lastConnectRoomId = normalizeRoomId(roomId) || this.lastConnectRoomId;
        this.connecting = this.#connectOnce(this.lastConnectRoomId).finally(() => {
            this.connecting = null;
        });
        return this.connecting;
    }

    async #connectOnce(roomId) {
        const missing = this.spec.describeMissing();
        if (missing.length) {
            throw new Error(`Missing IMVU WebSocket protocol config: ${missing.join(', ')}`);
        }

        await this.session.ensureLoggedIn();
        const url = this.spec.urlFor(roomId);
        const headers = {
            Origin: process.env.IMVU_WS_ORIGIN || 'https://www.imvu.com',
            ...this.spec.headersFor(roomId),
        };
        const cookie = await this.session.cookieHeader(headers.Origin);
        if (cookie) headers.Cookie = cookie;

        const safeUrl = url.replace(/([?&](?:token|auth|session)=)[^&]+/gi, '$1***');
        this.logger.log(`[IMVU-ACCOUNT-WS] connecting ${safeUrl}`);

        await new Promise((resolve, reject) => {
            const ws = new WebSocket(url, {
                headers,
                handshakeTimeout: Number(process.env.IMVU_WS_HANDSHAKE_TIMEOUT_MS || 30000),
                perMessageDeflate: false,
                ...this.agents.websocket,
            });
            this.ws = ws;

            const onOpen = () => {
                ws.off('error', onErrorBeforeOpen);
                this.reconnectAttempt = 0;
                this.connectedOnce = true;
                this.#wireSocket(ws);
                this.logger.log('[IMVU-ACCOUNT-WS] open');
                this.#resetSocialSubscriptions();
                this.#sendAccountFrames(this.spec.connectFramesFor(roomId), 'connect');
                this.#startPing(roomId);
                this.emit('open');
                void this.#subscribeSocialQueues();
                for (const room of this.rooms.values()) {
                    room._handleAccountOpen();
                }
                resolve(true);
            };
            const onErrorBeforeOpen = (error) => {
                ws.off('open', onOpen);
                reject(error);
            };

            ws.once('open', onOpen);
            ws.once('error', onErrorBeforeOpen);
        });
    }

    #wireSocket(ws) {
        ws.on('message', (raw) => {
            const frame = parseFrame(raw);
            if (frame == null) return;
            if (process.env.WS_DEBUG === '1' || process.env.WS_DEBUG === 'true') {
                const actions = Array.isArray(frame) ? frame : [frame];
                const verbose =
                    process.env.WS_DEBUG_VERBOSE === '1' ||
                    process.env.WS_DEBUG_VERBOSE === 'true';
                const line = typeof frame === 'string' ? frame : JSON.stringify(frame);
                const onlyPong =
                    actions.length > 0 &&
                    actions.every((a) => a && typeof a === 'object' && a.record === 'msg_g2c_pong');
                if (!onlyPong || verbose) {
                    this.logger.log(`[IMVU-ACCOUNT-WS][recv] ${line.slice(0, 800)}`);
                }
            }
            this.emit('raw', frame);
            const actions = Array.isArray(frame) ? frame : [frame];
            for (const action of actions) {
                this.#routeAction(action);
            }
        });

        ws.on('error', (error) => {
            this.emit('error', error);
            for (const room of this.rooms.values()) room.emit('error', error);
        });

        ws.on('close', (code, reason) => {
            this.#stopPing();
            const reasonText = reason?.toString?.() || '';
            this.logger.warn(`[IMVU-ACCOUNT-WS] close code=${code} reason=${reasonText || '(none)'}`);
            this.emit('close', code, reasonText);
            for (const room of this.rooms.values()) {
                room._resetForReconnect();
                room.emit('close', code, reasonText);
            }
            if (!this.closedByUser && this.#keepAlive) {
                void this.#scheduleReconnect(code, reason);
            }
        });
    }

    #resetSocialSubscriptions() {
        this.socialFloodgatesOpened = false;
        this.socialSubscribeInFlight = false;
        this.socialSubscribedQueues.clear();
        this.socialOpIds.clear();
    }

    async #subscribeSocialQueues() {
        if (!this.socialSyncEnabled || !this.isOpen || this.socialSubscribeInFlight) return;
        const queues = this.#socialQueueNames();
        if (!queues.length) {
            this.logger.warn('[IMVU-ACCOUNT-WS][social] missing bot user id; cannot subscribe');
            return;
        }

        this.socialSubscribeInFlight = true;
        try {
            const joinDelayMs = Math.max(0, Number(process.env.IMVU_WS_POST_CONNECT_DELAY_MS || 350));
            if (joinDelayMs) await delay(joinDelayMs);
            if (!this.socialSyncEnabled || !this.isOpen) return;

            if (!this.socialFloodgatesOpened) {
                this.sendRaw(JSON.stringify({ record: 'msg_c2g_open_floodgates' }));
                this.socialFloodgatesOpened = true;
                if (process.env.WS_DEBUG === '1' || process.env.WS_DEBUG === 'true') {
                    this.logger.log('[IMVU-ACCOUNT-WS][social] open_floodgates');
                }
            }

            for (const name of queues) {
                if (!this.isOpen || !this.socialSyncEnabled) return;
                if (this.socialSubscribedQueues.has(name)) continue;
                const opId = this.allocateOpId(null);
                this.socialOpIds.add(opId);
                const frame = JSON.stringify({
                    record: 'msg_c2g_subscribe',
                    queues_with_results: [
                        {
                            record: 'subscription',
                            name,
                            op_id: opId,
                        },
                    ],
                });
                this.sendRaw(frame);
                this.socialSubscribedQueues.add(name);
                this.logger.log(`[IMVU-ACCOUNT-WS][social] subscribe ${name}`);
            }
        } catch (error) {
            this.logger.warn(
                `[IMVU-ACCOUNT-WS][social] subscribe failed: ${error?.message || error}`
            );
        } finally {
            this.socialSubscribeInFlight = false;
        }
    }

    #handleSocialAction(action) {
        if (!this.socialSyncEnabled || !action || typeof action !== 'object') return false;

        const record = String(action.record || '');
        const queue = String(action.queue || '');
        const opId = frameOpId(action);

        if (record === 'msg_g2c_result' && opId != null && this.socialOpIds.has(opId)) {
            this.socialOpIds.delete(opId);
            if (action.status !== 0) {
                this.logger.warn(
                    `[IMVU-ACCOUNT-WS][social] subscribe result op=${opId} status=${action.status}` +
                        (action.error_message ? ` ${action.error_message}` : '')
                );
            }
            return true;
        }

        if (!this.#isOurSocialQueue(queue)) return false;

        if (record === 'msg_g2c_joined_queue') {
            this.logger.log(`[IMVU-ACCOUNT-WS][social] joined ${queue}`);
            return true;
        }
        if (record === 'msg_g2c_create_mount') {
            return true;
        }
        if (record === 'msg_g2c_left_queue') {
            this.socialSubscribedQueues.delete(queue);
            this.logger.warn(`[IMVU-ACCOUNT-WS][social] left ${queue}; will resubscribe`);
            void this.#subscribeSocialQueues();
            return true;
        }

        if (record !== 'msg_g2c_send_message' && record !== 'msg_c2g_send_message') {
            return true;
        }

        const mount = String(action.mount || '');
        if (!SOCIAL_HINT_MOUNTS.has(mount)) return true;

        const decoded = decodeImqPayload(action.message);
        const kind = classifySocialHint(mount, decoded);
        const edge = parseSocialEdgePayload(mount, decoded);
        this.emit('social', {
            kind,
            queue,
            mount,
            decoded: decoded.slice(0, 300),
            action: edge.action,
            userIds: edge.userIds,
            objects: edge.objects,
            roomId: edge.roomId || '',
            inviteId: edge.inviteId || '',
            inviterName: edge.inviterName || '',
            chatId: edge.chatId || '',
            rawAction: action,
        });
        return true;
    }

    #routeAction(action) {
        if (!action || typeof action !== 'object') return;
        const opId = frameOpId(action);
        const owner = opId != null ? this.opOwners.get(opId) : null;
        if (owner) {
            if (action.record === 'msg_g2c_result') this.opOwners.delete(opId);
            owner._handleFrame(action);
            return;
        }

        if (this.#handleSocialAction(action)) return;

        const queue = String(action.queue || '');
        const isChatMsg =
            action.record === 'msg_g2c_send_message' || action.record === 'msg_c2g_send_message';
        let targets = [];
        if (queue) {
            for (const room of this.rooms.values()) {
                if (room._ownsQueue(queue)) targets.push(room);
            }
        }

        if (isChatMsg && targets.length > 1) {
            targets = narrowChatFrameTargets(queue, targets);
        }

        if (targets.length > 0) {
            for (const room of targets) {
                room._handleFrame(action);
            }
            return;
        }

        if (isChatMsg) {
            return;
        }

        for (const room of this.rooms.values()) {
            room._handleFrame(action);
        }
    }

    async #scheduleReconnect(code, reason) {
        this.reconnectAttempt += 1;
        const max = Number(process.env.IMVU_WS_MAX_RECONNECTS || 0);
        if (max > 0 && this.reconnectAttempt > max) {
            const error = new Error(`WebSocket closed ${code}; reconnect limit reached`);
            this.emit('fatal', error);
            for (const room of this.rooms.values()) room.emit('fatal', error);
            return;
        }

        const baseMs = Number(process.env.IMVU_WS_RECONNECT_BASE_MS || 2000);
        const capMs = Number(process.env.IMVU_WS_RECONNECT_CAP_MS || 60000);
        const waitMs = Math.min(capMs, baseMs * Math.max(1, this.reconnectAttempt));
        this.logger.warn(
            `[IMVU-ACCOUNT-WS] closed ${code} ${reason?.toString?.() || ''}; reconnecting in ${waitMs}ms`
        );
        await delay(waitMs);
        if (this.closedByUser || !this.#keepAlive) return;
        try {
            await this.connect(this.lastConnectRoomId);
        } catch (error) {
            this.emit('error', error);
            for (const room of this.rooms.values()) room.emit('error', error);
            void this.#scheduleReconnect(0, error.message);
        }
    }

    #sendAccountFrames(frames, label) {
        for (const frame of frames) {
            this.sendRaw(frame);
            if (process.env.WS_DEBUG === '1' || process.env.WS_DEBUG === 'true') {
                this.logger.log(`[IMVU-ACCOUNT-WS][${label}] ${String(frame).slice(0, 800)}`);
            }
        }
    }

    sendRoomFrame(room, frame, label, { rewriteSubscriptionOps = false } = {}) {
        let frameToSend = frame;
        let opIds = extractFrameOpIds(frameToSend);
        if (rewriteSubscriptionOps) {
            const rewritten = rewriteSubscriptionOpIds(frameToSend, () => this.allocateOpId(room));
            frameToSend = rewritten.frame;
            opIds = rewritten.opIds.length ? rewritten.opIds : opIds;
        }
        this.registerOpIds(room, opIds);
        this.sendRaw(frameToSend);
        if (process.env.WS_DEBUG === '1' || process.env.WS_DEBUG === 'true') {
            this.logger.log(`[IMVU-WS][${room.roomId}][${label}] ${String(frameToSend).slice(0, 800)}`);
        }
    }

    sendRaw(frame) {
        if (!this.isOpen) {
            throw new Error('IMVU account WebSocket is not open.');
        }
        this.ws.send(frame);
    }

    unregisterRoom(room) {
        this.rooms.delete(room.roomId);
        for (const [opId, owner] of [...this.opOwners.entries()]) {
            if (owner === room) this.opOwners.delete(opId);
        }
        // Keep the account websocket open with zero rooms so DM !join invites and friend accepts still work.
    }

    #startPing(roomId) {
        this.#stopPing();
        const intervalMs = Number(process.env.IMVU_WS_PING_INTERVAL_MS || 0);
        if (!intervalMs) return;
        this.pingTimer = setInterval(() => {
            if (!this.isOpen) return;
            const frame = this.spec.pingFrameFor(roomId);
            if (frame) this.sendRaw(frame);
            else {
                try {
                    this.ws.ping();
                } catch {}
            }
        }, intervalMs);
    }

    #stopPing() {
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = null;
    }

    /** Close the shared account socket so the normal reconnect path re-auths IMQ. */
    requestReconnect(reason = 'manual') {
        if (this.closedByUser) return false;
        if (!this.ws || this.ws.readyState >= WebSocket.CLOSING) return false;
        const text = String(reason || 'manual').slice(0, 100);
        this.logger.warn(`[IMVU-ACCOUNT-WS] reconnect requested (${text})`);
        try {
            this.ws.close(4000, text);
            return true;
        } catch {
            return false;
        }
    }

    close() {
        this.closedByUser = true;
        this.#stopPing();
        if (this.ws && this.ws.readyState < WebSocket.CLOSING) {
            this.ws.close(1000, 'client closed');
        }
    }
}

export class ImvuAccountRoomClient extends EventEmitter {
    constructor({ account, roomId, visibilityEnabled = true }) {
        super();
        this.account = account;
        this.roomId = normalizeRoomId(roomId);
        this.spec = account.spec;
        this.session = account.session;
        this.logger = account.logger;
        this.bot = account.bot;
        this.visibilityEnabled = visibilityEnabled;
        this.chatQueue = '';
        this.legacyChatSubscribed = false;
        this.legacyChatOpId = null;
        this.visibilityBootstrapped = false;
        this.participant = null;
        this.legacyOutfitMessage = '';
        this.legacySeatMessage = '';
        this.seatNumber = '';
        this.seatFurniId = 0;
        this.testMessageSent = false;
        this.joined = false;
        this.closedByUser = false;
        this.discoveringLegacyChat = false;
        this.participantReady = false;
        this.visibilityBootstrapPending = false;
        this.unknownUserRepairInFlight = false;
        this.unknownUserRepairCooldownUntil = 0;
        this.unknownUserRepairFailures = 0;
        this.unknownUserRepairBackoffMs = Math.max(
            1000,
            envInt('IMVU_UNKNOWN_USER_REPAIR_COOLDOWN_MS', 5000)
        );
        this.visibleRetryTimer = null;
        this.visibleHeartbeatTimer = null;
        this.forceVisibleRefreshTimer = null;
        this.forceVisibleRefreshRunning = false;
        this.lastEnsureVisibleAt = 0;
        this.lastParticipantEnsureOkAt = 0;
        this.mediaPlayerQueue = '';
        this.mediaPlayerSubscribed = false;
        this.liveRoom = false;
        this.liveContext = null;
        this.audienceMessageMount = '';
        this.hangoutQueue = '';
        this.liveChatId = '';
        this.liveSubscribeOpId = null;
    }

    /** True while WS/visibility repair is running — ignore transient "left room" signals. */
    get presenceRepairInFlight() {
        return (
            this.unknownUserRepairInFlight ||
            this.visibilityBootstrapPending ||
            this.discoveringLegacyChat
        );
    }

    get isOpen() {
        return this.account.isOpen;
    }

    async connect() {
        this.closedByUser = false;
        await this.account.connect(this.roomId);
        await this.#joinIfNeeded();
        return true;
    }

    _handleAccountOpen() {
        this._resetForReconnect();
        if (!this.closedByUser) {
            void this.#joinIfNeeded().catch((error) => this.emit('error', error));
        }
    }

    _resetForReconnect() {
        this.chatQueue = '';
        this.legacyChatSubscribed = false;
        this.legacyChatOpId = null;
        this.visibilityBootstrapped = false;
        this.liveRoom = false;
        this.liveContext = null;
        this.audienceMessageMount = '';
        this.hangoutQueue = '';
        this.liveChatId = '';
        this.liveSubscribeOpId = null;
        this.visibilityBootstrapPending = false;
        this.testMessageSent = false;
        this.joined = false;
        this.discoveringLegacyChat = false;
        this.participantReady = false;
        this.unknownUserRepairInFlight = false;
        this.unknownUserRepairFailures = 0;
        this.unknownUserRepairCooldownUntil = 0;
        if (this.visibleRetryTimer) clearTimeout(this.visibleRetryTimer);
        this.visibleRetryTimer = null;
        this.#stopVisibilityHeartbeat();
        this.#stopForceVisibleRefresh();
        this.mediaPlayerQueue = '';
        this.mediaPlayerSubscribed = false;
    }

    _ownsQueue(queue) {
        const q = String(queue || '');
        if (!q) return false;
        if (this.mediaPlayerQueue && q === this.mediaPlayerQueue) return true;
        if (this.chatQueue && q === this.chatQueue) return true;
        if (this.hangoutQueue && q === this.hangoutQueue) return true;
        if (this.chatQueue && isImvuRoomChatQueue(q) && q !== this.chatQueue) {
            return roomQueueBelongsToRoom(q, this.roomId, { knownChatQueue: this.chatQueue });
        }
        if (q.startsWith('/chat/') || q.startsWith('/exp/') || isImvuRoomChatQueue(q)) {
            return roomQueueBelongsToRoom(q, this.roomId, { knownChatQueue: this.chatQueue });
        }
        if (q.includes(this.roomId)) return true;
        return roomQueueBelongsToRoom(q, this.roomId, { knownChatQueue: this.chatQueue });
    }

    _handleFrame(action) {
        this.#learnFromFrame(action);
        this.emit('frame', action);
    }

    async #joinIfNeeded() {
        if (this.joined || !this.isOpen) return;
        const joinDelayMs = Math.max(0, Number(process.env.IMVU_WS_POST_CONNECT_DELAY_MS || 350));
        if (joinDelayMs) await delay(joinDelayMs);
        if (this.joined || !this.isOpen) return;
        this.joined = true;
        this.#sendFrames(this.spec.joinFramesFor(this.roomId), 'join', { rewriteSubscriptionOps: true });
        this.emit('open');
        if (this.visibilityEnabled) {
            this.#scheduleForceVisibleRefresh();
            void this.#discoverRoomChat();
        }
    }

    #sendFrames(frames, label, options = {}) {
        for (const frame of frames) {
            this.account.sendRoomFrame(this, frame, label, options);
        }
    }

    #learnFromFrame(action) {
        if (!action || typeof action !== 'object') return;
        const queue = String(action.queue || '');
        const userId = String(this.bot.imqUserId || this.bot.user_id || this.bot.userId || '').trim();
        if (
            action.record === 'msg_g2c_left_queue' &&
            queue.startsWith('/chat/') &&
            String(action.user_id || '') === userId
        ) {
            if (this.closedByUser) return;
            if (!this._ownsQueue(queue)) return;
            const wasLegacyChat =
                isEphemeralLegacyChatQueue(queue) &&
                (this.chatQueue === queue || this.legacyChatSubscribed);
            if (wasLegacyChat) {
                this.logger.log(
                    `[IMVU-WS][${this.roomId}] legacy chat subscription ended (${queue}); resubscribing in-room`
                );
                this.legacyChatSubscribed = false;
                this.legacyChatOpId = null;
                this.visibilityBootstrapped = false;
                this.visibilityBootstrapPending = false;
                void this.#resubscribeLegacyChat(queue).then((resubscribed) => {
                    if (!resubscribed) void this.ensureVisible('legacy-chat-drop');
                });
                return;
            }
            this.logger.warn(`[IMVU-WS][${this.roomId}] left ${queue}; will resubscribe before visible join`);
            this.chatQueue = '';
            this.legacyChatSubscribed = false;
            this.legacyChatOpId = null;
            this.visibilityBootstrapped = false;
            this.visibilityBootstrapPending = false;
            this.discoveringLegacyChat = false;
            this.unknownUserRepairInFlight = false;
            this.#stopVisibilityHeartbeat();
            void this.#discoverRoomChat();
            return;
        }
        if (action.record === 'msg_g2c_result' && action.status === 0 && this.visibilityBootstrapPending) {
            this.visibilityBootstrapPending = false;
            this.visibilityBootstrapped = true;
            this.unknownUserRepairFailures = 0;
            this.unknownUserRepairBackoffMs = Math.max(
                1000,
                envInt('IMVU_UNKNOWN_USER_REPAIR_COOLDOWN_MS', 5000)
            );
        }
        if (
            action.record === 'msg_g2c_result' &&
            action.status === 1 &&
            String(action.error_message || '') === 'unknown_user'
        ) {
            if (this.participantReady || this.visibilityBootstrapped || this.visibilityBootstrapPending) {
                this.visibilityBootstrapped = false;
                this.visibilityBootstrapPending = false;
                this.logger.warn(
                    `[IMVU-WS][${this.roomId}] IMVU unknown_user (op ${action.op_id}); scheduling participant repair`
                );
                void this.#scheduleUnknownUserRepair(action.op_id);
            }
        }
        if (action.record === 'msg_g2c_result' && action.op_id === this.legacyChatOpId) {
            if (action.status === 0) {
                this.logger.log(`[IMVU-WS][${this.roomId}] legacy /chat subscription accepted`);
                this.#sendVisibilityBootstrap();
            } else {
                this.logger.warn(
                    `[IMVU-WS][${this.roomId}] legacy /chat subscription failed: ${action.error_message || action.status}`
                );
                this.legacyChatSubscribed = false;
                this.legacyChatOpId = null;
            }
        }
        if (action.record === 'msg_g2c_result' && action.op_id === this.liveSubscribeOpId) {
            if (action.status === 0) {
                this.logger.log(`[IMVU-WS][${this.roomId}] live/audience IMQ subscription accepted`);
                this.#sendVisibilityBootstrap();
            } else {
                this.logger.warn(
                    `[IMVU-WS][${this.roomId}] live/audience IMQ subscription failed: ${action.error_message || action.status}`
                );
                this.legacyChatSubscribed = false;
                this.liveSubscribeOpId = null;
            }
        }
        if ((queue.startsWith('/chat/') || (this.liveRoom && queue.startsWith('/exp/'))) && this._ownsQueue(queue)) {
            if (queue.startsWith('/chat/') || queue === this.chatQueue) {
                this.chatQueue = queue.startsWith('/chat/') ? queue : this.chatQueue || queue;
            }
            if (action.record === 'msg_g2c_joined_queue') {
                this.#sendVisibilityBootstrap();
            }
        }
    }

    #scheduleVisibleRetry(reason) {
        if (!this.visibilityEnabled || this.closedByUser || this.visibleRetryTimer) return;
        this.#stopVisibilityHeartbeat();
        const retryMs = Math.max(1000, envInt('IMVU_VISIBLE_RETRY_MS', 10000));
        this.logger.warn(`[IMVU-WS][${this.roomId}] visible join not ready (${reason}); retrying in ${retryMs}ms`);
        this.visibleRetryTimer = setTimeout(() => {
            this.visibleRetryTimer = null;
            this.chatQueue = '';
            this.legacyChatSubscribed = false;
            this.legacyChatOpId = null;
            this.visibilityBootstrapped = false;
            this.visibilityBootstrapPending = false;
            this.unknownUserRepairInFlight = false;
            this.#stopVisibilityHeartbeat();
            void this.#discoverLegacyChatQueue();
        }, retryMs);
    }

    #scheduleVisibilityHeartbeat() {
        // IMVU drops room presence without a periodic participant REST touch (~every few minutes).
        const intervalMs = Math.max(0, envInt('IMVU_VISIBLE_HEARTBEAT_MS', 180000));
        if (!intervalMs || this.visibleHeartbeatTimer || !this.visibilityEnabled) return;
        this.visibleHeartbeatTimer = setInterval(() => {
            if (!this.isOpen || !this.chatQueue || !this.participantReady || this.closedByUser) return;
            if (this.presenceRepairInFlight || !this.visibilityBootstrapped) return;
            void this.ensureVisible('visible-heartbeat');
        }, intervalMs);
    }

    #stopVisibilityHeartbeat() {
        if (this.visibleHeartbeatTimer) clearInterval(this.visibleHeartbeatTimer);
        this.visibleHeartbeatTimer = null;
    }

    #scheduleUnknownUserRepair(opId) {
        if (this.closedByUser || !this.isOpen) return;
        if (this.unknownUserRepairInFlight) return;
        const now = Date.now();
        if (now < this.unknownUserRepairCooldownUntil) {
            if (process.env.WS_DEBUG === '1' || process.env.WS_DEBUG === 'true') {
                this.logger.log(
                    `[IMVU-WS][${this.roomId}] unknown_user repair suppressed (cooldown ${this.unknownUserRepairCooldownUntil - now}ms, op ${opId})`
                );
            }
            return;
        }
        void this.#runUnknownUserRepair(opId);
    }

    async #hardRejoinParticipant() {
        const userId = String(this.bot.imqUserId || this.bot.user_id || this.bot.userId || '').trim();
        if (!/^\d+$/.test(userId)) return false;
        this.participantReady = false;
        this.lastParticipantEnsureOkAt = 0;
        if (typeof this.session?.removeChatParticipant === 'function') {
            try {
                await this.session.removeChatParticipant(this.roomId, userId);
            } catch (error) {
                this.logger.warn(
                    `[IMVU-WS][${this.roomId}] unknown_user hard rejoin DELETE failed: ${error?.message || error}`
                );
            }
            const gapMs = Math.max(0, envInt('IMVU_UNKNOWN_USER_HARD_REJOIN_GAP_MS', 1500));
            if (gapMs) await delay(gapMs);
        }
        return this.#ensureChatParticipantWithRetry();
    }

    #scheduleUnknownUserRepairRetry() {
        if (this.closedByUser || this.visibilityBootstrapped) return;
        const waitMs = Math.max(1000, this.unknownUserRepairBackoffMs);
        setTimeout(() => {
            if (this.closedByUser || !this.isOpen || this.visibilityBootstrapped) return;
            if (this.unknownUserRepairInFlight) return;
            void this.#scheduleUnknownUserRepair('retry');
        }, waitMs);
    }

    async #runUnknownUserRepair(opId) {
        if (this.unknownUserRepairInFlight || this.closedByUser || !this.isOpen) return;
        this.unknownUserRepairInFlight = true;
        this.visibilityBootstrapped = false;
        this.visibilityBootstrapPending = false;
        this.unknownUserRepairFailures += 1;
        const failure = this.unknownUserRepairFailures;
        const hardRejoinAfter = Math.max(1, envInt('IMVU_UNKNOWN_USER_HARD_REJOIN_AFTER', 2));
        const reconnectAfter = Math.max(
            hardRejoinAfter + 1,
            envInt('IMVU_UNKNOWN_USER_RECONNECT_AFTER', 3)
        );

        try {
            this.logger.warn(
                `[IMVU-WS][${this.roomId}] unknown_user repair #${failure} (op ${opId})`
            );

            if (failure >= reconnectAfter && typeof this.account.requestReconnect === 'function') {
                this.logger.warn(
                    `[IMVU-WS][${this.roomId}] unknown_user persists after ${failure} repairs; reconnecting account WS`
                );
                this.account.requestReconnect(`unknown_user:${this.roomId}`);
                return;
            }

            const stickyMs = Math.max(0, envInt('IMVU_PARTICIPANT_STICKY_MS', 120000));
            const participantSticky =
                failure < hardRejoinAfter &&
                this.participantReady &&
                stickyMs > 0 &&
                Date.now() - (this.lastParticipantEnsureOkAt || 0) < stickyMs;

            let ok = true;
            if (failure >= hardRejoinAfter) {
                ok = await this.#hardRejoinParticipant();
            } else if (!participantSticky) {
                ok = await this.#ensureChatParticipantWithRetry();
            }

            if (!ok || !this.isOpen) {
                this.logger.warn(
                    `[IMVU-WS][${this.roomId}] unknown_user repair: participant edge failed (op ${opId})`
                );
                return;
            }
            const readyDelayMs = Math.max(0, envInt('IMVU_WS_PARTICIPANT_READY_DELAY_MS', 1500));
            if (readyDelayMs) await delay(readyDelayMs);

            // Prefer a fresh legacy queue after hard rejoin; sticky queue can be orphaned.
            if (failure >= hardRejoinAfter) {
                this.chatQueue = '';
                this.legacyChatSubscribed = false;
                this.legacyChatOpId = null;
                await this.#discoverLegacyChatQueue();
                return;
            }

            if (this.chatQueue) {
                this.legacyChatSubscribed = false;
                this.legacyChatOpId = null;
                const resubscribed = await this.#resubscribeLegacyChat(this.chatQueue);
                if (resubscribed) return;
            } else {
                await this.#discoverLegacyChatQueue();
                return;
            }

            if (!this.isOpen) return;
            await this.ensureVisible('unknown-user-repair');
        } finally {
            this.unknownUserRepairInFlight = false;
            this.unknownUserRepairCooldownUntil = Date.now() + this.unknownUserRepairBackoffMs;
            this.unknownUserRepairBackoffMs = Math.min(
                60000,
                Math.max(
                    1000,
                    envInt('IMVU_UNKNOWN_USER_REPAIR_COOLDOWN_MS', 5000),
                    Math.floor(this.unknownUserRepairBackoffMs * 1.5)
                )
            );
            if (!this.visibilityBootstrapped && !this.closedByUser) {
                this.#scheduleUnknownUserRepairRetry();
            }
        }
    }

    #scheduleForceVisibleRefresh() {
        const intervalMs = Math.max(0, envInt('IMVU_FORCE_VISIBLE_REFRESH_MS', 30000));
        if (!intervalMs || this.forceVisibleRefreshTimer || !this.visibilityEnabled) return;
        this.forceVisibleRefreshTimer = setInterval(() => {
            if (this.forceVisibleRefreshRunning || this.closedByUser || !this.isOpen) return;
            if (this.presenceRepairInFlight || !this.visibilityBootstrapped) return;
            this.forceVisibleRefreshRunning = true;
            void this.ensureVisible('force-refresh').finally(() => {
                this.forceVisibleRefreshRunning = false;
            });
        }, intervalMs);
    }

    #stopForceVisibleRefresh() {
        if (this.forceVisibleRefreshTimer) clearInterval(this.forceVisibleRefreshTimer);
        this.forceVisibleRefreshTimer = null;
        this.forceVisibleRefreshRunning = false;
    }

    async #resubscribeLegacyChat(preferredQueue = '') {
        if (!this.visibilityEnabled || this.closedByUser || !this.isOpen) return false;
        if (this.discoveringLegacyChat || this.legacyChatSubscribed) return false;

        let queue = String(preferredQueue || this.chatQueue || '').trim();
        if (!queue && this.session?.fetchLegacyChatQueue) {
            queue = (await this.session.fetchLegacyChatQueue(this.roomId)) || '';
        }
        if (!queue || !this.isOpen) return false;

        const participantReady = await this.#ensureChatParticipantWithRetry();
        if (!participantReady) {
            await this.#warnIfHangoutJoinBlocked();
            this.#scheduleVisibleRetry('participant edge missing');
            return false;
        }

        this.legacyChatSubscribed = true;
        this.chatQueue = queue;
        this.legacyChatOpId = this.account.allocateOpId(this);
        const frame = JSON.stringify({
            record: 'msg_c2g_subscribe',
            queues_with_results: [
                {
                    record: 'subscription',
                    name: queue,
                    op_id: this.legacyChatOpId,
                },
            ],
        });
        this.account.sendRoomFrame(this, frame, 'legacy-chat-resubscribe');
        return true;
    }

    async #discoverLegacyChatQueue(options = {}) {
        if (!this.visibilityEnabled) return;
        if (this.legacyChatSubscribed || !this.session?.fetchLegacyChatQueue) return;
        const nested = Boolean(options.nested);
        if (this.discoveringLegacyChat && !nested) return;
        const ownedDiscovery = !this.discoveringLegacyChat;
        if (ownedDiscovery) this.discoveringLegacyChat = true;
        try {
            const delayMs = options.skipInitialDelay
                ? 0
                : Math.max(0, Number(process.env.IMVU_WS_LEGACY_CHAT_DISCOVERY_DELAY_MS || 2000));
            if (delayMs) await delay(delayMs);
            if (!this.isOpen || this.legacyChatSubscribed) return;

            const queue = await this.session.fetchLegacyChatQueue(this.roomId);
            if (!queue) {
                this.logger.warn(
                    `[IMVU-WS][${this.roomId}] no legacy /chat/... queue discovered; visible room avatar may not appear`
                );
                return;
            }
            this.#sendVisibilityPrepSubscriptions();
            const prepDelayMs = Math.max(0, Number(process.env.IMVU_WS_VISIBILITY_PREP_DELAY_MS || 1200));
            if (prepDelayMs) await delay(prepDelayMs);
            if (!this.isOpen || this.legacyChatSubscribed) return;

            const participantReady = await this.#ensureChatParticipantWithRetry();
            if (!participantReady) {
                // Classic participant denied — try live/audience path (CHAT_PARTICIPANT-005).
                if (typeof this.session.fetchLiveRoomContext === 'function') {
                    const live = await this.session.fetchLiveRoomContext(this.roomId, { force: true });
                    if (live?.isLive) {
                        await this.#warnIfHangoutJoinBlocked();
                        await this.#joinLiveAudience(live);
                        return;
                    }
                }
                await this.#warnIfHangoutJoinBlocked();
                this.#scheduleVisibleRetry('participant edge missing');
                return;
            }
            const participantDelayMs = Math.max(0, Number(process.env.IMVU_WS_PARTICIPANT_READY_DELAY_MS || 1200));
            if (participantDelayMs) await delay(participantDelayMs);
            if (!this.isOpen || this.legacyChatSubscribed) return;

            this.legacyChatSubscribed = true;
            this.chatQueue = queue;
            this.legacyChatOpId = this.account.allocateOpId(this);
            const frame = JSON.stringify({
                record: 'msg_c2g_subscribe',
                queues_with_results: [
                    {
                        record: 'subscription',
                        name: queue,
                        op_id: this.legacyChatOpId,
                    },
                ],
            });
            this.account.sendRoomFrame(this, frame, 'legacy-chat');
            const bootstrapDelayMs = Math.max(
                0,
                Number(process.env.IMVU_WS_VISIBLE_BOOTSTRAP_DELAY_MS || 5000)
            );
            setTimeout(() => {
                if (!this.isOpen || this.visibilityBootstrapped || this.chatQueue !== queue) return;
                this.logger.warn(
                    `[IMVU-WS][${this.roomId}] legacy /chat joined_queue not echoed; sending visibility bootstrap anyway`
                );
                this.#sendVisibilityBootstrap();
            }, bootstrapDelayMs);
        } finally {
            if (ownedDiscovery) this.discoveringLegacyChat = false;
        }
    }

    async #warnIfHangoutJoinBlocked() {
        if (!this.session?.fetchLiveRoomContext) return;
        try {
            const live = await this.session.fetchLiveRoomContext(this.roomId);
            if (live?.isLive) {
                this.logger.warn(
                    `[IMVU-WS][${this.roomId}] hangout/live-style room (mimic_chat=${Boolean(live.mimicChatRoom)}); ` +
                        `classic chat join was denied — falling back to audience experience join`
                );
            }
        } catch {
            /* ignore metadata probe failures */
        }
    }

    async #discoverRoomChat() {
        if (!this.visibilityEnabled || this.discoveringLegacyChat) return;
        if (this.legacyChatSubscribed) return;
        if (!this.session?.fetchLiveRoomContext && !this.session?.fetchLegacyChatQueue) return;

        this.discoveringLegacyChat = true;
        try {
            const delayMs = Math.max(0, Number(process.env.IMVU_WS_LEGACY_CHAT_DISCOVERY_DELAY_MS || 2000));
            if (delayMs) await delay(delayMs);
            if (!this.isOpen || this.legacyChatSubscribed) return;

            if (typeof this.session.fetchLiveRoomContext === 'function') {
                const live = await this.session.fetchLiveRoomContext(this.roomId);
                if (live?.isLive) {
                    await this.#joinLiveAudience(live);
                    return;
                }
            }

            await this.#discoverLegacyChatQueue({ skipInitialDelay: true, nested: true });
        } finally {
            this.discoveringLegacyChat = false;
        }
    }

    async #joinLiveAudience(liveContext) {
        if (!this.isOpen || this.closedByUser) return false;
        const live =
            liveContext?.isLive
                ? liveContext
                : await this.session.fetchLiveRoomContext?.(this.roomId);
        if (!live?.isLive || !live.audienceQueue) {
            this.logger.warn(
                `[IMVU-WS][${this.roomId}] live room missing audience queue; cannot join as audience`
            );
            this.#scheduleVisibleRetry('live audience queue missing');
            return false;
        }

        const joined = await this.session.ensureAudienceJoin?.(this.roomId, live);
        if (!joined) {
            this.logger.warn(`[IMVU-WS][${this.roomId}] audience experience join failed`);
            this.#scheduleVisibleRetry('audience join failed');
            return false;
        }

        this.liveRoom = true;
        this.liveContext = live;
        this.audienceMessageMount = live.audienceMessageMount || 'audience_message_mount';
        this.hangoutQueue = live.hangoutQueue || '';
        this.liveChatId = String(live.chatId || '');
        this.chatQueue = live.audienceQueue;
        this.participantReady = true;
        this.lastParticipantEnsureOkAt = Date.now();

        this.logger.log(
            `[IMVU-WS][${this.roomId}] live/audience room join via ${live.audienceExperienceUrl} ` +
                `(queue ${live.audienceQueue}, mount ${this.audienceMessageMount})`
        );

        const queues = [...new Set([live.audienceQueue, live.hangoutQueue].filter(Boolean))];
        this.legacyChatSubscribed = true;
        this.liveSubscribeOpId = this.account.allocateOpId(this);
        const frame = JSON.stringify({
            record: 'msg_c2g_subscribe',
            queues_with_results: queues.map((name, index) => ({
                record: 'subscription',
                name,
                op_id: index === 0 ? this.liveSubscribeOpId : this.account.allocateOpId(this),
            })),
        });
        this.account.sendRoomFrame(this, frame, 'live-audience');

        // Audience presence does not use classic outfit/seat bootstrap.
        this.visibilityBootstrapPending = false;
        this.visibilityBootstrapped = true;
        this.#scheduleVisibilityHeartbeat();
        this.#scheduleTestMessage();
        return true;
    }

    #sendVisibilityPrepSubscriptions() {
        const userId = String(this.bot.imqUserId || this.bot.user_id || this.bot.userId || '').trim();
        const queues = [
            `inv:/chat/chat-${this.roomId}`,
            `inv:/scene/scene-${this.roomId}`,
        ];
        if (/^\d+$/.test(userId)) {
            queues.push(
                `inv:/outfit_list/outfit_list-${userId}-1`,
                `inv:/outfit/outfit-${userId}-2`,
                `inv:/outfit/outfit-${userId}-1`
            );
        }

        for (const queue of queues) {
            const frame = JSON.stringify({
                record: 'msg_c2g_subscribe',
                queues_with_results: [
                    {
                        record: 'subscription',
                        name: queue,
                        op_id: this.account.allocateOpId(this),
                    },
                ],
            });
            this.account.sendRoomFrame(this, frame, 'visible-prep');
        }
        void this.#subscribeRoomMediaPlayer();
    }

    async #subscribeRoomMediaPlayer() {
        if (this.mediaPlayerSubscribed || !this.session?.fetchRoomMediaPlayerUpdateQueue) return;
        try {
            const queue = await this.session.fetchRoomMediaPlayerUpdateQueue(this.roomId);
            if (!queue || !this.isOpen) return;
            this.mediaPlayerSubscribed = true;
            this.mediaPlayerQueue = queue;
            const frame = JSON.stringify({
                record: 'msg_c2g_subscribe',
                queues_with_results: [
                    {
                        record: 'subscription',
                        name: queue,
                        op_id: this.account.allocateOpId(this),
                    },
                ],
            });
            this.account.sendRoomFrame(this, frame, 'media-player');
            if (process.env.WS_DEBUG === '1' || process.env.WS_DEBUG === 'true') {
                this.logger.log(`[IMVU-WS][${this.roomId}] subscribed ${queue}`);
            }
        } catch (error) {
            this.mediaPlayerSubscribed = false;
            this.logger.warn(
                `[IMVU-WS][${this.roomId}] media_player subscribe failed: ${error?.message || error}`,
            );
        }
    }

    #rememberParticipant(participant) {
        if (!participant || typeof participant !== 'object') return;
        this.participant = participant;
        if (typeof participant.legacy_outfit_message === 'string' && participant.legacy_outfit_message.trim()) {
            this.legacyOutfitMessage = participant.legacy_outfit_message.trim();
        }
        if (typeof participant.legacy_seat_message === 'string' && participant.legacy_seat_message.trim()) {
            this.legacySeatMessage = participant.legacy_seat_message.trim();
        }
        const seatNumber = Number(participant.seat_number);
        if (Number.isFinite(seatNumber) && seatNumber > 0) {
            this.seatNumber = String(seatNumber);
        }
        const seatFurniId = Number(participant.seat_furni_id);
        if (Number.isFinite(seatFurniId)) {
            this.seatFurniId = seatFurniId;
        }
    }

    async #ensureChatParticipant() {
        const userId = String(this.bot.imqUserId || this.bot.user_id || this.bot.userId || '').trim();
        if (!/^\d+$/.test(userId) || !this.session?.ensureChatParticipant) return false;
        const result = await this.session.ensureChatParticipant(this.roomId, userId, {
            participant: this.participant,
        });
        if (result?.mode === 'audience' && result.live) {
            this.liveRoom = true;
            this.liveContext = result.live;
            this.audienceMessageMount =
                result.live.audienceMessageMount || this.audienceMessageMount || 'audience_message_mount';
            this.hangoutQueue = result.live.hangoutQueue || this.hangoutQueue || '';
            this.liveChatId = String(result.live.chatId || this.liveChatId || '');
            if (!this.chatQueue && result.live.audienceQueue) {
                this.chatQueue = result.live.audienceQueue;
            }
        }
        this.#rememberParticipant(result?.participant);
        this.participantReady = Boolean(result);
        if (result) this.lastParticipantEnsureOkAt = Date.now();
        return result;
    }

    async #ensureChatParticipantWithRetry() {
        const attempts = Math.max(1, envInt('IMVU_VISIBLE_PARTICIPANT_RETRY_ATTEMPTS', 4));
        const delayMs = Math.max(500, envInt('IMVU_VISIBLE_PARTICIPANT_RETRY_MS', 2500));
        for (let attempt = 1; attempt <= attempts; attempt++) {
            const result = await this.#ensureChatParticipant();
            if (result) return result;
            if (attempt < attempts) {
                this.logger.warn(
                    `[IMVU-WS][${this.roomId}] participant edge not ready; retry ${attempt}/${attempts}`
                );
                await delay(delayMs);
            }
        }
        this.participantReady = false;
        return false;
    }

    resetPresenceForRejoin() {
        this.visibilityBootstrapped = false;
        this.visibilityBootstrapPending = false;
    }

    async ensureVisible(reason = 'manual') {
        if (!this.visibilityEnabled || this.closedByUser) return false;
        const now = Date.now();
        const softRefresh = reason === 'force-refresh' || reason === 'visible-heartbeat';
        const isHeartbeat = reason === 'visible-heartbeat';
        if (softRefresh && (this.presenceRepairInFlight || !this.visibilityBootstrapped)) {
            if (!this.presenceRepairInFlight && !this.visibilityBootstrapped) {
                void this.#scheduleUnknownUserRepair(reason);
            }
            return false;
        }
        const minGapMs = Math.max(5000, envInt('IMVU_ENSURE_VISIBLE_MIN_GAP_MS', 45000));
        if (reason === 'force-refresh' && now - this.lastEnsureVisibleAt < minGapMs) {
            return false;
        }
        if (!this.isOpen) await this.connect();
        // Soft force-refresh may skip REST when healthy; heartbeat must never skip —
        // that POST is the room keepalive (empty/refresh participant) IMVU expects.
        if (isHeartbeat) {
            await this.#ensureChatParticipant();
        } else {
            const skipParticipantRest =
                reason !== 'self-removed' &&
                reason !== 'unknown-user-repair' &&
                reason !== 'legacy-chat-drop' &&
                reason !== 'participant-repair' &&
                softRefresh &&
                this.participantReady &&
                this.legacyChatSubscribed &&
                Boolean(this.chatQueue);
            if (!skipParticipantRest) {
                await this.#ensureChatParticipantWithRetry();
            }
        }
        if (!this.chatQueue || !this.legacyChatSubscribed) {
            void this.#discoverRoomChat();
            return false;
        }
        if (softRefresh && this.visibilityBootstrapped && this.participantReady) {
            this.lastEnsureVisibleAt = now;
            return true;
        }
        if (!softRefresh) {
            this.visibilityBootstrapped = false;
            this.visibilityBootstrapPending = false;
        }
        this.#sendVisibilityBootstrap({ force: softRefresh });
        this.lastEnsureVisibleAt = now;
        if (!softRefresh || process.env.WS_DEBUG === '1' || process.env.WS_DEBUG === 'true') {
            this.logger.log(`[IMVU-WS][${this.roomId}] visibility refreshed (${reason})`);
        }
        return true;
    }

    #sendVisibilityBootstrap({ force = false, label = 'visible-join' } = {}) {
        if (!this.visibilityEnabled) return;
        if (this.liveRoom) {
            this.visibilityBootstrapPending = false;
            this.visibilityBootstrapped = true;
            this.#scheduleVisibilityHeartbeat();
            this.#scheduleTestMessage();
            return;
        }
        if ((!force && this.visibilityBootstrapped) || !this.isOpen || !this.chatQueue.startsWith('/chat/')) return;
        if (!this.participantReady) {
            this.#scheduleVisibleRetry('participant not confirmed');
            return;
        }
        this.visibilityBootstrapPending = true;

        const userId = String(this.bot.imqUserId || this.bot.user_id || this.bot.userId || '').trim();
        if (!/^\d+$/.test(userId)) return;

        const seatAssignmentVersion =
            String(process.env.IMVU_WS_SEAT_ASSIGNMENT_VERSION || '3').trim() || '3';
        const seatNumber =
            this.seatNumber ||
            String(process.env.IMVU_WS_SEAT_NUMBER || process.env.IMVU_WS_SEAT_INDEX || '1').trim() ||
            '1';
        const seatFurniId = Number.isFinite(Number(this.seatFurniId)) ? Number(this.seatFurniId) : 0;
        const legacyOutfitMessage = String(this.legacyOutfitMessage || '').trim();
        const legacySeatMessage = String(this.legacySeatMessage || '').trim();
        const bootstrapMessages = ['*imvu:isPureUser'];

        if (legacyOutfitMessage) {
            bootstrapMessages.push(legacyOutfitMessage);
            const legacyUseMessage = legacyOutfitMessage.replace(/^\*putOnOutfit\b/i, '*use');
            if (legacyUseMessage !== legacyOutfitMessage) {
                bootstrapMessages.push(legacyUseMessage);
            }
        } else {
            const outfitProductIds = String(process.env.IMVU_WS_OUTFIT_PRODUCT_IDS || '')
                .trim()
                .replace(/\s+/g, ' ');
            if (outfitProductIds) {
                bootstrapMessages.push(`*putOnOutfit ${outfitProductIds}`, `*use ${outfitProductIds}`);
            }
        }
        bootstrapMessages.push(
            legacySeatMessage || `*msg SeatAssignment ${seatAssignmentVersion} ${userId} ${seatNumber} ${seatFurniId}`
        );

        for (const text of bootstrapMessages) {
            const frame = this.spec.sendFrameFor(this.roomId, text, {
                chatQueue: this.chatQueue,
            });
            this.account.sendRoomFrame(this, frame, label);
        }

        this.#scheduleVisibilityHeartbeat();
        this.#scheduleTestMessage();
    }

    #scheduleTestMessage() {
        const text = String(process.env.IMVU_WS_TEST_MESSAGE || '').trim();
        if (!text || this.testMessageSent) return;
        this.testMessageSent = true;
        const delayMs = Math.max(0, Number(process.env.IMVU_WS_TEST_MESSAGE_DELAY_MS || 1500));
        setTimeout(() => {
            if (!this.isOpen || !this.chatQueue) return;
            try {
                let frame = this.spec.sendFrameFor(this.roomId, text, {
                    chatQueue: this.chatQueue,
                    ...(this.liveChatId ? { chatId: this.liveChatId } : {}),
                });
                if (this.liveRoom && this.audienceMessageMount) {
                    try {
                        const parsed = JSON.parse(frame);
                        parsed.mount = this.audienceMessageMount;
                        parsed.queue = this.chatQueue;
                        frame = JSON.stringify(parsed);
                    } catch {
                        /* keep template frame */
                    }
                }
                this.account.sendRoomFrame(this, frame, 'test-message');
                this.emit('sent', { roomId: this.roomId, text, meta: { autoTest: true } });
                this.logger.log(`[IMVU-WS][${this.roomId}][test-message] ${text}`);
            } catch (error) {
                this.logger.warn(`[IMVU-WS][${this.roomId}] test message failed: ${error.message}`);
            }
        }, delayMs);
    }

    async sendMessage(text, meta = {}) {
        if (!this.visibilityEnabled) {
            throw new Error(`Room ${this.roomId} is tracking-only; visible chat is disabled.`);
        }
        if (!this.isOpen) await this.connect();
        const chatQueue = this.chatQueue || '';
        if (!chatQueue) {
            throw new Error(
                `No concrete IMVU chat queue discovered for room ${this.roomId}. ` +
                    'Wait for /chat/... joined_queue or capture the room chat subscription flow.'
            );
        }
        let frame = this.spec.sendFrameFor(this.roomId, String(text || ''), {
            ...meta,
            chatQueue,
            ...(this.liveChatId ? { chatId: this.liveChatId } : {}),
            ...(this.audienceMessageMount ? { messageMount: this.audienceMessageMount } : {}),
        });
        if (this.liveRoom && this.audienceMessageMount) {
            try {
                const parsed = JSON.parse(frame);
                parsed.mount = this.audienceMessageMount;
                parsed.queue = chatQueue;
                frame = JSON.stringify(parsed);
            } catch {
                /* keep template frame */
            }
        }
        this.account.sendRoomFrame(this, frame, 'send-message');
        this.emit('sent', { roomId: this.roomId, text: String(text || ''), meta });
    }

    async leave() {
        if (!this.isOpen) return;
        this.#sendFrames(this.spec.leaveFramesFor(this.roomId), 'leave', { rewriteSubscriptionOps: true });
    }

    close() {
        this.closedByUser = true;
        if (this.visibleRetryTimer) clearTimeout(this.visibleRetryTimer);
        this.visibleRetryTimer = null;
        this.unknownUserRepairInFlight = false;
        this.visibilityBootstrapPending = false;
        this.#stopVisibilityHeartbeat();
        this.#stopForceVisibleRefresh();
        this.account.unregisterRoom(this);
        this.emit('close');
    }
}
