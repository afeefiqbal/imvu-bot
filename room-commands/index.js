import {
    defaultGreetingText,
    formatGreeting,
} from '../room-settings/defaults.js';
import { getRoomSettings, isLurkEnabledForRoom, patchRoomSettingsLocal } from '../room-settings/store.js';
import { patchRoomSettingsRemote } from './api.js';
import { buildSeatAssignmentMessage, seatFromParticipant } from './move.js';
import { parseOnOff, parseRoomCommand } from './parseCommand.js';
import { listQuietUsers } from './quietTracker.js';
import { fetchWearableNameHints, findOverScaler } from './scaleCheck.js';

const MOVE_DELAY_MS = Math.max(
    1000,
    parseInt(String(process.env.IMVU_MOVE_COMMAND_DELAY_MS || '5000'), 10) || 5000
);
const SCALE_CHECK_INTERVAL_MS = Math.max(
    15000,
    parseInt(String(process.env.IMVU_SCALE_CHECK_INTERVAL_MS || '30000'), 10) || 30000
);

/**
 * @param {object} opts
 * @param {string} opts.roomId
 * @param {string} [opts.botName]
 * @param {string} opts.apiBaseUrl
 * @param {(text: string) => Promise<void>} opts.sendMessage
 * @param {() => string} [opts.getRoomName]
 * @param {() => string | null} [opts.getSelfUserId]
 * @param {(p: { senderId?: string, senderLabel?: string }) => Promise<boolean>} opts.canUseRoomCommand
 * @param {{ fetchChatParticipant?: Function, updateChatParticipantSeat?: Function, fetchUserProfile?: Function, apiGetWearableNames?: Function } | null} [opts.sessionClient]
 * @param {Map<string, string>} opts.lastUserMap
 * @param {Map<string, number>} opts.lastSpokeAt
 * @param {Set<string>} opts.minAgeWarned
 */
export function createRoomChatCommandHandler(opts) {
    const {
        roomId,
        botName = '',
        apiBaseUrl,
        sendMessage,
        getRoomName = () => 'the room',
        getSelfUserId = () => null,
        canUseRoomCommand,
        sessionClient = null,
        lastUserMap,
        lastSpokeAt,
        minAgeWarned,
    } = opts;

    const persist = async (patch) => {
        patchRoomSettingsLocal(roomId, patch);
        if (botName) {
            const ok = await patchRoomSettingsRemote(apiBaseUrl, botName, roomId, patch);
            if (!ok) {
                console.log(`[room-cmd] settings saved in-memory only (API PATCH unavailable) room=${roomId}`);
            }
        }
    };

    const reply = async (text) => {
        try {
            await sendMessage(String(text || '').slice(0, 500));
        } catch (e) {
            console.warn('[room-cmd] sendMessage:', e?.message || e);
        }
    };

    const requireMod = async (senderId, senderLabel) => {
        if (await canUseRoomCommand({ senderId, senderLabel })) return true;
        await reply('(bot) That command is for room owner or mods only.');
        return false;
    };

    let scaleTimer = null;
    const scalerWarnedAt = new Map();

    const runScalePass = async () => {
        const settings = getRoomSettings(roomId);
        if (!settings.auto_scale_check) return;

        for (const [avatarId, label] of lastUserMap) {
            if (!/^\d+$/.test(String(avatarId))) continue;
            const names = await fetchWearableNameHints(sessionClient, String(avatarId));
            const over = findOverScaler(names, settings.max_scaler);
            if (!over) continue;

            const lastWarn = scalerWarnedAt.get(String(avatarId)) || 0;
            if (Date.now() - lastWarn < SCALE_CHECK_INTERVAL_MS - 2000) continue;
            scalerWarnedAt.set(String(avatarId), Date.now());

            await reply(
                `(bot) ${label || avatarId}: your avatar scaler looks like ${over.pct}% (room limit ${settings.max_scaler}%). Please lower it.`
            );
        }
    };

    const startScaleInterval = () => {
        if (scaleTimer) return;
        scaleTimer = setInterval(() => {
            void runScalePass().catch((e) => console.warn('[room-cmd] scale check:', e?.message || e));
        }, SCALE_CHECK_INTERVAL_MS);
    };

    const stopScaleInterval = () => {
        if (scaleTimer) clearInterval(scaleTimer);
        scaleTimer = null;
    };

    startScaleInterval();

    const moveInflight = new Set();

    /**
     * @param {{ text: string, senderId?: string, senderLabel?: string }} msg
     * @returns {Promise<boolean>}
     */
    const handler = async ({ text, senderId, senderLabel }) => {
        const parsed = parseRoomCommand(text);
        if (!parsed) return false;

        const { cmd, args } = parsed;
        const settings = getRoomSettings(roomId);

        if (cmd === 'newgreeting' && !args.trim()) {
            await reply('(bot) Usage: !newgreeting Welcome to {room}, {user}!');
            return true;
        }

        if (cmd === 'move') {
            const moveKey = senderId != null ? String(senderId) : 'anon';
            if (moveInflight.has(moveKey)) {
                await reply('(bot) Move already in progress — wait a few seconds.');
                return true;
            }
            moveInflight.add(moveKey);
            setTimeout(() => moveInflight.delete(moveKey), MOVE_DELAY_MS + 3000);
            const selfId = getSelfUserId();
            const targetId = senderId != null ? String(senderId) : '';
            if (!selfId || !/^\d+$/.test(selfId)) {
                await reply('(bot) Cannot move yet — bot session id not ready.');
                return true;
            }
            if (!targetId || !/^\d+$/.test(targetId)) {
                await reply('(bot) Could not identify your avatar for move.');
                return true;
            }
            if (typeof sessionClient?.fetchChatParticipant !== 'function') {
                await reply('(bot) Move is not available in this runtime.');
                return true;
            }

            await reply(
                `(bot) Moving to your spot in ~${Math.round(MOVE_DELAY_MS / 1000)}s — move away so the seat frees up.`
            );

            setTimeout(async () => {
                try {
                    const participant = await sessionClient.fetchChatParticipant(roomId, targetId);
                    const seat = seatFromParticipant(participant);
                    if (!seat) {
                        await reply(
                            '(bot) Could not find your seat. Move around the room and try !move again.'
                        );
                        return;
                    }
                    let moved = false;
                    if (typeof sessionClient.updateChatParticipantSeat === 'function') {
                        moved = Boolean(
                            await sessionClient.updateChatParticipantSeat(roomId, selfId, seat)
                        );
                    }
                    if (!moved) {
                        const line = buildSeatAssignmentMessage({
                            botUserId: selfId,
                            seatNumber: seat.seatNumber,
                            seatFurniId: seat.seatFurniId,
                        });
                        if (!line) {
                            await reply('(bot) Move failed — invalid seat data.');
                            return;
                        }
                        await sendMessage(line);
                    }
                    await reply('(bot) Moving to your spot...');
                } catch (e) {
                    console.warn('[room-cmd] move:', e?.message || e);
                    await reply('(bot) Move failed. Try moving in the room and use !move again.');
                }
            }, MOVE_DELAY_MS);

            return true;
        }

        if (cmd === 'roomcheck') {
            const minutes = args ? Math.max(1, parseInt(args, 10) || 10) : 10;
            const quiet = listQuietUsers(lastUserMap, lastSpokeAt, minutes);
            if (!quiet.length) {
                await reply(`(bot) No one has been quiet longer than ${minutes} minutes.`);
                return true;
            }
            const lines = quiet
                .slice(0, 15)
                .map((u) => `• ${u.label} — ~${u.quietMinutes}m`);
            await reply(`(bot) Quiet over ${minutes}m:\n${lines.join('\n')}`);
            return true;
        }

        const modOnly = new Set([
            'newgreeting',
            'autogreet',
            'scale',
            'maxscaler',
            'minage',
            'maxoccupancy',
            'nolurk',
        ]);
        if (modOnly.has(cmd) && !(await requireMod(senderId, senderLabel))) return true;

        if (cmd === 'newgreeting') {
            const g = args.trim();
            if (!g || g.length > 300) {
                await reply('(bot) Greeting must be 1–300 characters. Example: !newgreeting Welcome to {room}, {user}!');
                return true;
            }
            await persist({ greeting: g });
            await reply('(bot) Greeting updated. Use {room} and {user} as placeholders.');
            return true;
        }

        if (cmd === 'autogreet') {
            const toggle = parseOnOff(args);
            const next = toggle ?? !settings.auto_greet;
            await persist({ auto_greet: next });
            await reply(
                next
                    ? '(bot) Auto greet is ON — I will welcome new joiners.'
                    : '(bot) Auto greet is OFF — I will not welcome new joiners.'
            );
            return true;
        }

        if (cmd === 'scale') {
            const toggle = parseOnOff(args);
            const next = toggle ?? !settings.auto_scale_check;
            await persist({ auto_scale_check: next });
            await reply(`(bot) Scaler warnings are now ${next ? 'ON' : 'OFF'}.`);
            return true;
        }

        if (cmd === 'maxscaler') {
            const n = parseInt(args, 10);
            if (!Number.isFinite(n) || n < 1 || n > 500) {
                await reply('(bot) Usage: !maxscaler 120');
                return true;
            }
            await persist({ max_scaler: n });
            await reply(`(bot) Max scaler set to ${n}%.`);
            return true;
        }

        if (cmd === 'minage') {
            const n = parseInt(args, 10);
            if (!Number.isFinite(n) || n < 0 || n > 120) {
                await reply('(bot) Usage: !minage 18');
                return true;
            }
            await persist({ min_age: n });
            minAgeWarned.clear();
            await reply(`(bot) Minimum age check set to ${n}.`);
            return true;
        }

        if (cmd === 'maxoccupancy') {
            const n = parseInt(args, 10);
            if (!Number.isFinite(n) || n < 1 || n > 100) {
                await reply('(bot) Usage: !maxoccupancy 12');
                return true;
            }
            await persist({ max_occupancy: n });
            await reply(`(bot) Max occupancy for invites set to ${n}.`);
            return true;
        }

        if (cmd === 'nolurk') {
            const toggle = parseOnOff(args);
            const next = toggle ?? !settings.lurk_enabled;
            await persist({ lurk_enabled: next });
            await reply(
                `(bot) Lurk/AI replies are now ${next ? 'ON' : 'OFF'} in this room (resets when bot restarts unless saved in backend).`
            );
            return true;
        }

        if (cmd === 'help' || cmd === 'commands') {
            await reply(
                '(bot) Commands: !move · !roomcheck [min] · !settings · Mod: !newgreeting · !autogreet · !scale · !maxscaler · !minage · !maxoccupancy · !nolurk'
            );
            return true;
        }

        if (cmd === 'greeting' || cmd === 'settings') {
            const s = getRoomSettings(roomId);
            await reply(
                `(bot) greeting=${s.greeting ? `"${s.greeting.slice(0, 80)}${s.greeting.length > 80 ? '…' : ''}"` : '(default)'} | auto_greet=${s.auto_greet} | scale=${s.auto_scale_check}@${s.max_scaler}% | min_age=${s.min_age ?? 'off'} | lurk=${s.lurk_enabled} | max_occ=${s.max_occupancy ?? '—'}`
            );
            return true;
        }

        return false;
    };

    handler.stopScaleInterval = stopScaleInterval;

    return handler;
}

/**
 * Welcome text for a join using room settings.
 * @param {string} roomId
 * @param {string} displayName
 * @param {string} roomName
 */
export function buildWelcomeText(roomId, displayName, roomName) {
    const settings = getRoomSettings(roomId);
    if (!settings.auto_greet) return null;
    if (settings.greeting) {
        return formatGreeting(settings.greeting, { user: displayName, room: roomName }) || null;
    }
    return defaultGreetingText(displayName, roomName);
}

/**
 * One-shot min age warning on join.
 */
export async function maybeWarnMinAgeOnJoin({
    roomId,
    avatarId,
    displayName,
    sessionClient,
    minAgeWarned,
    sendMessage,
}) {
    const settings = getRoomSettings(roomId);
    if (settings.min_age == null || settings.min_age <= 0) return;
    const id = String(avatarId || '');
    if (!/^\d+$/.test(id) || minAgeWarned.has(id)) return;
    if (typeof sessionClient?.fetchUserProfile !== 'function') return;

    try {
        const profile = await sessionClient.fetchUserProfile(id);
        const age = profile?.profile_age;
        if (age == null) return;
        if (age >= settings.min_age) return;
        minAgeWarned.add(id);
        await sendMessage(
            `(bot) ${displayName || id}: your profile age (${age}) is below this room minimum (${settings.min_age}).`
        );
    } catch (e) {
        console.warn('[room-cmd] min age check:', e?.message || e);
    }
}

export { isLurkEnabledForRoom };
