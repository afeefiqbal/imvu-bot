/**
 * DOM + session snapshot for IMVU Next (same profile/proxy pattern as room-joiner).
 * Usage:
 *   BOT_NAME=Bot-Alpha node dom-debug.js
 *   BOT_NAME=Bot-Alpha node dom-debug.js "https://www.imvu.com/next/chat/room-163042598-3671/"
 *   HEADLESS=false BOT_NAME=Bot-Alpha node dom-debug.js   # see the browser
 *   DOM_DEBUG_COPY_PROFILE=1 BOT_NAME=Bot-Alpha node dom-debug.js   # copy profile (room-joiner may stay running)
 */
import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { parseProxyFromProcessEnv, resolveChromeProxy } from './proxy-env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const API_BASE = process.env.APP_URL || 'http://localhost:8000';

async function applyProxyAuthToPage(page, auth) {
    if (!page?.isClosed?.() && auth) await page.authenticate({ username: auth.username, password: auth.password || '' });
}

async function wireProxyAuthForBrowser(browser, auth) {
    if (!auth) return;
    const hook = async (pg) => {
        try {
            await applyProxyAuthToPage(pg, auth);
        } catch {}
    };
    browser.on('targetcreated', async (target) => {
        const pg = await target.page();
        if (pg) await hook(pg);
    });
    for (const pg of await browser.pages()) await hook(pg);
}

function cleanupLock(profileDir) {
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        try {
            const p = path.join(profileDir, name);
            if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch {}
    }
}

async function main() {
    const botName = (process.env.BOT_NAME || 'Bot-Alpha').trim();
    const targetUrl = process.argv[2] || 'https://www.imvu.com/next/home/';
    const headless = String(process.env.HEADLESS || 'true').toLowerCase() !== 'false';

    let fallbackProxy = (process.env.BOT_PROXY || '').trim();
    try {
        const { data } = await axios.get(`${API_BASE}/api/bots/${encodeURIComponent(botName)}`, { timeout: 15000 });
        if (data?.proxy && String(data.proxy).trim()) fallbackProxy = String(data.proxy).trim();
        console.log('[DOM-DEBUG] API bot:', botName, '| username:', data?.username || '(n/a)');
    } catch (e) {
        console.warn('[DOM-DEBUG] API fetch skipped:', e.message);
    }

    const parsed = parseProxyFromProcessEnv({ fallbackRaw: fallbackProxy });
    const chromeProxy = resolveChromeProxy(parsed);
    const canonicalProfile = path.resolve(__dirname, 'profiles', botName);
    let profileDir = canonicalProfile;
    let tmpProfileRoot = null;
    if (String(process.env.DOM_DEBUG_COPY_PROFILE || '').toLowerCase() === '1' || process.env.DOM_DEBUG_COPY_PROFILE === 'true') {
        tmpProfileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'imvu-dom-debug-'));
        profileDir = path.join(tmpProfileRoot, 'chrome-profile');
        console.log('[DOM-DEBUG] copying profile →', profileDir, '(so a running bot can keep the original locked)');
        fs.cpSync(canonicalProfile, profileDir, { recursive: true });
        cleanupLock(profileDir);
    } else {
        cleanupLock(profileDir);
    }

    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--window-size=1280,900',
        '--disable-features=IsolateOrigins,site-per-process',
    ];
    if (chromeProxy.arg) args.push(`--proxy-server=${chromeProxy.arg}`);

    console.log('[DOM-DEBUG] profileDir=', profileDir);
    console.log('[DOM-DEBUG] proxy=', parsed.redacted);
    console.log('[DOM-DEBUG] url=', targetUrl);
    console.log('[DOM-DEBUG] headless=', headless);

    let executablePath =
        process.env.PUPPETEER_EXECUTABLE_PATH ||
        process.env.CHROME_PATH ||
        (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '');
    if (executablePath && !fs.existsSync(executablePath)) executablePath = '';
    if (executablePath) console.log('[DOM-DEBUG] executablePath=', executablePath);

    const browser = await puppeteer.launch({
        ...(executablePath ? { executablePath } : {}),
        headless: headless ? 'new' : false,
        userDataDir: profileDir,
        ignoreHTTPSErrors: true,
        protocolTimeout: 120000,
        args,
    });
    await wireProxyAuthForBrowser(browser, chromeProxy.usePageAuthenticate ? parsed.auth : null);

    const page = (await browser.pages())[0];
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch((e) =>
        console.warn('[DOM-DEBUG] goto:', e.message)
    );

    const settle = parseInt(process.env.DOM_DEBUG_SETTLE_MS || '10000', 10);
    console.log('[DOM-DEBUG] settling', settle, 'ms…');
    await new Promise((r) => setTimeout(r, settle));

    const report = await page.evaluate(() => {
        const href = window.location.href;
        const title = document.title || '';
        const pick = (sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
            return { tag: el.tagName, class: (el.className && String(el.className).slice(0, 80)) || '', text: t };
        };
        const count = (sel) => document.querySelectorAll(sel).length;
        const buttonsSample = Array.from(document.querySelectorAll('button'))
            .slice(0, 25)
            .map((b) => ({
                cls: (b.className && String(b.className).slice(0, 60)) || '',
                text: (b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40),
            }));

        const labelGuest = (el) => {
            const raw = (el.innerText || el.textContent || el.getAttribute('aria-label') || '')
                .replace(/\s+/g, ' ')
                .trim();
            const u = raw.toUpperCase();
            return u === 'LOG IN' || u === 'LOGIN' || u === 'SIGN IN' || /\bLOG\s+IN\b/i.test(raw);
        };
        const guestClickable = Array.from(document.querySelectorAll('a, button, [role="button"]')).some(labelGuest);

        return {
            href,
            title,
            joinCta: pick('button.join-cta'),
            joinCtaCount: count('button.join-cta'),
            userMenu: pick('.user-menu'),
            avatarName: pick('.avatar-name'),
            loginLink: count('a.login-link, .login-link'),
            textareaChat: count('textarea.input-text, .uikit-chat-input-textarea, [class*="chat-input"] textarea'),
            canvas: count('canvas'),
            bodyTextLen: (document.body?.innerText || '').length,
            guestClickableHint: guestClickable,
            buttonsSample,
        };
    });

    console.log('\n========== DOM-DEBUG REPORT ==========');
    console.log(JSON.stringify(report, null, 2));
    console.log('========================================\n');

    const safeName = botName.replace(/[^\w.-]+/g, '_');
    const shot = path.join(__dirname, `dom-debug-${safeName}.png`);
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    console.log('[DOM-DEBUG] screenshot:', shot);

    const htmlPath = path.join(__dirname, `dom-debug-${safeName}.html`);
    const html = await page.content().catch(() => '');
    if (html) {
        fs.writeFileSync(htmlPath, html, 'utf8');
        console.log('[DOM-DEBUG] saved HTML:', htmlPath, `(${html.length} chars)`);
    }

    await browser.close().catch(() => {});
    if (tmpProfileRoot) {
        try {
            fs.rmSync(tmpProfileRoot, { recursive: true, force: true });
            console.log('[DOM-DEBUG] removed temp profile copy');
        } catch {}
    }
    console.log('[DOM-DEBUG] done.');
}

main().catch((e) => {
    console.error('[DOM-DEBUG] fatal:', e);
    process.exit(1);
});
