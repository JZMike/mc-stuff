"""MikeCockpit — API + PWA para comandar o MikeServer.

Leve por design (N97): FastAPI single-process, polling do lado do cliente,
sem dependências pesadas. Serve a PWA estática em / e a API em /api.
"""
from __future__ import annotations

import contextlib
from pathlib import Path

from fastapi import FastAPI, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app import (
    actions, alerts, catalog, claude_sessions, config, docker_api, infra, ports, system, telegram,
)

WEB_DIR = Path(__file__).parent / "web"


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    system.prime_cpu_percent()
    alerts.start()
    yield
    alerts.stop()


app = FastAPI(title=config.APP_NAME, lifespan=lifespan)


# ── Saúde ────────────────────────────────────────────────────────────────────
@app.get("/api/v1/health")
@app.get("/health")
async def health():
    docker_ok = await docker_api.available()
    return {
        "status": "ok",
        "service": "mikecockpit",
        "server": config.SERVER_NAME,
        "docker": docker_ok,
        "docker_error": None if docker_ok else docker_api._PROBE_ERROR,
        "host_cmd": actions.host_cmd_available(),
        "telegram": telegram.configured(),
    }


# ── Visão geral (read-only) ──────────────────────────────────────────────────
@app.get("/api/overview")
async def api_overview():
    return system.overview()


@app.get("/api/host")
async def api_host():
    return system.host_info()


@app.get("/api/processes")
async def api_processes(sort: str = Query("cpu", pattern="^(cpu|mem)$"), limit: int = 25):
    return {"processes": system.processes(limit=min(limit, 100), sort_by=sort)}


@app.post("/api/processes/{pid}/kill")
async def api_kill_process(pid: int, sig: str = Query("term", pattern="^(term|kill)$")):
    res = actions.kill_process(pid, sig)
    return JSONResponse(res, status_code=200 if res.get("ok") else 400)


# ── Tailscale & backups (infra) ──────────────────────────────────────────────
@app.get("/api/tailscale")
async def api_tailscale():
    return await infra.tailscale_status()


@app.get("/api/backups")
async def api_backups():
    return await infra.backups_status()


# ── Containers ───────────────────────────────────────────────────────────────
@app.get("/api/containers")
async def api_containers():
    return await docker_api.list_containers()


@app.post("/api/containers/{cid}/{action}")
async def api_container_action(cid: str, action: str):
    res = await docker_api.container_action(cid, action)
    code = 200 if res.get("ok") else 400
    return JSONResponse(res, status_code=code)


@app.get("/api/containers/{cid}/inspect")
async def api_container_inspect(cid: str):
    """Detalhe + 'helper' de triagem (o que é, criticidade, impacto) + URLs Tailscale."""
    d = await docker_api.inspect(cid)
    if not d.get("ok"):
        return JSONResponse(d, status_code=400)
    meta = catalog.describe(d["name"], d["image"], d.get("labels"))
    host = config.TAILSCALE_HOST
    d["urls"] = [{"port": p["public"], "url": f"https://{host}:{p['public']}"} for p in d["ports"]]
    d.pop("labels", None)  # não devolver labels em cru ao cliente
    return {**d, "helper": meta}


@app.get("/api/containers/{cid}/stats")
async def api_container_stats(cid: str):
    return await docker_api.container_stats(cid)


@app.get("/api/containers/{cid}/logs")
async def api_container_logs(cid: str, tail: int = 200):
    return await docker_api.container_logs(cid, tail=min(tail, 1000))


# ── Sistema (reboot) ─────────────────────────────────────────────────────────
@app.post("/api/system/reboot")
async def api_reboot(confirm: str = Query("")):
    if confirm != config.SERVER_NAME:
        return JSONResponse(
            {"ok": False, "error": f"Confirmação inválida. Envia ?confirm={config.SERVER_NAME}"},
            status_code=400,
        )
    return await actions.reboot_vm()


# ── Comandos (allowlist) ─────────────────────────────────────────────────────
@app.get("/api/commands")
async def api_commands():
    return {"host_cmd": actions.host_cmd_available(),
            "commands": [{k: v for k, v in c.items() if k != "cmd"} for c in config.allowed_commands()]}


@app.post("/api/commands/{command_id}/run")
async def api_run_command(command_id: str):
    res = await actions.run_allowed(command_id)
    return JSONResponse(res, status_code=200 if res.get("ok") else 400)


# ── Sessões Claude (tmux via mikeclaude) ─────────────────────────────────────
@app.get("/api/claude/projects")
async def api_claude_projects():
    return await claude_sessions.projects()


@app.get("/api/claude/sessions")
async def api_claude_sessions():
    return await claude_sessions.list_sessions()


@app.get("/api/claude/status")
async def api_claude_status_all():
    return await claude_sessions.status_all()


@app.get("/api/claude/status/{project}")
async def api_claude_status(project: str):
    return await claude_sessions.status(project)


@app.post("/api/claude/start/{project}")
async def api_claude_start(project: str):
    res = await claude_sessions.start(project)
    return JSONResponse(res, status_code=200 if res.get("ok") else 400)


@app.post("/api/claude/stop/{project}")
async def api_claude_stop(project: str):
    res = await claude_sessions.stop(project)
    return JSONResponse(res, status_code=200 if res.get("ok") else 400)


@app.post("/api/claude/restart/{project}")
async def api_claude_restart(project: str):
    res = await claude_sessions.restart(project)
    return JSONResponse(res, status_code=200 if res.get("ok") else 400)


# ── Apps / Tailscale (port trace) ────────────────────────────────────────────
@app.get("/api/apps")
async def api_apps():
    return await ports.discover()


# ── Alertas ──────────────────────────────────────────────────────────────────
@app.get("/api/alerts")
async def api_alerts():
    return {
        "enabled": config.ALERTS_ENABLED,
        "telegram": telegram.configured(),
        "thresholds": {
            "cpu_pct": config.ALERT_CPU_PCT, "mem_pct": config.ALERT_MEM_PCT,
            "disk_pct": config.ALERT_DISK_PCT, "temp_c": config.ALERT_TEMP_C,
        },
        "history": alerts.history(),
    }


@app.post("/api/alerts/test")
async def api_alerts_test():
    res = await telegram.send(
        f"🎛️ <b>{config.SERVER_NAME} · {config.APP_NAME}</b>\nTeste de notificação — está tudo a funcionar. ✅"
    )
    return JSONResponse(res, status_code=200 if res.get("ok") else 400)


# ── PWA estática (montada por último para não tapar a API) ───────────────────
if WEB_DIR.exists():
    app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")
