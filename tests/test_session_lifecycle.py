"""Session lifecycle: waking without copies and releasing the process."""
import json
from pathlib import Path

import pytest

from orc.claude_cli import ClaudeCliError
from orc.models import TaskStatus
from orc.report import REPORT_REL_PATH


def _running(repo, dispatcher, project):
    t = repo.add_task(project.id, "A", status="todo")
    dispatcher.tick()
    return repo.get_task(t.id)


def _resumes(fake_cli):
    return [c for c in fake_cli.calls if c[0] == "resume_bg"]


def test_wake_live_idle_session_stops_then_resumes_without_settings(repo, dispatcher, fake_cli, project):
    t = _running(repo, dispatcher, project)
    fake_cli.set_state(t.job_id, "working", tempo="idle")
    fake_cli.stop_marks_stopped = True
    dispatcher.sessions.wake(t, "continue")
    assert ("stop", t.job_id) in fake_cli.calls
    resume = _resumes(fake_cli)[-1]
    assert resume[3] == "continue"
    assert resume[4] is None  # waking a stopped one: no --settings, otherwise the daemon creates a copy


def test_wake_stopped_session_resumes_without_stop(repo, dispatcher, fake_cli, project):
    t = _running(repo, dispatcher, project)
    fake_cli.set_state(t.job_id, "stopped")
    dispatcher.sessions.wake(t, "next")
    assert ("stop", t.job_id) not in fake_cli.calls
    assert _resumes(fake_cli)[-1][4] is None


def test_wake_done_or_missing_state_resumes_with_settings(repo, dispatcher, fake_cli, project):
    t = _running(repo, dispatcher, project)
    fake_cli.set_state(t.job_id, "done")
    dispatcher.sessions.wake(t, "one")
    assert _resumes(fake_cli)[-1][4] is not None
    t = repo.get_task(t.id)
    fake_cli.drop_state(t.job_id)
    dispatcher.sessions.wake(t, "two")
    assert _resumes(fake_cli)[-1][4] is not None


def test_wake_raises_when_session_does_not_stop(repo, dispatcher, fake_cli, project):
    t = _running(repo, dispatcher, project)
    fake_cli.set_state(t.job_id, "working", tempo="idle")
    fake_cli.stop_marks_stopped = False  # the daemon never confirmed the stop
    with pytest.raises(ClaudeCliError):
        dispatcher.sessions.wake(t, "x")
    assert _resumes(fake_cli) == []


def test_release_stops_live_session_only(repo, dispatcher, fake_cli, project):
    t = _running(repo, dispatcher, project)
    fake_cli.set_state(t.job_id, "working", tempo="idle")
    assert dispatcher.sessions.release(t, "submitted") is True
    assert ("stop", t.job_id) in fake_cli.calls
    fake_cli.calls.clear()
    fake_cli.set_state(t.job_id, "stopped")
    assert dispatcher.sessions.release(t, "submitted") is False
    assert fake_cli.calls == []


def test_release_swallows_cli_error(repo, dispatcher, fake_cli, project):
    t = _running(repo, dispatcher, project)
    fake_cli.set_state(t.job_id, "working", tempo="idle")

    def boom(job_id):
        raise ClaudeCliError("daemon unavailable")
    fake_cli.stop = boom
    assert dispatcher.sessions.release(t, "submitted") is False


def _report(task):
    p = Path(task.worktree_path) / REPORT_REL_PATH
    p.parent.mkdir(exist_ok=True)
    p.write_text(json.dumps({"status": "success", "summary": "ok"}))


def test_rework_of_done_task_wakes_same_session(repo, dispatcher, fake_cli, project):
    t = _running(repo, dispatcher, project)
    repo.update_task(t.id, status=TaskStatus.DONE)
    fake_cli.set_state(t.job_id, "working", tempo="idle")  # the process is alive, as on 2.1.293+
    fake_cli.stop_marks_stopped = True
    dispatcher.rework(t.id, "fix the title")
    dispatcher.tick()
    assert ("stop", t.job_id) in fake_cli.calls
    assert _resumes(fake_cli)[-1][4] is None


def test_verify_failure_wakes_without_copy(repo, dispatcher, fake_cli, project):
    t = _running(repo, dispatcher, project)
    fake_cli.set_state(t.job_id, "working", tempo="idle")
    fake_cli.stop_marks_stopped = True
    repo.update_task(t.id, status=TaskStatus.VERIFYING)
    dispatcher._verify_failed(repo.get_task(t.id), "no report")
    assert repo.get_task(t.id).status == TaskStatus.IN_PROGRESS
    assert _resumes(fake_cli)[-1][4] is None


def test_verify_failure_fails_task_when_session_wont_stop(repo, dispatcher, fake_cli, project):
    t = _running(repo, dispatcher, project)
    fake_cli.set_state(t.job_id, "working", tempo="idle")
    repo.update_task(t.id, status=TaskStatus.VERIFYING)
    dispatcher._verify_failed(repo.get_task(t.id), "no report")
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.FAILED and "did not stop" in t.blocker_detail


def test_resume_failed_reports_unstoppable_session_as_value_error(repo, dispatcher, fake_cli, project):
    t = _running(repo, dispatcher, project)
    fake_cli.set_state(t.job_id, "working", tempo="idle")
    repo.update_task(t.id, status=TaskStatus.FAILED)
    with pytest.raises(ValueError, match="did not stop"):
        dispatcher.resume_failed(t.id)
    assert repo.get_task(t.id).status == TaskStatus.FAILED
    assert _resumes(fake_cli) == []


def test_handle_failure_fails_task_when_session_wont_stop(repo, dispatcher, fake_cli, project):
    t = _running(repo, dispatcher, project)
    fake_cli.set_state(t.job_id, "working", tempo="idle")
    st = fake_cli.read_state(t.job_id)
    dispatcher._handle_failure(repo.get_task(t.id), st)
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.FAILED and "did not stop" in t.blocker_detail


def test_report_at_turn_end_releases_session(repo, dispatcher, fake_cli, project, monkeypatch):
    t = _running(repo, dispatcher, project)
    # End of turn on 2.1.293+: working + idle, report written: the session handed in its work
    monkeypatch.setattr(dispatcher, "_session_quiet", lambda st: True)
    monkeypatch.setattr(dispatcher, "_reported_this_turn", lambda task, turn: True)
    fake_cli.set_state(t.job_id, "working", tempo="idle")
    dispatcher._sync_running()
    assert repo.get_task(t.id).status == TaskStatus.VERIFYING
    assert ("stop", t.job_id) in fake_cli.calls


def test_released_session_is_not_auto_resumed(repo, dispatcher, fake_cli, project, monkeypatch):
    t = _running(repo, dispatcher, project)
    monkeypatch.setattr(dispatcher, "_session_quiet", lambda st: True)
    monkeypatch.setattr(dispatcher, "_reported_this_turn", lambda task, turn: True)
    fake_cli.set_state(t.job_id, "working", tempo="idle")
    fake_cli.stop_marks_stopped = True
    dispatcher._sync_running()
    fake_cli.calls.clear()
    dispatcher._sync_running()  # state is now stopped, but the task is no longer in in_progress
    assert _resumes(fake_cli) == []


def test_fail_releases_live_session(repo, dispatcher, fake_cli, project):
    t = _running(repo, dispatcher, project)
    fake_cli.set_state(t.job_id, "working", tempo="idle")
    dispatcher._fail(t, "something broke")
    assert ("stop", t.job_id) in fake_cli.calls


def test_wake_treats_session_as_stopped_when_state_vanishes_after_wait(repo, dispatcher, fake_cli, project):
    """wait_stopped saw the stop, but a repeated read of state.json returned None: this is not done,
    the resume goes without --settings, otherwise the daemon creates a copy."""
    t = _running(repo, dispatcher, project)
    fake_cli.set_state(t.job_id, "working", tempo="idle")
    fake_cli.stop_marks_stopped = True
    old_job = t.job_id
    reads = {"n": 0}
    real_read = fake_cli.read_state

    def flaky_read(job_id):
        if job_id == old_job:
            reads["n"] += 1
            if reads["n"] >= 3:  # 1 is wake, 2 is wait_stopped, after that the file is not read
                return None
        return real_read(job_id)

    fake_cli.read_state = flaky_read
    dispatcher.sessions.wake(t, "continue")
    assert _resumes(fake_cli)[-1][4] is None
