/**
 * Proxy config shared by the pure WebSocket runtime and older launch helpers.
 *
 * multi-launcher sets BOT_PROXY_HOST (+ BOT_PROXY_USER / BOT_PROXY_PASS) so children
 * do not inherit user:pass inside BOT_PROXY. Manual runs can still use BOT_PROXY=http://user:pass@host:port.
 */

export function parseProxyUrlString(raw) {
    if (!raw || !String(raw).trim()) {
        return { serverForChrome: null, auth: null, redacted: '(none)' };
    }
    const s = String(raw).trim();
    try {
        const withProto = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(s) ? s : `http://${s}`;
        const u = new URL(withProto);
        const user = u.username ? decodeURIComponent(u.username) : '';
        const pass = u.password ? decodeURIComponent(u.password) : '';
        const port = u.port || (u.protocol === 'https:' ? '443' : '80');
        const host = u.hostname;
        if (!host) throw new Error('no host');
        const serverForChrome = `${u.protocol}//${host}:${port}`;
        const redacted = user ? `${u.protocol}//${user}:***@${host}:${port}` : serverForChrome;
        return {
            serverForChrome,
            auth: user ? { username: user, password: pass } : null,
            redacted,
        };
    } catch {
        return { serverForChrome: s, auth: null, redacted: s };
    }
}

function parseProxyFromSplitHost(hostRaw, userRaw, passRaw) {
    const withProto = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(hostRaw) ? hostRaw : `http://${hostRaw}`;
    const u = new URL(withProto);
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    const host = u.hostname;
    if (!host) {
        return { serverForChrome: null, auth: null, redacted: '(invalid BOT_PROXY_HOST)' };
    }
    const serverForChrome = `${u.protocol}//${host}:${port}`;
    const user = userRaw != null ? String(userRaw) : '';
    const pass = passRaw != null ? String(passRaw) : '';
    const auth = user ? { username: user, password: pass } : null;
    const redacted = auth ? `${u.protocol}//${user}:***@${host}:${port}` : serverForChrome;
    return { serverForChrome, auth, redacted };
}

/**
 * @param {{ fallbackRaw?: string }} [options] — e.g. API `proxy` when env BOT_PROXY is empty (room-joiner)
 */
export function parseProxyFromProcessEnv(options = {}) {
    const hostRaw = (process.env.BOT_PROXY_HOST || '').trim();
    if (hostRaw) {
        return parseProxyFromSplitHost(
            hostRaw,
            process.env.BOT_PROXY_USER,
            process.env.BOT_PROXY_PASS
        );
    }
    const combined = (process.env.BOT_PROXY || (options.fallbackRaw != null ? String(options.fallbackRaw) : '') || '').trim();
    return parseProxyUrlString(combined);
}

/** Legacy helper kept for external scripts that still expect browser-style proxy args. */
export function resolveChromeProxy(parsed) {
    if (!parsed?.serverForChrome) {
        return { arg: null, usePageAuthenticate: false };
    }
    if (!parsed.auth) {
        return { arg: parsed.serverForChrome, usePageAuthenticate: false };
    }
    const embed =
        process.env.IMVU_CHROME_PROXY_EMBED_AUTH === '1' ||
        process.env.IMVU_CHROME_PROXY_EMBED_AUTH === 'true';
    if (!embed) {
        return { arg: parsed.serverForChrome, usePageAuthenticate: true };
    }
    try {
        const withProto = parsed.serverForChrome.includes('://')
            ? parsed.serverForChrome
            : `http://${parsed.serverForChrome}`;
        const u = new URL(withProto);
        const host = u.hostname;
        const port = u.port || (u.protocol === 'https:' ? '443' : '80');
        const user = encodeURIComponent(parsed.auth.username);
        const pass = encodeURIComponent(parsed.auth.password || '');
        return {
            arg: `${u.protocol}//${user}:${pass}@${host}:${port}`,
            usePageAuthenticate: false,
        };
    } catch {
        return { arg: parsed.serverForChrome, usePageAuthenticate: true };
    }
}

export function proxyConfigured(parsed) {
    return Boolean(parsed?.serverForChrome);
}
