import axios from 'axios';

let attached = false;

export function botApiSecret() {
    return String(process.env.BOT_API_SECRET || process.env.BOT_API_TOKEN || '').trim();
}

export function applyBotApiAuth() {
    if (attached) return;
    attached = true;
    axios.interceptors.request.use((config) => {
        const secret = botApiSecret();
        if (!secret) return config;
        config.headers = config.headers || {};
        config.headers['X-Bot-Api-Secret'] = secret;
        config.headers.Authorization = `Bearer ${secret}`;
        return config;
    });
}

applyBotApiAuth();
