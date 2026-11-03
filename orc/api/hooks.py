"""Endpoints for session hooks /hooks/input-requests*.

They are called not by the dashboard but by orc/hooks/input_hook.py from inside a Claude Code session. Responses are deliberately
flat: the hook is stdlib-only and must parse them in a single line.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from orc.api.common import _check_hook_secret, _dispatcher, _input_request_view, _repo

router = APIRouter()


class InputRequestIn(BaseModel):
    """An input request from a session hook (orc/hooks/input_hook.py): what exactly the agent is waiting for."""
    task_id: int
    session_id: str | None = None
    cwd: str | None = None
    kind: str
    tool_name: str = ""
    tool_input: dict = {}


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
