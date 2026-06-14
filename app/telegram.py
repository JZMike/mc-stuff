"""Envio de notificações push via Telegram Bot API."""
from __future__ import annotations

import httpx

from . import config


def configured() -> bool:
    return bool(config.TELEGRAM_BOT_TOKEN and config.TELEGRAM_CHAT_ID)


async def send(text: str, silent: bool = False) -> dict:
    if not configured():
        return {"ok": False, "error": "Telegram não configurado (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)."}
    url = f"https://api.telegram.org/bot{config.TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": config.TELEGRAM_CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
        "disable_notification": silent,
        "disable_web_page_preview": True,
    }
    try:
        async with httpx.AsyncClient(timeout=15.0) as c:
            r = await c.post(url, json=payload)
            ok = r.status_code == 200 and r.json().get("ok", False)
            return {"ok": ok, "status": r.status_code, "detail": r.text[:200] if not ok else "enviado"}
    except (httpx.HTTPError, ValueError) as e:
        return {"ok": False, "error": str(e)}
