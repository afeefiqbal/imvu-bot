/**
 * Sugar AI triggers (case-insensitive):
 * - Standalone wake word "sugar" / "!sugar" (NOT SugarNix / sugarnix / sugary), OR
 * - Message starts with "." then a letter (e.g. ".hi", "...how are you")
 *   Dots-only ("...", "..", "....") → no reply
 *
 * No open follow-up session — only those messages get an AI reply.
 *
 * Spam abuse: flood / near-duplicate AI wakes permanently block that avatar
 * from /api/siva-chat and /api/lurk (persisted across restarts).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HAS_SUGAR_COMMAND = /\!sugar\b/i;
const HAS_NEW_SUGAR_COMMAND = /\!newsugar\b/i;
/** Whole-word "sugar" only — ignores SugarNix / sugarnix / other compounds. */
const HAS_SUGAR_WORD = /\bsugar\b/i;
/** Letter after leading dots (Latin or Malayalam) */
const LETTER_AFTER_DOTS = /^\.+\s*[a-zA-Z\u0D00-\u0D7F]/;
const ENDS_SESSION_COMMAND = /\!endsugar\b|\!endsiva\b/i;
const NEW_THREAD_COMMAND = /\!newsugar\b|\!newsiva\b/i;

/** roomId:senderId -> last activity timestamp (optional; not used for auto-follow-ups) */
const sivaSessionLastAt = new Map();

/** @type {Map<string, Array<{ at: number, norm: string }>>} */
const aiAttemptHistory = new Map();
/** @type {Set<string>} */
const aiSpamBlocked = new Set();
let aiSpamBlocklistLoaded = false;

function aiSpamWindowMs() {
    const n = parseInt(String(process.env.AI_SPAM_WINDOW_MS || '60000'), 10);
    return Number.isFinite(n) && n > 0 ? n : 60_000;
}

function aiSpamMaxAttempts() {
    const n = parseInt(String(process.env.AI_SPAM_MAX_ATTEMPTS || '8'), 10);
    return Number.isFinite(n) && n > 0 ? n : 8;
}

function aiSpamDupMax() {
    const n = parseInt(String(process.env.AI_SPAM_DUP_MAX || '5'), 10);
    return Number.isFinite(n) && n > 0 ? n : 5;
}

function aiSpamBlocklistPath() {
    const override = String(process.env.AI_SPAM_BLOCKLIST_PATH || '').trim();
    if (override) return resolve(override);
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, 'data', 'ai-spam-blocklist.json');
}

function normalizeAiSpamText(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240);
}

function loadAiSpamBlocklist() {
    if (aiSpamBlocklistLoaded) return;
    aiSpamBlocklistLoaded = true;
    try {
        const path = aiSpamBlocklistPath();
        if (!existsSync(path)) return;
        const raw = JSON.parse(readFileSync(path, 'utf8'));
        const ids = Array.isArray(raw?.blocked) ? raw.blocked : Array.isArray(raw) ? raw : [];
        for (const id of ids) {
            const s = String(id || '').trim();
            if (s) aiSpamBlocked.add(s);
        }
    } catch (err) {
        console.error('[AI-SPAM] failed to load blocklist:', err?.message || err);
    }
}

function persistAiSpamBlocklist() {
    try {
        const path = aiSpamBlocklistPath();
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(
            path,
            JSON.stringify(
                {
                    updatedAt: new Date().toISOString(),
                    blocked: [...aiSpamBlocked],
                },
                null,
                2,
            ),
            'utf8',
        );
    } catch (err) {
        console.error('[AI-SPAM] failed to persist blocklist:', err?.message || err);
    }
}

export function isAiSpamBlocked(senderId) {
    loadAiSpamBlocklist();
    const id = String(senderId ?? '').trim();
    if (!id) return false;
    return aiSpamBlocked.has(id);
}

/**
 * Record an AI-bound chat attempt. Returns false when the sender is blocked
 * (already or newly) — caller must not hit Groq / Laravel AI endpoints.
 */
export function noteAiChatAttempt(senderId, text, meta = {}) {
    loadAiSpamBlocklist();
    const id = String(senderId ?? '').trim();
    if (!id) return true;
    if (aiSpamBlocked.has(id)) return false;

    const now = Date.now();
    const windowMs = aiSpamWindowMs();
    const norm = normalizeAiSpamText(text);
    const hist = (aiAttemptHistory.get(id) || []).filter((e) => now - e.at <= windowMs);
    hist.push({ at: now, norm });
    aiAttemptHistory.set(id, hist);

    if (aiAttemptHistory.size > 2000) {
        const oldest = aiAttemptHistory.keys().next().value;
        aiAttemptHistory.delete(oldest);
    }

    const dupCount = norm
        ? hist.filter((e) => e.norm === norm).length
        : 0;
    const flooded = hist.length >= aiSpamMaxAttempts();
    const dupFlood = dupCount >= aiSpamDupMax();

    if (!flooded && !dupFlood) return true;

    aiSpamBlocked.add(id);
    aiAttemptHistory.delete(id);
    persistAiSpamBlocklist();
    const reason = dupFlood ? `duplicate×${dupCount}` : `flood×${hist.length}`;
    const label = meta.senderLabel ? ` (${meta.senderLabel})` : '';
    console.warn(
        `[AI-SPAM] permanently blocked avatar ${id}${label} — ${reason} in ${Math.round(windowMs / 1000)}s; no more AI replies`,
    );
    return false;
}

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
    return HAS_SUGAR_WORD.test(t);
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
    q = q.replace(/\!newsugar\b/gi, ' ');
    q = q.replace(/\!newsiva\b/gi, ' ');
    // Strip wake word only (keep SugarNix / other names intact if present).
    q = q.replace(/\!sugar\b/gi, ' ');
    q = q.replace(/\bsugar\b/gi, ' ');
    q = q.replace(/\s+/g, ' ').trim();
    return q;
}
