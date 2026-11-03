"""Deferred task start: parsing and checking the launch window. No DB, tested with tables.

The window is two task columns: start_after ("not before") and start_before ("not after", only together
with start_after). A waiting task stays in todo, the dispatcher simply does not pick it up until the time, and
returns one that missed the window to the backlog.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

log = logging.getLogger(__name__)


def normalize(raw: str | None) -> str | None:
    """Client time -> ISO UTC with second precision. Empty is None.

    No timezone is an error: "23:00" without a zone is not a moment but a guess about
    where the owner's browser is.
    """
    if raw is None or not raw.strip():
        return None
    raw = raw.strip()
    try:
        at = datetime.fromisoformat(raw)
    except ValueError:
        raise ValueError(f"could not parse time {raw!r}: expected ISO 8601 with a timezone") from None
    if at.tzinfo is None:
        raise ValueError(f"time {raw!r} has no timezone: send a full timestamp, for example 2026-10-05T23:00:00Z")
    return at.astimezone(timezone.utc).replace(microsecond=0).isoformat()


def validate(start_after: str | None, start_before: str | None, now: datetime) -> None:
    """Rules for a pair (already normalized). A past "not before" is acceptable: it means "can start immediately"."""
    if start_before is None:
        return
    if start_after is None:
        raise ValueError("start window end without a beginning: set 'not before' too")
    end = datetime.fromisoformat(start_before)
    if end <= datetime.fromisoformat(start_after):
        raise ValueError("the start window end must be later than its beginning")
    if end <= now:
        raise ValueError("the start window has already ended: choose an end in the future")


def _parse(raw: str | None, task_id: int | None = None) -> datetime | None:
    """Time from the database. A broken value is None and a warning: a tick must not fail because of it."""
    if not raw:
        return None
    try:
        at = datetime.fromisoformat(raw)
    except ValueError:
        log.warning("task #%s: broken schedule time %r, ignoring", task_id, raw)
        return None
    if at.tzinfo is None:
        log.warning("task #%s: schedule time without a timezone %r, ignoring", task_id, raw)
        return None
    return at


def window_closed(start_before: str | None, now: datetime) -> bool:
    """The end of the window has come: it is too late to start."""
    end = _parse(start_before)
    return end is not None and now >= end


def is_waiting(task, now: datetime) -> bool:
    """The "not before" time has not been reached yet: the dispatcher does not pick the task up and does not hold a slot for it."""
    at = _parse(task.start_after, task.id)
    return at is not None and now < at


def is_expired(task, now: datetime) -> bool:
    """The window ended and the task never started."""
    end = _parse(task.start_before, task.id)
    return end is not None and now >= end


def human(raw: str | None) -> str:
    """For comments and events: "2026-10-05 23:00 UTC". Empty is "…"."""
    at = _parse(raw)
    return at.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC") if at else "…"
