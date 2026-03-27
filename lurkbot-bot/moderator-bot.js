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
const USER_DATA_DIR = path.join(__dirname, 'profiles', BOT_NAME);

if (!fs.existsSync(BOTS_FILE)) {
    console.error(`[${BOT_NAME}] Error: bots.json not found!`);
    process.exit(1);
}

const bots = JSON.parse(fs.readFileSync(BOTS_FILE, 'utf8'));
const botMatch = bots.find(b => b.profile === 'S1VA') || bots[0];
const botUsername = botMatch.username.toLowerCase();

// --- GLOBALS & SHARED STATE ---
const userIdToUsername = new Map();
const pendingResolutions = new Set();
const roomStates = new Map(); // roomId -> Set of userIds
const lastSeen = new Map(); // userId -> timestamp
const departedGuests = new Set();
const welcomeCooldowns = new Map(); // userId -> timestamp
const roomClosingTimers = new Map(); // roomId -> timestamp
const activeTabRoomIds = new Set(); 
const targetRooms = new Set();
const joiningRooms = new Set();
let hasStateChange = false;


let browser = null;
let mainPage = null;
let isSyncing = false;
let isInitialStart = true;
let isRestarting = false;
let syncInterval = null;

const cleanupProfileLock = () => {
    try {
        const lockPath = path.join(USER_DATA_DIR, 'SingletonLock');
        if (fs.existsSync(lockPath)) {
            console.log(`[${BOT_NAME}] 🧹 Removing stale profile lock...`);
            fs.unlinkSync(lockPath);
        }
    } catch (e) { }
};

const initBot = async () => {
    if (isRestarting) return;
    isRestarting = true;
    
    try {
        if (browser) {
            console.log(`[${BOT_NAME}] 🔄 Restarting browser session...`);
            if (syncInterval) clearInterval(syncInterval);
            await browser.close().catch(() => {});
            browser = null;
        }

        cleanupProfileLock();

        const launchArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
        ];
        if (BOT_PROXY) launchArgs.push(`--proxy-server=${BOT_PROXY}`);

        browser = await puppeteer.launch({
            headless: true,
            executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            userDataDir: USER_DATA_DIR,
            args: launchArgs,
        });

        mainPage = (await browser.pages())[0];
        await mainPage.setViewport({ width: 1280, height: 800 });

        // --- CORE FUNCTIONS ---
        const sendChatMessage = async (targetPage, message) => {
            try {
                const inputSelectors = [
                    'textarea[placeholder*="Say something"]',
                    '.uikit-chat-input-textarea',
                    'textarea.chat-input',
                    '[role="textbox"]',
                    'textarea'
                ];
                
                let input;
                for (const selector of inputSelectors) {
                    input = await targetPage.$(selector).catch(() => null);
                    if (input) {
                        const visible = await input.boundingBox().catch(() => null);
                        if (visible) break;
                    }
                }

                if (input) {
                    await input.click({ clickCount: 3 }).catch(() => {});
                    await targetPage.keyboard.type(message, { delay: 20 });
                    await targetPage.keyboard.press('Enter');
                    
                    // Fallback: Click Send Button
                    await targetPage.evaluate(() => {
                        const btns = Array.from(document.querySelectorAll('button, [role="button"], .uikit-button'));
                        const sendBtn = btns.find(b => {
                            const t = (b.innerText || b.getAttribute('title') || '').toUpperCase().trim();
                            return t === 'SEND' || b.querySelector('svg') || b.querySelector('i.icon-send');
                        });
                        if (sendBtn) sendBtn.click();
                    }).catch(() => {});
                    
                    return true;
                }
            } catch (err) {
                console.error(`[${BOT_NAME}] Chat sending error:`, err.message);
            }
            return false;
        };

        const runSyncCycle = async (force = false) => {
            if (!browser || !browser.isConnected()) {
                console.error(`[${BOT_NAME}] Browser disconnected. Triggering restart...`);
                initBot();
                return;
            }

            if (force) hasStateChange = true;
            if (isSyncing) return;
            isSyncing = true;

            try {
                const imvuPages = (await browser.pages()).filter(p => p.url().includes('room-'));
                activeTabRoomIds.clear();

                do {
                    const currentSyncState = hasStateChange;
                    hasStateChange = false; // Reset to catch NEW changes during this iteration
                    
                    console.log(`[${BOT_NAME}] 🔄 Starting sync cycle (triggered by: ${isInitialStart ? 'Startup' : (currentSyncState ? 'Event' : 'Interval')})...`);

                    const roomsToSync = [];
                    imvuPages.map(p => p.url().match(/room-([\d\-]+)/)?.[1]).filter(Boolean).forEach(id => activeTabRoomIds.add(id));




                    // 1. Process Open Rooms
                    for (const p of imvuPages) {
                        const match = p.url().match(/room-([\d\-]+)/);
                        if (!match) continue;
                        const roomId = match[1];

                        const data = await p.evaluate((rid) => {
                            const ids = new Set();
                            const participantElements = document.querySelectorAll('.participant-avatar, .avatar-image, [data-user-id], [href*="/av/"], [href*="/avatar/"], .chat-room-participant, [src*="user-"]');
                            participantElements.forEach(el => {
                                const dataId = el.getAttribute('data-user-id') || el.getAttribute('data-id');
                                if (dataId && /^\d{5,12}$/.test(dataId)) ids.add(dataId);
                                const source = el.href || el.getAttribute('href') || el.src || el.getAttribute('src') || '';
                                const idMatch = source.match(/user-([0-9]{5,})/i) || source.match(/av\/([0-9]{5,})/i) || source.match(/avatar\/([0-9]{5,})/i) || source.match(/userdata\/(\d+)/i);
                                if (idMatch) ids.add(idMatch[1]);
                            });
                            const bodyHtml = document.body.innerHTML;
                            const globalMatches = bodyHtml.matchAll(/(?:user-|nt-|av\/)([0-9]{7,15})/g);
                            for (const m of globalMatches) ids.add(m[1]);
                            
                            const metaTitle = document.querySelector('meta[property="og:title"]')?.content;
                            const nameEl = document.querySelector('.chat-header-room-name, .room-name, .room-title-text, h1, h2');
                            let roomName = metaTitle || (nameEl ? nameEl.innerText.trim() : 'Unknown');
                            
                            // Clean up common prefixes if any
                            roomName = roomName.replace(/^IMVU\s*:\s*/i, '').replace(/\s*-\s*IMVU$/i, '');

                            const metaImg = document.querySelector('meta[property="og:image"]');
                            const roomImage = metaImg ? metaImg.content : `https://userimages-akm.imvu.com/room_thumbnail/room-${rid}`;

                            return { visitors: Array.from(ids), roomName, roomImage };

                        }, roomId).catch(() => null);


                        if (data) {
                            // Filter out the RoomID itself from visitors
                            data.visitors = data.visitors.filter(id => id !== roomId && !roomId.startsWith(id));
                            
                            const now = Date.now();
                            if (!roomStates.has(roomId)) roomStates.set(roomId, new Set());
                            const state = roomStates.get(roomId);

                            for (const userId of data.visitors) {
                                if (userId) lastSeen.set(userId, now);
                                if (userIdToUsername.has(userId)) {
                                    let user = userIdToUsername.get(userId);
                                    if (user.toLowerCase().startsWith('guest_') && user.length > 6) user = user.substring(6);
                                    const isBotSelf = user.toLowerCase() === botUsername || user.toLowerCase() === 'you' || user.toLowerCase() === 'siva';
                                    if (isBotSelf) continue;

                                    if (!state.has(userId) && user.length >= 3 && !user.startsWith('user_')) {
                                        hasStateChange = true;
                                        console.log(`[${BOT_NAME}] ✨ Welcoming ${user} (ID: ${userId})`);
                                        await sendChatMessage(p, `Welcome @${user}`);
                                        state.add(userId);
                                    }
                                } else if (!state.has(userId)) {
                                    state.add(userId);
                                    hasStateChange = true;
                                    if (!pendingResolutions.has(userId)) {
                                        console.log(`[${BOT_NAME}] 🔍 Unknown ID ${userId} found. Resolving username...`);
                                        pendingResolutions.add(userId);
                                        p.evaluate((id) => { fetch(`https://api.imvu.com/user/user-${id}`).catch(() => { }); }, userId).catch(() => { });
                                    }
                                }
                            }
                            
                            for (const userId of Array.from(state)) {
                                // Only timeout numeric IDs that the scraper is supposed to see
                                if (/^\d+$/.test(userId)) {
                                    if (!data.visitors.includes(userId)) {
                                        if (now - (lastSeen.get(userId) || 0) > 30000) {
                                            console.log(`[${BOT_NAME}] 🏃 User Left (Scraper Timeout): user_${userId} (ID: ${userId})`);
                                            state.delete(userId);
                                            lastSeen.delete(userId);
                                            hasStateChange = true;
                                        }
                                    }
                                }
                            }
                            
                            const finalVisitors = Array.from(state).map(key => {
                                // key could be an ID or a raw username
                                if (/^\d+$/.test(key)) return userIdToUsername.get(key) || `user_${key}`;
                                return key;
                            }).slice(0, 50);
                            roomsToSync.push({ 
                                id: roomId, 
                                visitors: finalVisitors, 
                                population: state.size,
                                name: data.roomName,
                                image_url: data.roomImage
                            });

                        }
                    }

                    // 2. Identify and Sync Closed Rooms (Zero population)
                    for (const [rid, state] of roomStates.entries()) {
                        if (!activeTabRoomIds.has(rid)) {
                            console.log(`[${BOT_NAME}] 🧹 Room ${rid} closed. Syncing 0 population...`);
                            roomsToSync.push({ id: rid, visitors: [], population: 0 });
                            hasStateChange = true;
                            roomStates.delete(rid);
                        }
                    }

                    if (roomsToSync.length > 0) {
                        const res = await axios.post(`${BACKEND_URL}/api/rooms/sync`, { rooms: roomsToSync, bot_name: BOT_NAME, bot_username: botMatch.username }, { timeout: 10000 });
                        for (const r of roomsToSync) {
                            console.log(`[DATA][Room:${r.id}] 👥 Guests (${r.population}): ${r.visitors.join(', ')}`);
                        }
                        if (res.data?.target_rooms) {
                            targetRooms.clear();
                            res.data.target_rooms.forEach(id => targetRooms.add(id));
                        }
                    }
                    isInitialStart = false;
                } while (hasStateChange || isInitialStart);


                // --- ROOM JOINING ---
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
                                
                                const needsLoginOnNewPage = await newPage.evaluate(() => {
                                    const loginLink = document.querySelector('.login-link, .nav-login, [href*="login"]');
                                    const loggedInUser = document.querySelector('.user-menu, .avatar-name, .username');
                                    return !!loginLink && !loggedInUser;
                                });
                                if (needsLoginOnNewPage) {
                                    await newPage.click('.login-link, [href*="login"]').catch(() => {});
                                    await new Promise(r => setTimeout(r, 4000));
                                    const userInp = await newPage.$('input[type="text"], #login_username');
                                    const passInp = await newPage.$('input[type="password"], #login_password');
                                    if (userInp && passInp) {
                                        await userInp.type(botMatch.username);
                                        await passInp.type(botMatch.password);
                                        await newPage.keyboard.press('Enter');
                                        await new Promise(r => setTimeout(r, 8000));
                                    }
                                }

                                await setupChatObserver(newPage);
                                await newPage.waitForFunction(() => {
                                    const btns = Array.from(document.querySelectorAll('button, .uikit-button, .join-cta, .btn-join, [class*="join"], [role="button"]'));
                                    const joinBtn = btns.find(b => {
                                        const text = (b.textContent || b.innerText || '').trim().toUpperCase();
                                        return text.includes('JOIN') || text.includes('GO TO ROOM') || text.includes('ENTER') || text.includes('CHAT NOW');
                                    });
                                    if (joinBtn && joinBtn.offsetWidth > 0) {
                                        joinBtn.click();
                                        return true;
                                    }
                                    return false;
                                }, { timeout: 30000 }).catch(() => {});
                            } catch (e) {
                                console.error(`Failed to join room ${rid}:`, e.message);
                            } finally {
                                joiningRooms.delete(rid);
                            }
                        })();
                    }
                }

                // --- ROOM EXIT / TAB CLEANUP ---
                const now = Date.now();
                for (const p of imvuPages) {
                    const rmMatch = p.url().match(/room-([\d\-]+)/);
                    if (rmMatch) {
                        const rid = rmMatch[1];
                        if (!targetRooms.has(rid)) {
                            if (!roomClosingTimers.has(rid)) {
                                console.log(`[${BOT_NAME}] ⏳ Room ${rid} scheduled for removal in 30s...`);
                                roomClosingTimers.set(rid, now + 30000);
                            } else if (now > roomClosingTimers.get(rid)) {
                                console.log(`[${BOT_NAME}] 🚪 Grace period expired. Closing untargeted room: ${rid}.`);
                                await p.close().catch(() => null);
                                roomClosingTimers.delete(rid);
                                roomStates.delete(rid);
                            }
                        } else {
                            roomClosingTimers.delete(rid);
                        }
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
                                 let username = val.data.username;
                                 if (username.toLowerCase().startsWith('guest_')) username = username.substring(6);
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
                const roomId = targetPage.url().match(/room-([\d\-]+)/)?.[1];
                if (!roomId) return; // Ensure we have a room ID

                const processUsernameStr = (rawName) => {
                    if (!rawName) return '';
                    let name = rawName.trim().replace(/[\r\n"]/g, '');
                    if (name.toLowerCase().startsWith('guest_')) return name.substring(6);
                    return name;
                };

                let username = '';
                const userId = htmlStr?.match(/user-(\d+)/)?.[1] || htmlStr?.match(/data-user-id="(\d+)"/)?.[1];
                
                // --- RESOLVE USERNAME FROM ID ---
                if (userId) {
                    // Wait briefly if not in map (network listener catch)
                    if (!userIdToUsername.has(userId)) {
                        await new Promise(r => setTimeout(r, 800));
                    }
                    if (userIdToUsername.has(userId)) {
                        username = processUsernameStr(userIdToUsername.get(userId));
                    } else {
                        username = `user_${userId}`;
                    }
                }

                if (!username && nodeName) username = processUsernameStr(nodeName);
                if (!username) username = userId ? `user_${userId}` : 'Guest';

                const isSystemMessage = lowerText.includes('chat') || lowerText.includes('join') || lowerText.includes('leave') || lowerText.includes('room');
                
                if (isSystemMessage && (lowerText.includes('is in the chat') || lowerText.includes('joined the chat'))) {
                    const joinMatch = text.match(/^(.+?)\s+(?:joined the chat|is in the chat)/i);
                    // We no longer use extractedName for the welcome, only for logging
                    const detectedName = joinMatch ? processUsernameStr(joinMatch[1]) : 'Unknown';

                    let accountUsername = '';
                    
                    if (userId) {
                        // Priority 1: Check existing map
                        if (userIdToUsername.has(userId)) {
                            accountUsername = processUsernameStr(userIdToUsername.get(userId));
                        }
                        
                        // Priority 2: Wait briefly and check again (network resolution)
                        if (!accountUsername || accountUsername === `user_${userId}`) {
                            await new Promise(r => setTimeout(r, 2000)); // Longer wait for real username
                            if (userIdToUsername.has(userId)) {
                                accountUsername = processUsernameStr(userIdToUsername.get(userId));
                            }
                        }
                    }

                    // If we STILL don't have a real account username, we skip the welcome entirely
                    // (User strictly requested NO fancy names and NO "Guest" names)
                    if (!accountUsername || accountUsername === `user_${userId}` || accountUsername.toLowerCase() === 'guest') {
                        console.log(`[${BOT_NAME}] ⚠️ Join Event: Could not resolve official username for ${detectedName} (ID: ${userId || 'none'}). Skipping welcome.`);
                        return;
                    }

                    const finalUsername = accountUsername;
                    console.log(`[${BOT_NAME}] 🔍 Join Event Verified: ID ${userId} -> Username: "${finalUsername}"`);



                    
                    const state = roomStates.get(roomId) || new Set();
                    roomStates.set(roomId, state);
                    
                    const now = Date.now();
                    const trackerKey = userId || finalUsername;
                    const lastWelcome = welcomeCooldowns.get(trackerKey) || 0;
                    const isCooldownActive = (now - lastWelcome) < 30000; // 30 seconds for faster testing

                    if (userId) lastSeen.set(userId, now);

                    // WELCOME LOGIC: Trigger if not in state OR if cooldown has expired (for re-joins)
                    if (!state.has(trackerKey) || !isCooldownActive) {
                        if (!isCooldownActive && finalUsername.toLowerCase() !== botUsername) {
                            console.log(`[${BOT_NAME}] ⚡ Welcoming ${finalUsername} (ID: ${userId || 'unknown'})`);
                            await sendChatMessage(targetPage, `Welcome @${finalUsername}`);
                            welcomeCooldowns.set(trackerKey, now);
                        } else if (isCooldownActive) {
                            console.log(`[${BOT_NAME}] ⚡ ${finalUsername} rejoined, but welcome is on cooldown (30s).`);
                        }
                        
                        departedGuests.delete(trackerKey);
                        state.add(trackerKey);
                        runSyncCycle(true).catch(() => { });
                    } else {
                        console.log(`[${BOT_NAME}] ⚡ DOM Join (Persistent Presence): ${finalUsername}`);
                        runSyncCycle(true).catch(() => { });
                    }


                } else if (isSystemMessage && lowerText.includes('left the chat')) {

                    const state = roomStates.get(roomId);
                    if (!state || !userId) return;
                    
                    if (state.has(userId)) {
                        console.log(`[${BOT_NAME}] 🏃 User Left (DOM): ${username} (ID: ${userId})`);
                        departedGuests.add(userId);
                        state.delete(userId);
                        lastSeen.delete(userId);
                        runSyncCycle(true).catch(() => { });
                    }
                }
            });

            await targetPage.exposeFunction('onNewChatMessage', (sender, content) => {
                if (sender.toLowerCase() !== botUsername) console.log(`[CHAT][${sender}] ${content}`);
            });

            try {
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
                                if (node.nodeType === 1) {
                                    const text = (node.textContent || '').trim();
                                    const htmlStr = node.innerHTML || '';
                                    
                                    // IMPROVED: Extract ID specifically from this node or its immediate siblings (for fancy fonts)
                                    const avatarNode = node.previousElementSibling?.querySelector('img[src*="userpics"], img[src*="avatar"]') 
                                                    || node.querySelector('img[src*="userpics"]');
                                    const avatarId = avatarNode?.src?.match(/\/(\d+)\//)?.[1];
                                    
                                    const linkId = node.querySelector('a[href*="av/"], a[href*="user-"]')?.href?.match(/(?:user-|av\/)(\d+)/)?.[1];
                                    const explicitId = node.querySelector('[data-user-id]')?.getAttribute('data-user-id');
                                    
                                    const bestId = explicitId || linkId || avatarId;
                                    const finalHtml = bestId ? `${htmlStr} data-user-id="${bestId}"` : htmlStr;

                                    const nameEl = node.querySelector('.name, .username, .cs2-chat-message-author, .message-author, [class*="author"]');
                                    const nodeName = nameEl ? nameEl.textContent.trim() : '';
                                    const lowerText = text.toLowerCase();
                                    if (lowerText.includes('chat') || lowerText.includes('join') || lowerText.includes('leave') || lowerText.includes('room')) {
                                        window.onNewChatEvent(text, finalHtml, nodeName);
                                    }
                                    const msgEl = node.querySelector('.text, .message, .message-body, [class*="message-body"]');
                                    if (nameEl && msgEl) window.onNewChatMessage(nodeName, msgEl.textContent.trim());
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
            if (res.data && res.data.target_rooms) {
                initialRooms = res.data.target_rooms;
                targetRooms.clear();
                initialRooms.forEach(id => targetRooms.add(id));
            }
        } catch (e) { }


        const firstRoom = initialRooms.length > 0 ? initialRooms[0] : '242955291-481';
        console.log(`[${BOT_NAME}] Navigating to room: ${firstRoom}...`);

        setupConsoleListener(mainPage);
        setupNetworkListener(mainPage);
        await mainPage.goto(`https://www.imvu.com/next/chat/room-${firstRoom}/`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);

        const needsLogin = await mainPage.evaluate(() => {
            const loginLink = document.querySelector('.login-link, .nav-login, [href*="login"]');
            const loggedInUser = document.querySelector('.user-menu, .avatar-name, .username');
            return !!loginLink && !loggedInUser;
        });

        if (needsLogin) {
            console.log(`[${BOT_NAME}] 🔐 Not logged in. Starting login flow...`);
            await mainPage.click('.login-link, [href*="login"]').catch(() => {});
            await new Promise(r => setTimeout(r, 4000));
            await mainPage.waitForSelector('input[type="password"]', { timeout: 15000 }).catch(() => null);
            try {
                const usernameInput = await mainPage.$('input[type="text"], input[type="email"], #login_username');
                const passwordInput = await mainPage.$('input[type="password"], #login_password');
                if (usernameInput && passwordInput) {
                    await usernameInput.click({ clickCount: 3 });
                    await usernameInput.type(botMatch.username, { delay: 60 });
                    await passwordInput.click({ clickCount: 3 });
                    await passwordInput.type(botMatch.password, { delay: 60 });
                    await mainPage.keyboard.press('Enter');
                    await new Promise(r => setTimeout(r, 10000));
                    await mainPage.reload({ waitUntil: 'domcontentloaded' });
                }
            } catch (err) { console.error(`Login failed: ${err.message}`); }
        } else {
            console.log(`[${BOT_NAME}] ✅ Already logged in as ${botMatch.username}`);
        }

        console.log(`[${BOT_NAME}] 🚪 Joining room...`);
        await mainPage.waitForFunction(() => {
            const btns = Array.from(document.querySelectorAll('button, .uikit-button, .join-cta, .btn-join, [class*="join"], [role="button"]'));
            const joinBtn = btns.find(b => {
                const text = (b.textContent || b.innerText || '').trim().toUpperCase();
                return text.includes('JOIN') || text.includes('GO TO ROOM') || text.includes('ENTER') || text.includes('CHAT NOW');
            });
            if (joinBtn && joinBtn.offsetWidth > 0) {
                joinBtn.click();
                return true;
            }
            return false;
        }, { timeout: 30000 }).catch(() => { });

        await new Promise(r => setTimeout(r, 5000));
        await setupChatObserver(mainPage);
        console.log(`[${BOT_NAME}] ✅ Ready. Broadcasting in room ${firstRoom}.`);
        
        isRestarting = false;
        isInitialStart = false;
        syncInterval = setInterval(runSyncCycle, 8000);
        
    } catch (e) {
        console.error(`[${BOT_NAME}] Critical error:`, e.message);
        isRestarting = false;
        if (e.message.includes('Connection closed') || e.message.includes('disconnected')) {
            console.log(`[${BOT_NAME}] 🛠 Triggering auto-recovery in 10s...`);
            setTimeout(initBot, 10000);
        }
    }
};

initBot();
