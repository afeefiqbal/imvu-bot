/**
 * Bot self-introduction after a visible room join.
 * Replaces the old IMVU_WS_TEST_MESSAGE smoke-test chat.
 */

const introTemplates = [
    (bot, room) => `*clears throat* Behold: ${bot} has entered ${room}. Applause is optional. Tips are encouraged.`,
    (bot, room) => `${bot} just crashed the party in ${room}. Don't worry — I only bite if you skip !help.`,
    (bot, room) => `Breaking news from ${room}: ${bot} is officially in the chat. Remaining calm is your problem.`,
    (bot, room) => `${bot} has spawned in ${room}. Side quest unlocked: try !help before chaos finds you.`,
    (bot, room) => `Plot twist — ${bot} just walked into ${room}. Yes, the rumors are true. The bot is real.`,
    (bot, room) => `${room}, meet ${bot}. ${bot}, meet ${room}. Now kiss. Or, y'know… type !help.`,
    (bot, room) => `I, ${bot}, have arrived in ${room} fashionably late and emotionally unprepared.`,
    (bot, room) => `${bot} slid into ${room} like a main character with no script. Someone hand me !help.`,
    (bot, room) => `Attention ${room}: ${bot} is online and slightly unhinged. Commands via !help. Therapy not included.`,
    (bot, room) => `${bot} just bootstrapped into ${room}. If I start glowing, that's not a feature — that's vibes.`,
    (bot, room) => `Guess who just joined ${room}? It's ${bot}. No autographs. Maybe !help though.`,
    (bot, room) => `${bot} entered ${room} so hard the furniture flinched. Type !help before I start freestyling.`,
    (bot, room) => `Hello ${room}, it's ${bot}. I bring commands, chaos, and approximately zero chill.`,
    (bot, room) => `${bot} has clocked into ${room}. Manager mode: disabled. Fun mode: dangerously enabled.`,
    (bot, room) => `A wild ${bot} appeared in ${room}! It used !help. It's super effective.`,
    (bot, room) => `${room} just got an upgrade: ${bot} is here. Your Wi-Fi may feel judged.`,
    (bot, room) => `It's me, ${bot}, barging into ${room} like rent is due and the rent is entertainment.`,
    (bot, room) => `${bot} arrived in ${room} with snacks, sarcasm, and a full command menu (!help).`,
    (bot, room) => `Did somebody order a bot? Too late — ${bot} already delivered myself to ${room}.`,
    (bot, room) => `${bot} is live in ${room}. I can't do your taxes, but I can do !help.`,
];

const random = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * @param {string} template
 * @param {{ bot?: string, room?: string }} vars
 */
export function formatIntroMessage(template, { bot = 'the bot', room = 'the room' } = {}) {
    const t = String(template || '').trim();
    if (!t) return null;
    return t
        .replace(/\{bot\}/gi, bot || 'the bot')
        .replace(/\{room\}/gi, room || 'the room')
        .slice(0, 500);
}

/**
 * Resolve the chat line to send after visibility bootstrap.
 * - IMVU_WS_INTRO_ENABLED=0 → disabled
 * - IMVU_WS_INTRO_MESSAGE set → custom template ({bot}, {room})
 * - else a built-in intro template
 *
 * @param {{ bot?: string, room?: string }} [vars]
 * @returns {string | null}
 */
export function resolveIntroMessage(vars = {}) {
    const enabledRaw = String(process.env.IMVU_WS_INTRO_ENABLED ?? '1').trim().toLowerCase();
    if (enabledRaw === '0' || enabledRaw === 'false' || enabledRaw === 'off' || enabledRaw === 'no') {
        return null;
    }

    const bot =
        String(vars.bot || process.env.BOT_NAME || 'the bot').trim() || 'the bot';
    const room = String(vars.room || 'the room').trim() || 'the room';

    const custom = String(process.env.IMVU_WS_INTRO_MESSAGE || '').trim();
    if (custom) return formatIntroMessage(custom, { bot, room });

    return random(introTemplates)(bot, room);
}

export function introMessageDelayMs() {
    const intro = Number(process.env.IMVU_WS_INTRO_MESSAGE_DELAY_MS);
    if (Number.isFinite(intro) && intro >= 0) return intro;
    const legacy = Number(process.env.IMVU_WS_TEST_MESSAGE_DELAY_MS);
    if (Number.isFinite(legacy) && legacy >= 0) return legacy;
    return 1500;
}
