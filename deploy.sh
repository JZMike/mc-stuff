#!/usr/bin/env bash
# MikeCockpit — deploy idempotente no MikeServer.
# Uso (no MikeServer):  cd /opt/projects/mikecockpit && ./deploy.sh
set -euo pipefail

STACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$STACK_DIR"

echo "▶ MikeCockpit — deploy em $STACK_DIR"

# 1) .env
if [ ! -f .env ]; then
  cp .env.example .env
  echo "  • .env criado a partir de .env.example."
  echo "    ⚠ Edita .env e preenche TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID para teres push."
fi

# porta a partir do .env (default 5599)
PORT="$(grep -E '^PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '[:space:]')"
PORT="${PORT:-5599}"
HOST="mikeserver.tail228d40.ts.net"

# 2) build + up
echo "▶ docker compose up -d --build (porta ${PORT})"
docker compose up -d --build

# 3) health
echo "▶ a aguardar health..."
for i in $(seq 1 20); do
  if curl -fsS "http://localhost:${PORT}/health" >/dev/null 2>&1; then
    echo "  ✓ saudável."
    break
  fi
  sleep 1
done
curl -fsS "http://localhost:${PORT}/health" 2>/dev/null || echo "  ⚠ health ainda não responde — vê: docker compose logs -f"

# 4) Tailscale serve (HTTPS no tailnet) — encaminha tailnet:PORT -> 127.0.0.1:PORT
if command -v tailscale >/dev/null 2>&1; then
  echo "▶ a expor via Tailscale (HTTPS :${PORT})"
  # limpa um eventual serve antigo na 5700 (legado)
  [ "$PORT" != "5700" ] && sudo tailscale serve --https=5700 off 2>/dev/null || true
  sudo tailscale serve --bg --https="${PORT}" "http://127.0.0.1:${PORT}" 2>/dev/null \
    && echo "  ✓ Tailscale serve ativo." \
    || echo "  • (Tailscale serve falhou/indisponível)"
fi

echo ""
echo "✅ Pronto. Abre no telemóvel:"
echo "   https://${HOST}:${PORT}"
echo "   (Adicionar ao ecrã principal = instala a PWA)"
