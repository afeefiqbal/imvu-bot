import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.join(__dirname, '..', 'data', 'preferred-seats.json');

/** @type {Map<string, { seatNumber: number, seatFurniId: number }>} */
const cache = new Map();
let loaded = false;

function roomKey(roomId) {
    return String(roomId || '')
        .trim()
        .replace(/^room-/i, '');
}

function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    try {
        if (!fs.existsSync(STORE_PATH)) return;
        const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
        for (const [id, seat] of Object.entries(raw)) {
            const key = roomKey(id);
            const seatNumber = Number(seat?.seatNumber ?? seat?.seat_number);
            if (!key || !Number.isFinite(seatNumber) || seatNumber <= 0) continue;
            const seatFurniId = Number(seat?.seatFurniId ?? seat?.seat_furni_id);
            cache.set(key, {
                seatNumber,
                seatFurniId: Number.isFinite(seatFurniId) ? seatFurniId : 0,
            });
        }
    } catch (e) {
        console.warn('[preferred-seats] load failed:', e?.message || e);
    }
}

function persist() {
    try {
        const dir = path.dirname(STORE_PATH);
        fs.mkdirSync(dir, { recursive: true });
        /** @type {Record<string, { seatNumber: number, seatFurniId: number }>} */
        const out = {};
        for (const [key, seat] of cache.entries()) {
            out[key] = seat;
        }
        fs.writeFileSync(STORE_PATH, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
    } catch (e) {
        console.warn('[preferred-seats] save failed:', e?.message || e);
    }
}

/**
 * @param {string} roomId
 * @returns {{ seatNumber: number, seatFurniId: number } | null}
 */
export function getPreferredSeat(roomId) {
    ensureLoaded();
    const key = roomKey(roomId);
    if (!key) return null;
    return cache.get(key) || null;
}

/**
 * @param {string} roomId
 * @param {{ seatNumber?: number, seat_number?: number, seatFurniId?: number, seat_furni_id?: number }} seat
 */
export function setPreferredSeat(roomId, seat) {
    ensureLoaded();
    const key = roomKey(roomId);
    const seatNumber = Number(seat?.seatNumber ?? seat?.seat_number);
    if (!key || !Number.isFinite(seatNumber) || seatNumber <= 0) return null;
    const seatFurniId = Number(seat?.seatFurniId ?? seat?.seat_furni_id);
    const next = {
        seatNumber,
        seatFurniId: Number.isFinite(seatFurniId) ? seatFurniId : 0,
    };
    cache.set(key, next);
    persist();
    console.log(
        `[preferred-seats] saved ${key} → seat ${next.seatNumber} furni ${next.seatFurniId}`
    );
    return next;
}
