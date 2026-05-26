import axios from 'axios';
import { backendApiBaseUrl } from './env-app-url.js';

let queue = [];
const API_BASE_URL = backendApiBaseUrl('http://127.0.0.1:8000');

setInterval(async () => {
    if (!queue.length) return;
    let payload;
    try {
        payload = queue.splice(0, queue.length);
        const failedItems = [];
        
        // Process each request individually since backend doesn't have a bulk endpoint
        await Promise.all(payload.map(async (item) => {
            try {
                await axios.post(`${API_BASE_URL}${item.endpoint}`, item.data);
            } catch (err) {
                // Ignore 404s for endpoints that intentionally might be missing (like optional ones), but log them
                // Otherwise re-queue them. (You can tweak error handling as needed, but let's re-queue on 5xx or network errors)
                if (err.response && err.response.status !== 404) {
                    failedItems.push(item);
                } else if (!err.response) {
                    failedItems.push(item); // Network error
                } else {
                    console.error(`[API] Endpoint ${item.endpoint} returned ${err.response.status}`);
                }
            }
        }));

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

    if (queue.length > 2000) return; // Prevent OOM
    queue.push({
        endpoint,
        data,
        timestamp: new Date().toISOString()
    });
};
