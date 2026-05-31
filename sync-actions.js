import axios from 'axios';
import { backendApiBaseUrl } from './env-app-url.js';
import { getRoomSettings } from './room-settings/store.js';
import { getRoomRuntime, trackerRoomKey } from './room-runtime-registry.js';
import { fetchAndPostDashboardProfile } from './imvu-profile-sync.js';
import { processPendingVerificationDeliveries } from './imvu-verification-sync.js';
import { runBotSocialSync, isSocialSyncEnabled } from './bot-social-sync.js';

export { runBotSocialSync, isSocialSyncEnabled };

const BACKEND_URL = backendApiBaseUrl('http://127.0.0.1:8000');

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitterMs(min, max) {
    return min + Math.random() * (max - min);
}

/**
 * @param {{ state?: string, track?: string | null }} payload
 */
async function reportMusicState(roomId, payload) {
    try {
        await axios.post(`${BACKEND_URL}/api/imvu-music-state`, {
            room_id: trackerRoomKey(roomId),
            state: payload.state || 'unknown',
            track: payload.track ?? null,
        });
    } catch (error) {
        console.warn(
            `[SYNC] music-state report failed room=${trackerRoomKey(roomId)}: ${error?.message || error}`
        );
    }
}

/**
 * Execute dashboard-queued actions from POST /api/rooms/sync response.
 *
 * @param {Record<string, unknown>} data
 * @param {{
 *   roomClients: Map<string, { client: { sendMessage: Function } }>,
 *   session: { setRoomRadioStreamUrl?: Function, stopRoomRadioStream?: Function },
 *   stopRoom: (roomId: string) => Promise<void>,
 *   startRoom?: (roomId: string) => Promise<unknown>,
 *   botName: string,
 *   logger?: Console,
 * }} ctx
 */
export async function processSyncActions(data, ctx) {
    const logger = ctx.logger || console;
    const logPrefix = `[${ctx.botName}][SYNC]`;

    if (Array.isArray(data.pending_leave_rooms)) {
        for (const raw of data.pending_leave_rooms) {
            const roomId = trackerRoomKey(raw);
            if (!roomId) continue;
            if (!ctx.roomClients?.has(roomId)) continue;
            logger.log(`${logPrefix} leaving room ${roomId} (pending_leave_rooms)`);
            await ctx.stopRoom(roomId);
        }
    }

    if (Array.isArray(data.pending_kicks)) {
        for (const kick of data.pending_kicks) {
            if (!kick || typeof kick !== 'object') continue;
            const roomId = trackerRoomKey(kick.room_id);
            const username = String(kick.username || '').trim();
            if (!roomId || !username) continue;

            const runtime = getRoomRuntime(roomId);
            if (!runtime) {
                logger.warn(`${logPrefix} kick skipped — bot not in room ${roomId} (${username})`);
                continue;
            }

            const settings = getRoomSettings(roomId);
            const useAutoboot = Boolean(kick.autoboot ?? settings.autoboot_on_kick);
            const result = await runtime.kickByUsername(username, {
                reason: useAutoboot ? 'dashboard-autoboot-kick' : 'dashboard-kick',
            });
            if (result.ok) {
                logger.log(`${logPrefix} kicked ${username} from ${roomId}`);
            } else {
                logger.warn(
                    `${logPrefix} kick failed ${username} in ${roomId}: ${result.reason || 'unknown'}`
                );
            }
        }
    }

    if (Array.isArray(data.pending_messages)) {
        for (const msg of data.pending_messages) {
            if (!msg || typeof msg !== 'object') continue;
            const roomId = trackerRoomKey(msg.room_id);
            const text = String(msg.pending_message || '').trim();
            if (!roomId || !text) continue;

            const entry = ctx.roomClients.get(roomId);
            if (!entry?.client?.sendMessage) {
                logger.warn(`${logPrefix} pending message skipped — bot not in room ${roomId}`);
                continue;
            }

            await delay(jitterMs(500, 2000));
            const target = String(msg.target_username || '').trim();
            const outgoing = target ? `(to ${target}) ${text}` : text;
            try {
                await entry.client.sendMessage(outgoing.slice(0, 500));
                logger.log(
                    `${logPrefix} sent pending message to ${roomId}${target ? ` (for ${target})` : ''}`
                );
            } catch (error) {
                logger.warn(
                    `${logPrefix} pending message failed room=${roomId}: ${error?.message || error}`
                );
            }
        }
    }

    if (Array.isArray(data.pending_music)) {
        for (const item of data.pending_music) {
            if (!item || typeof item !== 'object') continue;
            const roomId = trackerRoomKey(item.room_id);
            const action = String(item.action || 'start').trim().toLowerCase();
            if (!roomId) continue;

            if (action === 'stop') {
                if (typeof ctx.session?.stopRoomRadioStream !== 'function') {
                    logger.warn(`${logPrefix} music stop skipped — session API unavailable`);
                    continue;
                }
                const result = await ctx.session.stopRoomRadioStream(roomId);
                if (result?.ok) {
                    logger.log(`${logPrefix} stopped music in ${roomId}`);
                    await reportMusicState(roomId, { state: 'stopped', track: null });
                } else {
                    logger.warn(
                        `${logPrefix} music stop failed room=${roomId}: ${result?.reason || 'unknown'}`
                    );
                }
                continue;
            }

            const musicUrl = String(item.music_url || item.url || '').trim();
            if (!musicUrl) {
                logger.warn(`${logPrefix} music start skipped — missing music_url for ${roomId}`);
                continue;
            }
            if (typeof ctx.session?.setRoomRadioStreamUrl !== 'function') {
                logger.warn(`${logPrefix} music start skipped — session API unavailable`);
                continue;
            }

            const result = await ctx.session.setRoomRadioStreamUrl(roomId, musicUrl, {
                stationName: String(item.station_name || '').trim(),
            });
            if (result?.ok) {
                logger.log(`${logPrefix} started music in ${roomId}`);
                await reportMusicState(roomId, { state: 'playing', track: musicUrl });
            } else {
                logger.warn(
                    `${logPrefix} music start failed room=${roomId}: ${result?.reason || 'unknown'}`
                );
                await reportMusicState(roomId, { state: 'error', track: musicUrl });
            }
        }
    }

    if (Array.isArray(data.pending_profile_fetches)) {
        for (const item of data.pending_profile_fetches) {
            if (!item || typeof item !== 'object') continue;
            const username = String(item.username || '').trim();
            if (!username) continue;

            const result = await fetchAndPostDashboardProfile(ctx.session, item, ctx.botName);
            if (result.ok) {
                logger.log(
                    `${logPrefix} synced dashboard IMVU profile for ${result.username || username} (user-${result.user_id})`
                );
            } else if (result.reason !== 'inflight') {
                logger.warn(
                    `${logPrefix} dashboard profile fetch failed for ${username}: ${result.reason || 'unknown'}`
                );
            }
        }
    }

    if (Array.isArray(data.pending_verification_deliveries) && data.pending_verification_deliveries.length) {
        await processPendingVerificationDeliveries({
            session: ctx.session,
            botName: ctx.botName,
            logger,
            pendingItems: data.pending_verification_deliveries,
        });
    }

    if (isSocialSyncEnabled()) {
        await runBotSocialSync({
            session: ctx.session,
            botName: ctx.botName,
            logger,
            startRoom: ctx.startRoom,
        });
    }
}
