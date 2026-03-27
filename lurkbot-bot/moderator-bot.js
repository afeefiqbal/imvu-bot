import 'dotenv/config';
import puppeteer from 'puppeteer';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000';
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
            headless: true, // User requested for manual observation
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
        const departedGuests = new Set(); // Tracks users who explicitly left, so the scraper doesn't revive them from chat history
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
                        
                        document.querySelectorAll('[id*="nt-"], [src*="user-"], [data-user-id], [data-id], .uikit-avatar').forEach(el => {
                            const id = el.getAttribute('data-user-id') || el.getAttribute('data-id') ||
                                el.id?.match(/nt-(\d+)/)?.[1] || el.src?.match(/user-(\d+)/)?.[1];
                            if (id && /^\d{5,12}$/.test(id)) {
                                visitorIds.add(id);
                                console.log(`[DEBUG SCAPER] Found ID: ${id}`);
                            }
                        });

                        const hostEl = document.querySelector('.uikit-inline-item.host-name, .room-host, [class*="host-name"]');
                        const hostNameEl = hostEl?.querySelector('.text, [title]');
                        let hostName = hostNameEl ? (hostNameEl.textContent || hostNameEl.getAttribute('title') || '').toLowerCase().replace('hosted by', '').trim() : '';
                        const roomHostId = window.location.href.match(/room-([\d\-]+)/)?.[1]?.split('-')[0] || '';
                        return { visitors: Array.from(visitorIds), foundHost: hostName, hostId: roomHostId };
                    }).catch(() => null);

                    if (data) {
                        const uniqueGuests = new Map();
                        for (const userId of data.visitors) {
                            if (!userId) continue;
                            
                            if (userIdToUsername.has(userId)) {
                                let canonical = userIdToUsername.get(userId);
                                // Strip 'guest_' prefix if present
                                if (canonical.toLowerCase().startsWith('guest_') && canonical.length > 6) {
                                    canonical = canonical.substring(6);
                                }
                                
                                const lowerCanonical = canonical.toLowerCase();
                                const isBotSelf = lowerCanonical === 'you' || lowerCanonical === botUsername || lowerCanonical === `siva` || lowerCanonical === `guest_${botUsername}`;
                                
                                // If they were marked as departed but they are now in the physical Occupancy list, they have returned!
                                if (departedGuests.has(lowerCanonical)) {
                                    console.log(`[${BOT_NAME}] 🔄 Detected re-entry via Scraper: ${canonical}`);
                                    departedGuests.delete(lowerCanonical);
                                }

                                if (isBotSelf) continue;
                                uniqueGuests.set(lowerCanonical, canonical);
                            } else {
                                if (!pendingResolutions.has(userId)) {
                                    console.log(`[${BOT_NAME}] 🔍 Unknown ID ${userId} found. Resolving username...`);
                                    pendingResolutions.add(userId);
                                }
                                // Include unresolved users temporarily by their ID so they are counted
                                uniqueGuests.set(userId, `user_${userId}`);
                                p.evaluate((id) => {
                                    fetch(`https://api.imvu.com/user/user-${id}`).catch(() => { });
                                }, userId).catch(() => { });
                            }
                        }

                        const finalVisitors = Array.from(uniqueGuests.values()).slice(0, 50);
                        const population = finalVisitors.length;

                        if (!roomStates.has(roomId)) roomStates.set(roomId, new Set());
                        const oldVisitors = roomStates.get(roomId);
                        const currentVisitors = new Set(finalVisitors);

                        // If you want everyone in the room to be welcomed when bot joins, we don't block it with isFirstSync
                        for (const user of finalVisitors) {
                            if (!oldVisitors.has(user) && user.length >= 3 && !user.startsWith('user_')) {
                                hasStateChange = true;
                                console.log(`[${BOT_NAME}] ✨ Welcoming ${user}`);
                                await sendChatMessage(p, `Welcome @${user}`);
                            }
                        }
                        for (const user of oldVisitors) {
                            if (!currentVisitors.has(user) && user.length >= 3 && !user.startsWith('user_')) {
                                hasStateChange = true;
                                console.log(`[${BOT_NAME}] 👋 Saying goodbye to ${user}`);
                                await sendChatMessage(p, `Bye @${user}`);
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
                        (async () => {
                            try {
                                const newPage = await browser.newPage();
                                setupConsoleListener(newPage);
                                setupNetworkListener(newPage);
                                await newPage.goto(`https://www.imvu.com/next/chat/room-${rid}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
                                await setupChatObserver(newPage);
                                await newPage.waitForFunction(() => {
                                    const joinBtn = Array.from(document.querySelectorAll('button, .uikit-button, [role="button"], div, span'))
                                        .find(b => /^(JOIN|GO TO ROOM|ENTER)$/i.test((b.innerText || '').trim()));
                                    if (joinBtn) { joinBtn.click(); return true; }
                                    return false;
                                }, { timeout: 15000 }).catch(() => {});
                                joiningRooms.delete(rid);
                            } catch (e) {
                                joiningRooms.delete(rid);
                            }
                        })();
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
                                    userIdToUsername.set(userId, username);
                                    if (pendingResolutions.has(userId)) {
                                        console.log(`[${BOT_NAME}] ✅ Resolved ${userId} -> ${username}`);
                                        pendingResolutions.delete(userId);
                                        runSyncCycle().catch(() => { });
                                    }
                                }
                            }
                        }
                    }
                } catch (e) { }
            });
        };

        const setupConsoleListener = (p) => {
            p.on('console', msg => {
                const txt = msg.text();
                if (txt.includes('DEBUG') || txt.includes('CHAT')) console.log(`[BROWSER] ${txt}`);
            });
        };

        const setupChatObserver = async (targetPage) => {
            await targetPage.exposeFunction('onNewChatEvent', async (text, htmlStr, nodeName) => {
                const lowerText = text.toLowerCase();
                const roomId = targetPage.url().match(/room-([\d\-]+)/)?.[1] || activeRoomId;
                
                let rawUsername = '';

                // If name is attached via nodeName or prepended text
                if (lowerText.includes('is in the chat')) {
                    rawUsername = text.split(/ is in the chat/i)[0].trim();
                } else if (lowerText.includes('joined the chat')) {
                    rawUsername = text.split(/ joined the chat/i)[0].trim();
                } else if (lowerText.includes('left the chat')) {
                    rawUsername = text.split(/ left the chat/i)[0].trim();
                }


                const processUsernameStr = (rawName) => {
                    if (!rawName) return '';
                    // Strictly keep only alphanumeric, underscores, and hyphens (strips invisible characters)
                    let name = rawName.replace(/[^a-zA-Z0-9_\-\s]/g, '').trim();
                    if (name.toLowerCase().startsWith('guest_') && name.length > 6) {
                        return name.substring(6);
                    }
                    return name;
                };

                let username = '';
                // 1. ALWAYS PRIORITIZE ID-to-Username mapping from HTML meta
                if (htmlStr) {
                    const idMatch = htmlStr.match(/user-(\d+)/) || htmlStr.match(/nt-(\d+)/) || htmlStr.match(/data-user-id="(\d+)"/);
                    if (idMatch && idMatch[1]) {
                        const resolved = userIdToUsername.get(idMatch[1]);
                        if (resolved) username = processUsernameStr(resolved);
                        else rawUsername = `user_${idMatch[1]}`;
                    }
                }

                // 2. Fallback to Display Name from text only if username still missing
                if (!username && rawUsername) username = processUsernameStr(rawUsername) || processUsernameStr(nodeName);
                if (!username || username.length < 3 || /^(chat|join|leave|you|youre|room)$/i.test(username)) return;

                if (lowerText.includes('is in the chat') || lowerText.includes('joined the chat')) {
                    if (username.toLowerCase() !== botUsername) {
                        const state = roomStates.get(roomId) || new Set();
                        const isPresent = Array.from(state).some(u => u.toLowerCase() === username.toLowerCase());
                        
                        if (!isPresent) {
                            console.log(`[${BOT_NAME}] ⚡ DOM Join: ${username} (raw: ${rawUsername.trim()})`);
                            departedGuests.delete(username.toLowerCase());
                            state.add(username);
                            roomStates.set(roomId, state);
                            await sendChatMessage(targetPage, `Welcome @${username}`);
                            runSyncCycle().catch(() => { });
                        }
                    }
                } else if (lowerText.includes('left the chat')) {
                    const state = roomStates.get(roomId);
                    const existingUser = state ? Array.from(state).find(u => u.toLowerCase() === username.toLowerCase()) : null;

                    if (existingUser) {
                        console.log(`[${BOT_NAME}] 👋 DOM Leave: ${username}`);
                        departedGuests.add(username.toLowerCase());
                        state.delete(existingUser);
                        await sendChatMessage(targetPage, `Bye @${username}`);
                        runSyncCycle().catch(() => { });
                    }
                }
            });

            await targetPage.exposeFunction('onNewChatMessage', (sender, content) => {
                if (sender.toLowerCase() !== botUsername) console.log(`[CHAT][${sender}] ${content}`);
            });

            try {
                // Natively click the chat bubble so it opens before attaching the observer
                const bubbleSelectors = 'button.chat-bubble, .chat-bubble, .chat-button, [aria-label*="chat" i], [title*="chat" i], .uikit-chat-bubble';
                await targetPage.waitForSelector(bubbleSelectors, { timeout: 15000 });
                await targetPage.evaluate((sel) => {
                    const btn = document.querySelector(sel);
                    if (btn) btn.click();
                }, bubbleSelectors);
                
                await targetPage.waitForSelector('.message-list-wrapper, .cs2-chat-list, .chat-list', { timeout: 15000 });
            } catch (e) {
                console.log(`[${BOT_NAME}] ⚠️ Could not natively open chat bubble, trying fallback...`);
            }

            await targetPage.evaluate(() => {
                const setup = () => {
                    const list = document.querySelector('.message-list-wrapper') || document.querySelector('.cs2-chat-list') || document.querySelector('.chat-list') || document.body;
                    console.log('--- CHAT OBSERVER ACTIVE (DOM) ---');
                    const observer = new MutationObserver((mutations) => {
                        for (const mutation of mutations) {
                            for (const node of mutation.addedNodes) {
                                const text = (node.textContent || '').trim();
                                if (text) console.log(`[MUTATION] ${text.substring(0, 100)}`);
                                
                                if (node.nodeType === 1) {
                                    const htmlStr = node.innerHTML || '';
                                    const nameEl = node.querySelector('.name, .username, .cs2-chat-message-author, .message-author, [class*="author"]');
                                    const nodeName = nameEl ? nameEl.textContent.trim() : '';
                                    const lowerText = text.toLowerCase();

                                    if (lowerText.includes('chat') || lowerText.includes('join') || lowerText.includes('leave') || lowerText.includes('room')) {
                                        console.log(`[SYSTEM DOM] html: "${htmlStr.substring(0, 300)}..."`);
                                        window.onNewChatEvent(text, htmlStr, nodeName);
                                    }

                                    const msgEl = node.querySelector('.text, .message, .message-body, [class*="message-body"]');
                                    if (nameEl && msgEl) {
                                        window.onNewChatMessage(nodeName, msgEl.textContent.trim());
                                    }
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
        } catch (e) { }

        const firstRoom = initialRooms.length > 0 ? initialRooms[0] : '163042598-3671';
        console.log(`[${BOT_NAME}] Navigating to room: ${firstRoom}...`);

        setupConsoleListener(page);
        setupNetworkListener(page);
        await page.goto(`https://www.imvu.com/next/chat/room-${firstRoom}/`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);

        // Quick login if session expired
        const needsLogin = await page.evaluate(() => !!(document.querySelector('form[action*="/login"]') || document.title.toLowerCase().includes('log in'))).catch(() => false);
        if (needsLogin) {
            console.log(`[${BOT_NAME}] Session expired. Logging in...`);
            try {
                const loginRes = await axios.post('https://api.imvu.com/login', {
                    username: botMatch.username, password: botMatch.password, gdpr_cookie_acceptance: false
                }, { headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-IMVU-Application': 'welcome/1' }, timeout: 8000 });
                if (loginRes.headers['set-cookie']) {
                    for (const cStr of loginRes.headers['set-cookie']) {
                        const pair = cStr.split(';')[0];
                        const eqIdx = pair.indexOf('=');
                        if (eqIdx !== -1) await page.setCookie({ name: pair.substring(0, eqIdx), value: pair.substring(eqIdx + 1), domain: '.imvu.com' });
                    }
                    await page.reload({ waitUntil: 'domcontentloaded' });
                }
            } catch (e) { }
        }

        // --- ENTERING THE ROOM ---
        console.log(`[${BOT_NAME}] 🚪 Joining room...`);
        // Use waitForFunction to find and click join as soon as it appears
        await page.waitForFunction(() => {
            const btns = Array.from(document.querySelectorAll('button, .uikit-button, [role="button"], div, span'));
            const joinBtn = btns.find(b => {
                const text = (b.innerText || '').trim().toUpperCase();
                return text === 'JOIN' || text === 'GO TO ROOM' || text === 'ENTER';
            });
            if (joinBtn) {
                joinBtn.click();
                return true;
            }
            return false;
        }, { timeout: 30000 }).catch(() => { });

        // Extra insurance: click by class if it's visible
        await page.evaluate(() => {
            const btn = document.querySelector('.uikit-button-primary');
            if (btn && (btn.innerText || '').toUpperCase().includes('JOIN')) btn.click();
        }).catch(() => {});

        // Now that we are joining/joined, setup the observer
        await setupChatObserver(page);

        console.log(`[${BOT_NAME}] ✅ Ready. Broadcasting in room ${firstRoom}.`);

        setInterval(runSyncCycle, 8000);
                                                                                                                                                                                                                                                                                                                                        
    } catch (e) {
        console.error("Critical error:", e.message);
    }
})();
