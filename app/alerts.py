"""Avaliador de alertas — corre em background e empurra para o Telegram.

Regras: CPU / RAM / disco / temperatura acima do limiar durante N leituras
seguidas, e containers que caíram (running -> exited). Cooldown por chave
para não floodar.
"""
from __future__ import annotations

import asyncio
import time
from collections import deque

from . import config, docker_api, system, telegram

# histórico recente de alertas para mostrar na PWA
_history: deque = deque(maxlen=50)
_last_sent: dict[str, float] = {}
_sustain: dict[str, int] = {}
_prev_container_state: dict[str, str] = {}
_task: asyncio.Task | None = None


def history() -> list[dict]:
    return list(_history)


def _record(level: str, key: str, title: str, body: str, pushed: bool) -> dict:
    item = {"ts": time.time(), "level": level, "key": key, "title": title,
            "body": body, "pushed": pushed}
    _history.appendleft(item)
    return item


def mute(key: str, seconds: int = 3600) -> None:
    """Silencia uma chave de alerta durante N segundos (empurra o cooldown)."""
    _last_sent[key] = time.time() + seconds - config.ALERT_COOLDOWN_SECONDS


async def _maybe_push(level: str, key: str, title: str, body: str,
                      buttons: list[list[dict]] | None = None) -> None:
    now = time.time()
    # ainda em cooldown → não envia nem regista (evita inundar o histórico)
    if now - _last_sent.get(key, 0) < config.ALERT_COOLDOWN_SECONDS:
        return
    emoji = {"critical": "🔴", "warning": "🟠", "info": "🟢"}.get(level, "🔔")
    text = f"{emoji} <b>{config.SERVER_NAME} · {title}</b>\n{body}"
    res = await telegram.send(text, buttons=buttons)
    ok = res.get("ok", False)
    # sucesso → cooldown completo; falha → re-tentar em ~60s (não arma o cooldown todo)
    retry = min(60, config.ALERT_COOLDOWN_SECONDS)
    _last_sent[key] = now if ok else now - config.ALERT_COOLDOWN_SECONDS + retry
    _record(level, key, title, body, pushed=ok)


def _check_threshold(key: str, value: float, limit: float) -> bool:
    """True quando o valor esteve acima do limite durante SUSTAIN leituras."""
    if value >= limit:
        _sustain[key] = _sustain.get(key, 0) + 1
    else:
        _sustain[key] = 0
    return _sustain.get(key, 0) >= config.ALERT_SUSTAIN_SAMPLES


async def evaluate_once() -> list[dict]:
    fired = []
    snap = system.overview()
    cpu = snap["cpu"]["percent"]
    mem = snap["memory"]["percent"]
    disk = snap["disk"]["percent"]
    temp = snap["temperature"]["main_c"]

    if _check_threshold("cpu", cpu, config.ALERT_CPU_PCT):
        await _maybe_push("warning", "cpu", "CPU alta", f"CPU a {cpu}% (limiar {config.ALERT_CPU_PCT}%).")
        fired.append("cpu")
    if _check_threshold("mem", mem, config.ALERT_MEM_PCT):
        await _maybe_push("warning", "mem", "Memória alta", f"RAM a {mem}% (limiar {config.ALERT_MEM_PCT}%).")
        fired.append("mem")
    if _check_threshold("disk", disk, config.ALERT_DISK_PCT):
        await _maybe_push("critical", "disk", "Disco quase cheio", f"Disco a {disk}% (limiar {config.ALERT_DISK_PCT}%).")
        fired.append("disk")
    if temp is not None and _check_threshold("temp", temp, config.ALERT_TEMP_C):
        await _maybe_push("critical", "temp", "Temperatura alta", f"CPU a {temp}°C (limiar {config.ALERT_TEMP_C}°C).")
        fired.append("temp")

    # containers caídos — com ações inline no push (agir sem abrir a app)
    dock = await docker_api.list_containers()
    for ct in dock.get("containers", []):
        prev = _prev_container_state.get(ct["name"])
        if prev == "running" and ct["state"] in ("exited", "dead"):
            key = f"ct:{ct['name']}"
            await _maybe_push("critical", key, "Container caiu",
                              f"<code>{ct['name']}</code> está <b>{ct['state']}</b> ({ct['status']}).",
                              buttons=[[
                                  {"text": "↻ Reiniciar", "callback_data": f"ct:restart:{ct['name']}"},
                                  {"text": "🔕 Silenciar 1h", "callback_data": f"mute:{key}"},
                              ]])
            fired.append(key)
        _prev_container_state[ct["name"]] = ct["state"]

    return fired


async def _handle_callback(data: str) -> str | None:
    """Ações dos botões inline do Telegram. Devolve texto de resposta ou None."""
    if data.startswith("ct:restart:"):
        name = data.removeprefix("ct:restart:")
        # o Docker API aceita o nome como id; valida que o container existe primeiro
        listing = await docker_api.list_containers()
        known = {c["name"] for c in listing.get("containers", [])}
        if name not in known:
            return f"'{name}' não existe."
        res = await docker_api.container_action(name, "restart")
        if res.get("ok"):
            _record("info", f"ct:{name}", "Reiniciado via Telegram",
                    f"<code>{name}</code> reiniciado a partir do push.", pushed=False)
            return f"{name} reiniciado ✅"
        return f"Falhou: {res.get('error', '?')[:120]}"
    if data.startswith("mute:"):
        key = data.removeprefix("mute:")
        mute(key, 3600)
        return "Silenciado por 1h 🔕"
    return None


async def _loop() -> None:
    # baseline de container states antes de começar a alertar
    try:
        dock = await docker_api.list_containers()
        for ct in dock.get("containers", []):
            _prev_container_state[ct["name"]] = ct["state"]
    except Exception:
        pass
    while True:
        try:
            if config.ALERTS_ENABLED:
                await evaluate_once()
        except Exception:  # noqa: BLE001 — nunca matar o loop
            pass
        await asyncio.sleep(config.ALERT_EVAL_SECONDS)


def start() -> None:
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_loop())
    telegram.register_callback_handler(_handle_callback)
    telegram.start_poller()


def stop() -> None:
    global _task
    if _task and not _task.done():
        _task.cancel()
    _task = None
    telegram.stop_poller()
