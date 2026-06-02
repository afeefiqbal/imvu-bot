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
    }

    get isOpen() {
        return this.ws?.readyState === WebSocket.OPEN;
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
                this.#sendAccountFrames(this.spec.connectFramesFor(roomId), 'connect');
                this.#startPing(roomId);
                this.emit('open');
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
            if (!this.closedByUser && this.rooms.size > 0) {
                void this.#scheduleReconnect(code, reason);
            }
        });
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
        if (this.closedByUser || this.rooms.size === 0) return;
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
        // Keep the account websocket open with zero rooms so DM !join and friend accepts still work.
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
        this.visibleRetryTimer = null;
        this.visibleHeartbeatTimer = null;
        this.forceVisibleRefreshTimer = null;
        this.forceVisibleRefreshRunning = false;
        this.lastEnsureVisibleAt = 0;
        this.mediaPlayerQueue = '';
        this.mediaPlayerSubscribed = false;
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
        this.testMessageSent = false;
        this.joined = false;
        this.discoveringLegacyChat = false;
        this.participantReady = false;
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
        if (this.chatQueue && isImvuRoomChatQueue(q) && q !== this.chatQueue) {
            return roomQueueBelongsToRoom(q, this.roomId, { knownChatQueue: this.chatQueue });
        }
        if (q.startsWith('/chat/') || isImvuRoomChatQueue(q)) {
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
            void this.#discoverLegacyChatQueue();
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
                this.participantReady = false;
                void this.#resubscribeLegacyChat(queue);
                return;
            }
            this.logger.warn(`[IMVU-WS][${this.roomId}] left ${queue}; will resubscribe before visible join`);
            this.chatQueue = '';
            this.legacyChatSubscribed = false;
            this.legacyChatOpId = null;
            this.visibilityBootstrapped = false;
            this.discoveringLegacyChat = false;
            this.participantReady = false;
            this.#stopVisibilityHeartbeat();
            return;
        }
        if (
            action.record === 'msg_g2c_result' &&
            action.status === 1 &&
            String(action.error_message || '') === 'unknown_user'
        ) {
            if (this.participantReady || this.visibilityBootstrapped) {
                this.logger.warn(
                    `[IMVU-WS][${this.roomId}] IMVU unknown_user (op ${action.op_id}); re-establishing room participant`
                );
                this.participantReady = false;
                this.visibilityBootstrapped = false;
                void this.#ensureChatParticipantWithRetry().then((ok) => {
                    if (!ok || !this.isOpen) return;
                    if (this.legacyChatSubscribed && this.chatQueue) {
                        void this.ensureVisible('unknown-user-repair');
                    } else {
                        void this.#discoverLegacyChatQueue();
                    }
                });
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
        if (queue.startsWith('/chat/') && this._ownsQueue(queue)) {
            this.chatQueue = queue;
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
            this.participantReady = false;
            this.#stopVisibilityHeartbeat();
            void this.#discoverLegacyChatQueue();
        }, retryMs);
    }

    #scheduleVisibilityHeartbeat() {
        const intervalMs = Math.max(0, envInt('IMVU_VISIBLE_HEARTBEAT_MS', 120000));
        if (!intervalMs || this.visibleHeartbeatTimer || !this.visibilityEnabled) return;
        this.visibleHeartbeatTimer = setInterval(() => {
            if (!this.isOpen || !this.chatQueue || !this.participantReady || this.closedByUser) return;
            void this.ensureVisible('visible-heartbeat');
        }, intervalMs);
    }

    #stopVisibilityHeartbeat() {
        if (this.visibleHeartbeatTimer) clearInterval(this.visibleHeartbeatTimer);
        this.visibleHeartbeatTimer = null;
    }

    #scheduleForceVisibleRefresh() {
        const intervalMs = Math.max(0, envInt('IMVU_FORCE_VISIBLE_REFRESH_MS', 30000));
        if (!intervalMs || this.forceVisibleRefreshTimer || !this.visibilityEnabled) return;
        this.forceVisibleRefreshTimer = setInterval(() => {
            if (this.forceVisibleRefreshRunning || this.closedByUser || !this.isOpen) return;
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
        if (!this.visibilityEnabled || this.closedByUser || !this.isOpen) return;
        if (this.discoveringLegacyChat || this.legacyChatSubscribed) return;

        let queue = String(preferredQueue || this.chatQueue || '').trim();
        if (!queue && this.session?.fetchLegacyChatQueue) {
            queue = (await this.session.fetchLegacyChatQueue(this.roomId)) || '';
        }
        if (!queue || !this.isOpen) return;

        const participantReady = await this.#ensureChatParticipantWithRetry();
        if (!participantReady) {
            this.#scheduleVisibleRetry('participant edge missing');
            return;
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
    }

    async #discoverLegacyChatQueue() {
        if (!this.visibilityEnabled || this.discoveringLegacyChat) return;
        if (this.legacyChatSubscribed || !this.session?.fetchLegacyChatQueue) return;
        this.discoveringLegacyChat = true;
        try {
            const delayMs = Math.max(0, Number(process.env.IMVU_WS_LEGACY_CHAT_DISCOVERY_DELAY_MS || 2000));
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
            this.discoveringLegacyChat = false;
        }
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
        this.#rememberParticipant(result?.participant);
        this.participantReady = Boolean(result);
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
        this.participantReady = false;
        this.visibilityBootstrapped = false;
    }

    async ensureVisible(reason = 'manual') {
        if (!this.visibilityEnabled || this.closedByUser) return false;
        const now = Date.now();
        const minGapMs = Math.max(5000, envInt('IMVU_ENSURE_VISIBLE_MIN_GAP_MS', 45000));
        if (reason === 'force-refresh' && now - this.lastEnsureVisibleAt < minGapMs) {
            return false;
        }
        if (!this.isOpen) await this.connect();
        const skipParticipantRest =
            reason !== 'self-removed' &&
            reason !== 'unknown-user-repair' &&
            reason !== 'participant-repair' &&
            (reason === 'force-refresh' || reason === 'visible-heartbeat') &&
            this.participantReady &&
            this.legacyChatSubscribed &&
            Boolean(this.chatQueue);
        if (!skipParticipantRest) {
            await this.#ensureChatParticipantWithRetry();
        }
        if (!this.chatQueue || !this.legacyChatSubscribed) {
            void this.#discoverLegacyChatQueue();
            return false;
        }
        const softRefresh = reason === 'force-refresh' || reason === 'visible-heartbeat';
        if (softRefresh && this.visibilityBootstrapped && this.participantReady) {
            this.lastEnsureVisibleAt = now;
            return true;
        }
        if (!softRefresh) {
            this.visibilityBootstrapped = false;
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
        if ((!force && this.visibilityBootstrapped) || !this.isOpen || !this.chatQueue.startsWith('/chat/')) return;
        if (!this.participantReady) {
            this.#scheduleVisibleRetry('participant not confirmed');
            return;
        }
        this.visibilityBootstrapped = true;

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
                const frame = this.spec.sendFrameFor(this.roomId, text, {
                    chatQueue: this.chatQueue,
                });
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
        const frame = this.spec.sendFrameFor(this.roomId, String(text || ''), {
            ...meta,
            chatQueue,
        });
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
        this.#stopVisibilityHeartbeat();
        this.#stopForceVisibleRefresh();
        this.account.unregisterRoom(this);
        this.emit('close');
    }
}
