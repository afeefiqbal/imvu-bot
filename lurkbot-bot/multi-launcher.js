import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import axios from 'axios';
import dotenv from 'dotenv';

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

async function run() {
    const rooms = await fetchRoomsForBot();
    console.log(`[MULTI-LAUNCHER] 🔥 Preparing to join ${rooms.length} completely separate chat rooms!`);
    
    for (const roomId of rooms) {
        console.log(`\n[MULTI-LAUNCHER] 🚀 Spawning isolated bot process for Room: ${roomId}`);
        
        // Spawn a completely independent node process for this room
        spawn('node', ['room-joiner.js', roomId], {
            cwd: __dirname,
            stdio: 'inherit',
            env: { ...process.env, BOT_PROFILE: profileName }
        });
        
        // Give the network 8 seconds to settle before booting the next Chrome profile
        console.log(`[MULTI-LAUNCHER] ⏳ Waiting 8 seconds before launching next room...`);
        await new Promise(r => setTimeout(r, 8000));
    }
    
    console.log(`\n[MULTI-LAUNCHER] ✅ All room joiner processes have been heavily dispatched!`);
}

run();
