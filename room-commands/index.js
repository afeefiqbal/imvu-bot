import {
    defaultGreetingText,
    formatGreeting,
} from '../room-settings/defaults.js';
import { getRoomSettings, isLurkEnabledForRoom, isWelcomeEnabledForRoom, patchRoomSettingsLocal } from '../room-settings/store.js';
import { patchRoomSettingsRemote } from './api.js';
import { buildHelpMessages, buildInfoMessage } from './help.js';
import { getMaxKbsForRoom, runFunCommand, setMaxKbsForRoom } from './fun.js';
import { buildSeatAssignmentMessage, seatFromParticipant } from './move.js';
import { parseOnOff, parseRoomCommand } from './parseCommand.js';
import { listQuietUsers } from './quietTracker.js';
import { fetchScalerScan, findOverScaler } from './scaleCheck.js';

const MOVE_DELAY_MS = Math.max(
    1000,
    parseInt(String(process.env.IMVU_MOVE_COMMAND_DELAY_MS || '5000'), 10) || 5000
);
const SCALE_CHECK_INTERVAL_MS = Math.max(
    15000,
    parseInt(String(process.env.IMVU_SCALE_CHECK_INTERVAL_MS || '30000'), 10) || 30000
);

/** Rooms that skip the “owner or mods only” chat reply (still enforce the check). */
function silentModDenyRoomSet() {
    const raw = process.env.IMVU_SILENT_MOD_DENY_ROOMS;
    if (raw === undefined) return new Set(['242955291-1130']);
    const t = String(raw).trim();
    if (!t) return new Set();
    if (/^(1|true|all|\*)$/i.test(t)) return null;
    return new Set(t.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean));
}

/**
 * @param {object} opts
 * @param {string} opts.roomId
 * @param {string} [opts.botName]
 * @param {string} opts.apiBaseUrl
 * @param {(text: string) => Promise<void>} opts.sendMessage
 * @param {() => string} [opts.getRoomName]
 * @param {() => string | null} [opts.getSelfUserId]
 * @param {(p: { senderId?: string, senderLabel?: string }) => Promise<boolean>} opts.canUseRoomCommand
 * @param {(userId: string) => void} [opts.watchDirectMessageUser]
 * @param {{ fetchChatParticipant?: Function, updateChatParticipantSeat?: Function, fetchUserProfile?: Function, apiGetWearableNames?: Function } | null} [opts.sessionClient]
 * @param {Map<string, string>} opts.lastUserMap
 * @param {Map<string, number>} opts.lastSpokeAt
 * @param {Map<string, number>} [opts.joinedAt]
 * @param {Map<string, number>} [opts.messageCount]
 * @param {Set<string>} opts.minAgeWarned
 * @param {Map<string, number>} [opts.scalerWarnedAt]
 * @param {() => Promise<Array<{ username?: string, avatarname?: string, display_name?: string, legacy_cid?: number }>>} [opts.getRoomModerators]
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
        watchDirectMessageUser,
        sessionClient = null,
        lastUserMap,
        lastSpokeAt,
        joinedAt,
        messageCount,
        minAgeWarned,
        scalerWarnedAt: scalerWarnedAtOpt,
        getRoomModerators,
    } = opts;

    const silentDenyRooms = silentModDenyRoomSet();
    const silentModDeny =
        silentDenyRooms === null || silentDenyRooms.has(String(roomId));

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
        if (await canUseRoomCommand({ senderId, senderLabel })) {
            if (senderId && typeof watchDirectMessageUser === 'function') {
                watchDirectMessageUser(String(senderId));
            }
            return true;
        }
        if (!silentModDeny) {
            await reply('That command is for room owner or mods only.');
        }
        return false;
    };

    let scaleTimer = null;
    const scalerWarnedAt = scalerWarnedAtOpt || new Map();

    const warnScalerIfOver = async (avatarId, label) => {
        const settings = getRoomSettings(roomId);
        if (!settings.auto_scale_check) return;

        const id = String(avatarId || '');
        if (!/^\d+$/.test(id)) return;

        const scan = await fetchScalerScan(sessionClient, id);
        const over = findOverScaler(scan.names, settings.max_scaler, scan.scalePercents);
        if (!over) return;

        const lastWarn = scalerWarnedAt.get(id) || 0;
        if (Date.now() - lastWarn < SCALE_CHECK_INTERVAL_MS - 2000) return;
        scalerWarnedAt.set(id, Date.now());

        await reply(
            `${label || id}: your avatar scaler looks like ${over.pct}% (room limit ${settings.max_scaler}%). Please lower it.`
        );
    };

    const runScalePass = async () => {
        const settings = getRoomSettings(roomId);
        if (!settings.auto_scale_check) return;

        for (const [avatarId, label] of lastUserMap) {
            await warnScalerIfOver(avatarId, label);
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
            await reply('Usage: !newgreeting Welcome to {room}, {user}!');
            return true;
        }

        if (cmd === 'roomid') {
            await reply(`Room ID: ${roomId}`);
            return true;
        }

        if (cmd === 'move') {
            const moveKey = senderId != null ? String(senderId) : 'anon';
            if (moveInflight.has(moveKey)) {
                await reply('Move already in progress — wait a few seconds.');
                return true;
            }
            moveInflight.add(moveKey);
            setTimeout(() => moveInflight.delete(moveKey), MOVE_DELAY_MS + 3000);
            const selfId = getSelfUserId();
            const targetId = senderId != null ? String(senderId) : '';
            if (!selfId || !/^\d+$/.test(selfId)) {
                await reply('Cannot move yet — bot session id not ready.');
                return true;
            }
            if (!targetId || !/^\d+$/.test(targetId)) {
                await reply('Could not identify your avatar for move.');
                return true;
            }
            if (typeof sessionClient?.fetchChatParticipant !== 'function') {
                await reply('Move is not available in this runtime.');
                return true;
            }

            let capturedSeat = null;
            try {
                const participant = await sessionClient.fetchChatParticipant(roomId, targetId);
                capturedSeat = seatFromParticipant(participant);
            } catch (e) {
                console.warn('[room-cmd] move seat lookup:', e?.message || e);
            }

            if (!capturedSeat) {
                await reply('Could not find your seat. Stand on a seat or spot in the room and try !move again.');
                return true;
            }

            await reply(
                `Moving to your spot in ~${Math.round(MOVE_DELAY_MS / 1000)}s — move away so the seat frees up.`
            );

            setTimeout(async () => {
                try {
                    let moved = false;
                    if (typeof sessionClient.updateChatParticipantSeat === 'function') {
                        moved = Boolean(
                            await sessionClient.updateChatParticipantSeat(roomId, selfId, capturedSeat)
                        );
                    }
                    if (!moved) {
                        const line = buildSeatAssignmentMessage({
                            botUserId: selfId,
                            seatNumber: capturedSeat.seatNumber,
                            seatFurniId: capturedSeat.seatFurniId,
                        });
                        if (!line) {
                            await reply('Move failed — invalid seat data.');
                            return;
                        }
                        await sendMessage(line);
                    }
                    await reply('Moving to your spot...');
                } catch (e) {
                    console.warn('[room-cmd] move:', e?.message || e);
                    await reply('Move failed. Try moving in the room and use !move again.');
                }
            }, MOVE_DELAY_MS);

            return true;
        }

        if (cmd === 'roomcheck') {
            if (!(await requireMod(senderId, senderLabel))) return true;
            const minutes = args ? Math.max(1, parseInt(args, 10) || 10) : 10;
            const quiet = listQuietUsers(lastUserMap, lastSpokeAt, minutes);
            if (!quiet.length) {
                await reply(`No one has been quiet longer than ${minutes} minutes.`);
                return true;
            }
            const lines = quiet
                .slice(0, 15)
                .map((u) => `• ${u.label} — ~${u.quietMinutes}m`);
            await reply(`Quiet over ${minutes}m:\n${lines.join('\n')}`);
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
            'roommusic',
            'commands',
            'intro',
            'maxkbs',
            'outfit',
            'seat',
        ]);
        if (modOnly.has(cmd) && !(await requireMod(senderId, senderLabel))) return true;

        if (cmd === 'help') {
            for (const line of buildHelpMessages({ botName: botName || 'Bot' })) {
                await reply(line);
            }
            return true;
        }

        if (cmd === 'info') {
            await reply(buildInfoMessage(args));
            return true;
        }

        const funHandled = await runFunCommand(cmd, args, {
            roomId,
            senderId,
            senderLabel,
            reply,
            lastUserMap,
            lastSpokeAt,
            joinedAt,
            messageCount,
            sessionClient,
            getRoomName,
            getRoomModerators,
            botName,
        });
        if (funHandled) return true;

        if (cmd === 'roomsettings') {
            const s = getRoomSettings(roomId);
            const maxKbs = getMaxKbsForRoom(roomId);
            await reply(
                `greeting=${s.greeting ? `"${s.greeting.slice(0, 80)}${s.greeting.length > 80 ? '…' : ''}"` : '(default)'} | welcome=${s.auto_greet} | ai=${s.lurk_enabled} | music=${s.music_enabled} | cmds=${s.commands_enabled} | intro=${s.intro_enabled} | scale=${s.auto_scale_check}@${s.max_scaler}% | min_age=${s.min_age ?? 'off'} | max_occ=${s.max_occupancy ?? '—'} | max_kbs=${maxKbs ?? '—'}`
            );
            return true;
        }

        if (cmd === 'maxkbs') {
            const n = parseInt(args, 10);
            if (!Number.isFinite(n) || n < 1) {
                await reply('Usage: !maxkbs 500');
                return true;
            }
            setMaxKbsForRoom(roomId, n);
            await reply(`Max outfit size threshold set to ${n} KB.`);
            return true;
        }

        if (cmd === 'outfit') {
            const target = String(args || senderLabel || '').trim();
            if (!target) {
                await reply('Usage: !outfit username');
                return true;
            }
            const limit = getMaxKbsForRoom(roomId);
            await reply(
                limit
                    ? `Outfit check for ${target}: size API not available — threshold is ${limit} KB.`
                    : `Outfit check for ${target}: set a threshold with !maxkbs first.`
            );
            return true;
        }

        if (cmd === 'seat') {
            const seatNumber = parseInt(args, 10);
            if (!Number.isFinite(seatNumber) || seatNumber <= 0) {
                await reply('Usage: !seat 2');
                return true;
            }
            const selfId = getSelfUserId();
            if (!selfId || !/^\d+$/.test(String(selfId))) {
                await reply('Bot session not ready for !seat.');
                return true;
            }
            if (typeof sessionClient?.updateChatParticipantSeat !== 'function') {
                await reply('Seat command is not available in this runtime.');
                return true;
            }
            const moved = await sessionClient.updateChatParticipantSeat(roomId, selfId, {
                seatNumber,
                seatFurniId: 0,
            });
            await reply(moved ? `Moved to seat ${seatNumber}.` : `Could not move to seat ${seatNumber}.`);
            return true;
        }

        if (cmd === 'newgreeting') {
            const g = args.trim();
            if (!g || g.length > 300) {
                await reply('Greeting must be 1–300 characters. Example: !newgreeting Welcome to {room}, {user}!');
                return true;
            }
            await persist({ greeting: g });
            await reply('Greeting updated. Use {room} and {user} as placeholders.');
            return true;
        }

        if (cmd === 'autogreet') {
            const toggle = parseOnOff(args);
            const next = toggle ?? !settings.auto_greet;
            await persist({ auto_greet: next });
            await reply(
                next
                    ? 'Auto greet is ON — I will welcome new joiners.'
                    : 'Auto greet is OFF — I will not welcome new joiners.'
            );
            return true;
        }

        if (cmd === 'roommusic') {
            const toggle = parseOnOff(args);
            const next = toggle ?? !settings.music_enabled;
            await persist({ music_enabled: next });
            await reply(`Music commands for this room are now ${next ? 'ON' : 'OFF'}.`);
            return true;
        }

        if (cmd === 'commands') {
            const toggle = parseOnOff(args);
            const next = toggle ?? !settings.commands_enabled;
            await persist({ commands_enabled: next });
            await reply(
                next
                    ? 'Room/mod commands are now ON.'
                    : 'Room/mod commands are now OFF for this room. Re-enable from the admin panel if needed.'
            );
            return true;
        }

        if (cmd === 'intro') {
            const toggle = parseOnOff(args);
            const next = toggle ?? !settings.intro_enabled;
            await persist({ intro_enabled: next });
            await reply(`Bot intro for this room is now ${next ? 'ON' : 'OFF'}.`);
            return true;
        }

        if (cmd === 'scale') {
            const toggle = parseOnOff(args);
            const next = toggle ?? !settings.auto_scale_check;
            if (next) scalerWarnedAt.clear();
            await persist({ auto_scale_check: next });
            await reply(`Scaler warnings are now ${next ? 'ON' : 'OFF'}.`);
            return true;
        }

        if (cmd === 'maxscaler') {
            const n = parseInt(args, 10);
            if (!Number.isFinite(n) || n < 1 || n > 500) {
                await reply('Usage: !maxscaler 120');
                return true;
            }
            scalerWarnedAt.clear();
            await persist({ max_scaler: n, auto_scale_check: true });
            await reply(`Max scaler set to ${n}%. Scaler warnings are ON.`);
            return true;
        }

        if (cmd === 'minage') {
            const n = parseInt(args, 10);
            if (!Number.isFinite(n) || n < 0 || n > 120) {
                await reply('Usage: !minage 18');
                return true;
            }
            await persist({ min_age: n });
            minAgeWarned.clear();
            await reply(`Minimum age check set to ${n}.`);
            return true;
        }

        if (cmd === 'maxoccupancy') {
            const n = parseInt(args, 10);
            if (!Number.isFinite(n) || n < 1 || n > 100) {
                await reply('Usage: !maxoccupancy 12');
                return true;
            }
            await persist({ max_occupancy: n });
            await reply(`Max occupancy for invites set to ${n}.`);
            return true;
        }

        if (cmd === 'nolurk') {
            const toggle = parseOnOff(args);
            const next = toggle ?? !settings.lurk_enabled;
            await persist({ lurk_enabled: next });
            await reply(
                `Lurk/AI replies are now ${next ? 'ON' : 'OFF'} in this room (resets when bot restarts unless saved in backend).`
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
    if (!isWelcomeEnabledForRoom(roomId)) return null;
    const settings = getRoomSettings(roomId);
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
            `${displayName || id}: your profile age (${age}) is below this room minimum (${settings.min_age}).`
        );
    } catch (e) {
        console.warn('[room-cmd] min age check:', e?.message || e);
    }
}

/**
 * One-shot scaler warning on join (when auto_scale_check is on).
 */
export async function maybeWarnScalerOnJoin({
    roomId,
    avatarId,
    displayName,
    sessionClient,
    scalerWarnedAt,
    sendMessage,
}) {
    const settings = getRoomSettings(roomId);
    if (!settings.auto_scale_check) return;
    const id = String(avatarId || '');
    if (!/^\d+$/.test(id)) return;

    const warnedAt = scalerWarnedAt || new Map();
    const lastWarn = warnedAt.get(id) || 0;
    if (Date.now() - lastWarn < SCALE_CHECK_INTERVAL_MS - 2000) return;

    try {
        const scan = await fetchScalerScan(sessionClient, id);
        const over = findOverScaler(scan.names, settings.max_scaler, scan.scalePercents);
        if (!over) return;
        warnedAt.set(id, Date.now());
        await sendMessage(
            `${displayName || id}: your avatar scaler looks like ${over.pct}% (room limit ${settings.max_scaler}%). Please lower it.`
        );
    } catch (e) {
        console.warn('[room-cmd] scaler check:', e?.message || e);
    }
}

export { isLurkEnabledForRoom };
