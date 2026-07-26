import { COMMAND_CATALOG, canonicalCommand, commandsForCategory, commandInfo } from './catalog.js';
import { botDiscordInviteUrl } from './discordInvite.js';

function formatCommandLine(names) {
    return names.join(' - ');
}

/**
 * LurkBot-style help: general list, admin list, info hint (+ optional Discord).
 * @param {{ discordUrl?: string, botName?: string }} [opts]
 * @returns {string[]}
 */
export function buildHelpMessages(opts = {}) {
    const general = commandsForCategory('general');
    const admin = commandsForCategory('admin');
    const messages = [
        `Command list:\n${formatCommandLine(general)}`,
        `Admin command list:\n${formatCommandLine(admin)}`,
    ];

    const discordUrl = botDiscordInviteUrl(opts.discordUrl);
    const botLabel = String(opts.botName || 'the bot').trim();
    let footer =
        "Type '!info !command' to see more about a specific command. " +
        "For example: '!info !mystats'. Commands can also be sent in a whisper.";
    if (discordUrl) {
        footer += ` Check out ${botLabel}'s Discord for even more information:\n${discordUrl}`;
    }
    messages.push(footer);
    return messages;
}

/**
 * @param {string} rawArgs e.g. "!mystats" or "mystats"
 * @returns {string | null}
 */
export function buildInfoMessage(rawArgs) {
    const token = String(rawArgs || '').trim().replace(/^[!*]/, '');
    if (!token) {
        return "Usage: !info !command — for example: !info !mystats";
    }

    const key = canonicalCommand(token);
    const def = commandInfo(key);
    if (!def) {
        return `Unknown command: !${token}. Type !help for the full list.`;
    }

    const usage = def.usage || `!${key}`;
    return `!${key}: ${def.summary}\nUsage: ${usage}`;
}

/** Commands whose handlers live in index.js (admin/settings). */
export const ADMIN_HANDLER_COMMANDS = new Set([
    'move',
    'newgreeting',
    'autogreet',
    'scale',
    'maxscaler',
    'minage',
    'maxoccupancy',
    'nolurk',
    'roommusic',
    'commands',
    'intro',
    'roomcheck',
    'roomsettings',
    'maxkbs',
    'outfit',
    'seat',
]);

export { COMMAND_CATALOG, canonicalCommand };
