import { canonicalCommand } from './catalog.js';

export const JOIN_COMMAND_USAGE =
    'Usage: !join <room-id> — bot invites you to that room (bot must already be there)';

/**
 * Native IMVU client wires that appear in the chat stream but are not user chat
 * and must not be treated as bot/music commands.
 * Music still uses `*play` / `*add` / etc. — those are intentionally excluded.
 */
const IMVU_CLIENT_PROTOCOL_RE =
    /^\*(?:msg(?:\s|$)|use(?:\s|$)|putOnOutfit(?:\s|$)|seat(?:\s|$)|accept(?:\s|$)|boot(?:\s|$)|reject(?:\s|$)|imvu:|SeatAssignment\b)/i;

/**
 * @param {string} text
 * @returns {boolean}
 */
export function isImvuClientProtocolText(text) {
    const raw = String(text || '').trim();
    if (!raw.startsWith('*')) return false;
    return IMVU_CLIENT_PROTOCOL_RE.test(raw);
}

/** Cmds that only exist as IMVU client wires, never as Sugar room commands. */
const IMVU_PROTOCOL_PARSED_CMDS = new Set(['msg', 'use', 'putonoutfit']);

/**
 * True when a parsed room-command looks like an IMVU client wire (`*msg`, `*use`, …).
 * @param {{ cmd?: string, raw?: string } | null} parsed
 * @returns {boolean}
 */
export function isImvuClientProtocol(parsed) {
    if (!parsed) return false;
    if (parsed.raw && isImvuClientProtocolText(parsed.raw)) return true;
    const cmd = String(parsed.cmd || '').toLowerCase();
    return IMVU_PROTOCOL_PARSED_CMDS.has(cmd);
}

/**
 * Parse `!command` room chat lines (case-insensitive command word).
 *
 * Leading `*` is not accepted here — IMVU’s client uses `*` for protocol
 * (e.g. `*seat 4`, `*accept …`), and treating those as bot commands caused
 * false “owner or mods only” replies when people just sat down. Music still
 * accepts `*` / `!` in its own parser.
 *
 * @param {string} text
 * @returns {{ cmd: string, args: string, raw: string } | null}
 */
export function parseRoomCommand(text) {
    const raw = String(text || '').trim();
    if (raw.startsWith('*')) return null;
    const m = raw.match(/^!(\w+)(?:\s+(.*))?$/is);
    if (!m) return null;
    const word = m[1].toLowerCase();
    const cmd = canonicalCommand(word);
    return {
        cmd,
        args: (m[2] || '').trim(),
        raw,
    };
}

export function parseOnOff(arg) {
    const v = String(arg || '').trim().toLowerCase();
    if (!v) return null;
    if (v === 'on' || v === '1' || v === 'true' || v === 'yes') return true;
    if (v === 'off' || v === '0' || v === 'false' || v === 'no') return false;
    return null;
}
