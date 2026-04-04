import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, fork } from 'child_process';
import axios from 'axios';
import dotenv from 'dotenv';
import { bulkPost } from './api-queue.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from backend root
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const API_BASE_URL = process.env.APP_URL || 'http://localhost:8000';
const profileName = process.env.BOT_PROFILE || 'Bot-Alpha';

async function fetchRoomsForBot() {
    console.log(`[MULTI-LAUNCHER] 📡 Fetching room assignments for ${profileName}...`);
    try {
        const { data } = await axios.get(`${API_BASE_URL}/api/bots/${profileName}`);
        if (!data || !data.room_ids) {
            console.warn('[MULTI-LAUNCHER] No rooms assigned in backend, falling back to default.');
            return ['242955291-481'];
        }
        
        // Extract room IDs safely
        return data.room_ids.split(',').map(r => {
             const trimmed = r.trim();
             const m = trimmed.match(/room-([\d-]+)/);
             return m ? m[1] : trimmed;
        }).filter(Boolean);
        
    } catch (e) {
       console.error('[MULTI-LAUNCHER] ❌ Failed to contact backend. Falling back to default room.', e.message);
       return ['242955291-481'];
    }
}

const activeBots = new Map();

function runBot(roomId) {
    if (activeBots.has(roomId)) return;
    activeBots.set(roomId, true);
    
    console.log(`\n[MULTI-LAUNCHER] 🚀 Spawning isolated bot process for Room: ${roomId}`);
    
    const child = spawn('node', ['room-joiner.js', roomId], {
        cwd: __dirname,
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        env: { ...process.env, BOT_PROFILE: profileName }
    });
    
    child.on('message', (msg) => {
        if (msg && msg.type === 'api' && msg.payload) {
             bulkPost(msg.payload.endpoint, msg.payload.data);
        }
    });

    child.on('exit', (code) => {
        console.log(`[MULTI-LAUNCHER] ⚠️ Bot ${roomId} exited with code ${code}. Restarting in 10s...`);
        activeBots.delete(roomId);
        setTimeout(() => runBot(roomId), 10000);
    });
}

let discordStarted = false;

function startDiscord() {
    if (discordStarted) return;
    discordStarted = true;

    spawn('node', ['discord-server.js'], {
        cwd: __dirname,
        stdio: 'inherit'
    });
}

async function run() {
    console.log(`[MULTI-LAUNCHER] 🌐 Booting Discord Integration Server...`);
    startDiscord();

    const rooms = await fetchRoomsForBot();
    console.log(`[MULTI-LAUNCHER] 🔥 Preparing to join ${rooms.length} completely separate chat rooms!`);
    
    const MAX_BOTS = 5;
    for (const roomId of rooms.slice(0, MAX_BOTS)) {
        runBot(roomId);
        
        // Give the network 8 seconds to settle before booting the next Chrome profile
        console.log(`[MULTI-LAUNCHER] ⏳ Waiting 8 seconds before launching next room...`);
        await new Promise(r => setTimeout(r, 8000));
    }
    
    console.log(`\n[MULTI-LAUNCHER] ✅ All room joiner processes have been heavily dispatched!`);
}

run();
