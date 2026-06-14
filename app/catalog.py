"""Catálogo de apps/containers conhecidos — para o "helper" de triagem.

Dá, para cada container, um resumo humano: o que é, para que serve, quão
crítico é e o impacto de o desligar. Match por nome do container ou imagem.

Extensível de duas formas:
  - labels no próprio container (o utilizador anota): `cockpit.what`,
    `cockpit.purpose`, `cockpit.critical` (alta|media|baixa), `cockpit.impact`.
  - env `KNOWN_CONTAINERS_JSON` (lista de {match, what, purpose, critical, impact, icon}).
"""
from __future__ import annotations

import json
import os

# critical: "alta" (vermelho) | "media" (âmbar) | "baixa" (verde)
# Ordem importa: entradas específicas (por nome do TEU container) primeiro,
# genéricas (postgres/redis/...) por último como fallback.
_CATALOG: list[dict] = [
    # ── Infra crítica ────────────────────────────────────────────────────────
    {"match": ["nginx-proxy-manager"], "icon": "🌐", "what": "Nginx Proxy Manager (reverse proxy + SSL)",
     "purpose": "Encaminha domínios/portas para as apps e trata dos certificados.",
     "critical": "alta", "impact": "Derruba o acesso a **todas** as apps que passam por ele."},
    {"match": ["adguard"], "icon": "🛡️", "what": "AdGuard Home (DNS + bloqueio de ads)",
     "purpose": "Resolve o DNS da rede e bloqueia anúncios/trackers.",
     "critical": "alta", "impact": "Se for o DNS da tua rede, a navegação pode **parar em toda a casa**."},
    {"match": ["portainer"], "icon": "🐳", "what": "Portainer (gestão de Docker)",
     "purpose": "UI web para gerir containers e stacks.",
     "critical": "media", "impact": "Perdes a UI de gestão; os containers continuam a correr."},
    {"match": ["mikecockpit", "mc-stuff"], "icon": "🎛️", "what": "MikeCockpit (este painel)",
     "purpose": "Comando e telemetria do MikeServer.",
     "critical": "media", "impact": "Perdes este painel — o servidor continua a funcionar."},

    # ── As tuas apps ─────────────────────────────────────────────────────────
    {"match": ["coreroom-blueprint"], "icon": "🧩", "what": "CoreRoom Blueprint (gerador)",
     "purpose": "Serviço de geração de blueprints do CoreRoom.",
     "critical": "baixa", "impact": "Função de blueprint indisponível. **Está parado/crashou — candidato a rever.**"},
    {"match": ["azure-coreroom"], "icon": "🧪", "what": "CoreRoom Light (Azure) — experimental",
     "purpose": "Variante leve do CoreRoom (ensaio).",
     "critical": "baixa", "impact": "Nenhum — **está parado; provável candidato a remover.**"},
    {"match": ["coreroom"], "icon": "🧩", "what": "CoreRoom (motor + PWA)",
     "purpose": "Delivery intelligence de projetos BC + app mobile (:4000).",
     "critical": "media", "impact": "A app/PWA CoreRoom fica indisponível."},
    {"match": ["mikecommand"], "icon": "🕹️", "what": "MikeCommand (app — frontend/api/db/agent)",
     "purpose": "O teu projeto MikeCommand (stack próprio).",
     "critical": "media", "impact": "A app MikeCommand fica em baixo. (Distinto deste painel, o MikeCockpit.)"},
    {"match": ["vantage"], "icon": "📰", "what": "Vantage (briefing)",
     "purpose": "App de briefing/insights (:5555).",
     "critical": "media", "impact": "A app Vantage fica indisponível."},
    {"match": ["tradeagent"], "icon": "📈", "what": "TradeAgent (trading)",
     "purpose": "App de trading/rotina intraday.",
     "critical": "media", "impact": "A app TradeAgent fica indisponível."},
    {"match": ["memorix"], "icon": "🧠", "what": "Memorix (app pessoal — Caetana)",
     "purpose": "Stack Memorix (web + api + BD).",
     "critical": "media", "impact": "A app Memorix fica em baixo."},
    {"match": ["lente"], "icon": "🔎", "what": "Lente (SAF-T insights)",
     "purpose": "Análise de SAF-T (stack: postgres + redis + minio).",
     "critical": "media", "impact": "A análise SAF-T fica indisponível."},
    {"match": ["immich"], "icon": "📷", "what": "Immich (fotos) — base de dados",
     "purpose": "BD de fotos do Immich (pgvecto-rs).",
     "critical": "media", "impact": "O Immich fica sem dados (só o postgres está cá)."},
    {"match": ["activity-hub"], "icon": "📊", "what": "Activity Hub",
     "purpose": "Hub de atividade (stack app + postgres).",
     "critical": "media", "impact": "A app Activity Hub fica em baixo. _(confirma o uso — descrição estimada.)_"},
    {"match": ["openclaw"], "icon": "🦅", "what": "OpenClaw (gateway)",
     "purpose": "Gateway OpenClaw (:18789-18790).",
     "critical": "media", "impact": "O gateway OpenClaw fica indisponível. _(confirma o uso — descrição estimada.)_"},
    {"match": ["n8n"], "icon": "🔗", "what": "n8n (automações)",
     "purpose": "Motor de workflows/automação (:5678).",
     "critical": "media", "impact": "As automações n8n param de correr."},
    {"match": ["ha-dashboard"], "icon": "🏠", "what": "HA Dashboard",
     "purpose": "Dashboard de Home Assistant (:3003).",
     "critical": "baixa", "impact": "Perdes este dashboard (não afeta automações)."},
    {"match": ["homepage"], "icon": "🏁", "what": "Homepage (página de início)",
     "purpose": "Painel/portal de atalhos para as apps (:3001).",
     "critical": "baixa", "impact": "Perdes a página de início (não afeta serviços)."},
    {"match": ["jellyfin"], "icon": "🎬", "what": "Jellyfin (media)",
     "purpose": "Streaming de filmes/séries (:8096).",
     "critical": "baixa", "impact": "Sem streaming de media."},
    {"match": ["uptime-kuma"], "icon": "📈", "what": "Uptime Kuma (monitorização)",
     "purpose": "Vigia serviços e alerta quando caem (:3002).",
     "critical": "media", "impact": "Deixas de ser avisado quando algo fica em baixo."},
    {"match": ["dashdot"], "icon": "💤", "what": "dashdot (dashboard de servidor)",
     "purpose": "Painel simples de métricas do servidor.",
     "critical": "baixa", "impact": "Nenhum — **parado há semanas; substituído por este MikeCockpit. Candidato a remover.**"},

    # ── Genéricos (fallback) ─────────────────────────────────────────────────
    {"match": ["minio"], "icon": "🪣", "what": "MinIO (armazenamento de objetos)",
     "purpose": "Storage tipo-S3 para ficheiros de uma app.",
     "critical": "media", "impact": "A app que guarda ficheiros aqui perde acesso a eles."},
    {"match": ["redis"], "icon": "⚡", "what": "Redis (cache/filas)",
     "purpose": "Cache em memória de uma app.",
     "critical": "media", "impact": "A app fica mais lenta ou perde filas/sessões."},
    {"match": ["postgres", "mariadb", "mysql", "mongo"], "icon": "🗄️", "what": "Base de dados",
     "purpose": "Guarda os dados de uma app.",
     "critical": "alta", "impact": "A app que depende dela fica **sem dados / em erro**."},
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
    """Devolve metadados do container. Labels do container têm prioridade."""
    labels = labels or {}
    # 1) anotação manual via labels
    if labels.get("cockpit.what"):
        crit = (labels.get("cockpit.critical") or "media").lower()
        return {"what": labels["cockpit.what"], "purpose": labels.get("cockpit.purpose", ""),
                "critical": crit if crit in ("alta", "media", "baixa") else "media",
                "impact": labels.get("cockpit.impact", ""), "icon": labels.get("cockpit.icon", "📦"),
                "known": True, "source": "label"}
    # 2) catálogo (extra do env primeiro, depois o default)
    hay = f"{name} {image}".lower()
    for entry in _extra() + _CATALOG:
        for token in entry.get("match", []):
            if token.lower() in hay:
                return {"what": entry["what"], "purpose": entry["purpose"],
                        "critical": entry["critical"], "impact": entry["impact"],
                        "icon": entry.get("icon", "📦"), "known": True, "source": "catalog"}
    # 3) desconhecido → candidato a triagem
    return {"what": "Container não reconhecido", "purpose": "",
            "critical": "desconhecida", "impact": "Não sei o que é — **candidato a triagem**. Vê a imagem e a porta; se não o reconheces, pode ser lixo a remover.",
            "icon": "❓", "known": False, "source": "none"}
