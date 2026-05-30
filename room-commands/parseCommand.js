/** LurkBot-style aliases and common typos → canonical command name. */
const COMMAND_ALIASES = {
    newgreetings: 'newgreeting',
    newgreeting: 'newgreeting',
    autogreeet: 'autogreet',
    autgreet: 'autogreet',
    roomcheck: 'roomcheck',
    maxscaler: 'maxscaler',
    maxoccupancy: 'maxoccupancy',
    minage: 'minage',
    nolurk: 'nolurk',
    command: 'help',
    commands: 'help',
    help: 'help',
    settings: 'settings',
    greeting: 'settings',
};

/**
 * Parse `!command` / `*command` room chat lines (case-insensitive command word).
 * @param {string} text
 * @returns {{ cmd: string, args: string, raw: string } | null}
 */
export function parseRoomCommand(text) {
    const raw = String(text || '').trim();
    const m = raw.match(/^[!*](\w+)(?:\s+(.*))?$/is);
    if (!m) return null;
    const word = m[1].toLowerCase();
    const cmd = COMMAND_ALIASES[word] || word;
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
