import { spawn } from 'child_process';
import path from 'path';

function ffmpegVerbose() {
    return process.env.MUSIC_FFMPEG_VERBOSE === '1' || process.env.MUSIC_FFMPEG_VERBOSE === 'true';
}

/**
 * HLS from an HTTP(S) audio source (signed R2 or yt-dlp CDN).
 *
 * Critical: always read with `-re` (realtime). Without it, ffmpeg munches a
 * whole R2/MP3 file in seconds, deletes early segments (live window), and IMVU
 * joins a near-empty playlist → silence / end-of-track only.
 *
 * @param {object} opts
 * @param {string} opts.sourceUrl
 * @param {string} opts.outDir
 * @param {number} [opts.segmentSeconds]
 * @param {'live'|'vod'} [opts.playlistMode] live sliding window (default) or vod
 * @returns {{ proc: import('child_process').ChildProcess, playlistPath: string }}
 */
export function createFfmpegHttpToHls({
    sourceUrl,
    outDir,
    segmentSeconds = 2,
    playlistMode = 'live',
}) {
    const src = String(sourceUrl || '').trim();
    const dir = String(outDir || '').trim();
    if (!/^https?:\/\//i.test(src)) {
        throw new Error('ffmpeg http→hls requires an http(s) source URL');
    }
    if (!dir) throw new Error('ffmpeg http→hls requires outDir');

    const segSec = Math.max(1, Math.min(6, Number(segmentSeconds) || 2));
    const playlistPath = path.join(dir, 'index.m3u8');
    const segPattern = path.join(dir, 'seg_%05d.ts');
    const vod = String(playlistMode || 'live').toLowerCase() === 'vod';
    // ~40s of backlog so a slow IMVU client doesn't fall out of the window.
    const liveListSize = Math.max(
        10,
        parseInt(String(process.env.MUSIC_HLS_LIST_SIZE || '20'), 10) || 20,
    );

    const args = [
        '-hide_banner',
        '-loglevel',
        ffmpegVerbose() ? 'info' : 'warning',
        // Pace input to realtime — required for file/R2 sources or the live
        // window races ahead of the listener.
        '-re',
        '-user_agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        '-headers',
        'Referer: https://www.youtube.com/\r\n',
        '-reconnect',
        '1',
        '-reconnect_streamed',
        '1',
        '-reconnect_delay_max',
        '5',
        '-fflags',
        '+genpts+discardcorrupt',
        '-probesize',
        '65536',
        '-analyzeduration',
        '1000000',
        '-i',
        src,
        '-vn',
        '-sn',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ar',
        '44100',
        '-ac',
        '2',
        '-f',
        'hls',
        '-hls_time',
        String(segSec),
        '-hls_segment_filename',
        segPattern,
    ];

    if (vod) {
        args.push(
            '-hls_playlist_type',
            'vod',
            '-hls_list_size',
            '0',
            '-hls_flags',
            'independent_segments',
        );
    } else {
        args.push(
            '-hls_list_size',
            String(liveListSize),
            // temp_file: only publish a segment after it's fully written (avoids 0-byte
            // last segment that breaks IMVU / picky players → silence).
            '-hls_flags',
            'temp_file+delete_segments+append_list+omit_endlist+independent_segments',
        );
    }

    args.push(playlistPath);

    const proc = spawn('ffmpeg', args, {
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    proc.on('error', (err) => {
        console.error('[music] ffmpeg HLS spawn failed:', err.message);
    });
    if (proc.stderr) {
        proc.stderr.on('data', (buf) => {
            const line = String(buf || '')
                .trim()
                .split('\n')
                .filter(Boolean)
                .slice(-2)
                .join(' · ');
            if (!line) return;
            if (/error|fail|invalid/i.test(line)) {
                console.warn('[music] ffmpeg HLS:', line.slice(0, 900));
            } else if (ffmpegVerbose()) {
                console.log('[music] ffmpeg HLS:', line.slice(0, 400));
            }
        });
    }

    return { proc, playlistPath };
}
