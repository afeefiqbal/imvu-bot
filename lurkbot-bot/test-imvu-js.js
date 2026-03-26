const IMVU = require('imvu.js');
const fs = require('fs');
const path = require('path');

async function testImvuJs() {
    console.log("🚀 [IMVU.JS] testing imvu.js library...");
    
    const bots = JSON.parse(fs.readFileSync('bots.json', 'utf8'));
    const botCredentials = bots[0];

    // First, let's try to get a session from IMVU directly
    // Then we pass the osCsid as the "token" if that's what it wants.
    // Or maybe it wants the auth_token from the login response.
    
    // Actually, let's see what imvu.js.org does.
    // I'll try to just login using their library if they have a login method.
    // Looking at lib/imvu.js, it has a login(token) method.
    
    // I need a token. Let's see if I can find where to get it.
    // The library docs usually say you get it from the network tab.
    // I'll try to use the osCsid I just got: e5b71176c8d297f19e1a68460b3c49f7
    
    const client = new IMVU({
        name: 'Alexa'
    });

    try {
        console.log("[IMVU.JS] Attempting login with token...");
        // This will hit https://imvu.js.org/api/authenticate
        // Which might fail if the token is not what it expects.
        await client.login('e5b71176c8d297f19e1a68460b3c49f7');
        
        console.log("[IMVU.JS] Login successful!");
        client.on('ready', () => {
            console.log("[IMVU.JS] Bot is ready!");
            console.log("[IMVU.JS] Room:", client.room.name);
        });

    } catch (e) {
        console.error("[IMVU.JS] Login failed:", e.message);
    }
}

testImvuJs();
