"""Dashboard summary: periods, completion time, breakdowns, money."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from orc import analytics
from orc.models import TaskStatus

NOW = datetime(2026, 9, 20, 12, 0, tzinfo=timezone.utc)


def iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat()


def ago(**kw) -> str:
    return iso(NOW - timedelta(**kw))


def usage_json(total: int, model: str = "claude-opus-5", cost: float | None = None,
               estimated: float | None = None) -> str:
    return json.dumps({
        "total": {"input": total, "cache_creation": 0, "cache_read": 0, "output": 0},
        "total_tokens": total,
        "models": {model: {"input": total, "cache_creation": 0, "cache_read": 0, "output": 0, "messages": 1}},
        "cost_usd": cost,
        "cost_usd_estimated": estimated,
    })


def finish(repo, task, status, at: str, **fields):
    """Bring a task to a terminal status retroactively.

    `update_task` itself overwrites `updated_at` with "now", so the moment is set
    with a direct UPDATE: the test needs a task finished a month ago, not a second ago.
    """
    repo.update_task(task.id, status=status, **fields)
    done_at = at if status == TaskStatus.DONE else None
    repo.conn.execute("UPDATE tasks SET updated_at = ?, done_at = ? WHERE id = ?", (at, done_at, task.id))
    repo.conn.commit()
    return repo.get_task(task.id)


@pytest.fixture
def seeded(repo, project):
    """Three tasks finished within the period, one much earlier, one in progress."""
    fresh = repo.add_task(project.id, "fresh", model="claude-opus-5", effort="high")
    repo.conn.execute("UPDATE tasks SET created_at = ? WHERE id = ?", (ago(days=2), fresh.id))
    repo.add_task_session(fresh.id, "job-1", "sess-1", None)
    repo.conn.execute("UPDATE task_sessions SET created_at = ? WHERE task_id = ?", (ago(days=2), fresh.id))
    finish(repo, fresh, TaskStatus.DONE, ago(days=2, hours=-1), usage_json=usage_json(1000, cost=0.5))

    broken = repo.add_task(project.id, "crashed", model="claude-sonnet-5")
    repo.conn.execute("UPDATE tasks SET created_at = ? WHERE id = ?", (ago(days=3), broken.id))
    finish(repo, broken, TaskStatus.FAILED, ago(days=3, hours=-2), usage_json=usage_json(200, "claude-sonnet-5", estimated=0.1))

    old = repo.add_task(project.id, "ancient")
    repo.conn.execute("UPDATE tasks SET created_at = ? WHERE id = ?", (ago(days=200), old.id))
    finish(repo, old, TaskStatus.DONE, ago(days=199), usage_json=usage_json(9999, cost=99.0))

    running = repo.add_task(project.id, "running", status=TaskStatus.IN_PROGRESS)
    repo.update_task(running.id, blocker="needs_input")
    return {"fresh": fresh, "broken": broken, "old": old, "running": running}


def test_period_cuts_old_tasks(repo, seeded):
    out = analytics.build(repo, days=30, now=NOW)
    assert out["totals"]["finished"] == 2
    assert out["totals"]["done"] == 1
    assert out["totals"]["failed"] == 1
    assert out["totals"]["success_rate"] == 0.5
    # the ancient task with its $99 did not fall into the period
    assert out["totals"]["cost_usd"] == pytest.approx(0.6)


def test_all_time_includes_everything(repo, seeded):
    out = analytics.build(repo, days=0, now=NOW)
    assert out["totals"]["finished"] == 3
    assert out["totals"]["cost_usd"] == pytest.approx(99.6)
    # a period half a year back: the axis is no longer per day
    assert out["period"]["bucket"] == "week"


def test_snapshot_counts_live_tasks(repo, seeded):
    out = analytics.build(repo, days=30, now=NOW)
    assert out["now"]["by_status"]["in_progress"] == 1
    assert out["now"]["in_flight"] == 1
    assert out["now"]["waiting"] == 1
    assert out["now"]["total"] == 4


def test_empty_base_does_not_crash(repo):
    out = analytics.build(repo, days=30, now=NOW)
    assert out["totals"]["finished"] == 0
    assert out["totals"]["success_rate"] is None
    assert out["totals"]["lead_p50_sec"] is None
    assert out["models"] == []
    # the axis is drawn anyway: an empty period is a picture too
    assert len(out["flow"]) == 31


def test_flow_buckets_cover_period_with_zeros(repo, seeded):
    out = analytics.build(repo, days=30, now=NOW)
    assert out["period"]["bucket"] == "day"
    assert len(out["flow"]) == 31
    by_date = {row["date"]: row for row in out["flow"]}
    assert by_date["2026-09-18"]["done"] == 1
    assert by_date["2026-09-17"]["failed"] == 1
    assert by_date["2026-09-01"] == {
        "date": "2026-09-01", "created": 0, "done": 0, "failed": 0, "tokens": 0, "cost_usd": 0.0,
        "by_status": {}, "by_model": {}, "by_project": {},
    }


def test_flow_rows_split_by_status_model_and_project(repo, seeded):
    """The flow bucket carries three cuts of the same sum: the frontend colors the stack by any of them."""
    out = analytics.build(repo, days=30, now=NOW)
    by_date = {row["date"]: row for row in out["flow"]}
    day = by_date["2026-09-18"]
    assert day["tokens"] == 1000
    assert day["cost_usd"] == pytest.approx(0.5)
    assert day["by_status"] == {"done": {"tasks": 1, "tokens": 1000, "cost_usd": 0.5}}
    assert day["by_model"] == {"claude-opus-5": {"tasks": 1, "tokens": 1000, "cost_usd": 0.5}}
    assert list(day["by_project"]) == [out["projects"][0]["key"]]
    assert by_date["2026-09-17"]["by_status"] == {"failed": {"tasks": 1, "tokens": 200, "cost_usd": 0.1}}


def test_model_costs_scale_to_exact_total():
    """The exact session price is one for all models: the shares by rates are scaled to it."""
    usage = {
        "models": {
            "claude-opus-5": {"input": 1_000_000, "cache_creation": 0, "cache_read": 0, "output": 0},   # $5 at the rate
            "claude-sonnet-5": {"input": 1_000_000, "cache_creation": 0, "cache_read": 0, "output": 0},  # $2 at the rate
        },
    }
    shares = analytics.model_costs(usage, 14.0)
    assert shares["claude-opus-5"] == pytest.approx(10.0)
    assert shares["claude-sonnet-5"] == pytest.approx(4.0)
    # no model in the price list: split by tokens
    unknown = {"models": {"m-a": {"input": 300, "cache_creation": 0, "cache_read": 0, "output": 0},
                          "m-b": {"input": 100, "cache_creation": 0, "cache_read": 0, "output": 0}}}
    assert analytics.model_costs(unknown, 4.0) == {"m-a": pytest.approx(3.0), "m-b": pytest.approx(1.0)}
    assert analytics.model_costs(usage, None) == {}


def test_multi_model_task_splits_tokens_by_model_in_flow(repo, project):
    """A task with a subagent on another model splits the bucket tokens between models, while it
    is counted once, under the main model."""
    task = repo.add_task(project.id, "with a subagent")
    usage = json.dumps({
        "total": {"input": 900, "cache_creation": 0, "cache_read": 0, "output": 0},
        "total_tokens": 900,
        "models": {
            "claude-opus-5": {"input": 600, "cache_creation": 0, "cache_read": 0, "output": 0, "messages": 3},
            "claude-haiku-4-5": {"input": 300, "cache_creation": 0, "cache_read": 0, "output": 0, "messages": 9},
        },
        "cost_usd": 1.0,
    })
    finish(repo, task, TaskStatus.DONE, ago(days=1), usage_json=usage)
    row = {r["date"]: r for r in analytics.build(repo, days=30, now=NOW)["flow"]}["2026-09-19"]
    assert row["by_model"]["claude-opus-5"]["tasks"] == 1
    assert row["by_model"]["claude-opus-5"]["tokens"] == 600
    assert row["by_model"]["claude-haiku-4-5"]["tasks"] == 0
    assert row["by_model"]["claude-haiku-4-5"]["tokens"] == 300
    assert sum(c["cost_usd"] for c in row["by_model"].values()) == pytest.approx(1.0)
    # "messages" are not tokens: the main model is chosen by 600 vs 300, not by 3 vs 9
    assert analytics.build(repo, days=30, now=NOW)["models"][0]["key"] == "claude-opus-5"


def test_unset_effort_and_model_resolve_to_project_defaults(repo, git_repo, tmp_path):
    """An empty card field means the project default, and the dashboard shows it, not a dash."""
    proj = repo.add_project("with defaults", str(tmp_path / "defaults"))
    repo.update_project(proj.id, default_effort="high", default_model="claude-sonnet-5",
                        default_permission_mode="acceptEdits")
    task = repo.add_task(proj.id, "no settings")
    finish(repo, task, TaskStatus.DONE, ago(days=1))
    out = analytics.build(repo, project_id=proj.id, days=30, now=NOW)
    assert out["efforts"][0]["key"] == "high"
    assert out["models"][0]["key"] == "claude-sonnet-5"
    assert out["permissions"][0]["key"] == "acceptEdits"
    assert out["top_cost"][0]["model"] == "claude-sonnet-5"
    # and without a default at the project level too, Claude Code itself picks the level: that is a separate row
    repo.update_project(proj.id, default_effort=None)
    assert analytics.build(repo, project_id=proj.id, days=30, now=NOW)["efforts"][0]["key"] == analytics.UNSET


def test_previous_period_totals_for_deltas(repo, seeded, project):
    """Deltas on the tiles: totals of the previous period of the same length; there are none for all time."""
    earlier = repo.add_task(project.id, "previous period")
    repo.conn.execute("UPDATE tasks SET created_at = ? WHERE id = ?", (ago(days=10), earlier.id))
    finish(repo, earlier, TaskStatus.DONE, ago(days=9), usage_json=usage_json(500, cost=0.25))
    out = analytics.build(repo, days=7, now=NOW)
    assert out["totals"]["finished"] == 2
    prev = out["previous"]
    assert prev["finished"] == 1 and prev["done"] == 1 and prev["failed"] == 0
    assert prev["created"] == 1
    assert prev["success_rate"] == 1.0
    assert prev["tokens"] == 500
    assert prev["cost_usd"] == pytest.approx(0.25)
    assert prev["interventions"] == 0
    assert analytics.build(repo, days=0, now=NOW)["previous"] is None


def test_models_split_by_actual_model(repo, seeded):
    out = analytics.build(repo, days=30, now=NOW)
    rows = {r["key"]: r for r in out["models"]}
    assert rows["claude-opus-5"]["done"] == 1
    assert rows["claude-opus-5"]["tokens"] == 1000
    assert rows["claude-sonnet-5"]["failed"] == 1
    assert rows["claude-sonnet-5"]["cost_usd"] == pytest.approx(0.1)


def test_work_time_counts_from_first_session(repo, seeded):
    """Work time counts from the session start, not from creation: lying in the backlog is not our lead time."""
    out = analytics.build(repo, days=30, now=NOW)
    # the fresh task's session started 2 days ago and ended an hour later: an hour of work
    assert out["totals"]["work_p50_sec"] == 3600
    # the lead time is computed over the same tasks: the crashed one had no session, so it is not in the median
    assert out["totals"]["lead_p50_sec"] == 3600
    assert out["durations"]["measured"] == 1
    assert out["durations"]["finished"] == 2
    assert sum(b["count"] for b in out["durations"]["bins"]) == 1


def test_returned_from_done_is_not_finished(repo, project):
    """A card that went back from "Done" to the backlog is ahead of the work again, not behind it."""
    task = repo.add_task(project.id, "sent back")
    finish(repo, task, TaskStatus.DONE, ago(days=1))
    repo.update_task(task.id, status=TaskStatus.BACKLOG)
    out = analytics.build(repo, days=30, now=NOW)
    assert out["totals"]["finished"] == 0


def test_project_scope_filters(repo, seeded, git_repo, tmp_path):
    other = repo.add_project("second", str(tmp_path / "other"))
    task = repo.add_task(other.id, "other")
    finish(repo, task, TaskStatus.DONE, ago(days=1))
    assert analytics.build(repo, days=30, now=NOW)["totals"]["finished"] == 3
    assert analytics.build(repo, project_id=other.id, days=30, now=NOW)["totals"]["finished"] == 1
    assert len(analytics.build(repo, days=30, now=NOW)["projects"]) == 2


def test_interventions_counted(repo, project, seeded):
    task = seeded["running"]
    repo.add_input_request(task.id, "question", "AskUserQuestion", "{}", "what to do?")
    request = repo.open_input_request(task.id)
    repo.conn.execute("UPDATE input_requests SET created_at = ?, answered_at = ? WHERE id = ?",
                      (ago(days=1), ago(days=1, minutes=-5), request["id"]))
    repo.conn.commit()
    out = analytics.build(repo, days=30, now=NOW)
    assert out["totals"]["interventions"] == 1
    assert out["totals"]["interventions_by_kind"] == {"question": 1}
    assert out["totals"]["answer_wait_p50_sec"] == 300


def test_top_cost_sorted(repo, seeded):
    out = analytics.build(repo, days=0, now=NOW)
    assert [r["cost_usd"] for r in out["top_cost"]] == [99.0, 0.5, 0.1]
    assert out["top_cost"][0]["title"] == "ancient"


def test_backfilled_session_after_finish_is_not_a_duration(repo, project):
    """A session recorded after completion (journal backfill) is not an "instant task"."""
    task = repo.add_task(project.id, "old")
    repo.add_task_session(task.id, "job-x", "sess-x", None)
    finish(repo, task, TaskStatus.DONE, ago(days=5))
    repo.conn.execute("UPDATE task_sessions SET created_at = ? WHERE task_id = ?", (ago(days=1), task.id))
    repo.conn.commit()
    out = analytics.build(repo, days=30, now=NOW)
    assert out["totals"]["finished"] == 1
    assert out["totals"]["work_p50_sec"] is None
    assert out["durations"]["measured"] == 0
    # and the negative median does not leak into the per-model breakdown either
    assert out["models"][0]["median_sec"] is None


def test_broken_usage_json_is_ignored(repo, project):
    task = repo.add_task(project.id, "broken usage")
    finish(repo, task, TaskStatus.DONE, ago(days=1), usage_json="{not json")
    out = analytics.build(repo, days=30, now=NOW)
    assert out["totals"]["tokens"] == 0
    assert out["totals"]["cost_known_tasks"] == 0


def test_api_returns_summary(client, repo, project, seeded, monkeypatch):
    # The endpoint counts the window from "now" while the data is seeded from NOW: without the patch the test went red
    # as soon as the real date drifted from NOW by more than the window.
    monkeypatch.setattr(analytics, "utc_now", lambda: NOW)
    body = client.get("/api/analytics?days=30").json()
    assert body["totals"]["finished"] == 2
    assert body["scope"]["project_id"] is None
    scoped = client.get(f"/api/analytics?days=30&project_id={project.id}").json()
    assert scoped["scope"]["project"] == project.name


def test_api_rejects_odd_period(client):
    assert client.get("/api/analytics?days=13").status_code == 400


def test_api_404_on_unknown_project(client):
    assert client.get("/api/analytics?project_id=999").status_code == 404


@pytest.mark.parametrize("span,expected", [(10, "day"), (45, "day"), (90, "week"), (400, "month")])
def test_bucket_picked_by_span(span, expected):
    assert analytics.pick_bucket(span) == expected


def test_percentile_interpolates():
    assert analytics.percentile([], 0.5) is None
    assert analytics.percentile([5], 0.9) == 5
    assert analytics.percentile([0, 10], 0.5) == 5
    assert analytics.percentile([0, 10, 20, 30], 0.9) == 27


def test_task_cost_trusts_claude_code_only_for_single_session_tasks():
    """cost-state is not written in every session, and a resume carries someone else's running total: for
    multi-session tasks the "exact" price diverged from the tokens several times over. There we use our own."""
    from orc.analytics import task_cost

    one = {"cost_usd": 3.0, "cost_usd_estimated": 2.9, "sessions": [{"session_id": "a"}]}
    many = {"cost_usd": 3.0, "cost_usd_estimated": 7.5, "sessions": [{"session_id": "a"}, {"session_id": "b"}]}
    assert task_cost(one) == (3.0, True)
    assert task_cost(many) == (7.5, False)
