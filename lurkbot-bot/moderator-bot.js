import 'dotenv/config';
import puppeteer from 'puppeteer';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BACKEND_URL = process.env.BACKEND_URL || 'http://127.0.0.1:8000';
const BOT_NAME = "ModeratorBot";
const BOT_PROXY = process.env.BOT_PROXY || '';
const BOTS_FILE = path.join(__dirname, 'bots.json');
const USER_DATA_DIR = path.join(__dirname, 'profiles', 'S1VA');

if (!fs.existsSync(BOTS_FILE)) {
    console.error(`[${BOT_NAME}] Error: bots.json not found!`);
    process.exit(1);
}

const bots = JSON.parse(fs.readFileSync(BOTS_FILE, 'utf8'));
const botMatch = bots.find(b => b.profile === 'S1VA') || bots[0];
const botUsername = botMatch.username.toLowerCase();

(async () => {
    try {
        console.log(`🚀 Starting ${BOT_NAME} in INTELLIGENCE TRACKER mode...`);

        const launchArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
        ];
        if (BOT_PROXY) launchArgs.push(`--proxy-server=${BOT_PROXY}`);

        const browser = await puppeteer.launch({
            headless: false, // User requested for manual observation
            executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            userDataDir: USER_DATA_DIR,
            args: launchArgs,
        });

        const [page] = await browser.pages();
        await page.setViewport({ width: 1280, height: 800 });

        // --- SHARED STATE ---
        const userIdToUsername = new Map();
        const pendingResolutions = new Set();
        const roomStates = new Map(); // roomId -> Set of canonical usernames
        const targetRooms = new Set();
        const joiningRooms = new Set();
        let isSyncing = false;
        let isFirstSync = true;
        let activeRoomId = '';

        // --- CORE FUNCTIONS ---
        const sendChatMessage = async (targetPage, message) => {
            await targetPage.evaluate((msg) => {
                const input = document.querySelector('textarea, .uikit-chat-input-textarea, [placeholder*="Say something"]');
                const sendBtn = Array.from(document.querySelectorAll('button')).find(b => {
                    const t = b.innerText.toUpperCase().trim();
                    return t === 'SEND';
                });
                if (input) {
                    if (input.tagName === 'TEXTAREA') {
                        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
                        nativeSetter.call(input, msg);
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                    } else if (input.isContentEditable) {
                        input.innerText = msg;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                    if (sendBtn) {
                        sendBtn.click();
                    } else {
                        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                    }
                    return true;
                }
                return false;
            }, message).catch(() => false);
        };

        const runSyncCycle = async () => {
            if (isSyncing) return;
            isSyncing = true;
            console.log(`[${BOT_NAME}] 🔄 Starting sync cycle...`);
            try {
                const allPages = await browser.pages();
                const imvuPages = allPages.filter(p => p.url().includes('room-'));
                const roomsToSync = [];
                let hasStateChange = false;

                for (const p of imvuPages) {
                    const match = p.url().match(/room-([\d\-]+)/);
                    if (!match) continue;
                    const roomId = match[1];
                    activeRoomId = roomId;

                    const data = await p.evaluate(() => {
                        const visitorIds = new Set();
                        const html = document.body.innerHTML;
                        const matches = html.matchAll(/(?:user-|nt-|userId["']?:|avatar_)(\d{5,12})/g);
                        for (const m of matches) if (m[1]) visitorIds.add(m[1]);

                        document.querySelectorAll('[id*="nt-"], [src*="user-"], [data-user-id], [data-id]').forEach(el => {
                            const id = el.getAttribute('data-user-id') || el.getAttribute('data-id') ||
                                       el.id?.match(/nt-(\d+)/)?.[1] || el.src?.match(/user-(\d+)/)?.[1];
                            if (id && /^\d{5,12}$/.test(id)) visitorIds.add(id);
                        });

                        const hostEl = document.querySelector('.uikit-inline-item.host-name, .room-host, [class*="host-name"]');
                        const hostNameEl = hostEl?.querySelector('.text, [title]');
                        let hostName = hostNameEl ? (hostNameEl.innerText || hostNameEl.getAttribute('title') || '').toLowerCase().replace('hosted by', '').trim() : '';
                        const roomHostId = window.location.href.match(/room-([\d\-]+)/)?.[1]?.split('-')[0] || '';
                        return { visitors: Array.from(visitorIds), foundHost: hostName, hostId: roomHostId };
                    }).catch(() => null);

                    if (data) {
                        const uniqueGuests = new Map();
                        for (const userId of data.visitors) {
                            if (!userId) continue;
                            if (userIdToUsername.has(userId)) {
                                const canonical = userIdToUsername.get(userId);
                                const lowerCanonical = canonical.toLowerCase();
                                const isBotOrHost = lowerCanonical === 'you' || lowerCanonical === botUsername || lowerCanonical === `guest_${botUsername}` || userId === data.hostId || lowerCanonical === 'siva';
                                if (isBotOrHost) continue;
                                uniqueGuests.set(lowerCanonical, canonical);
                            } else {
                                if (!pendingResolutions.has(userId)) {
                                    console.log(`[${BOT_NAME}] 🔍 Unknown ID ${userId} found. Resolving username...`);
                                    pendingResolutions.add(userId);
                                }
                                p.evaluate((id) => {
                                    fetch(`https://api.imvu.com/user/user-${id}`).catch(() => {});
                                }, userId).catch(() => {});
                            }
                        }

                        const finalVisitors = Array.from(uniqueGuests.values()).slice(0, 50);
                        const population = finalVisitors.length;

                        if (!roomStates.has(roomId)) roomStates.set(roomId, new Set());
                        const oldVisitors = roomStates.get(roomId);
                        const currentVisitors = new Set(finalVisitors);

                        if (!isFirstSync && data.foundHost) {
                            for (const user of finalVisitors) {
                                if (!oldVisitors.has(user)) {
                                    hasStateChange = true;
                                    console.log(`[${BOT_NAME}] ✨ Welcoming ${user}`);
                                    await sendChatMessage(p, `Welcome @${user}`);
                                }
                            }
                            for (const user of oldVisitors) {
                                if (!currentVisitors.has(user)) {
                                    hasStateChange = true;
                                    console.log(`[${BOT_NAME}] 👋 Saying goodbye to ${user}`);
                                    await sendChatMessage(p, `Bye @${user}`);
                                }
                            }
                        }
                        roomStates.set(roomId, currentVisitors);
                        roomsToSync.push({ id: roomId, visitors: finalVisitors, population });
                    }
                }

                if (hasStateChange || isFirstSync) {
                    const res = await axios.post(`${BACKEND_URL}/api/rooms/sync`, { rooms: roomsToSync, bot_name: BOT_NAME, bot_username: botMatch.username }, { timeout: 10000 });
                    for (const r of roomsToSync) {
                        console.log(`[DATA][Room:${r.id}] 👥 Guests (${r.population}): ${r.visitors.join(', ')}`);
                    }
                    if (res.data?.target_rooms) {
                        targetRooms.clear();
                        res.data.target_rooms.forEach(id => targetRooms.add(id));
                    }
                    isFirstSync = false;
                }

                for (const rid of targetRooms) {
                    const isAlreadyOpen = imvuPages.some(p => p.url().includes(`room-${rid}`));
                    if (!isAlreadyOpen && !joiningRooms.has(rid)) {
                        joiningRooms.add(rid);
                        const newPage = await browser.newPage();
                        setupConsoleListener(newPage);
                        setupNetworkListener(newPage);
                        await newPage.goto(`https://www.imvu.com/next/chat/room-${rid}/`, { waitUntil: 'domcontentloaded' });
                        await setupChatObserver(newPage);
                    }
                }
            } catch (e) {
                console.error(`Tracker Error:`, e.message);
            } finally {
                isSyncing = false;
                console.log(`[${BOT_NAME}] ✨ Sync cycle complete.`);
            }
        };

        const setupNetworkListener = (p) => {
            p.on('response', async (response) => {
                const url = response.url();
                if (!url.includes('api.imvu.com')) return;
                const ct = response.headers()['content-type'] || '';
                if (!ct.includes('application/json')) return;
                try {
                    const json = await response.json();
                    if (json.denormalized) {
                        for (const [key, val] of Object.entries(json.denormalized)) {
                            const idMatch = key.match(/\/user\/user-(\d+)/);
                            if (idMatch && val?.data?.username) {
                                const userId = idMatch[1];
                                const username = val.data.username;
                                if (username.toLowerCase() !== botUsername) {
                                    if (pendingResolutions.has(userId)) {
                                        console.log(`[${BOT_NAME}] ✅ Resolved ${userId} -> ${username}`);
                                        pendingResolutions.delete(userId);
                                        runSyncCycle().catch(() => {});
                                    }
                                    userIdToUsername.set(userId, username);
                                }
                            }
                        }
                    }
                } catch (e) {}
            });
        };

        const setupConsoleListener = (p) => {
            p.on('console', msg => {
                const txt = msg.text();
                if (txt.includes('DEBUG') || txt.includes('CHAT')) console.log(`[BROWSER] ${txt}`);
            });
        };

        const setupChatObserver = async (targetPage) => {
            await targetPage.exposeFunction('onNewChatEvent', async (text) => {
                const lowerText = text.toLowerCase();
                const roomId = targetPage.url().match(/room-([\d\-]+)/)?.[1] || activeRoomId;
                
                if (lowerText.includes('is in the chat')) {
                    const username = text.split(/ is in the chat/i)[0].trim();
                    if (username && username.toLowerCase() !== botUsername) {
                        const state = roomStates.get(roomId) || new Set();
                        if (!state.has(username)) {
                            console.log(`[${BOT_NAME}] ⚡ DOM Join: ${username}`);
                            state.add(username);
                            roomStates.set(roomId, state);
                            await sendChatMessage(targetPage, `Welcome @${username}`);
                            runSyncCycle().catch(() => {});
                        }
                    }
                } else if (lowerText.includes('left the chat')) {
                    const username = text.split(/ left the chat/i)[0].trim();
                    const state = roomStates.get(roomId);
                    if (username && state?.has(username)) {
                        console.log(`[${BOT_NAME}] 👋 DOM Leave: ${username}`);
                        state.delete(username);
                        await sendChatMessage(targetPage, `Bye @${username}`);
                        runSyncCycle().catch(() => {});
                    }
                }
            });

            await targetPage.exposeFunction('onNewChatMessage', (sender, content) => {
                if (sender.toLowerCase() !== botUsername) console.log(`[CHAT][${sender}] ${content}`);
            });

            await targetPage.evaluate(() => {
                const setup = () => {
                    const list = document.querySelector('.message-list-wrapper') || document.querySelector('.cs2-chat-list');
                    if (!list) {
                        const bubbleBtn = document.querySelector('button.chat-bubble');
                        if (bubbleBtn) bubbleBtn.click();
                        setTimeout(setup, 3000);
                        return;
                    }
                    console.log('--- CHAT OBSERVER ACTIVE (DOM) ---');
                    const observer = new MutationObserver((mutations) => {
                        for (const mutation of mutations) {
                            for (const node of mutation.addedNodes) {
                                if (node.nodeType === 1) {
                                    const text = node.innerText || '';
                                    if (text.includes('chat')) window.onNewChatEvent(text);
                                    const nameEl = node.querySelector('.name, .username, [class*="name"]');
                                    const msgEl = node.querySelector('.text, .message, [class*="message-body"]');
                                    if (nameEl && msgEl) window.onNewChatMessage(nameEl.innerText.trim(), msgEl.innerText.trim());
                                }
                            }
                        }
                    });
                    observer.observe(list, { childList: true, subtree: true });
                };
                setup();
            });
        };

        // --- STARTUP FLOW ---
        let initialRooms = [];
        try {
            const res = await axios.post(`${BACKEND_URL}/api/rooms/sync`, { rooms: [], bot_name: BOT_NAME, bot_username: botMatch.username }, { timeout: 5000 });
            if (res.data && res.data.target_rooms) initialRooms = res.data.target_rooms;
        } catch (e) {}

        const firstRoom = initialRooms.length > 0 ? initialRooms[0] : '163042598-3671';
        console.log(`[${BOT_NAME}] Navigating to room: ${firstRoom}...`);
        
        setupConsoleListener(page);
        setupNetworkListener(page);
        await page.goto(`https://www.imvu.com/next/chat/room-${firstRoom}/`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
        await new Promise(r => setTimeout(r, 5000));

        // Quick login if session expired
        const needsLogin = await page.evaluate(() => !!(document.querySelector('form[action*="/login"]') || document.title.toLowerCase().includes('log in'))).catch(() => false);
        if (needsLogin) {
            console.log(`[${BOT_NAME}] Session expired. Logging in via API...`);
            try {
                const loginRes = await axios.post('https://api.imvu.com/login', {
                    username: botMatch.username, password: botMatch.password, gdpr_cookie_acceptance: false
                }, { headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-IMVU-Application': 'welcome/1' }, timeout: 8000 });
                const cookies = loginRes.headers['set-cookie'];
                if (cookies) {
                    for (const cStr of cookies) {
                        const pair = cStr.split(';')[0];
                        const eqIdx = pair.indexOf('=');
                        if (eqIdx !== -1) await page.setCookie({ name: pair.substring(0, eqIdx), value: pair.substring(eqIdx + 1), domain: '.imvu.com' });
                    }
                    await page.reload({ waitUntil: 'domcontentloaded' });
                    await new Promise(r => setTimeout(r, 5000));
                }
            } catch (e) {
                console.error(`[${BOT_NAME}] Login failed!`);
            }
        }

        await setupChatObserver(page);
        console.log(`[${BOT_NAME}] Forcing refresh to capture usernames...`);
        await page.reload({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => null);
        await new Promise(r => setTimeout(r, 8000));

        await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button')).find(b => /join|go to room|enter/i.test(b.innerText));
            if (btn) btn.click();
        }).catch(() => null);
        await new Promise(r => setTimeout(r, 10000));

        await sendChatMessage(page, "Moderator active.");
        console.log(`[${BOT_NAME}] ✅ Ready. Broadcasting in room ${firstRoom}.`);

        setInterval(runSyncCycle, 30000);

    } catch (e) {
        console.error("Critical error:", e.message);
    }
})();
