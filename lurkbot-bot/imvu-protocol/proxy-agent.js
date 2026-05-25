import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';

function proxyUrlFromParsed(parsed) {
    if (!parsed?.serverForChrome) return null;
    const withProto = parsed.serverForChrome.includes('://')
        ? parsed.serverForChrome
        : `http://${parsed.serverForChrome}`;
    const url = new URL(withProto);
    if (parsed.auth?.username) {
        url.username = encodeURIComponent(parsed.auth.username);
        url.password = encodeURIComponent(parsed.auth.password || '');
    }
    return url.href;
}

export function createProxyAgents(parsed) {
    const proxyUrl = proxyUrlFromParsed(parsed);
    if (!proxyUrl) {
        return {
            axios: {},
            websocket: {},
            redacted: parsed?.redacted || '(none)',
        };
    }

    const httpAgent = new HttpProxyAgent(proxyUrl);
    const httpsAgent = new HttpsProxyAgent(proxyUrl);

    return {
        axios: {
            httpAgent,
            httpsAgent,
            proxy: false,
        },
        websocket: {
            agent: httpsAgent,
        },
        redacted: parsed?.redacted || '(proxy)',
    };
}
