/**
 * Bridge Sugar / "." AI chat → real music commands (!play / !skip / …).
 * The model often *suggests* commands in prose; this module extracts and/or
 * maps clear user intents so roomChatCommandHandler can run them.
 */

const MUSIC_CMD_RE =
    /!(play|p|add|a|skip|stop|pause|resume|next)\b(?:\s+(?:"([^"]+)"|'([^']+)'|([^\n.!?]{1,160})))?/gi;

/** Vague “play something nice” — leave song choice to the model reply. */
const VAGUE_PLAY_QUERY =
    /^(some(\s+song)?|a\s+song|any(\s+song)?|something|music|a\s+track|tracks?)(\s+(to|that|for|please).*)?$/i;

/**
 * Map a sugar-stripped user message to an executable music command line, or null.
 * @param {string} text
 * @returns {string|null}
 */
export function resolveMusicIntentCommand(text) {
    const t = String(text || '')
        .trim()
        .replace(/\s+/g, ' ');
    if (!t) return null;

    if (
        /^(please\s+)?(you\s+)?(can\s+you\s+)?(skip|next)(\s+(this|the)?\s*(song|track|it|one)?)?[!?.]*$/i.test(
            t,
        )
    ) {
        return '!skip';
    }
    if (
        /^(please\s+)?(you\s+)?(can\s+you\s+)?(stop|end)(\s+(the\s+)?(music|song|track|playback|radio))?[!?.]*$/i.test(
            t,
        )
    ) {
        return '!stop';
    }
    if (/^(please\s+)?(pause)(\s+(the\s+)?(music|song|track))?[!?.]*$/i.test(t)) {
        return '!pause';
    }
    if (/^(please\s+)?(resume|unpause|continue)(\s+(the\s+)?(music|song|track))?[!?.]*$/i.test(t)) {
        return '!resume';
    }

    const play = /^(please\s+)?(you\s+)?(can\s+you\s+)?(play|put on|queue)\s+(.+?)[!?.]*$/i.exec(t);
    if (play) {
        const query = String(play[5] || '')
            .trim()
            .replace(/^["']|["']$/g, '');
        if (!query || VAGUE_PLAY_QUERY.test(query)) {
            return null;
        }
        // "play some song to lift my mood" already caught by vague; also soft-mood phrasing:
        if (/^(some|a|any)\b/i.test(query) && /\b(mood|happy|uplift|depress|feel)/i.test(query)) {
            return null;
        }
        const verb = play[4].toLowerCase();
        if (verb === 'queue' || verb === 'add') {
            return `!add ${query}`;
        }
        return `!play ${query}`;
    }

    // Bare "!skip" / "skip" after sugar strip of ".skip"
    if (/^!?(skip|next|stop|pause|resume)$/i.test(t)) {
        return t.startsWith('!') ? t.toLowerCase() : `!${t.toLowerCase()}`;
    }

    return null;
}

/**
 * Pull music bang-commands out of an AI chat reply.
 * @param {string} reply
 * @returns {string[]}
 */
export function extractMusicCommandsFromAiReply(reply) {
    const raw = String(reply || '');
    if (!raw.includes('!')) return [];

    const out = [];
    const seen = new Set();
    let m;
    MUSIC_CMD_RE.lastIndex = 0;
    while ((m = MUSIC_CMD_RE.exec(raw)) !== null) {
        const head = String(m[1] || '').toLowerCase();
        const arg = String(m[2] || m[3] || m[4] || '')
            .trim()
            .replace(/\s+by\s+.+$/i, '') // "!play Happy by Pharrell" → Happy
            .replace(/[,;:]+$/, '')
            .trim();

        let line;
        if (head === 'play' || head === 'p') {
            if (!arg) continue;
            line = `!play ${arg}`;
        } else if (head === 'add' || head === 'a') {
            if (!arg) continue;
            line = `!add ${arg}`;
        } else if (head === 'skip' || head === 'next') {
            line = '!skip';
        } else if (head === 'stop') {
            line = '!stop';
        } else if (head === 'pause') {
            line = '!pause';
        } else if (head === 'resume') {
            line = '!resume';
        } else {
            continue;
        }

        const key = line.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(line);
        // One action per AI reply — avoids "!play … then !skip" running both.
        break;
    }
    return out;
}

/**
 * Run music commands via the room handler. Returns how many were handled.
 * @param {{ roomChatCommandHandler?: Function, roomId?: string }} ctx
 * @param {string[]} commands
 * @param {{ senderLabel?: string, senderId?: string|number }} meta
 */
export async function runMusicCommandsFromAi(ctx, commands, meta = {}) {
    const handler = ctx?.roomChatCommandHandler;
    if (typeof handler !== 'function' || !Array.isArray(commands) || !commands.length) {
        return 0;
    }
    let handled = 0;
    for (const text of commands) {
        try {
            const ok = await handler({
                text,
                senderLabel: meta.senderLabel,
                senderId: meta.senderId,
                isSelf: false,
            });
            if (ok) {
                handled += 1;
                console.log(
                    `[AI-MUSIC][${ctx.roomId || '?'}] ${meta.senderLabel || meta.senderId}: ${text}`,
                );
            }
        } catch (e) {
            console.warn(`[AI-MUSIC] failed “${text}”: ${e?.message || e}`);
        }
    }
    return handled;
}
