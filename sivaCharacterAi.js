/**
 * Character.AI "Siva" triggers — chat commands and name mentions.
 * Matches: !siva, !s (not !siva), whole-word siva (case-insensitive).
 *
 * After the first trigger, follow-up messages in the same room (no !siva needed)
 * stay in the Siva thread until the session expires or the user sends !endsiva.
 */

const HAS_SIVA_COMMAND = /\!siva\b/i;
const HAS_NEW_SIVA_COMMAND = /\!newsiva\b/i;
/** !s as its own token — avoids matching the !s prefix of !siva */
const HAS_SHORT_S_COMMAND = /(?:^|[\s,])!s(?:$|[\s,])/i;
const HAS_SIVA_WORD = /\bsiva\b/i;
const ENDS_SIVA_COMMAND = /\!endsiva\b/i;
const NEW_SIVA_THREAD_COMMAND = /\!newsiva\b/i;

/** roomId:senderId -> last activity timestamp */
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
    if (HAS_SIVA_COMMAND.test(text) || HAS_NEW_SIVA_COMMAND.test(text)) {
        return true;
    }
    if (HAS_SHORT_S_COMMAND.test(text)) {
        return true;
    }
    if (HAS_SIVA_WORD.test(text)) {
        return true;
    }
    return false;
}

export function messageEndsSivaSession(text) {
    return typeof text === 'string' && ENDS_SIVA_COMMAND.test(text);
}

export function messageStartsNewSivaThread(text) {
    return typeof text === 'string' && NEW_SIVA_THREAD_COMMAND.test(text);
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
    if (ENDS_SIVA_COMMAND.test(t) || NEW_SIVA_THREAD_COMMAND.test(t)) {
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
 * Remove trigger tokens so the upstream character only sees the user's intent.
 */
export function stripSivaCharacterAiTriggers(message) {
    if (typeof message !== 'string') {
        return '';
    }
    let q = message;
    q = q.replace(/\!siva\b/gi, ' ');
    q = q.replace(/\!newsiva\b/gi, ' ');
    q = q.replace(/\!endsiva\b/gi, ' ');
    q = q.replace(/\bsiva\b/gi, ' ');
    q = q.replace(/(^|[\s,])!s($|[\s,])/gi, '$1 ');
    q = q.replace(/\s+/g, ' ').trim();
    return q;
}
