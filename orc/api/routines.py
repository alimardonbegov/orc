"""The /routines* endpoints: recurring tasks: list with statistics, create, edit, pause,
"run now", run history. The run logic lives in orc/routines.py."""
from __future__ import annotations

import json
from dataclasses import asdict

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from orc import projects, recurrence, routines
from orc.api.common import (
    _check_branch_exists, _check_description_for_work, _check_mode, _dispatcher, _repo,
)
from orc.models import Routine, TaskStatus
from orc.util import utc_now

router = APIRouter()

PRIORITIES = {"high", "normal", "low"}


class RoutineIn(BaseModel):
    project_id: int
    title: str = Field(min_length=1)
    description: str = ""
    priority: str = "normal"
    model: str | None = None
    effort: str | None = None
    permission_mode: str | None = None
    verify_cmd: str | None = None
    target_branch: str | None = None
    schedule_kind: str = "interval"
    interval_minutes: int | None = None
    cron: str | None = None
    timezone: str | None = None
    enabled: bool = True
    max_runs: int | None = Field(default=None, ge=1)
    archive_runs: bool = True


class RoutinePatch(BaseModel):
    title: str | None = Field(default=None, min_length=1)
    description: str | None = None
    priority: str | None = None
    model: str | None = None
    effort: str | None = None
    permission_mode: str | None = None
    verify_cmd: str | None = None
    target_branch: str | None = None
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


SCHEDULE_FIELDS = ("schedule_kind", "interval_minutes", "cron", "timezone")


def _check_schedule(kind: str, interval_minutes: int | None, cron: str | None, tz: str | None) -> None:
    try:
        recurrence.check(kind, interval_minutes, cron, tz)
    except ValueError as e:
        raise HTTPException(400, str(e))


def _check_priority(priority: str | None) -> None:
    if priority is not None and priority not in PRIORITIES:
        raise HTTPException(400, f"priority: expected one of {sorted(PRIORITIES)}")


def _routine_or_404(request: Request, routine_id: int) -> Routine:
    routine = _repo(request).get_routine(routine_id)
    if routine is None:
        raise HTTPException(404, "routine not found")
    return routine


def _report_summary(raw: str | None) -> dict | None:
    """A run's report (report.json) already as an object. A broken one gives None: it must not break the list."""
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
        "task_id": task.id, "run": task.routine_run, "title": task.title, "status": task.status,
        "blocker": task.blocker, "blocker_detail": task.blocker_detail,
        "created_at": task.created_at, "started_at": started_at, "done_at": task.done_at,
        "updated_at": task.updated_at, "archived_at": task.archived_at,
        "report": _report_summary(task.report_json), "tokens": _tokens(task.usage_json),
    }


def _routine_out(routine: Routine, stats: dict[str, int] | None, last, started_at: str | None) -> dict:
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
        "last_run": _run_out(last, started_at) if last is not None else None,
    }


def _routine_view(request: Request, routine: Routine) -> dict:
    repo = _repo(request)
    last = repo.last_routine_runs().get(routine.id)
    return _routine_out(routine, repo.routine_run_stats().get(routine.id), last,
                        repo.first_session_time(last.id) if last else None)


@router.get("/routines")
def list_routines(request: Request, project_id: int | None = None):
    repo = _repo(request)
    stats = repo.routine_run_stats()
    last = repo.last_routine_runs()
    starts = repo.first_session_times()
    return [_routine_out(r, stats.get(r.id), last.get(r.id), starts.get(last[r.id].id) if r.id in last else None)
            for r in repo.list_routines(project_id)]


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
    project = repo.get_project(body.project_id)
    if project is None:
        raise HTTPException(400, "project not found")
    try:
        projects.check_available(project)
    except projects.ProjectPathError as e:
        raise HTTPException(409, str(e))
    # Every run goes to the agent with this text: an empty task description means an empty scheduled session
    _check_description_for_work(body.description)
    _check_mode(body.permission_mode)
    _check_priority(body.priority)
    _check_schedule(body.schedule_kind, body.interval_minutes, body.cron, body.timezone)
    if body.target_branch:
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
    _check_mode(fields.get("permission_mode"))
    _check_priority(fields.get("priority"))
    for key in ("title", "schedule_kind", "enabled", "archive_runs", "priority"):
        if key in fields and fields[key] is None:
            raise HTTPException(400, f"{key}: null is not allowed")
    if fields.get("target_branch"):
        project = repo.get_project(routine.project_id)
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
    repo.add_event(f"routine '{routine.title}' deleted, its runs stayed on the board as ordinary tasks",
                   project_id=routine.project_id)
    return {"deleted": routine_id}


@router.post("/routines/{routine_id}/run", status_code=201)
def run_routine(routine_id: int, request: Request):
    """Run now: an out-of-turn run, the schedule does not shift."""
    repo = _repo(request)
    routine = _routine_or_404(request, routine_id)
    project = repo.get_project(routine.project_id)
    if project is not None:
        try:
            projects.check_available(project)
        except projects.ProjectPathError as e:
            raise HTTPException(409, str(e))
    try:
        task = _dispatcher(request).run_routine(routine_id)
    except routines.RunActive as e:
        raise HTTPException(409, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"task_id": task.id, "routine": _routine_view(request, repo.get_routine(routine_id))}


@router.get("/routines/{routine_id}/runs")
def routine_runs(routine_id: int, request: Request):
    """Run history of a routine, newest first, including those moved to the archive."""
    repo = _repo(request)
    _routine_or_404(request, routine_id)
    starts = repo.first_session_times()
    return [_run_out(t, starts.get(t.id)) for t in repo.routine_runs(routine_id)]
