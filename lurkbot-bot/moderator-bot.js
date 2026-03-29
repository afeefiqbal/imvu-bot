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
const welcomeCooldowns = new Map(); // userId -> timestamp
const welcomedUsersGlobal = new Set();
const userLastConfirmed = new Map(); // userId -> timestamp
const roomClosingTimers = new Map(); // roomId -> timestamp
const activeTabRoomIds = new Set(); 
const targetRooms = new Set();
const joiningRooms = new Set();
const roomPages = new Map(); // roomId -> Page instance
let hasStateChange = false;
const pendingJoins = new Map(); // "userId:roomId" -> timeoutRef
const replyCooldown = new Map(); // userId -> timestamp

// --- GLOBAL HELPERS ---
const isBotUser = (userId, username) => {
    if (botMatch.id && userId?.toString() === botMatch.id.toString()) return true;
    if (username && username.toLowerCase() === botUsername) return true;
    return false;
};

let browser = null;
let mainPage = null;
let isSyncing = false;
let isInitialStart = true;
let isRestarting = false;
let syncInterval = null;
let runSyncCycle = async () => { }; 
let sendChatMessage = async () => { }; 

const cleanupProfileLock = () => {
    try {
        const lockPath = path.join(USER_DATA_DIR, 'SingletonLock');
        if (fs.existsSync(lockPath)) {
            console.log(`[${BOT_NAME}] 🧹 Removing stale profile lock...`);
            fs.unlinkSync(lockPath);
        }
    } catch (e) { }
};

const performLogin = async (page) => {
    try {
        if (!page || page.isClosed()) return false;
        const originalUrl = page.url();
        const needsLogin = await page.evaluate(() => {
            const loginLink = document.querySelector('.login-link, .nav-login, [href*="login"]');
            const loggedInUser = document.querySelector('.user-menu, .avatar-name, .username');
            return !!loginLink && !loggedInUser;
        });
        if (!needsLogin) return true;

        console.log(`[${BOT_NAME}] 🔐 Checking login for page: ${originalUrl}`);

        const findForm = async (pOrF) => {
            return await pOrF.evaluate(() => {
                const userInp = document.querySelector('input[name="username"], input[name="email"], #login_username, [placeholder*="Username" i]');
                const passInp = document.querySelector('input[type="password"], #login_password');
                return !!(userInp && passInp);
            });
        };

        let hasForm = await findForm(page);
        if (!hasForm) {
            await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button, a, span, .login-link, [href*="login"]'));
                const loginBtn = btns.find(b => {
                    const t = (b.innerText || b.textContent || '').toUpperCase().trim();
                    return t.includes('LOG IN') || t.includes('SIGN IN') || t === 'LOGIN';
                });
                if (loginBtn) loginBtn.click();
            });
            await new Promise(r => setTimeout(r, 6000));
            hasForm = await findForm(page);
        }

        if (!hasForm && !page.url().includes('/login')) {
            console.log(`[${BOT_NAME}] ⚠️ No form visible. Forcing direct login navigation...`);
            await page.goto('https://www.imvu.com/login/', { waitUntil: 'domcontentloaded' }).catch(() => {});
            await new Promise(r => setTimeout(r, 6000));
            hasForm = await findForm(page);
        }

        const targets = [page, ...page.frames()];
        for (const t of targets) {
            const filled = await t.evaluate((u, p) => {
                const userInp = document.querySelector('input[name="username"], input[name="email"], #login_username, [placeholder*="Username" i]');
                const passInp = document.querySelector('input[type="password"], #login_password');
                if (userInp && passInp) {
                    userInp.focus();
                    userInp.value = u;
                    userInp.dispatchEvent(new Event('input', { bubbles: true }));
                    passInp.focus();
                    passInp.value = p;
                    passInp.dispatchEvent(new Event('input', { bubbles: true }));
                    return true;
                }
                return false;
            }, botMatch.username, botMatch.password).catch(() => false);

            if (filled) {
                await page.keyboard.press('Enter');
                await new Promise(r => setTimeout(r, 12000));
                
                // --- SELF-ID DISCOVERY ---
                const selfId = await page.evaluate(() => {
                    const nextData = window.next?.props?.pageProps?.initialState?.user?.profile?.id || 
                                     localStorage.getItem('av_id') || 
                                     document.querySelector('[data-user-id]')?.getAttribute('data-user-id');
                    return nextData;
                }).catch(() => null);
                
                if (selfId && !botMatch.id) {
                    botMatch.id = selfId.toString();
                    console.log(`[${BOT_NAME}] 🆔 Discovered self-ID: ${botMatch.id}`);
                }

                if (!page.url().includes(originalUrl) && originalUrl.includes('room-')) {
                    console.log(`[${BOT_NAME}] ✅ Login success. Returning to room...`);
                    await page.goto(originalUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
                    await new Promise(r => setTimeout(r, 8000));
                } else {
                    console.log(`[${BOT_NAME}] ✅ Login completed`);
                }
                
                // 🔥 EXTRACT SESSION FOR WS BOT
                await extractSession(page);
                return true;
            }
        }
    } catch (e) {
        console.error(`[${BOT_NAME}] ❌ Login Error:`, e.message);
    }
    return false;
};

const clickJoinButton = async (page) => {
    try {
        if (!page || page.isClosed()) return false;
        console.log(`[${BOT_NAME}] 🚪 Attempting to join room...`);
        
        for (let i = 0; i < 3; i++) {
            // Interact with the page to ensure focus
            
            // 🔥 DISMISS POPUPS (Daily Spin, Welcome, etc.)
            await page.evaluate(() => {
                const selectors = ['.modal-close', '.common-modal-close', '[class*="close"]', '[class*="dismiss"]', '.modal-x'];
                selectors.forEach(sel => {
                    document.querySelectorAll(sel).forEach(el => {
                        if (el.offsetWidth > 0 || el.offsetHeight > 0) el.click();
                    });
                });
            }).catch(() => {});

            await page.mouse.click(640, 400).catch(() => {});
            
            const success = await page.waitForFunction(() => {
                const btns = Array.from(document.querySelectorAll(
                    'button, .uikit-button, .join-cta, .btn-join, [class*="join"], [role="button"], a, div[class*="Button"]'
                ));

                const joinBtn = btns.find(b => {
                    const text = (b.textContent || b.innerText || b.getAttribute('aria-label') || b.title || '').trim().toUpperCase();
                    return (
                        text.includes('JOIN') ||
                        text.includes('GO TO') ||
                        text.includes('ENTER') ||
                        text.includes('CHAT') ||
                        text.includes('START') ||
                        text.includes('NOW') ||
                        text.includes('GO')
                    );
                });

                if (joinBtn && joinBtn.offsetWidth > 0) {
                    window._targetBtn = joinBtn;
                    return true;
                }
                return false;
            }, { timeout: 15000 }).then(() => true).catch(() => false);
            
            if (success) {
                const box = await page.evaluate(() => {
                    const b = window._targetBtn;
                    if (!b) return null;
                    const r = b.getBoundingClientRect();
                    return { x: r.left, y: r.top, w: r.width, h: r.height };
                });

                if (box) {
                    console.log(`[JOIN] 🎯 Precision clicking button at ${Math.round(box.x)},${Math.round(box.y)}`);
                    await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2);
                } else {
                    await page.evaluate(() => window._targetBtn?.click());
                }
                
                await new Promise(r => setTimeout(r, 4000));
                // Check if button is gone
                const gone = await page.evaluate(() => {
                    return !Array.from(document.querySelectorAll('button')).find(b => (b.innerText || '').toUpperCase().includes('JOIN'));
                });
                if (gone) {
                    console.log(`[${BOT_NAME}] ✅ Joined room`);
                    return true;
                }
            }
            await new Promise(r => setTimeout(r, 3000));
        }
        return false;
    } catch (e) { return false; }
};

const handleWSJoin = async (userId, roomId = null) => {
    const rooms = roomId ? [roomId] : Array.from(roomStates.keys());
    for (const rid of rooms) {
        if (!targetRooms.has(rid) && !roomPages.has(rid)) {
            console.log(`[WS] ⚠️ Ignoring external room ${rid}`);
            continue;
        }

        activeTabRoomIds.add(rid);
        const state = roomStates.get(rid) || new Set();
        roomStates.set(rid, state);
        if (state.has(userId)) continue;

        console.log(`[WS] ✅ JOIN: ${userId} in ${rid}`);
        
        const trackingKey = `${userId}:${rid}`;
        
        // --- ELITE RECONNECT GUARD ---
        if (state.has(userId) && lastSeen.get(trackingKey) && Date.now() - lastSeen.get(trackingKey) < 2000) {
             console.log(`[WS] ⚡ Reconnect detected for ${userId} in ${rid}. Skipping welcome.`);
             return;
        }

        state.add(userId);
        const now = Date.now();
        lastSeen.set(trackingKey, now);
        userLastConfirmed.set(trackingKey, now);

        let username = userIdToUsername.get(userId);
        for (let i = 0; i < 3 && !username; i++) {
            await new Promise(r => setTimeout(r, 1000));
            username = userIdToUsername.get(userId);
        }
        username = username || `user_${userId}`;
        if (username.startsWith('user_')) {
            await new Promise(r => setTimeout(r, 500));
            username = userIdToUsername.get(userId) || username;
        }

        const welcomeKey = `${userId}:${rid}`;
        const lastWelcome = welcomeCooldowns.get(welcomeKey) || 0;
        
        const isBot = isBotUser(userId, username);

        if (now - lastWelcome > 30000 && 
            !welcomedUsersGlobal.has(welcomeKey) && 
            !isBot) {
            
            console.log(`[${BOT_NAME}] 🎉 Triggering Welcome for ${username} in ${rid}`);
            let page = roomPages.get(rid);
            if (!page || page.isClosed()) {
                await new Promise(r => setTimeout(r, 2000));
                page = roomPages.get(rid);
            }

            if (page && !page.isClosed()) {
                await sendChatMessage(page, `Welcome @${username}! 👋`).catch(() => {});
            }
            welcomeCooldowns.set(welcomeKey, now);
            welcomedUsersGlobal.add(welcomeKey);
            
            // --- AUTO CLEANUP ---
            setTimeout(() => welcomeCooldowns.delete(welcomeKey), 10 * 60 * 1000);
            setTimeout(() => welcomedUsersGlobal.delete(welcomeKey), 10 * 60 * 1000);
        }

        hasStateChange = true;
        if (!isSyncing) runSyncCycle(true).catch(() => {});
    }
};

const handleWSLeave = async (userId, roomId = null) => {
    const rooms = roomId ? [roomId] : Array.from(roomStates.keys());
    for (const rid of rooms) {
        const state = roomStates.get(rid);
        if (!state || !state.has(userId)) continue;

        console.log(`[WS] ❌ LEAVE: ${userId} from ${rid}`);
        state.delete(userId);
        const trackingKey = `${userId}:${rid}`;
        lastSeen.delete(trackingKey);
        userLastConfirmed.delete(trackingKey);
        hasStateChange = true;
        if (!isSyncing) runSyncCycle(true).catch(() => {});
    }
};

const processIMVUMessage = (raw) => {
    try {
        if (typeof raw !== 'string') return;
        const data = JSON.parse(raw);
        if (!data.message) return;

        // --- HANDLE PRESENCE (PARTICIPANTS) ---
        if (data.record === 'msg_g2c_send_message' && data.mount?.includes('participants')) {
            let decoded;
            try {
                decoded = JSON.parse(Buffer.from(data.message, 'base64').toString('utf-8'));
            } catch (err) { return; }
            
            const action = decoded.action; 
            const objects = decoded.objects || [];

            for (const obj of objects) {
                const userMatch = obj.match(/user-(\d+)/);
                const roomMatch = obj.match(/chat-([\d\-]+)/);
                if (!userMatch || !roomMatch) continue;

                const userId = userMatch[1];
                const roomId = roomMatch[1];
                const joinKey = `${userId}:${roomId}`;

                if (action === 'created') {
                    if (pendingJoins.has(joinKey)) clearTimeout(pendingJoins.get(joinKey));
                    const timeout = setTimeout(() => {
                        handleWSJoin(userId, roomId);
                        pendingJoins.delete(joinKey);
                    }, 1000);
                    pendingJoins.set(joinKey, timeout);
                    
                    // --- AUTO CLEANUP ---
                    setTimeout(() => pendingJoins.delete(joinKey), 10000);
                    
                } else if (action === 'deleted') {
                    if (pendingJoins.has(joinKey)) {
                        clearTimeout(pendingJoins.get(joinKey));
                        pendingJoins.delete(joinKey);
                    } else {
                        handleWSLeave(userId, roomId);
                    }
                }
            }
        }

        // --- HANDLE CHAT MESSAGES ---
        if (data.mount === 'messages' || data.record === 'msg_g2c_send_message' && data.mount?.includes('messages')) {
            try {
                const decoded = JSON.parse(Buffer.from(data.message, 'base64').toString('utf-8'));
                const userId = decoded.userId?.toString();
                const msgText = decoded.message;

                if (!userId || !msgText || msgText.startsWith('*')) return;
                
                handleIncomingChat(userId, msgText, data.queue);
            } catch (e) { }
        }
    } catch (e) { }
};

const generateReply = (msg, username) => {
    const text = msg.toLowerCase();
    
    if (text.includes('hi') || text.includes('hello') || text.includes('hey')) {
        const variants = [`Hey @${username}! 👋`, `Hi there ${username} 😊`, `Hello ${username}, how’s it going?` ];
        return variants[Math.floor(Math.random() * variants.length)];
    }
    
    if (text.includes('how are you') || text.includes('hru')) {
         const variants = [`I'm doing great, ${username}! Thanks for asking. 😄`, `I'm good, ${username}, enjoying the chat!`, `Doing well! How about you?` ];
         return variants[Math.floor(Math.random() * variants.length)];
    }
    
    if (text.includes('bye')) return `See you later, ${username}! 👋`;
    if (text.includes('bot') || text.includes('moderator')) return `I'm just here to keep the room safe! 🛡️`;
    return null;
};

const handleIncomingChat = async (userId, message, queue) => {
    if (!botMatch.id || userId === botMatch.id.toString() || userIdToUsername.get(userId)?.toLowerCase() === botUsername) return;

    const roomMatch = queue?.match(/chat-([\d\-]+)/);
    const rid = roomMatch ? roomMatch[1] : null;
    if (!rid) return;

    const username = userIdToUsername.get(userId) || `user_${userId}`;
    console.log(`[CHAT][${rid}] ${username}: ${message}`);

    const now = Date.now();
    const lastReply = replyCooldown.get(userId) || 0;
    if (now - lastReply < 5000) return; // 5s spam guard

    const reply = generateReply(message, username);
    if (!reply) return;

    replyCooldown.set(userId, now);

    const page = roomPages.get(rid);
    if (page && !page.isClosed()) {
        // --- NATURAL TYPING DELAY ---
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
        
        // 🔥 MINIMIZE PUPPETEER CHAT (30% chance)
        if (Math.random() < 0.3) {
            await sendChatMessage(page, reply).catch(() => {});
        }
    }
};

const activateAvatar = async (page) => {
    try {
        // Wait for WebGL canvas
        await page.waitForFunction(() => {
            const canvas = document.querySelector('canvas');
            return canvas && canvas.width > 0;
        }, { timeout: 20000 });

        // Real interaction trigger
        await page.evaluate(() => {
            const canvas = document.querySelector('canvas');
            if (canvas) {
                canvas.click();
                canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            }
        });

        // Small movement (engine trigger)
        await page.keyboard.press('ArrowUp');
        await page.keyboard.press('ArrowDown');

        console.log(`[BOT] ✅ Avatar activated`);
    } catch (e) {
        console.log(`[BOT] ⚠️ Avatar activation failed`);
    }
};

const setupPageFocus = async (page) => {
    try {
        await page.evaluate(() => {
            window.blur();
        }).catch(() => {});
    } catch (e) {}
};

const extractSession = async (page) => {
    try {
        if (!page || page.isClosed()) return;
        const cookies = await page.cookies();
        const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        const userAgent = await page.evaluate(() => navigator.userAgent);

        const manifest = {
            cookies: cookieString,
            userAgent: userAgent,
            wsUrl: "wss://wss-imq.imvu.com/streaming/imvu_pre",
            timestamp: new Date().toISOString()
        };

        const manifestPath = path.join(__dirname, 'ws_manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        console.log(`[${BOT_NAME}] 🔐 Session manifest updated for WS bot`);
    } catch (e) {
        console.error(`[${BOT_NAME}] ❌ Session extraction failed:`, e.message);
    }
};

const setupNetworkSniffing = async (page) => {
    try {
        if (!page || page.isClosed()) return;
        await page.exposeFunction('handleIMVUEvent', async (event) => {
            const { type, data } = event;
            if (type === 'ws_message') processIMVUMessage(data);
            if (type === 'fetch_response') processIMVUMessage(data.body);
        }).catch(() => { });
    } catch (e) { }

    await page.evaluateOnNewDocument(() => {
        (function () {
            const sendToNode = (type, data) => {
                window.dispatchEvent(new CustomEvent('IMVU_EVENT', { detail: { type, data } }));
            };
            const OriginalWebSocket = window.WebSocket;
            window.WebSocket = function (...args) {
                const ws = new OriginalWebSocket(...args);
                ws.addEventListener('message', (e) => sendToNode('ws_message', e.data));
                return ws;
            };
            const originalFetch = window.fetch;
            window.fetch = async (...args) => {
                const res = await originalFetch(...args);
                try {
                    const clone = res.clone();
                    clone.text().then(t => sendToNode('fetch_response', { url: args[0], body: t }));
                } catch (e) { }
                return res;
            };
        })();
    });
};

const initBot = async () => {
    if (isRestarting) return;
    isRestarting = true;
    
    try {
        if (browser) {
            console.log(`[${BOT_NAME}] 🔄 Browser restarting...`);
            if (syncInterval) clearInterval(syncInterval);
            await browser.close().catch(() => {});
            browser = null; 
        }

        cleanupProfileLock();

        browser = await puppeteer.launch({
            headless: false,
            userDataDir: USER_DATA_DIR,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-web-security', 
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-blink-features=AutomationControlled',
                '--enable-webgl',
                '--use-gl=angle',
                '--ignore-gpu-blocklist',
                '--window-position=-10000,-10000',
                '--window-size=1280,800',
                '--disable-infobars',
                '--disable-notifications',
                '--mute-audio',
                '--disable-dev-shm-usage',
                '--disable-gpu-sandbox',
                '--no-zygote'
            ]
        });

        browser.on('disconnected', () => {
            console.log(`[${BOT_NAME}] 🚨 Browser process lost! Recovering in 5s...`);
            setTimeout(() => {
                isRestarting = false; // Reset lock for recovery
                initBot();
            }, 5000);
        });

        mainPage = (await browser.pages())[0];
        await mainPage.setViewport({ width: 1280, height: 800 });

        sendChatMessage = async (targetPage, message) => {
            try {
                if (targetPage.isClosed()) return false;
                const findInput = async () => {
                    const sel = ['textarea[placeholder*="Say something"]', '.uikit-chat-input-textarea', 'textarea.chat-input', '[role="textbox"]', 'textarea'];
                    for (const s of sel) {
                        const el = await targetPage.$(s).catch(() => null);
                        if (el && await el.boundingBox()) return el;
                    }
                    return null;
                };

                let input = await findInput();
                if (!input) {
                    const bSel = 'button.chat-bubble, .uikit-chat-bubble';
                    const b = await targetPage.$(bSel).catch(() => null);
                    if (b) {
                        await b.click().catch(() => {});
                        await new Promise(r => setTimeout(r, 2000));
                        input = await findInput();
                    }
                }

                if (input) {
                    await input.click({ clickCount: 3 }).catch(() => {});
                    
                    let sent = false;
                    for (let i = 0; i < 2 && !sent; i++) {
                        try {
                            await targetPage.keyboard.type(message, { delay: 20 });
                            await targetPage.keyboard.press('Enter');
                            
                            // Fallback Click
                            await targetPage.evaluate(() => {
                                 const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
                                 const send = btns.find(b => (b.innerText || '').toUpperCase().trim() === 'SEND' || b.querySelector('svg'));
                                 if (send) send.click();
                            }).catch(() => {});
                            sent = true;
                        } catch (e) { }
                    }
                    return sent;
                }
            } catch (err) { }
            return false;
        };

        runSyncCycle = async (force = false) => {
            if (!browser || !browser.isConnected()) return initBot();
            if (force) hasStateChange = true;
            if (isSyncing) return;
            isSyncing = true;

            try {
                do {
                    hasStateChange = false;
                    const roomsToSync = [];
                    
                    for (const [rid, p] of roomPages.entries()) {
                        if (p.isClosed()) { 
                            console.log(`[${BOT_NAME}] ⚠️ Page crashed for ${rid}, rejoining...`);
                            roomPages.delete(rid); 
                            roomStates.delete(rid);
                            targetRooms.add(rid); // Force Rejoin
                            continue; 
                        }
                        
                        const currentUrl = p.url().split('?')[0];
                        console.log(`[${BOT_NAME}] 🔄 Syncing room ${rid} (Page: ${currentUrl})`);
                        
                        // 🔥 RESCUE REDIRECT: Ensure we are actually in the target room
                        if (!currentUrl.includes(`room-${rid}`)) {
                             console.log(`[RESCUE] 🚨 Not in room! Redirecting back to ${rid}...`);
                             await p.goto(`https://www.imvu.com/next/chat/room-${rid}/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
                             await new Promise(r => setTimeout(r, 8000));
                             continue;
                        }

                        // 🔥 OPEN PARTICIPANTS PANEL: IMVU doesn't render users until panel is open
                        await p.evaluate(() => {
                            const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
                            const peopleBtn = btns.find(b => {
                                const t = (b.innerText || b.textContent || '').toLowerCase();
                                return t.includes('people') || t.includes('participants') || t.includes('visitors');
                            });
                            if (peopleBtn && peopleBtn.offsetWidth > 0) peopleBtn.click();
                        }).catch(() => {});

                        // Wait for at least one user to render
                        await p.waitForFunction(() => {
                            return document.querySelectorAll('.participant-avatar, [data-user-id], [href*="/av/"]').length > 0;
                        }, { timeout: 15000 }).catch(() => {});

                        const data = await p.evaluate((rid) => {
                             const ids = new Set();
                             document.querySelectorAll('.participant-avatar, [data-user-id], [href*="/av/"], [src*="user-"]').forEach(el => {
                                 if (el.offsetWidth === 0) return;
                                 const id = el.getAttribute('data-user-id') || (el.href || el.src || '').match(/(?:user-|av\/)(\d+)/)?.[1];
                                 if (id) ids.add(id);
                             });
                             const nameEl = document.querySelector('.chat-header-room-name, h1');
                             const roomName = (nameEl ? nameEl.innerText.trim() : 'Unknown').replace(/^IMVU\s*:\s*/i, '');
                             return { visitors: Array.from(ids), roomName };
                        }, rid).catch(() => null);

                        if (data) {
                            if (!roomStates.has(rid)) roomStates.set(rid, new Set());
                            const state = roomStates.get(rid);

                            // 🔥 Initial Population Bridge (No Welcome for existing users)
                            for (const id of data.visitors) {
                                if (!state.has(id)) {
                                    console.log(`[INIT] 👤 Found existing user ${id} in ${rid}`);
                                    state.add(id);

                                    const trackingKey = `${id}:${rid}`;
                                    const now = Date.now();
                                    lastSeen.set(trackingKey, now);
                                    userLastConfirmed.set(trackingKey, now);
                                    
                                    // 🚫 PREVENT WELCOME for people already there
                                    const welcomeKey = `${id}:${rid}`;
                                    welcomedUsersGlobal.add(welcomeKey);
                                    welcomeCooldowns.set(welcomeKey, now);
                                }
                            }

                            const finalVisitors = Array.from(state).map(id => userIdToUsername.get(id) || `user_${id}`);
                            roomsToSync.push({ id: rid, visitors: finalVisitors, population: state.size, name: data.roomName });
                        }
                    }

                    for (const rid of Array.from(roomStates.keys())) {
                        if (!targetRooms.has(rid) && !roomPages.has(rid)) {
                            console.log(`[${BOT_NAME}] 🧹 Removing untargeted room: ${rid}`);
                            roomsToSync.push({ id: rid, visitors: [], population: 0 });
                            roomStates.delete(rid);
                        }
                    }

                    if (roomsToSync.length > 0) {
                        const res = await axios.post(`${BACKEND_URL}/api/rooms/sync`, { rooms: roomsToSync, bot_name: BOT_NAME, bot_username: botMatch.username }).catch(() => ({ data: {} }));
                        for (const r of roomsToSync) {
                             console.log(`[DATA][Room:${r.id}] 👥 Guests (${r.population}): ${r.visitors.join(', ')}`);
                        }
                        if (res.data?.target_rooms) {
                            targetRooms.clear();
                            res.data.target_rooms.forEach(id => targetRooms.add(id));
                        }
                    }
                    isInitialStart = false;
                } while (hasStateChange);

                for (const rid of targetRooms) {
                    if (!roomPages.has(rid) && !joiningRooms.has(rid)) {
                        joiningRooms.add(rid);
                        (async () => {
                            try {
                                const newPage = await browser.newPage();
                                roomPages.set(rid, newPage);
                                setupConsoleListener(newPage);
                                setupNetworkListener(newPage);
                                await setupPageFocus(newPage);
                                await setupNetworkSniffing(newPage);
                                await newPage.goto(`https://www.imvu.com/next/chat/room-${rid}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
                                
                                await newPage.waitForSelector('body', { timeout: 15000 }).catch(() => {});
                                await performLogin(newPage);
                                
                                // --- AVATAR ACTIVATION PROTOCOL ---
                                await clickJoinButton(newPage);
                                await new Promise(r => setTimeout(r, 4000));
                                
                                if (newPage.url().includes('room-')) {
                                    await activateAvatar(newPage);
                                    
                                    console.log(`[${BOT_NAME}] ⏳ Waiting for room to fully load users...`);
                                    await new Promise(r => setTimeout(r, 8000));

                                    // --- KEEP PUPPETEER ALIVE ---
                                    setInterval(async () => {
                                        try {
                                            if (!newPage.isClosed()) {
                                                await newPage.mouse.move(
                                                    400 + Math.random() * 200,
                                                    300 + Math.random() * 200
                                                );
                                            }
                                        } catch {}
                                    }, 15000);
                                }
                                
                                await setupChatObserver(newPage);
                                await newPage.evaluate(() => {
                                    window.addEventListener('IMVU_EVENT', (e) => window.handleIMVUEvent(e.detail));
                                }).catch(() => {});
                                
                            } catch (e) { 
                                console.error(`[${BOT_NAME}] Join error ${rid}:`, e.message);
                                roomPages.delete(rid); 
                            } finally { 
                                joiningRooms.delete(rid); 
                            }
                        })();
                    }
                }

                const now = Date.now();
                for (const [rid, p] of roomPages.entries()) {
                    if (!targetRooms.has(rid)) {
                        if (!roomClosingTimers.has(rid)) {
                            console.log(`[${BOT_NAME}] ⏳ Scheduling exit for ${rid}`);
                            roomClosingTimers.set(rid, now + 20000);
                        } else if (now > roomClosingTimers.get(rid)) {
                            console.log(`[${BOT_NAME}] 🚪 Closing untargeted tab: ${rid}`);
                            if (p && !p.isClosed()) {
                                await p.close().catch(() => {});
                            }
                            roomClosingTimers.delete(rid);
                            roomPages.delete(rid);
                            roomStates.delete(rid);
                        }
                    } else {
                        roomClosingTimers.delete(rid);
                    }
                }
            } catch (e) {
                console.error(`Tracker Error:`, e.message);
            } finally {
                isSyncing = false;
                console.log(`[${BOT_NAME}] ✨ Sync cycle complete.`);
            }
        };

        const firstRes = await axios.post(`${BACKEND_URL}/api/rooms/sync`, { rooms: [], bot_name: BOT_NAME, bot_username: botMatch.username }).catch(() => ({ data: {} }));
        if (firstRes.data?.target_rooms) firstRes.data.target_rooms.forEach(id => targetRooms.add(id));
        const first = Array.from(targetRooms)[0] || '242955291-481';
        
        roomPages.set(first, mainPage);
        setupConsoleListener(mainPage);
        setupNetworkListener(mainPage);
        await setupPageFocus(mainPage);
        await setupNetworkSniffing(mainPage);
        await mainPage.goto(`https://www.imvu.com/next/chat/room-${first}/`, { waitUntil: 'domcontentloaded' });
        
        await mainPage.waitForSelector('body', { timeout: 15000 }).catch(() => {});
        await performLogin(mainPage);

        // --- AVATAR ACTIVATION PROTOCOL ---
        await clickJoinButton(mainPage);
        await new Promise(r => setTimeout(r, 4000));
        
        if (mainPage.url().includes('room-')) {
            await activateAvatar(mainPage);
            
            console.log(`[${BOT_NAME}] ⏳ Waiting for room to fully load users...`);
            await new Promise(r => setTimeout(r, 8000));

            // --- KEEP PUPPETEER ALIVE ---
            setInterval(async () => {
                try {
                    if (!mainPage.isClosed()) {
                        await mainPage.mouse.move(
                            400 + Math.random() * 200,
                            300 + Math.random() * 200
                        );
                    }
                } catch {}
            }, 15000);
        }

        await setupChatObserver(mainPage);
        await mainPage.evaluate(() => window.addEventListener('IMVU_EVENT', e => window.handleIMVUEvent(e.detail)));
        
        isRestarting = false;
        syncInterval = setInterval(() => {
            runSyncCycle().catch(() => {});
        }, 12000);

        // 🔥 AUTO-REFRESH SESSION EVERY 10 MIN
        setInterval(async () => {
            if (mainPage && !mainPage.isClosed()) {
                console.log(`[${BOT_NAME}] 🔄 Refreshing session manifest...`);
                await extractSession(mainPage);
            }
        }, 10 * 60 * 1000);
        console.log(`[${BOT_NAME}] 🚀 Bot online and tracking rooms.`);
        
    } catch (e) {
        console.error(`Init Error:`, e.message);
        isRestarting = false;
        setTimeout(initBot, 10000);
    }
};

const setupNetworkListener = (p) => {
    p.on('response', async (res) => {
        try {
            if (!res.url().includes('api.imvu.com') || !res.headers()['content-type']?.includes('json')) return;
            const json = await res.json();
            if (json.denormalized) {
                for (const [k, v] of Object.entries(json.denormalized)) {
                    const m = k.match(/user-(\d+)/);
                    if (m && v?.data?.username) {
                        let username = v.data.username;
                        if (username.toLowerCase().startsWith('guest_')) username = username.substring(6);
                        userIdToUsername.set(m[1], username);
                    }
                }
            }
        } catch (e) { }
    });
};

const setupConsoleListener = (p) => p.on('console', m => { 
    if (m.text().includes('DEBUG')) console.log(`[BROWSER] ${m.text()}`); 
});

const setupChatObserver = async (p) => {
    try {
        const bSel = 'button.chat-bubble, .uikit-chat-bubble';
        await p.waitForSelector(bSel, { timeout: 10000 }).catch(() => {});
        await p.evaluate(s => document.querySelector(s)?.click(), bSel).catch(() => {});
    } catch (e) { }
};

initBot();
