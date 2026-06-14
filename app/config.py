"""Configuração central — tudo vem do ambiente (.env), com defaults seguros.

Desenhado para correr DENTRO de um container no MikeServer com:
  - pid: host        -> ver processos do host
  - /var/run/docker.sock montado
  - / montado em /host (ro) para ler o disco/SO do host
Mas degrada com elegância se algo não existir (ex.: neste sandbox).
"""
from __future__ import annotations

import json
import os
from pathlib import Path


def _bool(name: str, default: bool) -> bool:
    return os.getenv(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except ValueError:
        return default


# ── Identidade ───────────────────────────────────────────────────────────────
APP_NAME = os.getenv("APP_NAME", "MikeCockpit")
SERVER_NAME = os.getenv("SERVER_NAME", "MikeServer")
PORT = _int("PORT", 5599)

# ── Acesso ao host ───────────────────────────────────────────────────────────
# Se / estiver montado em /host, usamos isso para o disco e SO do host.
HOST_ROOT = os.getenv("HOST_ROOT", "/host" if Path("/host/etc/os-release").exists() else "/")
DOCKER_SOCK = os.getenv("DOCKER_SOCK", "/var/run/docker.sock")
# nsenter no PID 1 do host (precisa de privileged + pid:host). Auto-deteta.
ENABLE_HOST_CMD = _bool("ENABLE_HOST_CMD", True)

# ── Telegram (notificações push) ─────────────────────────────────────────────
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "").strip()

# ── Polling (mantém leve no N97) ─────────────────────────────────────────────
POLL_OVERVIEW_MS = _int("POLL_OVERVIEW_MS", 4000)
POLL_CONTAINERS_MS = _int("POLL_CONTAINERS_MS", 6000)

# ── Limiares de alerta ───────────────────────────────────────────────────────
ALERT_CPU_PCT = _float("ALERT_CPU_PCT", 90.0)
ALERT_MEM_PCT = _float("ALERT_MEM_PCT", 90.0)
ALERT_DISK_PCT = _float("ALERT_DISK_PCT", 88.0)
ALERT_TEMP_C = _float("ALERT_TEMP_C", 80.0)
ALERT_EVAL_SECONDS = _int("ALERT_EVAL_SECONDS", 30)
ALERT_COOLDOWN_SECONDS = _int("ALERT_COOLDOWN_SECONDS", 900)  # 15 min entre repetições
ALERT_SUSTAIN_SAMPLES = _int("ALERT_SUSTAIN_SAMPLES", 3)  # nº de leituras seguidas acima do limiar
ALERTS_ENABLED = _bool("ALERTS_ENABLED", True)

# ── Comandos custom (allowlist) ──────────────────────────────────────────────
# Lista curada e SEGURA. Cada comando corre no host via nsenter (se disponível).
# Override total via env ALLOWED_COMMANDS_JSON='[{"id":"x","label":"...","cmd":"...","danger":false}]'
_DEFAULT_COMMANDS = [
    {
        "id": "uptime",
        "label": "Uptime & quem está ligado",
        "desc": "uptime + sessões ativas",
        "cmd": "uptime && echo '---' && who",
        "danger": False,
    },
    {
        "id": "coreroom-sync",
        "label": "Sync CoreRoom (AL)",
        "desc": "Corre o source-sync do CoreRoom manualmente",
        "cmd": "/opt/projects/coreroom/scripts/source-sync-cron.sh",
        "danger": False,
    },
    {
        "id": "vault-save",
        "label": "Guardar Vault (git push)",
        "desc": "Commit + push do vault Obsidian no servidor",
        "cmd": "cd /opt/projects/obsidian && git add -A && git commit -m 'mikecommand: save from server' && git push",
        "danger": False,
    },
    {
        "id": "docker-prune",
        "label": "Limpar Docker (prune)",
        "desc": "Remove imagens/containers/redes não usadas",
        "cmd": "docker system prune -f",
        "danger": True,
    },
    {
        "id": "df",
        "label": "Espaço em disco",
        "desc": "df -h dos pontos de montagem",
        "cmd": "df -h",
        "danger": False,
    },
]


def allowed_commands() -> list[dict]:
    raw = os.getenv("ALLOWED_COMMANDS_JSON", "").strip()
    if raw:
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            pass
    return _DEFAULT_COMMANDS


# ── Apps Tailscale (port trace) ──────────────────────────────────────────────
TAILSCALE_HOST = os.getenv("TAILSCALE_HOST", "mikeserver.tail228d40.ts.net")
# Portas servidas por HTTPS (tailscale serve). Fallback caso o status não esteja
# acessível; em runtime é confirmado por `tailscale serve status`.
_DEFAULT_HTTPS_PORTS = "443,4000,5555,5556,5559,5599"


def tailscale_https_ports() -> set[int]:
    raw = os.getenv("TAILSCALE_HTTPS_PORTS", _DEFAULT_HTTPS_PORTS)
    out = set()
    for p in raw.split(","):
        p = p.strip()
        if p.isdigit():
            out.add(int(p))
    return out


# Serviços que NÃO são páginas web (não vale a pena oferecer link de "abrir").
_NON_WEB_SVG = {"db", "cache", "terminal", "lock"}
_NON_WEB_PORTS = {22, 53, 5353}


def is_web(port: int, svg: str | None) -> bool:
    return (svg not in _NON_WEB_SVG) and (port not in _NON_WEB_PORTS)
# Apps conhecidas (nome amigável + ícone) por porta — enriquece o auto-discovery.
# Override via env KNOWN_APPS_JSON.
_DEFAULT_KNOWN_APPS = {
    "5599": {"name": "MikeCockpit", "icon": "🎛️", "path": "/opt/projects/mikecockpit"},
    "4000": {"name": "CoreRoom", "icon": "🧩", "path": "/opt/projects/coreroom"},
    "9000": {"name": "Portainer", "icon": "🐳", "path": "portainer"},
    "3001": {"name": "Homepage", "icon": "🏁", "path": "homepage"},
    "3002": {"name": "Uptime Kuma", "icon": "📈", "path": "uptime-kuma"},
    "8096": {"name": "Jellyfin", "icon": "🎬", "path": "jellyfin"},
    "5678": {"name": "n8n", "icon": "🔗", "path": "n8n"},
    "5555": {"name": "Vantage", "icon": "📰", "path": "/opt/projects/vantage"},
    "3003": {"name": "HA Dashboard", "icon": "🏠", "path": "ha-dashboard"},
    "18789": {"name": "OpenClaw", "icon": "🦅", "path": "openclaw"},
}


def known_apps() -> dict:
    raw = os.getenv("KNOWN_APPS_JSON", "").strip()
    if raw:
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            pass
    return _DEFAULT_KNOWN_APPS


# ── Sessões Claude (tmux via ~/bin/mikeclaude) ───────────────────────────────
# O script corre como ESTE utilizador (não root, sem sudo).
CLAUDE_USER = os.getenv("MIKECLAUDE_USER", "migcarvalho")
MIKECLAUDE_BIN = os.getenv("MIKECLAUDE_BIN", "mikeclaude")  # resolvido via PATH de login (~/bin)
CLAUDE_PROJECTS_BASE = os.getenv("CLAUDE_PROJECTS_BASE", "/opt/projects")

# Whitelist canónica no backend — só estes projetos são aceites.
_DEFAULT_CLAUDE_PROJECTS = [
    "vantage", "coreroom", "gap-advisor", "ha-dashboard", "mc-stuff",
    "mikecockpit", "mikecommand", "memorix", "obsidian", "openclaw", "shared", "tradeagent",
]


def claude_projects() -> list[str]:
    raw = os.getenv("CLAUDE_PROJECTS", "").strip()
    if raw:
        return [p.strip() for p in raw.split(",") if p.strip()]
    return _DEFAULT_CLAUDE_PROJECTS


def claude_project_path(project: str) -> str:
    return f"{CLAUDE_PROJECTS_BASE}/{project}"
