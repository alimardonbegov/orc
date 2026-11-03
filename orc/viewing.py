"""Viewing results: a finished task waits for the owner's glance, like an unread email.

Agents close tasks on their own, in several projects at once, and "Done" grows without any
human involvement. The viewed mark answers a single question: "which results have I not seen yet".
It is not a task status and the dispatcher does not care about it: a task is done regardless of
whether the owner looked at it. That is why there is a single column `tasks.viewed_at` here and no
transitions in the dispatcher.

A task becomes unviewed by itself, without a write to the database: `viewed_at` is empty or older
than `done_at`. The latter is a rework: the task was viewed, sent back to the agent, closed
again, and the mark from the previous submission does not apply to the new result.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from orc.models import Task, TaskStatus

# How much recent work stays unviewed when there were no marks at all before: on a database
# upgrade and when viewing is enabled for a project. A day means "what closed while I was not
# looking", not the whole archive for months.
GRACE = timedelta(hours=24)

# An unviewed done task: a condition for WHERE. The completion time may not have been recorded
# for old tasks (done_at did not appear right away), so we compare only when it is present.
UNVIEWED_SQL = ("status = 'done' AND (viewed_at IS NULL "
                  "OR (done_at IS NOT NULL AND viewed_at < done_at))")
# The same, but only tasks closed before the cutoff (the parameter is its ISO string).
STALE_UNVIEWED_SQL = f"{UNVIEWED_SQL} AND COALESCE(done_at, updated_at) < ?"


def is_unviewed(task: Task) -> bool:
    """Whether the task result waits for the owner's glance. Only a live done task: a failure calls
    the human by itself (it is in "Waiting for me"), and an archived card has already been put out of sight."""
    if task.status != TaskStatus.DONE or task.archived_at:
        return False
    if not task.viewed_at:
        return True
    # Time strings of one format (orc/util.py) are compared lexicographically
    return bool(task.done_at) and task.viewed_at < task.done_at


def grace_cutoff(now: datetime) -> str:
    """The "recent" cutoff: when seeding, anything closed before it counts as viewed."""
    return (now - GRACE).replace(microsecond=0).isoformat()
