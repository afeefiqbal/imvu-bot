import { spawn } from 'child_process';
import { isYoutubeBotBlockMessage, ytDlpExtraArgs } from './ytDlpArgs.js';

/**
 * Raw audio/video bytes from yt-dlp stdout → FFmpeg stdin (`-i pipe:0`).
 * @param {string} watchUrl canonical https://www.youtube.com/watch?v=…
 * @returns {{ proc: import('child_process').ChildProcess, stdout: import('stream').Readable }}
 */
export function spawnYtDlpAudioStdout(watchUrl) {
    const bin = String(process.env.YTDLP_PATH || 'yt-dlp').trim() || 'yt-dlp';
    const verbose = process.env.MUSIC_FFMPEG_VERBOSE === '1' || process.env.MUSIC_FFMPEG_VERBOSE === 'true';
    const proc = spawn(
        bin,
        [
            '-f',
            /* m4a/AAC often pipes more reliably than webm/opus for FFmpeg stdin (fewer mid-track EOFs). */
            'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
            '--fragment-retries',
            '25',
            '--extractor-retries',
            '3',
            '--socket-timeout',
            '40',
            '-o',
            '-',
            '--no-playlist',
            '--no-warnings',
            ...(verbose ? [] : ['--quiet']),
            '--no-cache-dir',
            ...ytDlpExtraArgs(),
            String(watchUrl || '').trim(),
        ],
        { stdio: ['ignore', 'pipe', verbose ? 'inherit' : 'pipe'] },
    );
    /** @type {Error | null} */
    let spawnError = null;
    if (!verbose && proc.stderr) {
        proc.stderr.on('data', (buf) => {
            const s = String(buf || '').trim();
            if (!s) return;
            console.warn('[music] yt-dlp:', s.slice(0, 500));
            if (isYoutubeBotBlockMessage(s)) {
                spawnError = new Error('youtube-bot-block');
            }
        });
    }
    proc.on('close', (code) => {
        if (code !== 0 && spawnError) {
            proc.emit('error', spawnError);
        }
    });
    proc.on('error', (err) => {
        console.error('[music] yt-dlp spawn:', err.message);
    });
    return { proc, stdout: proc.stdout };
}
