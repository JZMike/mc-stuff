"""Cliente mínimo para o Docker Engine API via /var/run/docker.sock (sem o SDK pesado)."""
from __future__ import annotations

import json
from pathlib import Path

import httpx

from . import config


def _available() -> bool:
    return Path(config.DOCKER_SOCK).exists()


def _client() -> httpx.AsyncClient:
    transport = httpx.AsyncHTTPTransport(uds=config.DOCKER_SOCK)
    # base_url é ignorado para UDS mas o httpx exige host; usamos um placeholder.
    return httpx.AsyncClient(transport=transport, base_url="http://docker", timeout=15.0)


async def available() -> bool:
    if not _available():
        return False
    try:
        async with _client() as c:
            r = await c.get("/v1.43/_ping")
            return r.status_code == 200
    except (httpx.HTTPError, OSError):
        return False


def _ports(container: dict) -> list[dict]:
    out = []
    for p in container.get("Ports", []) or []:
        if p.get("PublicPort"):
            out.append({"private": p.get("PrivatePort"), "public": p.get("PublicPort"),
                        "ip": p.get("IP"), "type": p.get("Type")})
    return out


async def list_containers() -> dict:
    """Lista containers + estatísticas leves (sem stats stream — caro no N97)."""
    if not _available():
        return {"available": False, "containers": []}
    try:
        async with _client() as c:
            r = await c.get("/v1.43/containers/json", params={"all": "true"})
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
            "state": ct.get("State", "unknown"),       # running / exited / paused ...
            "status": ct.get("Status", ""),            # "Up 3 hours" / "Exited (0) ..."
            "ports": _ports(ct),
            "compose_project": labels.get("com.docker.compose.project"),
            "compose_workdir": labels.get("com.docker.compose.project.working_dir"),
            "restart_count": None,
        })
    containers.sort(key=lambda x: (x["state"] != "running", x["name"]))
    return {"available": True, "containers": containers}


async def container_action(cid: str, action: str) -> dict:
    """restart | stop | start | pause | unpause."""
    if action not in ("restart", "stop", "start", "pause", "unpause"):
        return {"ok": False, "error": "ação inválida"}
    if not _available():
        return {"ok": False, "error": "docker.sock indisponível"}
    try:
        async with _client() as c:
            r = await c.post(f"/v1.43/containers/{cid}/{action}", timeout=60.0)
            if r.status_code in (204, 304):
                return {"ok": True, "action": action, "id": cid}
            return {"ok": False, "error": f"HTTP {r.status_code}: {r.text[:200]}"}
    except (httpx.HTTPError, OSError) as e:
        return {"ok": False, "error": str(e)}


async def container_logs(cid: str, tail: int = 200) -> dict:
    if not _available():
        return {"ok": False, "error": "docker.sock indisponível", "logs": ""}
    try:
        async with _client() as c:
            r = await c.get(f"/v1.43/containers/{cid}/logs",
                            params={"stdout": "true", "stderr": "true", "tail": str(tail), "timestamps": "false"})
            r.raise_for_status()
            # logs vêm com um header de 8 bytes por frame quando não há TTY; limpamos.
            return {"ok": True, "logs": _demux(r.content)}
    except (httpx.HTTPError, OSError) as e:
        return {"ok": False, "error": str(e), "logs": ""}


def _demux(data: bytes) -> str:
    """Remove os headers de stream do Docker (8 bytes) se presentes."""
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
