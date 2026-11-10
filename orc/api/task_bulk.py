"""POST /tasks/bulk: one change for several cards at once.

Every card goes through the same code as a single edit (`PATCH /tasks/{id}`, archive, unarchive), so a bulk
change obeys exactly the rules of a single one: a card without an agent does not go to To do, a card that
already runs does not return to the backlog. The answer is always a result for every card: a refusal of
one card is data for the owner, not an error of the request. (`POST /tasks/batch` is the plan that creates
linked cards, a different thing.)
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict

from orc.api.common import _dispatcher, _repo
from orc.api.tasks import TaskPatch, patch_task
from orc.labels import normalize_names
from orc.models import TaskStatus

router = APIRouter()

MAX_CARDS = 200
PRIORITIES = {"high", "normal", "low"}
# Only the ordinary moves. An emergency close (force) stays a single-card action behind its confirmation.
BULK_STATUSES = {TaskStatus.BACKLOG.value, TaskStatus.TODO.value}


class BulkIn(BaseModel):
    """One action per request: either a change of fields, or (un)archive."""
    model_config = ConfigDict(extra="forbid")
    task_ids: list[int]
    status: str | None = None
    priority: str | None = None
    # An explicit null takes the agent off; an absent field leaves it alone (model_fields_set tells them apart)
    agent_id: int | None = None
    add_labels: list[str] | None = None
    remove_labels: list[str] | None = None
    # true archives, false unarchives
    archived: bool | None = None


def _error_text(e: Exception) -> str:
    if isinstance(e, HTTPException):
        return str(e.detail)
    return str(e) or type(e).__name__


@router.post("/tasks/bulk")
def bulk_tasks(body: BulkIn, request: Request):
    repo, dispatcher = _repo(request), _dispatcher(request)
    ids = list(dict.fromkeys(body.task_ids))
    if not ids:
        raise HTTPException(400, "task_ids: pick at least one card")
    if len(ids) > MAX_CARDS:
        raise HTTPException(400, f"task_ids: at most {MAX_CARDS} cards at once, got {len(ids)}")
    given = body.model_fields_set - {"task_ids"}
    if not given:
        raise HTTPException(400, "nothing to change")
    if "archived" in given and given != {"archived"}:
        raise HTTPException(400, "archived cannot be combined with other changes: one action per request")
    if "archived" in given and body.archived is None:
        raise HTTPException(400, "archived: expected true or false")
    if body.status is not None and body.status not in BULK_STATUSES:
        raise HTTPException(400, f"status: expected one of {sorted(BULK_STATUSES)}")
    if body.priority is not None and body.priority not in PRIORITIES:
        raise HTTPException(400, f"priority: expected one of {sorted(PRIORITIES)}")
    if "status" in given and body.status is None or "priority" in given and body.priority is None:
        raise HTTPException(400, "status and priority cannot be null")
    try:
        add = normalize_names(body.add_labels or [])
        remove = {n.lower() for n in normalize_names(body.remove_labels or [])}
    except ValueError as e:
        raise HTTPException(400, str(e))
    # One action per request: a card could otherwise keep the first field and refuse the second
    changes = [k for k in ("status", "priority", "agent_id") if k in given] + (["labels"] if add or remove else [])
    if len(changes) > 1:
        raise HTTPException(400, f"one change per request, got {changes}")

    results = []
    for task_id in ids:
        task = repo.get_task(task_id)
        if task is None:
            results.append({"id": task_id, "ok": False, "error": "card not found"})
            continue
        try:
            if "archived" in given:
                done = dispatcher.archive(task_id) if body.archived else dispatcher.unarchive(task_id)
            else:
                if task.archived_at:
                    raise ValueError("the card is archived: bring it back first")
                fields = {k: getattr(body, k) for k in ("status", "priority", "agent_id") if k in given}
                if add or remove:
                    current = [item["name"] for item in repo.labels_of(task_id)]
                    kept = [n for n in current if n.lower() not in remove]
                    fields["labels"] = normalize_names(kept + add)
                patch_task(task_id, TaskPatch(**fields), request)
                done = repo.get_task(task_id)
            results.append({"id": task_id, "ok": True, "status": str(done.status), "agent_id": done.agent_id})
        except Exception as e:  # one card's trouble must not hide what already happened to the others
            results.append({"id": task_id, "ok": False, "error": _error_text(e)})
    good = sum(1 for r in results if r["ok"])
    return {"results": results, "ok": good, "failed": len(results) - good}
