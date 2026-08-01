import axios from 'axios';
import * as cheerio from 'cheerio';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import { normalizeRoomApiSlug } from '../user-tracker-utils.js';

const DEFAULT_LOGIN_URL = 'https://www.imvu.com/login/';
const DEFAULT_API_ORIGIN = 'https://api.imvu.com';
const DEFAULT_WEB_ORIGIN = 'https://www.imvu.com';

function truthy(value) {
    const v = String(value ?? '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function firstString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

async function setCookieHeader(jar, cookieHeader, origin) {
    const raw = String(cookieHeader || '').trim();
    if (!raw) return;
    for (const part of raw.split(/;\s*/).filter(Boolean)) {
        await jar.setCookie(part, origin);
    }
}

function pickForm($) {
    const selector = String(process.env.IMVU_LOGIN_FORM_SELECTOR || '').trim();
    if (selector) {
        const selected = $(selector).first();
        if (selected.length) return selected;
        throw new Error(`No login form matched IMVU_LOGIN_FORM_SELECTOR=${selector}`);
    }

    const passwordInput = $('input[type="password"]').first();
    const form = passwordInput.closest('form');
    if (form.length) return form;
    return $('form').first();
}

function collectFields($, form, bot) {
    const fields = new URLSearchParams();

    form.find('input, textarea, select').each((_, element) => {
        const input = $(element);
        const name = input.attr('name');
        if (!name || fields.has(name)) return;

        const type = String(input.attr('type') || '').toLowerCase();
        if (['button', 'file', 'image', 'reset', 'submit'].includes(type)) return;
        if ((type === 'checkbox' || type === 'radio') && !input.is(':checked')) return;

        fields.set(name, input.val() ?? '');
    });

    const usernameField = process.env.IMVU_LOGIN_USERNAME_FIELD || 'username';
    const passwordField = process.env.IMVU_LOGIN_PASSWORD_FIELD || 'password';
    fields.set(usernameField, bot.username || '');
    fields.set(passwordField, bot.password || '');

    const csrfField = String(process.env.IMVU_LOGIN_CSRF_FIELD || '').trim();
    if (csrfField && !fields.has(csrfField)) {
        const token = $(`input[name="${csrfField}"]`).first().val();
        if (token) fields.set(csrfField, token);
    }

    return fields;
}

function jsonLoginPayload(bot) {
    const usernameField = process.env.IMVU_LOGIN_USERNAME_FIELD || 'username';
    const passwordField = process.env.IMVU_LOGIN_PASSWORD_FIELD || 'password';
    const rawUsername = String(bot.username || '').trim();
    const username = truthy(process.env.IMVU_LOGIN_PRESERVE_USERNAME_CASE)
        ? rawUsername
        : rawUsername.toLowerCase();
    const payload = {
        [usernameField]: username,
        [passwordField]: bot.password || '',
    };

    if (process.env.IMVU_LOGIN_GDPR_COOKIE_ACCEPTANCE !== undefined) {
        payload.gdpr_cookie_acceptance = truthy(process.env.IMVU_LOGIN_GDPR_COOKIE_ACCEPTANCE);
    }

    return payload;
}

function describeLoginPayload(payload) {
    const usernameField = process.env.IMVU_LOGIN_USERNAME_FIELD || 'username';
    const passwordField = process.env.IMVU_LOGIN_PASSWORD_FIELD || 'password';
    const username = String(payload[usernameField] || '');
    const password = String(payload[passwordField] || '');
    return `${usernameField}=${username || '(empty)'} ${passwordField}_length=${password.length}`;
}

function summarizeLoginError(error) {
    const status = error.response?.status;
    const data = error.response?.data;
    const body =
        typeof data === 'string'
            ? data
            : data && typeof data === 'object'
              ? JSON.stringify(data)
              : '';
    return `JSON login failed${status ? ` HTTP ${status}` : ''}${body ? `: ${body.slice(0, 500)}` : ''}`;
}

function extractDenormalizedData(payload) {
    const denormalized = payload?.denormalized || {};
    const entry = (payload?.id && denormalized[payload.id]) || Object.values(denormalized)[0];
    return entry?.data || payload?.data || null;
}

function extractNumericUserIdFromText(text, { allowBareNumber = false } = {}) {
    const value = String(text || '');
    const direct =
        value.match(/(?:user|avatar)-(\d+)/i) ||
        value.match(/["'](?:user_id|userId|userid|cid|legacy_cid|avatar_id|avatarId)["']\s*:\s*["']?(\d+)["']?/i) ||
        value.match(/\/(?:user|avatar)\/(?:user-|avatar-)?(\d+)(?:$|[/?#])/i);
    if (direct) return direct[1];
    if (allowBareNumber && /^\d+$/.test(value)) return value;
    return null;
}

function findNumericUserId(value, seen = new Set()) {
    if (value == null) return null;
    if (typeof value === 'string') {
        return extractNumericUserIdFromText(value, { allowBareNumber: true });
    }
    if (typeof value !== 'object') return null;
    if (seen.has(value)) return null;
    seen.add(value);

    for (const key of ['user_id', 'userId', 'userid', 'cid', 'legacy_cid', 'avatar_id', 'avatarId', 'id']) {
        const raw = value[key];
        if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
        if (typeof raw === 'string') {
            const found = findNumericUserId(raw, seen);
            if (found) return found;
        }
    }

    for (const child of Object.values(value)) {
        const found = findNumericUserId(child, seen);
        if (found) return found;
    }
    return null;
}

function findBotImvuUserId(bot) {
    for (const key of ['imqUserId', 'imvu_user_id', 'imvuUserId', 'imvu_avatar_id', 'imvuAvatarId', 'avatar_id', 'avatarId']) {
        const found = findNumericUserId(bot?.[key]);
        if (found) return found;
    }
    return null;
}

function findLegacyChatQueue(value, seen = new Set()) {
    if (value == null) return null;
    if (typeof value === 'string') {
        const match = value.match(/\/chat\/(\d+)(?:$|[/?#"\s])/);
        return match ? `/chat/${match[1]}` : null;
    }
    if (typeof value !== 'object') return null;
    if (seen.has(value)) return null;
    seen.add(value);

    for (const key of ['queue', 'chat_queue', 'chatQueue', 'legacy_queue', 'legacyQueue']) {
        const found = findLegacyChatQueue(value[key], seen);
        if (found) return found;
    }
    for (const child of Object.values(value)) {
        const found = findLegacyChatQueue(child, seen);
        if (found) return found;
    }
    return null;
}

function findImvuSauce(value, seen = new Set()) {
    if (value == null || typeof value !== 'object') return '';
    if (seen.has(value)) return '';
    seen.add(value);

    for (const key of ['sauce', 'imvu_sauce', 'imvuSauce', 'x_imvu_sauce', 'xImvuSauce']) {
        const raw = value[key];
        if (typeof raw === 'string' && raw.trim()) return raw.trim();
    }
    for (const child of Object.values(value)) {
        const found = findImvuSauce(child, seen);
        if (found) return found;
    }
    return '';
}

function summarizeResponseData(data) {
    if (data == null || data === '') return '';
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    return body ? `: ${body.slice(0, 300)}` : '';
}

function denormalizedEntry(payload, preferredId = '') {
    const denormalized = payload?.denormalized;
    if (!denormalized || typeof denormalized !== 'object') return null;
    const key = preferredId && denormalized[preferredId] ? preferredId : payload?.id;
    if (key && denormalized[key]) return denormalized[key];
    const values = Object.values(denormalized);
    return values[0] || null;
}

function relationUrl(relations, key) {
    if (!relations || typeof relations !== 'object') return '';
    const raw = relations[key];
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
    if (Array.isArray(raw)) {
        const first = raw.find((v) => typeof v === 'string' && v.trim());
        return first ? String(first).trim() : '';
    }
    return '';
}

function experienceIdFromUrl(url) {
    const match = String(url || '').match(/experience-(\d+)/i);
    return match ? match[1] : '';
}

function extractParticipantData(payload, roomId, userId) {
    const denormalized = payload?.denormalized;
    if (!denormalized || typeof denormalized !== 'object') return null;

    const participantUrl = `${DEFAULT_API_ORIGIN}/chat/chat-${roomId}/participants/user-${userId}`;
    const direct = denormalized[participantUrl]?.data;
    if (direct && typeof direct === 'object' && direct.seat_number != null) return direct;

    for (const [key, entry] of Object.entries(denormalized)) {
        if (!key.includes(`/participants/user-${userId}`)) continue;
        const data = entry?.data;
        if (data && typeof data === 'object' && data.seat_number != null) return data;
    }

    if (direct && typeof direct === 'object') return direct;
    for (const [key, entry] of Object.entries(denormalized)) {
        if (key.endsWith(`/chat/chat-${roomId}/participants/user-${userId}`) && entry?.data) {
            return entry.data;
        }
    }
    return null;
}

function collectNumericUserIds(value, out = new Set(), seen = new Set()) {
    if (value == null) return out;
    if (typeof value === 'number' && Number.isFinite(value)) {
        const s = String(Math.trunc(value));
        if (/^\d{5,15}$/.test(s)) out.add(s);
        return out;
    }
    if (typeof value === 'string') {
        const direct = value.trim();
        if (/^\d{5,15}$/.test(direct)) out.add(direct);
        const re = /(?:user-|\/user\/user-)(\d{5,15})(?:[^0-9]|$)/gi;
        let match;
        while ((match = re.exec(value)) !== null) out.add(match[1]);
        return out;
    }
    if (typeof value !== 'object' || seen.has(value)) return out;
    seen.add(value);

    for (const child of Object.values(value)) {
        collectNumericUserIds(child, out, seen);
    }
    return out;
}

function participantSeatPayload(participant) {
    if (!participant || typeof participant !== 'object') return null;
    const seatNumber = Number(participant.seat_number);
    if (!Number.isFinite(seatNumber) || seatNumber <= 0) return null;

    const seatFurniId = Number(participant.seat_furni_id);
    return {
        seat_furni_id: Number.isFinite(seatFurniId) ? seatFurniId : 0,
        seat_number: seatNumber,
    };
}

function profileUrlForUsername(username) {
    const cleanUsername = String(username || '').trim();
    if (!cleanUsername) return '';
    const webOrigin = process.env.IMVU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN;
    return new URL(`/next/av/${encodeURIComponent(cleanUsername)}/`, webOrigin).href;
}

export function createImvuSessionClient({ bot = {}, agents = {}, logger = console } = {}) {
    const jar = new CookieJar();
    let loginResponseData = null;
    let cachedBotUserId = findBotImvuUserId(bot) || null;
    let imvuSauce = String(process.env.IMVU_X_SAUCE || process.env.IMVU_SAUCE || '').trim();
    const client = wrapper(
        axios.create({
            jar,
            withCredentials: true,
            timeout: Number(process.env.IMVU_HTTP_TIMEOUT_MS || 30000),
            maxRedirects: 5,
            ...agents.axios,
            headers: {
                Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
                'User-Agent':
                    process.env.IMVU_USER_AGENT ||
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36',
            },
        })
    );

    async function ensureLoggedIn() {
        const webOrigin = process.env.IMVU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN;
        await setCookieHeader(jar, process.env.IMVU_COOKIE_HEADER || process.env.IMVU_SESSION_COOKIE, webOrigin);
        await setCookieHeader(jar, process.env.IMVU_API_COOKIE_HEADER, process.env.IMVU_API_ORIGIN || DEFAULT_API_ORIGIN);

        const existingCookies = await jar.getCookies(webOrigin);
        if (existingCookies.length && !truthy(process.env.IMVU_FORCE_HTTP_LOGIN)) {
            logger.log(`[IMVU-SESSION] Using cookie jar with ${existingCookies.length} web cookies.`);
            return true;
        }

        if (!bot.username || !bot.password) {
            throw new Error('Bot username/password are required for HTTP login when no IMVU_COOKIE_HEADER is provided.');
        }

        const loginUrl = new URL(process.env.IMVU_LOGIN_URL || DEFAULT_LOGIN_URL);
        const contentType = String(process.env.IMVU_LOGIN_CONTENT_TYPE || 'form').trim().toLowerCase();

        if (contentType === 'json') {
            const payload = jsonLoginPayload(bot);
            logger.log(`[IMVU-SESSION] JSON login payload: ${describeLoginPayload(payload)}`);
            let res;
            try {
                res = await client.post(loginUrl.href, payload, {
                    headers: {
                        Accept: 'application/json; charset=utf-8',
                        'Content-Type': 'application/json; charset=UTF-8',
                        Origin: process.env.IMVU_LOGIN_ORIGIN || 'https://secure.imvu.com',
                        Referer: process.env.IMVU_LOGIN_REFERER || 'https://secure.imvu.com/',
                        'X-IMVU-Application': process.env.IMVU_X_APPLICATION || '',
                    },
                    validateStatus: (status) => status >= 200 && status < 400,
                });
            } catch (error) {
                throw new Error(summarizeLoginError(error));
            }

            logger.log(`[IMVU-SESSION] JSON login POST status ${res.status}`);
            loginResponseData = res.data;
            imvuSauce = findImvuSauce(loginResponseData) || imvuSauce;
            return true;
        }

        const loginPage = await client.get(loginUrl.href, {
            headers: { Accept: 'text/html,application/xhtml+xml' },
            validateStatus: (status) => status >= 200 && status < 400,
        });
        const $ = cheerio.load(loginPage.data);
        const form = pickForm($);
        if (!form.length) throw new Error('Could not locate an IMVU login form.');

        const actionUrl = new URL(
            firstString(process.env.IMVU_LOGIN_ACTION_URL, form.attr('action'), loginUrl.href),
            loginUrl
        );
        const fields = collectFields($, form, bot);

        const res = await client.post(actionUrl.href, fields, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Origin: loginUrl.origin,
                Referer: loginUrl.href,
            },
            validateStatus: (status) => status >= 200 && status < 400,
        });

        logger.log(`[IMVU-SESSION] Login POST status ${res.status}`);
        loginResponseData = res.data;
        imvuSauce = findImvuSauce(loginResponseData) || imvuSauce;
        return true;
    }

    async function cookieHeader(url = DEFAULT_WEB_ORIGIN) {
        return jar.getCookieString(url);
    }

    async function cookieValue(name, url = DEFAULT_WEB_ORIGIN) {
        const cookies = await jar.getCookies(url);
        return cookies.find((cookie) => cookie.key === name)?.value || '';
    }

    async function fetchProfileUserId() {
        const url = profileUrlForUsername(bot.username);
        if (!url) return null;
        try {
            const response = await client.get(url, {
                headers: {
                    Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
                    Referer: process.env.IMVU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN,
                },
                validateStatus: (status) => status >= 200 && status < 400,
            });
            const userId = extractNumericUserIdFromText(
                typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
            );
            if (userId) {
                logger.log(`[IMVU-SESSION] Resolved IMVU user id from public profile page.`);
            }
            return userId;
        } catch (error) {
            logger.warn(`[IMVU-SESSION] Could not resolve profile user id: ${error.message}`);
            return null;
        }
    }

    async function fetchApiUserId() {
        const username = String(bot.username || '').trim();
        if (!username) return null;
        return resolveUserIdFromUsername(username, { log: true });
    }

    async function resolveUserIdFromUsername(username, options = {}) {
        const name = String(username || '').trim();
        if (!name) return null;
        const shouldLog = options.log === true;
        try {
            const json = await apiGet(`/user?username=${encodeURIComponent(name)}`);
            const userId = findNumericUserId(json) || extractNumericUserIdFromText(JSON.stringify(json));
            if (userId && shouldLog) {
                logger.log(`[IMVU-SESSION] Resolved IMVU user id for ${name}.`);
            }
            return userId;
        } catch (error) {
            if (shouldLog) {
                logger.warn(`[IMVU-SESSION] Could not resolve user id for ${name}: ${error.message}`);
            }
            return null;
        }
    }

    async function resolveBotUserId() {
        if (cachedBotUserId && /^\d+$/.test(String(cachedBotUserId))) {
            return String(cachedBotUserId);
        }
        const fromBot = findBotImvuUserId(bot);
        if (fromBot) {
            cachedBotUserId = fromBot;
            return fromBot;
        }
        const fromLogin = findNumericUserId(loginResponseData);
        if (fromLogin) {
            cachedBotUserId = fromLogin;
            return fromLogin;
        }
        return null;
    }

    async function resolveImqIdentity() {
        const webOrigin = process.env.IMVU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN;
        const connectSource = await cookieValue('osCsid', webOrigin);
        const connectCookie = connectSource
            ? Buffer.from(connectSource, 'utf8').toString('base64')
            : '';
        const userId =
            findNumericUserId(loginResponseData) ||
            findBotImvuUserId(bot) ||
            (await fetchApiUserId()) ||
            (await fetchProfileUserId());
        if (userId) {
            cachedBotUserId = String(userId);
        }
        return {
            userId,
            connectCookie,
        };
    }

    async function apiGet(pathOrUrl, options = {}) {
        const url = /^https?:\/\//i.test(String(pathOrUrl))
            ? String(pathOrUrl)
            : new URL(String(pathOrUrl).replace(/^\/+/, ''), `${DEFAULT_API_ORIGIN}/`).href;
        const response = await client.get(url, {
            ...options,
            headers: {
                Accept: 'application/json',
                ...(options.headers || {}),
            },
        });
        return response.data;
    }

    async function resolveImvuSauce() {
        if (imvuSauce) return imvuSauce;
        imvuSauce = findImvuSauce(loginResponseData);
        if (imvuSauce) return imvuSauce;

        try {
            const response = await client.get(new URL('login/me', `${DEFAULT_API_ORIGIN}/`).href, {
                headers: {
                    Accept: 'application/json; charset=utf-8',
                    Origin: process.env.IMVU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN,
                    Referer: process.env.IMVU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN,
                },
                validateStatus: (status) => status >= 200 && status < 400,
            });
            loginResponseData = response.data;
            imvuSauce = findImvuSauce(response.data);
            if (imvuSauce) {
                logger.log(`[IMVU-SESSION] Resolved X-IMVU-Sauce from login/me.`);
            }
        } catch (error) {
            logger.warn(`[IMVU-SESSION] Could not resolve X-IMVU-Sauce: ${error.message}`);
        }

        return imvuSauce;
    }

    async function fetchRoomDetails(roomId) {
        const slug = normalizeRoomApiSlug(roomId);
        if (!slug) return null;
        try {
            const json = await apiGet(`/room/${slug}`);
            const data = extractDenormalizedData(json);
            if (!data) return null;
            const image =
                data.poster_url ||
                data.thumbnail_url ||
                data.image_url ||
                data.preview_url ||
                data.properties?.poster_url ||
                '';
            return {
                name: typeof data.name === 'string' ? data.name.trim() : '',
                image_url: typeof image === 'string' ? image.trim() : '',
                description: typeof data.description === 'string' ? data.description.trim() : '',
                occupancy: Number.isFinite(Number(data.occupancy)) ? Number(data.occupancy) : null,
                capacity: Number.isFinite(Number(data.capacity)) ? Number(data.capacity) : null,
                owner_avatarname:
                    typeof data.owner_avatarname === 'string' ? data.owner_avatarname.trim() : '',
            };
        } catch {
            return null;
        }
    }

    async function fetchRoomOwnerId(roomId) {
        const slug = normalizeRoomApiSlug(roomId);
        if (!slug) return null;
        try {
            const json = await apiGet(`/room/${slug}`);
            const data = extractDenormalizedData(json);
            if (!data || typeof data !== 'object') return null;

            const ownerKeys = [
                'owner_cid',
                'owner_id',
                'owner_user_id',
                'owner_userid',
                'owner_avatar_id',
                'creator_id',
                'creator_cid',
                'creator_user_id',
                'creator_userid',
                'proprietor_id',
                'room_owner_id',
                'owner',
                'creator',
            ];
            for (const key of ownerKeys) {
                if (!(key in data)) continue;
                const ownerId = findNumericUserId(data[key]);
                if (ownerId) return ownerId;
            }

            const prefixMatch = String(slug).match(/^room-(\d{5,15})-\d+$/i);
            const prefixId = prefixMatch ? prefixMatch[1] : null;
            if (prefixId) {
                const haystack = `${JSON.stringify(data)}\n${Object.keys(json?.denormalized || {}).join('\n')}`;
                const re = new RegExp(`(?:/user/user-|user-)${prefixId}(?:[^0-9]|$)`, 'i');
                if (re.test(haystack)) return prefixId;
            }
        } catch {
            return null;
        }
        return null;
    }

    async function fetchRoomModeratorIds(roomId) {
        const slug = normalizeRoomApiSlug(roomId);
        if (!slug) return [];
        const suffix = slug.replace(/^room-/i, '');
        const urls = [`/room/${slug}/moderators`, `/chat/chat-${suffix}/moderators`];
        const ids = new Set();

        for (const url of urls) {
            try {
                const json = await apiGet(url);
                collectNumericUserIds(json, ids);
            } catch {
                /* moderator endpoints are optional/shape-shifting */
            }
        }
        return [...ids];
    }

    /**
     * Moderator roster from IMVU REST (see api.imvu.com/room/room-{id}/moderators).
     * @returns {Promise<Array<{ username: string, display_name: string, legacy_cid: number|null }>>}
     */
    async function fetchRoomModerators(roomId) {
        const slug = normalizeRoomApiSlug(roomId);
        if (!slug) return [];
        const suffix = slug.replace(/^room-/i, '');
        const urls = [`/room/${slug}/moderators`, `/chat/chat-${suffix}/moderators`];
        const byUsername = new Map();

        for (const url of urls) {
            try {
                const json = await apiGet(url);
                const denorm = json?.denormalized || {};
                for (const [key, entry] of Object.entries(denorm)) {
                    if (!String(key).includes('/user/user-')) continue;
                    const data = entry?.data;
                    if (!data || typeof data !== 'object') continue;
                    const username = firstString(data.username, data.display_name);
                    const displayName = firstString(data.display_name, data.username);
                    if (!username && !displayName) continue;
                    const label = username || displayName;
                    byUsername.set(label, {
                        username: username || displayName,
                        display_name: displayName || username,
                        legacy_cid: Number.isFinite(Number(data.legacy_cid))
                            ? Number(data.legacy_cid)
                            : null,
                    });
                }
            } catch {
                /* optional */
            }
        }

        return [...byUsername.values()];
    }

    async function fetchUserName(userId) {
        const id = String(userId || '').trim();
        if (!/^\d+$/.test(id)) return null;
        try {
            const json = await apiGet(`/user/user-${id}`);
            const data = extractDenormalizedData(json);
            const username = firstString(data?.username, data?.display_name, data?.screen_name, data?.name);
            return username || null;
        } catch {
            return null;
        }
    }

    function extractProfileAge(data) {
        if (!data || typeof data !== 'object') return null;
        for (const key of ['age', 'user_age', 'profile_age', 'display_age', 'years_old']) {
            const n = Number(data[key]);
            if (Number.isFinite(n) && n >= 0 && n <= 120) return Math.round(n);
        }
        return null;
    }

    function collectWearableNameStrings(value, out, seen = new Set()) {
        if (value == null) return;
        if (typeof value === 'string') {
            const t = value.trim();
            if (t.length >= 3 && t.length <= 200) out.add(t);
            return;
        }
        if (typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) {
            for (const item of value) collectWearableNameStrings(item, out, seen);
            return;
        }
        const o = /** @type {Record<string, unknown>} */ (value);
        for (const key of ['name', 'product_name', 'display_name', 'title', 'label']) {
            if (typeof o[key] === 'string') out.add(String(o[key]).trim());
        }
        for (const child of Object.values(o)) collectWearableNameStrings(child, out, seen);
    }

    function collectScalerPercentsFromApi(value, out, seen = new Set()) {
        if (value == null) return;
        if (typeof value === 'number') return;
        if (typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) {
            for (const item of value) collectScalerPercentsFromApi(item, out, seen);
            return;
        }
        const o = /** @type {Record<string, unknown>} */ (value);
        for (const [key, raw] of Object.entries(o)) {
            if (typeof raw === 'number' && /scale|scaler|height/i.test(key)) {
                const pct = raw > 0 && raw <= 5 ? Math.round(raw * 100) : Math.round(raw);
                if (pct >= 50 && pct <= 500) out.add(pct);
            }
            collectScalerPercentsFromApi(raw, out, seen);
        }
    }

    async function apiGetWearableScan(userId) {
        const id = String(userId || '').trim();
        if (!/^\d+$/.test(id)) return { names: [], scalePercents: [] };
        const names = new Set();
        const scalePercents = new Set();
        const paths = [
            `/user/user-${id}`,
            `/inventory/outfit_list-${id}-1`,
            `/inventory/outfit-${id}-1`,
            `/inventory/outfit-${id}-2`,
        ];
        for (const path of paths) {
            try {
                const json = await apiGet(path);
                collectWearableNameStrings(json, names);
                collectScalerPercentsFromApi(json, scalePercents);
            } catch {
                /* optional */
            }
        }
        return {
            names: [...names].filter(Boolean),
            scalePercents: [...scalePercents],
        };
    }

    async function apiGetWearableNames(userId) {
        const scan = await apiGetWearableScan(userId);
        return scan.names;
    }

    function looksLikeUrlField(key, value) {
        if (typeof value !== 'string' || value === '') return false;
        if (!value.startsWith('http') && !value.startsWith('//')) return false;
        const k = String(key);
        return k.includes('url') || k.includes('image') || k.endsWith('_link');
    }

    function absoluteUrl(url) {
        const trimmed = String(url || '').trim();
        if (trimmed.startsWith('//')) return `https:${trimmed}`;
        return trimmed;
    }

    function normalizeUserProfile(data) {
        const profile = {};
        for (const [key, value] of Object.entries(data)) {
            if (typeof value === 'string' && looksLikeUrlField(key, value)) {
                profile[key] = absoluteUrl(value);
            } else {
                profile[key] = value;
            }
        }
        if (profile.legacy_cid != null) {
            profile.legacy_cid = Number(profile.legacy_cid);
        }
        profile.is_guest = Boolean(
            profile.is_guest ||
                profile.persona_type === 0 ||
                /^guest_/i.test(firstString(profile.username, profile.display_name))
        );
        return profile;
    }

    async function fetchFullUserProfile(userId) {
        const id = String(userId || '').trim();
        if (!/^\d+$/.test(id)) return null;
        try {
            const json = await apiGet(`/user/user-${id}`);
            const data = extractDenormalizedData(json);
            if (!data || typeof data !== 'object') return null;
            return normalizeUserProfile(data);
        } catch {
            return null;
        }
    }

    async function fetchUserProfile(userId) {
        const id = String(userId || '').trim();
        if (!/^\d+$/.test(id)) return null;
        try {
            const json = await apiGet(`/user/user-${id}`);
            const data = extractDenormalizedData(json);
            if (!data || typeof data !== 'object') return null;
            return {
                username: firstString(data.username, data.display_name, data.screen_name, data.name),
                created: firstString(data.created),
                registered: data.registered ?? null,
                display_name: firstString(data.display_name),
                profile_age: extractProfileAge(data),
                is_guest: Boolean(
                    data.is_guest ||
                        data.persona_type === 0 ||
                        /^guest_/i.test(firstString(data.username, data.display_name))
                ),
            };
        } catch {
            return null;
        }
    }

    async function fetchLegacyChatQueue(roomId) {
        const normalizedRoomId = String(roomId || '').trim().replace(/^room-/i, '');
        if (!/^\d+-\d+$/.test(normalizedRoomId)) return null;
        try {
            const json = await apiGet(`/chat/chat-${normalizedRoomId}`);
            const queue = findLegacyChatQueue(json);
            if (queue) {
                logger.log(`[IMVU-SESSION] Resolved legacy IMVU chat queue for room ${normalizedRoomId}.`);
            }
            return queue;
        } catch (error) {
            logger.warn(`[IMVU-SESSION] Could not resolve legacy chat queue for room ${normalizedRoomId}: ${error.message}`);
            return null;
        }
    }

    /**
     * Hard join probe: 403/401 on chat (and no live audience fallback) means the bot
     * cannot enter — dashboard should drop the room instead of retrying forever.
     * @returns {Promise<{ ok: boolean, reason: string, status?: number }>}
     */
    async function probeRoomJoinAccess(roomId) {
        const normalizedRoomId = String(roomId || '').trim().replace(/^room-/i, '');
        if (!/^\d+-\d+$/.test(normalizedRoomId)) {
            return { ok: false, reason: 'bad-room-id' };
        }

        let chatStatus = 0;
        try {
            const response = await client.get(
                new URL(`chat/chat-${normalizedRoomId}`, `${DEFAULT_API_ORIGIN}/`).href,
                {
                    headers: { Accept: 'application/json' },
                    validateStatus: () => true,
                    timeout: Number(process.env.IMVU_ROOM_PROBE_TIMEOUT_MS || 15000),
                },
            );
            chatStatus = Number(response.status) || 0;
            if (chatStatus >= 200 && chatStatus < 300 && findLegacyChatQueue(response.data)) {
                return { ok: true, reason: 'legacy-chat', status: chatStatus };
            }
        } catch (error) {
            const msg = String(error?.message || error || '');
            if (/403|401|forbidden|unauthorized/i.test(msg)) {
                return { ok: false, reason: 'forbidden', status: 403 };
            }
            if (/404|not found/i.test(msg)) {
                return { ok: false, reason: 'not-found', status: 404 };
            }
        }

        const live = await fetchLiveRoomContext(normalizedRoomId);
        if (live?.isLive && (live.audienceQueue || live.hangoutQueue)) {
            return { ok: true, reason: 'live-audience' };
        }

        if (chatStatus === 403 || chatStatus === 401) {
            return { ok: false, reason: 'forbidden', status: chatStatus };
        }
        if (chatStatus === 404) {
            return { ok: false, reason: 'not-found', status: chatStatus };
        }

        // Soft unknown — do not auto-delete (transient IMVU/network blips).
        return { ok: true, reason: 'unknown-allow', status: chatStatus || undefined };
    }

    async function fetchChatParticipant(roomId, userId, sauce = '') {
        const normalizedRoomId = String(roomId || '').trim().replace(/^room-/i, '');
        const normalizedUserId = String(userId || '').trim();
        if (!/^\d+-\d+$/.test(normalizedRoomId) || !/^\d+$/.test(normalizedUserId)) return null;

        const resolvedSauce = sauce || (await resolveImvuSauce());
        const response = await client.get(
            new URL(
                `chat/chat-${normalizedRoomId}/participants/user-${normalizedUserId}`,
                `${DEFAULT_API_ORIGIN}/`
            ).href,
            {
                headers: {
                    Accept: 'application/json; charset=utf-8',
                    Origin: process.env.IMVU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN,
                    Referer: `${process.env.IMVU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN}/next/chat/room-${normalizedRoomId}/`,
                    'X-IMVU-Application': process.env.IMVU_X_APPLICATION || 'next_desktop/1',
                    ...(resolvedSauce ? { 'X-IMVU-Sauce': resolvedSauce } : {}),
                },
                validateStatus: (status) => status >= 200 && status < 500,
            }
        );
        if (response.status < 200 || response.status >= 300) return null;
        return extractParticipantData(response.data, normalizedRoomId, normalizedUserId);
    }

    async function updateChatParticipantSeat(roomId, userId, seat) {
        const normalizedRoomId = String(roomId || '').trim().replace(/^room-/i, '');
        const normalizedUserId = String(userId || '').trim();
        if (!/^\d+-\d+$/.test(normalizedRoomId) || !/^\d+$/.test(normalizedUserId)) return null;

        const seatNumber = Number(seat?.seatNumber ?? seat?.seat_number);
        if (!Number.isFinite(seatNumber) || seatNumber <= 0) return null;
        const seatFurniId = Number(seat?.seatFurniId ?? seat?.seat_furni_id);
        const furni = Number.isFinite(seatFurniId) ? seatFurniId : 0;
        const payload = {
            seat_furni_id: String(furni),
            seat_number: seatNumber,
        };

        const sauce = await resolveImvuSauce();
        const participantUrl = new URL(
            `chat/chat-${normalizedRoomId}/participants/user-${normalizedUserId}`,
            `${DEFAULT_API_ORIGIN}/`
        ).href;
        const headers = {
            Accept: 'application/json; charset=utf-8',
            'Content-Type': 'application/json; charset=UTF-8',
            Origin: process.env.IMVU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN,
            Referer: `${process.env.IMVU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN}/next/chat/room-${normalizedRoomId}/`,
            'X-IMVU-Application': process.env.IMVU_X_APPLICATION || 'next_desktop/1',
            ...(sauce ? { 'X-IMVU-Sauce': sauce } : {}),
        };

        try {
            const response = await client.request({
                method: 'post',
                url: participantUrl,
                data: payload,
                headers,
                validateStatus: (status) => status >= 200 && status < 500,
            });
            if (response.status < 200 || response.status >= 300) {
                logger.warn(
                    `[IMVU-SESSION] updateChatParticipantSeat user-${normalizedUserId} chat-${normalizedRoomId} ${response.status}${summarizeResponseData(response.data)}`
                );
                return null;
            }
            const participant = extractParticipantData(response.data, normalizedRoomId, normalizedUserId);
            logger.log(
                `[IMVU-SESSION] Updated seat for user-${normalizedUserId} in chat-${normalizedRoomId} -> seat ${seatNumber} furni ${furni}.`
            );
            return participant;
        } catch (error) {
            logger.warn(
                `[IMVU-SESSION] updateChatParticipantSeat user-${normalizedUserId} chat-${normalizedRoomId}: ${error.message}`
            );
            return null;
        }
    }

    const liveRoomContextCache = new Map();

    async function fetchLiveRoomContext(roomId, { force = false } = {}) {
        const normalizedRoomId = String(roomId || '').trim().replace(/^room-/i, '');
        if (!/^\d+-\d+$/.test(normalizedRoomId)) return null;

        const cached = liveRoomContextCache.get(normalizedRoomId);
        const now = Date.now();
        if (!force && cached && now - cached.fetchedAt < 60_000) {
            return cached.value;
        }

        try {
            const roomPayload = await apiGet(`/room/room-${normalizedRoomId}`);
            const roomEntry = denormalizedEntry(roomPayload, `https://api.imvu.com/room/room-${normalizedRoomId}`);
            const roomData = roomEntry?.data || {};
            const roomRelations = roomEntry?.relations || {};
            const supportsAudience = Boolean(roomData.supports_audience);
            const hangoutUrl =
                relationUrl(roomRelations, 'hangout_experience') ||
                relationUrl(roomRelations, 'media_experience');

            if (!supportsAudience || !hangoutUrl) {
                const value = null;
                liveRoomContextCache.set(normalizedRoomId, { fetchedAt: now, value });
                return null;
            }

            const hangoutPayload = await apiGet(hangoutUrl);
            const hangoutEntry = denormalizedEntry(hangoutPayload, hangoutUrl);
            const hangoutData = hangoutEntry?.data || {};
            const hangoutRelations = hangoutEntry?.relations || {};
            const audienceUrl = relationUrl(hangoutRelations, 'audience_experience');
            const sceneUrl = relationUrl(hangoutRelations, 'scene_experience');
            if (!audienceUrl) {
                liveRoomContextCache.set(normalizedRoomId, { fetchedAt: now, value: null });
                return null;
            }

            const audiencePayload = await apiGet(audienceUrl);
            const audienceEntry = denormalizedEntry(audiencePayload, audienceUrl);
            const audienceData = audienceEntry?.data || {};

            let sceneData = {};
            if (sceneUrl) {
                try {
                    const scenePayload = await apiGet(sceneUrl);
                    sceneData = denormalizedEntry(scenePayload, sceneUrl)?.data || {};
                } catch {
                    /* scene metadata optional for audience join */
                }
            }

            const hangoutExperienceId = experienceIdFromUrl(hangoutUrl);
            const value = {
                isLive: true,
                roomId: normalizedRoomId,
                mimicChatRoom: Boolean(roomData.mimic_chat_room),
                hangoutExperienceUrl: hangoutUrl,
                hangoutExperienceId,
                hangoutQueue: String(hangoutData.queue || '').trim(),
                hangoutStateMount: String(hangoutData.state_mount || '').trim(),
                audienceExperienceUrl: audienceUrl,
                audienceQueue: String(audienceData.queue || '').trim(),
                audienceMessageMount: String(audienceData.message_mount || 'audience_message_mount').trim(),
                audienceStateMount: String(audienceData.state_mount || '').trim(),
                sceneExperienceUrl: sceneUrl,
                sceneQueue: String(sceneData.queue || '').trim(),
                sceneMessageMount: String(sceneData.message_mount || '').trim(),
                sceneStateMount: String(sceneData.state_mount || '').trim(),
                chatId: hangoutExperienceId || normalizedRoomId.split('-')[1] || normalizedRoomId,
            };
            liveRoomContextCache.set(normalizedRoomId, { fetchedAt: now, value });
            return value;
        } catch (error) {
            logger.warn(
                `[IMVU-SESSION] Could not resolve live/audience context for room ${normalizedRoomId}: ${error.message}`
            );
            return null;
        }
    }

    async function postExperienceAction(experienceUrl, actionType, roomId) {
        const url = String(experienceUrl || '').trim();
        if (!url) return { ok: false, status: 0, data: null, error: 'missing experience url' };
        const sauce = await resolveImvuSauce();
        const normalizedRoomId = String(roomId || '').trim().replace(/^room-/i, '');
        const response = await client.request({
            method: 'post',
            url,
            data: { action: { type: actionType } },
            headers: {
                Accept: 'application/json; charset=utf-8',
                'Content-Type': 'application/json; charset=UTF-8',
                Origin: process.env.IMVU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN,
                Referer: `${process.env.IMVU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN}/next/chat/room-${normalizedRoomId}/`,
                'X-IMVU-Application': process.env.IMVU_X_APPLICATION || 'next_desktop/1',
                ...(sauce ? { 'X-IMVU-Sauce': sauce } : {}),
            },
            validateStatus: (status) => status >= 200 && status < 500,
        });
        const failure = parseImvuApiFailure(response.data);
        const already =
            failure?.error === 'AUDIENCE-EXPERIENCE-005' ||
            /already joined/i.test(String(failure?.message || ''));
        const ok =
            (response.status >= 200 && response.status < 300) ||
            response.status === 409 ||
            already;
        return {
            ok,
            status: response.status,
            data: response.data,
            error: failure?.error || '',
            message: failure?.message || '',
            already,
        };
    }

    async function ensureAudienceJoin(roomId, context = null) {
        const normalizedRoomId = String(roomId || '').trim().replace(/^room-/i, '');
        const live = context?.isLive ? context : await fetchLiveRoomContext(normalizedRoomId);
        if (!live?.audienceExperienceUrl) return false;

        const result = await postExperienceAction(live.audienceExperienceUrl, 'join', normalizedRoomId);
        if (!result.ok) {
            logger.warn(
                `[IMVU-SESSION] Audience join failed for room ${normalizedRoomId}: ` +
                    `${result.status}${result.error ? ` ${result.error}` : ''}` +
                    `${result.message ? ` ${result.message}` : ''}`
            );
            return false;
        }
        logger.log(
            `[IMVU-SESSION] Joined audience experience for room ${normalizedRoomId}` +
                ` via POST ${live.audienceExperienceUrl}` +
                (result.already ? ' (already joined)' : ` ${result.status}`) +
                '.'
        );
        return { ...live, mode: 'audience', status: result.status, already: result.already };
    }

    async function leaveAudienceJoin(roomId, context = null) {
        const normalizedRoomId = String(roomId || '').trim().replace(/^room-/i, '');
        const live = context?.isLive ? context : await fetchLiveRoomContext(normalizedRoomId);
        if (!live?.audienceExperienceUrl) return { ok: false, status: 'not_live', attempts: [] };

        const result = await postExperienceAction(live.audienceExperienceUrl, 'leave', normalizedRoomId);
        if (!result.ok) {
            logger.warn(
                `[IMVU-SESSION] Audience leave failed for room ${normalizedRoomId}: ` +
                    `${result.status}${result.error ? ` ${result.error}` : ''}`
            );
            return { ok: false, status: result.status, attempts: [result] };
        }
        logger.log(`[IMVU-SESSION] Left audience experience for room ${normalizedRoomId}.`);
        return { ok: true, status: result.status, attempts: [result], mode: 'audience' };
    }

    /**
     * Send a room invite to another user (classic chat invites edge, or live sendInvite).
     * Returns inviteId + joinUrl when IMVU accepts the invite.
     */
    async function inviteUserToRoom(roomId, recipientUserId) {
        const normalizedRoomId = String(roomId || '').trim().replace(/^room-/i, '');
        const recipientId = String(recipientUserId || '').trim();
        if (!/^\d+-\d+$/.test(normalizedRoomId) || !/^\d+$/.test(recipientId)) {
            return { ok: false, error: 'invalid', message: 'Invalid room or recipient id' };
        }

        const joinUrl =
            String(process.env.IMVU_ROOM_JOIN_URL_TEMPLATE || '')
                .replace(/\{room\}/gi, normalizedRoomId)
                .trim() || `https://go.imvu.com/chat/room-${normalizedRoomId}`;

        // Inviter must be a participant for classic chat invites to deliver.
        const botUserId = await resolveBotUserId();
        if (botUserId) {
            await ensureChatParticipant(normalizedRoomId, botUserId).catch(() => false);
        }

        const sauce = await resolveImvuSauce();
        const headers = {
            Accept: 'application/json; charset=utf-8',
            'Content-Type': 'application/json; charset=UTF-8',
            Origin: process.env.IMVU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN,
            Referer: `${process.env.IMVU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN}/next/chat/room-${normalizedRoomId}/`,
            'X-IMVU-Application': process.env.IMVU_X_APPLICATION || 'next_desktop/1',
            ...(sauce ? { 'X-IMVU-Sauce': sauce } : {}),
        };

        const live = await fetchLiveRoomContext(normalizedRoomId);
        if (live?.isLive && live.audienceExperienceUrl) {
            const response = await client.request({
                method: 'post',
                url: live.audienceExperienceUrl,
                data: {
                    action: {
                        type: 'sendInvite',
                        payload: { recipient: recipientId },
                    },
                },
                headers,
                validateStatus: (status) => status >= 200 && status < 500,
            });
            const failure = parseImvuApiFailure(response.data);
            const ok = response.status >= 200 && response.status < 300;
            if (!ok) {
                logger.warn(
                    `[IMVU-SESSION] Live room invite to user-${recipientId} for ${normalizedRoomId} failed: ` +
                        `${response.status}${failure?.error ? ` ${failure.error}` : ''}` +
                        `${failure?.message ? ` ${failure.message}` : ''}`
                );
                return {
                    ok: false,
                    mode: 'audience',
                    status: response.status,
                    error: failure?.error || '',
                    message: failure?.message || `HTTP ${response.status}`,
                    joinUrl,
                };
            }
            logger.log(
                `[IMVU-SESSION] Invited user-${recipientId} to live room ${normalizedRoomId} via audience sendInvite.`
            );
            return {
                ok: true,
                mode: 'audience',
                status: response.status,
                inviteId: '',
                joinUrl,
                roomId: normalizedRoomId,
            };
        }

        // Official Next: room.getSingleEdge("chat").getEdgeCollection("invites").create({relations:{recipient:user.url()}})
        let inviteUrl = new URL(
            `chat/chat-${normalizedRoomId}/invites`,
            `${DEFAULT_API_ORIGIN}/`
        ).href;
        try {
            const roomPayload = await apiGet(`/room/room-${normalizedRoomId}`);
            const roomNode =
                roomPayload?.denormalized?.[`https://api.imvu.com/room/room-${normalizedRoomId}`] ||
                null;
            const chatUrl = String(roomNode?.relations?.chat || '').trim();
            if (chatUrl) {
                const chatPayload = await apiGet(chatUrl.replace(/^https?:\/\/api\.imvu\.com/i, ''));
                const chatNode = chatPayload?.denormalized?.[chatUrl] || null;
                const collectionUrl = String(chatNode?.relations?.invites || '').trim();
                if (collectionUrl) inviteUrl = collectionUrl;
            }
        } catch {
            // Fall back to chat/chat-{roomId}/invites
        }

        // Match EdgeCollection.create — user node URL only (not profile).
        const recipient = `https://api.imvu.com/user/user-${recipientId}`;
        const response = await client.request({
            method: 'post',
            url: inviteUrl,
            data: { relations: { recipient } },
            headers,
            validateStatus: (status) => status >= 200 && status < 500,
        });
        const failure = parseImvuApiFailure(response.data);
        const ok =
            (response.status >= 200 && response.status < 300) || response.status === 409;
        if (!ok) {
            logger.warn(
                `[IMVU-SESSION] Chat invite to user-${recipientId} for ${normalizedRoomId} failed: ` +
                    `${response.status}${failure?.error ? ` ${failure.error}` : ''}` +
                    `${failure?.message ? ` ${failure.message}` : ''}`
            );
            return {
                ok: false,
                mode: 'chat',
                status: response.status,
                error: failure?.error || '',
                message: failure?.message || `HTTP ${response.status}`,
                joinUrl,
            };
        }

        const location =
            String(response.headers?.location || response.headers?.Location || '').trim() ||
            String(response.data?.id || '').trim();
        // Official client loads Location into the invites collection after 201.
        if (location) {
            try {
                await client.get(location, {
                    headers,
                    validateStatus: (status) => status >= 200 && status < 500,
                });
            } catch {
                // non-fatal
            }
        }

        const inviteIdMatch = location.match(/invite-(\d+)/i);
        const inviteId = inviteIdMatch ? inviteIdMatch[1] : '';
        const roomRel =
            response.data?.denormalized?.[`https://api.imvu.com/invite/invite-${inviteId}`]
                ?.relations?.room || '';
        logger.log(
            `[IMVU-SESSION] Invited user-${recipientId} to room ${normalizedRoomId}` +
                ` via chat invites ${response.status}` +
                (inviteId ? ` (invite-${inviteId})` : '') +
                (roomRel ? ` room=${roomRel}` : '') +
                '.'
        );
        return {
            ok: true,
            mode: 'chat',
            status: response.status,
            inviteId,
            joinUrl,
            roomId: normalizedRoomId,
            inviteUrl: location || inviteUrl,
        };
    }

    async function ensureChatParticipant(roomId, userId, options = {}) {
        const normalizedRoomId = String(roomId || '').trim().replace(/^room-/i, '');
        const normalizedUserId = String(userId || '').trim();
        if (!/^\d+-\d+$/.test(normalizedRoomId) || !/^\d+$/.test(normalizedUserId)) return false;

        const live = await fetchLiveRoomContext(normalizedRoomId);
        if (live?.isLive) {
            const joined = await ensureAudienceJoin(normalizedRoomId, live);
            if (!joined) return false;
            return {
                participant: null,
                method: 'post',
                path: live.audienceExperienceUrl,
                status: joined.status,
                mode: 'audience',
                live,
            };
        }

        const refreshPayload = participantSeatPayload(options.participant);
        const candidates = refreshPayload
            ? [
                  {
                      method: 'post',
                      path: `/chat/chat-${normalizedRoomId}/participants/user-${normalizedUserId}`,
                      data: refreshPayload,
                  },
                  {
                      method: 'put',
                      path: `/chat/chat-${normalizedRoomId}/participants/user-${normalizedUserId}`,
                      data: refreshPayload,
                  },
                  {
                      method: 'post',
                      path: `/chat/chat-${normalizedRoomId}/participants`,
                      data: {},
                  },
                  {
                      method: 'get',
                      path: `/chat/chat-${normalizedRoomId}/participants/user-${normalizedUserId}`,
                  },
              ]
            : [
                  {
                      method: 'post',
                      path: `/chat/chat-${normalizedRoomId}/participants`,
                      data: {},
                  },
                  {
                      method: 'get',
                      path: `/chat/chat-${normalizedRoomId}/participants/user-${normalizedUserId}`,
                  },
                  {
                      method: 'put',
                      path: `/chat/chat-${normalizedRoomId}/participants/user-${normalizedUserId}`,
                      data: {},
                  },
                  {
                      method: 'post',
                      path: `/chat/chat-${normalizedRoomId}/participants/user-${normalizedUserId}`,
                      data: {},
                  },
              ];

        const sauce = await resolveImvuSauce();
        const failures = [];
        for (const candidate of candidates) {
            try {
                const response = await client.request({
                    method: candidate.method,
                    url: new URL(candidate.path.replace(/^\/+/, ''), `${DEFAULT_API_ORIGIN}/`).href,
                    data: candidate.data,
                    headers: {
                        Accept: 'application/json; charset=utf-8',
                        'Content-Type': 'application/json; charset=UTF-8',
                        Origin: process.env.IMVU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN,
                        Referer: `${process.env.IMVU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN}/next/chat/room-${normalizedRoomId}/`,
                        'X-IMVU-Application': process.env.IMVU_X_APPLICATION || 'next_desktop/1',
                        ...(sauce ? { 'X-IMVU-Sauce': sauce } : {}),
                    },
                    validateStatus: (status) => status >= 200 && status < 500,
                });
                if ((response.status >= 200 && response.status < 300) || response.status === 409) {
                    let participant = extractParticipantData(response.data, normalizedRoomId, normalizedUserId);
                    if (!participant && candidate.method !== 'get') {
                        try {
                            participant = await fetchChatParticipant(normalizedRoomId, normalizedUserId, sauce);
                        } catch {}
                    }
                    logger.log(
                        `[IMVU-SESSION] Ensured chat participant user-${normalizedUserId} in chat-${normalizedRoomId} via ${candidate.method.toUpperCase()} ${candidate.path} ${response.status}.`
                    );
                    return {
                        participant,
                        method: candidate.method,
                        path: candidate.path,
                        status: response.status,
                    };
                }
                failures.push(
                    `${candidate.method.toUpperCase()} ${candidate.path} ${response.status}${summarizeResponseData(response.data)}`
                );
            } catch (error) {
                failures.push(`${candidate.method.toUpperCase()} ${candidate.path} ${error.message}`);
            }
        }

        const primary = failures.find((f) => /AUTHORIZATION|FORBIDDEN|403/i.test(f)) || failures[0] || 'no method attempted';
        logger.warn(
            `[IMVU-SESSION] Could not ensure chat participant user-${normalizedUserId} in chat-${normalizedRoomId}: ${primary}` +
                (failures.length > 1 ? ` (+${failures.length - 1} more)` : '')
        );
        return false;
    }

    async function removeChatParticipant(roomId, userId) {
        const normalizedRoomId = String(roomId || '').trim().replace(/^room-/i, '');
        const normalizedUserId = String(userId || '').trim();
        if (!/^\d+-\d+$/.test(normalizedRoomId) || !/^\d+$/.test(normalizedUserId)) {
            return { ok: false, status: 'invalid', attempts: [] };
        }

        const live = await fetchLiveRoomContext(normalizedRoomId);
        if (live?.isLive) {
            return leaveAudienceJoin(normalizedRoomId, live);
        }

        const sauce = await resolveImvuSauce();
        const attempts = [];
        const candidates = [
            `/chat/chat-${normalizedRoomId}/participants/user-${normalizedUserId}`,
            `/chat/chat-${normalizedRoomId}/participants/user-${normalizedUserId}/`,
        ];

        for (const path of candidates) {
            try {
                const response = await client.delete(
                    new URL(path.replace(/^\/+/, ''), `${DEFAULT_API_ORIGIN}/`).href,
                    {
                        headers: {
                            Accept: 'application/json; charset=utf-8',
                            'Content-Type': 'application/json; charset=UTF-8',
                            Origin: process.env.IMVU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN,
                            Referer: `${process.env.IMVU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN}/next/chat/room-${normalizedRoomId}/`,
                            'X-IMVU-Application': process.env.IMVU_X_APPLICATION || 'next_desktop/1',
                            ...(sauce ? { 'X-IMVU-Sauce': sauce } : {}),
                        },
                        validateStatus: (status) => status >= 200 && status < 500,
                    }
                );
                attempts.push({ path, status: response.status });
                if (response.status === 204 || (response.status >= 200 && response.status < 300)) {
                    logger.log(
                        `[IMVU-SESSION] Removed chat participant user-${normalizedUserId} from chat-${normalizedRoomId} via DELETE ${path} ${response.status}.`
                    );
                    return { ok: true, status: response.status, attempts };
                }
            } catch (error) {
                attempts.push({ path, status: `error:${error.message}` });
            }
        }

        logger.warn(
            `[IMVU-SESSION] Could not remove chat participant user-${normalizedUserId} from chat-${normalizedRoomId}: ${JSON.stringify(attempts)}`
        );
        return { ok: false, status: attempts.at(-1)?.status || 'failed', attempts };
    }

    async function imvuNextApiHeaders(roomId) {
        const normalizedRoomId = String(roomId || '').trim().replace(/^room-/i, '');
        const sauce = await resolveImvuSauce();
        return {
            Accept: 'application/json; charset=utf-8',
            'Content-Type': 'application/json; charset=UTF-8',
            Origin: process.env.IMVU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN,
            Referer: `${process.env.IMVU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN}/next/chat/room-${normalizedRoomId}/`,
            'X-IMVU-Application': process.env.IMVU_X_APPLICATION || 'next_desktop/1',
            ...(sauce ? { 'X-IMVU-Sauce': sauce } : {}),
        };
    }

    function findRadioMediaPlayerUrl(playersJson) {
        for (const [nodeUrl, node] of Object.entries(playersJson?.denormalized || {})) {
            if (!nodeUrl.includes('/media_player/media_player-')) continue;
            const type = node?.data?.type;
            if (type?.provider === 'web_radio' && type?.format === 'radio') {
                return nodeUrl;
            }
        }
        return null;
    }

    const radioPlayerUrlCache = new Map();
    /** Per-room radio op queue — never alias a newer set/stop onto an older in-flight promise. */
    /** @type {Map<string, Promise<unknown>>} */
    const radioUpdateTail = new Map();
    /** @type {Map<string, number>} roomId → suppress self-rejoin until (ms) */
    const radioOpQuietUntil = new Map();
    /** @type {Map<string, { url: string, stationName: string, at: number }>} */
    const lastAppliedRoomRadio = new Map();
    /** Fresh If-Match etags from the last radio POST — skip player GET on same-URL pulse. */
    /** @type {Map<string, { etag: string, stationUrl: string, at: number }>} */
    const radioPlayerEtagCache = new Map();

    function rememberRadioEtag(roomId, etag, stationUrl) {
        const key = String(roomId || '').trim();
        const tag = String(etag || '').trim();
        if (!key || !tag) return;
        radioPlayerEtagCache.set(key, {
            etag: tag,
            stationUrl: canonicalRadioStationUrl(stationUrl),
            at: Date.now(),
        });
    }

    function markRadioOpQuiet(roomId, extraMs = null) {
        const key = String(roomId || '').trim();
        if (!key) return;
        const base = Math.max(
            15000,
            parseInt(String(process.env.IMVU_RADIO_SELF_REJOIN_QUIET_MS || '60000'), 10) || 60000,
        );
        const ms = extraMs != null ? Math.max(base, Number(extraMs) || base) : base;
        const until = Date.now() + ms;
        const prev = radioOpQuietUntil.get(key) || 0;
        if (until > prev) radioOpQuietUntil.set(key, until);
    }

    function isRadioOpQuiet(roomId) {
        const until = radioOpQuietUntil.get(String(roomId || '').trim()) || 0;
        return Date.now() < until;
    }

    /**
     * Run radio stop/set ops strictly in order per room.
     * Previous "return inflight" logic made setRoomRadioStreamUrl accidentally return a stop result.
     * @template T
     * @param {string} roomId
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    function enqueueRoomRadioOp(roomId, fn) {
        const key = String(roomId || '').trim();
        const prev = radioUpdateTail.get(key) ?? Promise.resolve();
        const next = prev.catch(() => {}).then(fn);
        radioUpdateTail.set(
            key,
            next.finally(() => {
                if (radioUpdateTail.get(key) === next) radioUpdateTail.delete(key);
            }),
        );
        return next;
    }

    async function fetchRoomRadioMediaInfo(roomId) {
        const normalizedRoomId = String(roomId || '').trim();
        const cached = radioPlayerUrlCache.get(normalizedRoomId);
        if (cached && Date.now() - cached.at < 5 * 60 * 1000) {
            return cached;
        }

        const slug = normalizeRoomApiSlug(roomId);
        if (!slug) return null;
        try {
            const roomJson = await apiGet(`/room/${slug}`);
            const roomUrl = `${DEFAULT_API_ORIGIN}/room/${slug}`;
            const roomObj = roomJson?.denormalized?.[roomUrl] || Object.values(roomJson?.denormalized || {})[0];
            const expUrl = String(roomObj?.relations?.media_experience || '').trim();
            if (!expUrl) return null;
            const expJson = await apiGet(expUrl);
            const expObj = expJson?.denormalized?.[expUrl] || Object.values(expJson?.denormalized || {})[0];
            const playersUrl = String(expObj?.relations?.media_players || '').trim();
            if (!playersUrl) return null;
            const playersJson = await apiGet(playersUrl);
            const playerUrl = findRadioMediaPlayerUrl(playersJson);
            if (!playerUrl) return null;

            const playerJson = await apiGet(playerUrl);
            const playerNode =
                playerJson?.denormalized?.[playerUrl] ||
                Object.values(playerJson?.denormalized || {}).find((n) =>
                    String(n?.updates?.queue || '').includes('/media_player/'),
                );
            const updateQueue = String(playerNode?.updates?.queue || '').trim();
            const expId = expUrl.split('/').pop() || '';
            const playerId = playerUrl.split('/').pop() || '';
            const experiencePlayerUrl = expId && playerId
                ? `${DEFAULT_API_ORIGIN}/experience/${expId}/media_players/${playerId}`
                : '';

            const info = {
                url: playerUrl,
                updateQueue,
                experiencePlayerUrl,
                mediaTargetsUrl: String(expObj?.relations?.media_targets || '').trim(),
                at: Date.now(),
            };
            radioPlayerUrlCache.set(normalizedRoomId, info);
            return info;
        } catch (error) {
            logger.warn(`[IMVU-SESSION] Could not resolve room radio player for ${roomId}: ${error.message}`);
            return null;
        }
    }

    async function fetchRoomRadioMediaPlayerUrl(roomId) {
        const info = await fetchRoomRadioMediaInfo(roomId);
        return info?.url || null;
    }

    async function fetchRoomMediaPlayerUpdateQueue(roomId) {
        const info = await fetchRoomRadioMediaInfo(roomId);
        return info?.updateQueue || null;
    }

    function canonicalRadioStationUrl(url) {
        const raw = String(url || '').trim();
        if (!raw) return raw;
        try {
            const parsed = new URL(raw);
            parsed.hash = '';
            // Only strip Icecast cache-bust params. Keep signed CDN/R2/S3 query strings
            // (X-Amz-*, Signature, …) — clearing search entirely breaks VibeVerse playback.
            parsed.searchParams.delete('_play');
            return parsed.toString();
        } catch {
            return raw.split('#')[0];
        }
    }

    async function waitForRoomRadioStatus(roomId, wantStatus, timeoutMs = 3500) {
        const want = String(wantStatus || '').trim().toLowerCase();
        const budget = Math.max(0, Number(timeoutMs) || 0);
        if (budget <= 0) return false;
        const deadline = Date.now() + budget;
        while (Date.now() < deadline) {
            const st = await fetchRoomMediaPlaybackState(roomId);
            if (st.ok && String(st.status || '').trim().toLowerCase() === want) return true;
            await new Promise((r) => setTimeout(r, 180));
        }
        return false;
    }

    /** Warm the media-player URL cache so !play radio cutover skips 3–4 IMVU GETs. */
    async function warmRoomRadioPlayer(roomId) {
        return fetchRoomRadioMediaInfo(roomId);
    }

    async function fetchRoomMediaPlaybackState(roomId) {
        const playerUrl = await fetchRoomRadioMediaPlayerUrl(roomId);
        if (!playerUrl) return { ok: false, reason: 'radio-player-not-found' };
        try {
            const json = await apiGet(playerUrl);
            const cur = json?.denormalized?.[playerUrl]?.data?.current_state;
            if (!cur || typeof cur !== 'object') return { ok: false, reason: 'state-missing' };
            return {
                ok: true,
                status: String(cur.status || ''),
                stationUrl: String(cur.station_url || ''),
            };
        } catch (error) {
            return { ok: false, reason: error.message || 'state-fetch-failed' };
        }
    }

    async function postMediaPlayerAction(roomId, playerUrl, body, etag = '') {
        const headers = await imvuNextApiHeaders(roomId);
        if (etag) headers['If-Match'] = etag;

        const postRes = await client.post(playerUrl, body, {
            headers,
            validateStatus: (status) => status >= 200 && status < 500,
            timeout: Number(process.env.IMVU_MEDIA_PLAYER_TIMEOUT_MS || 20000),
        });

        return {
            ok: postRes.status >= 200 && postRes.status < 300,
            status: postRes.status,
            data: postRes.data,
            etag:
                postRes.headers?.etag ||
                postRes.data?.http?.[playerUrl]?.headers?.etag ||
                etag ||
                '',
        };
    }

    async function postMediaPlayerActions(roomId, playerUrl, bodies) {
        const getRes = await client.get(playerUrl, {
            headers: { Accept: 'application/json; charset=utf-8' },
            validateStatus: (status) => status >= 200 && status < 500,
            timeout: Number(process.env.IMVU_MEDIA_PLAYER_TIMEOUT_MS || 20000),
        });
        if (getRes.status < 200 || getRes.status >= 300) {
            return { ok: false, status: getRes.status, data: getRes.data, reason: `player-get-${getRes.status}` };
        }

        let etag =
            getRes.headers?.etag || getRes.data?.http?.[playerUrl]?.headers?.etag || '';
        let last = { ok: false, status: 0, data: null };

        for (const body of bodies) {
            last = await postMediaPlayerAction(roomId, playerUrl, body, etag);
            if (last.etag) etag = last.etag;
            if (!last.ok) return last;
        }

        return last;
    }

    async function stopRoomRadioStream(roomId) {
        return enqueueRoomRadioOp(roomId, async () => {
            markRadioOpQuiet(roomId);
            const mediaInfo = await fetchRoomRadioMediaInfo(roomId);
            const playerUrl = mediaInfo?.url || null;
            if (!playerUrl) return { ok: false, reason: 'radio-player-not-found' };

            try {
                const identity = await resolveImqIdentity();
                if (identity.userId) {
                    await ensureChatParticipant(roomId, identity.userId);
                }

                const getRes = await client.get(playerUrl, {
                    headers: { Accept: 'application/json; charset=utf-8' },
                    validateStatus: (status) => status >= 200 && status < 500,
                    timeout: Number(process.env.IMVU_MEDIA_PLAYER_TIMEOUT_MS || 20000),
                });
                if (getRes.status < 200 || getRes.status >= 300) {
                    return { ok: false, reason: `player-get-${getRes.status}` };
                }

                let etag =
                    getRes.headers?.etag || getRes.data?.http?.[playerUrl]?.headers?.etag || '';
                const stopRes = await postMediaPlayerAction(
                    roomId,
                    playerUrl,
                    { action: 'stop_radio' },
                    etag,
                );
                if (!stopRes.ok) {
                    return { ok: false, reason: `post-${stopRes.status}` };
                }
                lastAppliedRoomRadio.delete(String(roomId || '').trim());
                markRadioOpQuiet(roomId);
                logger.log(`[IMVU-SESSION] Stopped room ${roomId} radio.`);
                return { ok: true, reason: 'stopped' };
            } catch (error) {
                logger.warn(`[IMVU-SESSION] Room radio stop failed for ${roomId}: ${error.message}`);
                return { ok: false, reason: error.message || 'stop-failed' };
            }
        });
    }

    /** IMVU rejects media_title / station_name over 100 chars (INBOUND VALIDATION-001). */
    function truncateStationName(name, max = 100) {
        const s = String(name || '').trim().replace(/\s+/g, ' ');
        if (s.length <= max) return s;
        if (max <= 1) return s.slice(0, max);
        return `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
    }

    async function setRoomRadioStreamUrl(roomId, publicUrl, options = {}) {
        const url = String(publicUrl || '').trim();
        if (!/^https:\/\//i.test(url)) return { ok: false, reason: 'invalid-url' };

        const stationUrl = canonicalRadioStationUrl(url);
        const stationName = truncateStationName(options?.stationName || '');
        const tRadio = Date.now();

        return enqueueRoomRadioOp(roomId, async () => {
            markRadioOpQuiet(roomId);
            const mediaInfo = await fetchRoomRadioMediaInfo(roomId);
            const playerUrl = mediaInfo?.url || null;
            if (!playerUrl) return { ok: false, reason: 'radio-player-not-found' };
            /** Room mods POST here; experience-nested URL returns AUTHORIZATION-002 even for mods. */
            const postPlayerUrl = playerUrl;
            const forceRestart = Boolean(options?.forceRestart);
            // Bot is already in-room during !play; skip participant POST (~0.5–1.5s).
            const skipEnsure =
                forceRestart ||
                options?.skipEnsureParticipant === true ||
                /^(1|true|yes|on)$/i.test(
                    String(process.env.IMVU_RADIO_SKIP_ENSURE_PARTICIPANT || '1').trim(),
                );

            try {
                if (!skipEnsure) {
                    const identity = await resolveImqIdentity();
                    if (identity.userId) {
                        await ensureChatParticipant(roomId, identity.userId);
                    }
                }

                // Cache-bust so IMVU treats each cutover as a new station_url even when
                // the stable /live m3u8 path is unchanged (stop→start alone does not reload HLS).
                const playSeed = Date.now();
                const stationUrlForImvu = (() => {
                    if (
                        /^(0|false|no|off)$/i.test(
                            String(process.env.MUSIC_STREAM_URL_CACHE_BUST ?? '1').trim(),
                        )
                    ) {
                        return stationUrl;
                    }
                    const sep = stationUrl.includes('?') ? '&' : '?';
                    return `${stationUrl}${sep}_play=${playSeed}`;
                })();

                const getRes = await client.get(playerUrl, {
                    headers: { Accept: 'application/json; charset=utf-8' },
                    validateStatus: (status) => status >= 200 && status < 500,
                    timeout: Number(process.env.IMVU_MEDIA_PLAYER_TIMEOUT_MS || 20000),
                });
                if (getRes.status < 200 || getRes.status >= 300) {
                    return {
                        ok: false,
                        status: getRes.status,
                        reason: `player-get-${getRes.status}`,
                    };
                }

                let etag =
                    getRes.headers?.etag || getRes.data?.http?.[playerUrl]?.headers?.etag || '';

                // Stable /live: skip stop→clear→update→start when already on this URL
                // — unless caller forces a restart (extractor HLS reuses the same m3u8 per room).
                const cur =
                    getRes.data?.denormalized?.[playerUrl]?.data?.current_state ||
                    getRes.data?.denormalized?.[playerUrl]?.data ||
                    null;
                const curUrl = canonicalRadioStationUrl(String(cur?.station_url || ''));
                const curStatus = String(cur?.status || '').toLowerCase();
                if (
                    !forceRestart &&
                    curUrl &&
                    curUrl === stationUrl &&
                    (curStatus === 'playing' || curStatus === 'paused')
                ) {
                    rememberRadioEtag(roomId, etag, stationUrl);
                    logger.log(
                        `[IMVU-SESSION] Room ${roomId} already on radio URL — skip rewrite: ${stationUrl}`,
                    );
                    return { ok: true, reason: 'url-unchanged' };
                }

                // Same-path / forceRestart cutover must flash-clear: IMVU strips ?_play=
                // from persisted station_url, so stop→update(same path) leaves clients on
                // the old HLS session until they rejoin. Empty URL forces a reload.
                const stopRes = await postMediaPlayerAction(
                    roomId,
                    postPlayerUrl,
                    { action: 'stop_radio' },
                    etag,
                );
                if (stopRes.etag) etag = stopRes.etag;
                // forceRestart defaults to a short stopped wait so clients drop the stream.
                const waitStoppedDefault = forceRestart ? '500' : '0';
                const waitStoppedMs = Math.max(
                    0,
                    parseInt(
                        String(process.env.IMVU_RADIO_WAIT_STOPPED_MS || waitStoppedDefault),
                        10,
                    ) || 0,
                );
                if (waitStoppedMs > 0) {
                    const stopped = await waitForRoomRadioStatus(roomId, 'stopped', waitStoppedMs);
                    if (!stopped) {
                        logger.log(
                            `[IMVU-SESSION] stop_radio pending for room ${roomId}; continuing radio update.`,
                        );
                    }
                }

                // Default ON for forceRestart (track change on stable/live HLS).
                // Set IMVU_RADIO_URL_FLASH_CLEAR=0 to skip.
                const flashClearDefault = forceRestart ? '1' : '0';
                const flashClear = !/^(0|false|no|off)$/i.test(
                    String(process.env.IMVU_RADIO_URL_FLASH_CLEAR ?? flashClearDefault).trim(),
                );
                if (flashClear) {
                    const clearRes = await postMediaPlayerAction(
                        roomId,
                        postPlayerUrl,
                        {
                            action: 'update_radio',
                            station_name: '',
                            station_url: '',
                        },
                        etag,
                    );
                    if (clearRes.etag) etag = clearRes.etag;
                    // forceRestart needs a longer empty gap so IMVU clients drop HLS
                    // (100ms is often too short — users still had to rejoin).
                    const flashMs = Math.max(
                        forceRestart ? 350 : 50,
                        parseInt(String(process.env.IMVU_RADIO_URL_FLASH_MS || '150'), 10) || 150,
                    );
                    await new Promise((r) => setTimeout(r, flashMs));
                }

                const updateRes = await postMediaPlayerAction(
                    roomId,
                    postPlayerUrl,
                    {
                        action: 'update_radio',
                        station_name: stationName,
                        station_url: stationUrlForImvu,
                    },
                    etag,
                );
                if (updateRes.etag) etag = updateRes.etag;
                if (!updateRes.ok) {
                    const detail = summarizeResponseData(updateRes.data);
                    logger.warn(
                        `[IMVU-SESSION] Could not update room ${roomId} radio URL: POST ${updateRes.status}${detail} · url=${stationUrlForImvu}`,
                    );
                    const errCode = String(updateRes.data?.error || '');
                    const modDenied =
                        errCode === 'MEDIA_PLAYER_NODE-004' ||
                        /must be host or moderator to configure streaming/i.test(detail);
                    if (modDenied) {
                        return {
                            ok: false,
                            reason: 'not-moderator',
                            detail: 'Bot must be room host or mod to set the radio URL.',
                        };
                    }
                    return { ok: false, reason: `post-${updateRes.status}`, detail };
                }

                let startRes = await postMediaPlayerAction(
                    roomId,
                    postPlayerUrl,
                    { action: 'start_radio' },
                    etag,
                );
                if (!startRes.ok) {
                    const detail = summarizeResponseData(startRes.data);
                    logger.warn(
                        `[IMVU-SESSION] Could not start room ${roomId} radio: POST ${startRes.status}${detail}`,
                    );
                    return { ok: false, reason: `post-${startRes.status}`, detail };
                }

                const pulseMs = Math.max(
                    0,
                    parseInt(String(process.env.IMVU_RADIO_RESTART_DELAY_MS || '0'), 10) || 0,
                );
                if (pulseMs > 0) {
                    await new Promise((r) => setTimeout(r, pulseMs));
                    if (startRes.etag) etag = startRes.etag;
                    startRes = await postMediaPlayerAction(
                        roomId,
                        postPlayerUrl,
                        { action: 'start_radio' },
                        etag,
                    );
                    if (!startRes.ok) {
                        const detail = summarizeResponseData(startRes.data);
                        logger.warn(
                            `[IMVU-SESSION] Room ${roomId} radio re-start pulse failed: POST ${startRes.status}${detail}`,
                        );
                    }
                }

                lastAppliedRoomRadio.set(String(roomId || '').trim(), {
                    url: stationUrl,
                    stationName,
                    at: Date.now(),
                });
                rememberRadioEtag(roomId, startRes.etag || etag, stationUrl);
                markRadioOpQuiet(roomId);
                logger.log(
                    `[IMVU-SESSION] Updated room ${roomId} radio URL via API (stop${flashClear ? ' → clear' : ''} → update → start, ${Date.now() - tRadio}ms, status ${startRes.status}): ${stationUrlForImvu}`,
                );
                return { ok: true, reason: 'api-restart-radio' };
            } catch (error) {
                logger.warn(`[IMVU-SESSION] Room radio URL update failed for ${roomId}: ${error.message}`);
                return { ok: false, reason: error.message || 'post-failed' };
            }
        });
    }

    /**
     * After a self-removed presence repair, push the last known Icecast URL again.
     * IMVU often drops room radio when the bot participant is briefly deleted.
     */
    async function reapplyRoomRadioAfterPresence(roomId) {
        const key = String(roomId || '').trim();
        const saved = lastAppliedRoomRadio.get(key);
        if (!saved?.url) return { ok: false, reason: 'no-saved-url' };
        const maxAge = Math.max(
            60000,
            parseInt(
                String(process.env.IMVU_RADIO_REAPPLY_MAX_AGE_MS || String(2 * 60 * 60 * 1000)),
                10,
            ) || 2 * 60 * 60 * 1000,
        );
        if (Date.now() - saved.at > maxAge) {
            lastAppliedRoomRadio.delete(key);
            return { ok: false, reason: 'stale' };
        }
        logger.log(
            `[IMVU-SESSION] Re-applying room ${key} radio after presence repair: ${saved.url}`,
        );
        return setRoomRadioStreamUrl(key, saved.url, {
            stationName: saved.stationName || '',
            reapply: true,
        });
    }

    async function apiPost(path, body = {}, options = {}) {
        const url = /^https?:\/\//i.test(String(path))
            ? String(path)
            : new URL(String(path).replace(/^\/+/, ''), `${DEFAULT_API_ORIGIN}/`).href;
        const response = await client.post(url, body, {
            ...options,
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                Origin: process.env.IMVU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN,
                Referer: `${process.env.IMVU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN}/`,
                ...(options.headers || {}),
            },
            validateStatus: (status) => status >= 200 && status < 500,
        });
        return response;
    }

    async function buildImvuApiHeaders(extra = {}) {
        const sauce = await resolveImvuSauce();
        return {
            Accept: 'application/json; charset=utf-8',
            'Content-Type': 'application/json; charset=UTF-8',
            Origin: process.env.IMVU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN,
            Referer: `${process.env.IMVU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN}/`,
            'X-IMVU-Application': process.env.IMVU_X_APPLICATION || 'next_desktop/1',
            ...(sauce ? { 'X-IMVU-Sauce': sauce } : {}),
            ...extra,
        };
    }

    async function buildImvuActivityHeaders(extra = {}) {
        const webOrigin = process.env.IMVU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN;
        const sauce = await resolveImvuSauce();
        return {
            Accept: 'application/json; charset=utf-8',
            Origin: webOrigin,
            Referer: `${webOrigin}/next/home/`,
            'X-IMVU-Application': process.env.IMVU_X_APPLICATION || 'next_desktop/1',
            ...(sauce ? { 'X-IMVU-Sauce': sauce } : {}),
            ...extra,
        };
    }

    function parseImvuApiFailure(payload) {
        if (!payload || typeof payload !== 'object') return null;
        const error = String(payload.error || '').trim();
        const message = String(payload.message || '').trim();
        if (!error && !message) return null;
        return { error, message };
    }

    async function sendFriendRequest(targetUserId, targetUsername = '') {
        // Bot policy: never send outbound friend requests — only accept inbound ones.
        void targetUserId;
        void targetUsername;
        return { ok: false, reason: 'outbound friend requests disabled' };
    }

    const watchedConversationPaths = new Set();
    const watchedDmUserIds = new Set();
    /** Users checked — no conversation exists yet; skip repeat API lookups. */
    const dmConversationAbsentUserIds = new Set();

    function extractConversationId(value) {
        const match = String(value || '').match(/conversation-\d+/i);
        return match ? match[0] : '';
    }

    function denormPathSuffix(value) {
        return String(value || '')
            .trim()
            .replace(/^https?:\/\/[^/]+/i, '')
            .replace(/^\/+/, '');
    }

    function denormGet(denorm, key) {
        if (!denorm || !key) return null;
        if (denorm[key]) return denorm[key];
        const suffix = denormPathSuffix(key);
        if (!suffix) return null;
        for (const [candidateKey, candidateValue] of Object.entries(denorm)) {
            if (denormPathSuffix(candidateKey) === suffix) return candidateValue;
        }
        return null;
    }

    function extractUserIdFromImvuRef(value) {
        const match = String(value || '').match(/(?:user-|users\/)(\d+)/i);
        return match ? match[1] : null;
    }

    function rememberConversationRef(value, botId) {
        const convId = extractConversationId(value);
        if (!convId || !botId) return;
        watchedConversationPaths.add(`user/user-${botId}/conversations/${convId}`);
    }

    function watchDirectMessageUser(userId) {
        const id = String(userId || '').trim();
        if (/^\d+$/.test(id)) {
            watchedDmUserIds.add(id);
            dmConversationAbsentUserIds.delete(id);
        }
    }

    function getWatchedDirectMessageUserIds() {
        return [...watchedDmUserIds];
    }

    async function watchRoomDmContacts(roomId) {
        const normalizedRoomId = String(roomId || '')
            .trim()
            .replace(/^room-/i, '');
        if (!normalizedRoomId) return;

        const ids = new Set();
        try {
            const ownerId = await fetchRoomOwnerId(normalizedRoomId);
            if (ownerId) ids.add(String(ownerId));
        } catch {
            /* optional */
        }
        try {
            for (const modId of await fetchRoomModeratorIds(normalizedRoomId)) {
                if (modId) ids.add(String(modId));
            }
        } catch {
            /* optional */
        }

        for (const id of ids) watchDirectMessageUser(id);
    }

    async function listAcceptedFriendUserIds() {
        const botId = await resolveBotUserId();
        if (!botId) return [];

        try {
            const headers = await buildImvuApiHeaders();
            const url = new URL(`user/user-${botId}/friends?limit=100`, `${DEFAULT_API_ORIGIN}/`).href;
            const response = await client.get(url, {
                headers: { Accept: 'application/json; charset=utf-8', ...headers },
                validateStatus: (status) => status >= 200 && status < 500,
            });
            if (response.status < 200 || response.status >= 300) return [];

            const denorm = response.data?.denormalized || {};
            const ids = new Set();
            for (const key of Object.keys(denorm)) {
                const match = key.match(/\/(?:friends\/)?user-(\d+)/i);
                if (match && match[1] !== String(botId)) ids.add(match[1]);
            }

            const listKey = Object.keys(denorm).find(
                (key) => key.includes('/friends') && !/\/friends\/user-/i.test(key)
            );
            const items = listKey ? denorm[listKey]?.data?.items : null;
            if (Array.isArray(items)) {
                for (const itemUrl of items) {
                    const userId = extractUserIdFromImvuRef(itemUrl);
                    if (userId && userId !== String(botId)) ids.add(userId);
                }
            }

            return [...ids];
        } catch (error) {
            logger.warn(`[IMVU-SESSION] listAcceptedFriendUserIds failed: ${error.message}`);
            return [];
        }
    }

    async function refreshDirectMessageWatchList(roomIds = []) {
        const normalizedRooms = [...new Set(
            (Array.isArray(roomIds) ? roomIds : [])
                .map((roomId) =>
                    String(roomId || '')
                        .trim()
                        .replace(/^room-/i, '')
                )
                .filter(Boolean)
        )];

        for (const roomId of normalizedRooms) {
            await watchRoomDmContacts(roomId).catch(() => {});
        }

        return watchedDmUserIds.size;
    }

    function conversationMessageFromData(data, botId, detailDenorm, convKey) {
        const lastMessage = data?.last_message;
        const text = Array.isArray(lastMessage?.payloads)
            ? lastMessage.payloads
                  .map((entry) => (entry?.type === 'text' ? String(entry.content || '') : ''))
                  .filter(Boolean)
                  .join(' ')
                  .trim()
            : '';
        const sentBy = String(lastMessage?.sent_by || lastMessage?.sender || '');
        if (!text || sentBy.includes(`/user-${botId}`)) return null;

        const senderMatch =
            sentBy.match(/user-(\d+)/i) ||
            String(lastMessage?.sender || '').match(/users\/(\d+)/i);
        const participants = Array.isArray(data?.participants) ? data.participants : [];
        const other = participants.find((entry) => {
            const user = String(entry?.user || '');
            return user.includes('/user/') && !user.includes(`/user-${botId}`);
        });

        let senderUsername = String(other?.name || other?.username || '').trim();
        if (!senderUsername && other?.user) {
            const userKey = String(other.user);
            const userData = detailDenorm[userKey]?.data;
            if (userData && typeof userData === 'object') {
                senderUsername = String(userData.username || userData.display_name || '').trim();
            }
        }

        return {
            messageId: String(lastMessage?.message_id || `${convKey}:${text}`),
            text,
            senderUserId: senderMatch ? senderMatch[1] : null,
            senderUsername,
        };
    }

    function parseInboundMessageRecord(messageData, botId, detailDenorm, convKey, participants = []) {
        const text = Array.isArray(messageData?.payloads)
            ? messageData.payloads
                  .map((entry) => (entry?.type === 'text' ? String(entry.content || '') : ''))
                  .filter(Boolean)
                  .join(' ')
                  .trim()
            : '';
        const sentBy = String(messageData?.sent_by || messageData?.sender || '');
        if (!text || sentBy.includes(`/user-${botId}`)) return null;

        const senderMatch = sentBy.match(/user-(\d+)/i) || String(messageData?.sender || '').match(/users\/(\d+)/i);
        const roster = Array.isArray(participants) ? participants : [];
        const other = roster.find((entry) => {
            const user = String(entry?.user || '');
            return user.includes('/user/') && !user.includes(`/user-${botId}`);
        });

        let senderUsername = String(other?.name || other?.username || '').trim();
        const senderUserId = senderMatch ? senderMatch[1] : null;
        if (!senderUsername && senderUserId) {
            for (const [key, value] of Object.entries(detailDenorm || {})) {
                if (!key.includes(`/users/${senderUserId}`) && !key.includes(`/user-${senderUserId}`)) continue;
                const userData = value?.data;
                if (userData && typeof userData === 'object') {
                    senderUsername = String(userData.username || userData.display_name || '').trim();
                    if (senderUsername) break;
                }
            }
        }

        return {
            messageId: String(messageData?.message_id || `${convKey}:${text}`),
            text,
            senderUserId,
            senderUsername,
        };
    }

    async function directMessageHeaders(extra = {}) {
        return buildImvuApiHeaders({
            Referer: `${process.env.IMVU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN}/next/messages/`,
            ...extra,
        });
    }

    async function resolveConversationIdBetweenUsers(botId, targetUserId, headers) {
        const targetId = String(targetUserId || '').trim();
        if (!/^\d+$/.test(targetId)) return null;

        const participantPairs = [
            [botId, targetId],
            [targetId, botId],
        ];

        try {
            const msgHeaders = headers || (await directMessageHeaders());
            for (const [leftId, rightId] of participantPairs) {
                const participants = [
                    `${DEFAULT_API_ORIGIN}/user/user-${leftId}`,
                    `${DEFAULT_API_ORIGIN}/user/user-${rightId}`,
                ].join(',');
                const listUrl = new URL(
                    `conversation?participants=${encodeURIComponent(participants)}`,
                    `${DEFAULT_API_ORIGIN}/`
                ).href;

                const response = await client.get(listUrl, {
                    headers: { Accept: 'application/json; charset=utf-8', ...msgHeaders },
                    validateStatus: (status) => status >= 200 && status < 500,
                });
                if (response.status < 200 || response.status >= 300) continue;

                const denorm = response.data?.denormalized || {};
                for (const value of Object.values(denorm)) {
                    const items = value?.data?.items;
                    if (!Array.isArray(items) || !items.length) continue;
                    const convId = extractConversationId(String(items[0]));
                    if (convId) {
                        rememberConversationRef(convId, botId);
                        return convId;
                    }
                }
            }
        } catch (error) {
            logger.warn(`[IMVU-SESSION] resolveConversationIdBetweenUsers failed: ${error.message}`);
        }
        return null;
    }

    async function fetchConversationInboundMessages(botId, convId, headers, limit = 10) {
        const normalizedConvId = extractConversationId(convId) || String(convId || '').trim();
        if (!normalizedConvId.includes('conversation-')) return [];

        const msgHeaders = headers || (await directMessageHeaders());
        const listUrl = new URL(`conversation/${normalizedConvId}/messages`, `${DEFAULT_API_ORIGIN}/`).href;

        try {
            const response = await client.get(listUrl, {
                headers: { Accept: 'application/json; charset=utf-8', ...msgHeaders },
                validateStatus: (status) => status >= 200 && status < 500,
            });
            if (response.status < 200 || response.status >= 300) return [];

            const denorm = response.data?.denormalized || {};
            let items = [];
            for (const [key, value] of Object.entries(denorm)) {
                if (key.endsWith('/messages') && Array.isArray(value?.data?.items)) {
                    items = value.data.items;
                    break;
                }
            }

            const detail = await fetchConversationDetail(botId, normalizedConvId, msgHeaders);
            const participants = detail?.data?.participants || [];
            const convKey = detail?.convKey || normalizedConvId;
            const results = [];
            const seen = new Set();

            for (const itemUrl of items.slice(0, Math.max(1, limit))) {
                const wrapperKey = String(itemUrl);
                const wrapper = denormGet(denorm, wrapperKey);
                const ref = String(wrapper?.relations?.ref || wrapperKey);
                const msgData = denormGet(denorm, ref)?.data;
                if (!msgData) continue;

                const parsed = parseInboundMessageRecord(msgData, botId, denorm, convKey, participants);
                if (!parsed || seen.has(parsed.messageId)) continue;
                seen.add(parsed.messageId);
                results.push(parsed);
            }

            return results;
        } catch (error) {
            logger.warn(`[IMVU-SESSION] fetchConversationInboundMessages failed: ${error.message}`);
            return [];
        }
    }

    function mergeConversationRefsFromDenorm(denorm, botId, refs) {
        for (const [key, value] of Object.entries(denorm || {})) {
            if (!key.includes('/conversation-')) continue;
            rememberConversationRef(key, botId);
            if (value?.data?.last_message) {
                refs.set(key, { inline: true, data: value.data, detailDenorm: denorm, convKey: key });
                continue;
            }
            refs.set(key, { inline: false });
        }
    }

    async function fetchConversationDetail(botId, convId, headers) {
        const conv = String(convId || '').trim();
        if (!conv.includes('conversation-')) return null;

        const msgHeaders = await buildImvuApiHeaders({
            Referer: `${process.env.IMVU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN}/next/messages/`,
            ...(headers || {}),
        });
        const normalizedConvId = extractConversationId(conv) || conv.replace(/^\/+/, '');
        const paths = [
            `conversation/${normalizedConvId}`,
            `user/user-${botId}/conversations/${normalizedConvId}?limit=0`,
        ];

        for (const path of paths) {
            try {
                const detailUrl = new URL(path.replace(/^\/+/, ''), `${DEFAULT_API_ORIGIN}/`).href;
                const detailResponse = await client.get(detailUrl, {
                    headers: { Accept: 'application/json; charset=utf-8', ...msgHeaders },
                    validateStatus: (status) => status >= 200 && status < 500,
                });
                if (detailResponse.status < 200 || detailResponse.status >= 300) continue;

                const detailDenorm = detailResponse.data?.denormalized || {};
                const convKey = Object.keys(detailDenorm).find((key) => key.includes('/conversation-'));
                const data = convKey ? detailDenorm[convKey]?.data : null;
                if (!data) continue;
                rememberConversationRef(convKey || conv, botId);
                return { data, detailDenorm, convKey: convKey || conv };
            } catch {
                /* try next path */
            }
        }
        return null;
    }

    async function openDirectConversationWithUser(botId, targetUserId, headers) {
        const targetId = String(targetUserId || '').trim();
        if (!/^\d+$/.test(targetId) || targetId === String(botId)) return null;

        const msgHeaders = headers || (await directMessageHeaders());

        try {
            const convId = await resolveConversationIdBetweenUsers(botId, targetId, msgHeaders);
            if (!convId) {
                dmConversationAbsentUserIds.add(targetId);
                return null;
            }

            const detail = await fetchConversationDetail(botId, convId, msgHeaders);
            if (!detail) return null;

            const inboundMessages = await fetchConversationInboundMessages(
                botId,
                convId,
                msgHeaders,
                30
            );
            return { ...detail, convId, inboundMessages };
        } catch (error) {
            logger.warn(`[IMVU-SESSION] Open DM with user-${targetId} failed: ${error.message}`);
        }
        return null;
    }

    async function listDirectMessagesFromUserIds(botId, headers, userIds, limit) {
        const messages = [];
        const seenMessageIds = new Set();
        const ids = [...new Set(
            (Array.isArray(userIds) ? userIds : [])
                .map((id) => String(id || '').trim())
                .filter((id) => /^\d+$/.test(id) && id !== String(botId))
        )];

        for (const userId of ids) {
            if (messages.length >= limit) break;
            // Always retry hinted senders — a prior miss must not permanently skip them.
            dmConversationAbsentUserIds.delete(String(userId));
            watchDirectMessageUser(userId);

            const opened = await openDirectConversationWithUser(botId, userId, headers);
            if (!opened) continue;

            // Prefer conversation last_message — that is the newest text (skip buried history).
            const parsedLast = conversationMessageFromData(
                opened.data,
                botId,
                opened.detailDenorm,
                opened.convKey
            );
            if (parsedLast && !seenMessageIds.has(parsedLast.messageId)) {
                seenMessageIds.add(parsedLast.messageId);
                if (parsedLast.senderUserId) watchDirectMessageUser(parsedLast.senderUserId);
                messages.push(parsedLast);
                continue;
            }

            const inbound = Array.isArray(opened.inboundMessages) ? opened.inboundMessages : [];
            if (inbound.length) {
                // API order varies; take the last entry as newest fallback.
                const parsed = inbound[inbound.length - 1];
                if (!parsed || seenMessageIds.has(parsed.messageId)) continue;
                seenMessageIds.add(parsed.messageId);
                if (parsed.senderUserId) watchDirectMessageUser(parsed.senderUserId);
                messages.push(parsed);
                continue;
            }
        }

        return messages;
    }

    async function listDirectMessagesFromWatchedUsers(botId, headers, limit, preferUserIds = []) {
        const preferred = [...new Set(
            (Array.isArray(preferUserIds) ? preferUserIds : [])
                .map((id) => String(id || '').trim())
                .filter((id) => /^\d+$/.test(id))
        )];
        // Prefer recent WS senders first — otherwise room owners/mods fill the limit
        // and we never open the conversation that actually sent !join.
        const ordered = [
            ...preferred,
            ...[...watchedDmUserIds].filter((id) => !preferred.includes(String(id))),
        ];
        return listDirectMessagesFromUserIds(botId, headers, ordered, limit);
    }

    /** Fast path: fetch DMs only for specific user ids (WS messageReceived senders). */
    async function listRecentDirectMessagesFromUsers(userIds, limit = 40) {
        const botId = await resolveBotUserId();
        if (!botId) return [];
        try {
            const headers = await directMessageHeaders();
            return listDirectMessagesFromUserIds(
                botId,
                headers,
                userIds,
                Math.max(1, Math.min(limit, 50))
            );
        } catch (error) {
            logger.warn(
                `[IMVU-SESSION] Could not list DMs for users: ${error.message}`
            );
            return [];
        }
    }

    async function fetchConversationListRefs(botId, headers, limit) {
        const refs = new Map();
        const pageSize = Math.max(1, Math.min(limit, 50));
        const queryVariants = [`limit=${pageSize}`, `limit=${pageSize}&offset=0`];

        for (const query of queryVariants) {
            const listUrl = new URL(`user/user-${botId}/conversations?${query}`, `${DEFAULT_API_ORIGIN}/`).href;
            const listResponse = await client.get(listUrl, {
                headers: { Accept: 'application/json; charset=utf-8', ...headers },
                validateStatus: (status) => status >= 200 && status < 500,
            });
            if (listResponse.status < 200 || listResponse.status >= 300) continue;

            const denorm = listResponse.data?.denormalized || {};
            mergeConversationRefsFromDenorm(denorm, botId, refs);

            const listKey = Object.keys(denorm).find(
                (key) => key.includes('/conversations') && !key.includes('/conversation-')
            );
            const items = listKey ? denorm[listKey]?.data?.items : null;
            if (Array.isArray(items)) {
                for (const itemUrl of items) {
                    rememberConversationRef(itemUrl, botId);
                    refs.set(String(itemUrl), { inline: false });
                }
            }
            if (refs.size > 0) break;
        }

        for (const path of watchedConversationPaths) {
            refs.set(`${DEFAULT_API_ORIGIN}/${path.replace(/^\/+/, '')}`, { inline: false });
        }

        return refs;
    }

    async function sendDirectMessage(targetUserId, message, targetUsername = '') {
        const botId = await resolveBotUserId();
        const targetId = String(targetUserId || '').trim();
        const text = String(message || '').trim();
        if (!botId || !/^\d+$/.test(targetId) || !text) {
            return { ok: false, reason: 'invalid payload' };
        }

        watchDirectMessageUser(targetId);

        try {
            const msgHeaders = await directMessageHeaders();
            let convId = await resolveConversationIdBetweenUsers(botId, targetId, msgHeaders);

            if (!convId) {
                const refererUsername = String(targetUsername || '').trim();
                const createHeaders = await buildImvuApiHeaders({
                    Referer: refererUsername
                        ? `${process.env.IMVU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN}/next/av/${encodeURIComponent(refererUsername)}/`
                        : `${process.env.IMVU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN}/next/messages/`,
                });
                const createResponse = await apiPost(
                    `/user/user-${botId}/conversations?limit=0`,
                    {
                        participants: [`${DEFAULT_API_ORIGIN}/user/user-${targetId}`],
                        payloads: [{ type: 'text', content: text }],
                    },
                    { headers: createHeaders }
                );
                if (createResponse.status >= 200 && createResponse.status < 300) {
                    rememberConversationRef(createResponse.data?.id, botId);
                    logger.log(`[IMVU-SESSION] Sent direct message to user-${targetId}.`);
                    return { ok: true };
                }
                const failure = parseImvuApiFailure(createResponse.data);
                if (failure?.error === 'FRIEND-001') {
                    return {
                        ok: false,
                        reason: failure.message || 'friend-required',
                        friendRequired: true,
                        error: failure.error,
                    };
                }
                if (createResponse.status === 429 || failure?.error === 'RATE-001') {
                    return {
                        ok: false,
                        reason: `status ${createResponse.status}${summarizeResponseData(createResponse.data)}`,
                        rateLimited: true,
                        error: failure?.error || 'RATE-001',
                    };
                }
                return {
                    ok: false,
                    reason: `status ${createResponse.status}${summarizeResponseData(createResponse.data)}`,
                };
            }

            const response = await apiPost(
                `/conversation/${convId}/messages`,
                { payloads: [{ type: 'text', content: text }] },
                { headers: msgHeaders }
            );
            if (response.status >= 200 && response.status < 300) {
                rememberConversationRef(convId, botId);
                logger.log(`[IMVU-SESSION] Sent direct message to user-${targetId}.`);
                return { ok: true };
            }

            const failure = parseImvuApiFailure(response.data);
            if (failure?.error === 'FRIEND-001') {
                return {
                    ok: false,
                    reason: failure.message || 'friend-required',
                    friendRequired: true,
                    error: failure.error,
                };
            }
            if (response.status === 429 || failure?.error === 'RATE-001') {
                return {
                    ok: false,
                    reason: `status ${response.status}${summarizeResponseData(response.data)}`,
                    rateLimited: true,
                    error: failure?.error || 'RATE-001',
                };
            }

            return {
                ok: false,
                reason: `status ${response.status}${summarizeResponseData(response.data)}`,
            };
        } catch (error) {
            return { ok: false, reason: error.message || 'direct-message-failed' };
        }
    }

    async function listInboundFriendRequests() {
        const botId = await resolveBotUserId();
        if (!botId) return [];

        try {
            const headers = await buildImvuApiHeaders();
            const url = new URL(
                `user/user-${botId}/inbound_friend_requests?limit=25`,
                `${DEFAULT_API_ORIGIN}/`
            ).href;
            const response = await client.get(url, {
                headers: { Accept: 'application/json; charset=utf-8', ...headers },
                validateStatus: (status) => status >= 200 && status < 500,
            });
            if (response.status < 200 || response.status >= 300) return [];

            const denorm = response.data?.denormalized || {};
            const ids = [];
            const seen = new Set();

            const pushId = (raw) => {
                const id = String(raw || '').trim();
                if (!/^\d+$/.test(id) || seen.has(id)) return;
                seen.add(id);
                ids.push(id);
            };

            // Prefer the collection's items list (pending requests only).
            for (const [key, node] of Object.entries(denorm)) {
                if (!/\/inbound_friend_requests(?:\?|$)/i.test(key)) continue;
                if (/\/inbound_friend_requests\/user-\d+/i.test(key)) continue;
                const items = node?.data?.items;
                if (!Array.isArray(items)) continue;
                for (const item of items) {
                    const match = String(item || '').match(/\/inbound_friend_requests\/user-(\d+)/i);
                    if (match) pushId(match[1]);
                }
            }

            // Fallback: edge keys that still look pending.
            if (!ids.length) {
                for (const [key, node] of Object.entries(denorm)) {
                    const match = key.match(/\/inbound_friend_requests\/user-(\d+)/i);
                    if (!match) continue;
                    const status = String(node?.data?.status || '').toLowerCase();
                    if (status && status !== 'pending' && status !== 'open' && status !== 'incoming') {
                        continue;
                    }
                    pushId(match[1]);
                }
            }

            return ids;
        } catch {
            return [];
        }
    }

    async function acceptFriendRequest(fromUserId) {
        const botId = await resolveBotUserId();
        const fromId = String(fromUserId || '').trim();
        if (!botId || !/^\d+$/.test(fromId)) {
            return { ok: false, reason: 'invalid ids' };
        }

        try {
            const headers = await buildImvuApiHeaders({
                Referer: `${process.env.IMVU_WEB_ORIGIN || DEFAULT_WEB_ORIGIN}/next/friends/`,
            });
            const path = `/user/user-${botId}/inbound_friend_requests/user-${fromId}`;
            // Official client: edge.save({ status: "accept" }) / { status: "reject" }.
            // Wrong enums (e.g. "accepted") → INBOUND VALIDATION-001.
            // Empty {} → INBOUND_FRIENDS_REQUEST-001 "Invalid status update".
            const response = await apiPost(path, { status: 'accept' }, { headers });
            if (response.status >= 200 && response.status < 300) {
                logger.log(`[IMVU-SESSION] Accepted friend request from user-${fromId}.`);
                return { ok: true };
            }
            const failure = parseImvuApiFailure(response.data);
            return {
                ok: false,
                reason: `status ${response.status}${summarizeResponseData(response.data)}`,
                error: failure?.error || '',
            };
        } catch (error) {
            return { ok: false, reason: error.message || 'accept-friend-failed' };
        }
    }

    async function listRecentDirectMessages(limit = 20, options = {}) {
        const botId = await resolveBotUserId();
        if (!botId) return [];

        try {
            const headers = await directMessageHeaders();
            const maxMessages = Math.max(1, Math.min(limit, 50));
            const preferUserIds = Array.isArray(options.preferUserIds)
                ? options.preferUserIds
                : [];
            const messages = [];
            const seenMessageIds = new Set();

            const pushParsed = (parsed) => {
                if (!parsed || seenMessageIds.has(parsed.messageId)) return false;
                seenMessageIds.add(parsed.messageId);
                if (parsed.senderUserId) watchDirectMessageUser(parsed.senderUserId);
                messages.push(parsed);
                return true;
            };

            const hasJoinCommand = () =>
                messages.some((entry) => /^!join\b/i.test(String(entry?.text || '')));

            if (preferUserIds.length > 0) {
                const preferredMessages = await listDirectMessagesFromUserIds(
                    botId,
                    headers,
                    preferUserIds,
                    maxMessages
                );
                for (const parsed of preferredMessages) pushParsed(parsed);
                if (hasJoinCommand()) return messages;
            }

            if (watchedDmUserIds.size > 0) {
                const watchedMessages = await listDirectMessagesFromWatchedUsers(
                    botId,
                    headers,
                    maxMessages,
                    preferUserIds
                );
                for (const parsed of watchedMessages) {
                    pushParsed(parsed);
                }
                // Do not return early — conversation inbox may still hold the !join
                // when watched owners/mods filled the buffer with unrelated DMs.
            }

            const conversationRefs = await fetchConversationListRefs(botId, headers, maxMessages);
            for (const [itemUrl, meta] of conversationRefs) {
                if (messages.length >= maxMessages && hasJoinCommand()) break;

                const convId = extractConversationId(itemUrl || meta.convKey || '');
                if (convId) {
                    const inbound = await fetchConversationInboundMessages(
                        botId,
                        convId,
                        headers,
                        Math.min(20, maxMessages)
                    );
                    for (const parsed of inbound) {
                        pushParsed(parsed);
                    }
                }

                if (meta.inline) {
                    pushParsed(
                        conversationMessageFromData(meta.data, botId, meta.detailDenorm, meta.convKey)
                    );
                }
            }

            return messages;
        } catch (error) {
            logger.warn(`[IMVU-SESSION] Could not list direct messages: ${error.message}`);
            return [];
        }
    }

    function parseChatInviteActivities(denorm) {
        const invites = [];
        const seenActivityKeys = new Set();

        const listKey = Object.keys(denorm).find(
            (key) => /\/activity(?:\?|$)/.test(key) && !/\/activity\/activity-/.test(key)
        );
        const itemUrls = listKey ? denorm[listKey]?.data?.items : null;
        const activityKeys = Array.isArray(itemUrls)
            ? itemUrls.map(String)
            : Object.keys(denorm).filter((key) => key.includes('/activity/activity-'));

        for (const itemKey of activityKeys) {
            const wrapper = denorm[itemKey];
            const ref = String(wrapper?.relations?.ref || itemKey);
            const activityEntry = denorm[ref] || wrapper;
            const data = activityEntry?.data;
            if (!data?.activity_type || seenActivityKeys.has(ref)) continue;

            const activityType = String(data.activity_type);
            if (!activityType.includes('chat_invite')) continue;

            seenActivityKeys.add(ref);
            const relations = activityEntry?.relations || wrapper?.relations || {};
            const actor = Array.isArray(data.actor) ? data.actor[0] : null;
            const activityIdMatch = ref.match(/activity-\d+-(\d+)/i);
            invites.push({
                activityKey: ref,
                activityId: activityIdMatch ? Number(activityIdMatch[1]) : 0,
                activityType,
                timestamp: String(data.timestamp || ''),
                actorUserId: actor?.cid != null ? String(actor.cid) : null,
                actorUsername: String(actor?.avatarname || actor?.display_name || '').trim(),
                roomRef: String(relations.activity_reference_node || ''),
                inviteEdge: String(relations.activity_reference_edge || ''),
            });
        }
        return invites;
    }

    function sortChatInvitesNewestFirst(invites) {
        return [...invites].sort((a, b) => {
            const ta = Date.parse(a.timestamp || '') || 0;
            const tb = Date.parse(b.timestamp || '') || 0;
            if (tb !== ta) return tb - ta;
            return (b.activityId || 0) - (a.activityId || 0);
        });
    }

    async function listUnreadChatInvites() {
        const botId = await resolveBotUserId();
        if (!botId) return [];

        try {
            const headers = await buildImvuActivityHeaders();
            const include =
                'feed_like,feed_comment,chat_invite_v2,shop_together_invite,experience_invite_v2,friend_accept,friend_request,timelines_follow,moderator_add,moderator_remove,payme_received,payme_requested,product_gift_received,credit_gift_received,vcoin_gift_received,first_time_purchase_bonus_predits_received,quest_event_completed,tip_received';
            // chat_invite (v1) appears on plain unread=1; chat_invite_v2 needs the include list (per IMVU client HAR).
            const queryUrls = [
                `user/user-${botId}/activity?unread=1`,
                `user/user-${botId}/activity?unread=1&include=${encodeURIComponent(include)}`,
            ];

            const invites = [];
            const seen = new Set();
            for (const path of queryUrls) {
                const listUrl = new URL(path, `${DEFAULT_API_ORIGIN}/`).href;
                const response = await client.get(listUrl, {
                    headers,
                    validateStatus: (status) => status >= 200 && status < 500,
                });
                if (response.status < 200 || response.status >= 300) continue;

                for (const invite of parseChatInviteActivities(response.data?.denormalized || {})) {
                    if (seen.has(invite.activityKey)) continue;
                    seen.add(invite.activityKey);
                    invites.push(invite);
                }
            }
            return sortChatInvitesNewestFirst(invites);
        } catch (error) {
            logger.warn(`[IMVU-SESSION] Could not list chat invites: ${error.message}`);
            return [];
        }
    }

    async function markChatInviteRead(activityKey) {
        const ref = String(activityKey || '').trim();
        if (!ref) return { ok: false, reason: 'missing activity key' };

        const botId = await resolveBotUserId();
        if (!botId) return { ok: false, reason: 'missing bot id' };

        const activityIdMatch = ref.match(/activity-\d+-(\d+)/i);
        if (!activityIdMatch) return { ok: false, reason: 'invalid activity key' };

        try {
            const headers = await buildImvuActivityHeaders();
            const path = `user/user-${botId}/activity/activity-${botId}-${activityIdMatch[1]}`;
            const response = await client.request({
                method: 'put',
                url: new URL(path, `${DEFAULT_API_ORIGIN}/`).href,
                data: { has_read: true },
                headers: {
                    ...headers,
                    'Content-Type': 'application/json; charset=UTF-8',
                },
                validateStatus: (status) => status >= 200 && status < 500,
            });
            if (response.status >= 200 && response.status < 300) {
                return { ok: true };
            }
            return { ok: false, reason: `status ${response.status}${summarizeResponseData(response.data)}` };
        } catch (error) {
            return { ok: false, reason: error.message || 'mark-read-failed' };
        }
    }

    async function acceptChatInvite(_inviteEdgeUrl) {
        // IMVU room join is done via POST /chat/chat-{room}/participants — there is no separate
        // accept-invite call in the Next client (POST to the invite edge returns 403).
        return { ok: true, skipped: true };
    }

    async function resolveRoomIdFromChatRef(chatRef) {
        const ref = String(chatRef || '').trim();
        if (!ref) return null;

        const roomMatch = ref.match(/\/room\/room-([\d-]+)/i);
        if (roomMatch) return roomMatch[1];

        const slugMatch = ref.match(/\/chat\/chat-([\d-]+)/i);
        if (!slugMatch) return null;
        const chatSlug = slugMatch[1];
        if (chatSlug.includes('-')) return chatSlug;

        try {
            const headers = await buildImvuApiHeaders();
            const json = await apiGet(`/chat/chat-${chatSlug}`, {
                headers,
                timeout: Number(process.env.IMVU_INVITE_CHAT_LOOKUP_MS || 10000),
            });
            const denorm = json?.denormalized || {};
            for (const [key, value] of Object.entries(denorm)) {
                const nestedRoom = key.match(/\/room\/room-([\d-]+)/i);
                if (nestedRoom) return nestedRoom[1];
                const roomRel = value?.relations?.room;
                if (roomRel) {
                    const relMatch = String(roomRel).match(/room-([\d-]+)/i);
                    if (relMatch) return relMatch[1];
                }
                const data = value?.data;
                if (data && typeof data === 'object') {
                    for (const field of ['room_id', 'room_slug', 'room_name']) {
                        const raw = String(data[field] || '');
                        const match = raw.match(/([\d]+-[\d]+)/);
                        if (match) return match[1];
                    }
                }
            }
        } catch (error) {
            logger.warn(`[IMVU-SESSION] resolveRoomIdFromChatRef(${chatSlug}) failed: ${error.message}`);
        }
        return null;
    }

    return {
        jar,
        client,
        ensureLoggedIn,
        cookieHeader,
        cookieValue,
        resolveImqIdentity,
        apiGet,
        fetchRoomDetails,
        fetchRoomOwnerId,
        fetchRoomModeratorIds,
        fetchRoomModerators,
        resolveBotUserId,
        fetchChatParticipant,
        updateChatParticipantSeat,
        fetchUserProfile,
        fetchFullUserProfile,
        resolveUserIdFromUsername,
        apiGetWearableNames,
        apiGetWearableScan,
        fetchUserName,
        fetchLegacyChatQueue,
        probeRoomJoinAccess,
        fetchLiveRoomContext,
        ensureAudienceJoin,
        leaveAudienceJoin,
        inviteUserToRoom,
        ensureChatParticipant,
        removeChatParticipant,
        fetchRoomMediaPlaybackState,
        fetchRoomMediaPlayerUpdateQueue,
        warmRoomRadioPlayer,
        setRoomRadioStreamUrl,
        stopRoomRadioStream,
        markRadioOpQuiet,
        isRadioOpQuiet,
        reapplyRoomRadioAfterPresence,
        sendFriendRequest,
        sendDirectMessage,
        listInboundFriendRequests,
        acceptFriendRequest,
        listRecentDirectMessages,
        listRecentDirectMessagesFromUsers,
        watchDirectMessageUser,
        getWatchedDirectMessageUserIds,
        watchRoomDmContacts,
        refreshDirectMessageWatchList,
        listAcceptedFriendUserIds,
        listUnreadChatInvites,
        acceptChatInvite,
        markChatInviteRead,
        resolveRoomIdFromChatRef,
    };
}
