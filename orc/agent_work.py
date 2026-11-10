"""One agent's work across all projects: totals, spending and the history of its runs.

The agents page shows who is working right now (orc/api/activity.py); this module answers the other
half of the agent's own page: what the agent has done so far and what it cost. A run is a task or a
chat turn series with this agent. Everything is read from what orc already stores (tasks, chats, their
token aggregates and the spending log), nothing new is recorded.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from orc.analytics import finished_at, model_tokens, parse_ts, parse_usage, task_cost
from orc.models import Chat, Task, TaskStatus
from orc.util import utc_now

DEFAULT_LIMIT = 50
MAX_LIMIT = 500
DAILY_DAYS = 14
LIVE_STATUSES = (TaskStatus.IN_PROGRESS, TaskStatus.VERIFYING, TaskStatus.MERGING)


def _run_usage(raw: str | None) -> tuple[int, float | None, dict[str, int]]:
    """Tokens, dollars (None: no estimate) and tokens per model of one run."""
    usage = parse_usage(raw)
    if usage is None:
        return 0, None, {}
    cost = task_cost(usage)
    tokens = usage.get("total_tokens")
    return (tokens if isinstance(tokens, int) and not isinstance(tokens, bool) else 0,
            cost[0] if cost else None, model_tokens(usage))


def _task_run(task: Task, started_at: str | None) -> dict:
    tokens, cost, models = _run_usage(task.usage_json)
    live = task.status in LIVE_STATUSES
    finished = finished_at(task)
    return {"kind": "task", "id": task.id, "title": task.title, "project_id": task.project_id,
            "status": str(task.status), "live": live, "started_at": started_at or (task.created_at if live else None),
            "finished_at": finished.isoformat() if finished else None, "updated_at": task.updated_at, "tokens": tokens, "cost_usd": cost,
            "models": models, "archived": task.archived_at is not None, "routine_id": task.routine_id}


def _chat_run(chat: Chat) -> dict:
    tokens, cost, models = _run_usage(chat.usage_json)
    return {"kind": "chat", "id": chat.id, "title": chat.title, "project_id": chat.project_id,
            "status": chat.status, "live": chat.status != "idle", "started_at": chat.created_at,
            "finished_at": None, "updated_at": chat.updated_at,
            "tokens": tokens, "cost_usd": cost, "models": models, "archived": False, "routine_id": chat.routine_id}


def _daily(repo, task_ids: set[int], now: datetime) -> list[dict]:
    """Tokens and dollars per calendar day (UTC) over the last two weeks, from the spending log.

    The log has no agent column, and chat turns are recorded without a task, so this covers the agent's
    tasks only; the totals above it include chats.
    """
    first = (now - timedelta(days=DAILY_DAYS - 1)).date()
    days = {(first + timedelta(days=i)).isoformat(): {"day": (first + timedelta(days=i)).isoformat(), "tokens": 0, "cost_usd": 0.0}
            for i in range(DAILY_DAYS)}
    for entry in repo.usage_entries_since(f"{first.isoformat()}T00:00:00"):
        if entry["task_id"] not in task_ids:
            continue
        stamp = parse_ts(entry["at"])
        bucket = days.get(stamp.date().isoformat()) if stamp else None
        if bucket is not None:
            bucket["tokens"] += int(entry["tokens"] or 0)
            bucket["cost_usd"] = round(bucket["cost_usd"] + float(entry["cost_usd"] or 0.0), 6)
    return list(days.values())


def build(repo, agent_id: int, limit: int = DEFAULT_LIMIT, offset: int = 0, now: datetime | None = None) -> dict:
    """The agent's totals and the page `offset`..`offset+limit` of its runs, the newest first."""
    now = now or utc_now()
    starts = repo.first_session_times()
    tasks = [t for t in repo.list_tasks(archived=None) if t.agent_id == agent_id]
    chats = repo.list_chats(agent_id=agent_id)
    runs = [_task_run(t, starts.get(t.id)) for t in tasks] + [_chat_run(c) for c in chats]
    # Live runs first (they are what the page is about), then by the last change.
    runs.sort(key=lambda r: (r["live"], r["updated_at"], r["id"]), reverse=True)

    by_status: dict[str, int] = {}
    for task in tasks:
        by_status[str(task.status)] = by_status.get(str(task.status), 0) + 1
    models: dict[str, int] = {}
    for run in runs:
        for model, count in run["models"].items():
            models[model] = models.get(model, 0) + count
    costs = [r["cost_usd"] for r in runs if r["cost_usd"] is not None]
    busy_ms = 0
    finished_with_time = 0
    for run in runs:
        began, ended = parse_ts(run["started_at"]), parse_ts(run["finished_at"])
        if began and ended and ended >= began:
            busy_ms += int((ended - began).total_seconds() * 1000)
            finished_with_time += 1
    stamps = [s for s in (parse_ts(r["started_at"]) for r in runs) if s]
    limit = max(1, min(limit, MAX_LIMIT))
    offset = max(0, offset)
    for run in runs:
        run.pop("models")  # the breakdown is for the totals; the table needs the tokens only
    return {
        "summary": {
            "tasks_total": len(tasks),
            "tasks_by_status": by_status,
            "tasks_done": by_status.get(str(TaskStatus.DONE), 0),
            "tasks_failed": by_status.get(str(TaskStatus.FAILED), 0),
            "chats_total": len(chats),
            "tokens": sum(r["tokens"] for r in runs),
            "cost_usd": round(sum(costs), 6) if costs else None,
            "models": dict(sorted(models.items(), key=lambda kv: -kv[1])),
            "busy_ms": busy_ms,
            "avg_run_ms": busy_ms // finished_with_time if finished_with_time else None,
            "first_run_at": min(stamps).isoformat() if stamps else None,
        },
        "daily": _daily(repo, {t.id for t in tasks}, now),
        "runs": runs[offset:offset + limit],
        "total_runs": len(runs),
    }
