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

    return {
        jar,
        client,
        ensureLoggedIn,
        cookieHeader,
        cookieValue,
        resolveImqIdentity,
        apiGet,
        fetchRoomDetails,
        fetchUserName,
        fetchLegacyChatQueue,
        ensureChatParticipant,
    };
}
