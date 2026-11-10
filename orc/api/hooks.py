"""Endpoints for sessions: /hooks/input-requests*, /hooks/tasks/{id}/handoff and /hooks/tasks/{id}/wakeups.

They are called not by the dashboard but from inside a Claude Code session: by orc/hooks/input_hook.py and by
`orc task done`, `orc task fail` and `orc task wakeup`. Responses are deliberately flat: the hook is stdlib-only and must parse them
in a single line.
"""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from orc import handoff
from orc.api.common import _check_chat_hook_secret, _check_hook_secret, _chat_request_view, _dispatcher, _input_request_view, _repo
from orc.chats import ChatError

router = APIRouter()


class InputRequestIn(BaseModel):
    """An input request from a session hook (orc/hooks/input_hook.py): what exactly the agent is waiting for."""
    task_id: int
    session_id: str | None = None
    cwd: str | None = None
    kind: str
    tool_name: str = ""
    tool_input: dict = {}


class HandoffIn(BaseModel):
    """`orc task done` or `orc task fail`. For failed the summary is the reason, and it is required."""
    status: Literal["done", "failed"]
    summary: str = ""


@router.post("/hooks/tasks/{task_id}/handoff")
def hook_handoff(task_id: int, body: HandoffIn, request: Request):
    _check_hook_secret(request, task_id)
    if _repo(request).get_task(task_id) is None:
        raise HTTPException(404, f"task #{task_id} not found")
    if body.status == handoff.STATUS_FAILED and not body.summary.strip():
        raise HTTPException(400, "say why the work cannot be completed: the owner reads this reason")
    try:
        return _dispatcher(request).hand_off(task_id, body.status, body.summary)
    except ValueError as e:
        raise HTTPException(409, str(e))


class WakeupIn(BaseModel):
    """`orc task wakeup`: a time (`at`, ISO 8601 with a zone) or a delay in seconds, a card to wait for, or a card with
    a deadline. The note is given back to the session when it wakes."""
    at: str | None = None
    in_sec: int | None = Field(default=None, ge=0)
    watch_task_id: int | None = None
    note: str = ""


@router.post("/hooks/tasks/{task_id}/wakeups", status_code=201)
def hook_wakeup(task_id: int, body: WakeupIn, request: Request):
    _check_hook_secret(request, task_id)
    if _repo(request).get_task(task_id) is None:
        raise HTTPException(404, f"task #{task_id} not found")
    try:
        return _dispatcher(request).create_wakeup(task_id, at=body.at, in_sec=body.in_sec,
                                                  watch_task_id=body.watch_task_id, note=body.note)
    except LookupError as e:
        raise HTTPException(409, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/hooks/input-requests", status_code=201)
def hook_input_request(body: InputRequestIn, request: Request):
    _check_hook_secret(request, body.task_id)
    try:
        row = _dispatcher(request).request_input(
            body.task_id, body.kind, body.tool_name, body.tool_input, session_id=body.session_id,
        )
    except ValueError as e:
        # 409, not 400: the request is valid, the task just is no longer waiting, so the hook quietly yields
        # to the dialog of Claude Code itself.
        raise HTTPException(409, str(e))
    return _input_request_view(row)


@router.get("/hooks/input-requests/{request_id}")
def hook_input_request_state(request_id: int, request: Request):
    row = _repo(request).get_input_request(request_id)
    if row is None:
        raise HTTPException(404, "request not found")
    _check_hook_secret(request, row["task_id"])
    return _input_request_view(row)


class ChatInputRequestIn(BaseModel):
    """The same request as above from a chat session: it has no card, so it is named by the chat."""
    chat_id: int
    session_id: str | None = None
    cwd: str | None = None
    kind: str
    tool_name: str = ""
    tool_input: dict = {}


@router.post("/hooks/chat-input-requests", status_code=201)
def hook_chat_input_request(body: ChatInputRequestIn, request: Request):
    _check_chat_hook_secret(request, body.chat_id)
    try:
        row = _dispatcher(request).chats.request_input(body.chat_id, body.kind, body.tool_name, body.tool_input)
    except ChatError as e:
        # 409 for the same reason: the hook quietly yields to the dialog of Claude Code itself
        raise HTTPException(409, str(e))
    return _chat_request_view(row)


@router.get("/hooks/chat-input-requests/{request_id}")
def hook_chat_input_request_state(request_id: int, request: Request):
    row = _repo(request).get_chat_message(request_id)
    if row is None or row["role"] != "input_request":
        raise HTTPException(404, "request not found")
    _check_chat_hook_secret(request, row["chat_id"])
    return _chat_request_view(row)
