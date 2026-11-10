"""The /routines* endpoints: recurring tasks: list with statistics, create, edit, pause,
"run now", run history. The run logic lives in orc/routines.py."""
from __future__ import annotations

import json
from dataclasses import asdict

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from orc import projects, recurrence, routines
from orc.api.common import (
    _check_agent, _check_branch_exists, _check_description_for_work, _dispatcher, _repo,
)
from orc.models import Chat, Routine, Task, TaskStatus
from orc.util import utc_now

router = APIRouter()

PRIORITIES = {"high", "normal", "low"}


class RoutineIn(BaseModel):
    # A card or a routine holds no model, effort or permission mode: a caller that still sends them
    # must hear it, not get a run that quietly uses other parameters
    model_config = ConfigDict(extra="forbid")
    project_id: int | None = None  # None: a routine outside any project, its runs are chats
    title: str = Field(min_length=1)
    description: str = ""
    priority: str = "normal"
    verify_cmd: str | None = None
    target_branch: str | None = None
    agent_id: int | None = None
    schedule_kind: str = "interval"
    interval_minutes: int | None = None
    cron: str | None = None
    timezone: str | None = None
    enabled: bool = True
    max_runs: int | None = Field(default=None, ge=1)
    archive_runs: bool = True


class RoutinePatch(BaseModel):
    # A card or a routine holds no model, effort or permission mode: a caller that still sends them
    # must hear it, not get a run that quietly uses other parameters
    model_config = ConfigDict(extra="forbid")
    # Sent explicitly: a project id moves the routine there, null detaches it (its runs become chats)
    project_id: int | None = None
    title: str | None = Field(default=None, min_length=1)
    description: str | None = None
    priority: str | None = None
    verify_cmd: str | None = None
    target_branch: str | None = None
    agent_id: int | None = None
    schedule_kind: str | None = None
    interval_minutes: int | None = None
    cron: str | None = None
    timezone: str | None = None
    enabled: bool | None = None
    max_runs: int | None = Field(default=None, ge=1)
    archive_runs: bool | None = None


class SchedulePreviewIn(BaseModel):
    schedule_kind: str = "interval"
    interval_minutes: int | None = None
    cron: str | None = None
    timezone: str | None = None


# Run parameters that only a card in a project has: a run in a chat takes everything from its agent
PROJECT_ONLY_FIELDS = ("verify_cmd", "target_branch")
# A chat has no board column, so its status is shown as the task status that means the same
CHAT_AS_TASK_STATUS = {"idle": TaskStatus.DONE, "queued": TaskStatus.TODO, "running": TaskStatus.IN_PROGRESS,
                       "waiting": TaskStatus.IN_PROGRESS}

SCHEDULE_FIELDS = ("schedule_kind", "interval_minutes", "cron", "timezone")


def _check_schedule(kind: str, interval_minutes: int | None, cron: str | None, tz: str | None) -> None:
    try:
        recurrence.check(kind, interval_minutes, cron, tz)
    except ValueError as e:
        raise HTTPException(400, str(e))


def _check_no_project_fields(values: dict) -> None:
    """A routine outside a project: its run is a chat, so the card-only parameters have nowhere to go."""
    for key in PROJECT_ONLY_FIELDS:
        if values.get(key):
            raise HTTPException(400, f"{key}: not applicable to a routine outside a project "
                                     f"(the agent's own settings apply)")


def _check_priority(priority: str | None) -> None:
    if priority is not None and priority not in PRIORITIES:
        raise HTTPException(400, f"priority: expected one of {sorted(PRIORITIES)}")


def _routine_or_404(request: Request, routine_id: int) -> Routine:
    routine = _repo(request).get_routine(routine_id)
    if routine is None:
        raise HTTPException(404, "routine not found")
    return routine


def _report_summary(raw: str | None) -> dict | None:
    """A run's report (tasks.report_json, orc/handoff.py) already as an object. A broken one gives None: it must not break the list."""
    if not raw:
        return None
    try:
        report = json.loads(raw)
    except ValueError:
        return None
    return report if isinstance(report, dict) else None


def _tokens(raw: str | None) -> int | None:
    try:
        usage = json.loads(raw) if raw else None
    except ValueError:
        return None
    value = usage.get("total_tokens") if isinstance(usage, dict) else None
    return value if isinstance(value, int) else None


def _run_out(task, started_at: str | None) -> dict:
    """A run in the routine history: exactly what a table row needs, without the conversation and sessions."""
    return {
        "task_id": task.id, "chat_id": None, "run": task.routine_run, "title": task.title, "status": task.status,
        "blocker": task.blocker, "blocker_detail": task.blocker_detail,
        "created_at": task.created_at, "started_at": started_at, "done_at": task.done_at,
        "updated_at": task.updated_at, "archived_at": task.archived_at,
        "report": _report_summary(task.report_json), "tokens": _tokens(task.usage_json),
    }


def _chat_run_out(chat) -> dict:
    """A run of a routine outside a project, in the same shape as a card's run: the history table is shared."""
    status = CHAT_AS_TASK_STATUS.get(chat.status, TaskStatus.TODO)
    return {
        "task_id": None, "chat_id": chat.id, "run": chat.routine_run, "title": chat.title, "status": status,
        "blocker": None, "blocker_detail": None,
        "created_at": chat.created_at, "started_at": chat.turn_started_at or chat.created_at,
        "done_at": chat.updated_at if status == TaskStatus.DONE else None,
        "updated_at": chat.updated_at, "archived_at": None,
        "report": None, "tokens": _tokens(chat.usage_json),
    }


def _chat_stats(by_chat_status: dict[str, int] | None) -> dict[str, int]:
    """Chat counters by chat status → the same keys as for cards, so _routine_out counts them alike."""
    out: dict[str, int] = {}
    for status, n in (by_chat_status or {}).items():
        key = CHAT_AS_TASK_STATUS.get(status, TaskStatus.TODO)
        out[key] = out.get(key, 0) + n
    return out


def _routine_out(routine: Routine, stats: dict[str, int] | None, last_run: dict | None) -> dict:
    stats = stats or {}
    active = sum(stats.get(s, 0) for s in routines.ACTIVE_RUN_STATUSES)
    return {
        **asdict(routine),
        "enabled": bool(routine.enabled), "archive_runs": bool(routine.archive_runs),
        "schedule_text": routines.describe(routine),
        "stats": {
            "total": sum(stats.values()), "done": stats.get(TaskStatus.DONE, 0),
            "failed": stats.get(TaskStatus.FAILED, 0), "active": active,
            "skipped": routine.skipped_count,
        },
        "last_run": last_run,
    }


def _routine_view(request: Request, routine: Routine) -> dict:
    repo = _repo(request)
    if routine.project_id is None:
        chat = repo.last_routine_chats().get(routine.id)
        return _routine_out(routine, _chat_stats(repo.routine_chat_stats().get(routine.id)),
                            _chat_run_out(chat) if chat else None)
    last = repo.last_routine_runs().get(routine.id)
    return _routine_out(routine, repo.routine_run_stats().get(routine.id),
                        _run_out(last, repo.first_session_time(last.id)) if last else None)


@router.get("/routines")
def list_routines(request: Request, project_id: int | None = None):
    """Routines of one project, or all of them (those outside any project included) without project_id."""
    repo = _repo(request)
    stats, chat_stats = repo.routine_run_stats(), repo.routine_chat_stats()
    last, last_chats = repo.last_routine_runs(), repo.last_routine_chats()
    starts = repo.first_session_times()
    out = []
    for r in repo.list_routines(project_id):
        if r.project_id is None:
            chat = last_chats.get(r.id)
            out.append(_routine_out(r, _chat_stats(chat_stats.get(r.id)), _chat_run_out(chat) if chat else None))
        else:
            run = last.get(r.id)
            out.append(_routine_out(r, stats.get(r.id), _run_out(run, starts.get(run.id)) if run else None))
    return out


@router.post("/routines/preview")
def preview_schedule(body: SchedulePreviewIn):
    """Upcoming scheduled runs: the form shows them under the field so that the cron
    can be checked by eye before saving."""
    _check_schedule(body.schedule_kind, body.interval_minutes, body.cron, body.timezone)
    slots = recurrence.upcoming(body.schedule_kind, body.interval_minutes, body.cron, body.timezone, utc_now())
    return {"next": [s.isoformat() for s in slots],
            "text": recurrence.describe(body.schedule_kind, body.interval_minutes, body.cron, body.timezone)}


@router.post("/routines", status_code=201)
def add_routine(body: RoutineIn, request: Request):
    repo = _repo(request)
    project = None
    if body.project_id is not None:
        project = repo.get_project(body.project_id)
        if project is None:
            raise HTTPException(400, "project not found")
        try:
            projects.check_available(project)
        except projects.ProjectPathError as e:
            raise HTTPException(409, str(e))
    elif body.agent_id is None:
        # The run of a routine outside a project is a chat, and a chat is always with an agent
        raise HTTPException(400, "agent_id: a routine outside a project needs an agent")
    else:
        _check_no_project_fields(body.model_dump())
    # Every run goes to the agent with this text: an empty task description means an empty scheduled session
    _check_description_for_work(body.description)
    _check_agent(repo, body.agent_id, body.project_id)
    _check_priority(body.priority)
    _check_schedule(body.schedule_kind, body.interval_minutes, body.cron, body.timezone)
    if body.target_branch and project is not None:
        _check_branch_exists(project.path, body.target_branch)
    fields = body.model_dump(exclude={"project_id", "title", "enabled", "archive_runs"})
    if body.schedule_kind == "interval":
        fields["cron"] = None
    else:
        fields["interval_minutes"] = None
    routine = repo.add_routine(body.project_id, body.title, **fields, enabled=int(body.enabled),
                               archive_runs=int(body.archive_runs))
    if body.enabled:
        routine = repo.update_routine(routine.id, next_run_at=routines.next_slot(routine, utc_now()))
    repo.add_event(f"routine '{routine.title}' created: {routines.describe(routine)}", project_id=routine.project_id)
    return _routine_view(request, routine)


@router.get("/routines/{routine_id}")
def get_routine(routine_id: int, request: Request):
    return _routine_view(request, _routine_or_404(request, routine_id))


@router.patch("/routines/{routine_id}")
def patch_routine(routine_id: int, body: RoutinePatch, request: Request):
    repo = _repo(request)
    routine = _routine_or_404(request, routine_id)
    fields = body.model_dump(exclude_unset=True)
    if "description" in fields:
        _check_description_for_work(fields["description"])
    target_project_id = fields.get("project_id", routine.project_id)
    if "project_id" in fields and fields["project_id"] == routine.project_id:
        del fields["project_id"]
    if "project_id" in fields:
        # Attach, move or detach. Past runs stay where they were made (cards or chats); an unfinished
        # run would be orphaned from the history the routine shows afterwards, so wait for it.
        if routines.active_run(repo, routine_id) is not None:
            raise HTTPException(409, "the routine has an unfinished run: wait for it before changing the project")
        if target_project_id is not None:
            project = repo.get_project(target_project_id)
            if project is None:
                raise HTTPException(400, "project not found")
            try:
                projects.check_available(project)
            except projects.ProjectPathError as e:
                raise HTTPException(409, str(e))
        # Card-only parameters belong to the old project's repository: start clean unless sent anew
        for key in PROJECT_ONLY_FIELDS:
            fields.setdefault(key, None)
        # The agent must still fit the new place: a project-internal agent does not follow to another
        agent_id = fields.get("agent_id", routine.agent_id)
        if target_project_id is None and agent_id is None:
            raise HTTPException(400, "agent_id: a routine outside a project needs an agent")
        _check_agent(repo, agent_id, target_project_id)
    if target_project_id is None:
        _check_no_project_fields(fields)
        if "agent_id" in fields and fields["agent_id"] is None:
            raise HTTPException(400, "agent_id: a routine outside a project needs an agent")
    if "agent_id" in fields:
        _check_agent(repo, fields["agent_id"], target_project_id)
    _check_priority(fields.get("priority"))
    for key in ("title", "schedule_kind", "enabled", "archive_runs", "priority"):
        if key in fields and fields[key] is None:
            raise HTTPException(400, f"{key}: null is not allowed")
    if fields.get("target_branch"):
        project = repo.get_project(target_project_id)
        if project is not None:
            _check_branch_exists(project.path, fields["target_branch"])
    merged = {k: fields.get(k, getattr(routine, k)) for k in SCHEDULE_FIELDS}
    schedule_changed = any(k in fields and fields[k] != getattr(routine, k) for k in SCHEDULE_FIELDS)
    if schedule_changed:
        _check_schedule(merged["schedule_kind"], merged["interval_minutes"], merged["cron"], merged["timezone"])
        if merged["schedule_kind"] == "interval":
            fields["cron"] = None
        else:
            fields["interval_minutes"] = None
    for key in ("enabled", "archive_runs"):
        if key in fields:
            fields[key] = int(fields[key])
    enabling = fields.get("enabled") == 1 and not routine.enabled
    pausing = fields.get("enabled") == 0 and bool(routine.enabled)
    will_run = bool(fields.get("enabled", routine.enabled))
    ceiling = fields["max_runs"] if "max_runs" in fields else routine.max_runs
    if will_run and ceiling is not None and routine.run_count >= ceiling:
        raise HTTPException(400, f"the ceiling of {ceiling} runs has already been reached (there were {routine.run_count}): "
                                 f"raise it or remove it to continue")
    routine = repo.update_routine(routine_id, **fields)
    if not routine.enabled:
        if routine.next_run_at is not None:
            routine = repo.update_routine(routine_id, next_run_at=None)
    elif enabling or schedule_changed or routine.next_run_at is None:
        # Enabling after a pause and changing the schedule count the slot from the current moment:
        # what was missed during the pause is not caught up.
        routine = repo.update_routine(routine_id, next_run_at=routines.next_slot(routine, utc_now()))
    if "project_id" in fields:
        repo.add_event(f"routine '{routine.title}' moved: "
                       f"{'detached from the project' if routine.project_id is None else 'attached to a project'}",
                       project_id=routine.project_id)
    if enabling:
        repo.add_event(f"routine '{routine.title}' resumed: {routines.describe(routine)}",
                       project_id=routine.project_id)
    elif pausing:
        repo.add_event(f"routine '{routine.title}' paused", project_id=routine.project_id)
    return _routine_view(request, routine)


@router.delete("/routines/{routine_id}")
def delete_routine(routine_id: int, request: Request):
    """Delete a routine. Its runs stay as ordinary tasks, with their own reports and history."""
    repo = _repo(request)
    routine = _routine_or_404(request, routine_id)
    repo.delete_routine(routine_id)
    repo.add_event(f"routine '{routine.title}' deleted, its runs stayed as ordinary "
                   f"{'chats' if routine.project_id is None else 'tasks'}", project_id=routine.project_id)
    return {"deleted": routine_id}


@router.post("/routines/{routine_id}/run", status_code=201)
def run_routine(routine_id: int, request: Request):
    """Run now: an out-of-turn run, the schedule does not shift."""
    repo = _repo(request)
    routine = _routine_or_404(request, routine_id)
    project = repo.get_project(routine.project_id) if routine.project_id is not None else None
    if project is not None:
        try:
            projects.check_available(project)
        except projects.ProjectPathError as e:
            raise HTTPException(409, str(e))
    try:
        run = _dispatcher(request).run_routine(routine_id)
    except routines.RunActive as e:
        raise HTTPException(409, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"task_id": run.id if isinstance(run, Task) else None,
            "chat_id": run.id if isinstance(run, Chat) else None,
            "routine": _routine_view(request, repo.get_routine(routine_id))}


@router.get("/routines/{routine_id}/runs")
def routine_runs(routine_id: int, request: Request):
    """Run history of a routine, newest first, including those moved to the archive."""
    repo = _repo(request)
    routine = _routine_or_404(request, routine_id)
    if routine.project_id is None:
        return [_chat_run_out(c) for c in repo.routine_chats(routine_id)]
    starts = repo.first_session_times()
    return [_run_out(t, starts.get(t.id)) for t in repo.routine_runs(routine_id)]
