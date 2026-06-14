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
_CATALOG: list[dict] = [
    {"match": ["nginx-proxy-manager", "nginxproxymanager", "npm_", "jc21/nginx"],
     "icon": "🌐", "what": "Reverse proxy + gestão de certificados (Nginx Proxy Manager)",
     "purpose": "Encaminha domínios/portas para as apps e trata de SSL.",
     "critical": "alta", "impact": "Derruba o acesso a TODAS as apps que passam por ele."},
    {"match": ["traefik"], "icon": "🌐", "what": "Reverse proxy (Traefik)",
     "purpose": "Router de tráfego para os containers.", "critical": "alta",
     "impact": "Apps atrás do Traefik ficam inacessíveis."},
    {"match": ["cloudflared", "cloudflare-tunnel"], "icon": "☁️", "what": "Cloudflare Tunnel",
     "purpose": "Expõe apps à internet sem abrir portas.", "critical": "alta",
     "impact": "Apps públicas via tunnel deixam de responder (acesso interno mantém-se)."},
    {"match": ["tailscale"], "icon": "🔒", "what": "Tailscale (VPN da tailnet)",
     "purpose": "Rede privada por onde acedes a tudo.", "critical": "alta",
     "impact": "PERDES o acesso remoto ao servidor. Cuidado."},
    {"match": ["pihole", "adguard"], "icon": "🛡️", "what": "DNS + bloqueio de anúncios",
     "purpose": "Resolve DNS da rede e bloqueia ads/trackers.", "critical": "alta",
     "impact": "Se for o DNS da tua rede, a navegação pode parar."},
    {"match": ["postgres", "mariadb", "mysql", "mongo", "redis", "influxdb"],
     "icon": "🗄️", "what": "Base de dados",
     "purpose": "Guarda os dados de uma ou mais apps.", "critical": "alta",
     "impact": "A app que depende dela fica sem dados / em erro."},
    {"match": ["vaultwarden", "bitwarden"], "icon": "🔑", "what": "Gestor de passwords (Vaultwarden)",
     "purpose": "Cofre de credenciais.", "critical": "alta",
     "impact": "Ficas sem acesso às tuas passwords guardadas."},
    {"match": ["homeassistant", "home-assistant", "hass"], "icon": "🏠",
     "what": "Home Assistant (domótica)", "purpose": "Automações e controlo da casa.",
     "critical": "media", "impact": "As automações e dispositivos de casa param."},
    {"match": ["portainer"], "icon": "🐳", "what": "Portainer (gestão de Docker)",
     "purpose": "UI para gerir containers/stacks.", "critical": "media",
     "impact": "Perdes a UI de gestão; os containers continuam a correr."},
    {"match": ["uptime-kuma", "uptimekuma"], "icon": "📈", "what": "Uptime Kuma (monitorização)",
     "purpose": "Vigia serviços e envia alertas quando caem.", "critical": "media",
     "impact": "Deixas de ser avisado quando algo fica em baixo."},
    {"match": ["coreroom"], "icon": "🧩", "what": "CoreRoom (motor + PWA)",
     "purpose": "Delivery intelligence de projetos BC + app mobile.", "critical": "media",
     "impact": "A app/PWA CoreRoom fica indisponível."},
    {"match": ["mikecockpit", "mc-stuff"], "icon": "🎛️", "what": "MikeCockpit (este painel)",
     "purpose": "Comando e telemetria do MikeServer.", "critical": "media",
     "impact": "Perdes este painel — o servidor continua a funcionar."},
    {"match": ["grafana", "prometheus"], "icon": "📊", "what": "Observabilidade (métricas)",
     "purpose": "Recolha e visualização de métricas.", "critical": "baixa",
     "impact": "Perdes dashboards/histórico de métricas."},
    {"match": ["watchtower"], "icon": "🔄", "what": "Watchtower (auto-update)",
     "purpose": "Atualiza imagens de containers automaticamente.", "critical": "baixa",
     "impact": "Os containers deixam de atualizar sozinhos (sem risco imediato)."},
    {"match": ["dozzle"], "icon": "📜", "what": "Dozzle (visor de logs)",
     "purpose": "Ver logs dos containers no browser.", "critical": "baixa",
     "impact": "Perdes este visor de logs (não afeta serviços)."},
    {"match": ["jellyfin", "plex", "emby"], "icon": "🎬", "what": "Servidor de media",
     "purpose": "Streaming de filmes/séries.", "critical": "baixa",
     "impact": "Sem streaming de media."},
    {"match": ["nextcloud"], "icon": "📁", "what": "Nextcloud (cloud pessoal)",
     "purpose": "Ficheiros/calendário/contactos.", "critical": "media",
     "impact": "Sem acesso aos ficheiros sincronizados."},
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
