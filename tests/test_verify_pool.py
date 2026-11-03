"""Verification pool: the tick hands out and collects, the thread runs only a subprocess."""
import threading
import time

from orc.verify import VerifyResult
from orc.verify_pool import VerifyPool


def _wait_until(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("condition was not reached")
        time.sleep(0.01)


def test_take_returns_outcome_after_run(tmp_path):
    def runner(cmd, cwd, timeout_sec):
        return VerifyResult(True, "done")

    pool = VerifyPool(workers=2, runner=runner)
    pool.submit(7, "job1", "make test", tmp_path, 60)
    pool.wait(5)
    outcome = pool.take(7)
    assert outcome is not None
    assert outcome.task_id == 7 and outcome.job_id == "job1"
    assert outcome.ok and outcome.output == "done" and outcome.cmd == "make test"
    assert outcome.duration_sec >= 0
    # The result is returned exactly once: the tick must not apply it twice
    assert pool.take(7) is None
    pool.shutdown()


def test_take_is_none_while_running_and_task_is_listed(tmp_path):
    release = threading.Event()

    def runner(cmd, cwd, timeout_sec):
        release.wait(5)
        return VerifyResult(True, "")

    pool = VerifyPool(workers=2, runner=runner)
    pool.submit(3, "job1", "sleep", tmp_path, 60)
    # While the check is running, the tick must see it in running() and not get a result
    _wait_until(lambda: pool.running() == [3])
    assert pool.take(3) is None
    release.set()
    pool.wait(5)
    assert pool.take(3) is not None
    assert pool.running() == []
    pool.shutdown()


def test_duplicate_submit_is_ignored(tmp_path):
    release = threading.Event()
    starts = []

    def runner(cmd, cwd, timeout_sec):
        starts.append(cmd)
        release.wait(5)
        return VerifyResult(True, "")

    pool = VerifyPool(workers=2, runner=runner)
    pool.submit(3, "job1", "first", tmp_path, 60)
    pool.submit(3, "job1", "second", tmp_path, 60)
    _wait_until(lambda: len(starts) == 1)
    release.set()
    pool.wait(5)
    # A second check in the same working copy would fight the first for files
    assert starts == ["first"]
    assert pool.take(3).cmd == "first"
    pool.shutdown()


def test_cancel_discards_running_result(tmp_path):
    release = threading.Event()

    def runner(cmd, cwd, timeout_sec):
        release.wait(5)
        return VerifyResult(True, "")

    pool = VerifyPool(workers=2, runner=runner)
    pool.submit(9, "job1", "sleep", tmp_path, 60)
    _wait_until(lambda: pool.running() == [9])
    pool.cancel(9)
    # The task was cancelled (retry, deletion, manual close): it immediately disappears from running,
    # and the result is no longer needed by anyone
    assert pool.running() == []
    release.set()
    pool.wait(5)
    assert pool.take(9) is None
    pool.shutdown()


def test_cancel_before_start_and_resubmit(tmp_path):
    release = threading.Event()
    runs = []

    def runner(cmd, cwd, timeout_sec):
        runs.append(cmd)
        release.wait(5)
        return VerifyResult(True, "")

    pool = VerifyPool(workers=1, runner=runner)
    pool.submit(1, "job1", "occupy", tmp_path / "a", 60)  # occupies the only thread
    pool.submit(2, "job2", "queued", tmp_path / "b", 60)  # waits in the queue
    pool.cancel(2)
    # After cancel the task can be submitted again, and this is a NEW check
    pool.submit(2, "job3", "again", tmp_path / "b", 60)
    release.set()
    pool.wait(5)
    assert "queued" not in runs and "again" in runs
    assert pool.take(2).job_id == "job3"
    pool.shutdown()


def test_failed_runner_becomes_failed_outcome(tmp_path):
    def runner(cmd, cwd, timeout_sec):
        raise OSError("no such folder")

    pool = VerifyPool(workers=2, runner=runner)
    pool.submit(4, "job1", "make test", tmp_path, 60)
    pool.wait(5)
    outcome = pool.take(4)
    # A failure of the launch itself is a check failure, not silence: otherwise the task would hang in verifying
    assert outcome is not None and not outcome.ok
    assert "no such folder" in outcome.output
    pool.shutdown()


def test_shutdown_kills_running_verify(tmp_path):
    """The server shuts down while `make test` is running: without killing the process the interpreter on
    exit would wait for the worker thread, and `make stop` would hang until the check finishes."""
    from orc.verify import run_verify

    pool = VerifyPool(workers=1, runner=run_verify)
    pool.submit(5, "job1", "sleep 30", tmp_path, 60)
    _wait_until(lambda: (tmp_path / ".orchestrator" / "verify.pid").exists())
    pgid = int((tmp_path / ".orchestrator" / "verify.pid").read_text())
    started = time.monotonic()
    pool.shutdown()
    assert time.monotonic() - started < 5
    # The group is dead: getpgid on a nonexistent leader raises ProcessLookupError
    _wait_until(lambda: not _group_alive(pgid))


def _group_alive(pgid):
    import os
    try:
        return os.getpgid(pgid) == pgid
    except ProcessLookupError:
        return False
