"""Trace de portas → apps acessíveis via Tailscale.

Combina:
  - portas publicadas pelos containers Docker (+ working_dir do compose = caminho),
  - portas à escuta no host (psutil),
  - um dicionário de apps conhecidas (nome/ícone) por porta.
Produz uma lista de links `https://<tailscale_host>:<porta>`.
"""
from __future__ import annotations

import psutil

from . import config, docker_api


async def discover() -> dict:
    known = config.known_apps()
    host = config.TAILSCALE_HOST
    by_port: dict[int, dict] = {}

    # 1) Containers Docker (têm caminho via working_dir do compose)
    dock = await docker_api.list_containers()
    for ct in dock.get("containers", []):
        path = ct.get("compose_workdir") or ""
        for p in ct.get("ports", []):
            port = p.get("public")
            if not port:
                continue
            by_port.setdefault(port, {
                "port": port,
                "source": "docker",
                "container": ct["name"],
                "state": ct["state"],
                "path": path,
            })

    # 2) Portas à escuta no host (apanha serviços fora do Docker)
    try:
        for conn in psutil.net_connections(kind="inet"):
            if conn.status != psutil.CONN_LISTEN or not conn.laddr:
                continue
            port = conn.laddr.port
            # ignora portas efémeras altas e loopback-only sem interesse
            if port in by_port:
                continue
            pname = "?"
            if conn.pid:
                try:
                    pname = psutil.Process(conn.pid).name()
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
            by_port.setdefault(port, {
                "port": port, "source": "host", "process": pname, "state": "listen", "path": ""
            })
    except (psutil.AccessDenied, OSError):
        pass

    # 3) Enriquecer com apps conhecidas + montar URL
    apps = []
    for port, info in sorted(by_port.items()):
        meta = known.get(str(port), {})
        name = meta.get("name") or info.get("container") or info.get("process") or f"Porta {port}"
        apps.append({
            **info,
            "name": name,
            "icon": meta.get("icon", "🔌"),
            "path": info.get("path") or meta.get("path", ""),
            "url": f"https://{host}:{port}",
            "known": bool(meta),
        })

    # apps conhecidas primeiro, depois por porta
    apps.sort(key=lambda a: (not a["known"], a["port"]))
    return {"tailscale_host": host, "count": len(apps), "apps": apps}
