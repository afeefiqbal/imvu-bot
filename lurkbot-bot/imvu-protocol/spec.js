import crypto from 'crypto';

function parseJsonEnv(name, fallback = null) {
    const raw = String(process.env[name] || '').trim();
    if (!raw) return fallback;
    try {
        return JSON.parse(raw);
    } catch (error) {
        throw new Error(`${name} must be valid JSON: ${error.message}`);
    }
}

function asArray(value) {
    if (value == null || value === '') return [];
    return Array.isArray(value) ? value : [value];
}

function roomSlugFromId(roomId) {
    const id = String(roomId || '').trim().replace(/^room-/i, '');
    return id ? `room-${id}` : '';
}

function base64Json(value) {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function renderString(template, vars) {
    return String(template).replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, key) => {
        const value = vars[key];
        return value == null ? '' : String(value);
    });
}

export function renderTemplate(template, vars) {
    if (typeof template === 'string') {
        const exact = template.match(/^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/);
        if (exact && Object.prototype.hasOwnProperty.call(vars, exact[1])) {
            return vars[exact[1]];
        }
        return renderString(template, vars);
    }
    if (Array.isArray(template)) return template.map((item) => renderTemplate(item, vars));
    if (template && typeof template === 'object') {
        return Object.fromEntries(
            Object.entries(template).map(([key, value]) => [key, renderTemplate(value, vars)])
        );
    }
    return template;
}

export function serializeFrame(frame) {
    if (frame == null) return null;
    if (typeof frame === 'string' || Buffer.isBuffer(frame)) return frame;
    return JSON.stringify(frame);
}

export function createProtocolSpec(bot = {}) {
    let nextOpId = Number(process.env.IMVU_WS_OP_ID_START || 1000);
    const combined = parseJsonEnv('IMVU_WS_FRAME_SPEC_JSON', {});
    const urlTemplate =
        process.env.IMVU_WS_URL_TEMPLATE ||
        process.env.IMVU_WS_URL ||
        combined.urlTemplate ||
        combined.url ||
        '';
    const headers = {
        ...(combined.headers && typeof combined.headers === 'object' ? combined.headers : {}),
        ...(parseJsonEnv('IMVU_WS_HEADERS_JSON', {}) || {}),
    };

    const connectFrames = asArray(
        parseJsonEnv('IMVU_WS_CONNECT_FRAMES_JSON', combined.connectFrames || combined.connectFrame || [])
    );
    const joinFrames = asArray(
        parseJsonEnv('IMVU_WS_JOIN_FRAMES_JSON', combined.joinFrames || combined.joinFrame || [])
    );
    const sendFrame =
        parseJsonEnv('IMVU_WS_SEND_FRAME_JSON', combined.sendFrame || null);
    const leaveFrames = asArray(
        parseJsonEnv('IMVU_WS_LEAVE_FRAMES_JSON', combined.leaveFrames || combined.leaveFrame || [])
    );
    const pingFrame =
        parseJsonEnv('IMVU_WS_PING_FRAME_JSON', combined.pingFrame || null);

    const buildVars = ({ roomId, text = '', extra = {} } = {}) => {
        const normalizedRoomId = String(roomId || '').trim().replace(/^room-/i, '');
        const fallbackChatId = normalizedRoomId.split('-')[1] || normalizedRoomId;
        const userId = bot.imqUserId || bot.user_id || bot.userId || '';
        const connectCookie = bot.imqConnectCookie || '';
        const chatQueue = extra.chatQueue || bot.imqChatQueue || '';
        const chatId = extra.chatId || bot.imqChatId || fallbackChatId;
        const messageEnvelope = {
            chatId,
            message: text,
            to: 0,
            userId,
        };
        const now = Date.now();
        return {
            botName: bot.name || '',
            username: bot.username || '',
            password: bot.password || '',
            userId,
            connectCookie,
            chatId,
            chatQueue,
            opId: nextOpId++,
            displayName: bot.profile || bot.display_name || bot.displayName || bot.username || '',
            roomId: normalizedRoomId,
            roomSlug: roomSlugFromId(normalizedRoomId),
            text,
            message: text,
            messageJson: JSON.stringify(messageEnvelope),
            messageBase64: base64Json(messageEnvelope),
            nonce: crypto.randomUUID(),
            timestamp: String(now),
            timestampMs: String(now),
            ...extra,
        };
    };

    const renderFrames = (templates, vars) =>
        asArray(templates)
            .map((frame) => renderTemplate(frame, vars))
            .map(serializeFrame)
            .filter((frame) => frame != null && frame !== '');

    return {
        hasEndpoint: Boolean(urlTemplate),
        hasSendFrame: Boolean(sendFrame),
        hasConnectFrames: connectFrames.length > 0,
        hasJoinFrames: joinFrames.length > 0,
        describeMissing() {
            const missing = [];
            if (!urlTemplate) missing.push('IMVU_WS_URL or IMVU_WS_URL_TEMPLATE');
            return missing;
        },
        urlFor(roomId, extra = {}) {
            return renderString(urlTemplate, buildVars({ roomId, extra }));
        },
        headersFor(roomId, extra = {}) {
            return renderTemplate(headers, buildVars({ roomId, extra }));
        },
        connectFramesFor(roomId, extra = {}) {
            return renderFrames(connectFrames, buildVars({ roomId, extra }));
        },
        joinFramesFor(roomId, extra = {}) {
            return renderFrames(joinFrames, buildVars({ roomId, extra }));
        },
        leaveFramesFor(roomId, extra = {}) {
            return renderFrames(leaveFrames, buildVars({ roomId, extra }));
        },
        pingFrameFor(roomId, extra = {}) {
            const rendered = renderFrames(pingFrame, buildVars({ roomId, extra }));
            return rendered[0] || null;
        },
        sendFrameFor(roomId, text, extra = {}) {
            if (!sendFrame) {
                throw new Error('No IMVU WebSocket send frame template configured.');
            }
            return renderFrames(sendFrame, buildVars({ roomId, text, extra }))[0];
        },
    };
}
