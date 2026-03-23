#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# tunnel.sh — Expose backend local ke internet via Cloudflare Quick Tunnel
#             dan auto-update BACKEND_PUBLIC_URL di .env
# Usage: ./scripts/tunnel.sh [port]
#        port default: 3001
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

PORT="${1:-3001}"
ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"

# ── Check cloudflared ─────────────────────────────────────────────────────────
if ! command -v cloudflared &>/dev/null; then
  echo "❌  cloudflared tidak ditemukan. Install dulu:"
  echo ""
  echo "    brew install cloudflare/cloudflare/cloudflared"
  echo ""
  echo "    atau download manual di:"
  echo "    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  exit 1
fi

echo "🚇  Memulai Cloudflare Quick Tunnel → http://localhost:${PORT}"
echo "    (tekan Ctrl+C untuk stop)"
echo ""

# ── Jalankan cloudflared, tangkap URL, update .env ───────────────────────────
TUNNEL_URL=""

cloudflared tunnel --url "http://localhost:${PORT}" 2>&1 | while IFS= read -r line; do
  echo "$line"

  # cloudflared print URL di baris yang mengandung trycloudflare.com
  if [[ "$line" =~ (https://[a-zA-Z0-9-]+\.trycloudflare\.com) ]] && [[ -z "$TUNNEL_URL" ]]; then
    TUNNEL_URL="${BASH_REMATCH[1]}"

    echo ""
    echo "✅  Tunnel aktif: $TUNNEL_URL"

    # Update BACKEND_PUBLIC_URL di .env
    if [[ -f "$ENV_FILE" ]]; then
      if grep -q "^BACKEND_PUBLIC_URL=" "$ENV_FILE"; then
        # macOS sed butuh '' setelah -i
        sed -i '' "s|^BACKEND_PUBLIC_URL=.*|BACKEND_PUBLIC_URL=${TUNNEL_URL}|" "$ENV_FILE"
        echo "📝  .env diupdate: BACKEND_PUBLIC_URL=${TUNNEL_URL}"
      else
        echo "BACKEND_PUBLIC_URL=${TUNNEL_URL}" >> "$ENV_FILE"
        echo "📝  .env ditambahkan: BACKEND_PUBLIC_URL=${TUNNEL_URL}"
      fi
    else
      echo "⚠️   File .env tidak ditemukan di ${ENV_FILE}"
      echo "     Set manual: BACKEND_PUBLIC_URL=${TUNNEL_URL}"
    fi

    echo ""
    echo "💡  Restart backend (pnpm dev) supaya env terbaca ulang."
    echo ""
  fi
done
