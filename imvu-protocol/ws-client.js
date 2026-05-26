import { EventEmitter } from 'events';
import WebSocket from 'ws';

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

export class ImvuRoomWebSocketClient extends EventEmitter {
    constructor({ roomId, spec, session, agents = {}, logger = console, bot = {}, visibilityEnabled = true }) {
        super();
        this.roomId = String(roomId || '').trim().replace(/^room-/i, '');
        this.spec = spec;
        this.session = session;
        this.agents = agents;
        this.logger = logger;
        this.bot = bot;
        this.visibilityEnabled = visibilityEnabled;
        this.ws = null;
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
        this.closedByUser = false;
        this.connecting = null;
        this.reconnectAttempt = 0;
        this.nextRuntimeOpId = Number(process.env.IMVU_WS_RUNTIME_OP_ID_START || 45);
        this.pingTimer = null;
    }

    get isOpen() {
        return this.ws?.readyState === WebSocket.OPEN;
    }

    async connect() {
        if (this.connecting) return this.connecting;
        this.closedByUser = false;
        this.connecting = this.#connectOnce().finally(() => {
            this.connecting = null;
        });
        return this.connecting;
    }

    async #connectOnce() {
        const missing = this.spec.describeMissing();
        if (missing.length) {
            throw new Error(`Missing IMVU WebSocket protocol config: ${missing.join(', ')}`);
        }

        await this.session.ensureLoggedIn();
        const url = this.spec.urlFor(this.roomId);
        const headers = {
            Origin: process.env.IMVU_WS_ORIGIN || 'https://www.imvu.com',
            ...this.spec.headersFor(this.roomId),
        };
        const cookie = await this.session.cookieHeader(headers.Origin);
        if (cookie) headers.Cookie = cookie;

        const safeUrl = url.replace(/([?&](?:token|auth|session)=)[^&]+/gi, '$1***');
        this.logger.log(`[IMVU-WS][${this.roomId}] connecting ${safeUrl}`);

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
                this.chatQueue = '';
                this.legacyChatSubscribed = false;
                this.legacyChatOpId = null;
                this.visibilityBootstrapped = false;
                this.testMessageSent = false;
                this.#wireSocket(ws);
                this.logger.log(`[IMVU-WS][${this.roomId}] open`);
                this.#sendFrames(this.spec.connectFramesFor(this.roomId), 'connect');
                const joinDelayMs = Math.max(
                    0,
                    Number(process.env.IMVU_WS_POST_CONNECT_DELAY_MS || 350)
                );
                setTimeout(() => {
                    if (!this.isOpen) return;
                    this.#sendFrames(this.spec.joinFramesFor(this.roomId), 'join');
                    this.#startPing();
                    if (this.visibilityEnabled) void this.#discoverLegacyChatQueue();
                }, joinDelayMs);
                this.emit('open');
                resolve();
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
                const line = typeof frame === 'string' ? frame : JSON.stringify(frame);
                this.logger.log(`[IMVU-WS][${this.roomId}][recv] ${line.slice(0, 800)}`);
            }
            this.emit('raw', frame);
            const actions = Array.isArray(frame) ? frame : [frame];
            for (const action of actions) {
                this.#learnFromFrame(action);
                this.emit('frame', action);
            }
        });

        ws.on('error', (error) => {
            this.emit('error', error);
        });

        ws.on('close', (code, reason) => {
            this.#stopPing();
            const reasonText = reason?.toString?.() || '';
            this.logger.warn(`[IMVU-WS][${this.roomId}] close code=${code} reason=${reasonText || '(none)'}`);
            this.emit('close', code, reasonText);
            if (!this.closedByUser) {
                void this.#scheduleReconnect(code, reason);
            }
        });
    }

    async #scheduleReconnect(code, reason) {
        this.reconnectAttempt += 1;
        const max = Number(process.env.IMVU_WS_MAX_RECONNECTS || 0);
        if (max > 0 && this.reconnectAttempt > max) {
            this.emit('fatal', new Error(`WebSocket closed ${code}; reconnect limit reached`));
            return;
        }

        const baseMs = Number(process.env.IMVU_WS_RECONNECT_BASE_MS || 2000);
        const capMs = Number(process.env.IMVU_WS_RECONNECT_CAP_MS || 60000);
        const waitMs = Math.min(capMs, baseMs * Math.max(1, this.reconnectAttempt));
        this.logger.warn(
            `[IMVU-WS][${this.roomId}] closed ${code} ${reason?.toString?.() || ''}; reconnecting in ${waitMs}ms`
        );
        await delay(waitMs);
        if (this.closedByUser) return;
        try {
            await this.connect();
        } catch (error) {
            this.emit('error', error);
            void this.#scheduleReconnect(0, error.message);
        }
    }

    #sendFrames(frames, label) {
        for (const frame of frames) {
            this.sendRaw(frame);
            if (process.env.WS_DEBUG === '1' || process.env.WS_DEBUG === 'true') {
                this.logger.log(`[IMVU-WS][${this.roomId}][${label}] ${String(frame).slice(0, 800)}`);
            }
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
            this.logger.warn(`[IMVU-WS][${this.roomId}] left legacy ${queue}; will resubscribe before visible join`);
            this.chatQueue = '';
            this.legacyChatSubscribed = false;
            this.legacyChatOpId = null;
            this.visibilityBootstrapped = false;
            return;
        }
        if (action.record === 'msg_g2c_result' && action.op_id === this.legacyChatOpId) {
            if (action.status === 0) {
                this.logger.log(`[IMVU-WS][${this.roomId}] legacy /chat subscription accepted`);
                this.#sendVisibilityBootstrap();
            } else {
                this.logger.warn(
                    `[IMVU-WS][${this.roomId}] legacy /chat subscription failed: ${action.error_message || action.status}`
                );
            }
        }
        if (queue.startsWith('/chat/')) {
            this.chatQueue = queue;
            if (action.record === 'msg_g2c_joined_queue') {
                this.#sendVisibilityBootstrap();
            }
        }
    }

    async #discoverLegacyChatQueue() {
        if (!this.visibilityEnabled) return;
        if (this.legacyChatSubscribed || !this.session?.fetchLegacyChatQueue) return;
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

        await this.#ensureChatParticipant();
        const participantDelayMs = Math.max(0, Number(process.env.IMVU_WS_PARTICIPANT_READY_DELAY_MS || 1200));
        if (participantDelayMs) await delay(participantDelayMs);
        if (!this.isOpen || this.legacyChatSubscribed) return;

        this.legacyChatSubscribed = true;
        this.chatQueue = queue;
        this.legacyChatOpId = this.nextRuntimeOpId++;
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
        this.sendRaw(frame);
        if (process.env.WS_DEBUG === '1' || process.env.WS_DEBUG === 'true') {
            this.logger.log(`[IMVU-WS][${this.roomId}][legacy-chat] ${frame}`);
        }
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
                        op_id: this.nextRuntimeOpId++,
                    },
                ],
            });
            this.sendRaw(frame);
            if (process.env.WS_DEBUG === '1' || process.env.WS_DEBUG === 'true') {
                this.logger.log(`[IMVU-WS][${this.roomId}][visible-prep] ${frame}`);
            }
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
        return result;
    }

    async ensureVisible(reason = 'manual') {
        if (!this.visibilityEnabled) return false;
        if (!this.isOpen) await this.connect();
        await this.#ensureChatParticipant();
        if (!this.chatQueue || !this.legacyChatSubscribed) {
            void this.#discoverLegacyChatQueue();
            return false;
        }
        this.visibilityBootstrapped = false;
        this.#sendVisibilityBootstrap();
        this.logger.log(`[IMVU-WS][${this.roomId}] visibility refreshed (${reason})`);
        return true;
    }

    #sendVisibilityBootstrap() {
        if (!this.visibilityEnabled) return;
        if (this.visibilityBootstrapped || !this.isOpen || !this.chatQueue.startsWith('/chat/')) return;
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
            this.sendRaw(frame);
            if (process.env.WS_DEBUG === '1' || process.env.WS_DEBUG === 'true') {
                this.logger.log(`[IMVU-WS][${this.roomId}][visible-join] ${String(frame).slice(0, 800)}`);
            }
        }

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
                this.sendRaw(frame);
                this.emit('sent', { roomId: this.roomId, text, meta: { autoTest: true } });
                this.logger.log(`[IMVU-WS][${this.roomId}][test-message] ${text}`);
            } catch (error) {
                this.logger.warn(`[IMVU-WS][${this.roomId}] test message failed: ${error.message}`);
            }
        }, delayMs);
    }

    #startPing() {
        this.#stopPing();
        const intervalMs = Number(process.env.IMVU_WS_PING_INTERVAL_MS || 0);
        if (!intervalMs) return;
        this.pingTimer = setInterval(() => {
            if (!this.isOpen) return;
            const frame = this.spec.pingFrameFor(this.roomId);
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

    sendRaw(frame) {
        if (!this.isOpen) {
            throw new Error(`IMVU WebSocket for room ${this.roomId} is not open.`);
        }
        this.ws.send(frame);
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
        this.sendRaw(frame);
        this.emit('sent', { roomId: this.roomId, text: String(text || ''), meta });
    }

    async leave() {
        if (!this.isOpen) return;
        this.#sendFrames(this.spec.leaveFramesFor(this.roomId), 'leave');
    }

    close() {
        this.closedByUser = true;
        this.#stopPing();
        if (this.ws && this.ws.readyState < WebSocket.CLOSING) {
            this.ws.close(1000, 'client closed');
        }
    }
}
