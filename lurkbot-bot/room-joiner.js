import 'dotenv/config';
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';
import express from 'express';
import { startUserTracking } from './user-tracker.js';
import axios from 'axios';
import dotenv from 'dotenv';
import { parseProxyFromProcessEnv, resolveChromeProxy } from './proxy-env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

/** multi-launcher: triggers Webshare/pool rotation when proxy may be blocked */
const EXIT_PROXY_ROTATE = 2;

if (!global.discordBridge) {
    global.discordBridge = new EventEmitter();
}
global.discordBridge.setMaxListeners(0);

function startDiscordRelayServer(botLabel) {
    const portRaw = (process.env.IMVU_DISCORD_RELAY_PORT || '').trim();
    if (!portRaw) {
        console.log(
            `[${botLabel}] ℹ️ IMVU_DISCORD_RELAY_PORT unset — set by multi-launcher or export it for Discord→IMVU relay`
        );
        return null;
    }
    const port = parseInt(portRaw, 10);
    if (!Number.isFinite(port) || port <= 0) return null;
    const app = express();
    app.use(express.json());
    app.post('/discord-relay', (req, res) => {
        try {
            const { targetRoomId, content } = req.body || {};
            if (targetRoomId != null && content != null && global.discordBridge) {
                global.discordBridge.emit('chat', {
                    targetRoomId: String(targetRoomId),
                    content: String(content),
                });
            }
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false });
        }
    });
    const srv = app.listen(port, '127.0.0.1', () => {
        console.log(`[${botLabel}] 📢 Discord→IMVU relay on http://127.0.0.1:${port}/discord-relay`);
    });
    srv.on('error', (e) => {
        console.error(`[${botLabel}] ❌ Discord relay :${port} — ${e.message}`);
    });
    return srv;
}

const RUNNER = 'RoomJoiner';
const API_BASE_URL = process.env.APP_URL || 'http://localhost:8000';

let ctxBotName = RUNNER;

async function applyProxyAuthToPage(page, auth) {
    if (!page || page.isClosed() || !auth) return;
    await page.authenticate({ username: auth.username, password: auth.password || '' });
}

async function wireProxyAuthForBrowser(browser, auth) {
    if (!auth) return;
    const hook = async (pg) => {
        try {
            await applyProxyAuthToPage(pg, auth);
        } catch (e) {
            console.warn(`[${ctxBotName}] proxy authenticate:`, e.message);
        }
    };
    browser.on('targetcreated', async (target) => {
        const pg = await target.page();
        if (pg) await hook(pg);
    });
    for (const pg of await browser.pages()) await hook(pg);
}

const cleanupProfileLock = (profileDir) => {
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        try {
            const p = path.join(profileDir, name);
            if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch {}
    }
};

const fetchBotSettings = async (botName) => {
    const url = `${API_BASE_URL}/api/bots/${encodeURIComponent(botName)}`;
    try {
        const response = await axios.get(url);
        return { ...response.data, profileName: botName };
    } catch (error) {
        console.error(`[${RUNNER}][${botName}] Error fetching bot settings from ${url}:`, error.message);
        return null;
    }
};

let botMatch = { username: '', password: '', profile: 'S1VA' };

let hasLoggedIn = false;
let lastLoginAt = 0;

function sessionMaxExceeded() {
    const max = parseInt(process.env.IMVU_SESSION_MAX_MS || '0', 10);
    if (!max || !lastLoginAt) return false;
    return Date.now() - lastLoginAt > max;
}

function isNextAppShellUrl(u) {
    if (!u || typeof u !== 'string' || !u.includes('imvu.com')) return false;
    if (u.includes('/next/chat/') || u.includes('/login') || u.includes('/welcome')) return false;
    if (u.includes('/next/home')) return true;
    try {
        const path = new URL(u).pathname.replace(/\/+$/, '') || '/';
        return path === '/next' || path.endsWith('/next');
    } catch {
        return false;
    }
}

async function waitForStrictLoggedIn(page, timeoutMs = 45000, stepMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await detectStrictLoggedIn(page)) return true;
        await new Promise((r) => setTimeout(r, stepMs));
    }
    return false;
}

/** True when IMVU Next app shell looks signed-in without obvious guest CTAs (avoids missing avatar menu on slow load). */
async function detectRelaxedAppLoggedIn(page) {
    if (!page || page.isClosed()) return false;
    try {
        return await page.evaluate(() => {
            const href = window.location.href;
            if (href.includes('chrome-error://')) return false;
            if (href.includes('/login') || href.includes('/welcome/')) return false;

            const hasUserChrome = !!document.querySelector(
                '.user-menu, .avatar-name, .username, [class*="userProfile"], .avatar-container, [class*="user-menu"]'
            );

            const labelGuest = (el) => {
                const raw = (el.innerText || el.textContent || el.getAttribute('aria-label') || '')
                    .replace(/\s+/g, ' ')
                    .trim();
                const u = raw.toUpperCase();
                return u === 'LOG IN' || u === 'LOGIN' || u === 'SIGN IN' || /\bLOG\s+IN\b/i.test(raw);
            };

            const guestLink = !!document.querySelector('a.login-link, .login-link');
            const guestClickable = Array.from(
                document.querySelectorAll('a, button, [role="button"]')
            ).some(labelGuest);

            if (guestLink || guestClickable) return false;

            const headerLoginHref = !!document.querySelector(
                'header a[href*="login" i], header a[href*="welcome" i], nav a[href*="login" i]'
            );
            if (headerLoginHref && !hasUserChrome) return false;

            if (/\/next\/chat\/room-/.test(href)) {
                return !!hasUserChrome;
            }

            let path = '';
            try {
                path = new URL(href).pathname.replace(/\/+$/, '') || '/';
            } catch {
                path = '';
            }
            const nextRoot = path === '/next' || path.endsWith('/next');
            const homeLike = href.includes('/next/home') || nextRoot;
            if (homeLike) return true;

            return !!hasUserChrome && href.includes('imvu.com/next');
        });
    } catch {
        return false;
    }
}

async function waitForRelaxedAppLoggedIn(page, timeoutMs = 30000, stepMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await detectRelaxedAppLoggedIn(page)) return true;
        await new Promise((r) => setTimeout(r, stepMs));
    }
    return false;
}

async function waitForAnyAppSession(page, strictMs, relaxedExtraMs = 25000) {
    if (await waitForStrictLoggedIn(page, strictMs, 2000)) return true;
    if (isNextAppShellUrl(page.url()) || page.url().includes('/next/home')) {
        return await waitForRelaxedAppLoggedIn(page, relaxedExtraMs, 2000);
    }
    return await waitForRelaxedAppLoggedIn(page, Math.min(relaxedExtraMs, 15000), 2000);
}

/** After password submit: wait until IMVU leaves welcome/login or hits /next (client redirects can be slow behind proxy). */
async function waitForPostLoginRedirect(page, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    const started = Date.now();
    let lastProgressLog = 0;
    const progressEveryMs = parseInt(process.env.IMVU_POST_LOGIN_PROGRESS_MS || '15000', 10);

    while (Date.now() < deadline) {
        const u = page.url();
        if (progressEveryMs > 0 && Date.now() - lastProgressLog >= progressEveryMs) {
            lastProgressLog = Date.now();
            const elapsed = Math.round((Date.now() - started) / 1000);
            const cap = 120;
            const short = u.length > cap ? `${u.slice(0, cap - 3)}...` : u;
            console.log(
                `[${ctxBotName}] ⏳ Login redirect wait ${elapsed}s / ${Math.round(timeoutMs / 1000)}s — ${short}`
            );
        }
        if (u.includes('chrome-error://')) return false;
        if (/imvu\.com\/next/i.test(u)) return true;
        const stillAuthGate =
            /secure\.imvu\.com\/welcome|\/welcome\/login/i.test(u) ||
            (/\/login/i.test(u) && !/imvu\.com\/next/i.test(u));
        if (!stillAuthGate && u.includes('imvu.com')) return true;
        await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
}

async function tryClickLoginSubmitButton(page) {
    try {
        return await page.evaluate(() => {
            const matches = (t) => /^(log\s*in|sign\s*in|submit)$/i.test((t || '').trim());
            const btn =
                document.querySelector(
                    'button[type="submit"], form button[type="submit"], input[type="submit"]'
                ) ||
                Array.from(document.querySelectorAll('button')).find((b) =>
                    matches((b.innerText || b.textContent || '').trim())
                );
            if (btn) {
                btn.click();
                return true;
            }
            return false;
        });
    } catch {
        return false;
    }
}

async function detectStrictLoggedIn(page) {
    if (!page || page.isClosed()) return false;
    try {
        return await page.evaluate(() => {
            const href = window.location.href;
            if (href.includes('chrome-error://')) return false;
            if (href.includes('/login') || href.includes('/welcome/')) return false;

            const hasUserChrome = !!document.querySelector(
                '.user-menu, .avatar-name, .username, [class*="userProfile"], .avatar-container, [class*="user-menu"]'
            );

            const labelGuest = (el) => {
                const raw = (el.innerText || el.textContent || el.getAttribute('aria-label') || '')
                    .replace(/\s+/g, ' ')
                    .trim();
                const u = raw.toUpperCase();
                return u === 'LOG IN' || u === 'LOGIN' || u === 'SIGN IN' || /\bLOG\s+IN\b/i.test(raw);
            };

            const guestLink = !!document.querySelector('a.login-link, .login-link');
            const guestClickable = Array.from(
                document.querySelectorAll('a, button, [role="button"]')
            ).some(labelGuest);

            const headerLoginHref = !!document.querySelector(
                'header a[href*="login" i], header a[href*="welcome" i], nav a[href*="login" i]'
            );

            if (guestLink || guestClickable) return false;
            if (headerLoginHref && !hasUserChrome) return false;

            const onHome = href.includes('/next/home');
            const inNext = href.includes('imvu.com/next');
            const inChatRoom = /imvu\.com\/next\/chat\/room-/.test(href);

            if (inChatRoom) {
                return !!hasUserChrome;
            }
            if (onHome) {
                return !!hasUserChrome && !guestLink && !guestClickable;
            }
            return hasUserChrome && inNext;
        });
    } catch {
        return false;
    }
}

async function executeLoginFlow(page) {
    try {
        if (!page || page.isClosed()) return false;

        const preLoginJitter = 8000 + Math.random() * 12000;
        console.log(`[${ctxBotName}] ⏳ Pre-login delay ${Math.round(preLoginJitter / 1000)}s`);
        await new Promise((r) => setTimeout(r, preLoginJitter));

        await page.goto('https://www.imvu.com/login/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
            console.error(`[${ctxBotName}] Login goto failed:`, e.message);
        });
        await new Promise((r) => setTimeout(r, 6000));

        if (page.url().includes('chrome-error://')) {
            console.log(`[${ctxBotName}] ⚠️ chrome-error:// — waiting 12s, one retry`);
            await new Promise((r) => setTimeout(r, 12000));
            await page.goto('https://www.imvu.com/login/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
            await new Promise((r) => setTimeout(r, 6000));
        }

        const pageStatus = await page.evaluate(() => {
            const hasUserInp = !!document.querySelector('input[name="username"], input[name="email"], #login_username');
            const loginBtn = Array.from(document.querySelectorAll('button, a, span')).find((b) => {
                const t = (b.innerText || b.textContent || '').toUpperCase().trim();
                return t === 'LOG IN' || t === 'LOGIN' || t === 'SIGN IN';
            });
            return { hasForm: hasUserInp, splashBtnFound: !!loginBtn, url: window.location.href };
        });

        console.log(`[${ctxBotName}] Login page status:`, pageStatus);

        if (pageStatus.url.includes('/next/home') || isNextAppShellUrl(pageStatus.url)) {
            if (await waitForStrictLoggedIn(page, 25000, 2000)) return true;
            if (await waitForRelaxedAppLoggedIn(page, 20000, 2000)) {
                console.log(`[${ctxBotName}] ✅ Already signed in (Next app shell)`);
                return true;
            }
        }

        if (!pageStatus.hasForm && pageStatus.splashBtnFound) {
            console.log(`[${ctxBotName}] Splash — opening login`);
            await page.evaluate(() => {
                const loginBtn = Array.from(document.querySelectorAll('button, a, span')).find((b) => {
                    const t = (b.innerText || b.textContent || '').toUpperCase().trim();
                    return t === 'LOG IN' || t === 'LOGIN' || t === 'SIGN IN';
                });
                if (loginBtn) loginBtn.click();
            });
            await new Promise((r) => setTimeout(r, 6000));
        }

        let filled = false;
        const userInputSelector =
            'input[name="username"], input[name="email"], input[type="email"], #login_username, [placeholder*="Username" i], [name="id"], input[type="text"]';
        const passInputSelector = 'input[type="password"], #login_password, [name="password"]';

        console.log(`[${ctxBotName}] ⏳ Waiting for login form...`);
        try {
            await page.waitForSelector(userInputSelector, { timeout: 20000 });
            await page.waitForSelector(passInputSelector, { timeout: 20000 });

            await page.focus(userInputSelector);
            await new Promise((r) => setTimeout(r, 800 + Math.random() * 1200));
            await page.keyboard.type(botMatch.username, { delay: 80 + Math.random() * 60 });

            await page.focus(passInputSelector);
            await new Promise((r) => setTimeout(r, 800 + Math.random() * 1200));
            await page.keyboard.type(botMatch.password, { delay: 80 + Math.random() * 60 });

            await new Promise((r) => setTimeout(r, 500 + Math.random() * 800));
            await page.keyboard.press('Enter');
            filled = true;
        } catch (e) {
            console.log(`[${ctxBotName}] ❌ Login form not found:`, e.message);
        }
        if (filled) {
            console.log(`[${ctxBotName}] ⏳ Submitted — waiting for redirect off login...`);
            const extraMs = parseInt(process.env.IMVU_POST_LOGIN_REDIRECT_MS || '90000', 10);
            let left = await waitForPostLoginRedirect(page, extraMs);
            if (!left) {
                console.log(`[${ctxBotName}] ⏳ No redirect yet — clicking submit if present`);
                await tryClickLoginSubmitButton(page);
                await new Promise((r) => setTimeout(r, 5000));
                left = await waitForPostLoginRedirect(page, Math.min(45000, extraMs));
            }
            const settleMs = parseInt(process.env.IMVU_POST_LOGIN_SETTLE_MS || '12000', 10);
            await new Promise((r) => setTimeout(r, settleMs));

            const strictWait = parseInt(process.env.IMVU_SESSION_STRICT_WAIT_MS || '70000', 10);
            const relaxedWait = parseInt(process.env.IMVU_SESSION_RELAXED_WAIT_MS || '45000', 10);

            const tryLoadNextAndVerify = async (label) => {
                await page.goto('https://www.imvu.com/next/home/', {
                    waitUntil: 'domcontentloaded',
                    timeout: 90000,
                }).catch((e) => console.warn(`[${ctxBotName}] goto next/home (${label}):`, e.message));
                await new Promise((r) => setTimeout(r, 6000));
                if (await waitForAnyAppSession(page, strictWait, relaxedWait)) return true;
                await page.goto('https://www.imvu.com/next/', {
                    waitUntil: 'domcontentloaded',
                    timeout: 90000,
                }).catch((e) => console.warn(`[${ctxBotName}] goto /next/ (${label}):`, e.message));
                await new Promise((r) => setTimeout(r, 6000));
                return await waitForAnyAppSession(page, strictWait, relaxedWait);
            };

            let seen = await waitForAnyAppSession(page, strictWait, relaxedWait);
            if (!seen) {
                seen = await tryLoadNextAndVerify('pass-a');
            }
            if (!seen) {
                console.log(`[${ctxBotName}] ⏳ Second pass: reload login outcome`);
                seen = await tryLoadNextAndVerify('pass-b');
            }

            if (!seen) {
                const u = page.url();
                let hint = '';
                try {
                    hint = await page.evaluate(() => {
                        const b = document.body?.innerText?.slice(0, 400) || '';
                        return b.replace(/\s+/g, ' ').trim();
                    });
                } catch {}
                console.error(
                    `[${ctxBotName}] ❌ Login submit did not produce a usable Next session | url=${u}` +
                        (hint ? ` | body≈ ${hint.slice(0, 180)}…` : '')
                );
                const shot = path.join(
                    __dirname,
                    `${String(botMatch.username || 'user').replace(/[^\w.-]+/g, '_')}-login-no-session.png`
                );
                await page.screenshot({ path: shot }).catch(() => {});
                return false;
            }
            return true;
        }

        const finalUrl = page.url();
        if (isNextAppShellUrl(finalUrl) || finalUrl.includes('/next/home')) {
            if (await waitForAnyAppSession(page, 12000, 20000)) {
                console.log(`[${ctxBotName}] ✅ Session OK without login form (already in Next)`);
                return true;
            }
        }

        console.log(`[${ctxBotName}] ❌ Login failed. URL: ${page.url()}`);
        await page.screenshot({ path: path.join(__dirname, `${botMatch.username}-login-failed.png`) }).catch(() => {});
        return false;
    } catch (e) {
        console.error(`[${ctxBotName}][LOGIN]`, e.message);
        await page.screenshot({ path: path.join(__dirname, `${botMatch.username}-login-error.png`) }).catch(() => {});
        return false;
    }
}

async function ensureLoggedIn(page) {
    if (!page || page.isClosed()) return false;

    if (sessionMaxExceeded()) {
        hasLoggedIn = false;
        console.log(`[${ctxBotName}] ⏰ IMVU_SESSION_MAX_MS exceeded — re-authenticating`);
    }

    if (hasLoggedIn) {
        if (await detectStrictLoggedIn(page)) {
            console.log(`[${ctxBotName}] 🔁 Already logged in (memory + DOM OK)`);
            return true;
        }
        if (await detectRelaxedAppLoggedIn(page)) {
            console.log(`[${ctxBotName}] 🔁 Already logged in (memory + relaxed app shell)`);
            return true;
        }
        console.log(`[${ctxBotName}] ⚠️ Session flag set but page looks logged out — re-checking`);
        hasLoggedIn = false;
    }

    await new Promise((r) => setTimeout(r, 2500));
    if (await detectStrictLoggedIn(page)) {
        hasLoggedIn = true;
        console.log(`[${ctxBotName}] ✅ Session valid (cookie reuse)`);
        return true;
    }
    if (await detectRelaxedAppLoggedIn(page)) {
        hasLoggedIn = true;
        console.log(`[${ctxBotName}] ✅ Session valid (cookie reuse, relaxed)`);
        return true;
    }

    console.log(`[${ctxBotName}] 🔐 Performing login...`);
    const ok = await executeLoginFlow(page);
    if (ok) {
        hasLoggedIn = true;
        lastLoginAt = Date.now();
        console.log(`[${ctxBotName}] ✅ Login complete`);
    }
    return ok;
}

async function preparePage(page) {
    await page.bringToFront();
    await page.evaluate(() => {
        window.focus();
        document.body?.focus();
    });
    await page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1280, height: 800 });
}

/**
 * IMVU room preview is a heavy SPA; on datacenter proxies the Join button / user chrome can take 30–60s.
 * Without this, recoverSessionIfNeeded often fires a false "Session expired" while the page is still loading.
 */
async function waitForRoomShellHydrated(page, timeoutMs = 55000) {
    const step = 2500;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!page || page.isClosed()) return false;
        const u = page.url();
        if (u.includes('chrome-error://')) return false;
        if (u.includes('/welcome/') || u.includes('secure.imvu.com/welcome')) return false;

        if (await detectStrictLoggedIn(page)) return true;
        if (await detectRelaxedAppLoggedIn(page)) return true;

        const state = await page.evaluate(() => {
            const href = window.location.href;
            if (!href.includes('/chat/room-')) return { ok: false };
            const b = document.querySelector('button.join-cta');
            if (b && b.getBoundingClientRect().width > 4) return { ok: true, why: 'join-cta' };
            const q = (s) => !!document.querySelector(s);
            if (
                q('textarea.input-text') ||
                q('.uikit-chat-input-textarea') ||
                q('[class*="chat-input"] textarea')
            ) {
                return { ok: true, why: 'chat-input' };
            }
            return { ok: false };
        });
        if (state.ok) {
            console.log(`[${ctxBotName}] ✅ Room shell hydrated (${state.why})`);
            return true;
        }

        await new Promise((r) => setTimeout(r, step));
    }
    return false;
}

async function recoverSessionIfNeeded(page, roomUrl) {
    const uFirst = page.url();
    if (/\/next\/chat\/room-/.test(uFirst)) {
        const grace = parseInt(process.env.IMVU_ROOM_HYDRATE_MS || '55000', 10);
        console.log(`[${ctxBotName}] ⏳ Room page hydrate wait (up to ${grace / 1000}s — slow proxy / SPA)...`);
        if (await waitForRoomShellHydrated(page, grace)) return true;
    }

    if (await detectStrictLoggedIn(page) || (await detectRelaxedAppLoggedIn(page))) return true;

    const u = page.url();
    let guestUi = false;
    try {
        guestUi = (await page.$('.login-link')) != null;
    } catch {
        guestUi = false;
    }

    if (!(u.includes('login') || u.includes('welcome') || guestUi)) {
        await new Promise((r) => setTimeout(r, 8000));
        if (await detectStrictLoggedIn(page) || (await detectRelaxedAppLoggedIn(page))) return true;
    }

    console.log(`[${ctxBotName}] Session expired — re-login`);
    hasLoggedIn = false;
    await page.goto('https://www.imvu.com/next/home/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 3000));
    const ok = await ensureLoggedIn(page);
    if (!ok) return false;

    let stable = await waitForAnyAppSession(page, 40000, 25000);
    if (!stable) {
        console.warn(`[${ctxBotName}] ⚠️ Home session not visible — one recovery retry`);
        hasLoggedIn = false;
        await page.goto('https://www.imvu.com/next/home/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 4000));
        const ok2 = await ensureLoggedIn(page);
        if (!ok2) return false;
        stable = await waitForAnyAppSession(page, 40000, 25000);
    }
    if (!stable) {
        console.error(
            `[${ctxBotName}] ❌ Session never verified on Next home after recovery — skip room (avoid 120s join wait)`
        );
        return false;
    }

    await page.goto(roomUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 12000));
    return true;
}

const clickJoinButton = async (page) => {
    try {
        if (!page || page.isClosed()) return false;

        const joinCtaWaitMs = parseInt(process.env.IMVU_JOIN_CTA_WAIT_MS || '120000', 10);

        await new Promise((r) => setTimeout(r, 8000));

        const alreadyIn = await page.evaluate(() => {
            const q = (s) => !!document.querySelector(s);
            const href = window.location.href;
            const isLobby = href.includes('/chat/') && !href.includes('room-');
            const hasChat =
                q('textarea.input-text') ||
                q('.cs2-chat-messages') ||
                q('[class*="chat-input"] textarea') ||
                q('textarea[placeholder*="Say" i]') ||
                q('.uikit-chat-input-textarea');
            return hasChat && !isLobby;
        });

        if (alreadyIn) {
            console.log(`[${ctxBotName}] ✅ Already inside chat UI — skip join CTA`);
            return true;
        }

        const isValidRoom = await page.evaluate(() => {
            return window.location.href.includes('/chat/room-');
        });

        if (!isValidRoom) {
            console.log(`[${ctxBotName}] ❌ Not in room context. Reloading...`);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await new Promise((r) => setTimeout(r, 8000));
        }

        console.log('[PREVIEW] fetching occupants (DOM)...');
        const previewUsers = await page.evaluate(() => {
            return [
                ...new Set(
                    Array.from(document.querySelectorAll('a[href*="/next/av/"]'))
                        .map((a) => a.href.split('/next/av/')[1]?.split('/')[0])
                        .filter(Boolean)
                ),
            ];
        });
        console.log(`[PREVIEW] 👥 ${previewUsers.length} users (approx, DOM)`);

        console.log(`[${ctxBotName}] 🚪 Waiting for room join CTA (${joinCtaWaitMs / 1000}s)...`);
        const waitForJoinCtaVisible = () =>
            page.waitForFunction(() => {
                const b = document.querySelector('button.join-cta');
                return b && b.getBoundingClientRect().width > 4;
            }, { timeout: joinCtaWaitMs });

        try {
            await waitForJoinCtaVisible();
        } catch (e) {
            console.log(`[${ctxBotName}] ⚠️ Join CTA wait timed out — reloading room once`);
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
            await new Promise((r) => setTimeout(r, 12000));
            try {
                await waitForJoinCtaVisible();
            } catch (e2) {
                console.log(`[${ctxBotName}] ⚠️ Join CTA still missing after reload.`);
            }
        }

        const tryClickJoin = async (attemptLabel) => {
            return page.evaluate((label) => {
                const visible = (el) => {
                    if (!el || el.offsetParent === null) return false;
                    const r = el.getBoundingClientRect();
                    return r.width > 4 && r.height > 4;
                };
                const labelOf = (el) =>
                    (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
                const candidates = Array.from(
                    document.querySelectorAll('button, a[role="button"], [role="button"]')
                ).filter(visible);
                let best = null;
                let bestScore = -1;
                for (const b of candidates) {
                    const lab = labelOf(b);
                    const u = lab.toUpperCase();
                    const aria = (b.getAttribute('aria-label') || '').toUpperCase();
                    const cls = (b.className && String(b.className)) || '';
                    let s = 0;
                    if (u === 'JOIN' || /^JOIN\b/.test(u)) s += 25;
                    else if (/\bJOIN\b/.test(u)) s += 18;
                    if (aria.includes('JOIN')) s += 15;
                    if (cls.includes('join-cta')) s += 6;
                    if (lab.length > 0) s += 4;
                    const r = b.getBoundingClientRect();
                    s += Math.min(12, Math.floor((r.width * r.height) / 8000));
                    if (s > bestScore) {
                        bestScore = s;
                        best = b;
                    }
                }
                let joinBtn = best && bestScore >= 10 ? best : null;
                if (!joinBtn) {
                    const fb = document.querySelector('button.join-cta');
                    if (fb && visible(fb)) joinBtn = fb;
                }
                if (!joinBtn) return { ok: false, reason: 'no-button' };
                joinBtn.scrollIntoView({ block: 'center', inline: 'center' });
                const text = labelOf(joinBtn);
                const ariaLabel = (joinBtn.getAttribute('aria-label') || '').trim();
                const tag = joinBtn.tagName || '';
                const cls = typeof joinBtn.className === 'string' ? joinBtn.className.trim().slice(0, 100) : '';
                joinBtn.click();
                return { ok: true, text, ariaLabel, tag, className: cls, attempt: label };
            }, attemptLabel);
        };

        const waitJoined = (ms) =>
            page
                .waitForFunction(() => {
                    const q = (sel) => !!document.querySelector(sel);
                    const href = window.location.href;
                    const isLobby = href.includes('/chat/') && !href.includes('room-');
                    const hasChat =
                        q('textarea.input-text') ||
                        q('.input-text') ||
                        q('[class*="chat-input"] textarea') ||
                        q('textarea[placeholder*="Say" i]') ||
                        q('.uikit-chat-input-textarea') ||
                        q('.cs2-chat-messages') ||
                        q('[class*="chat-messages"]') ||
                        q('.message-list');
                    return hasChat && !isLobby;
                }, { timeout: ms })
                .then(() => true)
                .catch(() => false);

        console.log(`[${ctxBotName}] 🚪 Attempting to click join...`);

        let clicked = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            const btnInfo = await tryClickJoin(`try-${attempt}`);
            if (btnInfo.ok) {
                clicked = true;
                const primary = (btnInfo.text || btnInfo.ariaLabel || '').trim();
                const fallback = [btnInfo.tag, btnInfo.className].filter(Boolean).join(' ');
                console.log(
                    `[${ctxBotName}] Clicked join CTA (${btnInfo.attempt}): "${primary || '(unlabeled)'}"` +
                        (fallback ? ` [${fallback}]` : '')
                );
                break;
            }
            console.log(`[${ctxBotName}] [JOIN-DEBUG] No join button yet, attempt ${attempt}`);
            await new Promise((r) => setTimeout(r, 5000));
        }

        if (!clicked) {
            console.log(`[${ctxBotName}] ⚠️ Never found a join button`);
            const shot = path.join(
                __dirname,
                `debug-after-join-${String(ctxBotName || 'bot').replace(/[^\w.-]+/g, '_')}.png`
            );
            await page.screenshot({ path: shot }).catch(() => {});
            return false;
        }

        await new Promise((r) => setTimeout(r, 6000));
        let joined = await waitJoined(35000);

        if (!joined) {
            console.log(`[${ctxBotName}] 🚪 Join not detected — second CTA click`);
            await tryClickJoin('retry');
            await new Promise((r) => setTimeout(r, 10000));
            joined = await waitJoined(40000);
        }

        if (!joined) {
            const shot = path.join(
                __dirname,
                `debug-after-join-${String(ctxBotName || 'bot').replace(/[^\w.-]+/g, '_')}.png`
            );
            console.log(`[${ctxBotName}] ⚠️ Join verification failed. Screenshot: ${path.basename(shot)}`);
            await page.screenshot({ path: shot }).catch(() => {});
        }
        return joined;
    } catch (e) {
        console.error(`[JOIN ERROR]`, e.message);
        return false;
    }
};

const activateAvatar = async (page) => {
    try {
        await page.waitForFunction(() => {
            const canvas = document.querySelector('canvas');
            return canvas && canvas.width > 0;
        }, { timeout: 20000 });

        await page.evaluate(() => {
            const canvas = document.querySelector('canvas');
            if (canvas) canvas.click();
        });

        await page.keyboard.press('ArrowUp');
        await page.keyboard.press('ArrowDown');

        console.log(`[${ctxBotName}] ✅ Avatar activated`);
    } catch (e) { }
};

const startJoiner = async (roomIdsStr = '') => {
    const botKey = (process.env.BOT_NAME || process.env.BOT_PROFILE || '').trim();
    if (!botKey) {
        console.error(`[${RUNNER}] Set BOT_NAME (or legacy BOT_PROFILE) before starting room-joiner.`);
        process.exit(1);
    }
    ctxBotName = botKey;
    console.log('RUNNING BOT:', process.env.BOT_NAME, `pid=${process.pid}`);

    startDiscordRelayServer(ctxBotName);

    console.log(`[${ctxBotName}] 📡 Loading bot record from API...`);
    const backendBot = await fetchBotSettings(botKey);

    if (!backendBot || !backendBot.username) {
        console.error(`[${ctxBotName}] ❌ Bot not found or missing username in API response.`);
        process.exit(1);
    }

    console.log(`[${ctxBotName}] ✅ Backend bot record loaded.`);

    botMatch.username = backendBot.username;
    botMatch.password = backendBot.password;

    if (!roomIdsStr && backendBot.room_ids) {
        roomIdsStr = backendBot.room_ids;
    }
    if (!roomIdsStr) {
        console.warn(`[${ctxBotName}] ⚠️ No rooms in argv or backend; using default room id.`);
        roomIdsStr = '242955291-481';
    }

    const roomList = roomIdsStr.split(',').map(id => id.replace(/[^0-9-]/g, '')).filter(Boolean);
    if (roomList.length === 0) {
        console.error(`[${ctxBotName}] ❌ No valid room ids.`);
        process.exit(1);
    }

    const USER_DATA_DIR = path.resolve(__dirname, 'profiles', ctxBotName);
    cleanupProfileLock(USER_DATA_DIR);

    const parsed = parseProxyFromProcessEnv({ fallbackRaw: (backendBot.proxy || '').trim() });
    const chromeProxy = resolveChromeProxy(parsed);
    const launchArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--window-size=1280,800',
        '--disable-web-security',
        '--enable-webgl',
        '--use-gl=angle',
        '--ignore-certificate-errors',
        '--ignore-certificate-errors-spki-list',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-ipc-flooding-protection',
    ];
    if (chromeProxy.arg) {
        launchArgs.push(`--proxy-server=${chromeProxy.arg}`);
    }

    console.log(
        `[${ctxBotName}] BOOT | profileDir=${USER_DATA_DIR} | account=${botMatch.username} | proxy=${parsed.redacted}` +
            (parsed.auth && !chromeProxy.usePageAuthenticate ? ' | proxy-auth=embedded' : '')
    );

    const browser = await puppeteer.launch({
        headless: 'new',
        userDataDir: USER_DATA_DIR,
        ignoreHTTPSErrors: true,
        protocolTimeout: 120000,
        args: launchArgs,
    });

    await wireProxyAuthForBrowser(browser, chromeProxy.usePageAuthenticate ? parsed.auth : null);

    const page1 = (await browser.pages())[0];
    await preparePage(page1);

    await page1.goto('https://www.imvu.com/next/home/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
        console.warn(`[${ctxBotName}] Initial home navigation:`, e.message);
    });
    if (page1.url().includes('chrome-error://')) {
        await new Promise((r) => setTimeout(r, 10000));
        await page1.goto('https://www.imvu.com/next/home/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    }
    if (page1.url().includes('chrome-error://')) {
        console.error(
            `[${ctxBotName}] ❌ Still on chrome-error:// after home retry (proxy or network).`
        );
        await browser.close().catch(() => {});
        process.exit(parsed.serverForChrome ? EXIT_PROXY_ROTATE : 1);
    }

    const loginOk = await ensureLoggedIn(page1);
    if (!loginOk) {
        console.error(`[${ctxBotName}] ❌ Could not establish IMVU session. Exiting.`);
        await browser.close().catch(() => {});
        process.exit(parsed.serverForChrome ? EXIT_PROXY_ROTATE : 1);
    }

    console.log(`[${ctxBotName}] ⏳ Stabilizing session on home before rooms...`);
    for (let s = 0; s < 25; s++) {
        if (await detectStrictLoggedIn(page1) || (await detectRelaxedAppLoggedIn(page1))) break;
        await new Promise((r) => setTimeout(r, 2000));
    }

    const joinOneRoom = async (page, currRoomId) => {
        await preparePage(page);
        const roomUrl = `https://www.imvu.com/next/chat/room-${currRoomId}/`;

        console.log(`[${ctxBotName}] 🚀 Navigating to room: ${currRoomId}`);

        await startUserTracking(page, currRoomId, {
            botName: ctxBotName,
            botUsername: botMatch.username,
            discordChannelId: backendBot.discord_channel_id,
        });

        await page.goto(roomUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
            console.warn(`[${ctxBotName}] Room navigation:`, e.message);
        });

        if (page.url().includes('chrome-error://')) {
            console.log(`[${ctxBotName}] ⚠️ chrome-error:// on room load — waiting 10s, one retry`);
            await new Promise((r) => setTimeout(r, 10000));
            await page.goto(roomUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        }

        await new Promise((r) => setTimeout(r, 8000));

        const recovered = await recoverSessionIfNeeded(page, roomUrl);
        if (!recovered) {
            console.error(`[${ctxBotName}] ❌ Session recovery failed for room ${currRoomId}`);
            return;
        }

        const uAfter = page.url();
        if (uAfter.includes('/next/home') || isNextAppShellUrl(uAfter)) {
            console.log(`[${ctxBotName}] 🔄 On Next home/shell — re-navigating to room: ${currRoomId}`);
            await page.goto(roomUrl, { waitUntil: 'domcontentloaded' });
            await new Promise((r) => setTimeout(r, 8000));
        }

        const joined = await clickJoinButton(page);

        if (joined) {
            console.log(`[${ctxBotName}][${botMatch.username}] 🎉 Successfully joined room!`);
            await activateAvatar(page);

            await new Promise((r) => setTimeout(r, 8000));
            await page.mouse.move(800, 400);
            await page.mouse.move(400, 400);

            const keepAlive = async () => {
                try {
                    if (page.isClosed()) return;
                    await new Promise((r) => setTimeout(r, Math.random() * 2000));
                    await page.mouse.move(400 + Math.random() * 300, 300 + Math.random() * 300).catch(() => {});
                    if (Math.random() > 0.5) {
                        await page.mouse.wheel({ deltaY: (Math.random() > 0.5 ? 1 : -1) * 100 }).catch(() => {});
                    }
                    await page.keyboard.press('Shift').catch(() => {});
                } catch (e) {}
                setTimeout(keepAlive, 15000);
            };
            keepAlive();

            console.log(`[${ctxBotName}][${botMatch.username}] 🟢 Bot is active in room ${currRoomId}.`);
        } else {
            console.log(`[${ctxBotName}] ❌ Join failed for room ${currRoomId}. URL: ${page.url()}`);
        }
    };

    await joinOneRoom(page1, roomList[0]);

    for (let i = 1; i < roomList.length; i++) {
        console.log(`[${ctxBotName}] ⏳ Next room tab in 25s (spacing tab loads)...`);
        await new Promise((r) => setTimeout(r, 25000));
        const newPage = await browser.newPage();
        if (chromeProxy.usePageAuthenticate && parsed.auth) await applyProxyAuthToPage(newPage, parsed.auth);
        await joinOneRoom(newPage, roomList[i]);
    }
};

const targetRoom = process.argv[2] || '';
startJoiner(targetRoom).catch((err) => {
    console.error(`[${ctxBotName}] Fatal Error in startJoiner:`, err);
    process.exit(1);
});
