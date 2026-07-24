/**
 * Production (Railway private DNS): set ICECAST_HOST to the Icecast service slug only
 * (e.g. `icecast`) and ICECAST_HOST_SUFFIX to `.railway.internal` → `icecast.railway.internal`.
 * Local dev: leave ICECAST_HOST_SUFFIX unset; use ICECAST_HOST=127.0.0.1 as usual.
 */
export function resolvedIcecastHost() {
    let host = String(process.env.ICECAST_HOST ?? '127.0.0.1').trim();
    if (!host) {
        host = '127.0.0.1';
    }

    const suffix = String(process.env.ICECAST_HOST_SUFFIX ?? '').trim();
    if (!suffix) {
        return host;
    }

    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    if (loopback) {
        return host;
    }

    if (host.endsWith(suffix)) {
        return host;
    }

    return `${host}${suffix}`;
}

/** Railway private DNS often resolves to IPv6 first; Icecast listens on IPv4. */
export function icecastConnectFamily(host) {
    return String(host || '').endsWith('.railway.internal') ? 4 : undefined;
}
