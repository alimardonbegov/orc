import json
import shutil
from pathlib import Path

from orc.models import TaskStatus
from orc.handoff import REPORT_REL_PATH
from orc.verify import VerifyResult


def _started(repo, dispatcher, project, **fields):
    t = repo.add_task(project.id, "A", status="todo", **fields)
    dispatcher.tick()
    return repo.get_task(t.id)


def _write_report(task, status="success", summary="done"):
    p = Path(task.worktree_path) / REPORT_REL_PATH
    p.parent.mkdir(exist_ok=True)
    p.write_text(json.dumps({"status": status, "summary": summary}))


def test_success_report_and_green_verify_moves_to_merging(repo, dispatcher, fake_cli, project):
    repo.update_project(project.id, verify_cmd="true")
    t = _started(repo, dispatcher, project)
    _write_report(t)
    fake_cli.set_state(t.job_id, "done")
    # a full tick() would merge the task in the same call: here we check
    # the verify step itself, so the merge step is deliberately not run.
    dispatcher._sync_running()
    dispatcher._process_verifying()
    dispatcher.verify_pool.wait(10)
    dispatcher._process_verifying()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.MERGING
    assert t.merge_queued_at is not None
    assert json.loads(t.report_json)["summary"] == "done"


def test_missing_report_resumes_once(repo, dispatcher, fake_cli, project):
    t = _started(repo, dispatcher, project)
    fake_cli.set_state(t.job_id, "done")
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.IN_PROGRESS and t.auto_resume_count == 1
    assert "task done" in fake_cli.calls[-1][3]


def test_failed_report_after_resume_fails_task(repo, dispatcher, fake_cli, project):
    t = _started(repo, dispatcher, project, auto_resume_count=1)
    _write_report(t, status="failed", summary="could not")
    fake_cli.set_state(t.job_id, "done")
    dispatcher.tick()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.FAILED and "could not" in t.blocker_detail
    assert t.detail_code == "agent_reported"


def test_red_verify_resumes_with_output(repo, dispatcher, fake_cli, project, settle):
    repo.update_project(project.id, verify_cmd="echo FAIL_MARKER; exit 1")
    t = _started(repo, dispatcher, project)
    _write_report(t)
    fake_cli.set_state(t.job_id, "done")
    settle()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.IN_PROGRESS
    assert "FAIL_MARKER" in fake_cli.calls[-1][3]
    assert t.detail_code is None  # the first red check is not a failure yet


def test_second_red_verify_fails_with_its_code(repo, dispatcher, fake_cli, project, settle):
    repo.update_project(project.id, verify_cmd="echo FAIL_MARKER; exit 1")
    t = _started(repo, dispatcher, project, auto_resume_count=1)
    _write_report(t)
    fake_cli.set_state(t.job_id, "done")
    settle()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.FAILED and "FAIL_MARKER" in t.blocker_detail
    assert t.detail_code == "check_failed_again"
    # A retry clears the text, and the code with it: it must not outlive its text
    dispatcher.retry(t.id)
    assert repo.get_task(t.id).detail_code is None


def test_task_verify_cmd_overrides_project(repo, dispatcher, fake_cli, project):
    repo.update_project(project.id, verify_cmd="exit 1")
    t = _started(repo, dispatcher, project, verify_cmd="true")
    _write_report(t)
    fake_cli.set_state(t.job_id, "done")
    # a full tick() would merge the task in the same call: here we check
    # the verify step itself, so the merge step is deliberately not run.
    dispatcher._sync_running()
    dispatcher._process_verifying()
    dispatcher.verify_pool.wait(10)
    dispatcher._process_verifying()
    assert repo.get_task(t.id).status == TaskStatus.MERGING


def test_no_verify_cmd_moves_straight_to_merging(repo, dispatcher, fake_cli, project):
    # Neither the task nor the project has verify_cmd set (the default for a new project):
    # this is the main path for a freshly created project, and an empty command must not be run.
    t = _started(repo, dispatcher, project)
    _write_report(t)
    fake_cli.set_state(t.job_id, "done")
    # a full tick() would merge the task in the same call: here we check
    # the verify step itself, so the merge step is deliberately not run.
    dispatcher._sync_running()
    dispatcher._process_verifying()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.MERGING
    assert t.merge_queued_at is not None
    assert json.loads(t.report_json)["summary"] == "done"


def test_process_verifying_isolates_failure_per_task(repo, dispatcher, fake_cli, project, monkeypatch):
    # Regression: a failure while checking one task (for example, a race while reading
    # report.json) must not abort the processing of the other tasks in _process_verifying.
    t1 = _started(repo, dispatcher, project)
    t2 = _started(repo, dispatcher, project)
    _write_report(t1)  # read_report raises on this one
    _write_report(t2)
    fake_cli.set_state(t1.job_id, "done")
    fake_cli.set_state(t2.job_id, "done")

    from orc.handoff import read_report as real_read_report

    broken_worktree = str(Path(t1.worktree_path))

    def flaky_read_report(worktree):
        if str(worktree) == broken_worktree:
            raise OSError("race while reading report.json")
        return real_read_report(worktree)

    monkeypatch.setattr("orc.handoff.read_report", flaky_read_report)

    # a full tick() would merge the task in the same call: here we check
    # the verify step itself, so the merge step is deliberately not run.
    dispatcher._sync_running()
    dispatcher._process_verifying()

    t1 = repo.get_task(t1.id)
    t2 = repo.get_task(t2.id)
    assert t1.status == TaskStatus.VERIFYING  # the failure is isolated: it neither crashed nor advanced
    assert t2.status == TaskStatus.MERGING  # processed despite the failure on t1


# ---------- missing worktree, deleted project, long verify ----------


def test_removed_worktree_fails_task_with_event(repo, dispatcher, fake_cli, project):
    # The owner removed .claude/worktrees/orc-task-N by hand. Previously this gave
    # read_report -> None -> resume -> FileNotFoundError in subprocess -> the task forever
    # in verifying without a single event.
    t = _started(repo, dispatcher, project)
    fake_cli.set_state(t.job_id, "done")
    dispatcher._sync_running()
    shutil.rmtree(t.worktree_path)
    dispatcher._process_verifying()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.FAILED
    assert "working copy" in t.blocker_detail
    assert t.detail_code == "branch_gone"
    assert any(e["level"] == "error" and str(t.id) in e["message"] for e in repo.list_events())


def test_task_without_worktree_path_fails(repo, dispatcher, fake_cli, project):
    # worktree_path=None (the task got into verifying without a start) is the same dead end.
    t = repo.add_task(project.id, "A", status="verifying")
    dispatcher._process_verifying()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.FAILED and "working copy" in t.blocker_detail


def test_deleted_project_fails_verifying_task(repo, dispatcher, fake_cli, project, monkeypatch):
    # get_project could return None and crash _verify
    # with an AttributeError, and the task stayed in verifying forever.
    t = _started(repo, dispatcher, project)
    _write_report(t)
    fake_cli.set_state(t.job_id, "done")
    dispatcher._sync_running()
    monkeypatch.setattr(dispatcher.repo, "get_project", lambda project_id: None)
    dispatcher._process_verifying()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.FAILED and "project" in t.blocker_detail
    assert t.detail_code == "project_unavailable"


def test_long_verify_does_not_block_tick(repo, dispatcher, fake_cli, project):
    """The whole point of the pool: while one task is being verified, the dispatcher keeps working."""
    import threading

    release = threading.Event()

    def slow_runner(cmd, cwd, timeout_sec):
        release.wait(10)
        return VerifyResult(True, "")

    dispatcher.verify_pool.runner = slow_runner
    repo.update_project(project.id, verify_cmd="make test", max_workers=2)

    first = _started(repo, dispatcher, project)
    _write_report(first)
    fake_cli.set_state(first.job_id, "done")
    dispatcher.tick()  # first goes to the pool and stays in verifying
    assert repo.get_task(first.id).status == TaskStatus.VERIFYING
    assert dispatcher.verify_pool.running() == [first.id]
    assert any("verification started" in e["message"] for e in repo.list_events())

    # While the check hangs, the second task must start: the tick is not blocked
    second = repo.add_task(project.id, "B", status="todo")
    dispatcher.tick()
    assert repo.get_task(second.id).status == TaskStatus.IN_PROGRESS

    release.set()
    dispatcher.verify_pool.wait(10)
    dispatcher.tick()
    # In the same tick _process_merging comes right after _process_verifying and in the test
    # repository merges without conflicts: the task reaches DONE in a single pass.
    assert repo.get_task(first.id).status == TaskStatus.DONE
    assert any("verification passed" in e["message"] for e in repo.list_events())


def test_stale_outcome_is_discarded(repo, dispatcher, fake_cli, project):
    """The task was restarted while the check was running: its result must not be applied."""
    from orc.verify_pool import VerifyOutcome

    t = _started(repo, dispatcher, project)
    _write_report(t)
    fake_cli.set_state(t.job_id, "done")
    dispatcher._sync_running()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.VERIFYING

    outcome = VerifyOutcome(t.id, "job-from-a-previous-life", True, "", "make test", 1.0)
    dispatcher._apply_verify_outcome(t, outcome)
    assert repo.get_task(t.id).status == TaskStatus.VERIFYING


def test_deleted_project_fails_merging_task(repo, dispatcher, fake_cli, project, monkeypatch):
    # The same for the merge step: get_project was also called there without a check.
    t = repo.add_task(project.id, "A", status="merging", merge_queued_at="2026-01-01T00:00:00+00:00")
    monkeypatch.setattr(dispatcher.repo, "get_project", lambda project_id: None)
    dispatcher._process_merging()
    t = repo.get_task(t.id)
    assert t.status == TaskStatus.FAILED and "project" in t.blocker_detail
    assert t.detail_code == "project_unavailable"


def test_retry_cancels_running_verify(repo, dispatcher, fake_cli, project):
    import threading

    release = threading.Event()

    def slow_runner(cmd, cwd, timeout_sec):
        release.wait(10)
        return VerifyResult(True, "")

    dispatcher.verify_pool.runner = slow_runner
    repo.update_project(project.id, verify_cmd="make test")

    t = _started(repo, dispatcher, project)
    _write_report(t)
    fake_cli.set_state(t.job_id, "done")
    dispatcher.tick()
    assert dispatcher.verify_pool.running() == [t.id]

    repo.update_task(t.id, status=TaskStatus.FAILED)
    dispatcher.retry(t.id)
    assert dispatcher.verify_pool.running() == []
    release.set()
    dispatcher.verify_pool.wait(10)
    # The result of a cancelled check must not surface and drag the task into merging
    assert dispatcher.verify_pool.take(t.id) is None
    assert repo.get_task(t.id).status == TaskStatus.TODO


def test_rejected_retry_keeps_verify_running(repo, dispatcher, fake_cli, project):
    """Cancellation comes AFTER the status checks: a rejected command has no right to touch the check."""
    import threading

    import pytest

    release = threading.Event()
    dispatcher.verify_pool.runner = lambda cmd, cwd, timeout_sec: (release.wait(10), VerifyResult(True, ""))[1]
    repo.update_project(project.id, verify_cmd="make test")

    t = _started(repo, dispatcher, project)
    _write_report(t)
    fake_cli.set_state(t.job_id, "done")
    dispatcher.tick()
    assert dispatcher.verify_pool.running() == [t.id]

    with pytest.raises(ValueError):
        dispatcher.retry(t.id)  # the task is in verifying, retry is only for failed
    assert dispatcher.verify_pool.running() == [t.id]
    release.set()
    dispatcher.verify_pool.wait(10)
