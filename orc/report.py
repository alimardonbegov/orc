"""Worker report: the file Claude writes as its last action."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

REPORT_REL_PATH = ".orchestrator/report.json"


@dataclass(frozen=True)
class Report:
    status: str   # success | failed
    summary: str
    notes: str


def read_report(worktree: Path) -> Report | None:
    path = worktree / REPORT_REL_PATH
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(data, dict):
        return None
    status = data.get("status")
    if status not in ("success", "failed"):
        status = "failed"
    return Report(status=status, summary=str(data.get("summary") or ""), notes=str(data.get("notes") or ""))


def drop_report(worktree: Path) -> None:
    """Remove the report from the previous pass. Without this a reworked task passes verify on the
    old `status: success` even if the new session did not manage to do anything."""
    (worktree / REPORT_REL_PATH).unlink(missing_ok=True)
