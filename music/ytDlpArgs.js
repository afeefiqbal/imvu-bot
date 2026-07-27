import fs from 'fs';

/**
 * Netscape cookie jar usable by yt-dlp (non-empty, not wiped to 0 bytes).
 * @param {string} path
 */
function cookiesFileLooksValid(path) {
    try {
        const st = fs.statSync(path);
        if (!st.isFile() || st.size < 32) return false;
        const fd = fs.openSync(path, 'r');
        try {
            const buf = Buffer.alloc(Math.min(512, st.size));
            const n = fs.readSync(fd, buf, 0, buf.length, 0);
            const head = buf.slice(0, n).toString('utf8');
            if (!head.trim()) return false;
            // yt-dlp: "does not look like a Netscape format cookies file"
            if (/#\s*Netscape/i.test(head) || /#\s*HTTP Cookie File/i.test(head)) return true;
            // Some exports omit the header but still have tab-separated rows.
            return /\tyoutube\.com\t/i.test(head) || /\t\.youtube\.com\t/i.test(head);
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return false;
    }
}

/**
 * Shared yt-dlp CLI flags (cookies, etc.) for resolve + stream.
 * @returns {string[]}
 */
export function ytDlpExtraArgs() {
    /** @type {string[]} */
    const args = [];
    // YouTube “n” challenge — without a JS runtime yt-dlp often only sees images.
    const jsRuntime = String(process.env.YTDLP_JS_RUNTIMES || 'node').trim();
    if (jsRuntime && jsRuntime !== '0' && jsRuntime.toLowerCase() !== 'off') {
        args.push('--js-runtimes', jsRuntime);
    }
    const cookiesFile = String(process.env.YTDLP_COOKIES_FILE || '').trim();
    if (cookiesFile && cookiesFileLooksValid(cookiesFile)) {
        args.push('--cookies', cookiesFile);
    } else {
        if (cookiesFile) {
            console.warn(
                `[music] YTDLP_COOKIES_FILE is missing/empty/invalid (${cookiesFile}) — skipping --cookies. Export a Netscape cookies.txt and chmod 444 it.`,
            );
        }
        const fromBrowser = String(process.env.YTDLP_COOKIES_FROM_BROWSER || '').trim();
        if (fromBrowser) {
            args.push('--cookies-from-browser', fromBrowser);
        }
    }
    return args;
}

/** @param {string} text */
export function isYoutubeBotBlockMessage(text) {
    const s = String(text || '');
    return /sign in to confirm you.?re not a bot|confirm you.?re not a bot/i.test(s);
}
