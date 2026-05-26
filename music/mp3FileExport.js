import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { spawnYtDlpAudioStdout } from './ytDlpAudioStdout.js';

async function pathIsWritableDir(p) {
    try {
        const st = await fs.stat(p);
        if (!st.isDirectory()) return false;
        await fs.access(p, fs.constants.W_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * Resolve Icecast static webroot where /file.mp3 is served directly.
 * Prefer explicit ICECAST_WEBROOT, fallback to common local/dev paths.
 */
export async function resolveIcecastWebroot() {
    const candidates = [
        String(process.env.ICECAST_WEBROOT || '').trim(),
        '/opt/homebrew/opt/icecast/share/icecast/web',
        '/usr/local/opt/icecast/share/icecast/web',
        '/usr/share/icecast/web',
    ].filter(Boolean);

    for (const c of candidates) {
        if (await pathIsWritableDir(c)) return c;
    }
    return '';
}

function runFfmpegToFile({ inputStdout, outPath }) {
    return new Promise((resolve, reject) => {
        const args = [
            '-hide_banner',
            '-loglevel',
            'warning',
            '-i',
            'pipe:0',
            '-vn',
            '-sn',
            '-c:a',
            'libmp3lame',
            '-b:a',
            '128k',
            '-ar',
            '44100',
            '-y',
            outPath,
        ];
        const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
        let err = '';
        proc.stderr?.on('data', (b) => {
            err += String(b || '');
            if (err.length > 6000) err = err.slice(-3000);
        });

        inputStdout.pipe(proc.stdin);

        proc.once('error', (e) => reject(new Error(`ffmpeg spawn failed: ${e.message}`)));
        proc.once('exit', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`ffmpeg exited with code=${code}. ${err.trim().slice(-500)}`));
        });
    });
}

/**
 * Build a static MP3 file in Icecast webroot and return public URL.
 * This is VOD-like behavior: every open starts from 0:00.
 */
export async function exportYoutubeToStaticMp3Url({ youtubeUrl, publicStreamUrl, roomId }) {
    const webroot = await resolveIcecastWebroot();
    if (!webroot) {
        throw new Error('No writable Icecast webroot found. Set ICECAST_WEBROOT in .env.');
    }
    if (!/^https:\/\//i.test(String(publicStreamUrl || '').trim())) {
        throw new Error('No public HTTPS stream URL available to derive file origin.');
    }

    const origin = new URL(publicStreamUrl).origin;
    const rid = String(roomId || 'room').replace(/[^0-9-]/g, '') || 'room';
    const stamp = Date.now();
    const filename = `vod-${rid}-${stamp}.mp3`;
    const outPath = path.join(webroot, filename);

    const { proc: ytdlpProc, stdout } = spawnYtDlpAudioStdout(youtubeUrl);
    const timeoutMs = Math.max(30_000, parseInt(String(process.env.MUSIC_VOD_EXPORT_TIMEOUT_MS || '240000'), 10) || 240_000);
    const timer = setTimeout(() => {
        try {
            ytdlpProc.kill('SIGKILL');
        } catch {}
    }, timeoutMs);

    try {
        await runFfmpegToFile({ inputStdout: stdout, outPath });
        const st = await fs.stat(outPath);
        if (!st.size || st.size < 4096) {
            throw new Error('Exported mp3 file is too small.');
        }
        return `${origin}/${filename}`;
    } finally {
        clearTimeout(timer);
        try {
            ytdlpProc.kill('SIGKILL');
        } catch {}
    }
}

