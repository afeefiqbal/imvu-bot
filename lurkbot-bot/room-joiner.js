import 'dotenv/config';
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { attachToAllTargets, startUserTracking } from './user-tracker.js';
import axios from 'axios';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from root if it exists
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const BOT_NAME = "RoomJoiner";
const BOTS_FILE = path.join(__dirname, 'bots.json');
const API_BASE_URL = process.env.APP_URL || 'http://localhost:8000';

if (!fs.existsSync(BOTS_FILE)) {
    console.error(`[${BOT_NAME}] Error: bots.json not found!`);
    process.exit(1);
}

// Settings will be fetched from backend or bots.json inside startJoiner

const cleanupProfileLock = (profileDir) => {
    try {
        const lockPath = path.join(profileDir, 'SingletonLock');
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    } catch (e) { }
};

const fetchBotSettings = async (botName) => {
    const url = `${API_BASE_URL}/api/bots/${botName}`;
    try {
        const response = await axios.get(url);
        return response.data;
    } catch (error) {
        console.error(`[${BOT_NAME}] Error fetching bot settings from ${url}:`, error.message);
        return null;
    }
};

const performLogin = async (page) => {
    try {
        if (!page || page.isClosed()) return false;
        
        const loginState = await page.evaluate(() => {
            const loginLink = document.querySelector('.login-link, .nav-login, [href*="login"]');
            const loggedInUser = document.querySelector('.user-menu, .avatar-name, .username, [class*="userProfile"], .avatar-container');
            const isHome = window.location.href.includes('/next/home');
            return {
                needsLogin: !!loginLink && !loggedInUser,
                alreadyLoggedIn: !!loggedInUser || isHome
            };
        });
        
        if (loginState.alreadyLoggedIn) {
            console.log(`[${BOT_NAME}] ✅ Already logged in.`);
            return true;
        }

        console.log(`[${BOT_NAME}] 🔐 Logging in as ${botMatch.username}...`);
        
        // Force navigate to login
        await page.goto('https://www.imvu.com/login/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
             console.error(`[${BOT_NAME}] Login goto failed:`, e.message);
        });
        await new Promise(r => setTimeout(r, 8000));

        if (page.url().includes('chrome-error://')) {
             console.log(`[${BOT_NAME}] ⚠️ Network blocked (chrome-error://). Retrying login page...`);
             await page.goto('https://www.imvu.com/login/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{});
             await new Promise(r => setTimeout(r, 8000));
        }
        await new Promise(r => setTimeout(r, 8000));

        // Detect splash page vs login form
        const pageStatus = await page.evaluate(() => {
            const hasUserInp = !!document.querySelector('input[name="username"], input[name="email"], #login_username');
            const loginBtn = Array.from(document.querySelectorAll('button, a, span')).find(b => {
                const t = (b.innerText || b.textContent || '').toUpperCase().trim();
                return t === 'LOG IN' || t === 'LOGIN' || t === 'SIGN IN';
            });
            return { hasForm: hasUserInp, splashBtnFound: !!loginBtn, url: window.location.href };
        });

        console.log(`[${BOT_NAME}] Login Page Status:`, pageStatus);

        if (!pageStatus.hasForm && pageStatus.splashBtnFound) {
            console.log(`[${BOT_NAME}] 🖱️ Splash page detected. Clicking 'Log In'...`);
            await page.evaluate(() => {
                const loginBtn = Array.from(document.querySelectorAll('button, a, span')).find(b => {
                    const t = (b.innerText || b.textContent || '').toUpperCase().trim();
                    return t === 'LOG IN' || t === 'LOGIN' || t === 'SIGN IN';
                });
                if (loginBtn) loginBtn.click();
            });
            await new Promise(r => setTimeout(r, 8000));
        }

        // Try filling form (even if it was already there or just appeared)
        const filled = await page.evaluate((u, p) => {
            const userInp = document.querySelector('input[name="username"], input[name="email"], #login_username, [placeholder*="Username" i], [name="id"]');
            const passInp = document.querySelector('input[type="password"], #login_password, [name="password"]');
            if (userInp && passInp) {
                userInp.value = u;
                userInp.dispatchEvent(new Event('input', { bubbles: true }));
                passInp.value = p;
                passInp.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
            }
            return false;
        }, botMatch.username, botMatch.password);

        if (filled) {
            await page.keyboard.press('Enter');
            console.log(`[${BOT_NAME}] ⏳ Form filled. Waiting for redirection...`);
            await new Promise(r => setTimeout(r, 15000));
            return true;
        } else {
            console.log(`[${BOT_NAME}] ❌ Login form STILL not found. URL: ${page.url()}`);
            await page.screenshot({ path: path.join(__dirname, 'debug-login.png') }).catch(() => {});
            return false;
        }
    } catch (e) { 
        console.error(`[LOGIN ERROR]`, e.message); 
        await page.screenshot({ path: path.join(__dirname, 'debug-login.png') }).catch(() => {});
        return false; 
    }
};

const clickJoinButton = async (page) => {
    try {
        if (!page || page.isClosed()) return false;
        
        // Wait for page to settle
        await new Promise(r => setTimeout(r, 8000));
        
        const alreadyIn = await page.evaluate(() => {
            return !!(document.querySelector('textarea.input-text') || document.querySelector('.cs2-chat-messages'));
        });
        
        if (alreadyIn) return true;

        // Approx. occupants from visible avatar links (works before /chat WebSocket subscribe).
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

        console.log(`[${BOT_NAME}] 🚪 Attempting to join...`);
        
        for (let attempt = 1; attempt <= 5; attempt++) {
            const btnInfo = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button, a, div[role="button"], span.join-cta, .uikit-button'));
                let joinBtn = document.querySelector('button.join-cta, .join-cta');
                
                if (!joinBtn) {
                     joinBtn = buttons.find(b => {
                        const t = (b.innerText || b.textContent || b.getAttribute('aria-label') || '').toLowerCase().trim();
                        return ['join', 'enter chat', 'go to room', 'chat now', 'enter'].includes(t);
                    });
                }

                if (joinBtn && joinBtn.offsetWidth > 0) {
                    joinBtn.scrollIntoView();
                    joinBtn.click();
                    return { found: true, text: (joinBtn.innerText || joinBtn.textContent || '').trim() };
                }
                return { found: false };
            });

            if (btnInfo.found) {
                console.log(`[${BOT_NAME}] Found and clicked button: "${btnInfo.text}"`);
                break;
            }
            console.log(`[${BOT_NAME}] [JOIN-DEBUG] Wait for button... attempt ${attempt}`);
            await new Promise(r => setTimeout(r, 5000));
        }

        const joined = await page.waitForFunction(() => {
            const hasChat = !!(document.querySelector('textarea.input-text') || 
                               document.querySelector('.cs2-chat-messages') || 
                               document.querySelector('.uikit-chat-input-textarea') ||
                               document.querySelector('.message-list'));
            const isLobby = window.location.href.includes('/chat/') && !window.location.href.includes('room-');
            return hasChat && !isLobby;
        }, { timeout: 45000 }).then(() => true).catch(() => false);

        if (!joined) {
             console.log(`[${BOT_NAME}] ⚠️ Join verification failed. Taking debug-after-join.png`);
             await page.screenshot({ path: path.join(__dirname, 'debug-after-join.png') }).catch(() => {});
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
        
        console.log(`[${BOT_NAME}] ✅ Avatar activated`);
    } catch (e) { }
};

// Global bot configuration
let botMatch = { username: '', password: '', profile: 'S1VA' };

const startJoiner = async (roomId = '') => {
    // Fetch settings from backend if not provided via CLI or if we want to sync with backend
    const profileName = process.env.BOT_PROFILE || 'Bot-Alpha';
    console.log(`[${BOT_NAME}] 📡 Fetching settings for profile: ${profileName}...`);
    const backendBot = await fetchBotSettings(profileName);

    if (backendBot) {
        console.log(`[${BOT_NAME}] ✅ Settings fetched from backend.`);
        
        // Load local bots.json for credential fallbacks
        let localBots = [];
        try {
            localBots = JSON.parse(fs.readFileSync(BOTS_FILE, 'utf8'));
        } catch (e) {}
        const localMatch = localBots.find(b => b.username === backendBot.username) || localBots[0];

        // Use backend credentials, fallback to local bots.json if backend returns placeholder values
        botMatch.username = (backendBot.username && backendBot.username !== 'Unset') ? backendBot.username : (localMatch?.username || process.env.BOT_ALPHA_USERNAME || 's1va');
        botMatch.password = (backendBot.password && backendBot.password !== 'Unset' && backendBot.password !== 'secret') ? backendBot.password : (localMatch?.password || process.env.BOT_ALPHA_PASSWORD || 'password');
        
        // Use assigned room ID if none provided
        if (!roomId && backendBot.room_ids) {
            // Take all rooms assigned to this bot
            const roomList = backendBot.room_ids.split(',').map(id => {
                const trimmed = id.trim();
                const urlMatch = trimmed.match(/room-([\d-]+)/);
                return urlMatch ? urlMatch[1] : trimmed;
            }).filter(Boolean);
            
            roomId = roomList[0]; // The current process will take the first room
            
            // Instantly branch off new transparent processes for any additional rooms!
            if (roomList.length > 1) {
                console.log(`[${BOT_NAME}] 👯 Detected ${roomList.length} rooms! Spawning isolated clones...`);
                // Use dynamic import so it doesn't clutter top imports
                import('child_process').then(({ spawn }) => {
                    for (let i = 1; i < roomList.length; i++) {
                        console.log(`[${BOT_NAME}] 🚀 Branching clone for Room: ${roomList[i]}`);
                        // Launch identical copy of itself specifically targeted to the next room
                        spawn('node', [path.basename(__filename), roomList[i]], {
                            cwd: __dirname,
                            stdio: 'inherit', // Shares the same terminal window output!
                            env: process.env
                        });
                    }
                });
            }
        }
        
        // Fallback to default if still no roomId
        if (!roomId) {
            console.warn(`[${BOT_NAME}] ⚠️ No room assigned in backend for this bot. Using default.`);
            roomId = '242955291-481';
        }
    } else {
        console.warn(`[${BOT_NAME}] ⚠️ Failed to fetch backend settings. Using defaults from bots.json.`);
        const bots = JSON.parse(fs.readFileSync(BOTS_FILE, 'utf8'));
        const localMatch = bots.find(b => b.profile === profileName) || bots[0];
        botMatch = { ...localMatch };
        if (!roomId) roomId = '242955291-481'; // Ultimate fallback
    }

    if (!roomId) {
        console.error(`[${BOT_NAME}] ❌ Error: No room ID assigned!`);
        process.exit(1);
    }

    const USER_DATA_DIR = path.resolve(__dirname, 'profiles', `${BOT_NAME}-${roomId}`);
    cleanupProfileLock(USER_DATA_DIR);

    const browser = await puppeteer.launch({
        headless: true, // Switched to headless
        userDataDir: USER_DATA_DIR,
        ignoreHTTPSErrors: true, // Critical for bypassing proxy/cert intercept issues
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--window-size=1280,800',
            '--disable-web-security',
            '--enable-webgl',
            '--use-gl=angle',
            '--ignore-certificate-errors',     // Fixes chromewebdata
            '--ignore-certificate-errors-spki-list',
            '--disable-features=IsolateOrigins,site-per-process'
        ]
    });

    const page = (await browser.pages())[0];
    
    // Set a modern User-Agent for headless compatibility
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    console.log(`[${BOT_NAME}] 🚀 Navigating to room: ${roomId}`);
    
    // 🎯 Initialize CDP WebSocket Tracker BEFORE navigation
    await attachToAllTargets(browser);
    await startUserTracking(page, roomId, {
        botName: profileName,
        botUsername: botMatch.username,
        discordChannelId: botMatch.discord_channel_id || (typeof backendBot !== 'undefined' ? backendBot?.discord_channel_id : undefined)
    });

    await page.goto(`https://www.imvu.com/next/chat/room-${roomId}/`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => {
         console.warn(`[${BOT_NAME}] Initial room navigation caught:`, e.message);
    });

    if (page.url().includes('chrome-error://')) {
         console.log(`[${BOT_NAME}] ⚠️ Network blocked (chrome-error://). Retrying room page...`);
         await new Promise(r => setTimeout(r, 3000));
         await page.goto(`https://www.imvu.com/next/chat/room-${roomId}/`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{});
    }

    await performLogin(page);
    
    // Check if we were redirected to home instead of staying in/near the room
    if (page.url().includes('/next/home')) {
        console.log(`[${BOT_NAME}] 🔄 Redirected to home. Re-navigating to room: ${roomId}`);
        await page.goto(`https://www.imvu.com/next/chat/room-${roomId}/`, { waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 8000));
    }

    const joined = await clickJoinButton(page);
    
    if (joined) {
        console.log(`[${BOT_NAME}] 🎉 Successfully joined room!`);
        await activateAvatar(page);
        
        // Stabilization
        await new Promise(r => setTimeout(r, 8000));
        await page.mouse.move(800, 400);
        await page.mouse.move(400, 400);

        // Keep Alive Loop
        const keepAliveTimer = setInterval(async () => {
            try {
                if (page.isClosed()) {
                    clearInterval(keepAliveTimer);
                    return;
                }
                await page.mouse.move(400 + Math.random() * 300, 300 + Math.random() * 300);
                await page.keyboard.press('Shift');
            } catch (e) {
                console.error(`[${BOT_NAME}] Keep-alive error:`, e.message);
            }
        }, 12000);

        console.log(`[${BOT_NAME}] 🟢 Bot is active and staying in the room.`);
    } else {
        console.log(`[${BOT_NAME}] ❌ Join failed. URL: ${page.url()}`);
    }
};

// Start the joiner
const targetRoom = process.argv[2] || '';
startJoiner(targetRoom).catch(err => {
    console.error(`[${BOT_NAME}] Fatal Error in startJoiner:`, err);
    process.exit(1);
});
