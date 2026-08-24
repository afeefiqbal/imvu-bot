import axios from 'axios';
import { backendApiBaseUrl } from './env-app-url.js';
import { applyBotApiAuth } from './laravel-auth.js';

applyBotApiAuth();

async function mapLimit(items, limit, fn) {
    const concurrency = Math.max(1, Math.min(limit, items.length || 1));
    let index = 0;
    await Promise.all(
        Array.from({ length: concurrency }, async () => {
            while (index < items.length) {
                const current = index++;
                await fn(items[current]);
            }
        }),
    );
}

let queue = [];
const API_BASE_URL = backendApiBaseUrl('http://127.0.0.1:8000');

setInterval(async () => {
    if (!queue.length) return;
    let payload;
    try {
        payload = queue.splice(0, queue.length);
        const failedItems = [];
        
        const concurrency = Math.max(1, parseInt(process.env.API_QUEUE_CONCURRENCY || '6', 10) || 6);
        await mapLimit(payload, concurrency, async (item) => {
            try {
                await axios.post(`${API_BASE_URL}${item.endpoint}`, item.data);
            } catch (err) {
                if (err.response && err.response.status !== 404) {
                    failedItems.push(item);
                } else if (!err.response) {
                    failedItems.push(item);
                } else {
                    console.error(`[API] Endpoint ${item.endpoint} returned ${err.response.status}`);
                }
            }
        });

        if (failedItems.length > 0) {
             queue.unshift(...failedItems);
             if (queue.length > 2000) queue.length = 2000;
        }
    } catch (e) {
        console.error('[BULK] Unhandled error during request processing:', e.message);
    }
}, 3000);

export const bulkPost = (endpoint, data) => {
    if (typeof process.send === 'function') {
        try {
            process.send({ type: 'api', payload: { endpoint, data } });
            return;
        } catch (e) {
            // fallback to local queue if IPC fails
        }
    }

    if (queue.length > 2000) {
        console.warn(`[API] queue full (${queue.length}); dropping ${endpoint}`);
        return;
    }
    queue.push({
        endpoint,
        data,
        timestamp: new Date().toISOString()
    });
};
