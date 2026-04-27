import { normalizeImvuUsername, normalizeRoomApiSlug } from './user-tracker-utils.js';

const KICK_RE = /^!(?:kick|boot)\s+(.+)$/i;
const KICK_SLASH_RE = /^\/(?:kick|boot)\s+(.+)$/i;

/** First numeric segment of room id `261755692-875` → legacy *boot arg (may be product id, not avatar CID). */
export const roomBootOwnerIdFromRoomId = (roomId) => {
    const s = String(roomId ?? '')
        .trim()
        .replace(/^room-/i, '');
    const m = s.match(/^(\d+)-\d+/);
    return m ? m[1] : null;
};

const pickUserIdFromValue = (v) => {
    if (v == null) return null;
    if (typeof v === 'number' && Number.isFinite(v)) {
        const s = String(Math.trunc(v));
        return /^\d{5,15}$/.test(s) ? s : null;
    }
    if (typeof v === 'string') {
        const t = v.trim();
        const m = t.match(/user-(\d{5,15})/i);
        if (m) return m[1];
        if (/^\d{5,15}$/.test(t)) return t;
    }
    if (typeof v === 'object') {
        for (const k of ['id', 'user_id', 'userId', 'cid', 'avatar_id', 'avatarId', 'url', 'href']) {
            if (k in v) {
                const x = pickUserIdFromValue(v[k]);
                if (x) return x;
            }
        }
    }
    return null;
};

/**
 * Room document `GET /room/room-…` — first *boot arg should be the **owner’s avatar id** when IMVU exposes it.
 * @returns {Promise<string|null>}
 */
export const fetchBootOwnerCidFromRoomApi = async (page, roomId) => {
    const slug = normalizeRoomApiSlug(roomId);
    if (!slug || !page || page.isClosed()) return null;
    try {
        const cid = await page.evaluate(async (roomSlug) => {
            try {
                const res = await fetch(`https://api.imvu.com/room/${roomSlug}`, {
                    credentials: 'include',
                    mode: 'cors',
                    headers: { Accept: 'application/json' },
                });
                if (!res.ok) return null;
                const json = await res.json();
                const denorm = json.denormalized || {};
                const entry = (json.id && denorm[json.id]) || Object.values(denorm)[0];
                const d = entry?.data;
                if (!d || typeof d !== 'object') return null;

                const keyHints = [
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
                for (const k of keyHints) {
                    if (!(k in d)) continue;
                    const id = pickUserIdFromValue(d[k]);
                    if (id) return id;
                }

                const prefixMatch = String(roomSlug).match(/^room-(\d{5,15})-\d+/i);
                const prefixId = prefixMatch ? prefixMatch[1] : null;
                if (prefixId) {
                    const denormKeys = Object.keys(denorm).join('\n');
                    const hay = `${JSON.stringify(d)}\n${denormKeys}`;
                    const re = new RegExp(`(?:/user/user-|user-)${prefixId}(?:[^0-9]|$)`, 'i');
                    if (re.test(hay)) return prefixId;
                    for (const dk of Object.keys(denorm)) {
                        const um = dk.match(/\/user\/user-(\d{5,15})(?:\/|$)/i);
                        if (um && um[1] === prefixId) return prefixId;
                    }
                    const fullHay = JSON.stringify(json);
                    const reFull = new RegExp(`(?:/user/user-|user-)${prefixId}(?:[^0-9]|$)`, 'i');
                    if (reFull.test(fullHay)) return prefixId;
                }

                return null;
            } catch {
                return null;
            }
        }, slug);
        return cid && /^\d{5,15}$/.test(String(cid)) ? String(cid) : null;
    } catch {
        return null;
    }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntilRosterAbsent(rosterHasUserId, targetId, opts) {
    const { timeoutMs = 14000, intervalMs = 450 } = opts;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (typeof rosterHasUserId !== 'function' || !rosterHasUserId(targetId)) return true;
        await sleep(intervalMs);
    }
    return typeof rosterHasUserId !== 'function' ? true : !rosterHasUserId(targetId);
}

/** After *boot / txnBoot, try participant DELETE via REST (often 403 for mod bots — set IMVU_DISCORD_KICK_REST=1 to retry). */
const restParticipantKickEnabled = () => {
    const v = (process.env.IMVU_DISCORD_KICK_REST ?? '0').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on';
};

/**
 * @returns {Promise<{ ok: boolean, attempts: { url: string, status: number|string }[] }>}
 */
async function tryDeleteChatParticipantRest(page, roomId, targetAvatarId) {
    const attempts = [];
    const slug = normalizeRoomApiSlug(roomId);
    if (!slug || !page || page.isClosed() || !/^\d+$/.test(String(targetAvatarId))) {
        return { ok: false, attempts };
    }
    const suffix = slug.replace(/^room-/i, '');
    const chatPath = `chat-${suffix}`;

    try {
        const pack = await page.evaluate(
            async ({ chatPath: cp, tid }) => {
                const out = [];
                const urls = [
                    `https://api.imvu.com/chat/${cp}/participants/user-${tid}`,
                    `https://api.imvu.com/chat/${cp}/participants/user-${tid}/`,
                ];
                for (const url of urls) {
                    try {
                        const res = await fetch(url, {
                            method: 'DELETE',
                            credentials: 'include',
                            mode: 'cors',
                            headers: { Accept: 'application/json' },
                        });
                        out.push({ url, status: res.status });
                        if (res.ok || res.status === 204) return { ok: true, attempts: out };
                    } catch (e) {
                        out.push({ url, status: `err:${String(e?.message || e)}` });
                    }
                }
                return { ok: false, attempts: out };
            },
            { chatPath, tid: String(targetAvatarId) }
        );
        return {
            ok: Boolean(pack?.ok),
            attempts: Array.isArray(pack?.attempts) ? pack.attempts : attempts,
        };
    } catch {
        return { ok: false, attempts };
    }
}

const stripDiscordMentions = (s) =>
    String(s ?? '')
        .replace(/<@!?(\d+)>/g, '')
        .trim();

export const parseDiscordKickLine = (raw) => {
    const line = stripDiscordMentions(raw).trim();
    let m = line.match(KICK_RE);
    if (!m) m = line.match(KICK_SLASH_RE);
    if (!m) return null;
    const handle = (m[1] || '').trim();
    if (!handle) return null;
    return { handle };
};

const normKey = (s) => {
    const n = normalizeImvuUsername(String(s ?? '').trim());
    return typeof n === 'string' ? n.toLowerCase() : '';
};

/**
 * @param {Map<string, string|null>} lastUserMap avatarId -> display name
 * @returns {{ avatarId: string, label: string } | null}
 */
export const findRosterEntryByHandle = (lastUserMap, handle) => {
    const want = normKey(handle);
    if (!want) return null;
    for (const [avatarId, label] of lastUserMap.entries()) {
        if (!avatarId || !/^\d+$/.test(String(avatarId))) continue;
        if (label == null || label === '') continue;
        if (normKey(label) === want) return { avatarId: String(avatarId), label: String(label) };
    }
    return null;
};

/**
 * Uses IMVU session cookies inside the chat tab (same as room details fetch).
 * Tries `/room/room-…/moderators` and `/chat/chat-…/moderators` (Next client uses both resources).
 * @returns {Promise<string[]>} moderator / co-mod avatar ids (may include unrelated numeric ids; we only test .includes(self))
 */
export const fetchRoomModeratorIds = async (page, roomId) => {
    const slug = normalizeRoomApiSlug(roomId);
    if (!slug || !page || page.isClosed()) return [];
    try {
        const pack = await page.evaluate(async (roomSlug) => {
            const attempts = [];
            const out = new Set();
            const addBare = (x) => {
                if (x == null) return;
                const s = String(x).trim();
                if (/^\d{5,15}$/.test(s)) out.add(s);
            };
            const walk = (val, depth) => {
                if (depth > 40 || val == null) return;
                const t = typeof val;
                if (t === 'string') {
                    const re = /user-(\d{5,15})/gi;
                    let m;
                    while ((m = re.exec(val)) !== null) out.add(m[1]);
                    addBare(val);
                    return;
                }
                if (t === 'number' && Number.isFinite(val)) {
                    addBare(Math.trunc(val));
                    return;
                }
                if (Array.isArray(val)) {
                    for (const x of val) walk(x, depth + 1);
                    return;
                }
                if (t === 'object') {
                    for (const v of Object.values(val)) walk(v, depth + 1);
                }
            };

            const suffix = roomSlug.replace(/^room-/i, '');
            const urls = [
                `https://api.imvu.com/room/${roomSlug}/moderators`,
                `https://api.imvu.com/chat/chat-${suffix}/moderators`,
            ];

            for (const url of urls) {
                try {
                    const res = await fetch(url, {
                        credentials: 'include',
                        mode: 'cors',
                        headers: { Accept: 'application/json' },
                    });
                    let topKeys = [];
                    if (res.ok) {
                        const json = await res.json();
                        if (json && typeof json === 'object') {
                            topKeys = Object.keys(json).slice(0, 16);
                            walk(json, 0);
                        }
                    }
                    attempts.push({ url, status: res.status, topKeys });
                } catch (e) {
                    attempts.push({
                        url,
                        status: 'exception',
                        err: String(e?.message || e),
                        topKeys: [],
                    });
                }
            }

            return { ids: [...out], attempts };
        }, slug);

        const ids = Array.isArray(pack?.ids) ? pack.ids.map(String) : [];
        if (ids.length === 0 && Array.isArray(pack?.attempts) && pack.attempts.length) {
            console.log('[DISCORD-KICK][mods] empty — attempts:', JSON.stringify(pack.attempts));
        }
        return ids;
    } catch {
        return [];
    }
};

const kickEnabled = () => {
    const v = (process.env.IMVU_DISCORD_KICK ?? '1').trim().toLowerCase();
    return v !== '0' && v !== 'false' && v !== 'off';
};

/** When IMVU’s moderators JSON is empty from this client (CORS, shape, or endpoint), set to 1 to allow kicks anyway. */
const skipModCheck = () => {
    const v = (process.env.IMVU_DISCORD_KICK_SKIP_MOD_CHECK ?? '0').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on';
};

/** Send *imvu:txnBoot before *boot (some sessions behave better this way). */
const txnBootFirst = () => {
    const v = (process.env.IMVU_DISCORD_KICK_TXN_FIRST ?? '0').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on';
};

/**
 * @returns {Promise<{ handled: boolean }>}
 *   handled: true = do not relay raw Discord line (kick path consumed it).
 */
export async function tryHandleDiscordRelayMessage(ctx) {
    if (!kickEnabled()) return { handled: false };

    const parsed = parseDiscordKickLine(ctx.content);
    if (!parsed) return { handled: false };

    const {
        page,
        roomId,
        lastUserMap,
        selfUserId,
        sendMessage,
        rosterHasUserId,
        logPrefix = '[DISCORD-KICK]',
    } = ctx;

    const reply = async (text) => {
        try {
            await sendMessage(text);
        } catch (e) {
            console.log(`${logPrefix} sendMessage failed:`, e?.message || e);
        }
    };

    if (!ctx.state?.botJoinedChat) {
        console.log(`${logPrefix} ignored (bot not in chat yet)`);
        return { handled: true };
    }

    const self = selfUserId != null ? String(selfUserId) : '';
    if (!/^\d+$/.test(self)) {
        await reply('(bot) Cannot kick yet — session id not ready.');
        console.log(`${logPrefix} no selfUserId`);
        return { handled: true };
    }

    const modIds = await fetchRoomModeratorIds(page, roomId);
    const ownerIdFromRoomKey = roomBootOwnerIdFromRoomId(roomId);
    const ownerCidFromApi = await fetchBootOwnerCidFromRoomApi(page, roomId);
    const isOwner =
        (ownerCidFromApi && self === ownerCidFromApi) ||
        (ownerIdFromRoomKey && self === ownerIdFromRoomKey);
    const isModListed = modIds.length > 0 && modIds.includes(self);
    const bypassMod = skipModCheck();

    if (bypassMod && !isOwner && !isModListed) {
        console.warn(
            `${logPrefix} IMVU_DISCORD_KICK_SKIP_MOD_CHECK=1 — proceeding without moderators API (self=${self})`
        );
    }

    if (!isOwner && !isModListed && !bypassMod) {
        await reply(
            '(bot) Discord kick refused — could not confirm moderator status (room/chat moderators API). Owner short-id also does not match this account. Set IMVU_DISCORD_KICK_SKIP_MOD_CHECK=1 only if you accept the risk.'
        );
        console.log(
            `${logPrefix} not moderator; self=${self} roomKey=${ownerIdFromRoomKey} apiOwner=${ownerCidFromApi || '—'} mods=${modIds.slice(0, 12).join(',')}`
        );
        return { handled: true };
    }

    const target = findRosterEntryByHandle(lastUserMap, parsed.handle);
    if (!target) {
        await reply(`(bot) No one in this room matches "${parsed.handle}" (check spelling / roster).`);
        console.log(`${logPrefix} no roster match for`, parsed.handle);
        return { handled: true };
    }

    if (target.avatarId === self) {
        await reply('(bot) Cannot kick myself.');
        return { handled: true };
    }

    const bootPrimary =
        (ownerCidFromApi && String(ownerCidFromApi)) || (ownerIdFromRoomKey && String(ownerIdFromRoomKey)) || null;
    if (!bootPrimary) {
        await reply('(bot) Cannot resolve *boot owner id (room API + room id).');
        console.log(`${logPrefix} bad room id`, roomId);
        return { handled: true };
    }

    const txnLine = `*imvu:txnBoot ${target.avatarId}`;
    const bootLine = `*boot ${bootPrimary} ${target.avatarId}`;

    console.log(
        `${logPrefix} ${isOwner ? 'owner' : 'mod'} → target ${target.label} (${target.avatarId}) *boot 1st arg=${bootPrimary} (apiOwner=${ownerCidFromApi || '—'} roomKey=${ownerIdFromRoomKey || '—'} txnFirst=${txnBootFirst() ? '1' : '0'})`
    );

    let gone = false;
    if (txnBootFirst()) {
        await sendMessage(txnLine);
        gone = await waitUntilRosterAbsent(rosterHasUserId, target.avatarId, {
            timeoutMs: 15000,
            intervalMs: 450,
        });
        if (!gone) {
            console.log(`${logPrefix} txnBoot first — target still on roster; sending *boot`);
            await sendMessage(bootLine);
            gone = await waitUntilRosterAbsent(rosterHasUserId, target.avatarId, {
                timeoutMs: 15000,
                intervalMs: 450,
            });
        }
    } else {
        await sendMessage(bootLine);
        gone = await waitUntilRosterAbsent(rosterHasUserId, target.avatarId, {
            timeoutMs: 15000,
            intervalMs: 450,
        });

        if (!gone) {
            console.log(`${logPrefix} target still on roster after *boot — sending txnBoot fallback`);
            await sendMessage(txnLine);
            gone = await waitUntilRosterAbsent(rosterHasUserId, target.avatarId, {
                timeoutMs: 15000,
                intervalMs: 450,
            });
        }
    }

    if (
        !gone &&
        ownerCidFromApi &&
        ownerIdFromRoomKey &&
        ownerCidFromApi !== ownerIdFromRoomKey &&
        bootPrimary === ownerCidFromApi
    ) {
        console.log(
            `${logPrefix} trying *boot with room-id numeric segment as 1st arg (${ownerIdFromRoomKey}) — API owner was ${ownerCidFromApi}`
        );
        await sendMessage(`*boot ${ownerIdFromRoomKey} ${target.avatarId}`);
        gone = await waitUntilRosterAbsent(rosterHasUserId, target.avatarId, {
            timeoutMs: 12000,
            intervalMs: 450,
        });
    }

    let restAttempts = [];
    if (!gone && restParticipantKickEnabled()) {
        const rest = await tryDeleteChatParticipantRest(page, roomId, target.avatarId);
        restAttempts = rest.attempts || [];
        if (restAttempts.length) {
            console.log(`${logPrefix} REST participant DELETE:`, JSON.stringify(restAttempts));
        }
        if (rest.ok) {
            gone = await waitUntilRosterAbsent(rosterHasUserId, target.avatarId, {
                timeoutMs: 12000,
                intervalMs: 450,
            });
        }
    }

    if (!gone) {
        const triedRest = restAttempts.length > 0;
        const allRest403 =
            triedRest && restAttempts.every((a) => a.status === 403 || a.status === 401);
        let detail =
            `${target.label} is still on the roster after *boot and *imvu:txnBoot (chat accepted them, but IMVU did not remove the user).`;
        if (triedRest && allRest403) {
            detail +=
                ' Participant DELETE over HTTPS returned 403 — IMVU forbids that removal for this login (co-mod / automation limits). Removing from the official client as the room owner may be required.';
        } else if (triedRest) {
            detail += ' REST participant DELETE did not succeed; see bot console for HTTP statuses.';
        }
        await reply(`(bot) Kick did not complete — ${detail}`);
    } else {
        console.log(`${logPrefix} roster no longer shows ${target.label} (${target.avatarId})`);
    }

    return { handled: true };
}
