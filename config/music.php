<?php

$icecastHost = (string) env('ICECAST_HOST', '127.0.0.1');
$suffix = (string) env('ICECAST_HOST_SUFFIX', '');
if ($suffix !== '' && ! in_array($icecastHost, ['127.0.0.1', 'localhost'], true) && ! str_ends_with($icecastHost, $suffix)) {
    $icecastHost .= $suffix;
}

return [
    'enabled' => env('MUSIC_ENABLED', false),

    'icecast' => [
        'host' => $icecastHost,
        /* Host-side port when Icecast is mapped e.g. Docker 8001→8000; must match Node tunnel + bot. */
        'port' => (int) env('ICECAST_PORT', 8001),
        /** Placeholder `{room}` is replaced with a filesystem-safe slug (e.g. 261755692-875). */
        'mount_template' => env('ICECAST_MOUNT_TEMPLATE', '/imvu-{room}.mp3'),
        'source_user' => env('ICECAST_SOURCE_USER', 'source'),
        'source_password' => env('ICECAST_SOURCE_PASSWORD', ''),
    ],

    /**
     * Full public URL template for IMVU room media (HTTPS), e.g. ngrok or your reverse proxy.
     * Placeholder `{room}` same as mount. Example: https://stream.example.com/imvu-{room}.mp3
     */
    'public_stream_url_template' => env('MUSIC_PUBLIC_STREAM_URL_TEMPLATE', ''),
];
