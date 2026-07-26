/**
 * Bot self-introduction after a visible room join.
 * Replaces the old IMVU_WS_TEST_MESSAGE smoke-test chat.
 */

const introTemplates = [
    (bot, room) =>
        `*clears throat* Behold: ${bot} has entered ${room}. Chat me with .hi (or say sugar). Commands: !help.`,
    (bot, room) =>
        `${bot} just crashed the party in ${room}. Talk to me with a leading . — like .hi — or say sugar. !help for commands.`,
    (bot, room) =>
        `Breaking news from ${room}: ${bot} is in chat. Start with . to talk (e.g. .how's it going) · or say sugar · !help`,
    (bot, room) =>
        `${bot} spawned in ${room}. Side quest: type .hi to chat, or sugar, or !help before chaos finds you.`,
    (bot, room) =>
        `Plot twist — ${bot} walked into ${room}. Yes I'm real. Whisper .hey or say sugar to chat · !help for cmds.`,
    (bot, room) =>
        `${room}, meet ${bot}. Chat with . (silent ask, like .hi) or say sugar. Or, y'know… type !help.`,
    (bot, room) =>
        `I, ${bot}, arrived in ${room} fashionably late. Poke me with .hi / sugar — commands via !help.`,
    (bot, room) =>
        `${bot} slid into ${room} with no script. Start a line with . to talk to me, or say sugar. !help works too.`,
    (bot, room) =>
        `Attention ${room}: ${bot} is online. Chat: .hi or sugar. Commands: !help. Therapy not included.`,
    (bot, room) =>
        `${bot} bootstrapped into ${room}. If I glow, that's vibes. Chat me with . or sugar · !help for the menu.`,
    (bot, room) =>
        `Guess who joined ${room}? ${bot}. No autographs — try .hi, say sugar, or !help.`,
    (bot, room) =>
        `${bot} entered ${room} so hard the furniture flinched. Chat: leading . (e.g. .sup) or sugar · !help`,
    (bot, room) =>
        `Hello ${room}, it's ${bot}. I bring .chat (start with .), sugar mentions, chaos, and !help.`,
    (bot, room) =>
        `${bot} clocked into ${room}. Fun mode on. Talk with .hi / sugar · commands with !help.`,
    (bot, room) =>
        `A wild ${bot} appeared in ${room}! It used .hi. You can also say sugar or !help. Super effective.`,
    (bot, room) =>
        `${room} upgrade: ${bot} is here. Start with . to chat silently, or say sugar. !help for commands.`,
    (bot, room) =>
        `It's me, ${bot}, barging into ${room}. Rent is entertainment — pay with .hi, sugar, or !help.`,
    (bot, room) =>
        `${bot} arrived in ${room} with snacks + sarcasm. Chat: .message or sugar · menu: !help.`,
    (bot, room) =>
        `Did somebody order a bot? Too late — ${bot} delivered to ${room}. Try .hi, sugar, or !help.`,
    (bot, room) =>
        `${bot} is live in ${room}. Can't do taxes. Can do .hi / sugar chat and !help.`,
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
