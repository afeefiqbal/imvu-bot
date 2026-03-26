/* 
 * direct-bot.js - Debugging Standalone Protocol Bot
 * Logs ALL records to identify the subscription response.
 */
import WebSocket from 'ws';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BOT_NAME = "s1va"; 
const BACKEND_URL = "http://127.0.0.1:8000";
const ROOM_ID = "5";
const TARGET_QUEUE = "/chat/120999807";

let session = {
    osid: null,
    userId: "378109128", 
    username: BOT_NAME,
    queue: TARGET_QUEUE,
    opId: 600
};

const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
const decode = (str) => {
    try {
        return JSON.parse(Buffer.from(str, 'base64').toString('utf8'));
    } catch(e) {
        return null;
    }
};

async function startBot() {
    console.log(`\n🚀 [DEBUG] Booting ${BOT_NAME}...`);
    
    const bots = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'bots.json'), 'utf8'));
    const creds = bots.find(b => b.name === BOT_NAME) || bots[0];

    try {
        console.log(`[AUTH] Logging in...`);
        const loginRes = await axios.post('https://api.imvu.com/login', {
            username: creds.username,
            password: creds.password,
            gdpr_cookie_acceptance: false
        }, {
            headers: {
                'Content-Type': 'application/json',
                'X-IMVU-Application': 'welcome/1'
            }
        });

        session.osid = loginRes.headers['set-cookie']?.find(c => c.startsWith('osCsid='))?.split('=')[1].split(';')[0];
        console.log(`[AUTH] ✓ Session ok.`);

        const ws = new WebSocket('wss://wss-imq.imvu.com/streaming/imvu_pre', {
            headers: {
                'Cookie': `osCsid=${session.osid}`,
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
                'Origin': 'https://www.imvu.com'
            }
        });

        const sendMsg = (record, payload = {}) => {
            session.opId++;
            const data = { record, ...payload, op_id: session.opId };
            ws.send(JSON.stringify(data));
        };

        const sendChat = (text) => {
            const inner = { chatId: ROOM_ID, message: text, to: 0, userId: session.userId };
            sendMsg("msg_c2g_send_message", { queue: session.queue, mount: "messages", message: encode(inner) });
        };

        ws.on('open', () => {
            console.log(`[WS] ✓ Connected. Subscribing to ${session.queue}...`);
            sendMsg("msg_c2g_subscribe", {
                queues_with_results: [{ record: "subscription", name: session.queue, op_id: 101 }],
                op_id: 101
            });
            
            // Force join signals even if we don't get a "success" response back yet
            setTimeout(() => sendChat("*imvu:isPureUser"), 2000);
            setTimeout(() => sendChat("Hello everyone! I am the new bot."), 4000);
        });

        ws.on('message', async (data) => {
            const raw = data.toString();
            const msg = JSON.parse(raw);
            console.log(`[RECV] Record: ${msg.record}`); // Log every record type

            if ((msg.record === "msg_g2c_send_message" || msg.record === "msg_g2c_deliver_message") && msg.mount === "messages") {
                const payload = decode(msg.message);
                if (!payload || payload.userId == session.userId) return;

                console.log(`[CHAT] ${payload.userId}: "${payload.message}"`);

                if (payload.message.toLowerCase().includes("!alexa") || payload.message.toLowerCase().includes("!a ")) {
                    try {
                        const res = await axios.post(`${BACKEND_URL}/api/lurk`, { message: payload.message });
                        if (res.data.reply) sendChat(res.data.reply);
                    } catch (e) {}
                }
            }
        });

        ws.on('close', () => {
            console.log("[WS] Lost connection. Reconnecting...");
            setTimeout(startBot, 5000);
        });

        setInterval(() => { if (ws.readyState === 1) sendMsg("msg_c2g_ping"); }, 30000);

    } catch (err) {
        console.error(`[FATAL] ${err.message}`);
        setTimeout(startBot, 10000);
    }
}

startBot();
