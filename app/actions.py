"""Ações no HOST (reboot, comandos da allowlist) via nsenter no PID 1.

Requer o container com `pid: host` + `privileged: true`. Se não estiver
disponível (ex.: sandbox), devolve um erro claro em vez de rebentar.
"""
from __future__ import annotations

import asyncio
import shutil
from pathlib import Path

from . import config


def host_cmd_available() -> bool:
    """nsenter existe e conseguimos ver o PID 1 do host (pid:host + privileged)."""
    if not config.ENABLE_HOST_CMD:
        return False
    if shutil.which("nsenter") is None:
        return False
    # /proc/1/root acessível indica que partilhamos o PID namespace do host.
    return Path("/proc/1/cmdline").exists()


def _wrap(cmd: str) -> list[str]:
    """Corre `cmd` no host via nsenter, num shell."""
    return ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--",
            "bash", "-lc", cmd]


async def run_host(cmd: str, timeout: int = 120) -> dict:
    if not host_cmd_available():
        return {"ok": False, "rc": -1, "stdout": "", "stderr": "",
                "error": "Execução no host indisponível (precisa de pid:host + privileged + nsenter)."}
    try:
        proc = await asyncio.create_subprocess_exec(
            *_wrap(cmd),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return {
            "ok": proc.returncode == 0,
            "rc": proc.returncode,
            "stdout": out.decode("utf-8", "replace")[-8000:],
            "stderr": err.decode("utf-8", "replace")[-4000:],
        }
    except asyncio.TimeoutError:
        return {"ok": False, "rc": -1, "stdout": "", "stderr": "", "error": f"timeout ({timeout}s)"}
    except (OSError, ValueError) as e:
        return {"ok": False, "rc": -1, "stdout": "", "stderr": "", "error": str(e)}


async def run_allowed(command_id: str) -> dict:
    for c in config.allowed_commands():
        if c["id"] == command_id:
            res = await run_host(c["cmd"], timeout=180)
            res["label"] = c["label"]
            return res
    return {"ok": False, "error": "comando não está na allowlist"}


async def reboot_vm() -> dict:
    """Reinicia a VM Debian (systemctl reboot no host)."""
    if not host_cmd_available():
        return {"ok": False, "error": "Reboot indisponível (precisa de pid:host + privileged)."}
    # systemctl reboot corta a ligação; disparamos e não esperamos pelo retorno.
    res = await run_host("systemctl reboot || reboot", timeout=10)
    # Em reboot, o processo é cortado — tratamos timeout/erro de pipe como sucesso.
    if res.get("error", "").startswith("timeout") or res.get("ok"):
        return {"ok": True, "message": "Reboot disparado. A VM vai reiniciar."}
    return {"ok": True, "message": "Reboot disparado (ligação cortada, esperado).", "detail": res}
