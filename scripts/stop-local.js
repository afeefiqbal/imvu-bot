#!/usr/bin/env node
/**
 * Stop local imvu-bot processes (multi-launcher, bot child, discord-server).
 * Usage: npm run stop
 */
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const rootEsc = root.replace(/'/g, "'\\''");

const patterns = [
    `${rootEsc}/index.js`,
    `${rootEsc}/imvu-bot.js`,
    `${rootEsc}/discord-server.js`,
    `${rootEsc}/multi-launcher.js`,
];

for (const pattern of patterns) {
    try {
        execSync(`pkill -f '${pattern}' 2>/dev/null || true`, { stdio: 'ignore' });
    } catch {
        /* optional */
    }
}

console.log('Stopped local imvu-bot processes.');
console.log('If ports 30900/3000 are still busy: lsof -i :30900 -i :3000');
