"""Running the verify command in a task worktree."""
from __future__ import annotations

import os
import signal
import subprocess
from dataclasses import dataclass
from pathlib import Path

# pid of the process group of a running verify. Verify is started with start_new_session=True and
# outlives the server: without this file, `make restart` in the middle of `make test` would leave
# the process chewing CPU forever. The .orchestrator/ directory is already in the repository's info/exclude.
PID_REL_PATH = ".orchestrator/verify.pid"


@dataclass(frozen=True)
class VerifyResult:
    ok: bool
    output: str
    # The process exit code; None when there is none (a timeout kill, a launch failure)
    exit_code: int | None = None
    timed_out: bool = False


def _pid_path(cwd: Path) -> Path:
    return Path(cwd) / PID_REL_PATH


def kill_stale(cwd: Path) -> int | None:
    """Kill the group of a previous verify in this working copy if it is still alive.

    Returns the pgid of the killed group, or None if there was nothing to kill. The file is removed
    in any case: a stale pid must not confuse the next verify.
    """
    path = _pid_path(cwd)
    try:
        pgid = int(path.read_text().strip())
    except (OSError, ValueError):
        return None
    killed: int | None = None
    try:
        # The group leader is alive and leads its own group, so it is our sh -c and not a foreign
        # process that got a reused pid. We do not touch a foreign one.
        if os.getpgid(pgid) == pgid:
            os.killpg(pgid, signal.SIGKILL)
            killed = pgid
    except (ProcessLookupError, PermissionError, OSError):
        pass
    path.unlink(missing_ok=True)
    return killed


def _clear_pid_file(path: Path, pgid: int | None) -> None:
    """Remove OUR OWN pid file. If a verify was killed by cancel and a new one has already started
    in the same copy, the file belongs to it, so we compare the content instead of just deleting."""
    if pgid is None:
        return
    try:
        if path.read_text().strip() == str(pgid):
            path.unlink(missing_ok=True)
    except OSError:
        pass


def run_verify(cmd: str, cwd: Path, timeout_sec: int) -> VerifyResult:
    # Popen with start_new_session=True: verify gets its own process group, and on timeout (or
    # on cancel from the pool) the whole group is killed with its descendants, not just the shell.
    pid_file = _pid_path(cwd)
    pgid: int | None = None
    try:
        # nice: verify is background work, and the owner's interactive work must not slow down because of it.
        # We keep the shell: it is needed for && and pipes in the owners' commands. nice does an exec,
        # so the pid and process group are the same, and killpg on timeout kills the whole tree.
        proc = subprocess.Popen(
            ["nice", "-n", "10", "/bin/sh", "-c", cmd],
            cwd=str(cwd),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        # start_new_session makes the child the leader of its own group, so the group id is its pid. Asking
        # os.getpgid instead raced with a command that exits at once (`true`): ESRCH failed a passing check.
        pgid = proc.pid
        pid_file.parent.mkdir(parents=True, exist_ok=True)
        pid_file.write_text(str(pgid))
        try:
            stdout, stderr = proc.communicate(timeout=timeout_sec)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(pgid, signal.SIGKILL)
            except (ProcessLookupError, OSError):
                pass  # the process has already exited or was not found
            try:
                stdout, stderr = proc.communicate(timeout=1)
            except subprocess.TimeoutExpired:
                stdout, stderr = "", ""
            output = (stdout or "") + (stderr or "")
            if isinstance(output, bytes):
                output = output.decode(errors="replace")
            return VerifyResult(False, f"timeout {timeout_sec}s\n{output}", None, True)
        return VerifyResult(proc.returncode == 0, stdout + stderr, proc.returncode)
    finally:
        _clear_pid_file(pid_file, pgid)
