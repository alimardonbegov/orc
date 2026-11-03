"""Verify pool: verify commands run in separate threads, and the tick only hands them out and collects them.

Previously `run_verify` ran directly in the tick and held the whole dispatcher up to verify_timeout_sec
(900 s by default): message delivery, state sync and starting ready tasks stalled for that time.
Now the tick puts a verify into the pool and moves on, and collects the result on one of the
following passes.

The main invariant: a worker thread runs ONLY a subprocess. No access to Repo from here: all
database writes are still done by the tick thread, and the "single writer" model stays in force.
"""
from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor, wait as wait_futures
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from orc.verify import VerifyResult, kill_stale, run_verify

log = logging.getLogger("orc.verify_pool")

Runner = Callable[[str, Path, int], VerifyResult]


@dataclass(frozen=True)
class VerifyOutcome:
    """The result of one verify. job_id travels with the task and back, so the tick can tell
    the result of THE SAME session from the result of a task that has been restarted in the meantime."""
    task_id: int
    job_id: str | None
    ok: bool
    output: str
    cmd: str
    duration_sec: float


@dataclass
class _Job:
    future: Future
    job_id: str | None
    cmd: str
    cwd: Path


class VerifyPool:
    def __init__(self, workers: int = 2, runner: Runner = run_verify) -> None:
        self._executor = ThreadPoolExecutor(max_workers=max(1, workers), thread_name_prefix="orc-verify")
        # Public attribute: tests replace it with an instant or hanging runner
        self.runner = runner
        self._lock = threading.Lock()
        self._jobs: dict[int, _Job] = {}

    def submit(self, task_id: int, job_id: str | None, cmd: str, cwd: Path | str, timeout_sec: int) -> None:
        """Queue a verify. A repeated submit for the same task is ignored: a verify
        is already running, and a second one in the same working copy would fight the first over files."""
        cwd = Path(cwd)
        with self._lock:
            if task_id in self._jobs:
                return
            future = self._executor.submit(self._run, cmd, cwd, timeout_sec)
            self._jobs[task_id] = _Job(future, job_id, cmd, cwd)

    def _run(self, cmd: str, cwd: Path, timeout_sec: int) -> tuple[VerifyResult, float]:
        # A foreign verify that survived a server restart holds the same files, so we remove it
        # before starting our own (see kill_stale).
        try:
            stale = kill_stale(cwd)
            if stale is not None:
                log.warning("killed an orphaned verify pgid=%s in %s", stale, cwd)
        except Exception:
            log.exception("failed to check for an orphaned verify in %s", cwd)
        started = time.monotonic()
        try:
            result = self.runner(cmd, cwd, timeout_sec)
        except Exception as e:
            # A launch failure (no folder, no permissions) is a verify failure, not silence:
            # otherwise the task would stay in verifying forever.
            result = VerifyResult(False, f"failed to start verify: {e}")
        return result, time.monotonic() - started

    def take(self, task_id: int) -> VerifyOutcome | None:
        """The ready result of a task, or None. Returned exactly once."""
        with self._lock:
            job = self._jobs.get(task_id)
            if job is None or not job.future.done():
                return None
            del self._jobs[task_id]
        try:
            result, duration = job.future.result()
        except Exception as e:  # must not get here: _run catches everything itself
            log.exception("verify #%s crashed past the handler", task_id)
            result, duration = VerifyResult(False, f"verify crashed inside the pool: {e}"), 0.0
        return VerifyOutcome(task_id, job.job_id, result.ok, result.output, job.cmd, duration)

    def running(self) -> list[int]:
        with self._lock:
            return sorted(tid for tid, job in self._jobs.items() if not job.future.done())

    def cancel(self, task_id: int) -> None:
        """The result is no longer needed (the task was deleted, closed by hand, sent to retry).

        The entry is removed immediately: running() stops showing it, and a repeated submit starts
        a new verify. A future that has not started yet is simply cancelled; a running one cannot be
        cancelled, but its process is killed via the pid file, and the thread is freed within seconds.
        """
        with self._lock:
            job = self._jobs.pop(task_id, None)
        if job is None:
            return
        if not job.future.cancel():
            self._kill(job)

    def _kill(self, job: _Job) -> None:
        # The window between Popen and writing the pid file is milliseconds; if we hit it, the process
        # will run to the end by itself, and the result is thrown away anyway (the entry is already removed).
        try:
            kill_stale(job.cwd)
        except Exception:
            log.exception("failed to kill the verify in %s", job.cwd)

    def wait(self, timeout: float | None = None) -> None:
        """Wait for all running verifies. Needed by `orc tick` (a one-shot pass must see
        the work through) and by tests."""
        with self._lock:
            futures = [job.future for job in self._jobs.values()]
        wait_futures(futures, timeout=timeout)

    def shutdown(self) -> None:
        """Close the pool together with the server without waiting for verifies.

        We kill running processes instead of just refusing new ones: at exit the interpreter waits
        for ThreadPoolExecutor worker threads, and without this `make stop` (and in the future,
        quitting the app) would hang until the end of a 15-minute `make test`. The result is lost
        deliberately: after a restart the task stays in verifying and the verify runs again.
        """
        with self._lock:
            jobs = list(self._jobs.values())
            self._jobs.clear()
        for job in jobs:
            if not job.future.cancel():
                self._kill(job)
        # wait=True is safe: the processes are already killed, the threads only have to return the result
        self._executor.shutdown(wait=True, cancel_futures=True)
