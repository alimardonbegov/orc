"""Detecting a failure due to a quota limit and the retry schedule."""
from __future__ import annotations

import re
from datetime import datetime, timedelta

# Word boundaries are mandatory: detail is a human-readable summary of the last action,
# and without \b a task "add rate limiting to the API" produces a false match on failure, which sends
# the WHOLE dispatcher into quota_wait for 30-120 minutes. User regexes from the settings
# must not be changed silently: there the owner sets the boundaries.
DEFAULT_QUOTA_PATTERNS = [
    r"\busage limit\b",
    r"\brate limit\b",
    r"\blimit reached\b",
    r"\bquota\b",
    r"\bresets at\b",
]


def is_quota_error(text: str, patterns: list[str] | None = None) -> bool:
    pats = patterns if patterns is not None else DEFAULT_QUOTA_PATTERNS
    return any(re.search(p, text, re.IGNORECASE) for p in pats)


# A small margin on top of the reset time. Sources round `resets_at` differently (in
# `rate_limit_event` these are whole seconds, in ~/.claude.json microseconds), and the reset itself on the
# Anthropic side does not happen exactly at that second. A start right at the edge hits the limit again
# and burns an attempt of QUOTA_RETRY_LIMIT, so we wait a minute longer.
RESET_BUFFER_SEC = 60
# Beyond this horizon there is nowhere for the reset time of the FIVE-HOUR window to come from: if the snapshot holds
# something larger, it is corruption or someone else's window. Such a value cannot be trusted: the whole board would stop for
# as long as it says.
MAX_RESET_AHEAD_SEC = 6 * 3600


def retry_delay_minutes(attempt: int) -> int:
    # 30 -> 60 -> 120 and then 120
    return min(30 * (2 ** attempt), 120)


def reset_retry_at(now: datetime, status: dict | None) -> datetime | None:
    """When the five-hour window will actually reset (+ buffer), from the limits snapshot of orc/usage.py.

    None means "nobody to ask": limits are unavailable, stale, without a reset time, or
    this time is implausible (already passed / too far away). Then the caller takes the blind
    backoff `retry_delay_minutes`. A reset in the past is also returned as None, not as "retry
    now": since Claude has just answered with a limit, an immediate start would fail in the same
    tick and waste an attempt.
    """
    if not status or not status.get("available") or status.get("stale"):
        return None
    window = status.get("five_hour")
    resets_at = window.get("resets_at") if isinstance(window, dict) else None
    if not isinstance(resets_at, (int, float)) or isinstance(resets_at, bool):
        return None
    try:
        moment = _from_epoch(resets_at + RESET_BUFFER_SEC, now)
    except (OverflowError, OSError, ValueError):
        return None  # epoch outside the calendar range: such a snapshot is useless
    if not now < moment <= now + timedelta(seconds=MAX_RESET_AHEAD_SEC):
        return None
    return moment


def _from_epoch(epoch: float, like: datetime) -> datetime:
    """Epoch -> a datetime with the same timezone "awareness" as `like`: the result is compared
    and added to the dispatcher's now(), and naive and aware times must not be mixed."""
    return datetime.fromtimestamp(epoch, tz=like.tzinfo) if like.tzinfo else datetime.fromtimestamp(epoch)
