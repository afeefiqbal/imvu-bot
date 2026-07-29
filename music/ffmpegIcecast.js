import { spawn } from 'child_process';

function ffmpegVerbose() {
    return process.env.MUSIC_FFMPEG_VERBOSE === '1' || process.env.MUSIC_FFMPEG_VERBOSE === 'true';
}

function ffmpegAudioFilter() {
    /* YouTube pipe (m4a/webm fragments) often has broken DTS; MP3 muxer then floods "non monotonically increasing dts". */
    return (
        String(process.env.MUSIC_FFMPEG_AF || '').trim() ||
        'asetpts=PTS-STARTPTS,aresample=44100:async=1:min_hard_comp=0.1:max_soft_comp=0.9'
    );
}

function attachFfmpegStderr(proc, { sourceLabel = 'pipe' } = {}) {
    let dtsMuxSpam = 0;
    if (!proc.stderr) return;
    proc.stderr.on('data', (buf) => {
        const s = String(buf || '').trim();
        if (!s) return;
        const line = s.split('\n').filter(Boolean).slice(-3).join(' · ');
        const low = line.toLowerCase();
        const icecastSinkFail =
            /connection refused|econnrefused|401|403|unauthorized|wrong password|authentication failed|server returned error/i.test(
                line,
            ) || (low.includes('icecast') && /error|failed|invalid/i.test(low));
        if (icecastSinkFail) {
            console.error('[music] ffmpeg Icecast output (sink):', line.slice(0, 900));
            return;
        }
        /* FFmpeg’s Icecast muxer warns for MP3 even when Icecast accepts it — not a failure. */
        if (low.includes('unsupported format') && low.includes('not officially supported in icecast')) {
            return;
        }
        if (low.includes('non monotonically increasing dts')) {
            dtsMuxSpam += 1;
            if (dtsMuxSpam === 1) {
                console.warn(
                    `[music] ffmpeg: non-monotonic DTS from ${sourceLabel}→MP3. Suppressing repeat lines; tune with MUSIC_FFMPEG_AF if needed.`,
                );
            }
            return;
        }
        console.warn('[music] ffmpeg:', line.slice(0, 900));
    });
}

/**
 * Pipe decoded audio into Icecast via ffmpeg.
 * @param {{ icecastDestUrl: string }} opts
 * @returns {{ proc: import('child_process').ChildProcess, stdin: import('stream').Writable }}
 */
export function createFfmpegIcecastPipe({ icecastDestUrl }) {
    const af = ffmpegAudioFilter();
    const args = [
        '-hide_banner',
        '-loglevel',
        ffmpegVerbose() ? 'info' : 'warning',
        // Keep stream wall-clock/live; without this, ffmpeg can run faster than real-time from pipe input.
        '-re',
        '-fflags',
        '+genpts+discardcorrupt',
        '-probesize',
        '65536',
        '-analyzeduration',
        '1500000',
        '-i',
        'pipe:0',
        '-vn',
        '-sn',
        '-af',
        af,
        '-c:a',
        'libmp3lame',
        '-b:a',
        '128k',
        '-ar',
        '44100',
        '-f',
        'mp3',
        icecastDestUrl,
    ];
    const proc = spawn('ffmpeg', args, {
        stdio: ['pipe', 'ignore', 'pipe'],
    });
    proc.on('error', (err) => {
        console.error('[music] ffmpeg spawn failed (is `ffmpeg` installed and on PATH?):', err.message);
    });
    attachFfmpegStderr(proc, { sourceLabel: 'pipe' });
    return { proc, stdin: proc.stdin };
}

/**
 * Pull an HTTPS/HTTP audio URL and re-encode live into Icecast (shared room radio).
 * @param {{ sourceUrl: string, icecastDestUrl: string }} opts
 * @returns {{ proc: import('child_process').ChildProcess }}
 */
export function createFfmpegHttpToIcecast({ sourceUrl, icecastDestUrl }) {
    const src = String(sourceUrl || '').trim();
    const dest = String(icecastDestUrl || '').trim();
    if (!/^https?:\/\//i.test(src)) {
        throw new Error('ffmpeg http→icecast requires an http(s) source URL');
    }
    if (!/^icecast:\/\//i.test(dest)) {
        throw new Error('ffmpeg http→icecast requires an icecast:// destination');
    }
    const af = ffmpegAudioFilter();
    const args = [
        '-hide_banner',
        '-loglevel',
        ffmpegVerbose() ? 'info' : 'warning',
        '-re',
        '-fflags',
        '+genpts+discardcorrupt',
        '-probesize',
        '65536',
        '-analyzeduration',
        '1500000',
        '-i',
        src,
        '-vn',
        '-sn',
        '-af',
        af,
        '-c:a',
        'libmp3lame',
        '-b:a',
        '128k',
        '-ar',
        '44100',
        '-f',
        'mp3',
        dest,
    ];
    const proc = spawn('ffmpeg', args, {
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    proc.on('error', (err) => {
        console.error('[music] ffmpeg spawn failed (is `ffmpeg` installed and on PATH?):', err.message);
    });
    attachFfmpegStderr(proc, { sourceLabel: 'http' });
    return { proc };
}
