"""The /chats* endpoints: direct conversations with an agent. The mechanics live in orc/chats.py."""
from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from orc import branches, git_ops, projects
from orc.api.common import _chat_request_view, _dispatcher, _repo
from orc.chats import ChatError
from orc.models import Chat
from orc.util import now_iso

router = APIRouter()

MESSAGE_MAX = 100_000
# Internal bookkeeping: paths and offsets are of no use to the dashboard
HIDDEN_FIELDS = ("transcript_path", "transcript_offset", "usage_json", "turn_progress", "hook_secret")


class ChatIn(BaseModel):
    agent_id: int
    project_id: int | None = None
    title: str = ""


class ChatPatch(BaseModel):
    """Only the fields that are sent change. A blank title is refused, as before."""
    title: str | None = Field(default=None, min_length=1, max_length=200)
    pinned: bool | None = None
    archived: bool | None = None


class MessageIn(BaseModel):
    body: str = Field(min_length=1, max_length=MESSAGE_MAX)


class ReadIn(BaseModel):
    # Omitted: everything the chat holds now
    message_id: int | None = None


def _chat_or_404(request: Request, chat_id: int) -> Chat:
    chat = _repo(request).get_chat(chat_id)
    if chat is None:
        raise HTTPException(404, "chat not found")
    return chat


def _chat_out(chat: Chat, summary: dict | None = None) -> dict:
    out = {k: v for k, v in asdict(chat).items() if k not in HIDDEN_FIELDS}
    return {**out, "last_message": (summary or {}).get("last_message"), "unread": (summary or {}).get("unread", 0)}


def _message_out(row: dict) -> dict:
    if row["role"] == "input_request":
        return {**row, "request": _chat_request_view(row)}
    if row["role"] != "proposal":
        return row
    # A proposal's body is JSON written by the server itself
    return {**row, "proposal": json.loads(row["body"])}


@router.get("/chats")
def list_chats(request: Request, agent_id: int | None = None, project_id: int | None = None):
    repo = _repo(request)
    summaries = repo.chat_summaries()
    return [_chat_out(c, summaries.get(c.id)) for c in repo.list_chats(agent_id, project_id)]


@router.post("/chats", status_code=201)
def add_chat(body: ChatIn, request: Request):
    repo = _repo(request)
    agent = repo.get_agent(body.agent_id)
    if agent is None:
        raise HTTPException(400, "agent not found")
    # An agent internal to a project talks only about that project, even if the client did not say so
    project_id = body.project_id if body.project_id is not None else agent.project_id
    if agent.project_id is not None and project_id != agent.project_id:
        raise HTTPException(400, "this agent is internal to another project")
    if project_id is not None:
        project = repo.get_project(project_id)
        if project is None:
            raise HTTPException(400, "project not found")
        try:
            projects.check_available(project)
        except projects.ProjectPathError as e:
            raise HTTPException(409, str(e))
    return _chat_out(repo.add_chat(agent.id, project_id, body.title.strip()[:200]))


@router.get("/chats/{chat_id}")
def get_chat(chat_id: int, request: Request):
    repo = _repo(request)
    chat = _chat_or_404(request, chat_id)
    return {**_chat_out(chat, repo.chat_summaries().get(chat_id)),
            "messages": [_message_out(m) for m in repo.list_chat_messages(chat_id)]}


@router.patch("/chats/{chat_id}")
def patch_chat(chat_id: int, body: ChatPatch, request: Request):
    repo = _repo(request)
    _chat_or_404(request, chat_id)
    fields: dict = {}
    if body.title is not None:
        title = body.title.strip()
        if not title:
            raise HTTPException(400, "the title is empty")
        fields["title"] = title
    if body.pinned is not None:
        fields["pinned"] = int(body.pinned)
    if body.archived is not None:
        fields["archived_at"] = now_iso() if body.archived else None
    if not fields:
        raise HTTPException(400, "nothing to change")
    # The list is ordered by the last activity: organising it is not activity
    return _chat_out(repo.update_chat(chat_id, touch=False, **fields), repo.chat_summaries().get(chat_id))


@router.delete("/chats/{chat_id}")
def delete_chat(chat_id: int, request: Request):
    _chat_or_404(request, chat_id)
    _dispatcher(request).chats.delete(chat_id)
    return {"deleted": chat_id}


@router.post("/chats/{chat_id}/messages", status_code=201)
def send_message(chat_id: int, body: MessageIn, request: Request):
    chat = _chat_or_404(request, chat_id)
    if not body.body.strip():
        raise HTTPException(400, "the message is empty")
    # Writing to an archived chat brings it back: the owner is clearly not done with it
    if chat.archived_at:
        _repo(request).update_chat(chat_id, touch=False, archived_at=None)
    # Nothing is started here: a launch takes seconds, so the chat loop does it
    return _message_out(_dispatcher(request).chats.send(chat, body.body.strip()))


@router.post("/chats/{chat_id}/stop")
def stop_chat(chat_id: int, request: Request):
    _chat_or_404(request, chat_id)
    return _chat_out(_dispatcher(request).chats.stop_turn(chat_id))


@router.post("/chats/{chat_id}/read")
def mark_read(chat_id: int, body: ReadIn, request: Request):
    chat = _chat_or_404(request, chat_id)
    # Only forward: a stale request from another tab must not bring unread messages back
    repo = _repo(request)
    # Never past the newest message: a mark that ran ahead would swallow the replies that come later
    upto = min(body.message_id, repo.last_message_id(chat_id)) if body.message_id is not None else repo.last_message_id(chat_id)
    if upto > chat.last_read_message_id:
        chat = repo.update_chat(chat_id, touch=False, last_read_message_id=upto)
    return {"last_read_message_id": chat.last_read_message_id}


@router.post("/chats/read-all")
def mark_all_read(request: Request):
    return {"chats": _repo(request).mark_all_chats_read()}


@router.post("/chats/{chat_id}/unread")
def mark_unread(chat_id: int, request: Request):
    """Brings the newest reply back as unread, so the owner comes back to the chat later."""
    repo = _repo(request)
    _chat_or_404(request, chat_id)
    reply = repo.last_reply_id(chat_id)
    if reply is None:
        raise HTTPException(409, "the chat has no reply to mark")
    repo.update_chat(chat_id, touch=False, last_read_message_id=reply - 1)
    return _chat_out(repo.get_chat(chat_id), repo.chat_summaries().get(chat_id))


def _open_proposal(request: Request, chat_id: int, message_id: int) -> dict:
    message = _repo(request).get_chat_message(message_id)
    if message is None or message["chat_id"] != chat_id or message["role"] != "proposal":
        raise HTTPException(404, "proposal not found")
    if message["state"] != "open":
        raise HTTPException(409, f"the proposal is already {message['state']}")
    return message


@router.post("/chats/{chat_id}/proposals/{message_id}/accept", status_code=201)
def accept_proposal(chat_id: int, message_id: int, request: Request):
    repo = _repo(request)
    chat = _chat_or_404(request, chat_id)
    message = _open_proposal(request, chat_id, message_id)
    project = repo.get_project(chat.project_id) if chat.project_id else None
    if project is None:
        raise HTTPException(409, "the chat is not attached to a project")
    try:
        projects.check_available(project)
    except projects.ProjectPathError as e:
        raise HTTPException(409, str(e))
    base = branches.base_branch(project, git_ops.current_branch(Path(project.path)))
    try:
        return _dispatcher(request).chats.accept_proposal(chat, message, base)
    except ChatError as e:
        raise HTTPException(409, str(e))


@router.post("/chats/{chat_id}/proposals/{message_id}/dismiss")
def dismiss_proposal(chat_id: int, message_id: int, request: Request):
    _chat_or_404(request, chat_id)
    message = _open_proposal(request, chat_id, message_id)
    _repo(request).update_chat_message(message["id"], state="dismissed")
    return {"ok": True}


class InputDecisionIn(BaseModel):
    decision: dict


@router.post("/chats/{chat_id}/input-requests/{message_id}/answer")
def answer_input_request(chat_id: int, message_id: int, body: InputDecisionIn, request: Request):
    """The owner's decision on what the session waits for: allow or deny a tool, answer a question, approve a
    plan. The session hook picks it up on its next poll."""
    _chat_or_404(request, chat_id)
    try:
        return _message_out(_dispatcher(request).chats.answer_input(chat_id, message_id, body.decision))
    except (ChatError, ValueError) as e:
        raise HTTPException(400, str(e))
