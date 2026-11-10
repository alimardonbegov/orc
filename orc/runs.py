"""The execution log of a card: its runs, checks and merges, with what each run cost.

A run is a row of task_sessions: one Claude Code job of the task, with the trigger that started it and the outcome
that ended it (orc/sessions.py, TRIGGERS and OUTCOMES). A check is a row of task_checks. A merge is read from the
events the merge queue already writes (orc/merging.py): no table of its own.

The cost of a run is not counted again. The spending log (usage_ledger) already holds the task's spending as
increments over time, and a run gets the increments written while it was the latest run. The log prices by the
estimate while the card's total may be Claude Code's exact price (analytics.task_cost), so the shares are then
scaled to that total: the runs add up to the number the card shows, and a resumed session that repeats its
history counts once, the way the task's total does.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone

from orc.analytics import task_cost
from orc.models import Task, TaskStatus
from orc.repo import Repo

# How much of a check's output is kept: the end, where a test runner prints the failures and the summary.
OUTPUT_TAIL = 8000

# The merge queue's own event texts (orc/merging.py), and what each says about the merge. Matched exactly: a
# reworded event breaks a test, not the log.
MERGE_EVENTS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("merged", re.compile(r"^#\d+ merged into (?P<target>.+)$")),
    ("failed", re.compile(r"^#\d+ merge failed: (?P<detail>.*)$", re.DOTALL)),
    ("conflict", re.compile(r"^#\d+ conflict with (?P<target>[^\s:]+)(?::\s*(?P<detail>.*))?$", re.DOTALL)),
)
MERGE_FRAGMENTS = (" merged into ", " merge failed: ", " conflict with ")


def output_tail(output: str) -> str:
    return output[-OUTPUT_TAIL:]


def _moment(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def _run_index(starts: list[datetime | None], at: datetime | None) -> int:
    """Which run an increment of the spending log belongs to: the latest one that started strictly before it.

    Strictly: the increment that closes a run is written in the same second the next run starts (the dispatcher
    counts tokens right before it resumes a session). An increment before the first run, or one whose time cannot
    be read, belongs to the first and the last run respectively."""
    if at is None:
        return len(starts) - 1
    index = 0
    for i, start in enumerate(starts):
        if start is not None and start < at:
            index = i
    return index


def _task_usage(task: Task) -> dict | None:
    try:
        usage = json.loads(task.usage_json) if task.usage_json else None
    except ValueError:
        return None
    return usage if isinstance(usage, dict) else None


def _share(parts: list[float], total: float, digits: int | None) -> list[float]:
    """Divide `total` in the proportions of `parts`, so that the shares add up to it exactly: the rounding
    remainder goes to the last share, and with no proportions at all the whole goes to the last run."""
    if not parts:
        return []
    base = sum(parts)
    shares = [p * total / base for p in parts] if base > 0 else [0.0] * (len(parts) - 1) + [total]
    shares = [round(x, digits) if digits is not None else float(int(x)) for x in shares]
    shares[-1] = round(total - sum(shares[:-1]), digits) if digits is not None else float(total - sum(shares[:-1]))
    return shares


def merge_rows(repo: Repo, task_id: int) -> list[dict]:
    rows = []
    for event in repo.task_events_containing(task_id, MERGE_FRAGMENTS):
        for result, pattern in MERGE_EVENTS:
            match = pattern.match(event["message"])
            if match is None:
                continue
            groups = match.groupdict()
            rows.append({"id": event["id"], "at": event["created_at"], "result": result,
                         "target": groups.get("target"), "detail": groups.get("detail")})
            break
    return rows


def execution_log(repo: Repo, task: Task, now: datetime) -> dict:
    sessions = repo.list_task_sessions(task.id)
    starts = [_moment(s["created_at"]) for s in sessions]
    costs = [0.0] * len(sessions)
    tokens = [0] * len(sessions)
    if sessions:
        for entry in repo.task_usage_entries(task.id):
            i = _run_index(starts, _moment(entry["at"]))
            costs[i] += entry["cost_usd"] or 0.0
            tokens[i] += entry["tokens"] or 0

    # The card's own total wins over the log: the log is the split, the total is the amount
    usage = _task_usage(task)
    priced = task_cost(usage)
    if sessions and priced is not None:
        costs = _share(costs, priced[0], 6)
    total_tokens = usage.get("total_tokens") if usage else None
    if sessions and isinstance(total_tokens, int) and not isinstance(total_tokens, bool):
        tokens = [int(x) for x in _share([float(x) for x in tokens], total_tokens, None)]

    runs = []
    agent_sec = 0.0
    for i, row in enumerate(sessions):
        last = i == len(sessions) - 1
        ended_at = row.get("ended_at")
        active = ended_at is None and last and task.status == TaskStatus.IN_PROGRESS
        if ended_at is None and not active:
            # A row from before the log, or one whose end nothing recorded: it lasted until the next run, or
            # until the task last changed.
            ended_at = sessions[i + 1]["created_at"] if not last else (task.done_at or task.updated_at)
        start = starts[i]
        end = now if active else _moment(ended_at)
        duration = max((end - start).total_seconds(), 0.0) if start and end else None
        agent_sec += duration or 0.0
        runs.append({
            "id": row["id"], "job_id": row["job_id"], "trigger": row.get("trigger"),
            "trigger_detail": row.get("trigger_detail"), "agent_id": row.get("agent_id"),
            "started_at": row["created_at"], "ended_at": None if active else ended_at,
            "outcome": row.get("outcome"), "active": active, "duration_sec": duration,
            "cost_usd": round(costs[i], 6), "tokens": tokens[i],
        })

    checks = [{**row, "ok": bool(row["ok"]), "timed_out": bool(row.get("timed_out"))} for row in repo.list_task_checks(task.id)]
    return {
        "runs": runs,
        "checks": checks,
        "merges": merge_rows(repo, task.id),
        "totals": {"cost_usd": round(sum(costs), 6), "tokens": sum(tokens), "agent_sec": agent_sec},
    }
