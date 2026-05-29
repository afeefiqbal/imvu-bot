# Icecast (production)

Separate Icecast service for the IMVU bot workers. The bot image (`/Dockerfile` at repo root) does **not** include Icecast; FFmpeg publishes to this service over Railway private DNS.

## Railway deploy

1. In the same Railway project as the bot, **New Service** → **GitHub Repo** → this repository.
2. Set **Root Directory** to `infra/icecast`.
3. Name the service **`icecast`** (slug used for private DNS: `icecast.railway.internal`).
4. Variables on the Icecast service:

   | Variable | Value |
   |----------|--------|
   | `ICECAST_PORT` | `8001` |
   | `ICECAST_SOURCE_PASSWORD` | Strong secret (shared with bot + Laravel) |
   | `ICECAST_ADMIN_PASSWORD` | Admin UI password (optional) |

5. Networking: prefer **private** only (no public HTTP needed for source ingest). Bots connect on the private network.

6. On the **bot** service, set (same `ICECAST_SOURCE_PASSWORD`):

   ```bash
   ICECAST_HOST=icecast
   ICECAST_HOST_SUFFIX=.railway.internal
   ICECAST_PORT=8001
   ICECAST_SOURCE_USER=source
   ICECAST_SOURCE_PASSWORD=<same secret>
   MUSIC_ENABLED=1
   IMVU_MUSIC_ENABLED=true
   CLOUDFLARE_TUNNEL_AUTO=0
   NGROK_TUNNEL_AUTO=0
   MUSIC_PUBLIC_STREAM_URL_TEMPLATE=https://your-stable-https-host/imvu-{room}.mp3
   ```

7. Mirror Icecast settings in Laravel `config/music.php` (or via `/api/stream-audio-config`) so mounts and passwords stay in sync.

## Local build / smoke test

```bash
cd infra/icecast
docker build -t imvu-icecast .
docker run --rm -p 8001:8001 \
  -e ICECAST_SOURCE_PASSWORD=lurkbot_dev \
  imvu-icecast
curl -sS http://127.0.0.1:8001/status-json.xsl | head
```

## Local dev (macOS Homebrew)

Use `icecast.homebrew.xml` from the repo root path and bind `127.0.0.1:8001` — see bot `.env` with `ICECAST_HOST=127.0.0.1` and **no** `ICECAST_HOST_SUFFIX`.

## Public HTTPS for IMVU listeners

IMVU clients need a **stable HTTPS** stream URL (`MUSIC_PUBLIC_STREAM_URL_TEMPLATE`), not a quick Cloudflare/ngrok tunnel from the bot container. Point that URL at Icecast mounts (named Cloudflare Tunnel, reverse proxy, or Laravel-served URL) in production.
