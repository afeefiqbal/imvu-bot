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
    if (m.endsWith(':messages')) return true;
    return false;
};

/** Room chat WS queue: legacy `/chat/123` or Next `inv:/chat/chat-roomId-instance`. */
export const isImvuRoomChatQueue = (queue) => {
    const q = String(queue || '');
    if (!q) return false;
    if (q.startsWith('/chat/')) return true;
    if (/^inv:\/chat\//i.test(q)) return true;
    return false;
};

/**
 * When multiple IMVU room tabs attach CDP, some builds deliver the same WS frames to every session.
 * Only handle chat (music, mentions, logs) if this frame's queue names our room (e.g. chat-261755692-875-…).
 * @param {string} queue
 * @param {string} roomId dashboard slug e.g. 261755692-875 or room-261755692-875
 * @returns {boolean} false when the queue clearly targets a different room
 */
export const roomQueueBelongsToRoom = (queue, roomId) => {
    const key = String(roomId || '')
        .trim()
        .replace(/^room-/i, '')
        .replace(/[^0-9-]/g, '');
    if (!key || !/^\d+-\d+$/.test(key)) return true;
    const q = String(queue || '');
    if (!q || !isImvuRoomChatQueue(q)) return true;
    const found = [];
    const re = /(?:chat|room)-(\d+-\d+)/gi;
    let m;
    while ((m = re.exec(q)) !== null) {
        found.push(m[1]);
    }
    if (found.length === 0) return true;
    return found.includes(key);
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
