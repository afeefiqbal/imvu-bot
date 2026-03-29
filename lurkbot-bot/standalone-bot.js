import WebSocket from 'ws';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MANIFEST_PATH = path.join(__dirname, 'ws_manifest.json');
const BACKEND_URL = 'http://localhost:8000'; 
const BOT_NAME = "StandaloneBot";

const userIdToUsername = new Map();
const roomStates = new Map(); 
let manifest = null;
let ws = null;
let opId = 1000;

const decode = (str) => {
    try { return JSON.parse(Buffer.from(str, 'base64').toString('utf8')); } 
    catch(e) { return null; }
};

const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');

async function startBot() {
    if (!fs.existsSync(MANIFEST_PATH)) {
        console.error("❌ MANIFEST MISSING! Run discovery.js first.");
        return;
    }

    try {
        manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
        console.log(`\x1b[36m%s\x1b[0m`, `\n🚀 [WS] Booting Standalone Bot...`);
        console.log(`🔗 Gateway: ${manifest.wsUrl}`);

        ws = new WebSocket(manifest.wsUrl, {
            headers: {
                'Cookie': manifest.cookies,
                'User-Agent': manifest.userAgent,
                'Origin': 'https://www.imvu.com'
            }
        });

        const sendMsg = (record, payload = {}) => {
            opId++;
            const data = { record, ...payload, op_id: opId };
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(data));
            }
        };

        ws.on('open', async () => {
            console.log(`\x1b[32m%s\x1b[0m`, `✅ [WS] Connected to IMVU.`);
            
            // Sync with backend to get target rooms
            try {
                console.log(`[BACKEND] Fetching room assignments...`);
                const res = await axios.post(`${BACKEND_URL}/api/rooms/sync`, { rooms: [], bot_name: BOT_NAME });
                const targets = res.data?.target_rooms || [];
                console.log(`[BACKEND] Found ${targets.length} target rooms.`);
                
                for (const roomId of targets) {
                    const queueName = `/chat/${roomId}`;
                    console.log(`📡 [SUB] Subscribing to: ${queueName}`);
                    sendMsg("msg_c2g_subscribe", {
                        queues_with_results: [{ record: "subscription", name: queueName }]
                    });
                }
            } catch (e) {
                console.warn("⚠️ Backend sync failed. Retrying in 10s...");
                setTimeout(startBot, 10000);
            }
        });

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                
                // --- TRACK USERNAMES ---
                if (msg.denormalized) {
                    for (const [k, v] of Object.entries(msg.denormalized)) {
                        const m = k.match(/user-(\d+)/);
                        if (m && v?.data?.username) {
                            userIdToUsername.set(m[1], v.data.username);
                        }
                    }
                }

                // --- HANDLE ROOM MESSAGES ---
                if (msg.record === "msg_g2c_send_message" || msg.record === "msg_g2c_deliver_message") {
                    const roomId = msg.queue?.replace('/chat/', '');
                    if (!roomId) return;

                    // --- PARTICIPANTS (JOINS/LEAVES) ---
                    if (msg.mount?.includes('participants')) {
                        const payload = decode(msg.message);
                        if (!payload || !payload.objects) return;

                        for (const obj of payload.objects) {
                            const userMatch = obj.match(/user-(\d+)/);
                            if (!userMatch) continue;
                            const userId = userMatch[1];

                            if (payload.action === 'created') {
                                console.log(`\x1b[35m%s\x1b[0m`, `[JOIN][${roomId}] User ${userId} arrived.`);
                                syncEvent(roomId, 'join', userId);
                            } else if (payload.action === 'deleted') {
                                console.log(`\x1b[31m%s\x1b[0m`, `[LEAVE][${roomId}] User ${userId} left.`);
                                syncEvent(roomId, 'leave', userId);
                            }
                        }
                    }

                    // --- CHAT MESSAGES ---
                    if (msg.mount?.includes('messages')) {
                        const payload = decode(msg.message);
                        if (!payload || !payload.message) return;
                        
                        const username = userIdToUsername.get(payload.userId?.toString()) || `user_${payload.userId}`;
                        console.log(`\x1b[34m%s\x1b[0m`, `[CHAT][${roomId}] ${username}: ${payload.message}`);
                    }
                }
            } catch (e) {
                // Silently handle parse errors for binary or invalid frames
            }
        });

        ws.on('close', () => {
            console.log("\x1b[31m%s\x1b[0m", "🚨 [WS] Connection lost. Reconnecting in 5s...");
            setTimeout(startBot, 5000);
        });

        ws.on('error', (err) => {
            console.error(`❌ [WS] Error: ${err.message}`);
        });

    } catch (err) {
        console.error(`❌ [FATAL] ${err.message}`);
        setTimeout(startBot, 10000);
    }
}

async function syncEvent(roomId, event, userId) {
    try {
        await axios.post(`${BACKEND_URL}/api/rooms/event`, {
            room_id: roomId,
            event_type: event,
            user_id: userId,
            bot_name: BOT_NAME
        }).catch(() => {});
    } catch(e) {}
}

// PING to keep session alive
setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        opId++;
        ws.send(JSON.stringify({ record: "msg_c2g_ping", op_id: opId }));
    }
}, 25000);

// --- AUTO RELOAD ON SESSION UPDATE ---
fs.watchFile(MANIFEST_PATH, (curr, prev) => {
    if (curr.mtime > prev.mtime) {
        console.log("\x1b[33m%s\x1b[0m", "🔄 [SESSION] Manifest updated by Puppeteer. Reconnecting...");
        if (ws) ws.close();
        // startBot() will be triggered by the reconnect logic in 'close'
    }
});

startBot();
