import axios from 'axios';
import dotenv from 'dotenv';
import { appBaseUrl } from './env-app-url.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const API_BASE_URL = appBaseUrl('http://127.0.0.1:8000');
console.log('Testing bot fetch from:', API_BASE_URL);

async function test() {
    try {
        const { data } = await axios.get(`${API_BASE_URL}/api/bots`);
        console.log('Bots found:', data.length);
        data.forEach(b => console.log(`- ${b.name} (${b.username}) - active: ${b.is_active}`));
    } catch (e) {
        console.error('Fetch failed:', e.message);
    }
}
test();
