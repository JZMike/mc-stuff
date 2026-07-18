"""Projetos AL (Azure DevOps) — clones locais, sync, sessões com briefing, PRs.

Fluxo: alguém reporta um erro → sync do repo → sessão Claude (tmux, via
mikeclaude) com o briefing em TASK.md → a sessão trabalha numa branch fix/…
e faz push → o PR é criado daqui para o DevOps.

Segurança (mesmo padrão do claude_sessions):
  - Nomes de repo validados contra a LISTA REAL da API + regex — nunca input
    livre em paths ou argv.
  - Auth git via GIT_CONFIG_* no ambiente — o PAT não aparece em argv nem
    fica gravado no .git/config do clone.
  - Tudo corre como o utilizador (run_as_user), sem sudo.
"""
from __future__ import annotations

import logging
import re
import time
from pathlib import Path

from . import actions, azdo, claude_sessions, config

log = logging.getLogger("mikecockpit.al")

_BRANCH_RE = re.compile(r"^## (\S+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$")


def _git_env() -> dict:
    """Auth para git clone/pull/push via env (git ≥ 2.31)."""
    return {
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "http.extraheader",
        "GIT_CONFIG_VALUE_0": f"Authorization: {azdo.auth_header()}",
    }


def _host_path(path: str) -> Path:
    """Path do host visto através do mount read-only (para leituras baratas)."""
    return Path(config.HOST_ROOT) / path.lstrip("/")


def _cloned(repo: str) -> bool:
    return (_host_path(config.al_project_dir(repo)) / ".git").exists()


async def _find_repo(repo: str) -> tuple[dict | None, str | None]:
    """Valida o nome contra a lista real do DevOps. Devolve (entry, erro)."""
    if not config.AL_REPO_RE.match(repo or ""):
        return None, "nome de repo inválido"
    rd = await azdo.list_repos()
    if not rd.get("available"):
        return None, rd.get("error", "DevOps indisponível")
    for r in rd["repos"]:
        if r["name"] == repo:
            return r, None
    return None, f"repo '{repo}' não existe no projeto DevOps"


async def _local_state(repo: str) -> dict | None:
    """Estado git do clone (branch/ahead/dirty) — None se não clonado."""
    if not _cloned(repo):
        return None
    state: dict = {"cloned": True, "branch": None, "ahead": None, "dirty": None}
    res = await actions.run_as_user(
        ["git", "-C", config.al_project_dir(repo), "status", "--porcelain=v1", "-b"], timeout=20)
    if not res.get("ok"):
        # sem execução no host (ex.: sandbox) — pelo menos a branch, via /host
        head = _host_path(config.al_project_dir(repo)) / ".git/HEAD"
        try:
            ref = head.read_text().strip()
            if ref.startswith("ref: refs/heads/"):
                state["branch"] = ref.removeprefix("ref: refs/heads/")
        except OSError:
            pass
        return state
    lines = (res.get("stdout") or "").splitlines()
    if lines:
        m = _BRANCH_RE.match(lines[0])
        if m:
            state["branch"] = m.group(1)
            extras = m.group(3) or ""
            am = re.search(r"ahead (\d+)", extras)
            state["ahead"] = int(am.group(1)) if am else 0
    state["dirty"] = max(0, len(lines) - 1)
    return state


async def repos() -> dict:
    rd = await azdo.list_repos()
    if not rd.get("available"):
        return rd
    out = []
    for r in rd["repos"]:
        local = await _local_state(r["name"])
        out.append({**r, "remote_url": None, "local": local,
                    "project": config.al_project_name(r["name"])})
    return {"available": True, "repos": out}


_CLAUDE_MD = """# {project} — projeto AL sincronizado do Azure DevOps

Gerido a partir do MikeCockpit. O clone canónico é o DevOps — isto é uma
área de trabalho para sessões Claude.

## Se existir TASK.md na raiz
É o briefing atual (erro reportado / work item). Lê-o PRIMEIRO e trata-o
como o pedido de trabalho desta sessão.

## Regras
- Trabalha SEMPRE numa branch `fix/...` ou `feature/...` — NUNCA em `{default}`.
- NUNCA faças push direto a `{default}` — o merge acontece por Pull Request
  no Azure DevOps (criado a partir do cockpit).
- É código de cliente: alterações mínimas e cirúrgicas; segue o estilo AL
  existente no projeto.
- Se o compilador `alc` estiver disponível, compila antes de dar por terminado.
- Termina com commit + push da branch (`git push -u origin <branch>`).
"""


async def _write_file(repo: str, filename: str, content: str) -> dict:
    """Escreve um ficheiro no clone, como o utilizador, com conteúdo por argv."""
    path = f"{config.al_project_dir(repo)}/{filename}"
    return await actions.run_as_user(
        ["python3", "-c",
         "import sys, pathlib; pathlib.Path(sys.argv[1]).write_text(sys.argv[2], encoding='utf-8')",
         path, content],
        timeout=20)


async def sync(repo: str) -> dict:
    entry, err = await _find_repo(repo)
    if err:
        return {"ok": False, "error": err}
    target = config.al_project_dir(repo)
    if _cloned(repo):
        res = await actions.run_as_user(["git", "-C", target, "pull", "--ff-only"],
                                        timeout=120, env=_git_env())
        action = "pull"
    else:
        res = await actions.run_as_user(["git", "clone", entry["remote_url"], target],
                                        timeout=300, env=_git_env())
        action = "clone"
    if not res.get("ok"):
        detail = (res.get("stderr") or res.get("error") or "").strip()[-400:]
        return {"ok": False, "error": f"{action} falhou: {detail or 'erro desconhecido'}"}
    # CLAUDE.md só se o projeto ainda não tiver um (nunca esmagar o do repo)
    if not (_host_path(target) / "CLAUDE.md").exists():
        await _write_file(repo, "CLAUDE.md", _CLAUDE_MD.format(
            project=config.al_project_name(repo), default=entry["default_branch"]))
    # ficheiros do cockpit fora do estado git e de commits (ignore LOCAL, nunca versionado)
    await actions.run_as_user(
        ["python3", "-c",
         "import sys, pathlib\n"
         "p = pathlib.Path(sys.argv[1]) / '.git/info/exclude'\n"
         "cur = p.read_text() if p.exists() else ''\n"
         "add = [l for l in ('CLAUDE.md', 'TASK.md') if l not in cur.split()]\n"
         "p.write_text(cur + ('\\n' if cur and not cur.endswith('\\n') else '') + '\\n'.join(add) + ('\\n' if add else ''))",
         target],
        timeout=15)
    out = ((res.get("stdout") or "") + (res.get("stderr") or "")).strip()[-300:]
    log.info("al sync %s -> %s", repo, action)
    return {"ok": True, "action": action, "project": config.al_project_name(repo),
            "message": f"{repo}: {action} concluído.", "detail": out}


async def start_session(repo: str, briefing: str, workitem_id: int | None = None) -> dict:
    entry, err = await _find_repo(repo)
    if err:
        return {"ok": False, "error": err}
    if not _cloned(repo):
        return {"ok": False, "error": "O repo ainda não foi sincronizado — faz Sync primeiro."}
    briefing = (briefing or "").strip()
    if not briefing:
        return {"ok": False, "error": "Briefing vazio — descreve o erro/tarefa."}

    parts = [f"# Briefing — {time.strftime('%Y-%m-%d %H:%M')}", ""]
    if workitem_id:
        wi = await azdo.get_workitem(workitem_id)
        if wi:
            desc = re.sub(r"<[^>]+>", " ", wi.get("description") or "").strip()
            parts += [f"## Work item #{wi['id']} — {wi['title']}",
                      f"Estado: {wi['state']} · Tipo: {wi['type']}",
                      f"Link: {wi['url']}", ""]
            if desc:
                parts += ["### Descrição (do DevOps)", desc[:3000], ""]
    parts += ["## Pedido", briefing, "",
              "(Regras de trabalho: ver CLAUDE.md — branch fix/…, sem push direto a "
              f"{entry['default_branch']}, terminar com push da branch.)"]
    res = await _write_file(repo, "TASK.md", "\n".join(parts) + "\n")
    if not res.get("ok"):
        detail = (res.get("stderr") or res.get("error") or "").strip()[-200:]
        return {"ok": False, "error": f"não consegui escrever o TASK.md: {detail}"}

    project = config.al_project_name(repo)
    started = await claude_sessions.start(project)
    if not started.get("ok"):
        return {"ok": False, "error": started.get("message", "falha a iniciar a sessão")}
    return {"ok": True, "project": project,
            "message": f"Sessão claude-{project} iniciada com o briefing no TASK.md."}


async def create_pr(repo: str, title: str = "") -> dict:
    entry, err = await _find_repo(repo)
    if err:
        return {"ok": False, "error": err}
    state = await _local_state(repo)
    if not state:
        return {"ok": False, "error": "O repo ainda não foi sincronizado."}
    branch = state.get("branch")
    if not branch or branch == "?":
        return {"ok": False, "error": "Não consegui determinar a branch atual do clone."}
    if branch == entry["default_branch"]:
        return {"ok": False,
                "error": f"O clone está em '{branch}' — a sessão devia trabalhar numa branch fix/…."}
    target = config.al_project_dir(repo)
    # push idempotente antes do PR (garante que a branch está no DevOps)
    push = await actions.run_as_user(["git", "-C", target, "push", "-u", "origin", branch],
                                     timeout=120, env=_git_env())
    if not push.get("ok"):
        detail = (push.get("stderr") or push.get("error") or "").strip()[-300:]
        return {"ok": False, "error": f"push falhou: {detail}"}
    if not title:
        last = await actions.run_as_user(["git", "-C", target, "log", "-1", "--pretty=%s"], timeout=15)
        title = (last.get("stdout") or "").strip() or f"Fix via MikeCockpit ({branch})"
    res = await azdo.create_pr(repo, branch, entry["default_branch"], title,
                               description=f"PR criado a partir do MikeCockpit (branch `{branch}`).")
    if res.get("ok"):
        log.info("al pr %s %s -> #%s", repo, branch, res.get("id"))
    return res
