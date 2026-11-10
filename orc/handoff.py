"""How a session hands in its work: `orc task done` and `orc task fail`.

The signal lives in the database. `handoff_at` is compared with the start of the session's last turn, so a
new turn makes an old signal stale by itself and nothing has to clean up after every message. The text of
the handoff goes into `tasks.report_json` as {status, summary, notes}, an old name for a live field.

This is also the only module that knows about `.orchestrator/report.json`. Sessions started under the old
prompt keep writing that file, and a report from the current turn counts as a handoff: it is copied into the
database, and from there on nothing tells the two apart. Remove the `report` half together with the last
session that can still write one.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path

from orc.inputs import shorten
from orc.models import Task
from orc.repo import Repo

STATUS_DONE = "done"
STATUS_FAILED = "failed"
SUMMARY_LIMIT = 4000
# report_json keeps the words the board and routine summaries already read
_REPORT_STATUS = {STATUS_DONE: "success", STATUS_FAILED: "failed"}

REPORT_REL_PATH = ".orchestrator/report.json"
# The agent's own statement that the work is not finished: it stopped for the owner's answer or check.
REPORT_NEEDS_INPUT = "needs_input"
_REPORT_HANDOFF = {"success": STATUS_DONE, "failed": STATUS_FAILED}


@dataclass(frozen=True)
class Report:
    status: str   # success | failed | needs_input
    summary: str
    notes: str


def record(repo: Repo, task_id: int, status: str, summary: str = "", notes: str = "",
           at: float | None = None) -> Task:
    """Store a handoff. It changes no status: the dispatcher acts on it when the turn is over."""
    report = {"status": _REPORT_STATUS[status], "summary": shorten(summary, SUMMARY_LIMIT, keep_lines=True), "notes": notes}
    return repo.update_task(task_id, handoff_at=time.time() if at is None else at, handoff_status=status,
                            report_json=json.dumps(report, ensure_ascii=False))


def clear(repo: Repo, task: Task) -> Task:
    """Forget the handoff, for when the work goes back to the session and an old one must not let it through."""
    if task.worktree_path:
        drop_report(Path(task.worktree_path))
    return repo.update_task(task.id, handoff_at=None, handoff_status=None)


def of_turn(repo: Repo, task: Task, started_at: float) -> tuple[Task, str | None]:
    """The task as it is now, and what the turn that started at `started_at` handed in: a status or None."""
    task = ingest_report(repo, task, since=started_at)
    if task.handoff_at is None or task.handoff_at < started_at:
        return task, None
    return task, task.handoff_status


def fill_summary(repo: Repo, task: Task, final_text: str | None) -> Task:
    """A summary is optional: without one, the words the agent ended its turn with stand for it."""
    report = _parse(task.report_json)
    if not final_text or not task.handoff_status or report is None or str(report.get("summary") or "").strip():
        return task
    report["summary"] = shorten(final_text, SUMMARY_LIMIT, keep_lines=True)
    return repo.update_task(task.id, report_json=json.dumps(report, ensure_ascii=False))


def reason(task: Task) -> str:
    """Why the session gave up, for the card."""
    report = _parse(task.report_json) or {}
    parts = (str(report.get(key) or "").strip() for key in ("summary", "notes"))
    return "\n\n".join(part for part in parts if part)


def _parse(raw: str | None) -> dict | None:
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


# ---------- the transition: report.json from sessions started under the old prompt ----------

def ingest_report(repo: Repo, task: Task, since: float | None = None) -> Task:
    """Copy a report.json into the database if it says more than the stored handoff.

    `since` is the start of the turn: an older file belongs to a previous pass. Without it (a task that sat
    in `verifying` during the upgrade) only the stored handoff limits it.
    """
    if not task.worktree_path:
        return task
    try:
        mtime = (Path(task.worktree_path) / REPORT_REL_PATH).stat().st_mtime
    except OSError:
        return task
    if (since is not None and mtime < since) or (task.handoff_at is not None and mtime <= task.handoff_at):
        return task
    report = read_report(Path(task.worktree_path))
    if report is None:
        return task  # unreadable: not a handoff, and the card waits for its owner
    status = _REPORT_HANDOFF.get(report.status)
    if status is None:
        # needs_input is written after anything stored: the agent says itself that it is not finished.
        return repo.update_task(task.id, handoff_at=None, handoff_status=None) if task.handoff_status else task
    return record(repo, task.id, status, report.summary, report.notes, at=mtime)


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
    if status not in ("success", "failed", REPORT_NEEDS_INPUT):
        status = "failed"
    return Report(status=status, summary=str(data.get("summary") or ""), notes=str(data.get("notes") or ""))


def drop_report(worktree: Path) -> None:
    """Remove the report from the previous pass. Without this a reworked task passes verify on the
    old `status: success` even if the new session did not manage to do anything."""
    (worktree / REPORT_REL_PATH).unlink(missing_ok=True)
