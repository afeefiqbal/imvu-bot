import puppeteer from 'puppeteer';
import axios from 'axios';
import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { startUserTracking } from './user-tracker.js';
import { backendApiBaseUrl } from './env-app-url.js';
import { parseProxyFromProcessEnv, resolveChromeProxy, proxyConfigured } from './proxy-env.js';
import { cleanupChromeProfileSingletonLocks, CHROME_EXTRA_SAFE_PROFILE_ARGS } from './chrome-profile-lock.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

if (!global.discordBridge) {
    global.discordBridge = new EventEmitter();
}
global.discordBridge.setMaxListeners(0);

/** Same as room-joiner: discord-server POSTs here so messages reach this Node process. */
function startDiscordRelayForBot(botLabel) {
    const portRaw = (process.env.IMVU_DISCORD_RELAY_PORT || '').trim();
    if (!portRaw) {
        console.log(
            `[${botLabel}] IMVU_DISCORD_RELAY_PORT unset — Discord→IMVU relay off (multi-launcher sets this per bot)`
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
        } catch {
            res.status(500).json({ ok: false });
        }
    });
    const srv = app.listen(port, '127.0.0.1', () => {
        console.log(`[${botLabel}] Discord→IMVU relay on http://127.0.0.1:${port}/discord-relay`);
    });
    srv.on('error', (e) => {
        console.error(`[${botLabel}] Discord relay :${port} — ${e.message}`);
    });
    return srv;
}

function trackerRoomId(raw) {
    const s = String(raw ?? '').trim();
    const m = s.match(/room-([\d-]+)/i);
    if (m) return m[1];
    const m2 = s.match(/(\d+-\d+)/);
    return m2 ? m2[1] : s.replace(/[^\d-]/g, '') || s;
}

/** multi-launcher picks a new proxy when child exits with this code (pool/Webshare). */
const EXIT_PROXY_ROTATE = 2;

function isHealthyImvuRoomUrl(u) {
    if (!u || typeof u !== 'string') return false;
    if (u.startsWith('chrome-error://')) return false;
    return u.includes('imvu.com/next/chat') && u.includes('room-');
}

function listHealthyImvuRoomPages(pages) {
    return pages.filter((p) => {
        try {
            return isHealthyImvuRoomUrl(p.url());
        } catch {
            return false;
        }
    });
}

function proxyTunnelFailed(message) {
    return /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_NO_SUPPORTED_PROXIES/i.test(
        String(message || '')
    );
}

/**
 * Node HTTPS via HTTP CONNECT — mirrors what Chrome needs. Fails fast before launching the browser.
 * IMVU_SKIP_PROXY_PREFLIGHT=1 to skip.
 */
async function proxyHttpsPreflight(parsed) {
    if (process.env.IMVU_SKIP_PROXY_PREFLIGHT === '1' || process.env.IMVU_SKIP_PROXY_PREFLIGHT === 'true') {
        return true;
    }
    if (!proxyConfigured(parsed)) return true;
    const withProto = parsed.serverForChrome.includes('://')
        ? parsed.serverForChrome
        : `http://${parsed.serverForChrome}`;
    let u;
    try {
        u = new URL(withProto);
    } catch {
        return true;
    }
    if (!u.hostname) return true;
    const port = parseInt(u.port || '80', 10);
    const proxy = { protocol: 'http', host: u.hostname, port };
    if (parsed.auth?.username) {
        proxy.auth = { username: parsed.auth.username, password: parsed.auth.password || '' };
    }
    try {
        await axios.get('https://www.imvu.com/', {
            timeout: 22000,
            proxy,
            validateStatus: () => true,
            maxRedirects: 5,
        });
        return true;
    } catch (e) {
        console.warn(`[proxy-preflight] ${e.message}`);
        return false;
    }
}

const BACKEND_URL = backendApiBaseUrl('http://127.0.0.1:8000');

/** IMVU “Join room” CTA — wait + click instead of racing evaluate(). */
const JOIN_ROOM_BTN_SELECTOR = 'button.cs2-btn-primary, button[class*="join"], .btn-join';
const MAX_ROOM_TABS = Math.max(1, parseInt(process.env.IMVU_MAX_TABS || '20', 10));

/**
 * Serialized into the page for `page.evaluate(roomJoinScrapeForPage)`.
 * Must not close over Node scope. In-page DOM errors become `error: 'IN_PAGE_EVAL'`
 * so Puppeteer does not throw for ordinary selector misses during hydration.
 */
function roomJoinScrapeForPage() {
    try {
        const bodyText = document.body?.innerText ?? '';
        const joinBtn = document.querySelector(
            'button.cs2-btn-primary, button[class*="join"], .btn-join'
        );
        const chatInput = document.querySelector(
            'textarea.input-text, .input-text, [class*="chat-input"]'
        );
        const chatMessages = document.querySelector(
            '.cs2-chat-messages, .message-list, .chat-messages'
        );
        const roomActions = document.querySelector('.cs2-top-actions, .room-menu');

        let error = null;
        if (bodyText.includes('Room is full')) error = 'ROOM_FULL';
        else if (bodyText.includes('Access Denied')) error = 'ACCESS_DENIED';
        else if (bodyText.includes('Please log in')) error = 'LOGGED_OUT';

        const isPhysicallyInside = (!!chatMessages || !!roomActions) && !joinBtn;
        const representsJoined = isPhysicallyInside || (!!chatInput && !joinBtn);

        return {
            hasJoinBtn: !!joinBtn && joinBtn.offsetWidth > 0,
            isJoined: representsJoined,
            error,
        };
    } catch (e) {
        return {
            hasJoinBtn: false,
            isJoined: false,
            error: 'IN_PAGE_EVAL',
            detail: String(e && e.message ? e.message : e),
        };
    }
}

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
            console.warn(`[imvu-bot] proxy authenticate:`, e.message);
        }
    };
    browser.on('targetcreated', async (target) => {
        const pg = await target.page();
        if (pg) await hook(pg);
    });
    for (const pg of await browser.pages()) await hook(pg);
}

(async () => {
    try {
        const BOT_NAME = (process.env.BOT_NAME || '').trim();
        if (!BOT_NAME) {
            console.error('imvu-bot: BOT_NAME is required');
            process.exit(1);
        }
        console.log('RUNNING BOT:', process.env.BOT_NAME);

        if (!/^(1|true|yes|on)$/i.test(String(process.env.IMVU_LAUNCHED_FROM_MULTI_LAUNCHER || '').trim())) {
            const { maybeStartMusicIngressTunnel } = await import('./music/tunnelIngress.js');
            await maybeStartMusicIngressTunnel();
        }

        const USER_DATA_DIR = path.resolve(__dirname, 'profiles', BOT_NAME);
        cleanupChromeProfileSingletonLocks(USER_DATA_DIR, BOT_NAME);
        const parsed = parseProxyFromProcessEnv();
        const chromeProxy = resolveChromeProxy(parsed);

        const credRes = await axios.get(`${BACKEND_URL}/api/bots/${encodeURIComponent(BOT_NAME)}`);
        if (!credRes.data?.username) {
            throw new Error(`Bot not found: ${BOT_NAME}`);
        }
        /** No password / no login here — session must exist in this profile (e.g. room-joiner logged in once). */
        const botMatch = {
            username: credRes.data.username,
            profile: credRes.data.profile || credRes.data.name || BOT_NAME,
            discordChannelId: credRes.data.discord_channel_id || null,
        };

        console.log(
            `[${BOT_NAME}] BOOT | profileDir=${USER_DATA_DIR} | account=${botMatch.username} | proxy=${parsed.redacted}` +
                (parsed.auth && !chromeProxy.usePageAuthenticate ? ' | proxy-auth=embedded' : '') +
                ` | login=room-joiner only`
        );
        if (!process.env.DISCORD_BOT_API_URL) {
            console.warn(
                `[${BOT_NAME}] DISCORD_BOT_API_URL unset — no Discord mirror/init (set e.g. http://127.0.0.1:3000/api/imvu-chat)`
            );
        }

        if (proxyConfigured(parsed)) {
            const tunnelOk = await proxyHttpsPreflight(parsed);
            if (!tunnelOk) {
                console.error(
                    `[${BOT_NAME}] Proxy HTTPS tunnel test failed before Chrome (Node CONNECT). ` +
                        `Check with curl using the same host:port and proxy auth as BOT_PROXY_HOST / BOT_PROXY_USER (or a single BOT_PROXY URL). ` +
                        `If that fails, the proxy cannot tunnel HTTPS — not a Puppeteer-only bug. ` +
                        `For IMVU chat prefer sticky residential/ISP proxies; datacenter IPs often break WSS. ` +
                        `Webshare: try WEBSHARE_PROXY_MODE=backbone. Exiting ${EXIT_PROXY_ROTATE} for launcher rotation.`
                );
                process.exit(EXIT_PROXY_ROTATE);
            }
        }

        const launchArgs = [
            ...CHROME_EXTRA_SAFE_PROFILE_ARGS,
            '--start-maximized',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
        ];
        if (chromeProxy.arg) {
            launchArgs.push(`--proxy-server=${chromeProxy.arg}`);
        }

        let executablePath = (process.env.PUPPETEER_EXECUTABLE_PATH || '').trim();
        if (executablePath && !fs.existsSync(executablePath)) {
            executablePath = '';
        }
        if (!executablePath && process.platform === 'darwin') {
            const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
            if (fs.existsSync(macChrome)) {
                executablePath = macChrome;
            }
        }

        cleanupChromeProfileSingletonLocks(USER_DATA_DIR, BOT_NAME);

        const browser = await puppeteer.launch({
            headless: 'new',
            ...(executablePath ? { executablePath } : {}),
            userDataDir: USER_DATA_DIR,
            args: launchArgs,
            defaultViewport: null,
        });

        await wireProxyAuthForBrowser(browser, chromeProxy.usePageAuthenticate ? parsed.auth : null);

        startDiscordRelayForBot(BOT_NAME);

        const pages = await browser.pages();
        const page = pages.length > 0 ? pages[0] : await browser.newPage();
        if (chromeProxy.usePageAuthenticate && parsed.auth) await applyProxyAuthToPage(page, parsed.auth);
        
        console.log(`[${BOT_NAME}] Fetching target rooms for bot from dashboard...`);
        let initialRooms = [];
        try {
            const res = await axios.post(`${BACKEND_URL}/api/rooms/sync`, { rooms: [], bot_name: BOT_NAME, bot_username: botMatch.username });
            if (res.data && res.data.target_rooms) {
                initialRooms = res.data.target_rooms;
            }
        } catch (e) {
            console.error(`[${BOT_NAME}] Failed to fetch initial rooms.`);
        }

        const firstRoom = initialRooms.length > 0 ? initialRooms[0] : '255338726-5';
        const initialRoomId = trackerRoomId(firstRoom);

        console.log(`[${BOT_NAME}] Using account (API): ${botMatch.username}`);
        console.log(`[${BOT_NAME}] Opening room (session from profile only — run room-joiner if guest): ${initialRoomId}`);
        let firstNavOk = false;
        try {
            await page.goto(`https://www.imvu.com/next/chat/room-${initialRoomId}/`, {
                waitUntil: 'domcontentloaded',
                timeout: 60000,
            });
            if (page.url().startsWith('chrome-error://')) {
                throw new Error(`chrome-error after navigation: ${page.url()}`);
            }
            firstNavOk = true;
        } catch (e) {
            console.error(`[${BOT_NAME}] ❌ First room navigation failed: ${e.message}`);
            if (parsed.serverForChrome && proxyTunnelFailed(e.message)) {
                console.error(
                    `[${BOT_NAME}] Proxy CONNECT tunnel failed — exiting ${EXIT_PROXY_ROTATE} so multi-launcher can rotate proxy`
                );
                process.exit(EXIT_PROXY_ROTATE);
            }
            process.exit(1);
        }

        await startUserTracking(page, initialRoomId, {
            botName: BOT_NAME,
            botUsername: botMatch.username,
            discordChannelId: botMatch.discordChannelId,
        });
        await new Promise(r => setTimeout(r, 5000));
        await page.screenshot({ path: path.join(__dirname, 'debug-bot.png') });

        const guestLink = await page.$('.login-link');
        const profileLooksGuest = !!guestLink;
        if (guestLink) {
            console.error(
                `[${BOT_NAME}] SESSION NOT READY: guest UI (.login-link). imvu-bot does not log in.\n` +
                    `  Run once per bot (saves cookies): BOT_NAME=${BOT_NAME} node room-joiner.js "<room-ids>"\n` +
                    `  Profile dir: profiles/${BOT_NAME}/ — then restart this process.\n` +
                    `  On Railway/Docker: mount a persistent volume on that profile path, or cookies are lost every deploy.`
            );
        }

        // --- Join if still on preview (same profile should already be logged in) ---
        console.log(`[${BOT_NAME}] Checking for Join button...`);
        const initialJoinScrape = await page.evaluate(roomJoinScrapeForPage).catch((e) => {
            console.warn(`[${BOT_NAME}] Join check scrape failed: ${e.message}`);
            return null;
        });
        if (initialJoinScrape?.error && ['ROOM_FULL', 'ACCESS_DENIED', 'LOGGED_OUT'].includes(initialJoinScrape.error)) {
            console.log(`[${BOT_NAME}] Room issue before join: ${initialJoinScrape.error}`);
        }
        const shouldClickInitialJoin =
            initialJoinScrape &&
            initialJoinScrape.hasJoinBtn &&
            !initialJoinScrape.isJoined &&
            !initialJoinScrape.error;
        if (shouldClickInitialJoin) {
            try {
                await page.waitForSelector(JOIN_ROOM_BTN_SELECTOR, { timeout: 30000, visible: true });
                await page.click(JOIN_ROOM_BTN_SELECTOR).catch(() => null);
                console.log(`[${BOT_NAME}] Join click sent (waitForSelector + click).`);
                await new Promise((r) => setTimeout(r, 8000));
            } catch {
                console.log(`[${BOT_NAME}] Join click path failed after visible join button.`);
            }
        } else if (initialJoinScrape == null) {
            try {
                await page.waitForSelector(JOIN_ROOM_BTN_SELECTOR, { timeout: 20000, visible: true });
                await page.click(JOIN_ROOM_BTN_SELECTOR).catch(() => null);
                console.log(`[${BOT_NAME}] Join click sent (fallback after scrape unavailable).`);
                await new Promise((r) => setTimeout(r, 8000));
            } catch {
                console.log(`[${BOT_NAME}] Already in room or no join button (scrape unavailable).`);
            }
        } else {
            console.log(
                `[${BOT_NAME}] Skipping initial join click (inside room, loading, or no CTA — joined=${Boolean(initialJoinScrape?.isJoined)} btn=${Boolean(initialJoinScrape?.hasJoinBtn)} err=${initialJoinScrape?.error || 'none'}).`
            );
        }

        let lastSyncHash = "";
        let isFirstSync = true;
        const targetRooms = new Set(); // Using GLOBAL Set
        const joiningRooms = new Set();
        const tabStates = new Map(); // Global tracking for each roomId
        /** Throttle noisy evaluate failures per room (navigation / detached frame). */
        const roomEvalFailLastLogMs = new Map();
        const processedGlobal = new Set();
        const lastSentGlobal = new Map();
        let lastGuestDomSkipLog = 0;

        // --- HUMAN-LIKE ENGAGEMENT ---
        const personalities = [
            ["Hey everyone! 👋", "This room is pretty cool.", "How's everyone doing today?"],
            ["Yo 😎", "What's up", "Cool place", "Nice vibes here."],
            ["Hello!", "Anyone here?", "Nice outfits", "Just hanging out."]
        ];
        const spamLibrary = personalities[Math.floor(Math.random() * personalities.length)];
        
        let activeFilamentSpamRooms = [];
        let activeFilamentMutedRooms = [];
        let isGlobalAiEnabled = true;
        const roomClosingTimers = new Map(); // roomId -> timestamp to close
        
        let isSyncing = false;
        // --- DASHBOARD SYNC & CONTROL ---
        setInterval(async () => {
            if (isSyncing) return;
            isSyncing = true;
            try {
                const allPages = await browser.pages();
                for (const p of allPages) {
                    try {
                        if (p.url().startsWith('chrome-error://')) await p.close().catch(() => null);
                    } catch {}
                }
                const imvuPages = listHealthyImvuRoomPages(await browser.pages());
                const roomsToSync = [];
                
                console.log(`[${BOT_NAME}] Sync: Detected ${imvuPages.length} active IMVU room pages.`);

                for (const p of imvuPages) {
                    const match = p.url().match(/room-([\d\-]+)/);
                    const roomId = match ? match[1] : null;
                    if (!roomId) continue;

                    const data = await p.evaluate(() => {
                        let roomName = document.title.replace('IMVU Next - Chat - ', '').trim();
                        const nameEl = document.querySelector('.room-info-name') || document.querySelector('.room-name');
                        if (nameEl) roomName = nameEl.innerText.trim();

                        const imgEl = document.querySelector('.room-img img') || document.querySelector('.room-poster img');
                        let roomUrl = imgEl ? imgEl.src : '';

                        const avatarLinks = document.querySelectorAll('a[href*="/next/av/"]');
                        let visitors = [];
                        if (avatarLinks.length > 0) {
                            visitors = Array.from(new Set(Array.from(avatarLinks).map(a => {
                                const m = a.getAttribute('href').match(/\/next\/av\/([^\/]+)/);
                                return m ? decodeURIComponent(m[1]).trim().toLowerCase() : null;
                            }).filter(n => n)));
                        } else {
                            const nameEls = document.querySelectorAll('.avatar-name, .username');
                            visitors = Array.from(new Set(Array.from(nameEls).map(el => el.innerText.trim().toLowerCase())));
                        }
                        
                        // Scrape population index
                        let popEl = document.querySelector('.icon-group + span') || document.querySelector('.population');
                        let pop = popEl ? parseInt(popEl.innerText) : visitors.length;

                        return { roomName, roomUrl, visitors: visitors.slice(0, 50), population: pop };
                    }).catch(() => null);

                    if (data) {
                        const rn = String(data.roomName || '').trim();
                        if (/^www\.imvu\.com$/i.test(rn)) {
                            console.warn(
                                `[${BOT_NAME}] Skipping dashboard sync for room ${roomId} — error/placeholder title "${rn}" (proxy or load failure)`
                            );
                        } else {
                            roomsToSync.push({
                                id: String(roomId).trim(),
                                name: data.roomName,
                                image_url: data.roomUrl,
                                visitors: data.visitors,
                                population: data.population || 0,
                            });
                        }
                    }
                }
                
                const currentHash = JSON.stringify(roomsToSync);
                // We ALWAYS fetch if it's the first sync, OR if data changed, OR even if it's quiet just to get targets
                let resultData = null;
                
                if (currentHash !== lastSyncHash || isFirstSync) {
                    console.log(`[${BOT_NAME}] Sync: Updating dashboard with ${roomsToSync.length} rooms.`);
                    const res = await axios.post(`${BACKEND_URL}/api/rooms/sync`, { rooms: roomsToSync, bot_name: BOT_NAME, bot_username: botMatch.username });
                    resultData = res.data;
                    lastSyncHash = currentHash;
                    isFirstSync = false;
                } else {
                    // Just heartbeat to get targets without sending full room data
                    try {
                        const res = await axios.post(`${BACKEND_URL}/api/rooms/sync`, { rooms: [], bot_name: BOT_NAME, bot_username: botMatch.username, heartbeat_only: true });
                        resultData = res.data;
                    } catch (e) { /* ignore */ }
                }

                if (resultData) {
                    const res = { data: resultData }; 
                    activeFilamentSpamRooms = res.data.spam_targets || [];
                    activeFilamentMutedRooms = res.data.muted_rooms || [];
                    isGlobalAiEnabled = res.data.global_ai_enabled !== false;
                    
                    // Update GLOBAL targetRooms set
                    if (res.data.target_rooms) {
                        targetRooms.clear();
                        res.data.target_rooms.forEach(tr => {
                            const cid = tr.toString().trim().replace(/\/$/, '');
                            targetRooms.add(cid);
                        });
                        console.log(`[${BOT_NAME}] Current Targets from Dashboard: ${Array.from(targetRooms).join(', ')}`);
                    }

                    // Background Room Management
                    (async () => {
                        const currentTargets = Array.from(targetRooms);
                        const imvuPages = listHealthyImvuRoomPages(await browser.pages());
                        
                        // 1. Join new global target rooms
                        for (const tRoom of currentTargets) {
                            const normalized = trackerRoomId(tRoom);
                            const isAlreadyOpen = imvuPages.some((pg) => {
                                const m = pg.url().match(/room-([\d-]+)/);
                                return m && m[1] === normalized;
                            });
                            
                            if (isAlreadyOpen) {
                                // console.log(`[${BOT_NAME}] Room ${normalized} already open in a tab.`);
                                continue;
                            }
                            
                            if (joiningRooms.has(normalized)) {
                                console.log(`[${BOT_NAME}] Still waiting for Room ${normalized} to finish opening...`);
                                continue;
                            }

                            if (imvuPages.length >= MAX_ROOM_TABS) {
                                console.log(
                                    `[${BOT_NAME}] MAX TABS HIT (${MAX_ROOM_TABS}) — skipping new room. Raise IMVU_MAX_TABS if needed.`
                                );
                                continue;
                            }

                            joiningRooms.add(normalized);
                            console.log(`[${BOT_NAME}] 🆕 JOIN COMMAND: Opening new tab for Room ${normalized}`);
                            const roomUrl = `https://www.imvu.com/next/chat/room-${normalized}/`;
                            let newPage = null;
                            try {
                                newPage = await browser.newPage();
                                if (chromeProxy.usePageAuthenticate && parsed.auth) {
                                    await applyProxyAuthToPage(newPage, parsed.auth);
                                }
                                await newPage.goto(roomUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
                                if (newPage.url().startsWith('chrome-error://')) {
                                    throw new Error(`chrome-error after navigation: ${newPage.url()}`);
                                }
                                await startUserTracking(newPage, trackerRoomId(normalized), {
                                    botName: BOT_NAME,
                                    botUsername: botMatch.username,
                                    discordChannelId: botMatch.discordChannelId,
                                });
                            } catch (err) {
                                console.error(`[${BOT_NAME}] ❌ FAILED to open Room ${normalized}: ${err.message}`);
                                if (newPage && !newPage.isClosed()) {
                                    await newPage.close().catch(() => null);
                                }
                                if (parsed.serverForChrome && proxyTunnelFailed(err.message)) {
                                    console.error(
                                        `[${BOT_NAME}] Proxy CONNECT tunnel failed — exiting ${EXIT_PROXY_ROTATE} so multi-launcher can rotate proxy`
                                    );
                                    process.exit(EXIT_PROXY_ROTATE);
                                }
                            } finally {
                                setTimeout(() => joiningRooms.delete(normalized), 10000);
                            }
                        }

                        // 2. Leave rooms not targeted (with 60s Grace Period)
                        const now = Date.now();
                        for (const p of imvuPages) {
                            const rmMatch = p.url().match(/room-([\d\-]+)/);
                            if (rmMatch) {
                                const id = rmMatch[1];
                                if (!currentTargets.includes(id)) {
                                    if (!roomClosingTimers.has(id)) {
                                        console.log(`[${BOT_NAME}] Room ${id} scheduled for removal in 60s...`);
                                        roomClosingTimers.set(id, now + 60000);
                                    } else if (now > roomClosingTimers.get(id)) {
                                        console.log(`[${BOT_NAME}] Grace period expired. Closing tab for ${id}.`);
                                        await p.close().catch(() => null);
                                        roomClosingTimers.delete(id);
                                    }
                                } else {
                                    roomClosingTimers.delete(id);
                                }
                            }
                        }
                    })().catch(() => null);

                    // Handle Pending Messages (from Dashboard)
                    if (res.data.pending_messages) {
                        for (const msg of res.data.pending_messages) {
                            const targetPg = imvuPages.find(pg => pg.url().includes('room-' + msg.room_id));
                            if (targetPg) {
                                console.log(`[Dashboard] Sending Message to Room ${msg.room_id}: ${msg.pending_message}`);
                                const delay = 3000 + Math.random() * 7000;
                                await new Promise(r => setTimeout(r, delay));
                                await say(targetPg, msg.pending_message);
                            }
                        }
                    }
                }
                
                // --- DEBUG: Save screenshot every interval to see what the bot sees ---
                if (imvuPages.length > 0) {
                    await imvuPages[0].screenshot({ path: path.join(__dirname, `${botMatch.username}-status.png`) }).catch(() => null);
                }

            } catch (e) { /* ignore */ }
            finally {
                isSyncing = false;
            }
        }, 25000 + Math.random() * 10000); // 25-35s sync interval (much safer)

        // --- PERIODIC ENGAGEMENT ---
        setInterval(async () => {
            const allPages = await browser.pages();
            const imvuPages = allPages.filter(
                (p) => p.url().includes('imvu.com/next/chat') && !p.url().startsWith('chrome-error://')
            );

            for (const p of imvuPages) {
                const u = p.url();
                const match = u.match(/room-([\d\-]+)/);
                const roomId = match ? match[1] : null;

                const spamOn = activeFilamentSpamRooms.some((r) => String(r).trim() === String(roomId).trim());
                if (roomId && spamOn) {
                    await new Promise(r => setTimeout(r, 2000 + Math.random() * 5000));
                    
                    const massiveMsg = spamLibrary[Math.floor(Math.random() * spamLibrary.length)];
                    console.log(`[ENGAGEMENT] Room ${roomId} | Choosing fragment...`);
                    const delay = 3000 + Math.random() * 7000;
                    await new Promise(r => setTimeout(r, delay));
                    await say(p, massiveMsg);
                }
            }
        }, 45000 + Math.random() * 50000); // 45-95s interval

        let isListening = false;
        // --- CHAT LISTENER ---
        setInterval(async () => {
            if (isListening) return;
            isListening = true;
            try {
                if (profileLooksGuest) {
                    const now = Date.now();
                    if (now - lastGuestDomSkipLog > 120000) {
                        lastGuestDomSkipLog = now;
                        console.warn(
                            `[${BOT_NAME}] DOM join/chat loop idle — boot saw guest UI. CDP may still run; seed profile once and persist profiles/${BOT_NAME}/ (volume on Railway).`
                        );
                    }
                    return;
                }

                const allPages = await browser.pages();
                const imvuPages = allPages.filter(
                    (p) => p.url().includes('imvu.com/next/chat') && !p.url().startsWith('chrome-error://')
                );

                for (const p of imvuPages) {
                    const match = p.url().match(/room-([\d\-]+)/);
                    const roomId = match ? match[1] : null;
                    if (!roomId) continue;

                    if (!tabStates.has(roomId)) {
                        tabStates.set(roomId, { 
                            lastMessage: null, 
                            lastSentMessage: null,
                            creationTime: Date.now(),
                            isJoined: false,
                            joinAttemptTime: 0,
                            isInitialLoad: true
                        });
                    }
                    const state = tabStates.get(roomId);

                    const pageState = await p.evaluate(roomJoinScrapeForPage).catch((e) => {
                        const now = Date.now();
                        const last = roomEvalFailLastLogMs.get(roomId) || 0;
                        if (now - last > 60000) {
                            console.warn(
                                `[${BOT_NAME}][Room:${roomId}] Room scrape failed (navigation/target): ${e.message}`
                            );
                            roomEvalFailLastLogMs.set(roomId, now);
                        }
                        return { hasJoinBtn: false, isJoined: false, error: 'EVAL_FAIL' };
                    });

                    if (pageState.error && ['ROOM_FULL', 'ACCESS_DENIED', 'LOGGED_OUT'].includes(pageState.error)) {
                        console.log(`[${BOT_NAME}][Room:${roomId}] Room Blocker: ${pageState.error}`);
                        if (pageState.error === 'LOGGED_OUT') {
                            console.log(
                                `[${BOT_NAME}] Session expired on tab — restart room-joiner for this bot to refresh cookies.`
                            );
                        }
                    } else if (pageState.error === 'IN_PAGE_EVAL' && pageState.detail) {
                        const now = Date.now();
                        const k = `${roomId}:inpage`;
                        const last = roomEvalFailLastLogMs.get(k) || 0;
                        if (now - last > 120000) {
                            console.warn(
                                `[${BOT_NAME}][Room:${roomId}] Room scrape (in-page): ${pageState.detail}`
                            );
                            roomEvalFailLastLogMs.set(k, now);
                        }
                    }

                    // Wake up the tab only if we REALLY need to (skip if we already treat this tab as joined).
                    if (!pageState.isJoined && !state.isJoined) {
                        const title = await p.title().catch(() => "Unknown");
                        console.log(`[${BOT_NAME}][Room:${roomId}] Tab is not joined. Wake up assessment...`);
                        await p.bringToFront().catch(() => null);
                        await new Promise(r => setTimeout(r, 2000)); // wait for wake-up
                        
                        const freshState = await p.evaluate(roomJoinScrapeForPage).catch(() => pageState);
                        Object.assign(pageState, freshState);
                    }

                    if (pageState.hasJoinBtn && !pageState.isJoined && !pageState.error) {
                        console.log(`[${BOT_NAME}][Room:${roomId}] Join button visible! Clicking...`);
                        try {
                            await p.waitForSelector(JOIN_ROOM_BTN_SELECTOR, { timeout: 30000, visible: true });
                            await p.click(JOIN_ROOM_BTN_SELECTOR).catch(() => null);
                            console.log(`[${BOT_NAME}][Room:${roomId}] Join click (waitForSelector + click).`);
                        } catch (e) {
                            try {
                                const btn = await p.$(JOIN_ROOM_BTN_SELECTOR);
                                if (btn) {
                                    const box = await btn.boundingBox();
                                    if (box) {
                                        await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
                                        await p.mouse.down();
                                        await new Promise((r) => setTimeout(r, 100));
                                        await p.mouse.up();
                                        console.log(`[${BOT_NAME}][Room:${roomId}] Fallback precision click.`);
                                    } else {
                                        await btn.click();
                                    }
                                }
                            } catch (_) { /* ignore */ }
                        }
                        await new Promise((r) => setTimeout(r, 5000));
                    }

                    if (pageState.isJoined && !state.isJoined) {
                        state.isJoined = true;
                        state.joinAttemptTime = Date.now();
                        console.log(`[${BOT_NAME}][Room:${roomId}] 🔓 SUCCESSFULLY JOINED!`);
                    }

                    if (!state.isJoined) {
                        const title = await p.title().catch(() => "Unknown");
                        console.log(`[${BOT_NAME}][Room:${roomId}] Status: ${title} | JoinVisible=${pageState.hasJoinBtn} | Error=${pageState.error || 'None'}`);
                        
                        // If we are definitely on a Chat page but the scraper missed the input, force join-state
                        if (title.includes('Chat') && !pageState.hasJoinBtn && !profileLooksGuest) {
                             console.log(`[${BOT_NAME}][Room:${roomId}] Forcing Joined state based on page title.`);
                             state.isJoined = true;
                             state.joinAttemptTime = Date.now();
                             continue;
                        }

                        // Only hard-refresh after a *clean* scrape says we're not inside (skip on EVAL_FAIL /
                        // IN_PAGE_EVAL — those often mean navigation/hydration, not a blank tab).
                        if (
                            !pageState.error &&
                            !pageState.hasJoinBtn &&
                            !pageState.isJoined &&
                            Date.now() - state.creationTime > 45000
                        ) {
                            console.log(`[${BOT_NAME}][Room:${roomId}] Tab seems stuck or blank. Refreshing...`);
                            await p.reload({ waitUntil: 'domcontentloaded' }).catch(() => null);
                            state.creationTime = Date.now();
                        }
                        continue;
                    }

                    const syncData = await p.evaluate(() => {
                        try {
                            // 1. Target relevant elements for mapping
                            const vMap = {};
                            const targets = document.querySelectorAll('a, [class*="avatar"], [class*="profile"], .room-item, .chat-item');
                            targets.forEach(el => {
                                // Check primary attributes
                                const attrs = ['href', 'title', 'aria-label', 'data-url', 'data-id'];
                                for (const aName of attrs) {
                                    const val = el.getAttribute(aName) || "";
                                    if (val.includes('/av/') || val.includes('/avatar/')) {
                                        const m = val.match(/\/(?:av|avatar)\/([^\/\?]+)/i);
                                        if (m) {
                                            const real = decodeURIComponent(m[1]).replace(/\/$/, '').trim();
                                            const displayNames = [el.innerText, el.title, el.getAttribute('aria-label')];
                                            displayNames.forEach(n => {
                                                if (n && n.trim().length > 0) {
                                                    const cleanN = n.trim().toLowerCase();
                                                    if (!vMap[cleanN]) vMap[cleanN] = real;
                                                }
                                            });
                                        }
                                    }
                                }
                            });

                            // 2. Scrape chat
                            // 2. Scrape chat - target ONLY the chat message container
                            const chatContainer = document.querySelector('.cs2-chat-messages, .message-list, .chat-messages, .cs2-messages-container');
                            if (!chatContainer) return { results: [], visitorsMapSize: Object.keys(vMap).length };

                            // Target actual text spans within messages
                            const sel = '.cs2-text, .msg-text, .cs2-msg-content, .message-content, .text';
                            const textElements = Array.from(chatContainer.querySelectorAll(sel)).slice(-25);
                            
                            const results = [];
                            for (const el of textElements) {
                                 const text = el.innerText.trim();
                                 if (!text || text.length < 1) continue;
                                 
                                 // Filter out obviously junk UI text
                                 if (text.includes('Click here') || text.includes('Logging out') || text.includes('ON AIR:') || text.includes('take a picture')) continue;

                                 const parentMsg = el.closest('.cs2-msg, .msg, [class*="msg"]');
                                 const isSystem = parentMsg ? (parentMsg.classList.contains('is-action') || parentMsg.classList.contains('is-system') || !parentMsg.querySelector('.cs2-name, [class*="name"]')) : true;
                                 let username = "Unknown";
 
                                 if (parentMsg) {
                                     // 1. Try to find the real ID from the secret profile link (Best for invisibles)
                                     const link = parentMsg.querySelector('[href*="/av/"], [href*="/avatar/"]') || 
                                                  parentMsg.closest('[href*="/av/"], [href*="/avatar/"]') ||
                                                  el.querySelector('[href*="/av/"], [href*="/avatar/"]');
                                     if (link) {
                                         const attrVal = link.getAttribute('href') || "";
                                         const m = attrVal.match(/\/(?:av|avatar)\/([^\/\?]+)/i);
                                         if (m) username = decodeURIComponent(m[1]).replace(/\/$/, '').trim();
                                     }

                                     // 2. FALLBACK: Use display name if link parsing failed (Good for standard accounts)
                                     if (username === "Unknown") {
                                         if (isSystem) {
                                             // Extract name from "X joined the chat"
                                             username = text.replace(/(?:joined|left|is in|entered|is here).*/i, "").trim();
                                         } else {
                                             const nameEl = parentMsg.querySelector('.cs2-name');
                                             if (nameEl) username = nameEl.innerText.trim();
                                         }
                                     }
                                 }
 
                                 // Bot/Self filter
                                 if (username.toLowerCase() === "you" || username === "Unknown") {
                                     username = "Unknown";
                                 }
 
                                 results.push({ message: text, username, isSystem });
                                                 // console.log(`[Diagnostic] Scraped ${results.length} lines.`);
                             }
                            return { results, visitorsMapSize: Object.keys(vMap).length };
                        } catch (e) { return { results: [], visitorsMapSize: 0 }; }
                    }).catch(() => ({ results: [], visitorsMapSize: 0 }));

                    const chatDataArray = syncData.results;

                    // CDP user-tracker handles Discord, welcomes, mention replies — enable DOM duplicate path only if needed.
                    if (process.env.IMVU_DOM_CHAT_AI === '1') {
                    for (const chat of chatDataArray) {
                        // 1. FILTER: Ignore bot's own activity or unknown users
                        const botNames = [botMatch.username.toLowerCase(), BOT_NAME.toLowerCase(), 's1va', 'siva', 'you'];
                        if (!chat.username || chat.username === "Unknown" || botNames.includes(chat.username.toLowerCase())) {
                            continue;
                        }

                        const hash = `${roomId}:${chat.username}:${chat.message}`;
                        const textHash = `${roomId}:text:${chat.message}`;
                        
                        if (chat.isSystem) {
                            const lowerMsg = chat.message.toLowerCase();
                            const isJoin = lowerMsg.includes('joined the chat') || 
                                           lowerMsg.includes('is in the chat') || 
                                           lowerMsg.includes('entered the room') ||
                                           lowerMsg.includes('is here!');
                            
                            const sysHash = `sys-join:${roomId}:${chat.username}:${chat.message}`;

                            if (isJoin) {
                                // SUPPRESSION: Only skip welcoming if it's the very first load
                                if (state.isInitialLoad) {
                                     processedGlobal.add(sysHash);
                                     continue;
                                }

                                if (processedGlobal.has(sysHash)) continue;
                                processedGlobal.add(sysHash);

                                // Sanitize username for cleaning long blank strings (invisible names)
                                let cleanName = chat.username.replace(/[^\x20-\x7E]/g, '').trim(); 
                                if (!cleanName || cleanName.length < 1) {
                                    console.log(`[Response] Skipping welcome for invisible/invalid name: ${chat.username}`);
                                    continue;
                                }

                                const welcomeMsg = `Welcome to the room, @${cleanName}! 👋`;
                                console.log(`[Response] Welcoming user: ${cleanName} in Room ${roomId}`);
                                lastSentGlobal.set(roomId, welcomeMsg);
                                const delay = 3000 + Math.random() * 7000;
                                await new Promise(r => setTimeout(r, delay));
                                await say(p, welcomeMsg);
                            }
                            continue;
                        }

                        // For regular chat: always deduplicate
                        if (processedGlobal.has(hash) || processedGlobal.has(textHash) || chat.message === lastSentGlobal.get(roomId)) continue;
                        processedGlobal.add(hash);
                        processedGlobal.add(textHash);
  
                         // --- 2. Regular AI Logic ---
                        try {
                            const res = await axios.post(`${BACKEND_URL}/api/lurk`, {
                                message: chat.message,
                                username: chat.username,
                                room_id: String(roomId).trim(),
                                bot_username: botMatch.username,
                                bot_display_name:
                                    (botMatch.profile && String(botMatch.profile).trim()) ||
                                    BOT_NAME,
                            });
                            const reply = res.data.reply;
                            if (reply) {
                                console.log(`[Response] Sending AI reply in Room ${roomId}: ${reply}`);
                                lastSentGlobal.set(roomId, reply);
                                const delay = 3000 + Math.random() * 7000;
                                await new Promise(r => setTimeout(r, delay));
                                await say(p, reply);
                            }
                        } catch (err) { }
                    }
                    }

                    if (processedGlobal.size > 1000) {
                        const arr = Array.from(processedGlobal).slice(-500);
                        processedGlobal.clear();
                        arr.forEach(a => processedGlobal.add(a));
                    }

                    // After processing all current chat lines in this sync, 
                    // if it was the initial load, it's NOT anymore.
                    if (state.isInitialLoad) {
                        state.isInitialLoad = false;
                    }

                }
            } catch (e) { /* ignore */ }
            finally {
                isListening = false;
            }
        }, 3000 + Math.random() * 3000); // 3-6s chat check
 
        async function say(p, text) {
            try {
                // Focus the tab natively to avoid headless background suspension on type
                await p.bringToFront().catch(() => null);

                await p.evaluate(() => {
                    const input = document.querySelector('textarea.input-text') || document.querySelector('textarea[placeholder*="Say something"]');
                    if (input) {
                        input.focus();
                        input.value = "";
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                });

                // Human-like character typing at OS level
                await p.keyboard.type(text, { delay: 50 + Math.random() * 30 });
                
                await new Promise(r => setTimeout(r, 500 + Math.random() * 500));

                await p.evaluate(() => {
                    const input = document.querySelector('textarea.input-text') || document.querySelector('textarea[placeholder*="Say something"]');
                    const btn = document.querySelector('button.btn-send');
                    if (input && btn) {
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                        btn.disabled = false;
                        btn.click();
                        // Also trigger Enter for reliability
                        input.dispatchEvent(new KeyboardEvent('keydown', {
                            bubbles: true, cancelable: true, keyCode: 13, key: 'Enter'
                        }));
                    }
                });
            } catch (e) {}
        }

    } catch (e) {
        console.error("Critical error:", e.message);
    }
})();