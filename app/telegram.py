"""Envio de notificações push via Telegram Bot API + ações inline nos alertas.

O poller de callbacks (getUpdates, long-poll) só arranca se o Telegram estiver
configurado. Só aceita callbacks do TELEGRAM_CHAT_ID configurado, e só com os
padrões de ação conhecidos ("ct:restart:<nome>" / "mute:<chave>").
"""
from __future__ import annotations

import asyncio
import logging

import httpx

from . import config

log = logging.getLogger("mikecockpit.telegram")

_poll_task: asyncio.Task | None = None
_offset = 0
# handlers registados por alerts.py (evita import circular): data -> coroutine
_callback_handlers: list = []


def configured() -> bool:
    return bool(config.TELEGRAM_BOT_TOKEN and config.TELEGRAM_CHAT_ID)


def _url(method: str) -> str:
    return f"https://api.telegram.org/bot{config.TELEGRAM_BOT_TOKEN}/{method}"


async def send(text: str, silent: bool = False, buttons: list[list[dict]] | None = None) -> dict:
    """Envia mensagem HTML; buttons = [[{"text": ..., "callback_data": ...}]] inline."""
    if not configured():
        return {"ok": False, "error": "Telegram não configurado (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)."}
    payload = {
        "chat_id": config.TELEGRAM_CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
        "disable_notification": silent,
        "disable_web_page_preview": True,
    }
    if buttons:
        payload["reply_markup"] = {"inline_keyboard": buttons}
    try:
        async with httpx.AsyncClient(timeout=15.0) as c:
            r = await c.post(_url("sendMessage"), json=payload)
            ok = r.status_code == 200 and r.json().get("ok", False)
            return {"ok": ok, "status": r.status_code, "detail": r.text[:200] if not ok else "enviado"}
    except (httpx.HTTPError, ValueError) as e:
        return {"ok": False, "error": str(e)}


async def _answer_callback(callback_id: str, text: str) -> None:
    try:
        async with httpx.AsyncClient(timeout=10.0) as c:
            await c.post(_url("answerCallbackQuery"),
                         json={"callback_query_id": callback_id, "text": text[:190]})
    except httpx.HTTPError:
        pass


def register_callback_handler(handler) -> None:
    """handler: async fn(data: str) -> str | None (texto de resposta se tratou)."""
    if handler not in _callback_handlers:
        _callback_handlers.append(handler)


async def _process_update(upd: dict) -> None:
    global _offset
    _offset = max(_offset, upd.get("update_id", 0) + 1)
    cq = upd.get("callback_query")
    if not cq:
        return
    # só o chat configurado pode acionar botões
    chat_id = str(((cq.get("message") or {}).get("chat") or {}).get("id", ""))
    if chat_id != str(config.TELEGRAM_CHAT_ID):
        await _answer_callback(cq.get("id", ""), "Não autorizado.")
        return
    data = cq.get("data", "")
    reply = None
    for h in _callback_handlers:
        try:
            reply = await h(data)
        except Exception as e:  # noqa: BLE001
            log.warning("callback handler falhou: %s", e)
            reply = f"Erro: {e}"
        if reply is not None:
            break
    await _answer_callback(cq.get("id", ""), reply or "Ação desconhecida.")


async def _poll_loop() -> None:
    global _offset
    while True:
        try:
            async with httpx.AsyncClient(timeout=35.0) as c:
                r = await c.post(_url("getUpdates"),
                                 json={"timeout": 25, "offset": _offset,
                                       "allowed_updates": ["callback_query"]})
                if r.status_code == 200 and r.json().get("ok"):
                    for upd in r.json().get("result", []):
                        await _process_update(upd)
                elif r.status_code == 409:
                    # outro consumidor (webhook/poller) — recua e tenta mais tarde
                    await asyncio.sleep(60)
        except (httpx.HTTPError, ValueError):
            await asyncio.sleep(10)
        await asyncio.sleep(1)


def start_poller() -> None:
    global _poll_task
    if configured() and (_poll_task is None or _poll_task.done()):
        _poll_task = asyncio.create_task(_poll_loop())


def stop_poller() -> None:
    global _poll_task
    if _poll_task and not _poll_task.done():
        _poll_task.cancel()
    _poll_task = None
