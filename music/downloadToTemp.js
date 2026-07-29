import { createWriteStream } from 'fs';
import { unlink } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

function maxBytes() {
    const n = parseInt(String(process.env.MUSIC_VV_DOWNLOAD_MAX_BYTES || ''), 10);
    return Number.isFinite(n) && n > 0 ? n : 80 * 1024 * 1024;
}

function downloadTimeoutMs() {
    const n = parseInt(String(process.env.MUSIC_VV_DOWNLOAD_TIMEOUT_MS || ''), 10);
    return Number.isFinite(n) && n > 0 ? n : 120_000;
}

function extFromUrl(url) {
    const m = String(url || '').match(/\.(mp3|m4a|aac|ogg|opus|wav)(?:\?|$)/i);
    return m ? m[1].toLowerCase() : 'mp3';
}

/**
 * Download a durable HTTPS audio URL to a temp file for local ffmpeg -re encode.
 * @param {{ url: string, roomId?: string, label?: string }} opts
 * @returns {Promise<{ filePath: string, bytes: number, cleanup: () => Promise<void> }>}
 */
export async function downloadToTemp({ url, roomId = 'room', label = 'vv' } = {}) {
    const src = String(url || '').trim();
    if (!/^https?:\/\//i.test(src)) {
        throw new Error('downloadToTemp requires an http(s) URL');
    }

    const ext = extFromUrl(src);
    const safeRoom = String(roomId || 'room').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'room';
    const filePath = path.join(
        tmpdir(),
        `imvu-${label}-${safeRoom}-${Date.now()}.${ext}`,
    );

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), downloadTimeoutMs());
    let bytes = 0;
    let cleaned = false;

    const cleanup = async () => {
        if (cleaned) return;
        cleaned = true;
        try {
            await unlink(filePath);
        } catch {
            /* already gone */
        }
    };

    try {
        const res = await fetch(src, {
            method: 'GET',
            signal: ctrl.signal,
            redirect: 'follow',
            headers: { Accept: 'audio/*,*/*' },
        });
        if (!res.ok || !res.body) {
            throw new Error(`download HTTP ${res.status}`);
        }

        const cap = maxBytes();
        const nodeBody = Readable.fromWeb(res.body);
        const limited = new Readable({
            read() {},
        });
        nodeBody.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > cap) {
                nodeBody.destroy(new Error(`download exceeded ${cap} bytes`));
                return;
            }
            limited.push(chunk);
        });
        nodeBody.on('end', () => limited.push(null));
        nodeBody.on('error', (err) => limited.destroy(err));

        await pipeline(limited, createWriteStream(filePath));
        if (bytes < 1024) {
            throw new Error(`download too small (${bytes} bytes)`);
        }
        console.log(
            `[music] downloaded durable audio → ${filePath} (${Math.round(bytes / 1024)} KiB)`,
        );
        return { filePath, bytes, cleanup };
    } catch (err) {
        await cleanup();
        throw err;
    } finally {
        clearTimeout(timer);
    }
}
