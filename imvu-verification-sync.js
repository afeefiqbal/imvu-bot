import axios from 'axios';
import { backendApiBaseUrl } from './env-app-url.js';

const BACKEND_URL = backendApiBaseUrl('http://127.0.0.1:8000');
const deliveryInflight = new Set();
const localRetryUntil = new Map();
const lastWarnAt = new Map();
const CODE_PATTERN = /\b([A-Z0-9]{6})\b/i;

function envInt(key, fallback) {
    const value = parseInt(process.env[key] || '', 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function retryMs() {
    return envInt('IMVU_VERIFY_DM_RETRY_MS', 2 * 60 * 1000);
}

function rateLimitMs() {
    return envInt('IMVU_VERIFY_DM_RATE_LIMIT_MS', 10 * 60 * 1000);
}

function normalizeUsername(value) {
    return String(value || '').trim().toLowerCase();
}

function isDmRateLimited(dm) {
    if (dm?.rateLimited) return true;
    const reason = String(dm?.reason || '').toLowerCase();
    return reason.includes('429') || reason.includes('rate-001');
}

function markLocalRetry(dashboardUserId, ms) {
    localRetryUntil.set(Number(dashboardUserId), Date.now() + ms);
}

function isLocallyCoolingDown(dashboardUserId) {
    return Date.now() < (localRetryUntil.get(Number(dashboardUserId)) || 0);
}

function warnOnce(logger, logPrefix, key, message) {
    const now = Date.now();
    const last = lastWarnAt.get(key) || 0;
    if (now - last < 60_000) return;
    lastWarnAt.set(key, now);
    logger.warn(`${logPrefix} ${message}`);
}

async function resolveTargetUserId(ctx, username, storedUserId) {
    const session = ctx.session;
    if (!session) return null;

    const stored = String(storedUserId || '').trim();
    if (/^\d+$/.test(stored)) {
        return stored;
    }

    // Only resolve by username when dashboard has no stored IMVU user id yet.
    if (typeof session.resolveUserIdFromUsername === 'function') {
        const fromProfile = String((await session.resolveUserIdFromUsername(username, { log: true })) || '');
        if (/^\d+$/.test(fromProfile)) {
            return fromProfile;
        }
    }

    return null;
}

async function reportDeliveryStatus(dashboardUserId, deliveryMethod, botName, { complete = true } = {}) {
    await axios.post(`${BACKEND_URL}/api/imvu-verification/deliver-status`, {
        dashboard_user_id: Number(dashboardUserId),
        delivery_method: deliveryMethod,
        bot_name: botName ? String(botName) : null,
        complete,
    });
}

async function reportDeliveryBlocked(dashboardUserId, { rateLimited = false } = {}) {
    await axios.post(`${BACKEND_URL}/api/imvu-verification/deliver-status`, {
        dashboard_user_id: Number(dashboardUserId),
        rate_limited: rateLimited,
        delivery_failed: !rateLimited,
    });
}

function buildVerificationMessage(code) {
    return `AetherRoom verification code: ${code}. Enter this in Dashboard Settings to verify your IMVU account.`;
}

/**
 * @param {{ session?: object, botName?: string, logger?: Console, pendingItems?: Array<object> }} ctx
 */
export async function processPendingVerificationDeliveries(ctx) {
    const logger = ctx.logger || console;
    const logPrefix = `[${ctx.botName || 'BOT'}][VERIFY]`;

    if (!Array.isArray(ctx.pendingItems) || !ctx.pendingItems.length) {
        return;
    }

    for (const item of ctx.pendingItems) {
        if (!item || typeof item !== 'object') continue;

        const dashboardUserId = Number(item.dashboard_user_id);
        const username = String(item.username || '').trim();
        const code = String(item.code || '').trim().toUpperCase();
        const userId = item.user_id != null ? String(item.user_id).trim() : '';

        if (!Number.isFinite(dashboardUserId) || dashboardUserId <= 0 || !username || !/^[A-Z0-9]{6}$/.test(code)) {
            continue;
        }

        if (isLocallyCoolingDown(dashboardUserId)) {
            continue;
        }

        const key = `${dashboardUserId}:${code}`;
        if (deliveryInflight.has(key)) continue;
        deliveryInflight.add(key);

        try {
            const targetUserId = await resolveTargetUserId(ctx, username, userId);
            if (!targetUserId) {
                warnOnce(
                    logger,
                    logPrefix,
                    `resolve:${dashboardUserId}`,
                    `could not resolve IMVU profile for ${username}`
                );
                continue;
            }

            const message = buildVerificationMessage(code);

            if (typeof ctx.session?.sendDirectMessage === 'function') {
                const dm = await ctx.session.sendDirectMessage(targetUserId, message, username);
                if (dm?.ok) {
                    await reportDeliveryStatus(dashboardUserId, 'direct_message', ctx.botName);
                    logger.log(`${logPrefix} sent code via IMVU message to ${username} (user-${targetUserId})`);
                    localRetryUntil.delete(dashboardUserId);
                    continue;
                }

                if (isDmRateLimited(dm)) {
                    markLocalRetry(dashboardUserId, rateLimitMs());
                    await reportDeliveryBlocked(dashboardUserId, { rateLimited: true });
                    warnOnce(
                        logger,
                        logPrefix,
                        `rate:${dashboardUserId}`,
                        `IMVU rate limit for ${username}; retry in ${Math.round(rateLimitMs() / 60000)} min (or type the code in room chat)`
                    );
                    continue;
                }

                if (dm?.friendRequired && typeof ctx.session?.sendFriendRequest === 'function') {
                    const friend = await ctx.session.sendFriendRequest(targetUserId, username);
                    if (friend?.ok) {
                        await reportDeliveryStatus(dashboardUserId, 'friend_request', ctx.botName, {
                            complete: false,
                        });
                        markLocalRetry(dashboardUserId, envInt('IMVU_VERIFY_DM_FRIEND_PENDING_MS', 15 * 60 * 1000));
                        logger.log(
                            `${logPrefix} ${username} requires friends-only messages; friend request sent from bot — accept it on IMVU, then the code will arrive in messages`
                        );
                        continue;
                    }
                    markLocalRetry(dashboardUserId, retryMs());
                    await reportDeliveryBlocked(dashboardUserId, { rateLimited: false });
                    warnOnce(
                        logger,
                        logPrefix,
                        `friend:${dashboardUserId}`,
                        `friend request to ${username} failed: ${friend?.reason || 'unknown'}`
                    );
                    continue;
                }

                markLocalRetry(dashboardUserId, retryMs());
                await reportDeliveryBlocked(dashboardUserId, { rateLimited: false });
                warnOnce(
                    logger,
                    logPrefix,
                    `dm:${dashboardUserId}`,
                    `direct message to ${username} failed: ${dm?.reason || 'unknown'}`
                );
                continue;
            }

            warnOnce(
                logger,
                logPrefix,
                `unsupported:${dashboardUserId}`,
                `could not deliver code to ${username} via IMVU messages yet`
            );
        } catch (error) {
            markLocalRetry(dashboardUserId, retryMs());
            await reportDeliveryBlocked(dashboardUserId, { rateLimited: false }).catch(() => {});
            warnOnce(
                logger,
                logPrefix,
                `error:${dashboardUserId}`,
                `delivery failed for ${username}: ${error?.message || error}`
            );
        } finally {
            deliveryInflight.delete(key);
        }
    }
}

/**
 * Detect a verification code typed in room chat and confirm ownership via Laravel.
 */
export async function tryVerificationCodeFromChat({ senderLabel, senderId, text, botName }) {
    const raw = String(text || '').trim();
    if (!raw) return false;

    const match = raw.match(CODE_PATTERN);
    if (!match) return false;

    const code = match[1].toUpperCase();
    const username = String(senderLabel || '').trim();
    if (!username || username === 'Guest') return false;

    try {
        const response = await axios.post(`${BACKEND_URL}/api/imvu-verification/verify-by-chat`, {
            username,
            user_id: senderId && /^\d+$/.test(String(senderId)) ? Number(senderId) : null,
            code,
            bot_name: botName ? String(botName) : null,
        });

        if (response.data?.ok) {
            console.log(`[${botName || 'BOT'}][VERIFY] verified ${username} via IMVU chat code`);
            return true;
        }
    } catch {
        /* not a pending verification code */
    }

    return false;
}
