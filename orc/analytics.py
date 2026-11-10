"""Task summary for the dashboard: flow, time, money, models, modes.

Computed on the fly from what already lives in the database: there is no separate metrics
table and none is needed. The orchestrator has hundreds of tasks, not millions, and one pass
over them is cheaper than an event log that would have to be kept consistent with the
dispatcher.

Three things explain why the module is built this way:

1. **There is no "finished" moment in the schema.** `done_at` is written only on the
   transition to `done` (see `Dispatcher._finish` and `merging.py`); a failure has none at
   all. So the completion time of a failed task is its `updated_at`, the last write to it.
   This is an approximation: if a human edited the failed card afterwards, the moment shifts
   forward.
2. **Status history is not stored.** A real CFD (cumulative flow by stage) cannot be built,
   and drawing one from guesses would be lying. Instead there is an honest "created vs.
   completed" pair per day: the same conclusions about bottlenecks, from the data we have.
3. **A task has two different durations.** "Lead time" (`created_at` -> completion) includes
   time spent in the backlog and speaks to deadlines; "work time" (first `task_sessions` row
   -> completion) says how long the agent actually worked. Both are computed: without the
   first the queue is invisible, without the second the cost of a task in time is invisible.

Read-only access through `Repo` plus arithmetic: no HTTP, no dispatcher.
"""
from __future__ import annotations

import json
from collections import Counter
from datetime import date, datetime, timedelta, timezone

from orc.agents import resolve_params
from orc.models import Agent, Project, Task, TaskStatus
from orc.token_usage import CACHE_1H_KEY, COUNTER_KEYS, _model_cost_usd
from orc.util import utc_now

# Periods understood by the endpoint. 0 means all time.
ALLOWED_DAYS = (7, 30, 90, 365, 0)

# Active statuses: the task occupies a worker and moves on its own.
IN_FLIGHT = (TaskStatus.IN_PROGRESS, TaskStatus.VERIFYING, TaskStatus.MERGING)
# Finished: they will not move further without a human.
TERMINAL = (TaskStatus.DONE, TaskStatus.FAILED)

# Duration buckets. Bounds are in seconds; the last one has an upper bound of `None` ("and more").
# The scale is logarithmic in spirit: the difference between 3 and 8 minutes matters more than between 3 and 4 hours.
DURATION_BINS: tuple[tuple[str, int, int | None], ...] = (
    ("< 5 min", 0, 300),
    ("5–15 min", 300, 900),
    ("15–30 min", 900, 1800),
    ("30–60 min", 1800, 3600),
    ("1–2 h", 3600, 7200),
    ("2–4 h", 7200, 14400),
    ("> 4 h", 14400, None),
)

# How many rows to return in the "most expensive" table
TOP_COST_LIMIT = 8

UNSET = "—"  # model/mode not chosen on the card: the project default applies


def parse_ts(raw: str | None) -> datetime | None:
    """A moment from the database. Anything that cannot be parsed means "no moment": the dashboard
    is no place to crash over one bad row that got into the column by hand or from an old version."""
    if not raw:
        return None
    try:
        stamp = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)


def finished_at(task: Task) -> datetime | None:
    """When the task came to rest for good in a terminal status. None means it is still moving.

    The CURRENT status is what counts, not the presence of `done_at`: a card returned from "Done"
    to the backlog cannot be considered finished, since its work lies ahead again.
    """
    if task.status == TaskStatus.DONE:
        return parse_ts(task.done_at) or parse_ts(task.updated_at)
    if task.status == TaskStatus.FAILED:
        return parse_ts(task.updated_at)
    return None


def percentile(values: list[float], q: float) -> float | None:
    """Percentile with linear interpolation. An empty list gives None, not zero:
    "median of 0 seconds" and "nothing to measure" look the same on a tile but mean different things."""
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    pos = (len(ordered) - 1) * q
    low = int(pos)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (pos - low)


def _round(value: float | None, digits: int = 0) -> float | None:
    if value is None:
        return None
    return round(value, digits) if digits else float(round(value))


def parse_usage(raw: str | None) -> dict | None:
    """Parse `tasks.usage_json` (format: orc/token_usage.py). A foreign format is treated as not counted."""
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(data, dict) or not isinstance(data.get("total_tokens"), int):
        return None
    return data


def task_cost(usage: dict | None) -> tuple[float, bool] | None:
    """Best dollar estimate: the exact one from Claude Code, otherwise our own from the price list. None if neither.

    The exact price is trusted only for single-session tasks. `cost-state` is not written in every
    session, and a resume may carry the running total of previous sessions, so for multi-session
    tasks the sum diverged from the tokens by large factors in both directions. Our own estimate
    was checked against the Claude Code price to the cent on single-session tasks, so where the
    "exact" one is doubtful, ours is the more honest.
    """
    if usage is None:
        return None
    exact = usage.get("cost_usd")
    sessions = usage.get("sessions")
    single = not isinstance(sessions, list) or len(sessions) <= 1
    if single and isinstance(exact, (int, float)) and not isinstance(exact, bool):
        return float(exact), True
    approx = usage.get("cost_usd_estimated")
    if isinstance(approx, (int, float)) and not isinstance(approx, bool):
        return float(approx), False
    return None


def model_tokens(usage: dict | None) -> dict[str, int]:
    """Task tokens per model from the transcript breakdown: {model: sum of counters}.

    Only the four token counters are summed (orc/token_usage.py COUNTER_KEYS): the same
    record also holds a message count, which has nothing to do with tokens. Models with zero
    tokens are dropped: there should be no service entries in the breakdown, but a foreign format happens.
    """
    models = usage.get("models") if usage else None
    if not isinstance(models, dict):
        return {}
    out: dict[str, int] = {}
    for model, counters in models.items():
        if not isinstance(model, str) or not isinstance(counters, dict):
            continue
        total = sum(v for k, v in counters.items() if k in COUNTER_KEYS and isinstance(v, int) and not isinstance(v, bool))
        if total > 0:
            out[model] = total
    return out


def model_costs(usage: dict | None, amount: float | None) -> dict[str, float]:
    """Task cost per model: {model: dollars}, summing to exactly `amount`.

    Claude Code reports the exact price as a single number per session, without a breakdown, so
    model shares are computed from our own price list (orc/token_usage.py) and scaled to match
    the total: otherwise the sum of the per-model bars would not match the "spent" tile. Models
    outside the price list split the remainder by tokens: this is rougher, but more honest than zero.
    """
    if amount is None or amount <= 0:
        return {}
    models = usage.get("models") if usage else None
    tokens = model_tokens(usage)
    if not tokens or not isinstance(models, dict):
        return {}
    priced: dict[str, float] = {}
    for model in tokens:
        counters = models[model]
        try:
            prices = {k: int(counters.get(k, 0) or 0) for k in COUNTER_KEYS}
            if CACHE_1H_KEY in counters:
                prices[CACHE_1H_KEY] = int(counters[CACHE_1H_KEY] or 0)
            cost = _model_cost_usd(model, prices)
        except (TypeError, ValueError):
            cost = None
        if cost is not None:
            priced[model] = cost
    if priced:
        scale = amount / sum(priced.values()) if sum(priced.values()) > 0 else 0.0
        shares = {model: cost * scale for model, cost in priced.items()}
        # Models without a price get zero: the scaled sum of the priced ones already equals the total
        return {model: shares.get(model, 0.0) for model in tokens}
    total_tokens = sum(tokens.values())
    return {model: amount * count / total_tokens for model, count in tokens.items()}


def main_model(task: Task, usage: dict | None, project: Project | None = None, agent: Agent | None = None) -> str:
    """The model of the task as actually used, not as configured.

    The transcript shows which model really answered, and the session may have changed to a resume.
    We take the "heaviest" one by tokens from the breakdown; if there is no breakdown, the agent's
    model remains, and after it the project default: that is exactly what the launch passed to
    `claude --model` (orc/sessions.py). The card itself holds no model.
    """
    tokens = model_tokens(usage)
    if tokens:
        return max(tokens.items(), key=lambda kv: kv[1])[0]
    return resolve_params(task, agent, project).model or UNSET


def effective_effort(task: Task, project: Project | None, agent: Agent | None = None) -> str:
    """The effort level the task was actually launched with: the agent's, otherwise the project's.

    If it is set in neither, `--effort` is not passed to the launch at all and Claude Code itself
    picks the level; the dashboard labels this separately (`UNSET`), because substituting a
    concrete value here would be a guess. The project default is taken as it is now: if it
    was changed after the launch, old tasks will be attributed to the new value.
    """
    return resolve_params(task, agent, project).effort or UNSET


def effective_permission(task: Task, project: Project | None, agent: Agent | None = None) -> str:
    """Session access mode: the agent's, otherwise the project's (the project always has one)."""
    return resolve_params(task, agent, project).permission_mode or UNSET


# ---------- time buckets ----------

def pick_bucket(span_days: float) -> str:
    """Time axis step for the period length: a day while there are fewer than fifty bars."""
    if span_days <= 45:
        return "day"
    if span_days <= 200:
        return "week"
    return "month"


def bucket_key(stamp: datetime, bucket: str) -> str:
    day = stamp.astimezone(timezone.utc).date()
    if bucket == "day":
        return day.isoformat()
    if bucket == "week":
        return (day - timedelta(days=day.weekday())).isoformat()
    return day.replace(day=1).isoformat()


def bucket_range(start: datetime, end: datetime, bucket: str) -> list[str]:
    """All buckets of the period in order, including empty ones: a dip in the flow is a fact too,
    and a skipped bar must be visible as zero, not as a compressed axis."""
    keys: list[str] = []
    cursor = date.fromisoformat(bucket_key(start, bucket))
    last = bucket_key(end, bucket)
    guard = 0
    while guard < 2000:
        keys.append(cursor.isoformat())
        if cursor.isoformat() == last:
            break
        if bucket == "day":
            cursor += timedelta(days=1)
        elif bucket == "week":
            cursor += timedelta(days=7)
        else:
            cursor = (cursor.replace(day=28) + timedelta(days=4)).replace(day=1)
        guard += 1
    return keys


# ---------- summary ----------

class _Bucket:
    """Accumulator for one breakdown row (model, mode, project)."""

    __slots__ = ("tasks", "done", "failed", "tokens", "cost", "durations")

    def __init__(self) -> None:
        self.tasks = 0
        self.done = 0
        self.failed = 0
        self.tokens = 0
        self.cost = 0.0
        self.durations: list[float] = []

    def add(self, task: Task, tokens: int, cost: float | None, duration: float | None) -> None:
        self.tasks += 1
        if task.status == TaskStatus.DONE:
            self.done += 1
        else:
            self.failed += 1
        self.tokens += tokens
        if cost is not None:
            self.cost += cost
        if duration is not None:
            self.durations.append(duration)

    def asdict(self, key: str) -> dict:
        return {
            "key": key,
            "tasks": self.tasks,
            "done": self.done,
            "failed": self.failed,
            "tokens": self.tokens,
            "cost_usd": round(self.cost, 4),
            "median_sec": _round(percentile(self.durations, 0.5)),
        }


def _sorted_rows(buckets: dict[str, _Bucket]) -> list[dict]:
    """Breakdown rows from larger to smaller by task count, ties broken by name."""
    return [b.asdict(k) for k, b in sorted(buckets.items(), key=lambda kv: (-kv[1].tasks, kv[0]))]


# Bucket slices of the flow: the frontend colors the bar stack by them. Keys inside are status,
# model and project; the value is {tasks, tokens, cost_usd}.
FLOW_SPLITS = ("by_status", "by_model", "by_project")


def _flow_row(key: str) -> dict:
    return {"date": key, "created": 0, "done": 0, "failed": 0, "tokens": 0, "cost_usd": 0.0,
            **{split: {} for split in FLOW_SPLITS}}


def _finish_flow_row(row: dict) -> dict:
    """Money in a bucket is rounded on output, not during accumulation, so as not to accumulate error."""
    row["cost_usd"] = round(row["cost_usd"], 4)
    for split in FLOW_SPLITS:
        for cell in row[split].values():
            cell["cost_usd"] = round(cell["cost_usd"], 4)
    return row


def _previous_totals(tasks: list[Task], starts: dict, prev_start: datetime, start: datetime,
                     interventions: int) -> dict:
    """Totals of the previous period of the same length: for the deltas on the tiles ("got better or worse").

    Less is computed than for the current period, only what is on the tiles: breakdowns
    and tables for the previous period are never compared row by row.
    """
    created = done = failed = tokens = 0
    cost = 0.0
    work_times: list[float] = []
    for task in tasks:
        stamp = parse_ts(task.created_at)
        if stamp is not None and prev_start <= stamp < start:
            created += 1
        end = finished_at(task)
        if end is None or end < prev_start or end >= start:
            continue
        if task.status == TaskStatus.DONE:
            done += 1
        else:
            failed += 1
        usage = parse_usage(task.usage_json)
        tokens += usage["total_tokens"] if usage else 0
        task_amount = task_cost(usage)
        if task_amount is not None:
            cost += task_amount[0]
        started = parse_ts(starts.get(task.id))
        work = (end - started).total_seconds() if started else None
        if work is not None and work >= 0:
            work_times.append(work)
    finished = done + failed
    return {
        "created": created,
        "finished": finished,
        "done": done,
        "failed": failed,
        "success_rate": round(done / finished, 4) if finished else None,
        "tokens": tokens,
        "cost_usd": round(cost, 4),
        "work_p50_sec": _round(percentile(work_times, 0.5)),
        "interventions": interventions,
    }


def build(repo, project_id: int | None = None, days: int = 30, now: datetime | None = None) -> dict:
    """Everything the dashboard shows, in one response.

    `project_id=None` is a slice across all projects (including archived ones: real money was
    spent on them, and hiding them from the total would understate spending). `days=0` is all time.
    """
    now = now or utc_now()
    tasks = repo.list_tasks(project_id=project_id, archived=None)
    projects = {p.id: p for p in repo.list_projects()}
    agents_by_id = {a.id: a for a in repo.list_agents()}
    starts = repo.first_session_times()

    created_stamps = [s for s in (parse_ts(t.created_at) for t in tasks) if s is not None]
    if days > 0:
        start = now - timedelta(days=days)
    else:
        start = min(created_stamps) if created_stamps else now
    span_days = max((now - start).total_seconds() / 86400, 1.0)
    bucket = pick_bucket(span_days)

    # ---- current slice: it is about "what is happening", not "what was", and is not cut by the period
    live = [t for t in tasks if t.archived_at is None]
    by_status = Counter(t.status for t in live)
    snapshot = {
        "by_status": {s.value: by_status.get(s.value, 0) for s in TaskStatus},
        "total": len(live),
        "archived": len(tasks) - len(live),
        "in_flight": sum(by_status.get(s.value, 0) for s in IN_FLIGHT),
        "waiting": sum(1 for t in live if t.blocker == "needs_input"),
        "blocked": sum(1 for t in live if t.blocker is not None and t.blocker != "quota"),
        "queued": by_status.get(TaskStatus.TODO.value, 0),
    }

    # ---- flow by buckets: finished tasks, their tokens and money, in three slices
    # (status, model, project); the frontend draws bar stacks from them and colors by the chosen one
    flow = {key: _flow_row(key) for key in bucket_range(start, now, bucket)}

    def bump(stamp: datetime, field: str) -> None:
        row = flow.get(bucket_key(stamp, bucket))
        if row is not None:
            row[field] += 1

    def bump_split(stamp: datetime, split: str, key: str, tasks_n: int, tokens_n: int, cost_n: float) -> None:
        row = flow.get(bucket_key(stamp, bucket))
        if row is None:
            return
        cell = row[split].setdefault(key, {"tasks": 0, "tokens": 0, "cost_usd": 0.0})
        cell["tasks"] += tasks_n
        cell["tokens"] += tokens_n
        cell["cost_usd"] += cost_n

    created_in_period = 0
    for task in tasks:
        stamp = parse_ts(task.created_at)
        if stamp is not None and stamp >= start:
            created_in_period += 1
            bump(stamp, "created")

    # ---- finished within the period: money, time and all breakdowns rest on them
    lead_times: list[float] = []
    work_times: list[float] = []
    duration_counts = [0] * len(DURATION_BINS)
    models: dict[str, _Bucket] = {}
    efforts: dict[str, _Bucket] = {}
    permissions: dict[str, _Bucket] = {}
    per_project: dict[str, _Bucket] = {}
    cost_total = 0.0
    cost_exact_tasks = 0
    cost_known_tasks = 0
    tokens_total = 0
    done_count = 0
    failed_count = 0
    retries = {"resume": 0, "quota": 0, "conflict": 0}
    top: list[dict] = []

    for task in tasks:
        end = finished_at(task)
        if end is None or end < start:
            continue
        bump(end, "done" if task.status == TaskStatus.DONE else "failed")
        if task.status == TaskStatus.DONE:
            done_count += 1
        else:
            failed_count += 1

        # Both times are computed over ONE set of tasks: those that had a session.
        # Otherwise the sets differ: a card closed by hand without a single launch gives a lead
        # time of a couple of minutes and no work time, and on the tile "median work 19 min ·
        # lead time 11 min" looks like a counting error. For a task with a session the lead time is by
        # definition no less than the work time (the session starts after creation), and the numbers read as a pair.
        created = parse_ts(task.created_at)
        started = parse_ts(starts.get(task.id))
        work = (end - started).total_seconds() if started else None
        # Negative time is not an "instant task" but a session record created LATER than
        # completion: the task_sessions log did not exist from the first release, and for old
        # tasks it was filled in by a backfill (Repo.tasks_without_sessions) at backfill time.
        # There is nothing to measure from such a mark, so the task simply drops out of the time statistics.
        if work is not None and work < 0:
            work = None
        lead = (end - created).total_seconds() if created and work is not None else None
        if work is not None:
            work_times.append(work)
            if lead is not None and lead >= 0:
                lead_times.append(lead)
            for i, (_label, low, high) in enumerate(DURATION_BINS):
                if work >= low and (high is None or work < high):
                    duration_counts[i] += 1
                    break

        usage = parse_usage(task.usage_json)
        tokens = usage["total_tokens"] if usage else 0
        tokens_total += tokens
        cost = task_cost(usage)
        if cost is not None:
            cost_total += cost[0]
            cost_known_tasks += 1
            cost_exact_tasks += 1 if cost[1] else 0
        amount = cost[0] if cost else None

        retries["resume"] += task.auto_resume_count
        retries["quota"] += task.quota_retry_count
        retries["conflict"] += task.conflict_retry_count

        project = projects.get(task.project_id)
        project_name = project.name if project else f"#{task.project_id}"
        agent = agents_by_id.get(task.agent_id) if task.agent_id else None
        model = main_model(task, usage, project, agent)
        models.setdefault(model, _Bucket()).add(task, tokens, amount, work)
        efforts.setdefault(effective_effort(task, project, agent), _Bucket()).add(task, tokens, amount, work)
        permissions.setdefault(effective_permission(task, project, agent), _Bucket()).add(task, tokens, amount, work)
        per_project.setdefault(project_name, _Bucket()).add(task, tokens, amount, work)

        row = flow.get(bucket_key(end, bucket))
        if row is not None:
            row["tokens"] += tokens
            row["cost_usd"] += amount or 0.0
        bump_split(end, "by_status", task.status, 1, tokens, amount or 0.0)
        bump_split(end, "by_project", project_name, 1, tokens, amount or 0.0)
        # A task is split into shares by model: tokens from the transcript breakdown, money
        # proportionally to it (see model_costs); the task itself as a whole goes to the main model
        per_model_tokens = model_tokens(usage) or {model: tokens}
        per_model_cost = model_costs(usage, amount) or ({model: amount} if amount else {})
        for name, count in per_model_tokens.items():
            bump_split(end, "by_model", name, 1 if name == model else 0, count, per_model_cost.get(name, 0.0))

        top.append({
            "id": task.id,
            "title": task.title,
            "status": task.status,
            "project": projects[task.project_id].name if task.project_id in projects else None,
            "model": model,
            "tokens": tokens,
            "cost_usd": round(amount, 4) if amount is not None else None,
            "work_sec": _round(work),
            "finished_at": end.isoformat(),
        })

    top.sort(key=lambda r: (r["cost_usd"] is None, -(r["cost_usd"] or 0), -r["tokens"]))

    # ---- input requests: how many times the agent called the human and how long the human took
    since_iso = start.isoformat()
    requests = repo.input_requests_since(since_iso, project_id=project_id)
    waits = [w for w in ((parse_ts(r["answered_at"]) - parse_ts(r["created_at"])).total_seconds()
                         for r in requests
                         if parse_ts(r["answered_at"]) and parse_ts(r["created_at"]))
             if w >= 0]
    by_kind = Counter(r["kind"] for r in requests)

    # ---- previous period of the same length: deltas on the tiles. There is nothing to compare "all time" with
    previous = None
    if days > 0:
        prev_start = start - timedelta(days=days)
        prev_requests = [r for r in repo.input_requests_since(prev_start.isoformat(), project_id=project_id)
                         if (parse_ts(r["created_at"]) or start) < start]
        previous = _previous_totals(tasks, starts, prev_start, start, len(prev_requests))

    finished = done_count + failed_count
    return {
        "generated_at": now.replace(microsecond=0).isoformat(),
        "period": {
            "days": days,
            "from": start.replace(microsecond=0).isoformat(),
            "to": now.replace(microsecond=0).isoformat(),
            "bucket": bucket,
        },
        "scope": {"project_id": project_id, "project": projects[project_id].name if project_id in projects else None},
        "totals": {
            "created": created_in_period,
            "finished": finished,
            "done": done_count,
            "failed": failed_count,
            # None, not 0: "none finished" and "all failed" are different news
            "success_rate": round(done_count / finished, 4) if finished else None,
            "tokens": tokens_total,
            "cost_usd": round(cost_total, 4),
            "cost_known_tasks": cost_known_tasks,
            "cost_exact_tasks": cost_exact_tasks,
            # Lead time and work time are computed over tasks that had a session (see above)
            "lead_p50_sec": _round(percentile(lead_times, 0.5)),
            "lead_p90_sec": _round(percentile(lead_times, 0.9)),
            "work_p50_sec": _round(percentile(work_times, 0.5)),
            "work_p90_sec": _round(percentile(work_times, 0.9)),
            "retries": retries,
            "interventions": len(requests),
            "interventions_by_kind": {k: by_kind.get(k, 0) for k in ("permission", "question", "plan") if by_kind.get(k)},
            "answer_wait_p50_sec": _round(percentile(waits, 0.5)),
        },
        "previous": previous,
        "now": snapshot,
        "flow": [_finish_flow_row(row) for row in flow.values()],
        # measured: how many of the finished tasks it was possible to measure time for at all:
        # the rest had no session or its mark is useless (see above)
        "durations": {
            "measured": len(work_times),
            "finished": finished,
            "bins": [
                {"label": label, "from_sec": low, "to_sec": high, "count": count}
                for (label, low, high), count in zip(DURATION_BINS, duration_counts)
            ],
        },
        "models": _sorted_rows(models),
        "efforts": _sorted_rows(efforts),
        "permissions": _sorted_rows(permissions),
        "projects": _sorted_rows(per_project),
        "top_cost": top[:TOP_COST_LIMIT],
    }
