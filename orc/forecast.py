"""Forecast of Claude account limits and per-project usage within the current windows.

A limit is a percentage of a window (5 hours and a week), not a number of tokens: how much
a percent "costs" is not disclosed by Anthropic. So the forecast is built from the percentages
themselves, while tokens and money are needed for a different question: who spends them.

1. **Limit pace**: the difference between percentage samples over time (the `limit_samples` table,
   written by `record_limits` on every dispatcher tick). A recent segment is used: for the
   five-hour window the last hour, for the weekly one the last day. If there is little history
   (the server has just started) we take the average pace since the window start: the start is
   known as `resets_at` minus the window length, so even a single sample is enough.
2. **Forecast**: a straight line, current percent + pace x time until reset. If the line hits 100%
   before the reset, we name the moment and how much the pace must drop to make it.
3. **Per-project usage**: from the `usage_ledger` journal (task token increments over time) for
   the same window. The share is computed by money at API rates, not by tokens: cache reads give
   the lion's share of tokens almost for free, and they barely eat into the subscription limit
   either. How many percent of the limit a project "ate" nobody knows exactly (the limit is shared
   with the terminal and other clients), but an upper bound can be estimated honestly: the
   project's share of orchestrator spend x the whole percent used. Hence `limit_pct_max`, "at most".

Read-only access through `Repo` and arithmetic only: no HTTP, no polling of Claude.
"""
from __future__ import annotations

from datetime import datetime, timezone

from orc.analytics import parse_ts
from orc.usage import WINDOWS, window_key

# Window length: the window start is derived from it and the reset time.
WINDOW_SEC = {"five_hour": 5 * 3600, "seven_day": 7 * 86400}
# "Recent" pace: how far back to look. For the five-hour window an hour is enough to smooth out
# a single model reply, and short enough to notice that a burst has just started.
PACE_LOOKBACK_SEC = {"five_hour": 3600, "seven_day": 24 * 3600}
# For a segment shorter than this, the difference between samples is noise: one sample of 3% in two minutes gives 90%/h.
MIN_PACE_SPAN_SEC = {"five_hour": 15 * 60, "seven_day": 3 * 3600}
# How far the percent may "roll back" between samples without a limit change: sources round
# differently (a fraction vs whole percents), and a difference of a fraction of a percent is not news.
DROP_TOLERANCE_PCT = 1.0
# More than this by the reset: not at the limit yet, but there is almost no margin.
TIGHT_PCT = 85.0

# How often the dispatcher tick looks at the limits for the sake of history.
RECORD_INTERVAL_SEC = 60
# The same number in the same window is written again no more often than this: a flat plateau is also a fact about pace,
# but not every minute.
SAMPLE_HEARTBEAT_SEC = 10 * 60
# Nobody keeps history older than a week with a margin: the longest window is a week.
KEEP_SAMPLES_SEC = 8 * 86400


def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).replace(microsecond=0).isoformat()


# ---------------------------------------------------------------- sample history


def record_limits(repo, status: dict | None, now: float) -> int:
    """Append samples from a `usage.read` snapshot to the history. Returns how many were written.

    The time the sample was MEASURED is written, not the current time: the snapshot could have sat in the cache for ten minutes, and
    a "now" stamp would stretch the pace over time that did not exist.
    """
    if not status or not status.get("available"):
        return 0
    written = 0
    for key in WINDOWS:
        window = status.get(key)
        if not isinstance(window, dict) or window.get("used_percentage") is None:
            continue
        pct = float(window["used_percentage"])
        resets_at = window.get("resets_at")
        measured = window.get("measured_at")
        measured = float(measured) if isinstance(measured, (int, float)) else now
        last = repo.last_limit_sample(key)
        if last is not None:
            if measured <= last["measured_at"]:
                continue
            same = abs(last["used_pct"] - pct) < 0.05 and window_key(last["resets_at"]) == window_key(resets_at)
            if same and measured - last["measured_at"] < SAMPLE_HEARTBEAT_SEC:
                continue
        repo.add_limit_sample(key, measured, pct, resets_at)
        written += 1
    if written:
        repo.delete_limit_samples_before(now - KEEP_SAMPLES_SEC)
    return written


# ---------------------------------------------------------------- window forecast


def _pace(key: str, points: list[tuple[float, float]], measured: float) -> float | None:
    """Recent pace in percent per second from (time, percent) points. None: nothing to measure from.

    The anchor is the earliest point of the recent segment. If the segment turns out shorter than the minimum,
    we take the last point BEFORE it, but no further than two segments back: otherwise the "recent" pace
    quietly turns into the half-window average.
    """
    lookback = PACE_LOOKBACK_SEC[key]
    earlier = [p for p in points if p[0] < measured]
    recent = [p for p in earlier if p[0] >= measured - lookback]
    anchor = recent[0] if recent else None
    if anchor is None or measured - anchor[0] < MIN_PACE_SPAN_SEC[key]:
        older = [p for p in earlier if measured - 2 * lookback <= p[0] < measured - lookback]
        anchor = older[-1] if older else anchor
    if anchor is None or measured - anchor[0] < MIN_PACE_SPAN_SEC[key]:
        return None
    current = points[-1][1]
    return max(0.0, (current - anchor[1]) / (measured - anchor[0]))


def _since_last_drop(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Points of the window after the last drop in percent.

    Within a window usage only grows, so a drop means one thing: the limit itself changed
    (subscription upgrade), and everything before was measured with a different ruler. A pace of "97% -> 8%"
    is not savings but a different denominator, and these points must not be mixed.
    """
    start = 0
    for i in range(1, len(points)):
        if points[i][1] < points[i - 1][1] - DROP_TOLERANCE_PCT:
            start = i
    return points[start:]


def window_forecast(key: str, current: dict | None, history: list[dict], now: float) -> dict:
    """Forecast for a single limit window.

    `verdict`: `hit` means the limit is already reached; `over` means it will be reached before the reset at the current pace;
    `tight` means we make it, but less than 15% remains by the reset; `ok` means there is margin; `unknown` means
    limits are unknown or the window has just started and there is nothing to measure the pace from.
    """
    out: dict = {
        "used_pct": None, "resets_at": None, "window_start": None, "measured_at": None,
        "pace_pct_per_hour": None, "pace_basis": None, "avg_pct_per_hour": None,
        "projected_pct": None, "hits_limit_at": None, "safe_pace_pct_per_hour": None,
        "slowdown_to_pct": None, "verdict": "unknown",
    }
    if not current or current.get("used_percentage") is None:
        return out
    pct = float(current["used_percentage"])
    resets_at = current.get("resets_at")
    measured = current.get("measured_at")
    measured = min(float(measured), now) if isinstance(measured, (int, float)) else now
    out.update(used_pct=pct, resets_at=resets_at, measured_at=measured)
    if pct >= 100:
        out.update(verdict="hit", projected_pct=100.0, hits_limit_at=measured)
        return out
    if not isinstance(resets_at, (int, float)) or resets_at <= now:
        return out
    start = resets_at - WINDOW_SEC[key]
    out["window_start"] = start

    # Only points of the window itself: a sample from the previous window at 90% before the reset would give a pace of "minus
    # ninety per hour", which by definition is never negative.
    same = window_key(resets_at)
    points = _since_last_drop(sorted(
        [(s["measured_at"], s["used_pct"]) for s in history
         if window_key(s["resets_at"]) == same and start <= s["measured_at"] < measured]
        + [(measured, pct)]
    ))
    elapsed = measured - start
    average = pct / elapsed if elapsed >= MIN_PACE_SPAN_SEC[key] else None
    recent = _pace(key, points, measured)
    pace, basis = (recent, "recent") if recent is not None else (average, "window" if average is not None else None)
    out["avg_pct_per_hour"] = round(average * 3600, 2) if average is not None else None
    left = resets_at - measured
    out["safe_pace_pct_per_hour"] = round((100 - pct) / left * 3600, 2)
    if pace is None:
        return out

    projected = pct + pace * left
    out.update(pace_pct_per_hour=round(pace * 3600, 2), pace_basis=basis, projected_pct=round(min(projected, 999.0), 1))
    if projected >= 100:
        out["verdict"] = "over"
        out["hits_limit_at"] = round(measured + (100 - pct) / pace)
        # The percentage of the current pace to slow down to in order to hit the limit exactly at the reset
        out["slowdown_to_pct"] = round((100 - pct) / left / pace * 100)
    else:
        out["verdict"] = "tight" if projected >= TIGHT_PCT else "ok"
    return out


# ---------------------------------------------------------------- per-project usage


def project_spend(entries: list[dict], projects: dict, pace_since: float, now: float,
                  remaining_sec: float, used_pct: float | None) -> dict:
    """Orchestrator usage per project over the window: tokens, money, share, pace and forecast to the reset.

    `entries` are ledger rows since the window start. Pace uses rows no earlier than `pace_since`.
    """
    rows: dict = {}
    pace_hours = max((now - pace_since) / 3600, 1 / 60)
    for entry in entries:
        pid = entry["project_id"]
        row = rows.setdefault(pid, {"tokens": 0, "cost": 0.0, "recent_tokens": 0, "recent_cost": 0.0, "tasks": set()})
        row["tokens"] += entry["tokens"]
        row["cost"] += entry["cost_usd"]
        if entry["task_id"] is not None:
            row["tasks"].add(entry["task_id"])
        at = parse_ts(entry["at"])
        if at is not None and at.timestamp() >= pace_since:
            row["recent_tokens"] += entry["tokens"]
            row["recent_cost"] += entry["cost_usd"]

    total_tokens = sum(r["tokens"] for r in rows.values())
    total_cost = sum(r["cost"] for r in rows.values())
    # Money is the best measure of weight for the limit; if no task has a price, split by tokens
    by_cost = total_cost > 0
    total = total_cost if by_cost else total_tokens
    remaining_h = max(remaining_sec, 0) / 3600

    out = []
    for pid, row in rows.items():
        project = projects.get(pid)
        share = (row["cost"] if by_cost else row["tokens"]) / total if total > 0 else 0.0
        pace_tokens = row["recent_tokens"] / pace_hours
        pace_cost = row["recent_cost"] / pace_hours
        out.append({
            "project_id": pid,
            "project": project.name if project else (f"#{pid}" if pid is not None else "—"),
            "tasks": len(row["tasks"]),
            "tokens": row["tokens"],
            "cost_usd": round(row["cost"], 4),
            "share": round(share, 4),
            "limit_pct_max": round(share * used_pct, 1) if used_pct is not None else None,
            "pace_tokens_per_hour": round(pace_tokens),
            "pace_cost_per_hour": round(pace_cost, 4),
            "projected_tokens": round(row["tokens"] + pace_tokens * remaining_h),
            "projected_cost_usd": round(row["cost"] + pace_cost * remaining_h, 4),
        })
    out.sort(key=lambda r: (-r["share"], -r["tokens"], r["project"]))
    # Who to slow down: whoever spends fastest NOW; if nobody is spending now, whoever
    # spent the most over the window
    leader = None
    if out:
        pace_key = "pace_cost_per_hour" if by_cost else "pace_tokens_per_hour"
        fastest = max(out, key=lambda r: (r[pace_key], r["share"]))
        leader = fastest["project_id"] if fastest[pace_key] > 0 else out[0]["project_id"]
    return {
        "measure": "cost" if by_cost else "tokens",
        "tokens": total_tokens,
        "cost_usd": round(total_cost, 4),
        "pace_tokens_per_hour": round(sum(r["recent_tokens"] for r in rows.values()) / pace_hours),
        "pace_cost_per_hour": round(sum(r["recent_cost"] for r in rows.values()) / pace_hours, 4),
        "leader_project_id": leader,
        "projects": out,
    }


# ---------------------------------------------------------------- summary


def build(repo, status: dict | None, now: datetime) -> dict:
    """Everything the forecast block on the dashboard shows, in one response."""
    at = now.timestamp()
    projects = {p.id: p for p in repo.list_projects()}
    available = bool(status and status.get("available"))
    result: dict = {
        "generated_at": now.replace(microsecond=0).isoformat(),
        "available": available,
        "stale": bool(status.get("stale")) if available else True,
        "updated_at": status.get("updated_at") if available else None,
        # Until this moment the time breakdown is an estimate (see orc/db.py, _seed_usage_ledger)
        "ledger_since": repo.get_setting("usage_ledger_since"),
        # Windows the account does not have (a plan without a five-hour limit): the dashboard does not draw them
        "absent": list(status.get("absent") or []) if available else [],
    }
    for key in WINDOWS:
        current = status.get(key) if available else None
        history = repo.limit_samples_since(key, at - WINDOW_SEC[key] - PACE_LOOKBACK_SEC[key])
        forecast = window_forecast(key, current, history, at)
        # Without a known window we count usage over its length back: the per-project numbers are useful
        # even when limits do not arrive
        start = forecast["window_start"] if forecast["window_start"] is not None else at - WINDOW_SEC[key]
        resets_at = forecast["resets_at"]
        remaining = resets_at - at if isinstance(resets_at, (int, float)) and resets_at > at else 0.0
        pace_since = max(start, at - PACE_LOOKBACK_SEC[key])
        entries = repo.usage_entries_since(_iso(start))
        forecast["spend_since"] = _iso(start)
        forecast["spend"] = project_spend(entries, projects, pace_since, at, remaining, forecast["used_pct"])
        result[key] = forecast
    return result
