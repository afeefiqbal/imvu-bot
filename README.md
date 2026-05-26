# imvu-bot

Node.js IMVU bot worker. The Laravel backend lives in
https://github.com/afeefiqbal/imvu-bot-laravel.

## Run

```bash
npm install
npm start
```

Set `BOT_API_BASE_URL` to the Laravel app URL, for example:

```bash
BOT_API_BASE_URL=https://your-laravel-service.up.railway.app npm start
```

## Combined System‑wide VPN + Per‑Bot Proxy Setup

## 1️⃣ Start your system‑wide VPN
- Open your VPN client (e.g., Mullvad, AirVPN, ExpressVPN) and **connect**.
- Verify the public IP has changed:
  ```bash
  curl https://ifconfig.me
  ```
- Keep the VPN running for the entire lifetime of the bots. All non‑Chrome traffic (API calls, Laravel backend, Discord bot, etc.) will automatically use this VPN.

## 2️⃣ Configure per‑bot proxies (optional, for distinct IPs)
- Some VPN providers expose a **local SOCKS/HTTP proxy** (usually `127.0.0.1:1080`).
- Edit `bots.json` and add a `proxy` field for any bot that should use its own proxy. Example:
  ```json
  [
    {
      "name": "Bot‑Alpha",
      "username": "alpha_bot",
      "password": "SuperSecret1!",
      "authToken": "xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "proxy": "socks5://127.0.0.1:1080"
    },
    {
      "name": "Bot‑Beta",
      "username": "beta_bot",
      "password": "SuperSecret2!",
      "authToken": "yyyyyyyyyyyyyyyyyyyyyyyyyyyy",
      "proxy": "socks5://127.0.0.1:1081"
    }
  ]
  ```
- If a bot **does not** have a `proxy` entry, it will fall back to the system‑wide VPN (the default behavior).

## 3️⃣ Launch the bots
You can start the VPN manually (step 1) and then run the launcher:
```bash
node multi-launcher.js
```
Or you can use the helper script below to start an OpenVPN connection **automatically** and then launch the bots.

## 4️⃣ Helper script – `start-vpn-and-launch.sh`
```bash
#!/usr/bin/env bash

# ------------------------------------------------------------
# 1️⃣ Start OpenVPN (replace the path with your own .ovpn file)
# ------------------------------------------------------------
VPN_CONFIG="$HOME/vpn/myvpn.ovpn"
if [[ -f "$VPN_CONFIG" ]]; then
  echo "🔐 Starting OpenVPN…"
  sudo openvpn --config "$VPN_CONFIG" --daemon
  # Give OpenVPN a few seconds to establish the tunnel
  sleep 5
else
  echo "⚠️ VPN config not found at $VPN_CONFIG – please start your VPN manually."
fi

# ------------------------------------------------------------
# 2️⃣ Verify public IP (should be the VPN IP)
# ------------------------------------------------------------
echo "🌐 Current public IP: $(curl -s https://ifconfig.me)"

# ------------------------------------------------------------
# 3️⃣ Launch all bots
# ------------------------------------------------------------
node $(dirname "$0")/multi-launcher.js
```
- Save this script as `start-vpn-and-launch.sh` in the project root.
- Make it executable: `chmod +x start-vpn-and-launch.sh`.
- Run it: `./start-vpn-and-launch.sh`.

## 5️⃣ Verify per‑bot proxy usage
Each bot logs its name and the proxy it’s using (if any):
```
[Bot‑Alpha] Launching your custom Chrome window...
[Bot‑Beta]  Launching your custom Chrome window...
```
If a proxy is set, you’ll also see Chrome started with `--proxy-server=…` in the debug output.

---
**Summary**: Keep the system‑wide VPN active for all traffic, and optionally add `proxy` entries in `bots.json` to give individual bots their own exit IPs. Use the helper script to automate the VPN start‑up and bot launch.
