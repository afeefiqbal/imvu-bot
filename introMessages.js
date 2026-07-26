/**
 * Bot self-introduction after a visible room join.
 * Replaces the old IMVU_WS_TEST_MESSAGE smoke-test chat.
 */

const introTemplates = [
    (bot, room) =>
        `*clears throat* Behold: ${bot} has entered ${room}. To chat, use "." (e.g. .hi) or say sugar. Commands: !help.`,
    (bot, room) =>
        `${bot} just crashed the party in ${room}. To chat, use "." — like .hi — or say sugar. !help for commands.`,
    (bot, room) =>
        `Breaking news from ${room}: ${bot} is in chat. To talk to me, use "." (e.g. .how's it going) · or say sugar · !help`,
    (bot, room) =>
        `${bot} spawned in ${room}. To chat, use "." (.hi), say sugar, or type !help before chaos finds you.`,
    (bot, room) =>
        `Plot twist — ${bot} walked into ${room}. Yes I'm real. To chat, use "." or say sugar · !help for cmds.`,
    (bot, room) =>
        `${room}, meet ${bot}. To chat, use "." (silent ask, like .hi) or say sugar. Or type !help.`,
    (bot, room) =>
        `I, ${bot}, arrived in ${room} fashionably late. To chat, use "." / sugar — commands via !help.`,
    (bot, room) =>
        `${bot} slid into ${room} with no script. To chat, use "." at the start of your line, or say sugar. !help works too.`,
    (bot, room) =>
        `Attention ${room}: ${bot} is online. To chat, use "." (e.g. .hi) or sugar. Commands: !help.`,
    (bot, room) =>
        `${bot} bootstrapped into ${room}. If I glow, that's vibes. To chat, use "." or sugar · !help for the menu.`,
    (bot, room) =>
        `Guess who joined ${room}? ${bot}. No autographs — to chat, use "." (.hi), say sugar, or !help.`,
    (bot, room) =>
        `${bot} entered ${room} so hard the furniture flinched. To chat, use "." (e.g. .sup) or sugar · !help`,
    (bot, room) =>
        `Hello ${room}, it's ${bot}. To chat, use "." or say sugar. Commands: !help.`,
    (bot, room) =>
        `${bot} clocked into ${room}. Fun mode on. To chat, use "." / sugar · commands with !help.`,
    (bot, room) =>
        `A wild ${bot} appeared in ${room}! To chat, use "." (.hi), say sugar, or !help. Super effective.`,
    (bot, room) =>
        `${room} upgrade: ${bot} is here. To chat, use "." for a silent ask, or say sugar. !help for commands.`,
    (bot, room) =>
        `It's me, ${bot}, barging into ${room}. To chat, use "." (.hi), sugar, or !help.`,
    (bot, room) =>
        `${bot} arrived in ${room} with snacks + sarcasm. To chat, use "." or sugar · menu: !help.`,
    (bot, room) =>
        `Did somebody order a bot? Too late — ${bot} delivered to ${room}. To chat, use "." , sugar, or !help.`,
    (bot, room) =>
        `${bot} is live in ${room}. Can't do taxes. To chat, use "." / sugar — or !help.`,
];

/** Always appended so custom intros still teach the wake. */
const DOT_CHAT_TIP = ' To chat, use "." (e.g. .hi) or say sugar.';

function ensureDotChatTip(message) {
    const text = String(message || '').trim();
    if (!text) return null;
    if (/\buse\s+"?\."?/i.test(text) || /leading\s+\./i.test(text) || /\.hi\b/i.test(text)) {
        return text.slice(0, 500);
    }
    return `${text}${DOT_CHAT_TIP}`.slice(0, 500);
}

const random = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * @param {string} template
 * @param {{ bot?: string, room?: string }} vars
 */
export function formatIntroMessage(template, { bot = 'the bot', room = 'the room' } = {}) {
    const t = String(template || '').trim();
    if (!t) return null;
    return ensureDotChatTip(
        t
            .replace(/\{bot\}/gi, bot || 'the bot')
            .replace(/\{room\}/gi, room || 'the room')
    );
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

    return ensureDotChatTip(random(introTemplates)(bot, room));
}

export function introMessageDelayMs() {
    const intro = Number(process.env.IMVU_WS_INTRO_MESSAGE_DELAY_MS);
    if (Number.isFinite(intro) && intro >= 0) return intro;
    const legacy = Number(process.env.IMVU_WS_TEST_MESSAGE_DELAY_MS);
    if (Number.isFinite(legacy) && legacy >= 0) return legacy;
    return 1500;
}
