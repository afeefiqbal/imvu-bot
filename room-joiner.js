import { fileURLToPath } from 'url';

/**
 * Compatibility shim for older launcher paths.
 * The bot now logs in through HTTP session handling and joins rooms over direct WebSocket.
 */
export async function runProfileLoginBootstrap({ botName } = {}) {
    console.log(
        `[${botName || process.env.BOT_NAME || 'IMVU'}] Profile bootstrap skipped; pure WebSocket mode does not use browser profiles.`
    );
    return 0;
}

async function main() {
    console.log('[room-joiner] Delegating to pure WebSocket runtime (imvu-bot.js).');
    await import('./imvu-bot.js');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    void main();
}
