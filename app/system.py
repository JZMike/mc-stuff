"""Métricas de sistema do HOST via psutil, com fallbacks robustos.

Notas sobre o container:
  - /proc/stat e /proc/meminfo já refletem o HOST (não são namespaced por PID).
  - `pid: host` faz com que a lista de processos seja a do host.
  - O disco do host lê-se via HOST_ROOT (/ montado em /host).
  - Temperatura lê-se de /sys (psutil) ou /sys/class/thermal como fallback.
"""
from __future__ import annotations

import time
from pathlib import Path

import psutil

from . import config

_BOOT = psutil.boot_time()


def _read_thermal_fallback() -> float | None:
    """Lê a maior temperatura de /sys/class/thermal/*/temp (em millong°C)."""
    candidates = [Path("/sys/class/thermal"), Path(config.HOST_ROOT) / "sys/class/thermal"]
    best: float | None = None
    for base in candidates:
        if not base.exists():
            continue
        for zone in base.glob("thermal_zone*/temp"):
            try:
                val = int(zone.read_text().strip()) / 1000.0
                if 0 < val < 200 and (best is None or val > best):
                    best = val
            except (ValueError, OSError):
                continue
        if best is not None:
            break
    return round(best, 1) if best is not None else None


def temperature() -> dict:
    """Temperatura principal (CPU) + sensores detalhados."""
    sensors: list[dict] = []
    main: float | None = None
    try:
        temps = psutil.sensors_temperatures()
        for chip, entries in (temps or {}).items():
            for e in entries:
                if e.current is None:
                    continue
                sensors.append({"chip": chip, "label": e.label or chip, "current": round(e.current, 1),
                                 "high": e.high, "critical": e.critical})
                # preferência por sensores de CPU
                if main is None or (e.label or "").lower().startswith(("package", "core", "tctl", "cpu")):
                    if main is None or (e.label or "").lower().startswith(("package", "tctl")):
                        main = round(e.current, 1)
    except (AttributeError, OSError):
        pass
    if main is None:
        main = _read_thermal_fallback()
        if main is not None and not sensors:
            sensors.append({"chip": "thermal_zone", "label": "CPU", "current": main, "high": None, "critical": None})
    return {"main_c": main, "sensors": sensors}


def _disk() -> dict:
    root = config.HOST_ROOT
    try:
        u = psutil.disk_usage(root)
    except OSError:
        u = psutil.disk_usage("/")
    return {"total": u.total, "used": u.used, "free": u.free, "percent": u.percent}


def overview() -> dict:
    """Snapshot leve para o ecrã principal."""
    vm = psutil.virtual_memory()
    sw = psutil.swap_memory()
    try:
        load1, load5, load15 = psutil.getloadavg()
    except (OSError, AttributeError):
        load1 = load5 = load15 = 0.0
    net = psutil.net_io_counters()
    cpu_pct = psutil.cpu_percent(interval=None)
    per_cpu = psutil.cpu_percent(interval=None, percpu=True)
    freq = None
    try:
        f = psutil.cpu_freq()
        freq = round(f.current) if f else None
    except (OSError, AttributeError):
        freq = None

    return {
        "ts": time.time(),
        "uptime_seconds": int(time.time() - _BOOT),
        "cpu": {
            "percent": round(cpu_pct, 1),
            "cores": psutil.cpu_count(logical=True),
            "physical": psutil.cpu_count(logical=False),
            "per_cpu": [round(x, 1) for x in per_cpu],
            "freq_mhz": freq,
            "load": [round(load1, 2), round(load5, 2), round(load15, 2)],
        },
        "memory": {
            "total": vm.total, "used": vm.used, "available": vm.available,
            "percent": vm.percent,
            "swap_total": sw.total, "swap_used": sw.used, "swap_percent": sw.percent,
        },
        "disk": _disk(),
        "temperature": temperature(),
        "network": {"bytes_sent": net.bytes_sent, "bytes_recv": net.bytes_recv,
                    "packets_sent": net.packets_sent, "packets_recv": net.packets_recv},
    }


def host_info() -> dict:
    """Informação estática/semi-estática do host."""
    os_release = {}
    rel = Path(config.HOST_ROOT) / "etc/os-release"
    if not rel.exists():
        rel = Path("/etc/os-release")
    try:
        for line in rel.read_text().splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                os_release[k] = v.strip().strip('"')
    except OSError:
        pass
    uname = psutil.os.uname() if hasattr(psutil.os, "uname") else None
    return {
        "server_name": config.SERVER_NAME,
        "os": os_release.get("PRETTY_NAME", "desconhecido"),
        "kernel": getattr(uname, "release", "?") if uname else "?",
        "arch": getattr(uname, "machine", "?") if uname else "?",
        "hostname": getattr(uname, "nodename", "?") if uname else "?",
        "cpu_model": _cpu_model(),
        "cores": psutil.cpu_count(logical=True),
        "ram_total": psutil.virtual_memory().total,
        "boot_time": _BOOT,
        "tailscale_host": config.TAILSCALE_HOST,
    }


def _cpu_model() -> str:
    cpuinfo = Path(config.HOST_ROOT) / "proc/cpuinfo"
    if not cpuinfo.exists():
        cpuinfo = Path("/proc/cpuinfo")
    try:
        for line in cpuinfo.read_text().splitlines():
            if line.lower().startswith("model name"):
                return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return "?"


def processes(limit: int = 25, sort_by: str = "cpu") -> list[dict]:
    """Top processos por CPU ou memória."""
    procs = []
    for p in psutil.process_iter(["pid", "name", "username", "cpu_percent", "memory_percent", "cmdline"]):
        try:
            info = p.info
            cmd = " ".join(info.get("cmdline") or []) or info.get("name") or "?"
            procs.append({
                "pid": info["pid"],
                "name": info.get("name") or "?",
                "user": info.get("username") or "?",
                "cpu": round(info.get("cpu_percent") or 0.0, 1),
                "mem": round(info.get("memory_percent") or 0.0, 1),
                "cmd": cmd[:120],
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    key = "mem" if sort_by == "mem" else "cpu"
    procs.sort(key=lambda x: x[key], reverse=True)
    return procs[:limit]


def prime_cpu_percent() -> None:
    """psutil.cpu_percent precisa de uma 1ª chamada para iniciar o baseline."""
    psutil.cpu_percent(interval=None)
    psutil.cpu_percent(interval=None, percpu=True)
    for p in psutil.process_iter():
        try:
            p.cpu_percent(interval=None)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
