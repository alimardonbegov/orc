"""What agents are doing: the live feed of a task or a chat, its processes, and who is working now.

Reads only: control goes through the existing commands (POST /tasks/{id}/stop, comments, resume,
POST /chats/{id}/stop, chat messages). The UI polls these while a panel is open, so they must stay
cheap: a feed read costs only what was appended since the cursor. See docs/internals/activity.md.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from orc import activity, processes
from orc.activity import Source
from orc.api.common import _dispatcher, _input_request_view, _repo
from orc.models import Chat, Task, TaskStatus

router = APIRouter()

ACTIVE_STATUSES = (TaskStatus.IN_PROGRESS, TaskStatus.VERIFYING, TaskStatus.MERGING)
RECENT_STATUSES = (TaskStatus.DONE, TaskStatus.FAILED)
RECENT_PER_AGENT = 5


def _task_or_404(request: Request, task_id: int) -> Task:
    task = _repo(request).get_task(task_id)
    if task is None:
        raise HTTPException(404, "task not found")
    return task


def _chat_or_404(request: Request, chat_id: int) -> Chat:
    chat = _repo(request).get_chat(chat_id)
    if chat is None:
        raise HTTPException(404, "chat not found")
    return chat


def _feed(sources: list[Source], cursor: str | None, before: str | None, limit: int, agent: str | None) -> dict:
    """A feed of the session or, with `agent`, of one of its subagents, with who was delegated what."""
    read_from = activity.subagent_sources(sources, agent) if agent else sources
    return {**activity.read_feed(read_from, activity.parse_cursor(cursor), activity.parse_cursor(before), limit),
            "delegations": activity.delegations(sources)}


def _full_result(sources: list[Source], session: int, offset: int, tool_use_id: str, agent: str | None) -> dict:
    # The file is found by the session key on our side: a path never comes from the client.
    if agent:
        sources = activity.subagent_sources(sources, agent)
    source = next((s for s in sources if s.key == session), None)
    text = activity.read_full_result(source, offset, tool_use_id) if source and offset >= 0 else None
    if text is None:
        raise HTTPException(404, "result not found")
    return {"text": text}


def _process_view(request: Request, session_id: str | None) -> dict:
    claude_dir = activity.claude_dir(_dispatcher(request).settings)
    pid = processes.session_pid(claude_dir, session_id)
    rows = processes.process_tree(pid) if pid else []
    return {"pid": pid if rows else None, "processes": rows}


@router.get("/tasks/{task_id}/activity")
def task_activity(task_id: int, request: Request, cursor: str | None = None, before: str | None = None,
                  limit: int = activity.DEFAULT_LIMIT, agent: str | None = None):
    repo, dispatcher = _repo(request), _dispatcher(request)
    cli = dispatcher.cli
    task = _task_or_404(request, task_id)
    return {**_feed(activity.task_sources(repo, cli, task), cursor, before, limit, agent),
            **activity.task_conversation(repo, dispatcher, task),
            "now": {**activity.task_now(repo, cli, task),
                    "input_request": _input_request_view(repo.open_input_request(task.id))}}


@router.get("/tasks/{task_id}/activity/result")
def task_activity_result(task_id: int, session: int, offset: int, tool_use_id: str, request: Request,
                         agent: str | None = None):
    task = _task_or_404(request, task_id)
    return _full_result(activity.task_sources(_repo(request), _dispatcher(request).cli, task), session, offset, tool_use_id, agent)


@router.get("/tasks/{task_id}/processes")
def task_processes(task_id: int, request: Request):
    task = _task_or_404(request, task_id)
    if task.status != TaskStatus.IN_PROGRESS:
        return {"pid": None, "processes": []}
    return _process_view(request, task.session_id)


@router.get("/chats/{chat_id}/activity")
def chat_activity(chat_id: int, request: Request, cursor: str | None = None, before: str | None = None,
                  limit: int = activity.DEFAULT_LIMIT, agent: str | None = None):
    chat = _chat_or_404(request, chat_id)
    return {**_feed(activity.chat_sources(chat), cursor, before, limit, agent),
            "comments": None, "stages": [],
            "now": {**activity.chat_now(_dispatcher(request).cli, chat), "input_request": None}}


@router.get("/chats/{chat_id}/activity/result")
def chat_activity_result(chat_id: int, session: int, offset: int, tool_use_id: str, request: Request,
                         agent: str | None = None):
    return _full_result(activity.chat_sources(_chat_or_404(request, chat_id)), session, offset, tool_use_id, agent)


@router.get("/chats/{chat_id}/processes")
def chat_processes(chat_id: int, request: Request):
    chat = _chat_or_404(request, chat_id)
    return _process_view(request, chat.session_id) if chat.status in ("running", "waiting") else {"pid": None, "processes": []}


@router.get("/agents/activity")
def agents_activity(request: Request):
    """Who is working on what right now and what they did last, across all agents.

    A task without an agent is listed too (`agent_id: null`): the default executor is an agent of sorts,
    and this page must not claim that nobody is working while the board is busy.
    """
    repo, cli = _repo(request), _dispatcher(request).cli
    starts = repo.first_session_times()
    runs, recent = [], []
    counts: dict[int | None, int] = {}
    tasks = sorted(repo.list_tasks(archived=False), key=lambda t: t.updated_at, reverse=True)
    for task in tasks:
        if task.status in ACTIVE_STATUSES:
            runs.append(_task_run(task, starts, activity.task_now(repo, cli, task)))
        elif task.status in RECENT_STATUSES and task.id in starts:
            if counts.get(task.agent_id, 0) < RECENT_PER_AGENT:
                counts[task.agent_id] = counts.get(task.agent_id, 0) + 1
                recent.append(_task_run(task, starts, None))
    for chat in repo.active_chats():
        runs.append({"kind": "chat", "id": chat.id, "title": chat.title, "agent_id": chat.agent_id,
                     "project_id": chat.project_id, "status": chat.status, "started_at": chat.turn_started_at,
                     "updated_at": chat.updated_at, "now": activity.chat_now(cli, chat)})
    return {"runs": runs, "recent": recent}


def _task_run(task: Task, starts: dict[int, str], now: dict | None) -> dict:
    return {"kind": "task", "id": task.id, "title": task.title, "agent_id": task.agent_id,
            "project_id": task.project_id, "status": str(task.status), "started_at": starts.get(task.id),
            "updated_at": task.updated_at, "now": now}
