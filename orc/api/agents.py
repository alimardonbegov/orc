"""The /agents* endpoints: pre-configured executors (orc/agents.py). The logic lives there; here is
input validation and what the UI needs next to the agent itself."""
from __future__ import annotations

import re
import sqlite3
from dataclasses import asdict

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from orc import agent_work, agents
from orc.api.common import _check_mode, _dispatcher, _repo
from orc.models import Agent, TaskStatus

router = APIRouter()

EFFORTS = {"low", "medium", "high", "xhigh", "max"}
NAME_MAX = 60
DESCRIPTION_MAX = 500
# The prompt travels as a single command-line argument of `claude --bg`.
PROMPT_MAX = 20_000
# A resized picture from the browser: small enough to come along with the agent list on every poll.
AVATAR_IMAGE_MAX = 200_000
AVATAR_GLYPH_MAX = 16
# No SVG: a data:image/svg+xml is a document with scripts, and the browser is what renders it.
AVATAR_IMAGE_RE = re.compile(r"^data:image/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$")
ACTIVE_STATUSES = (TaskStatus.IN_PROGRESS, TaskStatus.VERIFYING, TaskStatus.MERGING)


class AgentIn(BaseModel):
    name: str = Field(min_length=1)
    description: str = ""
    avatar: str | None = None
    model: str | None = None
    effort: str | None = None
    permission_mode: str | None = None
    prompt: str = ""
    project_id: int | None = None
    memory_enabled: bool = False
    # The projects this agent leads. The same appointment can be made from the project's settings.
    lead_project_ids: list[int] = Field(default_factory=list)


class AgentPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    description: str | None = None
    avatar: str | None = None
    model: str | None = None
    effort: str | None = None
    permission_mode: str | None = None
    prompt: str | None = None
    project_id: int | None = None
    memory_enabled: bool | None = None
    # The complete list: projects left out lose this agent as their lead. Absent means no change.
    lead_project_ids: list[int] | None = None


def _check_avatar(avatar: str | None) -> None:
    if avatar is None:
        return
    if avatar.startswith("data:"):
        if len(avatar) > AVATAR_IMAGE_MAX or not AVATAR_IMAGE_RE.match(avatar):
            raise HTTPException(400, f"avatar: expected a PNG, JPEG, WebP or GIF data URL under {AVATAR_IMAGE_MAX} characters")
    elif len(avatar) > AVATAR_GLYPH_MAX or "<" in avatar or ">" in avatar:
        raise HTTPException(400, f"avatar: a glyph must be at most {AVATAR_GLYPH_MAX} characters")


def _check_fields(fields: dict, request: Request) -> None:
    """Shared by create and edit: fields a PATCH left out are simply absent."""
    for key, limit in (("name", NAME_MAX), ("description", DESCRIPTION_MAX), ("prompt", PROMPT_MAX)):
        if fields.get(key) is not None and len(fields[key]) > limit:
            raise HTTPException(400, f"{key}: at most {limit} characters")
    if "name" in fields and fields["name"] is not None and not fields["name"].strip():
        raise HTTPException(400, "name: must not be blank")
    for key in ("name", "description", "prompt", "memory_enabled", "lead_project_ids"):
        if key in fields and fields[key] is None:
            raise HTTPException(400, f"{key}: null is not allowed")
    _check_avatar(fields.get("avatar"))
    _check_mode(fields.get("permission_mode"))
    if fields.get("effort") is not None and fields["effort"] not in EFFORTS:
        raise HTTPException(400, f"effort: expected one of {sorted(EFFORTS)}")
    if fields.get("project_id") is not None and _repo(request).get_project(fields["project_id"]) is None:
        raise HTTPException(400, "project not found")


def _check_leads(repo, agent: Agent | None, project_ids: list[int], scope: int | None) -> None:
    """Whether the agent (None while it is being created) may lead these projects, given the scope it
    will have after this save. An archived project takes no new lead, but one it already has may stay."""
    for project_id in project_ids:
        project = repo.get_project(project_id)
        if project is None:
            raise HTTPException(400, f"project {project_id} not found")
        if project.archived_at and (agent is None or project.lead_agent_id != agent.id):
            raise HTTPException(400, f"project '{project.name}' is archived")
        if scope is not None and project_id != scope:
            raise HTTPException(400, f"an agent internal to one project cannot lead '{project.name}'")


def _apply_leads(repo, agent: Agent, project_ids: list[int]) -> None:
    """Save the appointments. An event records each one, because taking a project over from another
    agent happens here on a screen that is not about that project."""
    appointed, released = repo.set_agent_leads(agent.id, project_ids)
    for project_id, previous_id in appointed.items():
        previous = repo.get_agent(previous_id) if previous_id is not None else None
        replacing = f", replacing '{previous.name}'" if previous else ""
        repo.add_event(f"agent '{agent.name}' appointed lead of project '{repo.get_project(project_id).name}'{replacing}",
                       project_id=project_id)
    for project_id in released:
        repo.add_event(f"agent '{agent.name}' is no longer the lead of project '{repo.get_project(project_id).name}'",
                       project_id=project_id)


def _normalize(fields: dict) -> dict:
    out = dict(fields)
    if out.get("name") is not None:
        out["name"] = out["name"].strip()
    # An empty string from a form means "not set", which for run parameters is inheritance
    for key in ("model", "effort", "permission_mode", "avatar"):
        if key in out and not out[key]:
            out[key] = None
    if "memory_enabled" in out:
        out["memory_enabled"] = int(out["memory_enabled"])
    return out


def _agent_or_404(request: Request, agent_id: int) -> Agent:
    agent = _repo(request).get_agent(agent_id)
    if agent is None:
        raise HTTPException(404, "agent not found")
    return agent


def _agent_out(agent: Agent, counts: dict[int, dict[str, int]], leads: dict[int, list[int]]) -> dict:
    stats = counts.get(agent.id, {})
    return {**asdict(agent), "memory_enabled": bool(agent.memory_enabled),
            "lead_project_ids": leads.get(agent.id, []),
            "tasks": {"active": sum(stats.get(s, 0) for s in ACTIVE_STATUSES),
                      "total": sum(stats.values())}}


@router.get("/agents")
def list_agents(request: Request, project_id: int | None = None):
    repo = _repo(request)
    counts, leads = repo.agent_task_counts(), repo.lead_projects()
    return [_agent_out(a, counts, leads) for a in repo.list_agents(project_id)]


@router.post("/agents", status_code=201)
def add_agent(body: AgentIn, request: Request):
    fields = body.model_dump()
    _check_fields(fields, request)
    fields = _normalize(fields)
    repo = _repo(request)
    leads = fields.pop("lead_project_ids")
    _check_leads(repo, None, leads, fields["project_id"])
    try:
        agent = repo.add_agent(fields.pop("name"), **fields)
    except sqlite3.IntegrityError:
        raise HTTPException(409, f"an agent named {body.name.strip()!r} already exists")
    repo.add_event(f"agent '{agent.name}' created", project_id=agent.project_id)
    _apply_leads(repo, agent, leads)
    return _agent_out(agent, {}, repo.lead_projects())


@router.get("/agents/{agent_id}")
def get_agent(agent_id: int, request: Request):
    repo = _repo(request)
    return _agent_out(_agent_or_404(request, agent_id), repo.agent_task_counts(), repo.lead_projects())


@router.get("/agents/{agent_id}/work")
def agent_work_history(agent_id: int, request: Request, limit: int = agent_work.DEFAULT_LIMIT, offset: int = 0):
    """Totals, spending and the history of the agent's runs: tasks and chats in every project."""
    _agent_or_404(request, agent_id)
    return agent_work.build(_repo(request), agent_id, limit, offset)


@router.patch("/agents/{agent_id}")
def patch_agent(agent_id: int, body: AgentPatch, request: Request):
    repo = _repo(request)
    current = _agent_or_404(request, agent_id)
    fields = body.model_dump(exclude_unset=True)
    _check_fields(fields, request)
    fields = _normalize(fields)
    leads = fields.pop("lead_project_ids", None)
    if leads is not None:
        _check_leads(repo, current, leads, fields.get("project_id", current.project_id))
    if fields.get("project_id") is not None:
        # Narrowing the scope must not leave a task of another project with an agent it may not use
        free = repo.agent_free_routines(agent_id)
        if free:
            raise HTTPException(409, f"the agent runs routines outside any project ({free}): "
                                     f"it cannot be limited to one project until they are reassigned")
        # The leadership this very save releases does not hold the agent back
        kept_leads = set(repo.lead_projects().get(agent_id, []) if leads is None else leads)
        foreign = (repo.agent_project_uses(agent_id) | kept_leads) - {fields["project_id"]}
        if foreign:
            raise HTTPException(409, f"the agent is still used in other projects ({sorted(foreign)}): "
                                     f"reassign their tasks, routines, chats and lead first")
    try:
        agent = repo.update_agent(agent_id, **fields)
    except sqlite3.IntegrityError:
        raise HTTPException(409, f"an agent named {fields.get('name')!r} already exists")
    if leads is not None:
        _apply_leads(repo, agent, leads)
    return _agent_out(agent, repo.agent_task_counts(), repo.lead_projects())


@router.delete("/agents/{agent_id}")
def delete_agent(agent_id: int, request: Request):
    repo, dispatcher = _repo(request), _dispatcher(request)
    agent = _agent_or_404(request, agent_id)
    # A queued task must not quietly fall back to the project's model and lose the prompt
    blockers = repo.agent_blockers(agent_id)
    if blockers["tasks"] or blockers["routines"]:
        raise HTTPException(409, f"the agent is in use: tasks {blockers['tasks']}, routines {blockers['routines']}. "
                                 f"Reassign or finish them first")
    for chat in repo.list_chats(agent_id=agent_id):
        dispatcher.chats.delete(chat.id)
    repo.delete_agent(agent_id)
    agents.clear_memory(dispatcher.settings.data_dir, agent_id)
    repo.add_event(f"agent '{agent.name}' deleted", level="warn", project_id=agent.project_id)
    return {"deleted": agent_id}


@router.get("/agents/{agent_id}/memory")
def get_memory(agent_id: int, request: Request):
    agent = _agent_or_404(request, agent_id)
    data_dir = _dispatcher(request).settings.data_dir
    return {"enabled": bool(agent.memory_enabled), "path": str(agents.memory_dir(data_dir, agent_id)),
            "files": agents.read_memory(data_dir, agent_id)}


@router.delete("/agents/{agent_id}/memory")
def delete_memory(agent_id: int, request: Request):
    _agent_or_404(request, agent_id)
    agents.clear_memory(_dispatcher(request).settings.data_dir, agent_id)
    return {"files": []}
