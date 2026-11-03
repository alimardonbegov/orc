"""Domain types. Dataclass fields match table columns so they can be built from sqlite3.Row."""
from __future__ import annotations

from dataclasses import dataclass, fields
from enum import StrEnum


class TaskStatus(StrEnum):
    BACKLOG = "backlog"
    TODO = "todo"
    IN_PROGRESS = "in_progress"
    VERIFYING = "verifying"
    MERGING = "merging"
    DONE = "done"
    FAILED = "failed"


class Priority(StrEnum):
    HIGH = "high"
    NORMAL = "normal"
    LOW = "low"


PRIORITY_ORDER = {Priority.HIGH: 0, Priority.NORMAL: 1, Priority.LOW: 2}


class Blocker(StrEnum):
    NEEDS_INPUT = "needs_input"
    CONFLICT = "conflict"
    DIRTY_COPY = "dirty_copy"
    QUOTA = "quota"
    # Claude Code does not trust the project folder: the start waits for the owner's explicit "trust" in the dashboard
    UNTRUSTED = "untrusted"


@dataclass
class Project:
    id: int
    name: str
    path: str
    default_model: str | None
    default_effort: str | None
    default_permission_mode: str
    default_branch: str | None
    verify_cmd: str | None
    verify_timeout_sec: int
    max_workers: int
    push_enabled: int
    archived_at: str | None  # the project was removed from the dashboard; NULL means a regular project
    created_at: str
    position: int | None = None  # manual order in the sidebar; NULL means sort by id, as before
    # JSON list of model ids hidden from this project's dropdowns; NULL means as in the orc settings
    hidden_models: str | None = None
    # Viewing results (orc/viewing.py): the project's finished tasks wait for the owner to look at them.
    # 0 means the project does not take part: no marks on cards, no counters.
    track_viewed: int = 1


@dataclass
class Task:
    id: int
    project_id: int
    title: str
    description: str
    status: str
    priority: str
    blocker: str | None
    blocker_detail: str | None
    target_branch: str | None
    model: str | None
    effort: str | None
    permission_mode: str | None
    verify_cmd: str | None
    requires_review: int
    worktree_path: str | None
    branch: str | None
    job_id: str | None
    session_id: str | None
    auto_resume_count: int
    state_miss_count: int      # consecutive ticks when state.json could not be read
    quota_retry_count: int     # how many times the task has already been retried on quota
    conflict_retry_count: int  # how many times the task has already been sent to resolve a conflict with the target branch
    resume_with: str | None
    outbox_state: str | None   # queued | sent | stopping | stalled; None means the queue is empty
    merge_queued_at: str | None
    retry_after: str | None
    report_json: str | None
    created_at: str
    updated_at: str
    done_at: str | None
    archived_at: str | None  # the task was removed from the board; NULL means a regular task
    position: int | None = None  # manual order within a column; NULL means sort by id, as before
    usage_json: str | None = None  # tokens across all task sessions (orc/token_usage.py); NULL means not counted yet
    hook_secret: str | None = None  # secret for this task's hooks (orc/inputs.py); NULL means no secret issued yet or it was reset
    start_after: str | None = None   # deferred start: not earlier than (orc/schedule.py); NULL means immediately
    start_before: str | None = None  # end of the start window: not later than; NULL means the window is open on the right
    # When the owner viewed the result (orc/viewing.py). NULL means not viewed. A mark older than
    # done_at belongs to a previous submission: after rework the task is unviewed again.
    viewed_at: str | None = None
    # A run of a recurring task (orc/routines.py): whose card this is and which run by count.
    # NULL means a regular task (or the routine was deleted, and the run stays a regular task).
    routine_id: int | None = None
    routine_run: int | None = None


@dataclass
class Routine:
    """A recurring task: the setup and the schedule. Each run is a separate task (Task)."""
    id: int
    project_id: int
    title: str
    description: str
    priority: str
    model: str | None
    effort: str | None
    permission_mode: str | None
    verify_cmd: str | None
    target_branch: str | None
    schedule_kind: str          # interval | cron (orc/recurrence.py)
    interval_minutes: int | None
    cron: str | None
    timezone: str | None        # IANA zone the cron is read in; NULL means UTC
    enabled: int
    next_run_at: str | None     # when to create the next run; NULL for a disabled one
    last_run_at: str | None
    run_count: int
    skipped_count: int
    max_runs: int | None        # ceiling on runs; NULL means no ceiling
    archive_runs: int           # 1 means past finished runs go to the archive
    created_at: str
    updated_at: str


PROJECT_COLUMNS = {f.name for f in fields(Project)}
TASK_COLUMNS = {f.name for f in fields(Task)}
ROUTINE_COLUMNS = {f.name for f in fields(Routine)}
