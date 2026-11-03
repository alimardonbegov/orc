"""Schedule of recurring tasks (routines): interval or cron. No DB, tested with tables.

A routine stores the schedule kind (`interval` | `cron`) and decides itself when to create the next
run: the dispatcher asks `next_run(...)` here and puts the answer into routines.next_run_at.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

KINDS = ("interval", "cron")
# More often than once in five minutes is pointless: a run is a whole Claude Code session with a worktree,
# and a frequent routine will burn the limits faster than the owner notices.
MIN_INTERVAL_MINUTES = 5
# The ceiling is a year: beyond that a "recurring" task is no longer a routine but a reminder.
MAX_INTERVAL_MINUTES = 366 * 24 * 60
# How far ahead to look for the nearest cron slot. An impossible expression (February 30) would otherwise
# spin the loop forever; five years cover any honest "once a year on February 29".
CRON_HORIZON_DAYS = 5 * 366

# (field name, minimum, maximum)
_FIELDS = (("minutes", 0, 59), ("hours", 0, 23), ("day of month", 1, 31), ("month", 1, 12), ("day of week", 0, 7))


@dataclass(frozen=True)
class Cron:
    minutes: frozenset[int]
    hours: frozenset[int]
    days: frozenset[int]
    months: frozenset[int]
    weekdays: frozenset[int]  # 0 is Sunday, as in cron (7 is folded to 0 on parsing)
    days_any: bool            # the day-of-month field is "*"
    weekdays_any: bool        # the day-of-week field is "*"

    def day_matches(self, day: datetime) -> bool:
        """Cron rule: if both day of month and day of week are restricted, either one is enough."""
        dom = day.day in self.days
        dow = (day.weekday() + 1) % 7 in self.weekdays
        if self.days_any and self.weekdays_any:
            return True
        if self.days_any:
            return dow
        if self.weekdays_any:
            return dom
        return dom or dow


def _parse_field(raw: str, name: str, lo: int, hi: int) -> frozenset[int]:
    values: set[int] = set()
    for part in raw.split(","):
        if not part:
            raise ValueError(f"cron: empty element in field «{name}»")
        step = 1
        if "/" in part:
            part, step_raw = part.split("/", 1)
            if not step_raw.isdigit() or int(step_raw) == 0:
                raise ValueError(f"cron: step {step_raw!r} in field «{name}» must be an integer greater than zero")
            step = int(step_raw)
        if part == "*":
            start, end = lo, hi
        elif "-" in part:
            a, b = part.split("-", 1)
            if not (a.isdigit() and b.isdigit()):
                raise ValueError(f"cron: range {part!r} in field «{name}» could not be parsed")
            start, end = int(a), int(b)
            if start > end:
                raise ValueError(f"cron: range {part!r} in field «{name}» is reversed")
        elif part.isdigit():
            start = int(part)
            # "5/15" means every 15 minutes starting from the fifth, as in cronie
            end = hi if step > 1 else start
        else:
            raise ValueError(f"cron: {part!r} in field «{name}»: expected numbers, '*', '-', ',' and '/'")
        if start < lo or end > hi:
            raise ValueError(f"cron: field «{name}» accepts {lo}–{hi}, got {part!r}")
        values.update(range(start, end + 1, step))
    return frozenset(values)


def parse_cron(expr: str) -> Cron:
    """Parse an expression of five fields. An error is a ValueError with text for the owner."""
    parts = (expr or "").split()
    if len(parts) != 5:
        raise ValueError(f"cron: 5 fields needed (minutes hours day_of_month month day_of_week), got {len(parts)}")
    parsed = [_parse_field(raw, *spec) for raw, spec in zip(parts, _FIELDS)]
    weekdays = frozenset(0 if d == 7 else d for d in parsed[4])
    return Cron(minutes=parsed[0], hours=parsed[1], days=parsed[2], months=parsed[3], weekdays=weekdays,
                days_any=parts[2].startswith("*"), weekdays_any=parts[4].startswith("*"))


def zone(name: str | None) -> ZoneInfo | timezone:
    """The routine's timezone. Empty means UTC; unknown is a ValueError (the dashboard sends the browser timezone)."""
    if not name:
        return timezone.utc
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        raise ValueError(f"unknown timezone {name!r}") from None


def next_cron(expr: str | Cron, tz_name: str | None, after: datetime) -> datetime:
    """The nearest moment by cron strictly later than `after`. Computed in the timezone's local time,
    the result is in UTC. The search jumps (month -> day -> hour -> minute) instead of going by the minute:
    a yearly expression would otherwise iterate half a million minutes."""
    cron = parse_cron(expr) if isinstance(expr, str) else expr
    tz = zone(tz_name)
    local = after.astimezone(tz).replace(tzinfo=None, second=0, microsecond=0) + timedelta(minutes=1)
    limit = local + timedelta(days=CRON_HORIZON_DAYS)
    while local < limit:
        if local.month not in cron.months:
            year, month = (local.year + 1, 1) if local.month == 12 else (local.year, local.month + 1)
            local = local.replace(year=year, month=month, day=1, hour=0, minute=0)
            continue
        if not cron.day_matches(local):
            local = (local + timedelta(days=1)).replace(hour=0, minute=0)
            continue
        if local.hour not in cron.hours:
            local = (local + timedelta(hours=1)).replace(minute=0)
            continue
        if local.minute not in cron.minutes:
            local += timedelta(minutes=1)
            continue
        at = local.replace(tzinfo=tz).astimezone(timezone.utc)
        if at > after:
            return at
        # DST ends: the same hour on the local clock already happened, so we search further
        local += timedelta(minutes=1)
    raise ValueError(f"cron: expression {expr if isinstance(expr, str) else ''!r} never fires "
                     f"in the next five years")


def next_interval(minutes: int, after: datetime) -> datetime:
    return (after + timedelta(minutes=minutes)).replace(microsecond=0)


def check(kind: str, interval_minutes: int | None, cron: str | None, tz_name: str | None) -> None:
    """Routine schedule rules. Raises ValueError with text for a 400."""
    if kind not in KINDS:
        raise ValueError(f"schedule kind: expected one of {list(KINDS)}")
    zone(tz_name)
    if kind == "interval":
        if interval_minutes is None:
            raise ValueError("interval: specify how often to run, in minutes")
        if not MIN_INTERVAL_MINUTES <= interval_minutes <= MAX_INTERVAL_MINUTES:
            raise ValueError(f"interval: from {MIN_INTERVAL_MINUTES} minutes to a year, got {interval_minutes}")
    else:
        if not (cron or "").strip():
            raise ValueError("cron: the expression is empty")
        next_cron(cron, tz_name, datetime.now(timezone.utc))  # also catches "February 30"


def next_run(kind: str, interval_minutes: int | None, cron: str | None, tz_name: str | None,
             after: datetime) -> datetime:
    """The routine's next slot strictly later than `after`."""
    if kind == "interval":
        return next_interval(interval_minutes or MIN_INTERVAL_MINUTES, after)
    return next_cron(cron or "", tz_name, after)


def upcoming(kind: str, interval_minutes: int | None, cron: str | None, tz_name: str | None,
             after: datetime, count: int = 3) -> list[datetime]:
    """The next `count` slots, for the form: to check by eye that the expression means what you think."""
    out: list[datetime] = []
    at = after
    for _ in range(count):
        at = next_run(kind, interval_minutes, cron, tz_name, at)
        out.append(at)
    return out


def describe(kind: str, interval_minutes: int | None, cron: str | None, tz_name: str | None) -> str:
    """A short string for events and comments: "every 2 h", "cron 0 9 * * 1-5 (Europe/Moscow)"."""
    if kind == "interval":
        m = interval_minutes or 0
        if m == 60:
            return "every hour"
        if m == 24 * 60:
            return "every day"
        if m % (24 * 60) == 0:
            return f"every {m // (24 * 60)} days"
        if m % 60 == 0:
            return f"every {m // 60} h"
        return f"every {m} min"
    return f"cron {cron} ({tz_name or 'UTC'})"
