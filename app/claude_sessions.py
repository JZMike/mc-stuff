"""Gestão de sessões Claude em tmux via ~/bin/mikeclaude (como utilizador, sem sudo).

Regras de segurança:
  - O nome do projeto é SEMPRE validado contra a whitelist do backend.
  - Nunca se concatena input livre em shell — args passam por argv (run_as_user).
  - Nunca usa sudo nem expõe .env.
  - Logs só com: comando lógico, projeto, estado, timestamp.
"""
from __future__ import annotations

import asyncio
import logging

from . import actions, config

log = logging.getLogger("mikecockpit.claude")

_VERBS = {"projects", "list", "status", "start", "stop", "restart"}
_ONLINE_HINTS = ("online", "running", "active", "attached", "up", "alive", "✓", "●")
_OFFLINE_HINTS = ("offline", "stopped", "not running", "no session", "inactive",
                  "down", "dead", "missing", "nenhuma", "sem sessão", "não")


def _valid_project(project: str) -> bool:
    return project in config.claude_projects()


def _clean(res: dict) -> str:
    return ((res.get("stdout") or "") + "\n" + (res.get("stderr") or "")).strip()


async def _run(verb: str, project: str | None = None, timeout: int = 60) -> dict:
    if verb not in _VERBS:
        return {"ok": False, "error": "comando não permitido"}
    if project is not None and not _valid_project(project):
        return {"ok": False, "error": f"projeto '{project}' não está na whitelist"}
    args = [config.MIKECLAUDE_BIN, verb] + ([project] if project else [])
    res = await actions.run_as_user(args, timeout=timeout)
    # Falha de infra (não do mikeclaude) → tratar como erro, não como sucesso
    stderr = (res.get("stderr") or "")
    if res.get("rc") not in (0, None):
        low = stderr.lower()
        if "runuser:" in low or "nsenter:" in low or "command not found" in low or "no such file" in low:
            res["error"] = stderr.strip().splitlines()[-1] if stderr.strip() else "falha de execução no host"
    log.info("claude %s %s -> rc=%s", verb, project or "-", res.get("rc"))
    return res


def _interpret_status(res: dict, project: str) -> str:
    """Devolve 'online' / 'offline' / 'unknown' de forma tolerante."""
    if res.get("error"):
        return "unknown"
    text = _clean(res).lower()
    # pista forte: a sessão claude-<project> aparece à escuta
    if f"claude-{project}" in text and any(h in text for h in _ONLINE_HINTS):
        return "online"
    if any(h in text for h in _OFFLINE_HINTS):
        return "offline"
    if any(h in text for h in _ONLINE_HINTS):
        return "online"
    return "online" if res.get("rc") == 0 else "offline"


# ── API pública ──────────────────────────────────────────────────────────────
async def projects() -> dict:
    names = config.claude_projects()
    return {
        "available": actions.host_cmd_available(),
        "user": config.CLAUDE_USER,
        "projects": [{"name": n, "path": config.claude_project_path(n), "status": "unknown"} for n in names],
    }


async def list_sessions() -> dict:
    res = await _run("list", timeout=20)
    return {"ok": res.get("ok", False), "output": _clean(res) or "(sem sessões ativas)",
            "error": res.get("error")}


async def status(project: str) -> dict:
    res = await _run("status", project, timeout=20)
    if res.get("error") and "whitelist" in res["error"]:
        return {"ok": False, "project": project, "status": "unknown", "error": res["error"]}
    return {"ok": True, "project": project, "status": _interpret_status(res, project),
            "detail": _clean(res)}


async def status_all() -> dict:
    names = config.claude_projects()
    results = await asyncio.gather(*(status(n) for n in names))
    return {"statuses": {r["project"]: r["status"] for r in results}}


async def start(project: str) -> dict:
    res = await _run("start", project, timeout=90)
    if res.get("error"):
        return {"ok": False, "project": project, "message": res["error"]}
    text = _clean(res).lower()
    # #9 — já existe: mensagem amigável, não erro
    if any(k in text for k in ("already", "exists", "já", "a correr", "running")):
        return {"ok": True, "project": project, "message": "Sessão já estava ativa.", "noop": True}
    if res.get("rc") == 0:
        return {"ok": True, "project": project, "message": f"Sessão claude-{project} iniciada."}
    return {"ok": True, "project": project, "message": _clean(res) or "Iniciado.", "warn": True}


async def stop(project: str) -> dict:
    res = await _run("stop", project, timeout=30)
    if res.get("error"):
        return {"ok": False, "project": project, "message": res["error"]}
    text = _clean(res).lower()
    # #10 — não existe: mensagem amigável, não erro
    if any(k in text for k in ("no session", "not running", "doesn't", "does not",
                               "não existe", "nenhuma", "já parada", "not found")):
        return {"ok": True, "project": project, "message": "Não havia sessão ativa.", "noop": True}
    if res.get("rc") == 0:
        return {"ok": True, "project": project, "message": f"Sessão claude-{project} terminada."}
    return {"ok": True, "project": project, "message": _clean(res) or "Parado.", "warn": True}


async def restart(project: str) -> dict:
    res = await _run("restart", project, timeout=90)
    if res.get("error"):
        return {"ok": False, "project": project, "message": res["error"]}
    msg = f"Sessão claude-{project} reiniciada." if res.get("rc") == 0 else (_clean(res) or "Reiniciado.")
    return {"ok": True, "project": project, "message": msg}
