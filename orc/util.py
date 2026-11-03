"""Shared utilities: UTC time in a single format across the whole application."""
from __future__ import annotations

from datetime import datetime, timezone


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def now_iso() -> str:
    # Second precision is enough, and the string sorts lexicographically
    return utc_now().replace(microsecond=0).isoformat()
