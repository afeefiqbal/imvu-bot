/**
 * Parse `!command` / `*command` room chat lines (case-insensitive command word).
 * @param {string} text
 * @returns {{ cmd: string, args: string, raw: string } | null}
 */
export function parseRoomCommand(text) {
    const raw = String(text || '').trim();
    const m = raw.match(/^[!*](\w+)(?:\s+(.*))?$/is);
    if (!m) return null;
    return {
        cmd: m[1].toLowerCase(),
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
