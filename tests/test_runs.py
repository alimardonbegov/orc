"""The card's execution log: each way a session starts records its trigger, runs end with an outcome, the
cost of the runs adds up to the task's spending, checks keep their output, merges come from the events."""
import json
from datetime import datetime, timedelta, timezone

import pytest

from orc import git_ops, handoff, runs
from orc.models import TaskStatus
from orc.sessions import OUTCOMES, TRIGGERS


def _started(repo, dispatcher, project, **fields):
    t = repo.add_task(project.id, "A", status="todo", **fields)
    dispatcher._start_ready()
    return repo.get_task(t.id)


def _runs(repo, task_id):
    return repo.list_task_sessions(task_id)


def _log(repo, task_id):
    return runs.execution_log(repo, repo.get_task(task_id), datetime.now(timezone.utc))


def _handed_in(repo, dispatcher, t):
    """The session called `orc task done` and its turn is over. The daemon confirms stops, so a wake goes through."""
    dispatcher.cli.stop_marks_stopped = True
    handoff.record(repo, t.id, handoff.STATUS_DONE, "done")
    dispatcher._session_done(repo.get_task(t.id))
    return repo.get_task(t.id)


def test_start_records_trigger_and_agent(repo, dispatcher, project):
    agent = repo.add_agent("Ann")
    t = _started(repo, dispatcher, project, agent_id=agent.id)
    [run] = _runs(repo, t.id)
    assert run["trigger"] == "start" and run["agent_id"] == agent.id
    assert run["ended_at"] is None and run["outcome"] is None
    [row] = _log(repo, t.id)["runs"]
    assert row["active"] is True and row["ended_at"] is None


def test_unknown_trigger_is_refused(repo, dispatcher, project):
    t = _started(repo, dispatcher, project)
    with pytest.raises(ValueError):
        dispatcher.sessions.wake(t, "x", trigger="guess")


def test_handoff_ends_the_run_and_rework_starts_one(repo, dispatcher, fake_cli, project):
    t = _started(repo, dispatcher, project)
    t = _handed_in(repo, dispatcher, t)
    assert _runs(repo, t.id)[0]["outcome"] == "handed_in"
    repo.update_task(t.id, status=TaskStatus.DONE)
    dispatcher.rework(t.id, "one more thing")
    dispatcher._start_ready()
    first, second = _runs(repo, t.id)
    assert first["outcome"] == "handed_in"
    assert second["trigger"] == "rework" and second["ended_at"] is None


def test_crash_ends_the_run_as_failed_and_resumes(repo, dispatcher, fake_cli, project):
    t = _started(repo, dispatcher, project)
    fake_cli.set_state(t.job_id, "failed", detail="boom")
    dispatcher._sync_running()
    first, second = _runs(repo, t.id)
    assert first["outcome"] == "failed" and first["ended_at"] is not None
    assert second["trigger"] == "crash"


def test_owner_resume_of_a_failed_task(repo, dispatcher, fake_cli, project):
    t = _started(repo, dispatcher, project)
    fake_cli.stop_marks_stopped = True
    dispatcher.stop_session(t.id)
    assert _runs(repo, t.id)[0]["outcome"] == "stopped"
    dispatcher.resume_failed(t.id, "go on")
    assert _runs(repo, t.id)[-1]["trigger"] == "resume"


def test_quota_ends_the_run_and_the_retry_starts_one(repo, dispatcher, fake_cli, project):
    now = [datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)]
    dispatcher.now = lambda: now[0]
    t = _started(repo, dispatcher, project)
    fake_cli.set_state(t.job_id, "failed", detail="You've hit your usage limit")
    dispatcher._sync_running()
    [run] = _runs(repo, t.id)
    assert run["outcome"] == "quota"
    now[0] += timedelta(hours=3)
    dispatcher._retry_quota()
    assert _runs(repo, t.id)[-1]["trigger"] == "quota"


def test_failed_check_is_kept_and_wakes_the_session(repo, dispatcher, fake_cli, project, client):
    repo.update_project(project.id, verify_cmd="echo FAIL_MARKER; exit 1")
    t = _started(repo, dispatcher, project)
    _handed_in(repo, dispatcher, t)
    dispatcher._process_verifying()
    dispatcher.verify_pool.wait(10)
    dispatcher._process_verifying()
    first, second = _runs(repo, t.id)
    assert first["outcome"] == "handed_in" and second["trigger"] == "verify_failed"
    body = client.get(f"/api/tasks/{t.id}/runs").json()
    [check] = body["checks"]
    assert check["ok"] is False and "FAIL_MARKER" in check["output_tail"]
    assert check["cmd"] == "echo FAIL_MARKER; exit 1" and check["job_id"] == first["job_id"]


def test_silent_failed_check_keeps_its_exit_code(repo, dispatcher, project, client):
    repo.update_project(project.id, verify_cmd="exit 3")
    t = _started(repo, dispatcher, project)
    _handed_in(repo, dispatcher, t)
    dispatcher._process_verifying()
    dispatcher.verify_pool.wait(10)
    dispatcher._process_verifying()
    [check] = client.get(f"/api/tasks/{t.id}/runs").json()["checks"]
    assert check["ok"] is False and check["output_tail"] == ""
    assert check["exit_code"] == 3 and check["timed_out"] is False


def test_timed_out_check_has_no_code(repo, dispatcher, project, client):
    repo.update_project(project.id, verify_cmd="sleep 30", verify_timeout_sec=1)
    t = _started(repo, dispatcher, project)
    _handed_in(repo, dispatcher, t)
    dispatcher._process_verifying()
    dispatcher.verify_pool.wait(10)
    dispatcher._process_verifying()
    [check] = client.get(f"/api/tasks/{t.id}/runs").json()["checks"]
    assert check["exit_code"] is None and check["timed_out"] is True


def test_old_check_rows_have_null_code(repo, project, client):
    t = repo.add_task(project.id, "A", status="todo")
    repo.conn.execute("INSERT INTO task_checks (task_id, cmd, ok, created_at) VALUES (?, 'c', 0, '2026-01-01')", (t.id,))
    repo.conn.commit()
    [check] = client.get(f"/api/tasks/{t.id}/runs").json()["checks"]
    assert check["exit_code"] is None and check["timed_out"] is False


def test_passed_check_is_kept_too(repo, dispatcher, project):
    repo.update_project(project.id, verify_cmd="true")
    t = _started(repo, dispatcher, project)
    _handed_in(repo, dispatcher, t)
    dispatcher._process_verifying()
    dispatcher.verify_pool.wait(10)
    dispatcher._process_verifying()
    [check] = repo.list_task_checks(t.id)
    assert check["ok"] == 1


def test_check_output_keeps_only_the_tail():
    assert runs.output_tail("x" * 10 + "y" * runs.OUTPUT_TAIL) == "y" * runs.OUTPUT_TAIL


def test_message_by_resume_supersedes_the_run(repo, dispatcher, fake_cli, project):
    t = _started(repo, dispatcher, project)
    fake_cli.set_state(t.job_id, "stopped")
    dispatcher.answer(t.id, "change of plan")
    first, second = _runs(repo, t.id)
    assert first["outcome"] == "superseded" and second["trigger"] == "message"
    assert first["ended_at"] == second["created_at"]


def _in_merging(repo, dispatcher, project, git_repo):
    t = _started(repo, dispatcher, project)
    t = _handed_in(repo, dispatcher, t)
    wt = git_repo / ".claude" / "worktrees" / f"orc-task-{t.id}"
    (wt / "a.txt").write_text("task\n")
    git_ops.git(["commit", "-am", "work"], wt)
    repo.update_task(t.id, status="merging", merge_queued_at="2026-01-01T00:00:01+00:00")
    return repo.get_task(t.id)


def _conflicting_target(git_repo):
    (git_repo / "a.txt").write_text("main edit\n")
    git_ops.git(["commit", "-am", "main"], git_repo)


def test_conflict_wakes_the_session(repo, dispatcher, fake_cli, project, git_repo):
    fake_cli.stop_marks_stopped = True
    t = _in_merging(repo, dispatcher, project, git_repo)
    _conflicting_target(git_repo)
    dispatcher._process_merging()
    assert _runs(repo, t.id)[-1]["trigger"] == "conflict"
    [merge] = _log(repo, t.id)["merges"]
    assert merge["result"] == "conflict" and merge["target"] == "main"


def test_conflict_without_a_session_starts_one(repo, dispatcher, fake_cli, project, git_repo):
    t = _in_merging(repo, dispatcher, project, git_repo)
    repo.update_task(t.id, session_id=None)
    _conflicting_target(git_repo)
    dispatcher._process_merging()
    assert fake_cli.calls[-1][0] == "start_bg"
    assert _runs(repo, t.id)[-1]["trigger"] == "conflict"


def test_merge_shows_up_in_the_log(repo, dispatcher, project, git_repo):
    t = _in_merging(repo, dispatcher, project, git_repo)
    dispatcher._process_merging()
    assert repo.get_task(t.id).status == TaskStatus.DONE
    [merge] = _log(repo, t.id)["merges"]
    assert merge["result"] == "merged" and merge["target"] == "main"


@pytest.mark.parametrize("message, result, target, detail", [
    ("#7 merged into dev", "merged", "dev", None),
    ("#7 merge failed: git said no", "failed", None, "git said no"),
    ("#7 conflict with dev", "conflict", "dev", None),
    ("#7 conflict with dev: handed to the task session (attempt 1 of 3)", "conflict", "dev",
     "handed to the task session (attempt 1 of 3)"),
])
def test_merge_events_are_read(repo, project, message, result, target, detail):
    t = repo.add_task(project.id, "A")
    repo.add_event(message, task_id=t.id)
    repo.add_event("#7 was merged? no, an unrelated line", task_id=t.id)
    [merge] = runs.merge_rows(repo, t.id)
    assert (merge["result"], merge["target"], merge["detail"]) == (result, target, detail)


def test_run_costs_add_up_to_the_task_spending(repo, project):
    t = repo.add_task(project.id, "A")
    a = repo.add_task_session(t.id, "j1", None, None, trigger="start")
    b = repo.add_task_session(t.id, "j2", None, None, trigger="crash")
    conn = repo.conn
    conn.execute("UPDATE task_sessions SET created_at = ?, ended_at = ?, outcome = 'failed' WHERE id = ?",
                 ("2026-01-01T10:00:00+00:00", "2026-01-01T10:30:00+00:00", a["id"]))
    conn.execute("UPDATE task_sessions SET created_at = ? WHERE id = ?", ("2026-01-01T11:00:00+00:00", b["id"]))
    conn.commit()
    # before the first run, during it, after its end (counted late), the second's start second, during the second
    for at, cost in (("2026-01-01T09:00:00+00:00", 1.0), ("2026-01-01T10:10:00+00:00", 2.0),
                     ("2026-01-01T10:45:00+00:00", 4.0), ("2026-01-01T11:00:00+00:00", 8.0),
                     ("2026-01-01T11:20:00+00:00", 16.0)):
        repo.add_usage_entry(t.id, project.id, 10, cost, at=at)
    log = _log(repo, t.id)
    first, second = log["runs"]
    assert first["cost_usd"] == 15.0 and second["cost_usd"] == 16.0
    assert log["totals"]["cost_usd"] == 31.0 and log["totals"]["tokens"] == 50
    assert first["duration_sec"] == 1800


def test_runs_add_up_to_the_cards_own_total(repo, project):
    # The log prices by the estimate; the card shows Claude Code's exact price of a one-session task
    t = repo.add_task(project.id, "A")
    a = repo.add_task_session(t.id, "j1", None, None, trigger="start")
    b = repo.add_task_session(t.id, "j2", None, None, trigger="crash")
    repo.conn.execute("UPDATE task_sessions SET created_at = ? WHERE id = ?", ("2026-01-01T10:00:00+00:00", a["id"]))
    repo.conn.execute("UPDATE task_sessions SET created_at = ? WHERE id = ?", ("2026-01-01T11:00:00+00:00", b["id"]))
    repo.conn.commit()
    repo.add_usage_entry(t.id, project.id, 300, 0.39, at="2026-01-01T10:10:00+00:00")
    repo.add_usage_entry(t.id, project.id, 600, 0.80, at="2026-01-01T11:10:00+00:00")
    repo.update_task(t.id, usage_json=json.dumps({"total_tokens": 1000, "cost_usd": 1.25, "cost_usd_estimated": 1.19,
                                                  "sessions": [{"session_id": "s"}]}))
    log = _log(repo, t.id)
    assert round(sum(r["cost_usd"] for r in log["runs"]), 6) == 1.25 == log["totals"]["cost_usd"]
    assert sum(r["tokens"] for r in log["runs"]) == 1000 == log["totals"]["tokens"]
    assert log["runs"][0]["cost_usd"] < log["runs"][1]["cost_usd"]


def test_spending_without_a_log_goes_to_the_last_run(repo, project):
    t = repo.add_task(project.id, "A")
    repo.add_task_session(t.id, "j1", None, None)
    repo.add_task_session(t.id, "j2", None, None)
    repo.update_task(t.id, usage_json=json.dumps({"total_tokens": 10, "cost_usd_estimated": 0.5, "sessions": []}))
    first, second = _log(repo, t.id)["runs"]
    assert (first["cost_usd"], second["cost_usd"]) == (0.0, 0.5)
    assert (first["tokens"], second["tokens"]) == (0, 10)


def test_runs_from_before_the_log_are_plain_runs(repo, project):
    t = repo.add_task(project.id, "A")
    repo.add_task_session(t.id, "j1", None, None)
    repo.add_task_session(t.id, "j2", None, None)
    repo.update_task(t.id, status=TaskStatus.DONE, done_at="2099-01-01T00:00:00+00:00")
    first, second = _log(repo, t.id)["runs"]
    assert first["trigger"] is None and first["outcome"] is None and not first["active"]
    assert first["ended_at"] == second["started_at"]
    assert second["ended_at"] == "2099-01-01T00:00:00+00:00" and not second["active"]


def test_runs_endpoint_404(client):
    assert client.get("/api/tasks/999/runs").status_code == 404


def test_trigger_and_outcome_lists_are_the_spec():
    assert set(TRIGGERS) >= {"start", "rework", "resume", "crash", "verify_failed", "conflict", "message"}
    assert set(OUTCOMES) == {"handed_in", "failed", "stopped", "quota", "superseded", "sleeping"}
