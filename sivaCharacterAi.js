/**
 * Sugar AI triggers (case-insensitive):
 * - Message contains "sugar" (e.g. sugar, !sugar, SugarNix), OR
 * - Message starts with "." then a letter (e.g. ".hi", "...how are you")
 *   Dots-only ("...", "..", "....") → no reply
 *
 * No open follow-up session — only those messages get an AI reply.
 */

const HAS_SUGAR_COMMAND = /\!sugar\b/i;
const HAS_NEW_SUGAR_COMMAND = /\!newsugar\b/i;
/** Any word that contains "sugar" anywhere inside it */
const HAS_SUGAR_SUBSTRING = /sugar/i;
/** Letter after leading dots (Latin or Malayalam) */
const LETTER_AFTER_DOTS = /^\.+\s*[a-zA-Z\u0D00-\u0D7F]/;
const ENDS_SESSION_COMMAND = /\!endsugar\b|\!endsiva\b/i;
const NEW_THREAD_COMMAND = /\!newsugar\b|\!newsiva\b/i;

/** roomId:senderId -> last activity timestamp (optional; not used for auto-follow-ups) */
const sivaSessionLastAt = new Map();

function sessionKey(roomId, senderId) {
    return `${String(roomId || '').trim()}:${String(senderId || '')}`;
}

function sessionTtlMs() {
    const n = parseInt(String(process.env.SIVA_SESSION_TTL_MS || '900000'), 10);
    return Number.isFinite(n) && n > 0 ? n : 900000;
}

export function messageInvokesSivaCharacterAi(text) {
    if (typeof text !== 'string' || !text.trim()) {
        return false;
    }
    const t = text.trim();
    // ".hi" / "...hello" → yes; "..." / ".." / "...." → no
    if (t.startsWith('.')) {
        return LETTER_AFTER_DOTS.test(t);
    }
    return HAS_SUGAR_SUBSTRING.test(text);
}

export function messageEndsSivaSession(text) {
    return typeof text === 'string' && ENDS_SESSION_COMMAND.test(text);
}

export function messageStartsNewSivaThread(text) {
    return typeof text === 'string' && NEW_THREAD_COMMAND.test(text);
}

/** Room commands (!move, !help, …) should not continue a Siva Q&A thread. */
export function isLikelyRoomCommand(text) {
    if (typeof text !== 'string') {
        return false;
    }
    const t = text.trim();
    if (!t.startsWith('!')) {
        return false;
    }
    if (ENDS_SESSION_COMMAND.test(t) || NEW_THREAD_COMMAND.test(t) || HAS_SUGAR_COMMAND.test(t) || HAS_NEW_SUGAR_COMMAND.test(t)) {
        return false;
    }
    return /^![a-z]/i.test(t);
}

export function markSivaSessionActive(roomId, senderId) {
    if (roomId == null || senderId == null) {
        return;
    }
    sivaSessionLastAt.set(sessionKey(roomId, senderId), Date.now());
    if (sivaSessionLastAt.size > 500) {
        pruneSivaSessions();
    }
}

export function clearSivaSession(roomId, senderId) {
    if (roomId == null || senderId == null) {
        return;
    }
    sivaSessionLastAt.delete(sessionKey(roomId, senderId));
}

export function isSivaSessionActive(roomId, senderId) {
    if (roomId == null || senderId == null) {
        return false;
    }
    const key = sessionKey(roomId, senderId);
    const last = sivaSessionLastAt.get(key);
    if (last == null) {
        return false;
    }
    if (Date.now() - last > sessionTtlMs()) {
        sivaSessionLastAt.delete(key);
        return false;
    }
    return true;
}

function pruneSivaSessions() {
    const cutoff = Date.now() - sessionTtlMs();
    for (const [key, ts] of sivaSessionLastAt) {
        if (ts < cutoff) {
            sivaSessionLastAt.delete(key);
        }
    }
}

/**
 * Remove wake tokens so the model only sees the user's intent.
 */
export function stripSivaCharacterAiTriggers(message) {
    if (typeof message !== 'string') {
        return '';
    }
    let q = message.trim();
    // Silent ask: ".how do I …" / "...hello" → "how do I …" / "hello"
    if (q.startsWith('.')) {
        q = q.replace(/^\.+/, '').trim();
    }
    q = q.replace(/\!endsugar\b/gi, ' ');
    q = q.replace(/\!endsiva\b/gi, ' ');
    q = q.replace(/\!newsiva\b/gi, ' ');
    // Strip any token that contains "sugar" (sugar, !sugar, SugarNix, …)
    q = q.replace(/\S*sugar\S*/gi, ' ');
    q = q.replace(/\s+/g, ' ').trim();
    return q;
}
