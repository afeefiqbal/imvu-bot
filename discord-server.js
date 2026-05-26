import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import { Client, GatewayIntentBits, ActivityType } from 'discord.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });
// Fallbacks for common local layouts: embedded Laravel parent, then sibling Laravel app.
dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', 'imvu-bot-laravel', '.env') });

const app = express();
app.use(bodyParser.json());

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const activeRooms = new Set();
const initializedRooms = new Set();
function resolveDiscordChannelId(body = {}) {
    return String(body.discord_channel_id || process.env.DISCORD_CHANNEL_ID || '').trim();
}

function updatePresence() {
    if (client.user) {
        client.user.setActivity(`Active in ${activeRooms.size} room${activeRooms.size === 1 ? '' : 's'}`, { type: ActivityType.Custom });
    }
}

client.once('clientReady', () => {
    console.log(`[DISCORD] ✅ Logged in as ${client.user.tag}!`);
    console.log(`[DISCORD] 🌐 Express Server listening on port 3000... waiting for IMVU chats.`);
    updatePresence();
});

async function getOrCreateRoomChannel(client, requestedId, room_id, room_name, options = {}) {
    if (!requestedId) return null;
    
    if (room_id && !activeRooms.has(room_id)) {
        activeRooms.add(room_id);
        updatePresence();
    }
    
    // Room DB channel IDs point directly at the channel created for that IMVU room.
    if (options.directChannelId) {
        const directChannel = await client.channels.fetch(requestedId).catch(() => null);
        if (directChannel?.send) return directChannel;
    }

    // Attempt 1: Try reading it as a direct Server (Guild) ID
    let guild = client.guilds.cache.get(requestedId) || await client.guilds.fetch(requestedId).catch(() => null);
    
    // Attempt 2: If it's a Channel ID, get the server the channel belongs to
    if (!guild) {
        const baseChannel = await client.channels.fetch(requestedId).catch(() => null);
        if (baseChannel && baseChannel.guild) {
            guild = baseChannel.guild;
        }
    }

    if (!guild) return null;

    // Use topic to identify the room so the user can rename the channel anything they want!
    const roomTopicIdentifier = `IMVU Room ID: ${room_id}`;
    
    // Create a beautiful default name using the room name + 4 digit suffix
    let cleanName = (room_name || 'room').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
    if (!cleanName) cleanName = 'room'; // Fallback if name was entirely emojis/unicode

    const shortId = room_id.split('-').pop() || room_id.slice(-4);
    const targetChannelName = `${cleanName}-${shortId}`;
    
    let roomChannel = guild.channels.cache.find(c => c.topic && c.topic.includes(roomTopicIdentifier));
    if (!roomChannel) {
        if (!global.channelCreationLocks) global.channelCreationLocks = new Set();
        if (global.channelCreationLocks.has(room_id)) {
            await new Promise(r => setTimeout(r, 1200));
            roomChannel = guild.channels.cache.find(c => c.topic && c.topic.includes(roomTopicIdentifier));
        }
        if (!roomChannel) {
            global.channelCreationLocks.add(room_id);
            console.log(`[DISCORD] 🏗️ Creating new channel for ${targetChannelName}`);
            try {
                roomChannel = await guild.channels.create({
                    name: targetChannelName,
                    type: 0, // Guild Text
                    topic: roomTopicIdentifier
                });
            } catch(e) {
                console.error(`[DISCORD] ❌ Failed creating channel:`, e.message);
            } finally {
                global.channelCreationLocks.delete(room_id);
            }
        }
    } else {
        // Automatically sync channel name if it drifted, keeping the old name if we hit rate limits.
        // We only overwrite the name if the cleanName actually exists and isn't a placeholder.
        if (roomChannel.name !== targetChannelName && room_name && cleanName !== 'imvunext' && cleanName !== 'room') {
            console.log(`[DISCORD] 🔄 Renaming channel ${roomChannel.name} to ${targetChannelName}`);
            roomChannel.setName(targetChannelName).catch(()=>null);
        }
    }
    return roomChannel;
}

// The endpoint the IMVU bot will hit
app.post('/api/imvu-chat', async (req, res) => {
    try {
        const { event, direction, username, message, room_id, room_name } = req.body;
        
        // Prefer the per-room channel saved in server_rooms; .env is only a fallback.
        const roomChannelId = String(req.body.discord_channel_id || '').trim();
        const channelId = resolveDiscordChannelId(req.body);
        if (!channelId) {
            console.error('[DISCORD] ❌ Missing Discord channel id from DB and DISCORD_CHANNEL_ID fallback in .env');
            return res.status(400).send('Missing channel config');
        }

        // Only process chats (ignore other events for now)
        if (event === 'imvu_chat') {
            const roomChannel = await getOrCreateRoomChannel(client, channelId, room_id, room_name, {
                directChannelId: Boolean(roomChannelId),
            });
            if (roomChannel) {
                const prefix = direction === 'OUT' ? '🤖(Bot)' : '👤';
                await roomChannel.send({
                    content: `**${prefix}** \`${username}\`: ${message}`,
                    allowedMentions: { parse: [] }
                });
                res.status(200).send({ status: 'sent', channel: roomChannel.name });
            } else {
                console.error(`[DISCORD] ❌ Base Channel ID '${channelId}' not found or lacks permissions to read Guild!`);
                res.status(404).send('Guild not found');
            }
        } else {
            res.status(200).send('Ignored');
        }
    } catch (err) {
        console.error('[DISCORD] ❌ Error sending chat:', err.message);
        res.status(500).send('Error');
    }
});

// Immediately initialize the room channel when the bot completely joins the IMVU room
app.post('/api/imvu-init-room', async (req, res) => {
    try {
        const { room_id, room_name } = req.body;
        const roomChannelId = String(req.body.discord_channel_id || '').trim();
        const channelId = resolveDiscordChannelId(req.body);
        
        if (!channelId || !room_id) return res.status(400).send('Missing args');
        
        const roomChannel = await getOrCreateRoomChannel(client, channelId, room_id, room_name, {
            directChannelId: Boolean(roomChannelId),
        });
        if (roomChannel) {
            const key = String(room_id);
            if (!initializedRooms.has(key)) {
                initializedRooms.add(key);
                await roomChannel.send({
                    content:
                        `✅ IMVU room active: **${room_name || 'Unknown Room'}** (\`${key}\`)\n` +
                        `Active rooms now: **${activeRooms.size}**`,
                    allowedMentions: { parse: [] }
                }).catch(() => null);
            }
            res.status(200).send({ status: 'initialized' });
        } else {
            res.status(404).send('Guild not found');
        }
    } catch (err) {
        res.status(500).send('Error');
    }
});

import EventEmitter from 'events';
if (!global.discordBridge) global.discordBridge = new EventEmitter();

// Listen to messages typed inside Discord and relay them to IMVU!
client.on('messageCreate', async (message) => {
    if (message.author.bot) return; // Prevent infinite bot loops
    if (!message.guild) return; // Ignore DMs

    // Extract the IMVU room ID from the channel topic!
    if (message.channel.topic && message.channel.topic.includes('IMVU Room ID:')) {
        const match = message.channel.topic.match(/IMVU Room ID:\s*([\w-]+)/);
        if (match) {
            const targetRoomId = match[1];
            const content = message.content;
            console.log(`[DISCORD -> IMVU] Forwarding message from ${message.author.username} in #${message.channel.name}`);
            const portsStr = (process.env.IMVU_DISCORD_RELAY_PORTS || '').trim();
            const relayPorts = portsStr
                .split(/[\s,]+/)
                .map((s) => parseInt(s.trim(), 10))
                .filter((n) => Number.isFinite(n) && n > 0 && n < 65536);
            if (relayPorts.length > 0) {
                await Promise.allSettled(
                    relayPorts.map((port) =>
                        axios.post(
                            `http://127.0.0.1:${port}/discord-relay`,
                            { targetRoomId, content },
                            { timeout: 8000 }
                        )
                    )
                );
            } else {
                global.discordBridge.emit('chat', {
                    targetRoomId,
                    content,
                });
            }
        }
    }
});

const token = process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN;
if (!token) {
    console.error('[DISCORD] ❌ Missing DISCORD_TOKEN or DISCORD_BOT_TOKEN in .env!');
    process.exit(1);
}

// Log in and then start the Express server
client.login(token)
    .then(() => {
        app.listen(3000, '127.0.0.1', () => {
            // Successfully bound to port
        }).on('error', (e) => {
            if (e.code === 'EADDRINUSE') {
                console.log('[DISCORD] ⚙️ Express server already running on port 3000 (from another instance).');
            } else {
                console.error('[DISCORD] ❌ Server error:', e);
            }
        });
    })
    .catch((e) => {
        console.error('[DISCORD] ❌ Failed to login with Discord bot token:', e.message);
        process.exit(1);
    });
