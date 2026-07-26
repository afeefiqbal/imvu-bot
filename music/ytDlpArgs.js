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
    if (cookiesFile) {
        args.push('--cookies', cookiesFile);
    } else {
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
