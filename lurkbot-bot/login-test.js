import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function testLogin() {
    console.log("🚀 [PROTOCOL] Starting Direct Login Test...");
    
    const botsPath = path.resolve(__dirname, 'bots.json');
    const bots = JSON.parse(fs.readFileSync(botsPath, 'utf8'));
    const bot = bots[0];

    console.log(`[AUTH] Attempting login for ${bot.username}...`);

    try {
        const res = await axios.post('https://api.imvu.com/login', {
            username: bot.username,
            password: bot.password,
            gdpr_cookie_acceptance: false
        }, {
            headers: {
                'Content-Type': 'application/json; charset=UTF-8',
                'X-IMVU-Application': 'welcome/1',
                'Referer': 'https://secure.imvu.com/',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'
            },
            withCredentials: true
        });

        console.log("[AUTH] Login Request Sent.");
        console.log(`[AUTH] Status: ${res.status} ${res.statusText}`);
        
        const cookies = res.headers['set-cookie'];
        console.log("[AUTH] Cookies received:");
        if (cookies) {
            cookies.forEach(c => console.log(`  - ${c.split(';')[0]}`));
        } else {
            console.log("  - None (Check if login was already active or failed)");
        }

        console.log("[AUTH] Response Data:", JSON.stringify(res.data, null, 2));

    } catch (err) {
        console.error(`[ERROR] Login failed: ${err.message}`);
        if (err.response) {
            console.error("[ERROR] Response Data:", JSON.stringify(err.response.data, null, 2));
        }
    }
}

testLogin();
