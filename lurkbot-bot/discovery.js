import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DISCOVERY_FILE = path.join(__dirname, 'ws_manifest.json');
const USER_DATA_DIR = path.join(__dirname, 'profiles', 'DiscoveryBot');

const startDiscovery = async () => {
    console.log("\x1b[36m%s\x1b[0m", "🚀 Starting WS Discovery Mode...");
    console.log("This tool will capture the IMVU WebSocket Handshake and Auth Tokens.");

    const browser = await puppeteer.launch({ 
        headless: false,
        userDataDir: USER_DATA_DIR,
        args: [
            '--no-sandbox',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process'
        ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // --- INTERCEPTOR LOGIC ---
    await page.exposeFunction('traceWSRequest', (data) => {
        try {
            const parsed = JSON.parse(data);
            if (parsed.action) {
                console.log("\x1b[32m%s\x1b[0m", `📤 DISCOVERED OUTGOING COMMAND: ${parsed.action}`);
                console.log(data);
                
                // Save the most important join/subscribe commands
                if (parsed.mount?.includes('messages') || parsed.mount?.includes('participants')) {
                    fs.appendFileSync(path.join(__dirname, 'ws_commands_discovered.log'), `${data}\n`);
                }
            }
        } catch (e) {}
    });

    await page.evaluateOnNewDocument(() => {
        const OriginalWebSocket = window.WebSocket;
        window.WebSocket = function(url, protocols) {
            console.log("\x1b[35m%s\x1b[0m", `🔗 WS URL DISCOVERED: ${url}`);
            window._wsUrl = url;
            
            const ws = new OriginalWebSocket(url, protocols);
            
            const originalSend = ws.send;
            ws.send = function(data) {
                if (typeof data === 'string') {
                    window.traceWSRequest(data);
                }
                originalSend.apply(this, arguments);
            };
            return ws;
        };
    });

    console.log("\x1b[33m%s\x1b[0m", "👉 Navigate to IMVU Next and Login...");
    console.log("👉 Join ONE target room (e.g., room-XXXX).");
    console.log("👉 I will automatically save your tokens and commands when you land in the room.");

    await page.goto('https://www.imvu.com/next/chat/', { waitUntil: 'domcontentloaded' });
    
    // Wait for the room join
    await page.waitForFunction(() => window.location.href.includes('room-'), { timeout: 0 });
    
    console.log("\x1b[32m%s\x1b[0m", "✅ Room Join Detected! Capturing manifest...");

    const cookies = await page.cookies();
    const wsUrl = await page.evaluate(() => window._wsUrl);
    const userAgent = await browser.userAgent();

    const manifest = {
        wsUrl: wsUrl || "wss://chat.imvu.com/next/", // Fallback if missed
        userAgent: userAgent,
        cookies: cookies.map(c => `${c.name}=${c.value}`).join('; '),
        timestamp: new Date().toISOString()
    };

    fs.writeFileSync(DISCOVERY_FILE, JSON.stringify(manifest, null, 2));

    console.log("\x1b[42m%s\x1b[0m", " 🎉 SUCCESS! ");
    console.log(`- WS Manifest: ${DISCOVERY_FILE}`);
    console.log(`- WS Commands: ${path.join(__dirname, 'ws_commands_discovered.log')}`);
    console.log("\x1b[36m%s\x1b[0m", "You can now close the browser and use these in your pure WS client.");

    await new Promise(r => setTimeout(r, 5000));
    await browser.close();
};

startDiscovery().catch(console.error);
