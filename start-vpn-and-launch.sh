#!/usr/bin/env bash

# ------------------------------------------------------------
# 1️⃣ Launch all Alexa bots
# ------------------------------------------------------------
echo "🌐 Starting Alexa Bots..."
node "$(dirname "$0")/lurkbot-bot/multi-launcher.js"
