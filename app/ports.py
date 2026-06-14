"""Trace de portas → apps acessíveis via Tailscale.

Prioriza os containers Docker (nomeados, com caminho). Só acrescenta serviços
do host que sejam REALMENTE acessíveis: ignora loopback, docker-proxy e ruído.
"""
from __future__ import annotations

import psutil

from . import catalog, config, docker_api

# processos que são ruído (não são "apps" do utilizador)
_NOISE_PROC = {"docker-proxy", "systemd-resolve", "systemd-resolved"}
# portas de infra que não interessam como "app"
_NOISE_PORTS = {53, 5353, 5355}


def _is_loopback(ip: str | None) -> bool:
    if not ip:
        return False
    return ip in ("127.0.0.1", "::1") or ip.startswith("127.")


async def discover() -> dict:
    known = config.known_apps()
    host = config.TAILSCALE_HOST
    by_port: dict[int, dict] = {}

    # 1) Containers Docker — a fonte limpa e nomeada (com caminho via compose)
    dock = await docker_api.list_containers()
    for ct in dock.get("containers", []):
        if ct["state"] != "running":
            continue
        path = ct.get("compose_workdir") or ""
        for p in ct.get("ports", []):
            port = p.get("public")
            if not port:
                continue
            by_port.setdefault(port, {
                "port": port, "source": "docker", "container": ct["name"],
                "state": "running", "path": path,
            })

    # 2) Serviços do host — só os acessíveis (não-loopback, não-ruído)
    try:
        for conn in psutil.net_connections(kind="inet"):
            if conn.status != psutil.CONN_LISTEN or not conn.laddr:
                continue
            port = conn.laddr.port
            if port in by_port or port in _NOISE_PORTS:
                continue
            if _is_loopback(conn.laddr.ip):
                continue
            pname = "?"
            if conn.pid:
                try:
                    pname = psutil.Process(conn.pid).name()
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
            if pname in _NOISE_PROC:
                continue
            by_port.setdefault(port, {
                "port": port, "source": "host", "process": pname, "state": "listen", "path": "",
            })
    except (psutil.AccessDenied, OSError):
        pass

    # 3) Enriquecer com apps conhecidas + montar URL
    apps = []
    for port, info in sorted(by_port.items()):
        meta = known.get(str(port), {})
        ref = info.get("container") or info.get("process") or ""
        name = meta.get("name") or ref or f"Porta {port}"
        cat = catalog.describe(ref or name, ref)
        apps.append({
            **info,
            "name": name,
            "icon": meta.get("icon") or (cat["icon"] if cat["known"] else "🔌"),
            "path": info.get("path") or meta.get("path", ""),
            "url": f"https://{host}:{port}",
            "known": bool(meta),
            "desc": cat["what"] if cat["known"] else "",
            "critical": cat["critical"] if cat["known"] else None,
        })

    apps.sort(key=lambda a: (not a["known"], a["source"] != "docker", a["port"]))
    return {"tailscale_host": host, "count": len(apps), "apps": apps}
