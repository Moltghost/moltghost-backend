#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# tunnel.sh — Expose local backend to the internet via Cloudflare Quick Tunnel
#             and auto-update BACKEND_PUBLIC_URL in .env
# Usage: ./scripts/tunnel.sh [port]
#        port default: 3001
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

PORT="${1:-3001}"
ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"

# ── Check cloudflared ─────────────────────────────────────────────────────────
if ! command -v cloudflared &>/dev/null; then
  echo "❌  cloudflared not found. Install it first:"
  echo ""
  echo "    brew install cloudflare/cloudflare/cloudflared"
  echo ""
  echo "    or download manually at:"
  echo "    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  exit 1
fi

echo "🚇  Starting Cloudflare Quick Tunnel → http://localhost:${PORT}"
echo "    (press Ctrl+C to stop)"
echo ""

# ── Run cloudflared, capture URL, update .env ────────────────────────────────
TUNNEL_URL=""

cloudflared tunnel --url "http://localhost:${PORT}" 2>&1 | while IFS= read -r line; do
  echo "$line"

  # cloudflared prints URL in the line containing trycloudflare.com
  if [[ "$line" =~ (https://[a-zA-Z0-9-]+\.trycloudflare\.com) ]] && [[ -z "$TUNNEL_URL" ]]; then
    TUNNEL_URL="${BASH_REMATCH[1]}"

    echo ""
    echo "✅  Tunnel active: $TUNNEL_URL"

    # Update BACKEND_PUBLIC_URL in .env
    if [[ -f "$ENV_FILE" ]]; then
      if grep -q "^BACKEND_PUBLIC_URL=" "$ENV_FILE"; then
        # macOS sed requires '' after -i
        sed -i '' "s|^BACKEND_PUBLIC_URL=.*|BACKEND_PUBLIC_URL=${TUNNEL_URL}|" "$ENV_FILE"
        echo "📝  .env updated: BACKEND_PUBLIC_URL=${TUNNEL_URL}"
      else
        echo "BACKEND_PUBLIC_URL=${TUNNEL_URL}" >> "$ENV_FILE"
        echo "📝  .env appended: BACKEND_PUBLIC_URL=${TUNNEL_URL}"
      fi
    else
      echo "⚠️   .env file not found at ${ENV_FILE}"
      echo "     Set manually: BACKEND_PUBLIC_URL=${TUNNEL_URL}"
    fi

    echo ""
    echo "💡  Restart the backend (pnpm dev) to pick up the new env."
    echo ""
  fi
done
