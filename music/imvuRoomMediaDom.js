import { normalizeRoomApiSlug } from '../user-tracker-utils.js';

/**
 * Best-effort: push a stream URL into IMVU Next room media / URL fields (layout-dependent).
 * Falls back to authenticated IMVU REST API when no browser page is available (pure WebSocket mode).
 * @returns {Promise<{ ok: boolean, reason?: string, detail?: string }>}
 */
export async function applyRoomMediaStreamUrl(page, publicUrl, opts = null) {
    const url = String(publicUrl || '').trim();
    if (!url || !/^https:\/\//i.test(url)) return { ok: false, reason: 'invalid-url' };

    const sessionClient = opts?.sessionClient;
    const roomId = opts?.roomId;
    if ((!page || page.isClosed()) && sessionClient?.setRoomRadioStreamUrl && roomId) {
        const result = await sessionClient.setRoomRadioStreamUrl(roomId, url, {
            stationName: String(opts?.stationName || '').trim(),
            forceRestart: Boolean(opts?.forceRestart),
        });
        if (result?.ok) {
            console.log(`[music/api] room ${roomId} media URL set: ${url}`);
            return { ok: true, reason: result.reason || 'api' };
        }
        console.warn(
            `[music/api] room media URL not updated for ${roomId}: ${result?.reason || 'unknown'}${result?.detail ? ` (${result.detail})` : ''} · url=${url}`,
        );
        return {
            ok: false,
            reason: result?.reason || 'api-failed',
            detail: result?.detail || '',
        };
    }

    if (!page || page.isClosed()) return { ok: false, reason: 'page-unavailable' };

    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    const applyInFrame = async (frame, idx) => {
        try {
            const openMediaPanel = async () => {
                try {
                    const candidates = [
                        'li[data-nav="media-button"]',
                        'li.system-tray-item:nth-child(1)',
                        'li.system-tray-item',
                        '[aria-label*="media" i]',
                        '[title*="media" i]',
                        'button[class*="media" i]',
                    ];
                    for (const sel of candidates) {
                        const btn = await frame.$(`>>> ${sel}`);
                        if (!btn) continue;
                        await btn.click();
                        await wait(350);
                    }
                } catch {}
            };

            const applyOnce = async () => frame.evaluate((u) => {
                try {
                    /**
                     * Traverse normal DOM + open shadow roots.
                     * @param {ParentNode} root
                     * @returns {Element[]}
                     */
                    const allElements = (root) => {
                        const out = [];
                        const walk = (node) => {
                            if (!node) return;
                            for (const el of node.querySelectorAll('*')) {
                                out.push(el);
                                if (el.shadowRoot) walk(el.shadowRoot);
                            }
                        };
                        walk(root);
                        return out;
                    };

                    const getText = (el) => String(el?.textContent || '').trim().toLowerCase();
                    const visible = (el) =>
                        !!el &&
                        el instanceof HTMLElement &&
                        (() => {
                            const r = el.getBoundingClientRect();
                            return r.width > 0 && r.height > 0;
                        })() &&
                        getComputedStyle(el).visibility !== 'hidden' &&
                        getComputedStyle(el).display !== 'none' &&
                        getComputedStyle(el).opacity !== '0';

                    const nodes = allElements(document);
                    const inputs = nodes.filter(
                        (el) =>
                            el instanceof HTMLInputElement &&
                            (el.id === 'radio-station-input' ||
                                /radio station/i.test(String(el.placeholder || '')) ||
                                /url/i.test(String(el.placeholder || ''))),
                    );
                    const input = inputs.find(visible) || inputs[0] || null;
                    if (!input) {
                        return { ok: false, reason: 'input-not-found', inputs: 0 };
                    }

                    input.focus();
                    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
                    if (desc?.set) desc.set.call(input, u);
                    else input.value = u;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
                    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));

                    const container = input.closest('.radio-set-station-container');
                    if (container) {
                        for (const btn of container.querySelectorAll('button')) {
                            if (!(btn instanceof HTMLButtonElement) || btn.disabled) continue;
                            if (getText(btn) === 'load') {
                                btn.click();
                                return { ok: true, reason: 'clicked-load-near-input', inputs: inputs.length };
                            }
                        }
                    }

                    for (const el of nodes) {
                        if (!(el instanceof HTMLButtonElement) || el.disabled) continue;
                        const t = getText(el);
                        if (t === 'load' || t === 'save' || t === 'apply' || t === 'update') {
                            el.click();
                            return { ok: true, reason: `clicked-fallback-${t}`, inputs: inputs.length };
                        }
                    }

                    return { ok: true, reason: 'value-set-no-button', inputs: inputs.length };
                } catch {
                    return { ok: false, reason: 'evaluate-exception', inputs: 0 };
                }
            }, url);

            // IMVU starts in chat panel; open media controls first when possible.
            await openMediaPanel();
            let applied = await applyOnce();
            if (!applied?.ok && applied?.reason === 'input-not-found') {
                await openMediaPanel();
                applied = await applyOnce();
            }
            if (!applied?.ok && applied?.reason === 'input-not-found') {
                await wait(600);
                applied = await applyOnce();
            }
            const info = applied && typeof applied === 'object' ? applied : { ok: Boolean(applied), reason: 'legacy' };
            console.log(
                `[music/dom] frame#${idx} ${info.ok ? 'OK' : 'MISS'} reason=${info.reason} inputs=${info.inputs ?? 0} url=${String(frame.url()).slice(0, 140)}`,
            );
            return Boolean(info.ok);
        } catch (e) {
            console.warn(`[music/dom] frame#${idx} error:`, e?.message || e);
            return false;
        }
    };

    try {
        let anyHit = false;
        for (const [idx, frame] of page.frames().entries()) {
            if (await applyInFrame(frame, idx)) {
                anyHit = true;
            }
        }
        if (!anyHit) {
            console.warn(`[music/dom] no frame accepted media URL update (${page.frames().length} frames scanned).`);
        }
        return anyHit ? { ok: true, reason: 'dom' } : { ok: false, reason: 'dom-miss' };
    } catch {
        return { ok: false, reason: 'dom-error' };
    }
}

/**
 * IMVU persists `station_url` without our Icecast cache-bust (`_play=`) param; strict equality would
 * always fail while status is already "playing".
 */
function imvuStreamUrlsMatch(stationUrl, expectedUrl) {
    const norm = (raw) => {
        const s = String(raw || '').trim();
        if (!s) return '';
        try {
            const u = new URL(s);
            u.searchParams.delete('_play');
            const q = u.searchParams.toString();
            return `${u.origin}${u.pathname}${q ? `?${q}` : ''}`;
        } catch {
            return s;
        }
    };
    return norm(stationUrl) === norm(expectedUrl);
}

/**
 * Poll IMVU media_player state and confirm expected URL is playing.
 * @param {{ isClosed?: () => boolean } | null} page
 * @param {{ roomId: string, expectedUrl: string, timeoutMs?: number, intervalMs?: number, sessionClient?: { fetchRoomMediaPlaybackState?: (roomId: string) => Promise<{ ok?: boolean, status?: string, stationUrl?: string, reason?: string }> } }} opts
 * @returns {Promise<{ ok: boolean, status?: string, stationUrl?: string, reason?: string }>}
 */
export async function waitForRoomMediaPlayback(page, opts) {
    const roomId = String(opts?.roomId || '').trim();
    const expectedUrl = String(opts?.expectedUrl || '').trim();
    const timeoutMs = Math.max(3000, Number(opts?.timeoutMs || 18000));
    const intervalMs = Math.max(400, Number(opts?.intervalMs || 1500));
    const sessionClient = opts?.sessionClient;
    if (!roomId || !expectedUrl) return { ok: false, reason: 'invalid-args' };

    if ((!page || page.isClosed()) && sessionClient?.fetchRoomMediaPlaybackState) {
        const endAt = Date.now() + timeoutMs;
        let last = { ok: false, reason: 'no-state' };
        while (Date.now() < endAt) {
            const state = await sessionClient.fetchRoomMediaPlaybackState(roomId);
            last = state || { ok: false, reason: 'state-empty' };
            const status = String(last.status || '').toLowerCase();
            const stationUrl = String(last.stationUrl || '').trim();
            if (imvuStreamUrlsMatch(stationUrl, expectedUrl) && status === 'playing') {
                return { ok: true, status, stationUrl };
            }
            await new Promise((r) => setTimeout(r, intervalMs));
        }
        return {
            ok: false,
            reason: last.reason || 'timeout',
            status: last.status,
            stationUrl: last.stationUrl,
        };
    }

    if (!page || page.isClosed()) return { ok: false, reason: 'page-unavailable' };

    const roomSlug = normalizeRoomApiSlug(roomId);
    if (!roomSlug) return { ok: false, reason: 'invalid-room-id' };

    const endAt = Date.now() + timeoutMs;
    let last = { ok: false, reason: 'no-state' };

    while (Date.now() < endAt) {
        try {
            const state = await page.evaluate(async ({ roomSlug: slug }) => {
                const fetchJson = async (url) => {
                    const res = await fetch(url, { credentials: 'include' });
                    if (!res.ok) return null;
                    return await res.json();
                };
                const findCurrentState = (payload) => {
                    const den = payload?.denormalized || {};
                    for (const v of Object.values(den)) {
                        const cur = v?.data?.current_state;
                        if (cur && typeof cur === 'object') return cur;
                    }
                    const root = den?.[payload?.id]?.data?.current_state;
                    return root && typeof root === 'object' ? root : null;
                };
                try {
                    const roomUrl = `https://api.imvu.com/room/${slug}`;
                    const roomPayload = await fetchJson(roomUrl);
                    if (!roomPayload) return { ok: false, reason: 'room-fetch-failed' };
                    const roomObj = roomPayload?.denormalized?.[roomUrl];
                    const expUrl = String(roomObj?.relations?.media_experience || '').trim();
                    if (!expUrl) return { ok: false, reason: 'media-experience-missing' };

                    const expPayload = await fetchJson(expUrl);
                    if (!expPayload) return { ok: false, reason: 'experience-fetch-failed' };
                    const expObj =
                        expPayload?.denormalized?.[expUrl] ||
                        Object.values(expPayload?.denormalized || {}).find((v) => v?.relations?.media_players);
                    const playersUrl = String(expObj?.relations?.media_players || '').trim();
                    if (!playersUrl) return { ok: false, reason: 'media-players-missing' };

                    const playersPayload = await fetchJson(playersUrl);
                    if (!playersPayload) return { ok: false, reason: 'media-players-fetch-failed' };
                    const cur = findCurrentState(playersPayload);
                    if (!cur) return { ok: false, reason: 'media-state-missing' };

                    return {
                        ok: true,
                        status: String(cur.status || ''),
                        stationUrl: String(cur.station_url || ''),
                    };
                } catch {
                    return { ok: false, reason: 'state-evaluate-failed' };
                }
            }, { roomSlug });

            last = state || { ok: false, reason: 'state-empty' };
            const status = String(last.status || '').toLowerCase();
            const stationUrl = String(last.stationUrl || '').trim();
            if (imvuStreamUrlsMatch(stationUrl, expectedUrl) && status === 'playing') {
                return { ok: true, status, stationUrl };
            }
        } catch {
            last = { ok: false, reason: 'state-check-error' };
        }

        await new Promise((r) => setTimeout(r, intervalMs));
    }

    return {
        ok: false,
        reason: last.reason || 'timeout',
        status: last.status,
        stationUrl: last.stationUrl,
    };
}
