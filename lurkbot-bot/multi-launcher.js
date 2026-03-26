// multi-launcher.js – launches a separate IMVU bot process for each entry in bots.json
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Resolve __dirname in ES module context
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const botsPath = path.resolve(__dirname, 'bots.json');
if (!fs.existsSync(botsPath)) {
  console.error('❌ bots.json not found. Create it with bot credentials.');
  process.exit(1);
}

let bots;
try {
  bots = JSON.parse(fs.readFileSync(botsPath, 'utf-8'));
} catch (e) {
  console.error('❌ Failed to parse bots.json:', e.message);
  process.exit(1);
}

if (!Array.isArray(bots) || bots.length === 0) {
  console.error('❌ bots.json is empty or malformed.');
  process.exit(1);
} 

// Parse optional CLI arguments: --count=N
let botCount = bots.length;
process.argv.slice(2).forEach(arg => {
  if (arg.startsWith('--count=')) {
    const n = parseInt(arg.split('=')[1], 10);
    if (!isNaN(n) && n > 0) botCount = Math.min(n, bots.length);
  }
});

const imvuBotScript = path.resolve(__dirname, 'imvu-bot.js');

// Limit the bots array if a count was specified
const botsToLaunch = bots.slice(0, botCount);

botsToLaunch.forEach((bot, idx) => {
  const env = { ...process.env };
  env.BOT_NAME = bot.name || `Bot-${idx}`;
  env.BOT_USERNAME = bot.username || '';
  env.BOT_PASSWORD = bot.password || '';
  env.BOT_AUTH_TOKEN = bot.authToken || '';
  env.BOT_PROXY = bot.proxy || '';
  // Unique Chrome profile per bot
  env.BOT_USER_DATA_DIR = bot.userDataDir || `/tmp/imvu-bot-profile-${env.BOT_NAME}`;

  const child = spawn('node', [imvuBotScript], { env, stdio: ['ignore', 'pipe', 'pipe'] });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => {
    process.stdout.write(`[${env.BOT_NAME}] ${data}`);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', data => {
    process.stderr.write(`[${env.BOT_NAME}][ERR] ${data}`);
  });

  child.on('close', code => {
    console.log(`[${env.BOT_NAME}] exited with code ${code}`);
  });
});
