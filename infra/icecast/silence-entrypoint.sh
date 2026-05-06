#!/bin/sh
set -e
# Must match <source-password> in icecast.xml / ICECAST_SOURCE_PASSWORD in .env
PW="${ICECAST_SOURCE_PASSWORD:-lurkbot_dev}"
HOST="${ICECAST_SILENCE_HOST:-icecast}"
PORT="${ICECAST_SILENCE_PORT:-8000}"
MOUNT="${ICECAST_SILENCE_MOUNT:-/lurkbot-silence.mp3}"
# ffmpeg expects icecast://user:pass@host:port/path
exec ffmpeg -hide_banner -loglevel warning -re \
    -f lavfi -i "anullsrc=r=44100:cl=stereo" \
    -c:a libmp3lame -b:a 64k -ar 44100 -content_type audio/mpeg \
    -f mp3 "icecast://source:${PW}@${HOST}:${PORT}${MOUNT}"
