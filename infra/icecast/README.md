# Icecast (production)

Separate Icecast service for the IMVU bot workers. The bot image (`/Dockerfile` at repo root) does **not** include Icecast; FFmpeg publishes to this service over Railway private DNS.

## Railway deploy

Use the **same Railway project** as the bot so private DNS works (`icecast.railway.internal`). Two ways to run the container:

### Option A — Docker image (recommended)

Builds run in GitHub Actions; Railway only pulls the image (no Railpack/Dockerfile build on Railway).

1. Push this repo to `main`. Workflow [`.github/workflows/icecast-image.yml`](../../.github/workflows/icecast-image.yml) publishes:
   - `ghcr.io/afeefiqbal/imvu-icecast:latest`
2. On GitHub: **Packages** → `imvu-icecast` → **Package settings** → set visibility to **Public** (simplest), *or* keep private and add GHCR credentials on Railway (Pro).
3. In your **existing** bot Railway project: **+ New** → **Docker Image**.
4. Image: `ghcr.io/afeefiqbal/imvu-icecast:latest`
5. Rename the service to **`icecast`** (Settings → name). Slug must be `icecast` for `icecast.railway.internal`.
6. Set variables (see **Variables** below). **Redeploy** after each new image push.

If the package is **private**, on the Icecast service → **Settings** → **Registry credentials**: username = your GitHub username, password = GitHub PAT with `read:packages`.

Manual build/push (optional):

```bash
cd infra/icecast
docker build -t ghcr.io/afeefiqbal/imvu-icecast:latest .
docker push ghcr.io/afeefiqbal/imvu-icecast:latest
```

### Option B — Build on Railway from GitHub

1. **New Service** → **GitHub Repo** → this repository.
2. **Root Directory** `infra/icecast` (uses `Dockerfile` + `railway.toml`).

### Variables (both options)

| Variable | Value |
|----------|--------|
| `ICECAST_PORT` | `8001` (required — set on **icecast** service; must match bot `ICECAST_PORT`) |
| `ICECAST_SOURCE_PASSWORD` | Strong secret (shared with bot + Laravel) |
| `ICECAST_ADMIN_PASSWORD` | Admin UI password (optional) |

On Railway, set **`ICECAST_PORT=8001`** and **`PORT=8001`** on the icecast service (or set the public domain **target port** to `8001` in Networking). If the proxy targets `8080` but Icecast listens on `8001`, `curl` returns **502 Application failed to respond**.

Networking: prefer **private** only (no public HTTP needed for source ingest). Bots connect on the private network.

On the **bot** service, set (same `ICECAST_SOURCE_PASSWORD`):

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

Mirror Icecast settings in Laravel `config/music.php` (or via `/api/stream-audio-config`) so mounts and passwords stay in sync.

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
