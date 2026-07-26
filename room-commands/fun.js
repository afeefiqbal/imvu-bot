import { isLurkEnabledForRoom } from '../room-settings/store.js';
import { botDiscordInviteUrl } from './discordInvite.js';
import { parseOnOff } from './parseCommand.js';
import { seatFromParticipant } from './move.js';

const EIGHT_BALL = [
    'Yes.',
    'No.',
    'Maybe.',
    'Ask again later.',
    'Definitely yes.',
    'Definitely no.',
    'Signs point to yes.',
    "Don't count on it.",
    'Very likely.',
    'Unlikely.',
];

const BODY_PARTS = [
    'head',
    'shoulder',
    'elbow',
    'hand',
    'knee',
    'foot',
    'back',
    'chest',
    'arm',
    'leg',
];

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

/** @type {Map<string, Map<string, string>>} room -> userId -> status */
const userStatusByRoom = new Map();
/** @type {Map<string, Set<string>>} room -> userIds opted out of picks */
const noPickByRoom = new Map();
/** @type {Map<string, number>} room -> max outfit KB threshold */
const maxKbsByRoom = new Map();

function roomKey(roomId) {
    return String(roomId || '').trim().replace(/^room-/i, '');
}

function userKey(roomId, userId) {
    return `${roomKey(roomId)}:${String(userId || 'anon')}`;
}

function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function parseNumberArg(raw, fallback = null) {
    const n = Number(String(raw || '').trim());
    return Number.isFinite(n) ? n : fallback;
}

function parseDurationMs(raw) {
    const s = String(raw || '').trim().toLowerCase();
    const m = s.match(/^(\d+(?:\.\d+)?)(s|m|h)?$/);
    if (!m) return null;
    const n = Number(m[1]);
    const unit = m[2] || 'm';
    if (unit === 's') return n * 1000;
    if (unit === 'h') return n * 3600 * 1000;
    return n * 60 * 1000;
}

/** @param {number} ms */
function formatElapsed(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    if (totalSec < 60) return `${totalSec}s`;
    const totalMin = Math.floor(totalSec / 60);
    if (totalMin < 60) return `${totalMin}m`;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
}

function splitPickList(args) {
    return String(args || '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
}

function statusMap(roomId) {
    const key = roomKey(roomId);
    if (!userStatusByRoom.has(key)) userStatusByRoom.set(key, new Map());
    return userStatusByRoom.get(key);
}

function noPickSet(roomId) {
    const key = roomKey(roomId);
    if (!noPickByRoom.has(key)) noPickByRoom.set(key, new Set());
    return noPickByRoom.get(key);
}

function eligiblePickItems(args, roomId, lastUserMap) {
    const fromArgs = splitPickList(args);
    const pool = fromArgs.length
        ? fromArgs
        : [...lastUserMap.values()].filter(Boolean);
    const blocked = noPickSet(roomId);
    return pool.filter((name) => {
        for (const [id, label] of lastUserMap) {
            if (label === name && blocked.has(String(id))) return false;
        }
        return true;
    });
}

/**
 * @param {string} cmd
 * @param {string} args
 * @param {object} ctx
 * @returns {Promise<boolean>}
 */
export async function runFunCommand(cmd, args, ctx) {
    const {
        roomId,
        senderId,
        senderLabel,
        reply,
        lastUserMap,
        lastSpokeAt,
        joinedAt,
        messageCount,
        sessionClient,
        getRoomName = () => 'the room',
        getRoomModerators,
        botName = 'Bot',
    } = ctx;

    const name = String(senderLabel || 'there').trim() || 'there';
    const uid = senderId != null ? String(senderId) : '';

    switch (cmd) {
        case 'c2f': {
            const c = parseNumberArg(args);
            if (c == null) {
                await reply('Usage: !c2f 25');
                return true;
            }
            await reply(`${c}°C = ${((c * 9) / 5 + 32).toFixed(1)}°F`);
            return true;
        }
        case 'f2c': {
            const f = parseNumberArg(args);
            if (f == null) {
                await reply('Usage: !f2c 77');
                return true;
            }
            await reply(`${f}°F = ${(((f - 32) * 5) / 9).toFixed(1)}°C`);
            return true;
        }
        case 'cm2in': {
            const cm = parseNumberArg(args);
            if (cm == null) {
                await reply('Usage: !cm2in 180');
                return true;
            }
            await reply(`${cm} cm = ${(cm / 2.54).toFixed(2)} in`);
            return true;
        }
        case 'in2cm': {
            const inch = parseNumberArg(args);
            if (inch == null) {
                await reply('Usage: !in2cm 70');
                return true;
            }
            await reply(`${inch} in = ${(inch * 2.54).toFixed(2)} cm`);
            return true;
        }
        case 'kg2lbs': {
            const kg = parseNumberArg(args);
            if (kg == null) {
                await reply('Usage: !kg2lbs 60');
                return true;
            }
            await reply(`${kg} kg = ${(kg * 2.20462).toFixed(2)} lbs`);
            return true;
        }
        case 'lbs2kg': {
            const lbs = parseNumberArg(args);
            if (lbs == null) {
                await reply('Usage: !lbs2kg 150');
                return true;
            }
            await reply(`${lbs} lbs = ${(lbs / 2.20462).toFixed(2)} kg`);
            return true;
        }
        case 'km2mi': {
            const km = parseNumberArg(args);
            if (km == null) {
                await reply('Usage: !km2mi 10');
                return true;
            }
            await reply(`${km} km = ${(km * 0.621371).toFixed(2)} mi`);
            return true;
        }
        case 'mi2km': {
            const mi = parseNumberArg(args);
            if (mi == null) {
                await reply('Usage: !mi2km 5');
                return true;
            }
            await reply(`${mi} mi = ${(mi / 0.621371).toFixed(2)} km`);
            return true;
        }
        case '8ball': {
            const q = String(args || '').trim();
            if (!q) {
                await reply('Ask a question: !8ball Will it rain?');
                return true;
            }
            await reply(`${pickRandom(EIGHT_BALL)} (${q})`);
            return true;
        }
        case 'd20':
            await reply(`🎲 d20: ${randInt(1, 20)}`);
            return true;
        case 'number': {
            const parts = String(args || '').trim().split(/\s+/).filter(Boolean);
            let min = 1;
            let max = 100;
            if (parts.length >= 2) {
                min = parseNumberArg(parts[0], 1);
                max = parseNumberArg(parts[1], 100);
            } else if (parts.length === 1) {
                max = parseNumberArg(parts[0], 100);
                min = 1;
            }
            if (min > max) [min, max] = [max, min];
            await reply(`Random: ${randInt(min, max)} (${min}–${max})`);
            return true;
        }
        case 'pick1': {
            const pool = eligiblePickItems(args, roomId, lastUserMap);
            if (!pool.length) {
                await reply('Nothing to pick from. Use: !pick1 Alice, Bob, Carol');
                return true;
            }
            await reply(`I pick: ${pickRandom(pool)}`);
            return true;
        }
        case 'pick2': {
            const pool = eligiblePickItems(args, roomId, lastUserMap);
            if (pool.length < 2) {
                await reply('Need at least 2 names. Use: !pick2 Alice, Bob, Carol');
                return true;
            }
            const copy = [...pool];
            const first = pickRandom(copy);
            const rest = copy.filter((x) => x !== first);
            const second = pickRandom(rest);
            await reply(`I pick: ${first} and ${second}`);
            return true;
        }
        case 'yesno':
            await reply(pickRandom(['Yes.', 'No.', 'Maybe.']));
            return true;
        case 'odds': {
            const n = Math.max(2, Math.round(parseNumberArg(args, 100) || 100));
            await reply(`1 in ${n} (${pickRandom(['lucky', 'unlucky', 'neutral'])} roll: ${randInt(1, n)})`);
            return true;
        }
        case 'coinflip':
            await reply(pickRandom(['Heads.', 'Tails.']));
            return true;
        case 'card':
            await reply(`${pickRandom(RANKS)}${pickRandom(SUITS)}`);
            return true;
        case 'rockpaperscissors': {
            const choices = ['rock', 'paper', 'scissors'];
            const theirs = String(args || '').trim().toLowerCase();
            if (!choices.includes(theirs)) {
                await reply('Usage: !rps rock|paper|scissors');
                return true;
            }
            const mine = pickRandom(choices);
            let outcome = 'Tie.';
            if (
                (mine === 'rock' && theirs === 'scissors') ||
                (mine === 'paper' && theirs === 'rock') ||
                (mine === 'scissors' && theirs === 'paper')
            ) {
                outcome = 'I win.';
            } else if (mine !== theirs) {
                outcome = 'You win.';
            }
            await reply(`${mine} vs ${theirs} — ${outcome}`);
            return true;
        }
        case 'bodypart':
            await reply(pickRandom(BODY_PARTS));
            return true;
        case 'hello':
            await reply(`Hey ${name} 👋`);
            return true;
        case 'bye':
            await reply(`Bye ${name}!`);
            return true;
        case 'afk': {
            const msg = String(args || '').trim() || 'AFK';
            if (uid) statusMap(roomId).set(uid, `AFK: ${msg}`);
            await reply(`${name} is now AFK${msg !== 'AFK' ? ` (${msg})` : ''}.`);
            return true;
        }
        case 'brb': {
            const msg = String(args || '').trim() || 'BRB';
            if (uid) statusMap(roomId).set(uid, `BRB: ${msg}`);
            await reply(`${name} will be right back${msg !== 'BRB' ? ` (${msg})` : ''}.`);
            return true;
        }
        case 'back': {
            if (uid) statusMap(roomId).delete(uid);
            await reply(`Welcome back, ${name}!`);
            return true;
        }
        case 'status': {
            const st = uid ? statusMap(roomId).get(uid) : null;
            await reply(st ? `${name}: ${st}` : `${name}: no status set.`);
            return true;
        }
        case 'setstatus': {
            const msg = String(args || '').trim();
            if (!msg) {
                await reply('Usage: !setstatus Busy');
                return true;
            }
            if (uid) statusMap(roomId).set(uid, msg);
            await reply(`${name}: status set to "${msg.slice(0, 80)}".`);
            return true;
        }
        case 'userid':
            await reply(uid ? `Your user id: ${uid}` : 'Could not identify your user id.');
            return true;
        case 'mods': {
            const mods = typeof getRoomModerators === 'function' ? await getRoomModerators() : [];
            if (!mods?.length) {
                await reply('No moderators found (or list unavailable).');
                return true;
            }
            const lines = mods
                .slice(0, 20)
                .map((m) => m?.username || m?.avatarname || m?.display_name || m?.legacy_cid || '?');
            await reply(`Moderators:\n${lines.map((l) => `• ${l}`).join('\n')}`);
            return true;
        }
        case 'list': {
            const names = [...lastUserMap.values()].filter(Boolean);
            if (!names.length) {
                await reply('No one tracked in the room yet.');
                return true;
            }
            await reply(`In room (${names.length}):\n${names.slice(0, 25).map((n) => `• ${n}`).join('\n')}`);
            return true;
        }
        case 'position': {
            if (!uid || typeof sessionClient?.fetchChatParticipant !== 'function') {
                await reply('Could not look up your seat.');
                return true;
            }
            const participant = await sessionClient.fetchChatParticipant(roomId, uid);
            const seat = seatFromParticipant(participant);
            if (!seat) {
                await reply(`${name}: not on a seat (or seat unknown).`);
                return true;
            }
            await reply(
                `${name}: seat ${seat.seatNumber}${seat.seatFurniId ? ` (furni ${seat.seatFurniId})` : ''}.`
            );
            return true;
        }
        case 'discord': {
            await reply(`Discord: ${botDiscordInviteUrl()}`);
            return true;
        }
        case 'timer': {
            const ms = parseDurationMs(args);
            if (!ms || ms <= 0) {
                await reply('Usage: !timer 5m  (s/m/h — default minutes)');
                return true;
            }
            const label = String(args || '').trim();
            await reply(`Timer started (${label}) — I'll ping in ${Math.round(ms / 1000)}s.`);
            setTimeout(() => {
                void reply(`${name}: timer done (${label}).`);
            }, ms);
            return true;
        }
        case 'lurk': {
            const on = isLurkEnabledForRoom(roomId);
            await reply(`Lurk/AI replies in ${getRoomName()}: ${on ? 'ON' : 'OFF'}. Mods: !nolurk on|off`);
            return true;
        }
        case 'rate': {
            const topic = String(args || '').trim() || 'that';
            await reply(`I rate ${topic} ${randInt(1, 10)}/10.`);
            return true;
        }
        case 'mystats': {
            const now = Date.now();
            const spoke = uid ? lastSpokeAt?.get(uid) : null;
            const joined = uid ? joinedAt?.get(uid) : null;
            const msgs = uid ? messageCount?.get(uid) || 0 : 0;
            const lastSpoke =
                spoke != null ? `${formatElapsed(now - spoke)} ago` : 'never this visit';
            const inRoom = joined != null ? formatElapsed(now - joined) : 'unknown';
            const st = uid ? statusMap(roomId).get(uid) : null;
            await reply(
                `${name} · msgs: ${msgs} · in room: ${inRoom} · last spoke: ${lastSpoke}${st ? ` · status: ${st}` : ''} · room: ${roomKey(roomId)}`
            );
            return true;
        }
        case 'leaderboard': {
            const counts = messageCount instanceof Map ? messageCount : new Map();
            const rows = [...counts.entries()]
                .map(([id, msgs]) => ({
                    label: lastUserMap.get(id) || id,
                    msgs: Number(msgs) || 0,
                    spoke: lastSpokeAt?.get(id) || 0,
                }))
                .filter((r) => r.msgs > 0)
                .sort((a, b) => b.msgs - a.msgs || b.spoke - a.spoke)
                .slice(0, 10);
            if (!rows.length) {
                await reply('No chat activity tracked yet.');
                return true;
            }
            await reply(
                'Top chatters:\n' +
                    rows.map((r, i) => `${i + 1}. ${r.label} (${r.msgs})`).join('\n')
            );
            return true;
        }
        case 'nopick': {
            if (!uid) {
                await reply('Could not identify you for !nopick.');
                return true;
            }
            const toggle = parseOnOff(args);
            const set = noPickSet(roomId);
            const next = toggle ?? !set.has(uid);
            if (next) set.add(uid);
            else set.delete(uid);
            await reply(next ? `${name} opted OUT of picks.` : `${name} opted IN to picks.`);
            return true;
        }
        default:
            return false;
    }
}

export function getMaxKbsForRoom(roomId) {
    return maxKbsByRoom.get(roomKey(roomId)) ?? null;
}

export function setMaxKbsForRoom(roomId, value) {
    const key = roomKey(roomId);
    if (value == null) maxKbsByRoom.delete(key);
    else maxKbsByRoom.set(key, value);
}
