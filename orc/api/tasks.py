"""The /tasks* endpoints: list, create, card, PATCH, comments, answers to input requests,
retry/resume/archive/unarchive/delete."""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from orc import branches, child_wake, git_ops, projects, runs, schedule, task_plans, wakeups
from orc.api.common import (
    ARCHIVED_FILTERS, FORCE_MOVES, MANUAL_MOVES, SCHEDULE_EDITABLE, SLICE2, TARGET_BRANCH_EDITABLE,
    _check_stage, _stage_blocked_by,
    _check_agent, _check_assignee_for_work, _check_branch_exists, _check_deps, _check_parent, _check_description_for_work,
    _check_window_open, _dispatcher, _plan_or_400,
    _input_request_view, _repo, _task_detail, _task_out,
)
from orc.models import Blocker, TaskStatus
from orc.util import utc_now

router = APIRouter()


class TaskIn(BaseModel):
    # A card or a routine holds no model, effort or permission mode: a caller that still sends them
    # must hear it, not get a run that quietly uses other parameters
    model_config = ConfigDict(extra="forbid")
    project_id: int
    title: str = Field(min_length=1)
    description: str = ""
    priority: str = "normal"
    # backlog (nothing happens yet) or todo (straight to the queue, under the same rules as moving it there)
    status: str = TaskStatus.BACKLOG
    target_branch: str | None = None
    depends_on: list[int] = []
    verify_cmd: str | None = None
    # The agent the task is allocated to (orc/agents.py). The card holds no run parameters of its own:
    # model, effort and permission mode come from the agent.
    agent_id: int | None = None
    requires_review: bool = False
    # Deferred start: ISO 8601 with a time zone (orc/schedule.py). null means no schedule.
    start_after: str | None = None
    start_before: str | None = None
    # Planning: calendar days YYYY-MM-DD, which the dispatcher never reads, and label names (created if missing)
    start_date: str | None = None
    due_date: str | None = None
    labels: list[str] = []
    # The card this one is a subtask of: grouping only, the queue does not read it
    parent_task_id: int | None = None
    # Wake the card when its subtasks are done (orc/child_wake.py): null follows the project's and orc's settings
    wake_on_children: bool | None = None
    # The stage among the subtasks of the parent (orc/stages.py); needs a parent
    stage: int | None = None


class TaskPatch(BaseModel):
    # A card or a routine holds no model, effort or permission mode: a caller that still sends them
    # must hear it, not get a run that quietly uses other parameters
    model_config = ConfigDict(extra="forbid")
    title: str | None = None
    description: str | None = None
    priority: str | None = None
    status: str | None = None
    blocker: str | None = None
    target_branch: str | None = None
    depends_on: list[int] | None = None
    verify_cmd: str | None = None
    agent_id: int | None = None
    requires_review: bool | None = None
    # Deferred start: ISO 8601 with a time zone (orc/schedule.py). null means no schedule.
    start_after: str | None = None
    start_before: str | None = None
    # Planning dates (YYYY-MM-DD, null clears) and the full list of label names; editable in every status
    start_date: str | None = None
    due_date: str | None = None
    labels: list[str] | None = None
    # The card this one is a subtask of (null makes it top-level); editable in every status, like the labels
    parent_task_id: int | None = None
    # Wake the card when its subtasks are done: true or false for this card, null to follow the project (orc/child_wake.py)
    wake_on_children: bool | None = None
    # The stage among the subtasks of the parent; null clears it
    stage: int | None = None
    # Manual order within a column (drag on the board, see web/src/components/Board.tsx).
    # The value is entirely up to the client: the server does not interpret it, only stores it.
    position: int | None = None
    # Confirmation of an emergency manual close (FORCE_MOVES). Not a task field: it is not written to the database.
    force: bool = False
    # The caller's folder, sent by `orc task edit`. Not a task field either: it says that an agent session is
    # asking, and the rules for agents (the generation fuse) apply to it.
    cwd: str | None = None


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
    # For kind=answer: soft leaves the agent's current step alone, as typing into a busy console does;
    # interrupt presses Esc first.
    mode: str = "soft"


class ViewedIn(BaseModel):
    """A mark that the result was viewed: true means viewed, false returns it to unviewed."""
    viewed: bool = True


class ResumeIn(BaseModel):
    """What to tell the session on resume. Without it, the routine "continue from where you left off"."""
    message: str | None = None


class InputDecisionIn(BaseModel):
    """The owner's decision on a request. The content depends on the request kind and is validated by orc/inputs.py."""
    decision: dict


def _check_agent_may_start(repo, task, cwd: str | None) -> None:
    """A card that an agent created too many generations deep may land only in the backlog, and the owner
    decides whether it goes on. Without this an agent could create it there and promote it by itself."""
    caller = task_plans.find_caller(repo.list_tasks(archived=False), cwd)
    if caller is not None and task_plans.too_deep_to_autostart(repo, task):
        raise HTTPException(400, f"card #{task.id} was created by a chain of agents {task_plans.generation(repo, task)} "
                                 f"generations deep, and only the owner may send it to work: leave it in the backlog")


@router.get("/tasks")
def list_tasks(request: Request, project_id: int | None = None, status: str | None = None,
               archived: str = "hide", label_id: int | None = None):
    if archived not in ARCHIVED_FILTERS:
        raise HTTPException(400, f"archived: expected one of {sorted(ARCHIVED_FILTERS)}")
    repo = _repo(request)
    deps = repo.all_deps()
    stage_blocked = _stage_blocked_by(repo)
    # Open input requests in one query for the whole list: the card and the "waiting for me" strip
    # distinguish "waiting for permission" from "waiting for an answer", and a single blocker badge does not show that.
    open_inputs = repo.open_input_requests()
    # When the task was first taken into work is also one query: the board shows it
    # on the "In progress" card, and tasks has no such column (see first_session_times).
    starts = repo.first_session_times()
    tasks = repo.list_tasks(project_id, status, archived=ARCHIVED_FILTERS[archived], label_id=label_id)
    # Labels in one query for the whole list, like the blockers: never one query per card
    labels = repo.labels_by_task()
    return [{**_task_out(t), "depends_on": deps.get(t.id, []), "stage_blocked_by": stage_blocked.get(t.id, []),
             "started_at": starts.get(t.id),
             "labels": labels.get(t.id, []),
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
    _check_agent(repo, body.agent_id, body.project_id)
    if body.requires_review:
        raise HTTPException(400, f"requires_review: {SLICE2}")
    if body.depends_on:
        _check_deps(repo, body.depends_on)
    _check_parent(repo, body.parent_task_id)
    _check_stage(repo, body.stage, body.parent_task_id, None, body.depends_on)
    # The target branch is fixed when the card is created: the explicit one from the request, otherwise
    # the one its blockers merge into (only there will their work be visible), otherwise the project's
    # base branch, otherwise whatever is checked out in the repository right now.
    target = (body.target_branch or task_plans.common_blocker_branch(map(repo.get_task, body.depends_on), body.project_id)
              or branches.base_branch(project, git_ops.current_branch(Path(project.path))))
    _check_branch_exists(project.path, target)
    start_after, start_before = _schedule_or_400(body.start_after, body.start_before)
    label_names, start_date, due_date = _plan_or_400(body.labels, body.start_date, body.due_date)
    if body.status not in (TaskStatus.BACKLOG, TaskStatus.TODO):
        raise HTTPException(400, f"status: a new card can be backlog or todo, got {body.status!r}")
    if body.status == TaskStatus.TODO:
        _check_assignee_for_work(body.agent_id)
        _check_description_for_work(body.description)
        _check_window_open(start_before)
    task = repo.add_task(
        body.project_id, body.title, body.description, priority=body.priority, target_branch=target,
        status=str(body.status),
        depends_on=body.depends_on,
        verify_cmd=body.verify_cmd, requires_review=int(body.requires_review), agent_id=body.agent_id,
        start_after=start_after, start_before=start_before, start_date=start_date, due_date=due_date,
        labels=label_names or (), parent_task_id=body.parent_task_id, stage=body.stage,
        wake_on_children=None if body.wake_on_children is None else int(body.wake_on_children),
    )
    return _task_detail(repo, task)


@router.get("/tasks/{task_id}")
def get_task(task_id: int, request: Request):
    repo = _repo(request)
    task = repo.get_task(task_id)
    if task is None:
        raise HTTPException(404, "task not found")
    return _task_detail(repo, task)


@router.get("/tasks/{task_id}/runs")
def task_runs(task_id: int, request: Request):
    """The card's execution log: runs with their trigger, outcome and cost, checks with their output, merges."""
    repo = _repo(request)
    task = repo.get_task(task_id)
    if task is None:
        raise HTTPException(404, "task not found")
    return runs.execution_log(repo, task, utc_now())


@router.get("/tasks/{task_id}/wakeups")
def task_wakeups(task_id: int, request: Request):
    """The wakeups the card's session asked for (orc/wakeups.py): pending ones and the history, oldest first."""
    repo = _repo(request)
    if repo.get_task(task_id) is None:
        raise HTTPException(404, "task not found")
    return [wakeups.view(row) for row in repo.list_wakeups(task_id)]


@router.post("/tasks/{task_id}/wakeups/{wakeup_id}/cancel")
def cancel_task_wakeup(task_id: int, wakeup_id: int, request: Request):
    """The owner cancels a pending wakeup (Dispatcher.cancel_wakeup)."""
    if _repo(request).get_task(task_id) is None:
        raise HTTPException(404, "task not found")
    try:
        return _dispatcher(request).cancel_wakeup(task_id, wakeup_id)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(409, str(e))


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
    # Planning is editable in every status: dates and labels describe the plan, not the session's assignment
    label_names = None
    if "labels" in fields or "start_date" in fields or "due_date" in fields:
        start = fields.get("start_date", task.start_date)
        due = fields.get("due_date", task.due_date)
        label_names, start, due = _plan_or_400(fields.pop("labels", None), start, due)
        for key, value in (("start_date", start), ("due_date", due)):
            if key in fields:
                fields[key] = value
    if "agent_id" in fields:
        _check_agent(repo, fields["agent_id"], task.project_id)
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
    if "parent_task_id" in fields:
        _check_parent(repo, fields["parent_task_id"], task_id)
    if "parent_task_id" in fields and fields["parent_task_id"] != task.parent_task_id and "stage" not in fields:
        fields["stage"] = None  # a stage belongs to the siblings of one parent: a card that moves leaves it
    if fields.get("stage") is not None:
        _check_stage(repo, fields.get("stage", task.stage), fields.get("parent_task_id", task.parent_task_id), task_id,
                     fields["depends_on"] if fields.get("depends_on") is not None else repo.deps_of(task_id))
    depends_on = fields.pop("depends_on", None)
    if depends_on is not None:
        _check_deps(repo, depends_on, task_id)
    # Handle the status separately from the other fields: failed -> todo must go through
    # dispatcher.retry (cleans worktree/branch/job_id), and an emergency manual close through
    # dispatcher.force_done (stops the session), not just rewrite the status column.
    new_status = fields.pop("status", None)
    force = fields.pop("force", False)
    cwd = fields.pop("cwd", None)
    if ("agent_id" in fields and fields["agent_id"] is None and new_status is None
            and task.status == TaskStatus.TODO and task.routine_id is None):
        # Taking the agent off a queued card hands it to a person: left in the queue, it would
        # still be started by the dispatcher, on the project's parameters and with nobody's name on it.
        new_status = TaskStatus.BACKLOG
        fields["position"] = None
    if new_status is not None and new_status != task.status:
        move = (task.status, new_status)
        if move not in MANUAL_MOVES and move not in FORCE_MOVES:
            raise HTTPException(400, f"manual transition {task.status} -> {new_status} is not allowed")
        if move in FORCE_MOVES and not force:
            raise HTTPException(400, f"transition {task.status} -> {new_status} closes the task bypassing verification "
                                     f"and merge and stops its session: repeat the request with force=true")
        if new_status == TaskStatus.TODO:
            _check_agent_may_start(repo, task, cwd)
            # Take the description including this same request: the form may add the task
            # statement and send the card to work in a single PATCH.
            _check_assignee_for_work(fields.get("agent_id", task.agent_id), task.routine_id)
            _check_description_for_work(fields.get("description", task.description))
            _check_window_open(fields.get("start_before", task.start_before))
    if "requires_review" in fields:
        fields["requires_review"] = int(fields["requires_review"])
    wake_before = child_wake.enabled_parents(repo) if "wake_on_children" in fields else None
    if fields.get("wake_on_children") is not None:
        fields["wake_on_children"] = int(fields["wake_on_children"])
    if depends_on is not None:
        repo.set_deps(task_id, depends_on)
    # Apply the other card fields before the status transition so that retry() is not overwritten
    # by a later write (and so that retry() sees the current task data).
    if fields:
        task = repo.update_task(task_id, **fields)
    if wake_before is not None:
        child_wake.take_baseline(repo, wake_before)
        task = repo.get_task(task_id)
    if label_names is not None:
        repo.set_task_labels(task_id, label_names)
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
        _check_assignee_for_work(task.agent_id, task.routine_id)
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
        _check_assignee_for_work(task.agent_id, task.routine_id)
        _check_description_for_work(task.description)
        _check_window_open(task.start_before)
    try:
        return _task_out(_dispatcher(request).trust_and_retry(task_id))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/tasks/{task_id}/resume")
def resume_task(task_id: int, request: Request, body: ResumeIn | None = None):
    message = (body.message or "").strip() if body else ""
    try:
        return _task_out(_dispatcher(request).resume_failed(task_id, message or None))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/tasks/{task_id}/accept")
def accept_task(task_id: int, request: Request):
    """The owner takes the work as handed in, for an agent that forgot to or gave up (Dispatcher.accept)."""
    if _repo(request).get_task(task_id) is None:
        raise HTTPException(404, f"task #{task_id} not found")
    try:
        return _task_out(_dispatcher(request).accept(task_id))
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.post("/tasks/{task_id}/stop")
def stop_task(task_id: int, request: Request):
    """Stop the agent and leave the task waiting for the owner's decision (Dispatcher.stop_session)."""
    repo = _repo(request)
    if repo.get_task(task_id) is None:
        raise HTTPException(404, "task not found")
    try:
        return _task_detail(repo, _dispatcher(request).stop_session(task_id))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/tasks/{task_id}/interrupt")
def interrupt_task(task_id: int, request: Request):
    """Esc in the session (Dispatcher.interrupt): unlike /stop, the session stays and the task stays in progress."""
    repo = _repo(request)
    if repo.get_task(task_id) is None:
        raise HTTPException(404, "task not found")
    try:
        return _task_detail(repo, _dispatcher(request).interrupt(task_id))
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
