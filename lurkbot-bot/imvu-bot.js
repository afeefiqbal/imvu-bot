import puppeteer from 'puppeteer';
import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BOT_NAME      = process.env.BOT_NAME      || 'UnnamedBot';
const USER_DATA_DIR = path.resolve(__dirname, 'profiles', BOT_NAME);
const BOT_PROXY     = process.env.BOT_PROXY     || null;
const BACKEND_URL   = "http://127.0.0.1:8000";

(async () => {
    try {
        console.log(`🚀 Starting ${BOT_NAME} (Alexa) in SIMPLE mode...`);
        
        const launchArgs = [
            "--start-maximized", 
            "--no-sandbox", 
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled"
        ];
        if (BOT_PROXY) launchArgs.push(`--proxy-server=${BOT_PROXY}`);

        const browser = await puppeteer.launch({
            headless: true,
            executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            userDataDir: USER_DATA_DIR,
            args: launchArgs,
            defaultViewport: null
        });

        const pages = await browser.pages();
        const page = pages.length > 0 ? pages[0] : await browser.newPage();

        // --- LOAD CREDENTIALS ---
        const botsPath = path.resolve(__dirname, 'bots.json');
        const bots = JSON.parse(fs.readFileSync(botsPath, 'utf8'));
        const botMatch = bots.find(b => b.username === BOT_NAME) || bots[0];
        console.log(`[${BOT_NAME}] Using account: ${botMatch.username}`);

        console.log(`[${BOT_NAME}] Fetching target rooms for bot...`);
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

        // --- STEP 1: Go directly to the first room ---
        console.log(`[${BOT_NAME}] Using account: ${botMatch.username}`);
        console.log(`[${BOT_NAME}] Going to initial room: ${firstRoom}...`);
        await page.goto(`https://www.imvu.com/next/chat/room-${firstRoom}/`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
        await new Promise(r => setTimeout(r, 5000));
        await page.screenshot({ path: path.join(__dirname, 'debug-bot.png') });

        // --- STEP 2: Check if guest (login-link visible in nav) ---
        const isGuest = await page.$('.login-link') !== null;
        console.log(`[${BOT_NAME}] Guest mode: ${isGuest}`);

        if (isGuest) {
            console.log(`[${BOT_NAME}] Clicking LOG IN nav link...`);
            await page.click('.login-link');
            await new Promise(r => setTimeout(r, 3000));
            await page.screenshot({ path: path.join(__dirname, 'debug-bot.png') });

            // Wait for the modal login form
            await page.waitForSelector('input[type="password"]', { timeout: 15000 }).catch(() => null);

            try {
                const usernameInput = await page.$('input[type="text"], input[type="email"]');
                const passwordInput = await page.$('input[type="password"]');

                if (usernameInput) {
                    await usernameInput.click({ clickCount: 3 });
                    await usernameInput.type(botMatch.username, { delay: 60 });
                    console.log(`[${BOT_NAME}] Typed username: ${botMatch.username}`);
                }
                if (passwordInput) {
                    await passwordInput.click({ clickCount: 3 });
                    await passwordInput.type(botMatch.password, { delay: 60 });
                    console.log(`[${BOT_NAME}] Typed password.`);
                }

                // Press Enter to submit
                await page.keyboard.press('Enter');
                console.log(`[${BOT_NAME}] Submitted. Waiting for login...`);
                await new Promise(r => setTimeout(r, 8000));
                await page.screenshot({ path: path.join(__dirname, 'debug-bot.png') });
            } catch (err) {
                console.error(`[${BOT_NAME}] Login error: ${err.message}`);
            }
        } else {
            console.log(`[${BOT_NAME}] Already logged in!`);
        }

        // --- STEP 3: Click Join if visible ---
        console.log(`[${BOT_NAME}] Checking for Join button...`);
        const joinBtn = await page.waitForSelector('button.cs2-btn-primary, button[class*="join"]', { timeout: 15000 }).catch(() => null);
        if (joinBtn) {
            console.log(`[${BOT_NAME}] Forcing JOIN click via evaluate...`);
            await page.evaluate(() => {
                const btn = document.querySelector('button.cs2-btn-primary, button[class*="join"]');
                if (btn) btn.click();
            });
            await new Promise(r => setTimeout(r, 8000));
        } else {
            console.log(`[${BOT_NAME}] Already in room or no join button found.`);
        }

        let lastSyncHash = "";
        let isFirstSync = true;
        const targetRooms = new Set(); // Using GLOBAL Set
        const joiningRooms = new Set();
        const tabStates = new Map(); // Global tracking for each roomId
        const processedGlobal = new Set();
        const lastSentGlobal = new Map();

        // --- THE MASSIVE 6000+ WORD SPAM LIBRARY ---
        const spamLibrary = [];
        for (let i = 0; i < 500; i++) {
            spamLibrary.push(`Chat message #${i}: This is a high-volume transmission intended for stress-testing and room population engagement. We are currently broadcasting a sequence of over six thousand words to verify the bot's endurance and the room's throughput capacity. Each word is carefully curated to ensure maximum stability. Let me tell you about the future of automation and how we can achieve great things through persistent and reliable logic systems. Imagine a world where every task is optimized. ${i % 10 === 0 ? "IMPORTANT: This system is operating at peak efficiency." : "Keep chatting and stay active!"}`);
        }
        
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
                const imvuPages = allPages.filter(p => p.url().includes('imvu.com/next/chat') && p.url().includes('room-'));
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
                        roomsToSync.push({
                            id: String(roomId).trim(),
                            name: data.roomName,
                            image_url: data.roomUrl,
                            visitors: data.visitors,
                            population: data.population || 0
                        });
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
                        const imvuPages = (await browser.pages()).filter(pg => pg.url().includes('imvu.com/next/chat') && pg.url().includes('room-'));
                        
                        // 1. Join new global target rooms
                        for (const tRoom of currentTargets) {
                            const normalized = tRoom;
                            const isAlreadyOpen = imvuPages.some(pg => pg.url().includes(`room-${normalized}`));
                            
                            if (isAlreadyOpen) {
                                // console.log(`[${BOT_NAME}] Room ${normalized} already open in a tab.`);
                                continue;
                            }
                            
                            if (joiningRooms.has(normalized)) {
                                console.log(`[${BOT_NAME}] Still waiting for Room ${normalized} to finish opening...`);
                                continue;
                            }

                            joiningRooms.add(normalized);
                            console.log(`[${BOT_NAME}] 🆕 JOIN COMMAND: Opening new tab for Room ${normalized}`);
                            try {
                                const newPage = await browser.newPage();
                                await newPage.goto(`https://www.imvu.com/next/chat/room-${normalized}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
                            } catch (err) {
                                console.error(`[${BOT_NAME}] ❌ FAILED to open Room ${normalized}: ${err.message}`);
                            } finally {
                                // Give it 30s to load before we allow trying again
                                setTimeout(() => joiningRooms.delete(normalized), 30000);
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
                                await say(targetPg, msg.pending_message);
                            }
                        }
                    }
                }
                
                // --- DEBUG: Save screenshot every interval to see what the bot sees ---
                if (imvuPages.length > 0) {
                    await imvuPages[0].screenshot({ path: path.join(__dirname, 'debug-bot.png') }).catch(() => null);
                }

            } catch (e) { /* ignore */ }
            finally {
                isSyncing = false;
            }
        }, 25000 + Math.random() * 10000); // 25-35s sync interval (much safer)

        // --- THE MASSIVE SPAM ENGINE ---
        setInterval(async () => {
            const allPages = await browser.pages();
            const imvuPages = allPages.filter(p => p.url().includes('imvu.com/next/chat'));

            for (const p of imvuPages) {
                const u = p.url();
                const match = u.match(/room-([\d\-]+)/);
                const roomId = match ? match[1] : null;

                const spamOn = activeFilamentSpamRooms.some((r) => String(r).trim() === String(roomId).trim());
                if (roomId && spamOn) {
                    // SLOWER SPAM: Wait a random long time
                    await new Promise(r => setTimeout(r, Math.random() * 20000));
                    
                    const massiveMsg = spamLibrary[Math.floor(Math.random() * spamLibrary.length)];
                    console.log(`[SAFE SPAM] Room ${roomId} | Choosing fragment...`);
                    await say(p, massiveMsg);
                }
            }
        }, 45000 + Math.random() * 50000); // 45-95s spam interval (Very safe)

        let isListening = false;
        // --- CHAT LISTENER ---
        setInterval(async () => {
            if (isListening) return;
            isListening = true;
            try {
                const allPages = await browser.pages();
                const imvuPages = allPages.filter(p => p.url().includes('imvu.com/next/chat'));

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

                    // Diagnostic Scraper
                    const pageState = await p.evaluate(() => {
                        const bodyText = document.body.innerText;
                        const title = document.title;
                        
                        // Critical detection selectors
                        const joinBtn = document.querySelector('button.cs2-btn-primary, button[class*="join"], .btn-join');
                        const chatInput = document.querySelector('textarea.input-text, .input-text, [class*="chat-input"]');
                        const chatMessages = document.querySelector('.cs2-chat-messages, .message-list, .chat-messages');
                        const roomActions = document.querySelector('.cs2-top-actions, .room-menu');

                        let error = null;
                        if (bodyText.includes('Room is full')) error = 'ROOM_FULL';
                        else if (bodyText.includes('Access Denied')) error = 'ACCESS_DENIED';
                        else if (bodyText.includes('Please log in')) error = 'LOGGED_OUT';
                        
                        // STRICTOR JOINED HEURISTIC:
                        // 1. Must see chat messages or room actions
                        // 2. Must NOT see the Join button anymore
                        const isPhysicallyInside = (!!chatMessages || !!roomActions) && !joinBtn;
                        
                        // fallback if those aren't found but chat input IS there
                        const representsJoined = isPhysicallyInside || (!!chatInput && !joinBtn);

                        return { 
                            hasJoinBtn: !!joinBtn && (joinBtn.offsetWidth > 0), 
                            isJoined: representsJoined, 
                            error 
                        };
                    }).catch(() => ({ hasJoinBtn: false, isJoined: false, error: 'EVAL_FAIL' }));

                    if (pageState.error) {
                        console.log(`[${BOT_NAME}][Room:${roomId}] Room Blocker: ${pageState.error}`);
                        if (pageState.error === 'LOGGED_OUT') {
                             console.log(`[${BOT_NAME}] Session expired on this tab. Bot might need re-login.`);
                        }
                    }

                    // Wake up the tab only if we REALLY need to!
                    if (!pageState.isJoined) {
                        const title = await p.title().catch(() => "Unknown");
                        console.log(`[${BOT_NAME}][Room:${roomId}] Tab is not joined. Wake up assessment...`);
                        await p.bringToFront().catch(() => null);
                        await new Promise(r => setTimeout(r, 2000)); // wait for wake-up
                        
                        // RE-EVALUATE after wake up!
                        const freshState = await p.evaluate(() => {
                            const joinBtn = document.querySelector('button.cs2-btn-primary, button[class*="join"], .btn-join');
                            const chatInput = document.querySelector('textarea.input-text, .input-text, [class*="chat-input"]');
                            const chatMessages = document.querySelector('.cs2-chat-messages, .message-list, .chat-messages');
                            const roomActions = document.querySelector('.cs2-top-actions, .room-menu');
                            const isPhysicallyInside = (!!chatMessages || !!roomActions) && !joinBtn;
                            const representsJoined = isPhysicallyInside || (!!chatInput && !joinBtn);
                            return { 
                                hasJoinBtn: !!joinBtn && (joinBtn.offsetWidth > 0), 
                                isJoined: representsJoined
                            };
                        }).catch(() => pageState);
                        Object.assign(pageState, freshState);
                    }

                    if (pageState.hasJoinBtn && !pageState.isJoined) {
                        console.log(`[${BOT_NAME}][Room:${roomId}] Join button visible! Clicking...`);
                        try {
                            const btn = await p.$('button.cs2-btn-primary, button[class*="join"], .btn-join');
                            if (btn) {
                                const box = await btn.boundingBox();
                                if (box) {
                                    await p.mouse.move(box.x + box.width/2, box.y + box.height/2);
                                    await p.mouse.down();
                                    await new Promise(r => setTimeout(r, 100));
                                    await p.mouse.up();
                                    console.log(`[${BOT_NAME}][Room:${roomId}] Precision click sent.`);
                                } else {
                                    await btn.click();
                                }
                                await new Promise(r => setTimeout(r, 5000));
                            }
                        } catch (e) { /* ignore */ }
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
                        if (title.includes('Chat') && !pageState.hasJoinBtn) {
                             console.log(`[${BOT_NAME}][Room:${roomId}] Forcing Joined state based on page title.`);
                             state.isJoined = true;
                             state.joinAttemptTime = Date.now();
                             continue;
                        }

                        // If page is blank or stuck on redirect for > 30s, refresh
                        if (!pageState.hasJoinBtn && !pageState.isJoined && (Date.now() - state.creationTime > 45000)) {
                             console.log(`[${BOT_NAME}][Room:${roomId}] Tab seems stuck or blank. Refreshing...`);
                             await p.reload({ waitUntil: 'domcontentloaded' }).catch(() => null);
                             state.creationTime = Date.now(); // reset timer
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
 
                    // Process all new messages
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
                                await say(p, reply);
                            }
                        } catch (err) { }
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
                // Human typing simulation: 2-5 sec delay
                await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
                
                await p.evaluate(async (txt) => {
                    const input = document.querySelector('textarea.input-text') || document.querySelector('textarea[placeholder*="Say something"]');
                    const btn = document.querySelector('button.btn-send');
                    if (input && btn) {
                        input.focus();
                        input.value = "";
                        
                        // Human-like character typing
                        for (let i = 0; i < txt.length; i++) {
                            const char = txt.charAt(i);
                            input.value += char;
                            input.dispatchEvent(new Event('input', { bubbles: true }));
                            // Random delay between 50-150ms per char
                            await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
                        }
                        
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                        
                        // Brief pause after typing before clicking send
                        await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
                        
                        btn.disabled = false;
                        btn.click();
                        // Also trigger Enter for reliability
                        input.dispatchEvent(new KeyboardEvent('keydown', {
                            bubbles: true, cancelable: true, keyCode: 13, key: 'Enter'
                        }));
                    }
                }, text);
            } catch (e) {}
        }

    } catch (e) {
        console.error("Critical error:", e.message);
    }
})();