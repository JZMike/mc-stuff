"""MikeCockpit — API + PWA para comandar o MikeServer.

Leve por design (N97): FastAPI single-process, polling do lado do cliente,
sem dependências pesadas. Serve a PWA estática em / e a API em /api.
"""
from __future__ import annotations

import contextlib
from pathlib import Path

from fastapi import Body, FastAPI, Query
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from app import (
    actions, al_projects, alerts, azdo, catalog, claude_sessions, config, docker_api, infra,
    metrics, ports, system, telegram, topology,
)

WEB_DIR = Path(__file__).parent / "web"


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    system.prime_cpu_percent()
    alerts.start()
    metrics.start()
    yield
    metrics.stop()
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
        "azdo": azdo.configured(),
    }


# ── Visão geral (read-only) ──────────────────────────────────────────────────
@app.get("/api/overview")
async def api_overview():
    return system.overview()


@app.get("/api/host")
async def api_host():
    return system.host_info()


@app.get("/api/metrics/history")
async def api_metrics_history(minutes: int = Query(60, ge=5, le=1440)):
    return metrics.history(minutes=minutes)


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


# /remove ANTES da rota genérica /{action} (senão era apanhada por ela)
@app.post("/api/containers/{cid}/remove")
async def api_container_remove(cid: str, confirm: str = Query("")):
    """Remove um container PARADO. Guardas: nome tem de bater certo + não pode estar a correr."""
    info = await docker_api.inspect(cid)
    if not info.get("ok"):
        return JSONResponse(info, status_code=400)
    if confirm != info["name"]:
        return JSONResponse(
            {"ok": False, "error": f"Confirmação inválida (escreve '{info['name']}')."}, status_code=400)
    if info.get("running"):
        return JSONResponse(
            {"ok": False, "error": "O container está a correr — pára-o primeiro."}, status_code=400)
    res = await docker_api.remove_container(cid)
    return JSONResponse(res, status_code=200 if res.get("ok") else 400)


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
    served = await infra.https_ports()
    urls = []
    for p in d["ports"]:
        port = p["public"]
        if config.is_web(port, meta.get("svg")):
            scheme = "https" if port in served else "http"
            urls.append({"port": port, "url": f"{scheme}://{host}:{port}"})
    d["urls"] = urls
    d.pop("labels", None)  # não devolver labels em cru ao cliente
    return {**d, "helper": meta}


@app.get("/api/containers/{cid}/stats")
async def api_container_stats(cid: str):
    return await docker_api.container_stats(cid)


@app.get("/api/containers/{cid}/logs")
async def api_container_logs(cid: str, tail: int = 200):
    return await docker_api.container_logs(cid, tail=min(tail, 1000))


@app.get("/api/containers/{cid}/logs/stream")
async def api_container_logs_stream(cid: str, tail: int = 100):
    """Logs ao vivo via SSE — streaming em vez de snapshot + refresh manual."""
    async def gen():
        async for text in docker_api.stream_logs(cid, tail=min(tail, 500)):
            for line in text.splitlines():
                yield f"data: {line}\n\n"
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/stacks/{project}/{action}")
async def api_stack_action(project: str, action: str):
    """Ação em lote sobre um stack compose (restart/stop/start de todos os containers)."""
    res = await docker_api.stack_action(project, action)
    return JSONResponse(res, status_code=200 if res.get("ok") else 400)


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


@app.get("/api/claude/rc/{project}")
async def api_claude_rc(project: str):
    """Deep-link Remote Control — assumir a sessão tmux na app do Claude."""
    res = await claude_sessions.remote_control(project)
    return JSONResponse(res, status_code=200 if res.get("ok") else 400)


# ── Projetos AL / Azure DevOps ───────────────────────────────────────────────
@app.get("/api/al/repos")
async def api_al_repos():
    """Repos do projeto DevOps + estado local de cada clone (al-<repo>)."""
    return await al_projects.repos()


@app.get("/api/al/workitems")
async def api_al_workitems():
    return await azdo.list_workitems()


@app.post("/api/al/sync/{repo}")
async def api_al_sync(repo: str):
    res = await al_projects.sync(repo)
    return JSONResponse(res, status_code=200 if res.get("ok") else 400)


@app.post("/api/al/session/{repo}/start")
async def api_al_session_start(repo: str, payload: dict = Body(default={})):
    wid = payload.get("workitem_id")
    wid = int(wid) if str(wid or "").isdigit() else None
    res = await al_projects.start_session(
        repo,
        briefing=str(payload.get("briefing") or ""),
        workitem_id=wid,
    )
    return JSONResponse(res, status_code=200 if res.get("ok") else 400)


@app.post("/api/al/pr/{repo}")
async def api_al_pr(repo: str, payload: dict = Body(default={})):
    res = await al_projects.create_pr(repo, title=str(payload.get("title") or ""))
    return JSONResponse(res, status_code=200 if res.get("ok") else 400)


# ── Apps / Tailscale (port trace) ────────────────────────────────────────────
@app.get("/api/apps")
async def api_apps():
    return await ports.discover()


@app.get("/api/map")
async def api_map():
    return await topology.build()


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
