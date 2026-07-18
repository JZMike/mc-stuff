"""Histórico de métricas — ring buffer em memória, amostrado em background.

Leve por design (N97): uma amostra a cada METRICS_SAMPLE_SECONDS (30s),
maxlen 2880 → 24h de história, ~200KB de RAM. Sem base de dados.
O /overview já expõe o instante; isto guarda a série para sparklines e gráficos.
"""
from __future__ import annotations

import asyncio
import time
from collections import deque

from . import config, system

_SAMPLES: deque = deque(maxlen=2880)  # 24h @ 30s
_task: asyncio.Task | None = None


def sample_once() -> None:
    snap = system.overview()
    _SAMPLES.append({
        "ts": round(snap["ts"]),
        "cpu": snap["cpu"]["percent"],
        "mem": snap["memory"]["percent"],
        "disk": snap["disk"]["percent"],
        "temp": snap["temperature"]["main_c"],
        "load1": snap["cpu"]["load"][0],
    })


def history(minutes: int = 60, max_points: int = 240) -> dict:
    """Série dos últimos N minutos, decimada para max_points (leve no cliente)."""
    cutoff = time.time() - minutes * 60
    pts = [s for s in _SAMPLES if s["ts"] >= cutoff]
    if len(pts) > max_points:
        step = len(pts) / max_points
        pts = [pts[int(i * step)] for i in range(max_points)]
    return {"minutes": minutes, "interval_s": config.METRICS_SAMPLE_SECONDS, "points": pts}


async def _loop() -> None:
    while True:
        try:
            sample_once()
        except Exception:  # noqa: BLE001 — nunca matar o sampler
            pass
        await asyncio.sleep(config.METRICS_SAMPLE_SECONDS)


def start() -> None:
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_loop())


def stop() -> None:
    global _task
    if _task and not _task.done():
        _task.cancel()
    _task = None
