"""The /tasks* endpoints: list, create, card, PATCH, comments, answers to input requests,
retry/resume/archive/unarchive/delete."""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from orc import branches, git_ops, projects, schedule
from orc.api.common import (
    ARCHIVED_FILTERS, FORCE_MOVES, MANUAL_MOVES, SCHEDULE_EDITABLE, SLICE2, TARGET_BRANCH_EDITABLE,
    _check_branch_exists, _check_deps, _check_description_for_work, _check_mode, _check_window_open, _dispatcher,
    _input_request_view, _repo, _task_detail, _task_out,
)
from orc.models import Blocker, TaskStatus
from orc.util import utc_now

router = APIRouter()


class TaskIn(BaseModel):
    project_id: int
    title: str = Field(min_length=1)
    description: str = ""
    priority: str = "normal"
    target_branch: str | None = None
    depends_on: list[int] = []
    model: str | None = None
    effort: str | None = None
    permission_mode: str | None = None
    verify_cmd: str | None = None
    requires_review: bool = False
    # Deferred start: ISO 8601 with a time zone (orc/schedule.py). null means no schedule.
    start_after: str | None = None
    start_before: str | None = None


class TaskPatch(BaseModel):
    title: str | None = None
    description: str | None = None
    priority: str | None = None
    status: str | None = None
    blocker: str | None = None
    target_branch: str | None = None
    depends_on: list[int] | None = None
    model: str | None = None
    effort: str | None = None
    permission_mode: str | None = None
    verify_cmd: str | None = None
    requires_review: bool | None = None
    # Deferred start: ISO 8601 with a time zone (orc/schedule.py). null means no schedule.
    start_after: str | None = None
    start_before: str | None = None
    # Manual order within a column (drag on the board, see web/src/components/Board.tsx).
    # The value is entirely up to the client: the server does not interpret it, only stores it.
    position: int | None = None
    # Confirmation of an emergency manual close (FORCE_MOVES). Not a task field: it is not written to the database.
    force: bool = False


def _schedule_or_400(start_after: str | None, start_before: str | None) -> tuple[str | None, str | None]:
    """A normalized and validated pair; an error is a 400 with text for the owner."""
    try:
        after, before = schedule.normalize(start_after), schedule.normalize(start_before)
        schedule.validate(after, before, utc_now())
    except ValueError as e:
        raise HTTPException(400, str(e))
    return after, before


class CommentIn(BaseModel):
    body: str = Field(min_length=1)
    kind: str = "comment"
    # For kind=answer: soft hands the message over through the inbox without touching the session;
    # interrupt stops it and continues with this text.
    mode: str = "soft"


class ViewedIn(BaseModel):
    """A mark that the result was viewed: true means viewed, false returns it to unviewed."""
    viewed: bool = True


class InputDecisionIn(BaseModel):
    """The owner's decision on a request. The content depends on the request kind and is validated by orc/inputs.py."""
    decision: dict


@router.get("/tasks")
def list_tasks(request: Request, project_id: int | None = None, status: str | None = None,
               archived: str = "hide"):
    if archived not in ARCHIVED_FILTERS:
        raise HTTPException(400, f"archived: expected one of {sorted(ARCHIVED_FILTERS)}")
    repo = _repo(request)
    deps = repo.all_deps()
    # Open input requests in one query for the whole list: the card and the "waiting for me" strip
    # distinguish "waiting for permission" from "waiting for an answer", and a single blocker badge does not show that.
    open_inputs = repo.open_input_requests()
    # When the task was first taken into work is also one query: the board shows it
    # on the "In progress" card, and tasks has no such column (see first_session_times).
    starts = repo.first_session_times()
    tasks = repo.list_tasks(project_id, status, archived=ARCHIVED_FILTERS[archived])
    return [{**_task_out(t), "depends_on": deps.get(t.id, []), "started_at": starts.get(t.id),
             "input_request": _input_request_view(open_inputs.get(t.id))} for t in tasks]


@router.post("/tasks", status_code=201)
def add_task(body: TaskIn, request: Request):
    repo = _repo(request)
    project = repo.get_project(body.project_id)
    if project is None:
        raise HTTPException(400, "project not found")
    # The project folder may have moved or been archived: without this check, task creation
    # would fail later, when reading branches, with an obscure git error.
    try:
        projects.check_available(project)
    except projects.ProjectPathError as e:
        raise HTTPException(409, str(e))
    _check_mode(body.permission_mode)
    if body.requires_review:
        raise HTTPException(400, f"requires_review: {SLICE2}")
    if body.depends_on:
        _check_deps(repo, body.depends_on)
    # The target branch is fixed when the card is created: the explicit one from the request, otherwise
    # the project's base branch, otherwise whatever is checked out in the repository right now.
    target = body.target_branch or branches.base_branch(project, git_ops.current_branch(Path(project.path)))
    _check_branch_exists(project.path, target)
    start_after, start_before = _schedule_or_400(body.start_after, body.start_before)
    task = repo.add_task(
        body.project_id, body.title, body.description, priority=body.priority, target_branch=target,
        depends_on=body.depends_on, model=body.model, effort=body.effort, permission_mode=body.permission_mode,
        verify_cmd=body.verify_cmd, requires_review=int(body.requires_review),
        start_after=start_after, start_before=start_before,
    )
    return _task_detail(repo, task)


@router.get("/tasks/{task_id}")
def get_task(task_id: int, request: Request):
    repo = _repo(request)
    task = repo.get_task(task_id)
    if task is None:
        raise HTTPException(404, "task not found")
    return _task_detail(repo, task)


@router.patch("/tasks/{task_id}")
def patch_task(task_id: int, body: TaskPatch, request: Request):
    repo, dispatcher = _repo(request), _dispatcher(request)
    task = repo.get_task(task_id)
    if task is None:
        raise HTTPException(404, "task not found")
    fields = body.model_dump(exclude_unset=True)
    # The edit form sends the whole schedule: fields equal to the current raw values are not an
    # edit. We drop them before parsing, otherwise garbage in the database (a broken string) would block
    # saving any other edit of the card.
    for key in ("start_after", "start_before"):
        if key in fields and fields[key] == getattr(task, key):
            del fields[key]
    if "start_after" in fields or "start_before" in fields:
        try:
            for key in ("start_after", "start_before"):
                if key in fields:
                    fields[key] = schedule.normalize(fields[key])
        except ValueError as e:
            raise HTTPException(400, str(e))
        after = fields.get("start_after", task.start_after)
        before = fields.get("start_before", task.start_before)
        if (after, before) == (task.start_after, task.start_before):
            # The edit form sends all fields at once: an unchanged schedule is not an edit, and it is not
            # validated (the window may have expired while the card sat in the backlog).
            fields.pop("start_after", None)
            fields.pop("start_before", None)
        else:
            if task.status not in SCHEDULE_EDITABLE:
                if (task.start_after, task.start_before) == (None, None):
                    # The form was opened on a waiting task, but the dispatcher has already started it and cleared
                    # the schedule. A title edit must not be lost because of that: stale
                    # schedule fields are quietly dropped.
                    fields.pop("start_after", None)
                    fields.pop("start_before", None)
                else:
                    raise HTTPException(400, f"the start schedule cannot be changed in status {task.status}: "
                                             f"the task has already started")
            else:
                _schedule_or_400(after, before)
    _check_mode(fields.get("permission_mode"))
    if fields.get("requires_review"):
        raise HTTPException(400, f"requires_review: {SLICE2}")
    if "blocker" in fields and fields["blocker"] is not None:
        # The badge is set only by the dispatcher. By hand it can ONLY be cleared: this is the
        # documented way to say "conflict resolved, merge again".
        allowed = sorted(b.value for b in Blocker)
        raise HTTPException(400, f"blocker can only be cleared (null); the dispatcher sets it. Values: {allowed}")
    if "blocker" in fields and task.blocker == Blocker.CONFLICT:
        # "Conflict resolved by hand" also means the resolution attempt counter is reset: the next
        # conflict of this task goes through the automatic path again, not straight to the human.
        fields["conflict_retry_count"] = 0
    if "target_branch" in fields and fields["target_branch"] != task.target_branch:
        if task.status not in TARGET_BRANCH_EDITABLE:
            raise HTTPException(400, f"target_branch cannot be changed in status {task.status}: "
                                     f"the worktree was already created from the previous base")
        project = repo.get_project(task.project_id)
        if project is not None:
            _check_branch_exists(project.path, fields["target_branch"])
    depends_on = fields.pop("depends_on", None)
    if depends_on is not None:
        _check_deps(repo, depends_on, task_id)
    # Handle the status separately from the other fields: failed -> todo must go through
    # dispatcher.retry (cleans worktree/branch/job_id), and an emergency manual close through
    # dispatcher.force_done (stops the session), not just rewrite the status column.
    new_status = fields.pop("status", None)
    force = fields.pop("force", False)
    if new_status is not None and new_status != task.status:
        move = (task.status, new_status)
        if move not in MANUAL_MOVES and move not in FORCE_MOVES:
            raise HTTPException(400, f"manual transition {task.status} -> {new_status} is not allowed")
        if move in FORCE_MOVES and not force:
            raise HTTPException(400, f"transition {task.status} -> {new_status} closes the task bypassing verification "
                                     f"and merge and stops its session: repeat the request with force=true")
        if new_status == TaskStatus.TODO:
            # Take the description including this same request: the form may add the task
            # statement and send the card to work in a single PATCH.
            _check_description_for_work(fields.get("description", task.description))
            _check_window_open(fields.get("start_before", task.start_before))
    if "requires_review" in fields:
        fields["requires_review"] = int(fields["requires_review"])
    if depends_on is not None:
        repo.set_deps(task_id, depends_on)
    # Apply the other card fields before the status transition so that retry() is not overwritten
    # by a later write (and so that retry() sees the current task data).
    if fields:
        task = repo.update_task(task_id, **fields)
    if new_status is not None and new_status != task.status:
        if task.status == TaskStatus.FAILED and new_status == TaskStatus.TODO:
            try:
                task = dispatcher.retry(task_id)
            except ValueError as e:
                raise HTTPException(400, str(e))
        elif (task.status, new_status) in FORCE_MOVES:
            # Not a plain status write: the session must be stopped and the message queue cleared.
            try:
                task = dispatcher.force_done(task_id)
            except ValueError as e:
                raise HTTPException(400, str(e))
        else:
            task = repo.update_task(task_id, status=new_status)
    return _task_detail(repo, task)


@router.post("/tasks/{task_id}/comments", status_code=201)
def add_comment(task_id: int, body: CommentIn, request: Request):
    repo, dispatcher = _repo(request), _dispatcher(request)
    if repo.get_task(task_id) is None:
        raise HTTPException(404, "task not found")
    # answer and rework add the comment themselves: the text must land in the card only
    # together with a successful delivery to the session, not separately from it.
    if body.kind in ("answer", "rework"):
        try:
            if body.kind == "answer":
                dispatcher.answer(task_id, body.body, mode=body.mode)
            else:
                dispatcher.rework(task_id, body.body)
        except ValueError as e:
            raise HTTPException(400, str(e))
        return _task_detail(repo, repo.get_task(task_id))
    if body.kind != "comment":
        raise HTTPException(400, "kind: comment | answer | rework")
    repo.add_comment(task_id, "user", "comment", body.body)
    return _task_detail(repo, repo.get_task(task_id))


@router.post("/tasks/{task_id}/input-requests/{request_id}/answer")
def answer_input_request(task_id: int, request_id: int, body: InputDecisionIn, request: Request):
    """The owner's decision: allow/deny a tool, answer a question, approve a plan.
    The session hook will pick it up on the nearest poll (see GET /hooks/input-requests/{id})."""
    try:
        _dispatcher(request).answer_input(task_id, request_id, body.decision)
    except ValueError as e:
        raise HTTPException(400, str(e))
    repo = _repo(request)
    return _task_detail(repo, repo.get_task(task_id))


@router.post("/tasks/{task_id}/retry")
def retry_task(task_id: int, request: Request):
    # Retry is the same entry into work as moving the card: it would restart
    # an empty task statement (old tasks may have been left with an empty description).
    task = _repo(request).get_task(task_id)
    if task is not None:
        _check_description_for_work(task.description)
        _check_window_open(task.start_before)
    try:
        return _task_out(_dispatcher(request).retry(task_id))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/tasks/{task_id}/trust")
def trust_task(task_id: int, request: Request):
    """The owner's explicit trust in the project folder (the untrusted blocker) and a restart of the task."""
    task = _repo(request).get_task(task_id)
    if task is not None:
        _check_description_for_work(task.description)
        _check_window_open(task.start_before)
    try:
        return _task_out(_dispatcher(request).trust_and_retry(task_id))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/tasks/{task_id}/resume")
def resume_task(task_id: int, request: Request):
    try:
        return _task_out(_dispatcher(request).resume_failed(task_id))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/tasks/{task_id}/viewed")
def mark_task_viewed(task_id: int, body: ViewedIn, request: Request):
    """Viewing the result (orc/viewing.py): "I have seen this" or "return to unviewed".
    A separate endpoint, not a PATCH field: the mark does not edit the card and does not touch updated_at."""
    repo = _repo(request)
    task = repo.get_task(task_id)
    if task is None:
        raise HTTPException(404, "task not found")
    if task.status != TaskStatus.DONE:
        raise HTTPException(400, f"only a finished task can be marked as viewed; this one is in status {task.status}")
    return _task_detail(repo, repo.set_viewed(task_id, body.viewed))


@router.post("/tasks/{task_id}/archive")
def archive_task(task_id: int, request: Request):
    repo, dispatcher = _repo(request), _dispatcher(request)
    if repo.get_task(task_id) is None:
        raise HTTPException(404, "task not found")
    try:
        task = dispatcher.archive(task_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _task_detail(repo, task)


@router.post("/tasks/{task_id}/unarchive")
def unarchive_task(task_id: int, request: Request):
    repo, dispatcher = _repo(request), _dispatcher(request)
    if repo.get_task(task_id) is None:
        raise HTTPException(404, "task not found")
    return _task_detail(repo, dispatcher.unarchive(task_id))


@router.delete("/tasks/{task_id}")
def delete_task(task_id: int, request: Request, force: bool = False, drop_worktree: bool = True):
    """Delete a task for good. force confirms deletion of a running task (its session
    will be cut off), drop_worktree=false keeps the branch and working copy."""
    repo, dispatcher = _repo(request), _dispatcher(request)
    if repo.get_task(task_id) is None:
        raise HTTPException(404, "task not found")
    try:
        removed = dispatcher.delete_task(task_id, force=force, drop_worktree=drop_worktree)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"deleted": task_id, **removed}
