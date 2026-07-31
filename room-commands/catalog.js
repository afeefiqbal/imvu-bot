/** @typedef {'general' | 'admin'} CommandCategory */

/**
 * @typedef {Object} CommandDef
 * @property {CommandCategory} category
 * @property {string} summary
 * @property {string} [usage]
 * @property {string[]} [aliases]
 */

/** @type {Record<string, CommandDef>} */
export const COMMAND_CATALOG = {
    // —— General ——
    c2f: { category: 'general', summary: 'Convert Celsius to Fahrenheit.', usage: '!c2f 25' },
    f2c: { category: 'general', summary: 'Convert Fahrenheit to Celsius.', usage: '!f2c 77' },
    cm2in: { category: 'general', summary: 'Convert centimeters to inches.', usage: '!cm2in 180' },
    in2cm: { category: 'general', summary: 'Convert inches to centimeters.', usage: '!in2cm 70' },
    kg2lbs: { category: 'general', summary: 'Convert kilograms to pounds.', usage: '!kg2lbs 60' },
    lbs2kg: { category: 'general', summary: 'Convert pounds to kilograms.', usage: '!lbs2kg 150' },
    km2mi: { category: 'general', summary: 'Convert kilometers to miles.', usage: '!km2mi 10' },
    mi2km: { category: 'general', summary: 'Convert miles to kilometers.', usage: '!mi2km 5' },
    '8ball': { category: 'general', summary: 'Ask the magic 8-ball a yes/no question.', usage: '!8ball Will it rain?' },
    d20: { category: 'general', summary: 'Roll a 20-sided die.', usage: '!d20' },
    number: { category: 'general', summary: 'Random number (optional min max).', usage: '!number 1 100' },
    pick1: { category: 'general', summary: 'Pick one item from a comma-separated list.', usage: '!pick1 Alice, Bob, Carol' },
    pick2: { category: 'general', summary: 'Pick two different items from a list.', usage: '!pick2 Alice, Bob, Carol' },
    yesno: { category: 'general', summary: 'Random yes, no, or maybe.', usage: '!yesno' },
    odds: { category: 'general', summary: 'Random odds (1 in N).', usage: '!odds 100' },
    coinflip: { category: 'general', summary: 'Flip a coin.', usage: '!coinflip' },
    card: { category: 'general', summary: 'Draw a random playing card.', usage: '!card' },
    rockpaperscissors: {
        category: 'general',
        summary: 'Play rock paper scissors.',
        usage: '!rps rock',
        aliases: ['rps'],
    },
    bodypart: { category: 'general', summary: 'Random body part (for games).', usage: '!bodypart' },
    hello: { category: 'general', summary: 'Say hello.', usage: '!hello' },
    bye: { category: 'general', summary: 'Say goodbye.', usage: '!bye' },
    afk: { category: 'general', summary: 'Set AFK status.', usage: '!afk eating' },
    brb: { category: 'general', summary: 'Set be-right-back status.', usage: '!brb' },
    back: { category: 'general', summary: 'Clear AFK/BRB status.', usage: '!back' },
    status: { category: 'general', summary: 'Show your AFK/BRK status.', usage: '!status' },
    setstatus: { category: 'general', summary: 'Set a custom status message.', usage: '!setstatus Busy' },
    roomid: { category: 'general', summary: 'Show this room ID.', usage: '!roomid' },
    userid: { category: 'general', summary: 'Show your IMVU user id.', usage: '!userid' },
    mods: { category: 'general', summary: 'List room moderators.', usage: '!mods' },
    list: { category: 'general', summary: 'List people currently tracked in the room.', usage: '!list' },
    position: { category: 'general', summary: 'Show your seat position in the room.', usage: '!position' },
    discord: { category: 'general', summary: 'Show the bot Discord invite link.', usage: '!discord' },
    timer: { category: 'general', summary: 'Set a countdown timer.', usage: '!timer 5m' },
    lurk: { category: 'general', summary: 'Show whether Lurk/AI replies are enabled here.', usage: '!lurk' },
    rate: { category: 'general', summary: 'Rate something 1–10.', usage: '!rate pizza' },
    mystats: {
        category: 'general',
        summary: 'Your msgs, time in room, and last spoke this visit.',
        usage: '!mystats',
        aliases: ['stats'],
    },
    leaderboard: { category: 'general', summary: 'Top chatters in the room this visit.', usage: '!leaderboard' },
    nopick: { category: 'general', summary: 'Opt out of !pick1/!pick2 (on/off).', usage: '!nopick on' },
    help: {
        category: 'general',
        summary: 'List available commands.',
        usage: '!help',
        aliases: ['commands', 'command'],
    },
    info: { category: 'general', summary: 'Help for one command.', usage: '!info !mystats' },

    // —— Admin ——
    move: { category: 'admin', summary: 'Bot moves to your seat (anyone).', usage: '!move' },
    newgreeting: { category: 'admin', summary: 'Set join greeting ({room}, {user}).', usage: '!newgreeting Welcome {user}!' },
    autogreet: { category: 'admin', summary: 'Turn auto-greet on or off.', usage: '!autogreet on' },
    scale: { category: 'admin', summary: 'Turn scaler warnings on or off.', usage: '!scale on' },
    maxscaler: { category: 'admin', summary: 'Max avatar scaler % allowed.', usage: '!maxscaler 120' },
    minage: { category: 'admin', summary: 'Minimum profile age for the room.', usage: '!minage 18' },
    maxoccupancy: { category: 'admin', summary: 'Max room population for invites.', usage: '!maxoccupancy 12' },
    nolurk: { category: 'admin', summary: 'Turn Lurk/AI replies on or off.', usage: '!nolurk off' },
    roommusic: { category: 'admin', summary: 'Turn music commands on or off for this room.', usage: '!roommusic off' },
    commands: { category: 'admin', summary: 'Turn mod/room commands on or off for this room.', usage: '!commands off' },
    intro: { category: 'admin', summary: 'Turn bot join intro on or off for this room.', usage: '!intro off' },
    roomcheck: { category: 'admin', summary: 'Users quiet longer than N minutes.', usage: '!roomcheck 10' },
    roomsettings: {
        category: 'admin',
        summary: 'Show room bot settings.',
        usage: '!roomsettings',
        aliases: ['settings', 'greeting'],
    },
    maxkbs: { category: 'admin', summary: 'Max outfit size in KB (warning threshold).', usage: '!maxkbs 500' },
    outfit: { category: 'admin', summary: 'Check outfit size for a user (best effort).', usage: '!outfit username' },
    seat: {
        category: 'admin',
        summary: 'Move bot to a seat number (anyone in open rooms; else mods).',
        usage: '!seat 2',
    },
};

/** @type {Record<string, string>} */
export const COMMAND_ALIASES = {};
for (const [name, def] of Object.entries(COMMAND_CATALOG)) {
    COMMAND_ALIASES[name] = name;
    for (const alias of def.aliases || []) {
        COMMAND_ALIASES[alias] = name;
    }
}
COMMAND_ALIASES.newgreetings = 'newgreeting';
COMMAND_ALIASES.autogreeet = 'autogreet';
COMMAND_ALIASES.autgreet = 'autogreet';
COMMAND_ALIASES.room_id = 'roomid';
COMMAND_ALIASES.maxsclar = 'maxscaler';
COMMAND_ALIASES.maxscalar = 'maxscaler';
COMMAND_ALIASES.room_music = 'roommusic';
COMMAND_ALIASES.roomcmds = 'commands';
COMMAND_ALIASES.roomcommands = 'commands';
COMMAND_ALIASES.botintro = 'intro';

export function canonicalCommand(name) {
    const key = String(name || '').trim().toLowerCase().replace(/^[!*]/, '');
    return COMMAND_ALIASES[key] || key;
}

export function commandsForCategory(category) {
    return Object.entries(COMMAND_CATALOG)
        .filter(([, def]) => def.category === category)
        .map(([name]) => `!${name}`)
        .sort((a, b) => a.localeCompare(b));
}

export function commandInfo(cmd) {
    const key = canonicalCommand(cmd);
    return COMMAND_CATALOG[key] || null;
}
