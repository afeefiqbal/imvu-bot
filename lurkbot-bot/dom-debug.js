console.log(
    [
        '[DOM-DEBUG] Chromium DOM debugging has been removed from this bot runtime.',
        'Use WS_DEBUG=1 or WS_DEBUG_VERBOSE=1 with node imvu-bot.js to inspect direct WebSocket frames.',
        'Set IMVU_WS_FRAME_SPEC_JSON or the IMVU_WS_* template env vars from your authorized capture before connecting.',
    ].join('\n')
);
