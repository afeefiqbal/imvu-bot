import './scripts/ensure-valet-ca.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import axios from 'axios';
import dotenv from 'dotenv';
import { bulkPost } from './api-queue.js';
import { backendApiBaseUrl } from './env-app-url.js';
import { maybeStartMusicIngressTunnel } from './music/tunnelIngress.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });
// Fallbacks for common local layouts: embedded Laravel parent, then sibling Laravel app.
dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', 'imvu-bot-laravel', '.env') });

function envTruthy(key) {
    const v = String(process.env[key] ?? '')
        .trim()
        .toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** Local dev: drop Railway private DNS. Drop quick-tunnel env only when music is off (copied prod .env otherwise blocks boot ~45s). Opt out: LURKBOT_KEEP_RAILWAY_ENV=1 */
function normalizeEnvForLocalDev() {
    const appEnv = String(process.env.APP_ENV || '').toLowerCase();
    const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
    if (appEnv !== 'local' || onRailway) return;
    if (String(process.env.LURKBOT_KEEP_RAILWAY_ENV || '').trim() === '1') return;

    delete process.env.ICECAST_HOST_SUFFIX;

    const musicOn = envTruthy('IMVU_MUSIC_ENABLED') || envTruthy('MUSIC_ENABLED');
    if (!musicOn) {
        delete process.env.CLOUDFLARE_TUNNEL_AUTO;
        delete process.env.NGROK_TUNNEL_AUTO;
        delete process.env.CLOUDFLARE_TUNNEL_FORCE;
    }
}

normalizeEnvForLocalDev();

/** Railway + stable Icecast HTTPS URL: never start ngrok/cloudflared quick tunnels. */
function normalizeEnvForRailway() {
    const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
    if (!onRailway) return;

    const tpl = String(process.env.MUSIC_PUBLIC_STREAM_URL_TEMPLATE || '').trim();
    const stableHttps =
        tpl && /^https:\/\//i.test(tpl) && !/\.trycloudflare\.com\b/i.test(tpl);
    if (!stableHttps) return;

    delete process.env.CLOUDFLARE_TUNNEL_AUTO;
    delete process.env.CLOUDFLARE_TUNNEL_FORCE;
    delete process.env.NGROK_TUNNEL_AUTO;
    delete process.env.NGROK_TUNNEL_FORCE;
}

normalizeEnvForRailway();

/**
 * Multi-bot orchestration: one `spawn()` = one Node child using the pure WebSocket IMVU runtime.
 *
 * Default `IMVU_LAUNCH_SCRIPT`: imvu-bot.js. The child does HTTP session setup and direct WSS
 * room connections.
 */
const API_BASE_URL = backendApiBaseUrl('http://127.0.0.1:8000');
console.log(`[MULTI-LAUNCHER] Laravel API base (bot→HTTP): ${API_BASE_URL}`);

/** @type {import('child_process').ChildProcess[]} */
const trackedChildren = [];
let discordChild = null;
let intentionalShutdown = false;

function trackChild(child) {
    if (!child) return child;
    trackedChildren.push(child);
    child.once('exit', () => {
        const i = trackedChildren.indexOf(child);
        if (i >= 0) trackedChildren.splice(i, 1);
    });
    return child;
}

function shutdownAllChildren(signal = 'SIGTERM') {
    intentionalShutdown = true;
    console.log('\n[MULTI-LAUNCHER] Shutting down — stopping bot and Discord child processes…');
    const toKill = [...trackedChildren];
    if (discordChild && !discordChild.killed) toKill.push(discordChild);
    for (const child of toKill) {
        try {
            if (!child.killed) child.kill(signal);
        } catch {
            /* optional */
        }
    }
    const deadline = Date.now() + 8000;
    const poll = () => {
        const alive = trackedChildren.filter((c) => c.exitCode == null && !c.killed);
        const discordAlive = discordChild && discordChild.exitCode == null && !discordChild.killed;
        if (!alive.length && !discordAlive) {
            process.exit(0);
            return;
        }
        if (Date.now() >= deadline) {
            for (const child of alive) {
                try {
                    child.kill('SIGKILL');
                } catch {
                    /* optional */
                }
            }
            if (discordAlive) {
                try {
                    discordChild.kill('SIGKILL');
                } catch {
                    /* optional */
                }
            }
            process.exit(0);
            return;
        }
        setTimeout(poll, 200);
    };
    setTimeout(poll, 200);
}

/** Ctrl+C / SIGTERM — do not auto-restart the bot child. */
function isGracefulStopExit(code, signal) {
    if (intentionalShutdown) return true;
    if (signal === 'SIGINT' || signal === 'SIGTERM') return true;
    if (code === 130 || code === 143) return true;
    return false;
}

process.once('SIGINT', () => shutdownAllChildren('SIGINT'));
process.once('SIGTERM', () => shutdownAllChildren('SIGTERM'));

/** Comma- or newline-separated proxy URLs; used when a bot row has no `proxy`. */
function parseProxyPool() {
    const raw = process.env.PROXY_POOL || process.env.PROXY_LIST || '';
    if (!String(raw).trim()) return [];
    return String(raw)
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
}

function redactProxyForLog(proxyUrl) {
    if (!proxyUrl) return '(none)';
    try {
        const s = String(proxyUrl);
        const withProto = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(s) ? s : `http://${s}`;
        const u = new URL(withProto);
        if (u.username) return `${u.protocol}//${u.username}:***@${u.host}`;
        return `${u.protocol}//${u.host}`;
    } catch {
        return '(proxy)';
    }
}

/**
 * Child processes: no credentials in BOT_PROXY — use BOT_PROXY_HOST + BOT_PROXY_USER / BOT_PROXY_PASS
 * (matches imvu-bot / room-joiner parseProxyFromProcessEnv).
 */
function proxyUrlToSplitEnv(proxyUrl) {
    if (!proxyUrl || !String(proxyUrl).trim()) {
        return {
            BOT_PROXY: '',
            BOT_PROXY_HOST: '',
            BOT_PROXY_USER: '',
            BOT_PROXY_PASS: '',
        };
    }
    const s = String(proxyUrl).trim();
    const withProto = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(s) ? s : `http://${s}`;
    let u;
    try {
        u = new URL(withProto);
    } catch {
        return { BOT_PROXY: s, BOT_PROXY_HOST: '', BOT_PROXY_USER: '', BOT_PROXY_PASS: '' };
    }
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    const hostLine = `${u.hostname}:${port}`;
    const user = u.username ? decodeURIComponent(u.username) : '';
    const pass = u.password ? decodeURIComponent(u.password) : '';
    return {
        BOT_PROXY: '',
        BOT_PROXY_HOST: hostLine,
        BOT_PROXY_USER: user,
        BOT_PROXY_PASS: pass,
    };
}

function redactSplitProxyForLog(split) {
    if (!split?.BOT_PROXY_HOST) return split?.BOT_PROXY ? redactProxyForLog(split.BOT_PROXY) : '(empty)';
    const u = split.BOT_PROXY_USER ? `${split.BOT_PROXY_USER}:***` : '(no user)';
    return `${split.BOT_PROXY_HOST} user=${u}`;
}

/**
 * Per-bot proxy: DB `proxy` wins; otherwise round-robin from merged pool (static + discovered).
 */
function resolveProxyForBot(dbProxy, pool, roundRobinIndex) {
    const manual = dbProxy && String(dbProxy).trim();
    if (manual) {
        return { url: manual, source: 'database' };
    }
    if (!pool.length) {
        return { url: null, source: 'none' };
    }
    const i = roundRobinIndex % pool.length;
    return { url: pool[i], source: `pool#${i + 1}/${pool.length}` };
}

function proxyUrlFromParts(username, password, host, port) {
    const h = String(host).trim();
    const pt = String(port).trim();
    if (!h || !pt) return null;
    const u = username != null && String(username) !== '' ? String(username) : '';
    const p = password != null && String(password) !== '' ? String(password) : '';
    if (u) {
        return `http://${encodeURIComponent(u)}:${encodeURIComponent(p)}@${h}:${pt}`;
    }
    return `http://${h}:${pt}`;
}

/**
 * Webshare list API requires ?mode=direct|backbone (400 if omitted).
 * Residential plans: use WEBSHARE_PROXY_MODE=backbone and host p.webshare.io.
 */
async function fetchWebshareProxies(token, targetCount) {
    const modeRaw = (process.env.WEBSHARE_PROXY_MODE || 'direct').trim().toLowerCase();
    const mode = modeRaw === 'backbone' ? 'backbone' : 'direct';

    const out = [];
    let page = 1;
    const pageSize = 25;
    const want = Math.max(1, Math.min(targetCount, 500));
    while (out.length < want && page <= 40) {
        const res = await axios.get('https://proxy.webshare.io/api/v2/proxy/list/', {
            params: { mode, page, page_size: pageSize },
            headers: { Authorization: `Token ${token.trim()}` },
            timeout: 25000,
            validateStatus: () => true,
        });
        if (res.status !== 200) {
            const body =
                typeof res.data === 'object' && res.data !== null
                    ? JSON.stringify(res.data)
                    : String(res.data || res.statusText);
            throw new Error(`HTTP ${res.status}: ${body}`);
        }
        const { data } = res;
        const results = Array.isArray(data?.results) ? data.results : [];
        if (results.length === 0) break;
        for (const row of results) {
            const host =
                mode === 'backbone'
                    ? 'p.webshare.io'
                    : row.proxy_address && String(row.proxy_address).trim();
            const port = row.port;
            const url = proxyUrlFromParts(row.username, row.password, host, port);
            if (url) out.push(url);
            if (out.length >= want) break;
        }
        if (results.length < pageSize) break;
        page += 1;
    }
    return out;
}

/** GET returns JSON array, { proxies: [] }, { results: [...] }, or newline-separated ip:port / URLs */
async function fetchProxiesFromDiscoveryUrl(url) {
    const { data } = await axios.get(url.trim(), { timeout: 30000 });
    if (typeof data === 'string') {
        return data
            .split(/[\n\r]+/)
            .map((s) => s.trim())
            .filter(Boolean)
            .map((line) => {
                if (/^https?:\/\//i.test(line)) return line;
                if (/^[\w.-]+:\d+$/.test(line)) return `http://${line}`;
                return line;
            });
    }
    if (Array.isArray(data)) return data.map(String).filter(Boolean);
    if (data?.proxies && Array.isArray(data.proxies)) return data.proxies.map(String).filter(Boolean);
    if (data?.results && Array.isArray(data.results)) {
        return data.results
            .map((row) =>
                typeof row === 'string'
                    ? row
                    : proxyUrlFromParts(row.username, row.password, row.proxy_address, row.port)
            )
            .filter(Boolean);
    }
    return [];
}

function autoProxyDisabled() {
    const v = (process.env.IMVU_DISABLE_AUTO_PROXY || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Static PROXY_POOL + optional Webshare API + optional PROXY_DISCOVERY_URL.
 * @param {number} botsNeedingAutoProxy — active bots with rooms but no DB proxy
 */
async function buildProxyPool(botsNeedingAutoProxy) {
    const staticList = parseProxyPool();
    const discovered = [];

    if (autoProxyDisabled()) {
        console.warn(
            '[MULTI-LAUNCHER] IMVU_DISABLE_AUTO_PROXY is set — skipping Webshare + PROXY_DISCOVERY_URL. Bots use PROXY_POOL and/or per-row DB proxy only; otherwise direct (home) IP. Use this to confirm ERR_TUNNEL_CONNECTION_FAILED is proxy-related.'
        );
        return [...new Set(staticList)];
    }

    const token = (process.env.WEBSHARE_API_TOKEN || '').trim();
    const needFromProviders = Math.max(0, botsNeedingAutoProxy - staticList.length);

    if (token && needFromProviders > 0) {
        try {
            const target = Math.max(needFromProviders, 10);
            const ws = await fetchWebshareProxies(token, target);
            discovered.push(...ws);
            console.log(`[MULTI-LAUNCHER] 🌐 Webshare: fetched ${ws.length} proxy URL(s) for auto-assign`);
            const modeRaw = (process.env.WEBSHARE_PROXY_MODE || 'direct').trim().toLowerCase();
            if (ws.length > 0 && modeRaw !== 'backbone') {
                console.warn(
                    '[MULTI-LAUNCHER] Webshare is using WEBSHARE_PROXY_MODE=direct (per-IP host). If every child logs ERR_TUNNEL_CONNECTION_FAILED, set WEBSHARE_PROXY_MODE=backbone for residential (gateway p.webshare.io).'
                );
            }
        } catch (e) {
            console.error('[MULTI-LAUNCHER] ❌ WEBSHARE_API_TOKEN fetch failed:', e.message);
        }
    }

    const discUrl = (process.env.PROXY_DISCOVERY_URL || '').trim();
    if (discUrl) {
        try {
            const extra = await fetchProxiesFromDiscoveryUrl(discUrl);
            discovered.push(...extra);
            console.log(
                `[MULTI-LAUNCHER] 🌐 PROXY_DISCOVERY_URL: +${extra.length} entr${extra.length === 1 ? 'y' : 'ies'}`
            );
        } catch (e) {
            console.error('[MULTI-LAUNCHER] ❌ PROXY_DISCOVERY_URL failed:', e.message);
        }
    }

    const merged = [...staticList, ...discovered];
    return [...new Set(merged)];
}

/** Child exit code: parent should pick another Webshare/pool proxy (see room-joiner). */
const EXIT_PROXY_ROTATE = 2;

/**
 * After a blocked proxy, prefer a fresh Webshare list; else next distinct URL in proxyPool.
 */
async function pickNextProxyAfterBlock(launchOpts) {
    const failed = launchOpts.proxy && String(launchOpts.proxy).trim();
    const token = (process.env.WEBSHARE_API_TOKEN || '').trim();

    if (launchOpts.rotateFromWebshare && token && !autoProxyDisabled()) {
        try {
            const n = Math.max(
                10,
                parseInt(process.env.WEBSHARE_ROTATE_FETCH_COUNT || '25', 10)
            );
            const fresh = await fetchWebshareProxies(token, n);
            if (fresh.length) {
                const idx = failed ? fresh.findIndex((u) => u === failed) : -1;
                if (idx >= 0 && fresh.length > 1) {
                    return {
                        url: fresh[(idx + 1) % fresh.length],
                        source: 'webshare-rotate',
                    };
                }
                const alt = failed ? fresh.find((u) => u !== failed) : fresh[0];
                if (alt) return { url: alt, source: 'webshare-rotate' };
            }
        } catch (e) {
            console.error('[MULTI-LAUNCHER] Webshare proxy refresh failed:', e.message);
        }
    }

    const pool = launchOpts.proxyPool || [];
    if (pool.length > 1 && failed) {
        const i = pool.findIndex((u) => u === failed);
        const nextIdx = i >= 0 ? (i + 1) % pool.length : 0;
        const next = pool[nextIdx];
        if (next && next !== failed) {
            return { url: next, source: `pool#${nextIdx + 1}/${pool.length}` };
        }
    }
    return null;
}

async function fetchAllBots() {
    console.log(`[MULTI-LAUNCHER] 📡 Fetching all active bots from backend...`);
    try {
        const { data } = await axios.get(`${API_BASE_URL}/api/bots`);
        return data && Array.isArray(data) ? data : [];
    } catch (e) {
        const st = e.response?.status;
        console.error(
            `[MULTI-LAUNCHER] ❌ Failed to contact backend (${API_BASE_URL}/api/bots${st ? ` → HTTP ${st}` : ''}).`,
            e.message,
        );
        return [];
    }
}

function parseRooms(roomString) {
    if (!roomString) return [];
    return roomString.split(',').map(r => {
        const trimmed = r.trim();
        const m = trimmed.match(/room-([\d-]+)/);
        const raw = m ? m[1] : trimmed.replace(/[^0-9-]/g, '');
        return raw.replace(/^-+|-+$/g, '');
    }).filter(Boolean);
}

const activeBots = new Map();

const LAUNCH_SCRIPT = (process.env.IMVU_LAUNCH_SCRIPT || 'imvu-bot.js').trim();
const LAUNCH_SCRIPT_BASE = path.basename(LAUNCH_SCRIPT);

function staggerMs() {
    return 20000 + Math.random() * 20000;
}

/**
 * Per-child env must not inherit a stale BOT_NAME / proxy / relay port from the parent shell or .env.
 */
function buildChildEnv(botName, proxyUrl, discordRelayPort) {
    const childEnv = { ...process.env, BOT_NAME: botName };
    const split = proxyUrlToSplitEnv(proxyUrl);
    childEnv.BOT_PROXY = split.BOT_PROXY;
    childEnv.BOT_PROXY_HOST = split.BOT_PROXY_HOST;
    childEnv.BOT_PROXY_USER = split.BOT_PROXY_USER;
    childEnv.BOT_PROXY_PASS = split.BOT_PROXY_PASS;
    if (discordRelayPort != null && Number.isFinite(Number(discordRelayPort))) {
        childEnv.IMVU_DISCORD_RELAY_PORT = String(discordRelayPort);
    } else {
        delete childEnv.IMVU_DISCORD_RELAY_PORT;
    }
    childEnv.IMVU_LAUNCHED_FROM_MULTI_LAUNCHER = '1';
    return childEnv;
}

/**
 * Guaranteed per-bot isolation: new process + fresh env object every time (BOT_NAME, BOT_PROXY_*, relay port).
 * Default child is imvu-bot.js (no argv); room-joiner.js receives comma-separated room ids as argv[2].
 */
function spawnIsolatedBotChild(botName, roomsArg, proxyUrl, discordRelayPort) {
    const childEnv = buildChildEnv(botName, proxyUrl, discordRelayPort);
    const argv = LAUNCH_SCRIPT_BASE === 'imvu-bot.js' ? [LAUNCH_SCRIPT] : [LAUNCH_SCRIPT, roomsArg];
    return spawn('node', argv, {
        cwd: __dirname,
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        env: childEnv,
        shell: false,
        detached: false,
    });
}

function spawnIsolatedBotChildTracked(botName, roomsArg, proxyUrl, discordRelayPort) {
    return trackChild(spawnIsolatedBotChild(botName, roomsArg, proxyUrl, discordRelayPort));
}

function runBot(botName, roomsArg, launchOpts = {}) {
    const processKey = `${botName}_${roomsArg}`;
    if (activeBots.has(processKey)) return;
    activeBots.set(processKey, true);

    const proxy = launchOpts.proxy && String(launchOpts.proxy).trim() ? String(launchOpts.proxy).trim() : null;
    const drp = launchOpts.discordRelayPort;
    const childEnv = buildChildEnv(botName, proxy, drp);

    const src = launchOpts.proxySource || (proxy ? 'set' : 'none');
    console.log(
        `\n[MULTI-LAUNCHER] 🚀 Spawning ${LAUNCH_SCRIPT_BASE} [${botName}]${LAUNCH_SCRIPT_BASE === 'imvu-bot.js' ? ' (rooms from API)' : ` rooms: ${roomsArg}`} | proxy: ${src} ${proxy ? `→ ${redactProxyForLog(proxy)}` : '(direct)'}`
    );
    const split = proxyUrlToSplitEnv(proxy);
    console.log(
        `[MULTI-LAUNCHER] child env | BOT_NAME=${botName} | proxy=${proxy ? redactSplitProxyForLog(split) : '(direct)'} | IMVU_DISCORD_RELAY_PORT=${childEnv.IMVU_DISCORD_RELAY_PORT ?? '(unset)'}`
    );

    const child = spawnIsolatedBotChildTracked(botName, roomsArg, proxy, drp);

    console.log(`[MULTI-LAUNCHER] child pid=${child.pid} BOT_NAME=${botName}`);

    child.on('message', (msg) => {
        if (msg && msg.type === 'api' && msg.payload) {
            bulkPost(msg.payload.endpoint, msg.payload.data);
        }
    });

    child.on('exit', (code, signal) => {
        activeBots.delete(processKey);

        if (isGracefulStopExit(code, signal)) {
            console.log(
                `[MULTI-LAUNCHER] Bot ${botName} stopped${signal ? ` (${signal})` : code != null ? ` (code ${code})` : ''}.`
            );
            return;
        }

        if (code === EXIT_PROXY_ROTATE && launchOpts.rotateFromWebshare) {
            const max = Math.max(1, parseInt(process.env.IMVU_MAX_PROXY_ROTATIONS || '10', 10));
            const n = (launchOpts.rotationCount || 0) + 1;
            if (n > max) {
                console.warn(
                    `[MULTI-LAUNCHER] Max proxy rotations (${max}) reached for ${botName}; retry same proxy in 10s.`
                );
                setTimeout(
                    () => runBot(botName, roomsArg, { ...launchOpts, rotationCount: 0 }),
                    10000
                );
                return;
            }
            void (async () => {
                const next = await pickNextProxyAfterBlock(launchOpts);
                if (next) {
                    console.log(
                        `[MULTI-LAUNCHER] 🔄 Proxy blocked / unusable — switching (${n}/${max}): ${redactProxyForLog(launchOpts.proxy)} → ${redactProxyForLog(next.url)}`
                    );
                    setTimeout(
                        () =>
                            runBot(botName, roomsArg, {
                                ...launchOpts,
                                proxy: next.url,
                                proxySource: next.source,
                                rotationCount: n,
                            }),
                        5000
                    );
                } else {
                    console.warn(
                        `[MULTI-LAUNCHER] No alternate proxy (check WEBSHARE_API_TOKEN / PROXY_POOL); retry in 10s.`
                    );
                    setTimeout(() => runBot(botName, roomsArg, launchOpts), 10000);
                }
            })();
            return;
        }

        console.log(`[MULTI-LAUNCHER] ⚠️ Bot ${botName} (${roomsArg}) exited with code ${code}. Restarting in 10s...`);
        setTimeout(
            () => runBot(botName, roomsArg, { ...launchOpts, rotationCount: 0 }),
            10000
        );
    });
}

let discordStarted = false;

function startDiscord() {
    if (discordStarted) return;
    discordStarted = true;

    discordChild = trackChild(
        spawn('node', ['discord-server.js'], {
            cwd: __dirname,
            stdio: 'inherit',
            env: { ...process.env },
        })
    );
}

function pollIntervalMs() {
    return Math.max(5000, parseInt(process.env.MULTI_LAUNCHER_POLL_MS || '60000', 10) || 60000);
}

async function run() {
    let bots = await fetchAllBots();
    while (bots.length === 0) {
        const waitSec = Math.round(pollIntervalMs() / 1000);
        console.warn(
            '[MULTI-LAUNCHER] ⚠️ No active bots from GET /api/bots (empty []). ' +
                'In Laravel production: create a bot, mark it active, assign room_ids.',
        );
        console.warn(`[MULTI-LAUNCHER] Retrying in ${waitSec}s (${API_BASE_URL}/api/bots)…`);
        await new Promise((r) => setTimeout(r, pollIntervalMs()));
        bots = await fetchAllBots();
    }

    if (String(process.env.VIBEVERSE_API_URL || '').trim()) {
        console.log(
            `[MULTI-LAUNCHER] Stream API music mode — skipping Icecast/tunnel ingress (${String(process.env.VIBEVERSE_API_URL).replace(/\/$/, '')})`,
        );
    } else {
        await maybeStartMusicIngressTunnel();
    }

    console.log(`\n[MULTI-LAUNCHER] 🔥 Preparing to launch ${bots.length} active bots!`);
    console.log(`[MULTI-LAUNCHER] 📝 Bots found: ${bots.map((b) => b.name).join(', ')}`);

    const MAX_ROOMS_PER_BOT = 10; // Increased to allow bots to handle their whole assigned list

    let botsNeedingAuto = 0;
    for (const bot of bots) {
        if (!(bot.proxy && String(bot.proxy).trim())) botsNeedingAuto += 1;
    }

    const proxyPool = await buildProxyPool(botsNeedingAuto);
    if (proxyPool.length) {
        console.log(
            `[MULTI-LAUNCHER] 🌐 Proxy pool: ${proxyPool.length} total (static + discovered; used when bot.proxy is empty)`
        );
    } else if (botsNeedingAuto > 0) {
        console.warn(
            '[MULTI-LAUNCHER] ⚠️ Bots have no per-row proxy and pool is empty — traffic uses your server IP. Add WEBSHARE_API_TOKEN (free tier), PROXY_DISCOVERY_URL, or PROXY_POOL.'
        );
    }

    const botsToLaunch = [];
    const seenBotNames = new Set();
    let poolIndex = 0;
    for (const bot of bots) {
        const canonicalName = bot.name != null ? String(bot.name).trim() : '';
        if (!canonicalName) {
            console.warn('[MULTI-LAUNCHER] ⚠️ Skipping bot row with empty name.');
            continue;
        }
        if (seenBotNames.has(canonicalName)) {
            console.warn(
                `[MULTI-LAUNCHER] ⚠️ Duplicate bot name "${canonicalName}" in API list — already launching one process; extra row skipped.`
            );
            continue;
        }
        const rooms = parseRooms(bot.room_ids);
        const { url, source } = resolveProxyForBot(bot.proxy, proxyPool, poolIndex);
        poolIndex += 1;
        seenBotNames.add(canonicalName);
        if (rooms.length === 0) {
            console.log(
                `[MULTI-LAUNCHER] ℹ️ Bot [${canonicalName}] has no rooms — launching idle (DM !join invites users when bot is in a room).`
            );
        }
        botsToLaunch.push({
            name: canonicalName,
            username: bot.username,
            roomsArg: rooms.slice(0, MAX_ROOMS_PER_BOT).join(','),
            proxy: url,
            proxySource: source,
        });
    }

    if (botsToLaunch.length === 0) {
        console.warn('[MULTI-LAUNCHER] ⚠️ No active bots to launch.');
        return;
    }

    if (LAUNCH_SCRIPT_BASE === 'imvu-bot.js') {
        console.log('[MULTI-LAUNCHER] Child script is imvu-bot.js — pure WebSocket runtime.');
    }

    const relayBase = parseInt(process.env.IMVU_DISCORD_RELAY_BASE || '30900', 10);
    const relayPorts = botsToLaunch.map((_, i) => relayBase + i);
    process.env.IMVU_DISCORD_RELAY_PORTS = relayPorts.join(',');
    console.log(
        `[MULTI-LAUNCHER] 📢 Discord→IMVU relay ports (one per bot): ${relayPorts.join(', ')} — discord-server will POST here`
    );

    console.log(`[MULTI-LAUNCHER] 🌐 Booting Discord Integration Server...`);
    startDiscord();

    for (let i = 0; i < botsToLaunch.length; i++) {
        const b = botsToLaunch[i];
        const relayPort = relayPorts[i];
        console.log(`[MULTI-LAUNCHER] 🚀 Launching [${b.name}] (${b.username})${b.roomsArg ? ` for rooms: ${b.roomsArg}` : ' (idle — DM !join)'}`);

        runBot(b.name, b.roomsArg, {
            proxy: b.proxy,
            proxySource: b.proxySource,
            discordRelayPort: relayPort,
            rotateFromWebshare: Boolean(b.proxy && b.proxySource !== 'database'),
            proxyPool: proxyPool,
        });

        if (i < botsToLaunch.length - 1) {
            const waitMs = Math.round(staggerMs());
            console.log(`[MULTI-LAUNCHER] ⏳ Stagger: waiting ${(waitMs / 1000).toFixed(1)}s before next bot profile...`);
            await new Promise((r) => setTimeout(r, waitMs));
        }
    }

    console.log(`\n[MULTI-LAUNCHER] ✅ All multi-bot room joiner processes have been dispatched!`);
}

run();
