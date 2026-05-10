import fs from 'fs';
import path from 'path';

const SINGLETON_NAMES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

/**
 * Remove Chromium "process singleton" artifacts so Puppeteer can start after
 * container restarts with a new hostname while the user-data dir lives on a
 * persistent volume (Railway/Docker). Safe when no other live Chrome uses this dir.
 */
export function cleanupChromeProfileSingletonLocks(profileDir, logTag = 'profile-lock') {
    if (!profileDir) return;

    let rootOk = false;
    try {
        rootOk = fs.existsSync(profileDir);
    } catch {
        return;
    }
    if (!rootOk) return;

    const rm = (p) => {
        try {
            fs.rmSync(p, { force: true, maxRetries: 8, retryDelay: 75 });
        } catch (e) {
            console.warn(`[${logTag}] could not remove stale Chromium lock: ${p} — ${e.message}`);
        }
    };

    const stripInDir = (dir) => {
        for (const name of SINGLETON_NAMES) {
            const p = path.join(dir, name);
            try {
                if (fs.existsSync(p)) rm(p);
            } catch (e) {
                console.warn(`[${logTag}] could not stat lock candidate: ${p} — ${e.message}`);
            }
        }
    };

    stripInDir(profileDir);

    let entries;
    try {
        entries = fs.readdirSync(profileDir, { withFileTypes: true });
    } catch (e) {
        console.warn(`[${logTag}] readdir ${profileDir}: ${e.message}`);
        return;
    }
    for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        stripInDir(path.join(profileDir, ent.name));
    }
}
