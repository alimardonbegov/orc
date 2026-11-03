import json
import subprocess
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from orc import git_ops, usage
from orc.claude_cli import ClaudeCliError, JobState
from orc.dispatcher import QUOTA_RETRY_LIMIT, STATE_LOST_TICKS
from orc.models import Blocker, TaskStatus
from orc.quota import RESET_BUFFER_SEC


def _init_git_repo(path):
    # A minimal repository with a main branch and one commit, like git_repo from conftest,
    # but for a test that needs two independent projects at once.
    path.mkdir()
    for args in (
        ["init", "-b", "main"],
        ["config", "user.email", "t@t"],
        ["config", "user.name", "t"],
    ):
        subprocess.run(["git", *args], cwd=path, check=True, capture_output=True, text=True)
    (path / "a.txt").write_text("1\n")
    subprocess.run(["git", "add", "a.txt"], cwd=path, check=True, capture_output=True, text=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=path, check=True, capture_output=True, text=True)


def test_start_ready_creates_worktree_and_session(repo, dispatcher, fake_cli, project, git_repo):
    t = repo.add_task(project.id, "Do X", "description", status="todo")
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.IN_PROGRESS
    assert t.branch == f"orc/task-{t.id}"
    assert t.target_branch == "main"  # taken from the project's current branch
    assert t.worktree_path == str(git_repo / ".claude" / "worktrees" / f"orc-task-{t.id}")
    assert git_ops.current_branch(git_repo / ".claude" / "worktrees" / f"orc-task-{t.id}") == t.branch
    assert t.job_id == "job00001" and t.session_id == "sess-job00001"
    call = fake_cli.calls[0]
    assert call[0] == "start_bg" and call[3] == f"orc#{t.id} Do X"
    assert "Do X" in call[2] and ".orchestrator/report.json" in call[2]
    assert (git_repo / ".git" / "info" / "exclude").read_text().count(".orchestrator/") == 1


def test_start_uses_task_overrides_and_project_defaults(repo, dispatcher, fake_cli, project):
    repo.update_project(project.id, default_model="sonnet", default_effort="medium")
    t = repo.add_task(project.id, "A", status="todo", model="opus", permission_mode="bypassPermissions")
    dispatcher.tick()
    call = fake_cli.calls[0]
    assert call[4] == "opus" and call[5] == "medium" and call[6] == "bypassPermissions"


def test_backlog_is_ignored_and_paused_dispatcher_starts_nothing(repo, dispatcher, fake_cli, project):
    repo.add_task(project.id, "A")  # backlog
    dispatcher.tick()
    assert fake_cli.calls == []
    repo.add_task(project.id, "B", status="todo")
    repo.set_setting("dispatcher_paused", "1")
    dispatcher.tick()
    assert fake_cli.calls == []


def test_sync_blocked_sets_needs_input_and_event(repo, dispatcher, fake_cli, project):
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    fake_cli.set_state("job00001", "blocked", needs="Which port?")
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.blocker == Blocker.NEEDS_INPUT and t.blocker_detail == "Which port?"
    events = repo.list_events(unread_only=True)
    assert len(events) == 2  # start + waiting for an answer
    dispatcher.tick()
    assert len(repo.list_events(unread_only=True)) == 2  # does not write again
    fake_cli.set_state("job00001", "working")
    dispatcher.tick()
    assert repo.get_task(t.id).blocker is None


def test_sync_done_moves_to_verifying(repo, dispatcher, fake_cli, project):
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    fake_cli.set_state("job00001", "done")
    dispatcher._sync_running()
    assert repo.get_task(t.id).status == TaskStatus.VERIFYING


def test_failed_non_quota_resumes_once_then_fails(repo, dispatcher, fake_cli, project):
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    fake_cli.set_state("job00001", "failed", detail="TypeError")
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.IN_PROGRESS and t.auto_resume_count == 1 and t.job_id == "job00002"
    assert fake_cli.calls[-1][0] == "resume_bg" and fake_cli.calls[-1][2] == "sess-job00001"
    fake_cli.set_state("job00002", "failed", detail="TypeError again")
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.FAILED and "TypeError again" in t.blocker_detail


def test_resume_picks_up_session_id_of_new_job(repo, dispatcher, fake_cli, project):
    # resume_bg may spawn a copy of the session under a new job id.
    # _resume must pick up the session_id of the new job, not keep the old one.
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()  # job00001, session_id sess-job00001
    fake_cli.set_state("job00001", "failed", detail="TypeError")
    # We pre-seed the state for job00002 with a DIFFERENT session_id, as if it were a copy of the session.
    # states.setdefault in FakeClaudeCli.resume_bg will not overwrite an existing entry.
    fake_cli.states["job00002"] = JobState("working", "", None, "sess-copy", None)
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.job_id == "job00002"
    assert t.session_id == "sess-copy"


def test_sync_running_isolates_read_state_failure_per_task(repo, dispatcher, fake_cli, project):
    # read_state may raise OSError (a race with deletion of the job directory, a broken symlink, permissions)
    # and a failure on one task must not abort the sync of the others in the same tick.
    t1 = repo.add_task(project.id, "A", status="todo")
    t2 = repo.add_task(project.id, "B", status="todo")
    dispatcher.tick()  # job00001 (t1) and job00002 (t2) start
    fake_cli.set_state("job00002", "done")
    real_read_state = fake_cli.read_state

    def flaky_read_state(job_id):
        if job_id == "job00001":
            raise OSError("race with deletion of the job directory")
        return real_read_state(job_id)

    fake_cli.read_state = flaky_read_state
    dispatcher.tick()
    t1 = repo.get_task(t1.id)
    t2 = repo.get_task(t2.id)
    assert t1.status == TaskStatus.IN_PROGRESS  # not harmed, but did not advance either
    # Processed despite the failure on t1: _process_verifying runs in the same tick
    # right after _sync_running, so t2 does not merely reach VERIFYING but is checked at once:
    # report.json is not written, so the check fails and the task goes to auto-resume.
    assert t2.status == TaskStatus.IN_PROGRESS and t2.auto_resume_count == 1


def test_quota_failure_freezes_dispatcher_and_retries_later(repo, dispatcher, fake_cli, project):
    now = [datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)]
    dispatcher.now = lambda: now[0]
    a = repo.add_task(project.id, "A", status="todo")
    b = repo.add_task(project.id, "B", status="todo")
    repo.update_project(project.id, max_workers=1)
    dispatcher.tick()  # only A starts
    fake_cli.set_state("job00001", "failed", detail="You've hit your usage limit")
    dispatcher.tick()
    a = repo.get_task(a.id)
    assert a.blocker == Blocker.QUOTA and a.status == TaskStatus.IN_PROGRESS
    assert dispatcher.status()["quota_retry_after"] == "2026-01-01T12:30:00+00:00"
    assert repo.get_task(b.id).status == TaskStatus.TODO  # no new starts
    now[0] += timedelta(minutes=31)
    dispatcher.tick()
    a = repo.get_task(a.id)
    assert a.blocker is None and a.job_id == "job00002"
    assert dispatcher.status()["quota_retry_after"] is None
    # a repeated limit: the delay grows to 60 minutes
    fake_cli.set_state("job00002", "failed", detail="usage limit")
    dispatcher.tick()
    assert dispatcher.status()["quota_retry_after"] == "2026-01-01T13:31:00+00:00"


def test_quota_backoff_caps_at_120_minutes(repo, dispatcher, fake_cli, project):
    # 30 -> 60 -> 120 -> 120: the third and fourth consecutive failures must not exceed the ceiling
    # retry_delay_minutes (orc/quota.py). Explicit numbers (not retry_delay_minutes itself) in the expectations,
    # so the test does not mask a regression in the delay formula itself.
    now = [datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)]
    dispatcher.now = lambda: now[0]
    repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()  # job00001
    job_id = "job00001"
    for expected_delay_minutes in (30, 60, 120, 120):
        fake_cli.set_state(job_id, "failed", detail="usage limit")
        dispatcher.tick()
        expected_retry_at = now[0] + timedelta(minutes=expected_delay_minutes)
        assert dispatcher.status()["quota_retry_after"] == expected_retry_at.isoformat()
        # lift the pause and resume the task under a new job id for the next failure
        now[0] = expected_retry_at + timedelta(minutes=1)
        dispatcher.tick()
        assert dispatcher.status()["quota_retry_after"] is None
        job_id = repo.get_task(repo.list_tasks()[0].id).job_id


def _seed_usage_cache(dispatcher, measured_at, five_resets_at):
    """The limits cache as the statusline of a running session leaves it."""
    dispatcher.settings.usage_cache_path.parent.mkdir(parents=True, exist_ok=True)
    dispatcher.settings.usage_cache_path.write_text(json.dumps({
        "model": "Claude Sonnet 5",
        "updated_at": measured_at,
        "five_hour": {"used_percentage": 100.0, "resets_at": five_resets_at,
                      "measured_at": measured_at, "source": "statusline"},
        "seven_day": {"used_percentage": 31.0, "resets_at": five_resets_at + 4 * 3600,
                      "measured_at": measured_at, "source": "statusline"},
    }))


def test_quota_wait_uses_real_window_reset_instead_of_backoff(repo, dispatcher, fake_cli, project):
    # The main point of retry on a limit: the pause is computed from the actual reset time
    # of the five-hour window, not from a guessed 30 minutes. The test clock is tied to the real one:
    # usage.read() computes the snapshot freshness (STALE_AFTER_SEC) from the system time.
    now_epoch = time.time()
    now = [datetime.fromtimestamp(now_epoch, tz=timezone.utc)]
    dispatcher.now = lambda: now[0]
    resets_at = now_epoch + 40 * 60  # reset in 40 minutes: the difference from the 30-minute backoff is visible
    _seed_usage_cache(dispatcher, now_epoch, resets_at)
    repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    fake_cli.set_state("job00001", "failed", detail="You've hit your usage limit")
    dispatcher.tick()
    expected = datetime.fromtimestamp(resets_at + RESET_BUFFER_SEC, tz=timezone.utc).replace(microsecond=0)
    assert dispatcher.status()["quota_retry_after"] == expected.isoformat()
    # The backoff still advances: it stays the fallback if there turns out to be no limits snapshot.
    assert repo.get_setting("quota_attempt") == "1"


def test_quota_wait_falls_back_to_backoff_when_limits_are_stale(repo, dispatcher, fake_cli, project):
    # A snapshot older than STALE_AFTER_SEC is no longer a fact about the limit but a memory. Its
    # resets_at cannot be trusted (the window may have changed since), so the blind backoff applies.
    now_epoch = time.time()
    now = [datetime.fromtimestamp(now_epoch, tz=timezone.utc)]
    dispatcher.now = lambda: now[0]
    _seed_usage_cache(dispatcher, now_epoch - usage.STALE_AFTER_SEC - 60, now_epoch + 40 * 60)
    repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    fake_cli.set_state("job00001", "failed", detail="You've hit your usage limit")
    dispatcher.tick()
    expected = (now[0] + timedelta(minutes=30)).replace(microsecond=0)
    assert dispatcher.status()["quota_retry_after"] == expected.isoformat()


def test_quota_attempt_resets_to_zero_when_task_reaches_done(repo, dispatcher, fake_cli, project):
    # quota_attempt is reset only in the done branch of _apply_state, the only reset path of
    # the backoff. If this reset is ever lost in a refactor, every next
    # quota wait will become 120 minutes instead of 30, and that is almost impossible to notice in the logs.
    repo.set_setting("quota_attempt", "5")  # as if there had already been several failures in a row
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    fake_cli.set_state("job00001", "done")
    dispatcher._sync_running()
    assert repo.get_task(t.id).status == TaskStatus.VERIFYING
    assert repo.get_setting("quota_attempt") == "0"


def test_global_limit_caps_total_across_projects(repo, dispatcher, fake_cli, tmp_path):
    # global_max_workers limits the TOTAL across all projects, not per project: none of
    # the existing dispatcher tests checked this (they all worked with one project).
    repo_a, repo_b = tmp_path / "repo_a", tmp_path / "repo_b"
    for path in (repo_a, repo_b):
        _init_git_repo(path)
    pa = repo.add_project("proj-a", str(repo_a), max_workers=5)
    pb = repo.add_project("proj-b", str(repo_b), max_workers=5)
    repo.set_setting("global_max_workers", "3")
    for i in range(4):
        repo.add_task(pa.id, f"A{i}", status="todo")
        repo.add_task(pb.id, f"B{i}", status="todo")
    dispatcher.tick()
    running = repo.list_tasks(status=TaskStatus.IN_PROGRESS)
    assert len(running) == 3  # exactly the global limit, despite max_workers=5 on each project


# ---------- state loss and resume ----------


def test_lost_state_json_fails_task_after_threshold(repo, dispatcher, fake_cli, project):
    # state.json disappeared (the owner ran `claude rm`, Claude Code cleaned up old jobs):
    # without a counter the task stays in in_progress forever and occupies a worker slot permanently.
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    fake_cli.drop_state("job00001")
    for _ in range(STATE_LOST_TICKS - 1):
        dispatcher.tick()
        assert repo.get_task(t.id).status == TaskStatus.IN_PROGRESS  # we wait until the threshold
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.FAILED
    assert "state.json" in t.blocker_detail
    assert any(e["level"] == "warn" and "lost" in e["message"] for e in repo.list_events())


def test_state_miss_counter_resets_on_successful_read(repo, dispatcher, fake_cli, project):
    # The counter counts CONSECUTIVE misses and is reset by the first successful read.
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    fake_cli.drop_state("job00001")
    for _ in range(STATE_LOST_TICKS - 1):
        dispatcher.tick()
    assert repo.get_task(t.id).state_miss_count == STATE_LOST_TICKS - 1
    fake_cli.set_state("job00001", "working")
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.IN_PROGRESS and t.state_miss_count == 0


def test_failed_without_known_session_fails_with_clear_text(repo, dispatcher, fake_cli, project):
    # The daemon has not written state.json by the time of the start (session_id unknown), and the first
    # state arrives immediately as failed, also without a sessionId. There is nothing to resume: the task must
    # go to failed with a clear message instead of spinning on every tick.
    fake_cli.delay_state = True
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    assert repo.get_task(t.id).session_id is None
    fake_cli.set_state("job00001", "failed", detail="TypeError", session_id=None)
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.FAILED
    assert t.auto_resume_count == 1
    assert "could not resume" in t.blocker_detail


def test_failure_with_fresh_session_id_resumes_by_new_id(repo, dispatcher, fake_cli, project):
    # session_id arrived together with the failed state: the resume must go with the NEW id,
    # not with the one that lay in the stale task object.
    fake_cli.delay_state = True
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    assert repo.get_task(t.id).session_id is None
    fake_cli.set_state("job00001", "failed", detail="boom", session_id="sess-fresh")
    dispatcher.tick()
    assert fake_cli.calls[-1][0] == "resume_bg"
    assert fake_cli.calls[-1][2] == "sess-fresh"
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.IN_PROGRESS and t.auto_resume_count == 1


def test_failed_resume_attempt_is_counted_and_does_not_loop(repo, dispatcher, fake_cli, project):
    # A failed resume must be counted too, otherwise the task retries on every tick forever.
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()

    def broken_resume(cwd, session_id, prompt):
        raise ClaudeCliError("daemon unavailable")

    fake_cli.resume_bg = broken_resume
    fake_cli.set_state("job00001", "failed", detail="X")
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.auto_resume_count == 1
    assert t.status == TaskStatus.FAILED
    dispatcher.tick()
    assert repo.get_task(t.id).status == TaskStatus.FAILED  # does not spin


# ---------- stop, cleanup, step failures, quota ceiling ----------


def test_answer_delivers_in_the_same_call_when_daemon_confirms_stop(repo, dispatcher, fake_cli, project):
    # An immediate resume after stop is treated by the daemon as launching a COPY of the session.
    # If the stop was confirmed quickly, the reply goes right in the answer call, without waiting for a tick.
    fake_cli.stop_marks_stopped = True
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    fake_cli.set_state("job00001", "blocked", needs="Port?")
    dispatcher.tick()
    dispatcher.answer(t.id, "8080")
    assert [c[0] for c in fake_cli.calls[-2:]] == ["stop", "resume_bg"]
    assert repo.pending_messages(t.id) == []
    assert repo.get_task(t.id).outbox_state is None


def test_answer_never_resumes_a_session_that_did_not_confirm_stop(repo, dispatcher, fake_cli, project):
    # The main invariant: until the state confirms the stop, there is no resume at all.
    # Previously we resumed "anyway" here so as not to lose the reply, and ended up with a copy of the session;
    # now the reply sits in the queue and waits as long as needed.
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    fake_cli.set_state("job00001", "blocked", needs="Port?")
    dispatcher.tick()

    dispatcher.answer(t.id, "8080")  # stop_marks_stopped is off: the daemon is silent
    assert ("stop", "job00001") in fake_cli.calls
    assert not [c for c in fake_cli.calls if c[0] == "resume_bg"]
    assert repo.get_task(t.id).outbox_state == "stopping"
    assert [m["body"] for m in repo.pending_messages(t.id)] == ["8080"]

    dispatcher.tick()  # the state is still not confirmed: there is still no resume
    assert not [c for c in fake_cli.calls if c[0] == "resume_bg"]
    assert fake_cli.calls.count(("stop", "job00001")) == 1  # and stop is not sent in a loop

    fake_cli.set_state("job00001", "stopped")
    dispatcher.tick()
    assert fake_cli.calls[-1][0] == "resume_bg" and fake_cli.calls[-1][3] == "8080"


def test_start_failure_removes_orphan_worktree_and_retry_works(repo, dispatcher, fake_cli, project, git_repo):
    # The worktree is created but the session did not start. Without cleanup and without recording the worktree in the DB
    # the "retry" button runs into "branch already exists" forever.
    real_start_bg = fake_cli.start_bg

    def broken_start_bg(**kwargs):
        raise ClaudeCliError("daemon did not come up")

    fake_cli.start_bg = broken_start_bg
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.FAILED and "failed to start" in t.blocker_detail
    assert not (git_repo / ".claude" / "worktrees" / f"orc-task-{t.id}").exists()
    assert f"orc/task-{t.id}" not in git_ops.list_branches(git_repo)
    dispatcher.retry(t.id)
    fake_cli.start_bg = real_start_bg
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.IN_PROGRESS and t.worktree_path is not None


def test_start_failure_records_worktree_so_retry_can_clean_it(repo, dispatcher, fake_cli, project, git_repo, monkeypatch):
    # If removing the worktree right away failed, the path and branch must be recorded in the DB:
    # otherwise retry() will not find what to clean up and the task is broken forever.
    def broken_start_bg(**kwargs):
        raise ClaudeCliError("daemon did not come up")

    fake_cli.start_bg = broken_start_bg
    monkeypatch.setattr(git_ops, "remove_worktree", lambda *a, **kw: (_ for _ in ()).throw(git_ops.GitError("busy")))
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.FAILED
    assert t.worktree_path == str(git_repo / ".claude" / "worktrees" / f"orc-task-{t.id}")
    assert t.branch == f"orc/task-{t.id}"
    monkeypatch.undo()
    dispatcher.retry(t.id)
    assert not (git_repo / ".claude" / "worktrees" / f"orc-task-{t.id}").exists()
    assert f"orc/task-{t.id}" not in git_ops.list_branches(git_repo)


def test_failed_tick_step_writes_error_event(repo, dispatcher, monkeypatch):
    # A failed step is suppressed at the tick() level and used to go only to the log: the owner saw
    # a frozen board with no explanation at all.
    def _start_ready():  # the step name goes into the event text
        raise RuntimeError("step broken")

    monkeypatch.setattr(dispatcher, "_start_ready", _start_ready)
    dispatcher.tick()
    assert any(e["level"] == "error" and "_start_ready" in e["message"] and "step broken" in e["message"]
               for e in repo.list_events())


def test_quota_retries_are_capped_and_task_fails(repo, dispatcher, fake_cli, project):
    # On the quota path auto_resume_count does not grow, so without a separate ceiling the task
    # (including one that caught a false regex match) retries forever and never becomes failed.
    now = [datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)]
    dispatcher.now = lambda: now[0]
    t = repo.add_task(project.id, "add rate limiting", status="todo")
    dispatcher.tick()
    for _ in range(QUOTA_RETRY_LIMIT + 2):
        current = repo.get_task(t.id)
        if current.status == TaskStatus.FAILED:
            break
        fake_cli.set_state(current.job_id, "failed", detail="usage limit")
        dispatcher.tick()          # the dispatcher goes to quota_wait
        now[0] += timedelta(hours=3)
        dispatcher.tick()          # retry on quota
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.FAILED
    assert "quota_patterns" in t.blocker_detail
    assert t.quota_retry_count >= QUOTA_RETRY_LIMIT
    assert any(e["level"] == "warn" and "quota limit" in e["message"] for e in repo.list_events())


def test_quota_retry_counter_resets_when_session_revives(repo, dispatcher, fake_cli, project):
    # The ceiling counts CONSECUTIVE quota retries, a session that comes alive resets it.
    now = [datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)]
    dispatcher.now = lambda: now[0]
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    fake_cli.set_state("job00001", "failed", detail="usage limit")
    dispatcher.tick()
    now[0] += timedelta(hours=3)
    dispatcher.tick()
    assert repo.get_task(t.id).quota_retry_count == 1
    fake_cli.set_state(repo.get_task(t.id).job_id, "working")
    dispatcher.tick()
    assert repo.get_task(t.id).quota_retry_count == 0


def test_garbage_settings_in_db_do_not_stop_the_dispatcher(repo, dispatcher, fake_cli, project):
    # Second half: validation lives in the API, but the database outlives the code version: a value
    # could have landed there before validation appeared. Garbage must give a fallback, not kill the step.
    repo.set_setting("global_max_workers", "many")
    repo.set_setting("quota_patterns", "not json")
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    assert repo.get_task(t.id).status == TaskStatus.IN_PROGRESS
    fake_cli.set_state("job00001", "failed", detail="TypeError")
    dispatcher.tick()  # _sync_running must not fail on parsing quota_patterns
    assert repo.get_task(t.id).auto_resume_count == 1
    assert not any(e["level"] == "error" and "dispatcher step" in e["message"] for e in repo.list_events())


# ---------- A message to a session without a badge and rework from done ----------


def test_answer_reaches_working_session_without_badge(repo, dispatcher, fake_cli, project):
    # Previously the reply field worked only under the needs_input badge: there was no way to write to a running
    # session. Now the message reaches it too, through the inbox and the hook, that is
    # without any stop at all: the session keeps working under the same job id.
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    assert repo.get_task(t.id).blocker is None
    dispatcher.answer(t.id, "take port 8080")
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.IN_PROGRESS and t.job_id == "job00001"
    assert not [c for c in fake_cli.calls if c[0] in ("stop", "resume_bg")]
    assert t.outbox_state == "sent"
    assert repo.list_comments(t.id)[0]["kind"] == "answer"


def test_answer_refuses_quota_wait_and_unknown_session(repo, dispatcher, fake_cli, project):
    # A task in quota wait is retried by the dispatcher on schedule: a manual resume would bypass
    # the pause and break the attempt counter. A session without a session_id is simply unavailable for resume.
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    repo.update_task(t.id, blocker=Blocker.QUOTA, blocker_detail="usage limit")
    with pytest.raises(ValueError, match="quota"):
        dispatcher.answer(t.id, "text")
    repo.update_task(t.id, blocker=None, session_id=None)
    with pytest.raises(ValueError, match="session"):
        dispatcher.answer(t.id, "text")
    assert ("stop", "job00001") not in fake_cli.calls  # it never got as far as stop


def test_answer_refuses_task_that_is_not_running(repo, dispatcher, project):
    t = repo.add_task(project.id, "A", status="todo")
    with pytest.raises(ValueError):
        dispatcher.answer(t.id, "text")


def test_rework_returns_done_task_to_todo_and_resumes_session(repo, dispatcher, fake_cli, project):
    # "Rework": a rework comment on a finished card returns it to todo with the flag
    # "continue the session", and on start a resume in the same worktree is done instead of a new session.
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    worktree = Path(repo.get_task(t.id).worktree_path)
    (worktree / ".orchestrator").mkdir(parents=True, exist_ok=True)
    (worktree / ".orchestrator" / "report.json").write_text('{"status": "success", "summary": "s", "notes": ""}')
    repo.update_task(t.id, status=TaskStatus.DONE, report_json='{"status": "success"}', done_at="2026-09-21T00:00:00")

    fake_cli.stop_marks_stopped = True  # wake kills the live process and wakes the same job
    dispatcher.rework(t.id, "add one more test")

    t = repo.get_task(t.id)
    assert t.status == TaskStatus.TODO and t.resume_with == "add one more test"
    assert t.report_json is None and t.done_at is None
    # The previous successful report must disappear: otherwise verify reads it and lets
    # the task into the merge even if the session did nothing.
    assert not (worktree / ".orchestrator" / "report.json").exists()
    assert repo.list_comments(t.id)[0]["kind"] == "rework"

    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.IN_PROGRESS and t.resume_with is None
    assert fake_cli.calls[-1][0] == "resume_bg" and fake_cli.calls[-1][3] == "add one more test"


def test_rework_archives_previous_report_as_comment(repo, dispatcher, fake_cli, project):
    # The task report disappears from task.report_json when sent to rework (see the test above):
    # without archiving it in the conversation the submission history would be lost as if it never existed.
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    repo.update_task(
        t.id, status=TaskStatus.DONE,
        report_json='{"status": "success", "summary": "did X", "notes": "did not check Y"}',
    )

    dispatcher.rework(t.id, "rework Y")

    comments = repo.list_comments(t.id)
    assert len(comments) == 2
    assert comments[0]["kind"] == "report" and comments[0]["author"] == "claude"
    assert "did X" in comments[0]["body"] and "did not check Y" in comments[0]["body"]
    assert comments[1]["kind"] == "rework" and comments[1]["body"] == "rework Y"


def test_rework_refuses_when_copy_or_session_is_gone(repo, dispatcher, fake_cli, project, tmp_path):
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    repo.update_task(t.id, status=TaskStatus.DONE)
    repo.update_task(t.id, worktree_path=str(tmp_path / "no-such-copy"))
    with pytest.raises(ValueError, match="working copy"):
        dispatcher.rework(t.id, "rework it")
    assert repo.get_task(t.id).status == TaskStatus.DONE  # the card stayed done


def test_rework_refuses_task_that_is_not_done(repo, dispatcher, project):
    t = repo.add_task(project.id, "A", status="todo")
    with pytest.raises(ValueError):
        dispatcher.rework(t.id, "rework it")


def test_force_done_refuses_task_that_is_not_working_or_failed(repo, dispatcher, project):
    # Closing by hand is an emergency exit from working statuses and from failed. A task in the backlog
    # has nothing to stop, and "done" without a single run would just be a lie.
    for status in (TaskStatus.BACKLOG, TaskStatus.TODO, TaskStatus.DONE):
        t = repo.add_task(project.id, "A", status=status)
        with pytest.raises(ValueError, match="in progress"):
            dispatcher.force_done(t.id)
        assert repo.get_task(t.id).status == status


def test_force_done_closes_failed_task(repo, dispatcher, project):
    # The task did not make it: it can be closed by hand the same way as one stuck in progress,
    # without starting an extra cycle through retry/resume.
    t = repo.add_task(project.id, "A", status=TaskStatus.FAILED, blocker_detail="crashed")
    t = dispatcher.force_done(t.id)
    assert t.status == TaskStatus.DONE and t.done_at
    assert any("closed manually" in c["body"] for c in repo.list_comments(t.id))


def test_force_done_survives_dead_session(repo, dispatcher, fake_cli, project, monkeypatch):
    # The usual case of a stuck card: the daemon is gone and `claude stop` fails.
    # That is no reason to leave the task in in_progress: that is exactly what the button is for.
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    monkeypatch.setattr(fake_cli, "stop", lambda job_id: (_ for _ in ()).throw(ClaudeCliError("daemon not responding")))
    t = dispatcher.force_done(t.id)
    assert t.status == TaskStatus.DONE and t.done_at


def test_start_uses_project_default_branch(repo, dispatcher, project, git_repo):
    # The project's base branch, not the one checked out in the repository: it is "where everything lives"
    git_ops.create_branch(git_repo, "dev", "main")
    repo.update_project(project.id, default_branch="dev")
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.target_branch == "dev" and t.status == TaskStatus.IN_PROGRESS


def test_start_fails_readably_when_target_branch_is_gone(repo, dispatcher, project, git_repo):
    # The branch was deleted by hand bypassing the dashboard: a bare git error about an invalid reference does not
    # explain what to fix.
    t = repo.add_task(project.id, "A", status="todo", target_branch="vanished-branch")
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.FAILED
    assert "vanished-branch" in t.blocker_detail and "no longer exists" in t.blocker_detail
