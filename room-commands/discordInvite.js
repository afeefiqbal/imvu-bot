/** Faizii / QYNT Discord profile (override with BOT_DISCORD_INVITE_URL). */
export const DEFAULT_BOT_DISCORD_URL = 'https://discord.com/users/651063231745359882';

/**
 * @param {string} [override]
 * @returns {string}
 */
export function botDiscordInviteUrl(override) {
    return String(override || process.env.BOT_DISCORD_INVITE_URL || DEFAULT_BOT_DISCORD_URL).trim();
}
