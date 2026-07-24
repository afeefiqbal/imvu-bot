/**
 * Shared yt-dlp CLI flags (cookies, etc.) for resolve + stream.
 * @returns {string[]}
 */
export function ytDlpExtraArgs() {
    const cookiesFile = String(process.env.YTDLP_COOKIES_FILE || '').trim();
    if (cookiesFile) {
        return ['--cookies', cookiesFile];
    }
    const fromBrowser = String(process.env.YTDLP_COOKIES_FROM_BROWSER || '').trim();
    if (fromBrowser) {
        return ['--cookies-from-browser', fromBrowser];
    }
    return [];
}

/** @param {string} text */
export function isYoutubeBotBlockMessage(text) {
    const s = String(text || '');
    return /sign in to confirm you.?re not a bot|confirm you.?re not a bot/i.test(s);
}
