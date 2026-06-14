"""Topologia do MikeServer para o mapa orbital (núcleo + serviços à volta).

Núcleo = MikeServer (com saúde global). Nós = serviços com porta publicada,
verde (a correr) ou vermelho (em baixo). Reaproveita o discover de portas e
o catálogo para nome/ícone.
"""
from __future__ import annotations

from . import catalog, config, docker_api, ports, system


def _overall(cpu: float, mem: float, disk: float) -> str:
    if cpu >= config.ALERT_CPU_PCT or mem >= config.ALERT_MEM_PCT or disk >= config.ALERT_DISK_PCT:
        return "crit"
    if cpu >= 75 or mem >= 80 or disk >= 75:
        return "warn"
    return "ok"


async def build() -> dict:
    apps = (await ports.discover()).get("apps", [])
    seen = {a["port"] for a in apps}
    nodes = [{
        "name": a["name"], "port": a["port"], "url": a["url"], "status": "up",
        "icon": a.get("icon", "🔌"), "svg": a.get("svg", "generic"), "critical": a.get("critical"),
        "kind": a.get("source", "host"),
    } for a in apps]

    # serviços PARADOS (containers com porta mas exited/dead) → nós vermelhos
    dock = await docker_api.list_containers()
    for ct in dock.get("containers", []):
        if ct["state"] == "running":
            continue
        pubs = [p.get("public") for p in ct.get("ports", []) if p.get("public")]
        if not pubs:
            continue
        port = pubs[0]
        if port in seen:
            continue
        seen.add(port)
        meta = catalog.describe(ct["name"], ct["image"])
        nodes.append({
            "name": ct["name"], "port": port,
            "url": f"https://{config.TAILSCALE_HOST}:{port}", "status": "down",
            "icon": meta["icon"], "svg": meta.get("svg", "generic"),
            "critical": meta["critical"], "kind": "docker",
        })

    snap = system.overview()
    cpu = snap["cpu"]["percent"]
    mem = snap["memory"]["percent"]
    disk = snap["disk"]["percent"]
    center = {
        "name": config.SERVER_NAME,
        "cpu": cpu, "mem": mem, "disk": disk,
        "uptime_seconds": snap["uptime_seconds"],
        "health": _overall(cpu, mem, disk),
    }
    up = sum(1 for n in nodes if n["status"] == "up")
    nodes.sort(key=lambda n: (n["status"] != "up", n["port"]))
    return {"center": center, "nodes": nodes, "up": up, "total": len(nodes)}
