"""Limit forecast and per-project usage (orc/forecast.py), the usage journal and its seeding."""
import json
from datetime import datetime, timezone

from orc import forecast
from orc.db import connect, init_schema
from orc.repo import Repo

NOW = 1_800_000_000.0
H = 3600


def _sample(pct, resets_at, measured_at=NOW):
    return {"used_percentage": pct, "resets_at": resets_at, "measured_at": measured_at, "source": "probe"}


def _hist(*points, resets_at):
    return [{"measured_at": at, "used_pct": pct, "resets_at": resets_at} for at, pct in points]


# ---------------------------------------------------------------- window forecast


def test_recent_pace_predicts_hitting_limit_before_reset():
    resets = NOW + 2 * H
    # Over the last hour +30%: at 70% now it reaches 100% in an hour, before the reset
    fc = forecast.window_forecast("five_hour", _sample(70, resets), _hist((NOW - H, 40), resets_at=resets), NOW)
    assert fc["verdict"] == "over"
    assert fc["pace_basis"] == "recent"
    assert fc["pace_pct_per_hour"] == 30
    assert fc["hits_limit_at"] == NOW + H
    assert fc["projected_pct"] == 130
    # To make it: 30% in 2 hours = 15%/h, i.e. half the current pace
    assert fc["safe_pace_pct_per_hour"] == 15
    assert fc["slowdown_to_pct"] == 50


def test_without_history_window_average_is_used():
    resets = NOW + 4 * H  # the window started an hour ago
    fc = forecast.window_forecast("five_hour", _sample(10, resets), [], NOW)
    assert fc["pace_basis"] == "window"
    assert fc["pace_pct_per_hour"] == 10
    assert fc["projected_pct"] == 50
    assert fc["verdict"] == "ok"
    assert fc["hits_limit_at"] is None


def test_idle_recent_pace_is_zero_and_forecast_is_flat():
    resets = NOW + 2 * H
    fc = forecast.window_forecast("five_hour", _sample(60, resets), _hist((NOW - 50 * 60, 60), resets_at=resets), NOW)
    assert fc["pace_pct_per_hour"] == 0
    assert fc["projected_pct"] == 60
    assert fc["verdict"] == "ok"


def test_tight_when_little_left_at_reset():
    resets = NOW + H
    fc = forecast.window_forecast("five_hour", _sample(80, resets), _hist((NOW - H, 70), resets_at=resets), NOW)
    assert fc["projected_pct"] == 90
    assert fc["verdict"] == "tight"


def test_previous_window_samples_are_ignored():
    """A probe from the previous window (90% before the reset) does not make the pace negative and is not mixed in."""
    resets = NOW + 4 * H
    history = _hist((NOW - 40 * 60, 90), resets_at=NOW - 2 * H)
    fc = forecast.window_forecast("five_hour", _sample(5, resets), history, NOW)
    assert fc["pace_basis"] == "window"
    assert fc["pace_pct_per_hour"] == 5


def test_points_before_a_percent_drop_are_another_scale():
    """Subscription upgrade: the same window had 97%, now 8%. Points before the drop were measured against a different
    limit, so we do not compute pace from them; otherwise the forecast would mix two scales."""
    resets = NOW + 2 * 86400
    history = _hist((NOW - 20 * H, 90), (NOW - 12 * H, 97), (NOW - 6 * H, 5), resets_at=resets)
    fc = forecast.window_forecast("seven_day", _sample(8, resets), history, NOW)
    assert fc["pace_basis"] == "recent"
    assert fc["pace_pct_per_hour"] == 0.5  # (8 − 5) over 6 hours, not "minus 89"


def test_too_short_span_is_not_a_pace():
    """Two probes five minutes apart are noise; the window just started, so there is no average either."""
    resets = NOW + 5 * H - 10 * 60
    fc = forecast.window_forecast("five_hour", _sample(3, resets), _hist((NOW - 5 * 60, 1), resets_at=resets), NOW)
    assert fc["verdict"] == "unknown"
    assert fc["pace_pct_per_hour"] is None
    assert fc["used_pct"] == 3


def test_limit_already_hit():
    fc = forecast.window_forecast("five_hour", _sample(100, NOW + H), [], NOW)
    assert fc["verdict"] == "hit"


def test_unknown_limits():
    assert forecast.window_forecast("seven_day", None, [], NOW)["verdict"] == "unknown"
    # The reset time has already passed, so the percentage no longer applies
    assert forecast.window_forecast("five_hour", _sample(50, NOW - 60), [], NOW)["verdict"] == "unknown"


def test_weekly_window_uses_day_lookback():
    resets = NOW + 3 * 86400
    fc = forecast.window_forecast("seven_day", _sample(70, resets), _hist((NOW - 86400, 46), resets_at=resets), NOW)
    assert fc["pace_basis"] == "recent"
    assert fc["pace_pct_per_hour"] == 1
    assert fc["verdict"] == "over"  # 70 + 72 > 100


# ---------------------------------------------------------------- probe history


def test_record_limits_dedupes_same_value(repo):
    resets = NOW + 2 * H
    status = {"available": True, "five_hour": _sample(10, resets, NOW), "seven_day": None}
    assert forecast.record_limits(repo, status, NOW) == 1
    # The same probe again is not newer
    assert forecast.record_limits(repo, status, NOW + 60) == 0
    # The same number a minute later: we do not write the plateau every minute
    status["five_hour"] = _sample(10, resets, NOW + 60)
    assert forecast.record_limits(repo, status, NOW + 60) == 0
    # ...but after ten minutes we write it: a flat stretch is also a pace data point
    status["five_hour"] = _sample(10, resets, NOW + 11 * 60)
    assert forecast.record_limits(repo, status, NOW + 11 * 60) == 1
    status["five_hour"] = _sample(12, resets, NOW + 12 * 60)
    assert forecast.record_limits(repo, status, NOW + 12 * 60) == 1
    assert [s["used_pct"] for s in repo.limit_samples_since("five_hour", 0)] == [10, 10, 12]


def test_record_limits_skips_unavailable(repo):
    assert forecast.record_limits(repo, {"available": False}, NOW) == 0
    assert forecast.record_limits(repo, None, NOW) == 0


# ---------------------------------------------------------------- per-project usage


def _iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat()


def test_project_spend_shares_by_cost_and_picks_fastest(repo):
    a = repo.add_project("alpha", "/tmp/a")
    b = repo.add_project("beta", "/tmp/b")
    projects = {a.id: a, b.id: b}
    entries = [
        # alpha: many tokens long ago, almost free (cache reads)
        {"task_id": 1, "project_id": a.id, "at": _iso(NOW - 3 * H), "tokens": 900_000, "cost_usd": 1.0},
        # beta: fewer tokens, but pricier and right now
        {"task_id": 2, "project_id": b.id, "at": _iso(NOW - 20 * 60), "tokens": 100_000, "cost_usd": 3.0},
    ]
    spend = forecast.project_spend(entries, projects, NOW - H, NOW, remaining_sec=H, used_pct=40.0)
    assert spend["measure"] == "cost"
    rows = {r["project"]: r for r in spend["projects"]}
    assert rows["beta"]["share"] == 0.75 and rows["alpha"]["share"] == 0.25
    # On top: share of the orchestrator's usage × the total percentage spent
    assert rows["beta"]["limit_pct_max"] == 30.0
    assert rows["beta"]["pace_cost_per_hour"] == 3.0
    assert rows["alpha"]["pace_cost_per_hour"] == 0
    assert rows["beta"]["projected_cost_usd"] == 6.0
    assert spend["leader_project_id"] == b.id
    assert [r["project"] for r in spend["projects"]] == ["beta", "alpha"]


def test_project_spend_falls_back_to_tokens_without_prices():
    entries = [
        {"task_id": 1, "project_id": 1, "at": _iso(NOW - 3 * H), "tokens": 300, "cost_usd": 0.0},
        {"task_id": None, "project_id": 2, "at": _iso(NOW - 3 * H), "tokens": 100, "cost_usd": 0.0},
    ]
    spend = forecast.project_spend(entries, {}, NOW - H, NOW, remaining_sec=0, used_pct=None)
    assert spend["measure"] == "tokens"
    rows = {r["project_id"]: r for r in spend["projects"]}
    assert rows[1]["share"] == 0.75 and rows[1]["project"] == "#1"
    assert rows[1]["limit_pct_max"] is None
    # Nobody is spending right now: we suggest slowing down whoever spent more
    assert spend["leader_project_id"] == 1


# ---------------------------------------------------------------- summary and endpoint


def test_build_combines_windows_and_spend(repo):
    p = repo.add_project("alpha", "/tmp/a")
    now = datetime.fromtimestamp(NOW, timezone.utc)
    repo.add_usage_entry(None, p.id, 1000, 0.5, at=_iso(NOW - 30 * 60))
    repo.add_usage_entry(None, p.id, 5000, 2.0, at=_iso(NOW - 6 * H))  # outside the five-hour window
    repo.add_limit_sample("five_hour", NOW - H, 20, NOW + 2 * H)
    status = {"available": True, "stale": False, "updated_at": NOW,
              "five_hour": _sample(50, NOW + 2 * H), "seven_day": _sample(30, NOW + 4 * 86400)}
    out = forecast.build(repo, status, now)
    assert out["available"] is True
    five = out["five_hour"]
    assert five["verdict"] == "over" and five["pace_pct_per_hour"] == 30
    assert five["spend"]["tokens"] == 1000
    week = out["seven_day"]
    assert week["spend"]["tokens"] == 6000
    assert week["spend"]["projects"][0]["project"] == "alpha"


def test_build_without_limits_still_shows_spend(repo):
    p = repo.add_project("alpha", "/tmp/a")
    repo.add_usage_entry(None, p.id, 1000, 0.5, at=_iso(NOW - 30 * 60))
    out = forecast.build(repo, {"available": False}, datetime.fromtimestamp(NOW, timezone.utc))
    assert out["available"] is False
    assert out["five_hour"]["verdict"] == "unknown"
    assert out["five_hour"]["spend"]["tokens"] == 1000


def test_forecast_endpoint(client, dispatcher, project):
    cache = dispatcher.settings.usage_cache_path
    now = datetime.now(timezone.utc).timestamp()
    cache.write_text(json.dumps({
        "updated_at": now,
        "five_hour": {"used_percentage": 42, "resets_at": now + 2 * H, "measured_at": now, "source": "probe"},
        "seven_day": {"used_percentage": 12, "resets_at": now + 3 * 86400, "measured_at": now, "source": "probe"},
    }))
    body = client.get("/api/forecast").json()
    assert body["available"] is True
    assert body["five_hour"]["used_pct"] == 42
    assert body["five_hour"]["verdict"] in {"ok", "tight", "over"}
    assert body["seven_day"]["spend"]["projects"] == []
    # The probe landed in the history
    assert dispatcher.repo.last_limit_sample("five_hour")["used_pct"] == 42


# ---------------------------------------------------------------- usage journal


def test_ledger_is_seeded_from_existing_usage(tmp_path):
    """A database from before the journal: already counted task usage goes into it as one row per task."""
    path = tmp_path / "orc.db"
    conn = connect(path)
    init_schema(conn)
    repo = Repo(conn)
    p = repo.add_project("alpha", "/tmp/a")
    t = repo.add_task(p.id, "A")
    usage = {"total_tokens": 777, "total": {}, "cost_usd": 1.5, "cost_usd_estimated": 1.2,
             "scanned_at": "2026-09-20T10:00:00+00:00"}
    repo.update_task(t.id, usage_json=json.dumps(usage))
    conn.execute("DELETE FROM usage_ledger")
    conn.execute("DELETE FROM settings WHERE key = 'usage_ledger_since'")
    conn.execute("PRAGMA user_version = 1")
    conn.commit()

    init_schema(conn)
    rows = repo.usage_entries_since("2000-01-01")
    assert rows == [{"task_id": t.id, "project_id": p.id, "at": "2026-09-20T10:00:00+00:00",
                     "tokens": 777, "cost_usd": 1.2}]
    assert repo.get_setting("usage_ledger_since") is not None


def test_ledger_survives_task_deletion(repo):
    p = repo.add_project("alpha", "/tmp/a")
    t = repo.add_task(p.id, "A")
    repo.add_usage_entry(t.id, p.id, 10, 0.1)
    repo.delete_task(t.id)
    rows = repo.usage_entries_since("2000-01-01")
    assert rows[0]["task_id"] is None and rows[0]["project_id"] == p.id


def test_dispatcher_logs_usage_increments(repo, dispatcher, project):
    t = repo.add_task(project.id, "A")
    first = {"total_tokens": 100, "cost_usd_estimated": 0.2, "cost_usd": None}
    dispatcher._log_usage_delta(t, None, first)
    second = {"total_tokens": 250, "cost_usd_estimated": 0.5, "cost_usd": None}
    dispatcher._log_usage_delta(t, first, second)
    # A recount without growth writes nothing
    dispatcher._log_usage_delta(t, second, dict(second))
    rows = repo.usage_entries_since("2000-01-01")
    assert [(r["tokens"], r["cost_usd"]) for r in rows] == [(100, 0.2), (150, 0.3)]
    assert all(r["project_id"] == project.id for r in rows)


def test_dispatcher_tick_records_limit_history(repo, dispatcher):
    now = datetime.now(timezone.utc).timestamp()
    dispatcher.settings.usage_cache_path.write_text(json.dumps({
        "updated_at": now,
        "five_hour": {"used_percentage": 7, "resets_at": now + H, "measured_at": now, "source": "statusline"},
    }))
    dispatcher.tick()
    assert repo.last_limit_sample("five_hour")["used_pct"] == 7
    # A second tick right after leaves the history alone: we look once a minute
    dispatcher.settings.usage_cache_path.write_text(json.dumps({
        "updated_at": now + 1,
        "five_hour": {"used_percentage": 9, "resets_at": now + H, "measured_at": now + 1, "source": "statusline"},
    }))
    dispatcher.tick()
    assert repo.last_limit_sample("five_hour")["used_pct"] == 7


def test_old_samples_are_pruned(repo):
    repo.add_limit_sample("five_hour", NOW - 9 * 86400, 5, NOW - 9 * 86400 + H)
    status = {"available": True, "five_hour": _sample(1, NOW + H)}
    forecast.record_limits(repo, status, NOW)
    assert [s["used_pct"] for s in repo.limit_samples_since("five_hour", 0)] == [1]

