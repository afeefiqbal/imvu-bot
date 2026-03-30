/**
 * Character.AI "Siva" triggers — chat commands and name mentions.
 * Matches: !siva, !s (not !siva), whole-word siva (case-insensitive).
 */

const HAS_SIVA_COMMAND = /\!siva\b/i;
/** !s as its own token — avoids matching the !s prefix of !siva */
const HAS_SHORT_S_COMMAND = /(?:^|[\s,])!s(?:$|[\s,])/i;
const HAS_SIVA_WORD = /\bsiva\b/i;

export function messageInvokesSivaCharacterAi(text) {
    if (typeof text !== 'string' || !text.trim()) {
        return false;
    }
    if (HAS_SIVA_COMMAND.test(text)) {
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

/**
 * Remove trigger tokens so the upstream character only sees the user's intent.
 */
export function stripSivaCharacterAiTriggers(message) {
    if (typeof message !== 'string') {
        return '';
    }
    let q = message;
    q = q.replace(/\!siva\b/gi, ' ');
    q = q.replace(/\bsiva\b/gi, ' ');
    q = q.replace(/(^|[\s,])!s($|[\s,])/gi, '$1 ');
    q = q.replace(/\s+/g, ' ').trim();
    return q;
}
