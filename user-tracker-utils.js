export const EXCLUDED_HANDLES = ['you', 'unknown', 'guest', 'loading'];

export const normalizeRoomApiSlug = (rid) => {
    const s = String(rid ?? '').trim().replace(/^\/+|\/+$/g, '');
    if (!s) return null;
    if (/^room-[\d-]+$/i.test(s)) return s;
    if (/^\d+-\d+$/.test(s)) return `room-${s}`;
    return null;
};

export const normalizeImvuUsername = (name) => {
    if (name == null || typeof name !== 'string') return name;
    const t = name.trim();
    if (!t) return t;
    const stripped = t.replace(/^guest_/i, '');
    return stripped || t;
};

export const decodeId = (id) => {
    if (id == null || id === '') return null;
    const s = String(id);
    if (/^\d+$/.test(s)) return s;
    if (/^[A-Za-z0-9+/]+$/.test(s) && s.length >= 4) {
        try {
            const padded = s.padEnd(Math.ceil(s.length / 4) * 4, '=');
            const decoded = Buffer.from(padded, 'base64').toString('utf-8');
            if (/^\d+$/.test(decoded)) return decoded;
        } catch {}
    }
    if (s.length > 10 && s.includes('=')) {
        try {
            return Buffer.from(s, 'base64').toString('utf-8');
        } catch {}
    }
    return s;
};

export const isImvuRoomProtocolLine = (msg) => (msg || '').trim().startsWith('*');

/** IMVU Next chat mount label varies by build (`messages`, `edge:messages`, …). */
export const isImvuMessagesMount = (mount) => {
    const m = String(mount || '').toLowerCase();
    if (!m) return false;
    if (m === 'messages' || m === 'edge:messages') return true;
    if (m === 'audience_message_mount' || m === 'scene_message_mount') return true;
    if (m.endsWith(':messages') || m.endsWith('_message_mount')) return true;
    return false;
};

/** Room chat WS queue: legacy `/chat/123`, Next `inv:/chat/...`, or live `/exp/{id}/...`. */
export const isImvuRoomChatQueue = (queue) => {
    const q = String(queue || '');
    if (!q) return false;
    if (q.startsWith('/chat/')) return true;
    if (q.startsWith('/exp/')) return true;
    if (/^inv:\/chat\//i.test(q)) return true;
    return false;
};

/** Numeric legacy queue from fetchLegacyChatQueue — not the room participant mount. */
export const isEphemeralLegacyChatQueue = (queue) =>
    /^\/chat\/\d+$/i.test(String(queue || '').trim());

/**
 * When multiple IMVU room tabs share one account WebSocket, the same chat frame can reach every tracker.
 * Only handle chat (music, mentions, logs) if this frame's queue names our room (e.g. chat-{ownerId}-{roomNum}-…).
 * @param {string} queue
 * @param {string} roomId dashboard slug e.g. {ownerId}-{roomNum} or room-{ownerId}-{roomNum}
 * @param {{ knownChatQueue?: string } | string} [opts] this room's subscribed legacy chat queue, when known
 * @returns {boolean} false when the queue clearly targets a different room or cannot be routed safely
 */
export const roomQueueBelongsToRoom = (queue, roomId, opts = null) => {
    const knownChatQueue =
        typeof opts === 'string' ? opts : String(opts?.knownChatQueue || '').trim();
    const key = String(roomId || '')
        .trim()
        .replace(/^room-/i, '')
        .replace(/[^0-9-]/g, '');
    const q = String(queue || '');
    if (!q) return false;

    if (knownChatQueue && q === knownChatQueue) return true;
    // inv:/chat/chat-{room} and legacy /chat/{num} can both apply to the same room; match by slug below.

    if (!key || !/^\d+-\d+$/.test(key)) return true;
    if (!isImvuRoomChatQueue(q)) return true;

    const found = [];
    const re = /(?:chat|room)-(\d+-\d+)/gi;
    let m;
    while ((m = re.exec(q)) !== null) {
        found.push(m[1]);
    }
    if (found.length === 0) return false;
    return found.includes(key);
};

/**
 * When one account WS serves multiple rooms, a chat frame must not fan out to every tracker.
 * @param {string} queue
 * @param {Array<{ roomId?: string }>} targets
 * @returns {Array<{ roomId?: string }>}
 */
export const narrowChatFrameTargets = (queue, targets) => {
    if (!Array.isArray(targets) || targets.length <= 1) return targets || [];

    const q = String(queue || '');
    const slugs = [];
    const re = /(?:chat|room)-(\d+-\d+)/gi;
    let match;
    while ((match = re.exec(q)) !== null) {
        slugs.push(match[1]);
    }

    if (slugs.length === 1) {
        const slug = slugs[0];
        const filtered = targets.filter((room) => {
            const key = String(room?.roomId || '')
                .trim()
                .replace(/^room-/i, '');
            return key === slug;
        });
        if (filtered.length) return filtered;
    }

    // Legacy numeric /chat/123 or live /exp/{id}/... queues: keep only rooms whose subscribed queue matches exactly.
    if (q.startsWith('/chat/') || q.startsWith('/exp/')) {
        const filtered = targets.filter((room) => String(room?.chatQueue || '') === q);
        if (filtered.length) return filtered;
    }

    return [];
};

export const chatVerbose = () =>
    process.env.CHAT_VERBOSE === '1' || process.env.CHAT_VERBOSE === 'true';

export const decodeChatEnvelope = (rawMessage) => {
    if (!rawMessage || typeof rawMessage !== 'string') return null;
    try {
        const padded = rawMessage.padEnd(Math.ceil(rawMessage.length / 4) * 4, '=');
        return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'));
    } catch {
        return null;
    }
};

export const displayNameFromEnvelope = (env) => {
    if (!env || typeof env !== 'object') return null;
    const asLabel = (v) => {
        if (typeof v !== 'string') return null;
        const t = v.trim();
        if (!t || /^\d+$/.test(t)) return null;
        return t;
    };
    const candidates = [
        env.username, env.user_name, env.display_name, env.displayName, env.screen_name,
        env.screenName, env.name, env.from_user, env.fromUser, env.senderName,
        env.sender_username, env.avatar_name, env.avatarName,
    ];
    for (const v of candidates) {
        const n = asLabel(v);
        if (n) return n;
    }
    if (env.user && typeof env.user === 'object') {
        const u = env.user;
        const n = asLabel(u.username || u.display_name || u.displayName || u.name || u.screen_name);
        if (n) return n;
    }
    if (env.sender && typeof env.sender === 'object') {
        const s = env.sender;
        const n = asLabel(s.username || s.display_name || s.displayName || s.name);
        if (n) return n;
    }
    return null;
};

export const collectBotMentionAliases = (botUsername, botDisplayName) => {
    const aliases = new Set();
    const add = (raw) => {
        if (raw == null || typeof raw !== 'string') return;
        const t = raw.trim();
        if (!t) return;
        aliases.add(t.toLowerCase());
        const norm = normalizeImvuUsername(t);
        if (norm && typeof norm === 'string') aliases.add(norm.toLowerCase());
    };
    add(botUsername);
    add(botDisplayName);
    return [...aliases].filter((a) => a.length > 0);
};

export const messageMentionsBot = (chatText, aliases) => {
    const text = typeof chatText === 'string' ? chatText : '';
    if (!text.trim()) return false;
    const lower = text.toLowerCase();
    for (const alias of aliases) {
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

/** Whole message is only @bot or bot name — skip /api/lurk (avoids confused third-person replies). */
export const isOnlyBotNameMention = (chatText, aliases) => {
    const t = String(chatText ?? '').trim();
    if (!t) return false;
    const stripped = t.replace(/^@+\s*/i, '').trim().toLowerCase();
    for (const alias of aliases) {
        if (!alias) continue;
        if (stripped === String(alias).toLowerCase()) return true;
    }
    return false;
};

export const welcomeHandleKey = (displayName) => {
    const h = String(normalizeImvuUsername(displayName) || '').trim().toLowerCase();
    if (!h || EXCLUDED_HANDLES.includes(h)) return null;
    return h;
};

export const getVisitorListForSync = (lastUserMap) => {
    const out = new Set();
    for (const v of lastUserMap.values()) {
        if (v == null || v === '') continue;
        const s = String(normalizeImvuUsername(String(v))).trim().toLowerCase();
        if (!s || EXCLUDED_HANDLES.includes(s)) continue;
        out.add(s);
    }
    return [...out].slice(0, 50);
};
