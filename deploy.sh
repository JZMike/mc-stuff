#!/usr/bin/env bash
# MikeCommand — deploy idempotente no MikeServer.
# Uso (no MikeServer):  cd /opt/stacks/mikecommand && ./deploy.sh
set -euo pipefail

STACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$STACK_DIR"

echo "▶ MikeCommand — deploy em $STACK_DIR"

# 1) .env
if [ ! -f .env ]; then
  cp .env.example .env
  echo "  • .env criado a partir de .env.example."
  echo "    ⚠ Edita .env e preenche TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID para teres push."
fi

# 2) build + up
echo "▶ docker compose up -d --build"
docker compose up -d --build

# 3) health
echo "▶ a aguardar health..."
for i in $(seq 1 20); do
  if curl -fsS http://localhost:5700/health >/dev/null 2>&1; then
    echo "  ✓ saudável."
    break
  fi
  sleep 1
done
curl -fsS http://localhost:5700/health 2>/dev/null || echo "  ⚠ health ainda não responde — vê: docker compose logs -f"

# 4) Tailscale serve (HTTPS no tailnet) — opcional mas recomendado
if command -v tailscale >/dev/null 2>&1; then
  echo "▶ a expor via Tailscale (HTTPS :5700)"
  sudo tailscale serve --bg --https=5700 http://127.0.0.1:5700 2>/dev/null \
    && echo "  ✓ Tailscale serve ativo." \
    || echo "  • (Tailscale serve falhou/indisponível — a app continua em http://<ip>:5700)"
fi

echo ""
echo "✅ Pronto. Abre no telemóvel:"
echo "   https://mikeserver.tail228d40.ts.net:5700"
echo "   (Adicionar ao ecrã principal = instala a PWA)"
