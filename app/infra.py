"""Infra extra: estado do Tailscale e estado dos backups/SoT (vault + CoreRoom)."""
from __future__ import annotations

import json
import re
import time

from . import actions, config

_https_cache = {"t": 0.0, "ports": set()}


async def https_ports() -> set:
    """Portas servidas por HTTPS (via `tailscale serve status`), com cache de 120s.

    Cai para o fallback de config se o status não estiver acessível.
    """
    now = time.time()
    if now - _https_cache["t"] < 120 and _https_cache["ports"]:
        return _https_cache["ports"]
    ports = set()
    res = await actions.run_host("tailscale serve status 2>/dev/null", timeout=10)
    if res.get("ok") and res.get("stdout"):
        for m in re.finditer(r"https://[^\s:/]+(?::(\d+))?", res["stdout"]):
            ports.add(int(m.group(1)) if m.group(1) else 443)
    if not ports:
        ports = config.tailscale_https_ports()  # fallback
    elif now - _https_cache["t"] >= 120:
        _https_cache.update(t=now, ports=ports)
    return ports or config.tailscale_https_ports()


async def tailscale_status() -> dict:
    """Lê `tailscale status --json` no host. Crítico: se isto cair, perde-se o acesso."""
    res = await actions.run_host("tailscale status --json 2>/dev/null", timeout=15)
    if not res.get("ok") or not res.get("stdout"):
        return {"available": False, "error": res.get("error") or "tailscale indisponível"}
    try:
        d = json.loads(res["stdout"])
    except (json.JSONDecodeError, KeyError):
        return {"available": False, "error": "resposta inválida do tailscale"}

    self_ = d.get("Self") or {}
    peers = d.get("Peer") or d.get("Peers") or {}
    peer_list = list(peers.values()) if isinstance(peers, dict) else []
    online = sum(1 for p in peer_list if p.get("Online"))
    devices = sorted(
        [{"name": p.get("HostName", "?"), "os": p.get("OS", ""), "online": bool(p.get("Online")),
          "ip": (p.get("TailscaleIPs") or ["?"])[0]} for p in peer_list],
        key=lambda x: (not x["online"], x["name"]),
    )[:20]
    return {
        "available": True,
        "state": d.get("BackendState", "?"),          # "Running" = ok
        "hostname": self_.get("HostName", "?"),
        "ip": (self_.get("TailscaleIPs") or ["?"])[0],
        "magic_dns": d.get("MagicDNSSuffix", ""),
        "key_expiry": self_.get("KeyExpiry"),
        "peers_online": online,
        "peers_total": len(peer_list),
        "devices": devices,
    }


async def _git_repo(path: str) -> dict:
    """Estado git de um repo: último commit + ahead/behind do upstream."""
    # nsenter corre como root → evitar bloqueio "dubious ownership" em repos de outro dono
    g = f"git -c safe.directory='{path}'"
    cmd = (
        f"cd {path} 2>/dev/null && "
        f"echo \"LAST|$({g} log -1 --format='%cr|%h|%s' 2>/dev/null)\" && "
        f"echo \"AHEAD|$({g} rev-list --count @{{u}}..HEAD 2>/dev/null)\" && "
        f"echo \"BEHIND|$({g} rev-list --count HEAD..@{{u}} 2>/dev/null)\" && "
        f"echo \"DIRTY|$({g} status --porcelain 2>/dev/null | wc -l)\""
    )
    res = await actions.run_host(cmd, timeout=20)
    out = {"path": path, "ok": res.get("ok", False), "last": None, "ahead": 0, "behind": 0, "dirty": 0}
    for line in (res.get("stdout") or "").splitlines():
        if "|" not in line:
            continue
        k, _, v = line.partition("|")
        if k == "LAST" and v:
            parts = v.split("|")
            out["last"] = {"when": parts[0], "hash": parts[1] if len(parts) > 1 else "",
                           "msg": parts[2] if len(parts) > 2 else ""}
        elif k == "AHEAD":
            out["ahead"] = int(v) if v.strip().isdigit() else 0
        elif k == "BEHIND":
            out["behind"] = int(v) if v.strip().isdigit() else 0
        elif k == "DIRTY":
            out["dirty"] = int(v) if v.strip().isdigit() else 0
    return out


async def backups_status() -> dict:
    """SoT: estado do vault e do CoreRoom (último commit, por enviar, alterações locais)."""
    if not actions.host_cmd_available():
        return {"available": False, "error": "execução no host indisponível"}
    vault = await _git_repo("/opt/projects/obsidian")
    coreroom = await _git_repo("/opt/projects/coreroom")
    return {"available": True, "repos": [
        {"name": "Vault (Obsidian)", **vault},
        {"name": "CoreRoom", **coreroom},
    ]}
