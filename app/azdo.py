"""Cliente Azure DevOps REST — repos, work items e pull requests.

Só REST puro (httpx); a orquestração local (clones, sessões) vive em
al_projects.py. O PAT nunca sai do servidor: não aparece em respostas,
logs nem URLs devolvidas ao cliente.
"""
from __future__ import annotations

import base64
from urllib.parse import quote

import httpx

from . import config

_API = {"api-version": "7.1"}


def configured() -> bool:
    return bool(config.azdo_org_url() and config.azdo_project() and config.azdo_pat())


def auth_header() -> str:
    return "Basic " + base64.b64encode(f":{config.azdo_pat()}".encode()).decode()


def _base() -> str:
    return f"{config.azdo_org_url()}/{quote(config.azdo_project(), safe='')}"


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=_base(),
        headers={"Authorization": auth_header(), "Accept": "application/json"},
        timeout=20.0,
    )


def _err(e: Exception) -> str:
    if isinstance(e, httpx.HTTPStatusError):
        code = e.response.status_code
        if code in (401, 403):
            return f"HTTP {code} — PAT inválido/expirado ou sem scopes (Code R/W + Work Items Read)."
        if code == 404:
            return "HTTP 404 — organização/projeto não encontrado (verifica AZDO_ORG_URL / AZDO_PROJECT)."
        return f"HTTP {code}: {e.response.text[:180]}"
    return str(e)


def _not_configured() -> dict:
    hint = f" nem em {config.AZDO_ENV_FALLBACK}" if config.AZDO_ENV_FALLBACK else ""
    return {"available": False,
            "error": f"Azure DevOps não configurado — sem AZDO_ORG_URL/AZDO_PROJECT/AZDO_PAT no .env{hint}."}


async def list_repos() -> dict:
    if not configured():
        return _not_configured()
    try:
        async with _client() as c:
            r = await c.get("/_apis/git/repositories", params=_API)
            r.raise_for_status()
            raw = r.json().get("value", [])
    except (httpx.HTTPError, ValueError) as e:
        return {"available": False, "error": _err(e)}
    repos = []
    for x in raw:
        if x.get("isDisabled"):
            continue
        repos.append({
            "name": x.get("name", ""),
            "id": x.get("id", ""),
            "default_branch": (x.get("defaultBranch") or "refs/heads/main").removeprefix("refs/heads/"),
            "web_url": x.get("webUrl"),
            "remote_url": x.get("remoteUrl"),
        })
    repos.sort(key=lambda x: x["name"].lower())
    return {"available": True, "repos": repos}


def _wiql() -> str:
    types = ", ".join("'" + t.replace("'", "") + "'" for t in config.AZDO_WI_TYPES)
    return (
        "SELECT [System.Id] FROM WorkItems "
        "WHERE [System.TeamProject] = @project "
        f"AND [System.WorkItemType] IN ({types}) "
        "AND [System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved') "
        "ORDER BY [System.ChangedDate] DESC"
    )


_WI_FIELDS = ("System.Title,System.State,System.WorkItemType,System.AssignedTo,"
              "System.ChangedDate,System.Description")


def _wi_url(wid: int) -> str:
    return f"{_base()}/_workitems/edit/{wid}"


def _wi_item(w: dict) -> dict:
    f = w.get("fields", {})
    return {
        "id": w.get("id"),
        "title": f.get("System.Title", ""),
        "state": f.get("System.State", "?"),
        "type": f.get("System.WorkItemType", "?"),
        "assigned": (f.get("System.AssignedTo") or {}).get("displayName"),
        "changed": f.get("System.ChangedDate"),
        "description": (f.get("System.Description") or "")[:4000],
        "url": _wi_url(w.get("id", 0)),
    }


async def list_workitems(limit: int = 25) -> dict:
    if not configured():
        return _not_configured()
    try:
        async with _client() as c:
            r = await c.post("/_apis/wit/wiql", params=_API, json={"query": _wiql()})
            r.raise_for_status()
            ids = [w["id"] for w in r.json().get("workItems", [])][:limit]
            if not ids:
                return {"available": True, "items": []}
            r2 = await c.get("/_apis/wit/workitems",
                             params={**_API, "ids": ",".join(map(str, ids)), "fields": _WI_FIELDS})
            r2.raise_for_status()
            items = [_wi_item(w) for w in r2.json().get("value", [])]
    except (httpx.HTTPError, ValueError, KeyError) as e:
        return {"available": False, "error": _err(e)}
    return {"available": True, "items": items}


async def get_workitem(wid: int) -> dict | None:
    if not configured():
        return None
    try:
        async with _client() as c:
            r = await c.get(f"/_apis/wit/workitems/{wid}", params=_API)
            r.raise_for_status()
            return _wi_item(r.json())
    except (httpx.HTTPError, ValueError) as e:  # noqa: F841
        return None


async def create_pr(repo: str, source_branch: str, target_branch: str,
                    title: str, description: str = "") -> dict:
    if not configured():
        return {"ok": False, "error": _not_configured()["error"]}
    payload = {
        "sourceRefName": f"refs/heads/{source_branch}",
        "targetRefName": f"refs/heads/{target_branch}",
        "title": title[:250],
        "description": description[:4000],
    }
    try:
        async with _client() as c:
            r = await c.post(f"/_apis/git/repositories/{repo}/pullrequests", params=_API, json=payload)
            if r.status_code == 409:
                return {"ok": False, "error": "Já existe um PR ativo para esta branch."}
            r.raise_for_status()
            pr = r.json()
    except (httpx.HTTPError, ValueError) as e:
        return {"ok": False, "error": _err(e)}
    pr_id = pr.get("pullRequestId")
    return {"ok": True, "id": pr_id,
            "url": f"{_base()}/_git/{quote(repo, safe='')}/pullrequest/{pr_id}"}
