"""Cliente mínimo para o Docker Engine API via /var/run/docker.sock (sem o SDK pesado).

Usa endpoints SEM versão (o daemon serve na versão máxima que suporta) para
máxima compatibilidade entre versões do Docker.
"""
from __future__ import annotations

from pathlib import Path

import httpx

from . import config

_PROBE_ERROR: str | None = None


def _socket_exists() -> bool:
    p = Path(config.DOCKER_SOCK)
    return p.exists() or p.is_socket()


def _client() -> httpx.AsyncClient:
    transport = httpx.AsyncHTTPTransport(uds=config.DOCKER_SOCK)
    return httpx.AsyncClient(transport=transport, base_url="http://docker", timeout=15.0)


async def available() -> bool:
    global _PROBE_ERROR
    if not _socket_exists():
        _PROBE_ERROR = f"{config.DOCKER_SOCK} não existe (montar no compose)."
        return False
    try:
        async with _client() as c:
            r = await c.get("/_ping")
            if r.status_code == 200:
                _PROBE_ERROR = None
                return True
            _PROBE_ERROR = f"_ping HTTP {r.status_code}"
            return False
    except (httpx.HTTPError, OSError) as e:
        _PROBE_ERROR = str(e)
        return False


def _ports(container: dict) -> list[dict]:
    out = []
    seen = set()
    for p in container.get("Ports", []) or []:
        pub = p.get("PublicPort")
        if pub and pub not in seen:
            seen.add(pub)
            out.append({"private": p.get("PrivatePort"), "public": pub,
                        "ip": p.get("IP"), "type": p.get("Type")})
    return out


async def list_containers() -> dict:
    if not _socket_exists():
        return {"available": False, "error": f"{config.DOCKER_SOCK} não montado.", "containers": []}
    try:
        async with _client() as c:
            r = await c.get("/containers/json", params={"all": "true"})
            r.raise_for_status()
            raw = r.json()
    except (httpx.HTTPError, OSError) as e:
        return {"available": False, "error": str(e), "containers": []}

    containers = []
    for ct in raw:
        name = (ct.get("Names") or ["/?"])[0].lstrip("/")
        labels = ct.get("Labels") or {}
        containers.append({
            "id": ct.get("Id", "")[:12],
            "name": name,
            "image": ct.get("Image", ""),
            "state": ct.get("State", "unknown"),
            "status": ct.get("Status", ""),
            "ports": _ports(ct),
            "compose_project": labels.get("com.docker.compose.project"),
            "compose_workdir": labels.get("com.docker.compose.project.working_dir"),
        })
    containers.sort(key=lambda x: (x["state"] != "running", x["name"]))
    return {"available": True, "containers": containers}


async def container_action(cid: str, action: str) -> dict:
    if action not in ("restart", "stop", "start", "pause", "unpause"):
        return {"ok": False, "error": "ação inválida"}
    if not _socket_exists():
        return {"ok": False, "error": "docker.sock indisponível"}
    try:
        async with _client() as c:
            r = await c.post(f"/containers/{cid}/{action}", timeout=60.0)
            if r.status_code in (204, 304):
                return {"ok": True, "action": action, "id": cid}
            return {"ok": False, "error": f"HTTP {r.status_code}: {r.text[:200]}"}
    except (httpx.HTTPError, OSError) as e:
        return {"ok": False, "error": str(e)}


async def inspect(cid: str) -> dict:
    """Detalhe de um container — APENAS campos seguros (nunca Config.Env/segredos)."""
    if not _socket_exists():
        return {"ok": False, "error": "docker.sock indisponível"}
    try:
        async with _client() as c:
            r = await c.get(f"/containers/{cid}/json")
            r.raise_for_status()
            d = r.json()
    except (httpx.HTTPError, OSError) as e:
        return {"ok": False, "error": str(e)}
    state = d.get("State") or {}
    cfg = d.get("Config") or {}
    labels = cfg.get("Labels") or {}
    # portas publicadas
    ports = []
    for priv, binds in ((d.get("NetworkSettings") or {}).get("Ports") or {}).items():
        for b in (binds or []):
            if b.get("HostPort"):
                ports.append({"private": priv, "public": int(b["HostPort"])})
    seen = set()
    ports = [p for p in ports if not (p["public"] in seen or seen.add(p["public"]))]
    return {
        "ok": True,
        "name": (d.get("Name") or "").lstrip("/"),
        "image": cfg.get("Image", ""),
        "state": state.get("Status", "?"),
        "running": state.get("Running", False),
        "health": ((state.get("Health") or {}).get("Status")),
        "restart_count": d.get("RestartCount", 0),
        "created": d.get("Created"),
        "started_at": state.get("StartedAt"),
        "ports": sorted(ports, key=lambda x: x["public"]),
        "mounts": len(d.get("Mounts") or []),
        "compose_project": labels.get("com.docker.compose.project"),
        "compose_workdir": labels.get("com.docker.compose.project.working_dir"),
        "labels": labels,  # usado pelo catálogo (cockpit.*); NUNCA Env
    }


async def container_stats(cid: str) -> dict:
    """Snapshot único de CPU%/RAM de um container (stream=false → já traz precpu)."""
    if not _socket_exists():
        return {"ok": False}
    try:
        async with _client() as c:
            r = await c.get(f"/containers/{cid}/stats", params={"stream": "false"}, timeout=20.0)
            r.raise_for_status()
            s = r.json()
    except (httpx.HTTPError, OSError, ValueError):
        return {"ok": False}
    try:
        cpu = s["cpu_stats"]; pre = s["precpu_stats"]
        cd = cpu["cpu_usage"]["total_usage"] - pre["cpu_usage"]["total_usage"]
        sd = cpu.get("system_cpu_usage", 0) - pre.get("system_cpu_usage", 0)
        ncpu = cpu.get("online_cpus") or len(cpu["cpu_usage"].get("percpu_usage") or []) or 1
        cpu_pct = round((cd / sd) * ncpu * 100, 1) if sd > 0 and cd > 0 else 0.0
        mem = s["memory_stats"]
        used = mem.get("usage", 0) - (mem.get("stats", {}).get("inactive_file", 0) or 0)
        limit = mem.get("limit", 0)
        mem_pct = round(used / limit * 100, 1) if limit else 0.0
        return {"ok": True, "cpu": cpu_pct, "mem_pct": mem_pct, "mem_used": used, "mem_limit": limit}
    except (KeyError, TypeError, ZeroDivisionError):
        return {"ok": False}


async def container_logs(cid: str, tail: int = 200) -> dict:
    if not _socket_exists():
        return {"ok": False, "error": "docker.sock indisponível", "logs": ""}
    try:
        async with _client() as c:
            r = await c.get(f"/containers/{cid}/logs",
                            params={"stdout": "true", "stderr": "true", "tail": str(tail), "timestamps": "false"})
            r.raise_for_status()
            return {"ok": True, "logs": _demux(r.content)}
    except (httpx.HTTPError, OSError) as e:
        return {"ok": False, "error": str(e), "logs": ""}


def _demux(data: bytes) -> str:
    out = bytearray()
    i = 0
    n = len(data)
    looks_multiplexed = n >= 8 and data[0] in (0, 1, 2) and data[1] == 0 and data[2] == 0 and data[3] == 0
    if not looks_multiplexed:
        return data.decode("utf-8", "replace")
    while i + 8 <= n:
        size = int.from_bytes(data[i + 4:i + 8], "big")
        i += 8
        out += data[i:i + size]
        i += size
    return out.decode("utf-8", "replace")
