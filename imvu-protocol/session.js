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

function extractParticipantData(payload, roomId, userId) {
    const denormalized = payload?.denormalized;
    if (!denormalized || typeof denormalized !== 'object') return null;

    const participantUrl = `${DEFAULT_API_ORIGIN}/chat/chat-${roomId}/participants/user-${userId}`;
    const direct = denormalized[participantUrl]?.data;
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
        try {
            const json = await apiGet(`/user?username=${encodeURIComponent(username)}`);
            const userId = findNumericUserId(json) || extractNumericUserIdFromText(JSON.stringify(json));
            if (userId) {
                logger.log(`[IMVU-SESSION] Resolved IMVU user id from user lookup API.`);
            }
            return userId;
        } catch (error) {
            logger.warn(`[IMVU-SESSION] Could not resolve API user id: ${error.message}`);
            return null;
        }
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

    async function apiGetWearableNames(userId) {
        const id = String(userId || '').trim();
        if (!/^\d+$/.test(id)) return [];
        const names = new Set();
        try {
            collectWearableNameStrings(await apiGet(`/user/user-${id}`), names);
        } catch {
            /* optional */
        }
        for (const path of [`/inventory/outfit-${id}-1`, `/inventory/outfit-${id}-2`]) {
            try {
                collectWearableNameStrings(await apiGet(path), names);
            } catch {
                /* optional */
            }
        }
        return [...names].filter(Boolean);
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

    async function fetchChatParticipant(roomId, userId, sauce = '') {
        const normalizedRoomId = String(roomId || '').trim().replace(/^room-/i, '');
        const normalizedUserId = String(userId || '').trim();
        if (!/^\d+-\d+$/.test(normalizedRoomId) || !/^\d+$/.test(normalizedUserId)) return null;

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
                    ...(sauce ? { 'X-IMVU-Sauce': sauce } : {}),
                },
                validateStatus: (status) => status >= 200 && status < 500,
            }
        );
        if (response.status < 200 || response.status >= 300) return null;
        return extractParticipantData(response.data, normalizedRoomId, normalizedUserId);
    }

    async function ensureChatParticipant(roomId, userId, options = {}) {
        const normalizedRoomId = String(roomId || '').trim().replace(/^room-/i, '');
        const normalizedUserId = String(userId || '').trim();
        if (!/^\d+-\d+$/.test(normalizedRoomId) || !/^\d+$/.test(normalizedUserId)) return false;

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
        let lastError = '';
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
                lastError = `${candidate.method.toUpperCase()} ${candidate.path} ${response.status}${summarizeResponseData(response.data)}`;
            } catch (error) {
                lastError = `${candidate.method.toUpperCase()} ${candidate.path} ${error.message}`;
            }
        }

        logger.warn(
            `[IMVU-SESSION] Could not ensure chat participant user-${normalizedUserId} in chat-${normalizedRoomId}: ${lastError || 'no method attempted'}`
        );
        return false;
    }

    async function removeChatParticipant(roomId, userId) {
        const normalizedRoomId = String(roomId || '').trim().replace(/^room-/i, '');
        const normalizedUserId = String(userId || '').trim();
        if (!/^\d+-\d+$/.test(normalizedRoomId) || !/^\d+$/.test(normalizedUserId)) {
            return { ok: false, status: 'invalid', attempts: [] };
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
    const radioUpdateInflight = new Map();

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
            parsed.search = '';
            parsed.hash = '';
            return parsed.toString();
        } catch {
            return raw.split('?')[0].split('#')[0];
        }
    }

    async function waitForRoomRadioStatus(roomId, wantStatus, timeoutMs = 3500) {
        const want = String(wantStatus || '').trim().toLowerCase();
        const deadline = Date.now() + Math.max(500, timeoutMs);
        while (Date.now() < deadline) {
            const st = await fetchRoomMediaPlaybackState(roomId);
            if (st.ok && String(st.status || '').trim().toLowerCase() === want) return true;
            await new Promise((r) => setTimeout(r, 180));
        }
        return false;
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

    async function setRoomRadioStreamUrl(roomId, publicUrl, options = {}) {
        const url = String(publicUrl || '').trim();
        if (!/^https:\/\//i.test(url)) return { ok: false, reason: 'invalid-url' };

        const stationUrl = canonicalRadioStationUrl(url);
        const stationName = String(options?.stationName || '').trim();

        const normalizedRoomId = String(roomId || '').trim();
        const inflight = radioUpdateInflight.get(normalizedRoomId);
        if (inflight) return inflight;

        const work = (async () => {
            const mediaInfo = await fetchRoomRadioMediaInfo(roomId);
            const playerUrl = mediaInfo?.url || null;
            if (!playerUrl) return { ok: false, reason: 'radio-player-not-found' };
            /** Room mods POST here; experience-nested URL returns AUTHORIZATION-002 even for mods. */
            const postPlayerUrl = playerUrl;

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
                    return {
                        ok: false,
                        status: getRes.status,
                        reason: `player-get-${getRes.status}`,
                    };
                }

                let etag =
                    getRes.headers?.etag || getRes.data?.http?.[playerUrl]?.headers?.etag || '';

                const stopRes = await postMediaPlayerAction(
                    roomId,
                    postPlayerUrl,
                    { action: 'stop_radio' },
                    etag,
                );
                if (stopRes.etag) etag = stopRes.etag;
                const waitStoppedMs = Math.max(
                    0,
                    parseInt(String(process.env.IMVU_RADIO_WAIT_STOPPED_MS || '1200'), 10) || 1200,
                );
                if (waitStoppedMs > 0) {
                    const stopped = await waitForRoomRadioStatus(roomId, 'stopped', waitStoppedMs);
                    if (!stopped) {
                        logger.log(
                            `[IMVU-SESSION] stop_radio pending for room ${roomId}; continuing radio update.`,
                        );
                    }
                }

                const flashClear = !/^(0|false|no|off)$/i.test(
                    String(process.env.IMVU_RADIO_URL_FLASH_CLEAR ?? '1').trim(),
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
                    await new Promise((r) =>
                        setTimeout(
                            r,
                            Math.max(
                                0,
                                parseInt(String(process.env.IMVU_RADIO_URL_FLASH_MS || '300'), 10) ||
                                    300,
                            ),
                        ),
                    );
                }

                const updateRes = await postMediaPlayerAction(
                    roomId,
                    postPlayerUrl,
                    {
                        action: 'update_radio',
                        station_name: stationName,
                        station_url: stationUrl,
                    },
                    etag,
                );
                if (updateRes.etag) etag = updateRes.etag;
                if (!updateRes.ok) {
                    const detail = summarizeResponseData(updateRes.data);
                    logger.warn(
                        `[IMVU-SESSION] Could not update room ${roomId} radio URL: POST ${updateRes.status}${detail}`,
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
                    parseInt(String(process.env.IMVU_RADIO_RESTART_DELAY_MS || '700'), 10) || 700,
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

                logger.log(
                    `[IMVU-SESSION] Updated room ${roomId} radio URL via API (stop${flashClear ? ' → clear' : ''} → update → start, status ${startRes.status}).`,
                );
                return { ok: true, reason: 'api-restart-radio' };
            } catch (error) {
                logger.warn(`[IMVU-SESSION] Room radio URL update failed for ${roomId}: ${error.message}`);
                return { ok: false, reason: error.message || 'post-failed' };
            }
        })();

        radioUpdateInflight.set(normalizedRoomId, work);
        try {
            return await work;
        } finally {
            radioUpdateInflight.delete(normalizedRoomId);
        }
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
        fetchChatParticipant,
        fetchUserProfile,
        apiGetWearableNames,
        fetchUserName,
        fetchLegacyChatQueue,
        ensureChatParticipant,
        removeChatParticipant,
        fetchRoomMediaPlaybackState,
        fetchRoomMediaPlayerUpdateQueue,
        setRoomRadioStreamUrl,
    };
}
