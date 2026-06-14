"""Catálogo de apps/containers conhecidos — para o "helper" de triagem e o mapa.

Dá, para cada container, um resumo humano (o que é, para que serve, criticidade,
impacto) + uma chave de ícone SVG (`svg`). Match por nome do container ou imagem.
"""
from __future__ import annotations

import json
import os

# critical: "alta" | "media" | "baixa"  ·  svg: chave do ícone (ver web/app.js ICONS)
_CATALOG: list[dict] = [
    {"match": ["nginx-proxy-manager"], "icon": "🌐", "svg": "proxy",
     "what": "Nginx Proxy Manager (reverse proxy + SSL)",
     "purpose": "Encaminha domínios/portas para as apps e trata dos certificados.",
     "critical": "alta", "impact": "Derruba o acesso a **todas** as apps que passam por ele."},
    {"match": ["traefik"], "icon": "🌐", "svg": "proxy", "what": "Traefik (reverse proxy)",
     "purpose": "Router de tráfego para os containers.", "critical": "alta",
     "impact": "Apps atrás do Traefik ficam inacessíveis."},
    {"match": ["cloudflared", "cloudflare-tunnel"], "icon": "☁️", "svg": "cloud", "what": "Cloudflare Tunnel",
     "purpose": "Expõe apps à internet sem abrir portas.", "critical": "alta",
     "impact": "Apps públicas via tunnel deixam de responder."},
    {"match": ["tailscale"], "icon": "🔒", "svg": "lock", "what": "Tailscale (VPN da tailnet)",
     "purpose": "Rede privada por onde acedes a tudo.", "critical": "alta",
     "impact": "Perdes o acesso remoto ao servidor."},
    {"match": ["sshd", "openssh"], "icon": "⌨️", "svg": "terminal", "what": "SSH",
     "purpose": "Acesso remoto por linha de comando.", "critical": "alta",
     "impact": "Perdes o SSH ao servidor."},
    {"match": ["adguard", "pihole"], "icon": "🛡️", "svg": "shield", "what": "AdGuard / DNS + bloqueio de ads",
     "purpose": "Resolve o DNS da rede e bloqueia anúncios.", "critical": "alta",
     "impact": "Se for o DNS da rede, a navegação pode **parar**."},
    {"match": ["portainer"], "icon": "🐳", "svg": "cube", "what": "Portainer (gestão de Docker)",
     "purpose": "UI web para gerir containers e stacks.", "critical": "media",
     "impact": "Perdes a UI de gestão; os containers continuam a correr."},
    {"match": ["mikecockpit", "mc-stuff"], "icon": "🎛️", "svg": "server", "what": "MikeCockpit (este painel)",
     "purpose": "Comando e telemetria do MikeServer.", "critical": "media",
     "impact": "Perdes este painel — o servidor continua a funcionar."},
    {"match": ["coreroom-blueprint"], "icon": "🧩", "svg": "puzzle", "what": "CoreRoom Blueprint (gerador)",
     "purpose": "Geração de blueprints do CoreRoom.", "critical": "baixa",
     "impact": "Função de blueprint indisponível. **Parado/crashou — candidato a rever.**"},
    {"match": ["azure-coreroom"], "icon": "🧪", "svg": "flask", "what": "CoreRoom Light (Azure) — experimental",
     "purpose": "Variante leve do CoreRoom (ensaio).", "critical": "baixa",
     "impact": "Nenhum — **parado; provável candidato a remover.**"},
    {"match": ["coreroom"], "icon": "🧩", "svg": "puzzle", "what": "CoreRoom (motor + PWA)",
     "purpose": "Delivery intelligence de projetos BC + app mobile (:4000).", "critical": "media",
     "impact": "A app/PWA CoreRoom fica indisponível."},
    {"match": ["mikecommand"], "icon": "🕹️", "svg": "panel", "what": "MikeCommand (app)",
     "purpose": "O teu projeto MikeCommand (frontend/api/db/agent).", "critical": "media",
     "impact": "A app MikeCommand fica em baixo."},
    {"match": ["vantage"], "icon": "📰", "svg": "news", "what": "Vantage (briefing)",
     "purpose": "App de briefing/insights (:5555).", "critical": "media",
     "impact": "A app Vantage fica indisponível."},
    {"match": ["tradeagent"], "icon": "📈", "svg": "chart", "what": "TradeAgent (trading)",
     "purpose": "App de trading/rotina intraday.", "critical": "media",
     "impact": "A app TradeAgent fica indisponível."},
    {"match": ["memorix"], "icon": "🧠", "svg": "spark", "what": "Memorix (app pessoal)",
     "purpose": "Stack Memorix (web + api + BD).", "critical": "media",
     "impact": "A app Memorix fica em baixo."},
    {"match": ["lente"], "icon": "🔎", "svg": "search", "what": "Lente (SAF-T insights)",
     "purpose": "Análise de SAF-T (postgres + redis + minio).", "critical": "media",
     "impact": "A análise SAF-T fica indisponível."},
    {"match": ["immich"], "icon": "📷", "svg": "photo", "what": "Immich (fotos)",
     "purpose": "BD de fotos do Immich.", "critical": "media",
     "impact": "O Immich fica sem dados."},
    {"match": ["activity-hub"], "icon": "📊", "svg": "chart", "what": "Activity Hub",
     "purpose": "Hub de atividade (app + postgres).", "critical": "media",
     "impact": "A app Activity Hub fica em baixo. _(descrição estimada.)_"},
    {"match": ["openclaw"], "icon": "🦅", "svg": "bolt", "what": "OpenClaw (gateway)",
     "purpose": "Gateway OpenClaw (:18789).", "critical": "media",
     "impact": "O gateway OpenClaw fica indisponível. _(estimado.)_"},
    {"match": ["n8n"], "icon": "🔗", "svg": "flow", "what": "n8n (automações)",
     "purpose": "Motor de workflows/automação (:5678).", "critical": "media",
     "impact": "As automações n8n param."},
    {"match": ["ha-dashboard", "homeassistant", "home-assistant"], "icon": "🏠", "svg": "home",
     "what": "Home Assistant / Dashboard", "purpose": "Domótica / dashboard de casa.",
     "critical": "baixa", "impact": "Perdes o dashboard (não afeta automações)."},
    {"match": ["homepage"], "icon": "🏁", "svg": "grid", "what": "Homepage (portal de atalhos)",
     "purpose": "Painel/portal de atalhos para as apps (:3001).", "critical": "baixa",
     "impact": "Perdes a página de início."},
    {"match": ["jellyfin", "plex", "emby"], "icon": "🎬", "svg": "media", "what": "Servidor de media",
     "purpose": "Streaming de filmes/séries.", "critical": "baixa", "impact": "Sem streaming."},
    {"match": ["uptime-kuma", "uptimekuma"], "icon": "📈", "svg": "monitor", "what": "Uptime Kuma",
     "purpose": "Vigia serviços e alerta quando caem (:3002).", "critical": "media",
     "impact": "Deixas de ser avisado quando algo cai."},
    {"match": ["dashdot"], "icon": "💤", "svg": "monitor", "what": "dashdot (dashboard de servidor)",
     "purpose": "Painel simples de métricas.", "critical": "baixa",
     "impact": "Nenhum — **parado há semanas; candidato a remover.**"},
    {"match": ["minio"], "icon": "🪣", "svg": "storage", "what": "MinIO (storage de objetos)",
     "purpose": "Storage tipo-S3 de uma app.", "critical": "media",
     "impact": "A app perde acesso aos ficheiros."},
    {"match": ["redis"], "icon": "⚡", "svg": "cache", "what": "Redis (cache/filas)",
     "purpose": "Cache em memória de uma app.", "critical": "media",
     "impact": "A app fica lenta ou perde filas/sessões."},
    {"match": ["postgres", "mariadb", "mysql", "mongo"], "icon": "🗄️", "svg": "db", "what": "Base de dados",
     "purpose": "Guarda os dados de uma app.", "critical": "alta",
     "impact": "A app que depende dela fica **sem dados / em erro**."},
]


def _extra() -> list[dict]:
    raw = os.getenv("KNOWN_CONTAINERS_JSON", "").strip()
    if raw:
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            pass
    return []


def describe(name: str, image: str, labels: dict | None = None) -> dict:
    """Metadados do container. Labels do container têm prioridade."""
    labels = labels or {}
    if labels.get("cockpit.what"):
        crit = (labels.get("cockpit.critical") or "media").lower()
        return {"what": labels["cockpit.what"], "purpose": labels.get("cockpit.purpose", ""),
                "critical": crit if crit in ("alta", "media", "baixa") else "media",
                "impact": labels.get("cockpit.impact", ""), "icon": labels.get("cockpit.icon", "📦"),
                "svg": labels.get("cockpit.svg", "generic"), "known": True, "source": "label"}
    hay = f"{name} {image}".lower()
    for entry in _extra() + _CATALOG:
        for token in entry.get("match", []):
            if token.lower() in hay:
                return {"what": entry["what"], "purpose": entry["purpose"],
                        "critical": entry["critical"], "impact": entry["impact"],
                        "icon": entry.get("icon", "📦"), "svg": entry.get("svg", "generic"),
                        "known": True, "source": "catalog"}
    return {"what": "Container não reconhecido", "purpose": "",
            "critical": "desconhecida",
            "impact": "Não sei o que é — **candidato a triagem**. Vê a imagem e a porta.",
            "icon": "❓", "svg": "generic", "known": False, "source": "none"}
