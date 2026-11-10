"""Wakeups: a task session asks to be resumed later, at a time or when another card is done.

`orc task wakeup` only records, like `orc task done`: a pending row in `task_wakeups` and the handoff signal
`sleep`. When the turn is over, the dispatcher shuts the session down and marks the card `sleeping`: still in
progress, with its worktree and conversation on disk, but no live process and no worker slot. A dispatcher step
checks the pending wakeups of sleeping cards on every tick and resumes the session with the reason, when a slot is
free. See docs/internals/wakeups.md.

The conditions are facts orc already stores, so nothing runs on behalf of the agent: the clock, and the status of
another card. The agent decides itself what the new state means once it is awake.
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

from orc.inputs import shorten
from orc.models import Task, TaskStatus
from orc.repo import Repo

KIND_AT = "at"
KIND_TASK = "task"

PENDING = "pending"
FIRED = "fired"
CANCELLED = "cancelled"

# The handoff signal of a turn that ends in sleep (orc/handoff.py keeps done and failed)
STATUS_SLEEP = "sleep"

# A wakeup further away than this is a forgotten card, not a plan.
MAX_AHEAD = timedelta(days=30)
# Shorter than a dispatcher tick or two is a poll in disguise: the slot would be given back and taken again at once.
MIN_AHEAD = timedelta(minutes=1)
NOTE_LIMIT = 2000

WAKE_PROMPT = (
    "You asked to be woken up, and now {reason}.{note} Check the current state of what you were waiting for, "
    "then continue the task, and hand in the work at the end as your instructions say."
)


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).replace(microsecond=0).isoformat()


def _moment(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        at = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return at if at.tzinfo else at.replace(tzinfo=timezone.utc)


def _clock(raw: str | None) -> str:
    at = _moment(raw)
    return at.strftime("%Y-%m-%d %H:%M UTC") if at else "?"


def parse_time(raw: str) -> datetime:
    """An absolute time from the agent. No zone is an error: the agent's guess of where the server is would be wrong."""
    try:
        at = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    except ValueError:
        raise ValueError(f"could not parse time {raw!r}: expected ISO 8601 with a time zone") from None
    if at.tzinfo is None:
        raise ValueError(f"time {raw!r} has no time zone: send a full timestamp, for example 2026-11-08T15:00:00Z")
    return at


def create(repo: Repo, task: Task, now: datetime, *, at: str | None = None, in_sec: int | None = None,
           watch_task_id: int | None = None, note: str = "") -> dict:
    """Record a wakeup for the session of `task` and the signal that this turn ends in sleep.

    ValueError for a request that cannot be right; LookupError for a watched card that is already done, which
    the agent should hear now instead of sleeping on it."""
    if task.status != TaskStatus.IN_PROGRESS:
        raise ValueError(f"task #{task.id} is {task.status}, not in progress: there is nothing to put to sleep")
    if at is not None and in_sec is not None:
        raise ValueError("a time or a delay, not both")
    wake_at: datetime | None = None
    if at is not None:
        wake_at = parse_time(at)
    elif in_sec is not None:
        wake_at = now + timedelta(seconds=in_sec)
    if wake_at is not None:
        if wake_at < now + MIN_AHEAD:
            raise ValueError(f"the wakeup must be at least {int(MIN_AHEAD.total_seconds() // 60)} minute ahead")
        if wake_at > now + MAX_AHEAD:
            raise ValueError(f"the wakeup must be within {MAX_AHEAD.days} days")
    if watch_task_id is not None:
        if watch_task_id == task.id:
            raise ValueError("a card cannot wait for itself")
        watched = repo.get_task(watch_task_id)
        if watched is None:
            raise ValueError(f"card #{watch_task_id} not found")
        if watched.archived_at:
            raise ValueError(f"card #{watch_task_id} is archived: it will never be done")
        if watched.status in (TaskStatus.DONE, TaskStatus.FAILED):
            raise LookupError(f"card #{watch_task_id} is already {watched.status}: continue now instead of sleeping")
        kind = KIND_TASK
    elif wake_at is not None:
        kind = KIND_AT
    else:
        raise ValueError("say when to wake: a time, a delay, or a card to wait for")
    row = repo.add_wakeup(task.id, kind, _iso(wake_at) if wake_at else None, watch_task_id,
                          shorten(note.strip(), NOTE_LIMIT, keep_lines=True))
    repo.update_task(task.id, handoff_at=time.time(), handoff_status=STATUS_SLEEP)
    return view(row)


def describe(wakeup: dict) -> str:
    """The condition in a few words, for the card's badge, the feed and the CLI."""
    if wakeup["kind"] == KIND_TASK:
        text = f"until #{wakeup['watch_task_id']} is done"
        if wakeup.get("wake_at"):
            text += f", at the latest {_clock(wakeup['wake_at'])}"
        return text
    return f"until {_clock(wakeup.get('wake_at'))}"


def sleeping_detail(pending: list[dict]) -> str:
    if not pending:
        return "asleep with no wakeup left: write to the agent to wake it, accept the work or close the card"
    return "asleep " + "; or ".join(describe(w) for w in pending)


def due_reason(repo: Repo, wakeup: dict, now: datetime) -> str | None:
    """Why this wakeup fires now, or None while its condition does not hold.

    A watched card that failed, was archived or deleted wakes the sleeper too: it would wait forever otherwise,
    and what to do about it is the agent's call."""
    if wakeup["kind"] == KIND_TASK and wakeup.get("watch_task_id") is not None:
        number = wakeup["watch_task_id"]
        watched = repo.get_task(number)
        if watched is None:
            return f"card #{number} was deleted"
        if watched.archived_at:
            return f"card #{number} was archived"
        if watched.status == TaskStatus.DONE:
            return f"card #{number} is done"
        if watched.status == TaskStatus.FAILED:
            return f"card #{number} failed"
    at = _moment(wakeup.get("wake_at"))
    if at is not None and now >= at:
        if wakeup["kind"] == KIND_TASK:
            return f"the deadline {_clock(wakeup['wake_at'])} passed while #{wakeup['watch_task_id']} was not done"
        return f"the time came ({_clock(wakeup['wake_at'])})"
    return None


def wake_prompt(wakeup: dict, reason: str) -> str:
    note = wakeup.get("note") or ""
    return WAKE_PROMPT.format(reason=reason, note=f" Your note for this moment: {note}" if note else "")


def view(row: dict) -> dict:
    return {**row, "summary": describe(row)}
