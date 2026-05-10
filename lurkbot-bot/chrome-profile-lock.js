import fs from 'fs';
import path from 'path';

const SINGLETON_NAMES = new Set(['SingletonLock', 'SingletonCookie', 'SingletonSocket']);

/**
 * Chromium switch (see chrome/common/chrome_switches.cc `kNoProcessSingletonDialog`).
 * Use with Puppeteer alongside deleting stale Singleton* files on persistent volumes;
 * the flag avoids singleton UI paths and helps some headless/container cases.
 */
export const CHROME_EXTRA_SAFE_PROFILE_ARGS = ['--no-process-singleton-dialog'];

/**
 * Remove Chromium "process singleton" artifacts so Puppeteer can start after
 * container restarts with a new hostname while the user-data dir lives on a
 * persistent volume (Railway/Docker). Safe when no other live Chrome uses this dir.
 *
 * Recurses into subdirs (Chrome sometimes leaves copies under profile subtrees;
 * symlinks are removed via lstat + rmSync).
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

    const removed = [];

    const rm = (p) => {
        try {
            fs.rmSync(p, { force: true, maxRetries: 12, retryDelay: 100 });
            removed.push(p);
        } catch (e) {
            console.warn(`[${logTag}] could not remove stale Chromium lock: ${p} — ${e.message}`);
        }
    };

    const considerRemove = (p) => {
        try {
            fs.lstatSync(p);
        } catch {
            return;
        }
        rm(p);
    };

    const maxDepth = Math.max(1, parseInt(process.env.IMVU_PROFILE_LOCK_SCAN_DEPTH || '8', 10));

    const walk = (dir, depthLeft) => {
        if (depthLeft <= 0) return;
        let ents;
        try {
            ents = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            console.warn(`[${logTag}] readdir ${dir}: ${e.message}`);
            return;
        }
        for (const ent of ents) {
            const full = path.join(dir, ent.name);
            if (SINGLETON_NAMES.has(ent.name)) {
                considerRemove(full);
                continue;
            }
            if (ent.isDirectory()) {
                walk(full, depthLeft - 1);
            }
        }
    };

    walk(profileDir, maxDepth);

    if (removed.length > 0) {
        console.log(
            `[${logTag}] removed ${removed.length} stale Chromium singleton path(s) under ${profileDir}`,
        );
    } else if (/^(1|true|yes|on)$/i.test(String(process.env.IMVU_DEBUG_PROFILE_LOCK || '').trim())) {
        console.log(`[${logTag}] no SingletonLock/Cookie/Socket entries found under ${profileDir}`);
    }
}
