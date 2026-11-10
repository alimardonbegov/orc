"""Labels and planning dates of a card: validation without HTTP or SQL.

Labels are global across projects: a name is unique ignoring case. Planning dates are plain calendar
days (`YYYY-MM-DD`), with no time and no time zone, and the dispatcher never reads them. The deferred
start (`start_after`, orc/schedule.py) is a different thing: it holds the queue.
"""
from __future__ import annotations

import re
from datetime import date

NAME_MAX = 40
# Colours the picker offers, as `#rrggbb`. A custom value is accepted if it has the same shape.
DEFAULT_COLOR = "#8b8b95"
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def normalize_name(raw: str) -> str:
    """A label name: spaces collapsed, never empty, not longer than NAME_MAX."""
    name = " ".join(raw.split())
    if not name:
        raise ValueError("label name must not be blank")
    if len(name) > NAME_MAX:
        raise ValueError(f"label name is longer than {NAME_MAX} characters")
    return name


def normalize_color(raw: str | None) -> str:
    if raw is None or not raw.strip():
        return DEFAULT_COLOR
    color = raw.strip().lower()
    if not _COLOR_RE.match(color):
        raise ValueError(f"colour {raw!r}: expected #rrggbb")
    return color


def normalize_names(names: list[str]) -> list[str]:
    """Names of one card: normalized, without repeats (ignoring case), in the given order."""
    seen: dict[str, str] = {}
    for raw in names:
        name = normalize_name(raw)
        seen.setdefault(name.casefold(), name)
    return list(seen.values())


def normalize_date(raw: str | None) -> str | None:
    """`YYYY-MM-DD` or None. An empty string means no date."""
    if raw is None or not raw.strip():
        return None
    raw = raw.strip()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        raise ValueError(f"date {raw!r}: expected YYYY-MM-DD")
    try:
        return date.fromisoformat(raw).isoformat()
    except ValueError:
        raise ValueError(f"date {raw!r} does not exist") from None


def check_date_order(start: str | None, due: str | None) -> None:
    """The plan cannot end before it begins. ISO days compare as strings."""
    if start and due and due < start:
        raise ValueError(f"the due date {due} is earlier than the start date {start}")
