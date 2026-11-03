import json
from datetime import datetime, timedelta, timezone

from orc.prompt import DEFAULT_TEMPLATE, build_prompt
from orc.quota import (DEFAULT_QUOTA_PATTERNS, RESET_BUFFER_SEC, is_quota_error,
                       reset_retry_at, retry_delay_minutes)
from orc.report import REPORT_REL_PATH, Report, read_report
from orc.verify import run_verify


def test_build_prompt_substitutes_and_keeps_braces_in_description():
    text = build_prompt(DEFAULT_TEMPLATE, title="T", description="code {x: 1}", branch="orc/task-1",
                        target_branch="dev", verify_cmd="pytest", report_path=".orchestrator/report.json")
    assert "# Task: T" in text
    assert "code {x: 1}" in text
    assert "orc/task-1" in text and "dev" in text and "pytest" in text
    assert "{title}" not in text


def test_build_prompt_unknown_placeholder_is_kept():
    assert build_prompt("a {unknown} b", title="", description="", branch="", target_branch="",
                        verify_cmd="", report_path="") == "a {unknown} b"


def test_read_report(tmp_path):
    assert read_report(tmp_path) is None
    p = tmp_path / REPORT_REL_PATH
    p.parent.mkdir()
    p.write_text("not json")
    assert read_report(tmp_path) is None
    p.write_text(json.dumps({"status": "success", "summary": "ok"}))
    assert read_report(tmp_path) == Report(status="success", summary="ok", notes="")
    p.write_text(json.dumps({"status": "weird"}))
    assert read_report(tmp_path).status == "failed"


def test_quota_detection():
    assert is_quota_error("You've hit your usage limit, resets at 3pm") is True
    assert is_quota_error("Rate limit exceeded") is True
    assert is_quota_error("TypeError: x is undefined") is False
    assert is_quota_error("custom words", ["custom"]) is True
    assert DEFAULT_QUOTA_PATTERNS


def test_retry_delay_grows_and_caps():
    assert [retry_delay_minutes(i) for i in range(4)] == [30, 60, 120, 120]


def test_run_verify_ok_and_fail_and_timeout(tmp_path):
    ok = run_verify("echo hi && true", tmp_path, 5)
    assert ok.ok is True and "hi" in ok.output
    bad = run_verify("echo boom >&2; exit 3", tmp_path, 5)
    assert bad.ok is False and "boom" in bad.output
    slow = run_verify("sleep 3", tmp_path, 1)
    assert slow.ok is False and "timeout" in slow.output


def test_run_verify_runs_with_lowered_priority(tmp_path):
    import os
    from orc.verify import run_verify
    # The base nice depends on the environment (tests may run under nice), so we compare against it:
    # the check must be at +10 relative to the parent.
    base = os.getpriority(os.PRIO_PROCESS, 0)
    res = run_verify("ps -o nice= -p $$", tmp_path, 10)
    assert res.ok and res.output.strip() == str(base + 10)


def test_read_report_non_dict_json_returns_none(tmp_path):
    """read_report must safely return None on non-object JSON."""
    p = tmp_path / REPORT_REL_PATH
    p.parent.mkdir()

    # List instead of an object
    p.write_text(json.dumps([1, 2, 3]))
    assert read_report(tmp_path) is None

    # String instead of an object
    p.write_text(json.dumps("not an object"))
    assert read_report(tmp_path) is None

    # null instead of an object
    p.write_text(json.dumps(None))
    assert read_report(tmp_path) is None

    # Number instead of an object
    p.write_text(json.dumps(42))
    assert read_report(tmp_path) is None


def test_run_verify_no_orphan_processes_on_timeout(tmp_path):
    """run_verify on timeout must kill the whole process group, including children.

    The test has two parts:
    1. Control: make sure the marker in argv is really caught by pgrep
    2. Check: make sure run_verify kills it
    """
    import subprocess
    import time
    import uuid
    import os
    import signal

    # Marker in argv (not swallowed by a comment)
    marker = f"orc-orphan-{uuid.uuid4().hex[:8]}"
    # Compound command: python sleeps 5 sec, marker in argv, then echo
    cmd = f'python3 -c "import time; time.sleep(5)" {marker} && echo done'

    # === Part 1: Control ===
    # Make sure the marker is really caught by pgrep while the process is alive
    proc = subprocess.Popen(cmd, shell=True, start_new_session=True)
    time.sleep(0.3)  # Give the process time to start

    check_alive = subprocess.run(["pgrep", "-f", marker], capture_output=True)
    if check_alive.returncode != 0:
        # Process not found: the test is broken, the check does not work
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, OSError):
            pass
        raise AssertionError(
            f"Control: marker '{marker}' is not caught by pgrep. "
            f"The check is broken, not the code. Command: {cmd}"
        )

    # Kill the test process
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, OSError):
        pass

    # === Part 2: The check itself ===
    # Call run_verify, an error must come back
    result = run_verify(cmd, tmp_path, 1)

    assert result.ok is False, "run_verify must return ok=False on timeout"
    assert "timeout" in result.output, "The output must mention the timeout"

    # Give time for cleanup
    time.sleep(0.3)

    # Check that the process is now dead (the marker is not caught)
    check_dead = subprocess.run(["pgrep", "-f", marker], capture_output=True)
    assert check_dead.returncode != 0, (
        f"After run_verify the process with marker '{marker}' is still alive. "
        f"The group was not killed correctly."
    )


def test_kill_stale_kills_surviving_group(tmp_path):
    """A check survives the server's death: start_new_session detaches it from the orc process.
    kill_stale must remove such a copy before starting a new one."""
    import os
    import subprocess
    import time

    from orc.verify import PID_REL_PATH, kill_stale

    proc = subprocess.Popen(["sleep", "30"], start_new_session=True)
    pgid = os.getpgid(proc.pid)
    pid_file = tmp_path / PID_REL_PATH
    pid_file.parent.mkdir(parents=True, exist_ok=True)
    pid_file.write_text(str(pgid))

    killed = kill_stale(tmp_path)
    # On macOS a zombie process is removed from the kernel table almost immediately after SIGKILL, and a repeated
    # os.getpgid(proc.pid) after kill_stale races with that cleanup, so we compare with the pgid
    # taken BEFORE the kill instead of re-reading it.
    assert killed == pgid
    for _ in range(100):
        if proc.poll() is not None:
            break
        time.sleep(0.05)
    assert proc.poll() is not None
    assert not pid_file.exists()
    # A repeated call on an empty spot is safe and finds nothing
    assert kill_stale(tmp_path) is None


def test_kill_stale_ignores_reused_pid(tmp_path):
    """A pid from the file may end up belonging to another process. Our group leader always leads ITS OWN
    group (start_new_session), a foreign process with the same pid almost never does."""
    import os

    from orc.verify import PID_REL_PATH, kill_stale

    pid_file = tmp_path / PID_REL_PATH
    pid_file.parent.mkdir(parents=True, exist_ok=True)
    # The current pytest process is alive, but is usually not the leader of its own group
    if os.getpgid(os.getpid()) == os.getpid():
        import pytest
        pytest.skip("pytest itself turned out to be a group leader, the scenario cannot be reproduced")
    pid_file.write_text(str(os.getpid()))
    assert kill_stale(tmp_path) is None
    assert not pid_file.exists()


def test_run_verify_writes_and_clears_pid_file(tmp_path):
    from orc.verify import PID_REL_PATH, run_verify

    result = run_verify("true", tmp_path, 5)
    assert result.ok
    # The file lives only while the check runs: if left behind, it would make the next
    # check kill a foreign process with a reused pid
    assert not (tmp_path / PID_REL_PATH).exists()


def test_run_verify_leaves_foreign_pid_file_alone(tmp_path):
    """A check was killed by cancel, and a new one has already started in the same copy: the killed
    check must not touch its pid file."""
    from orc.verify import PID_REL_PATH, run_verify

    pid_file = tmp_path / PID_REL_PATH
    # The command itself replaces the pid file with a "foreign" value before run_verify reaches finally
    result = run_verify(f"echo 999999 > {pid_file}", tmp_path, 5)
    assert result.ok
    assert pid_file.read_text().strip() == "999999"


def test_build_prompt_template_json_braces_preserved():
    """build_prompt(DEFAULT_TEMPLATE, ...) must preserve the single braces of the JSON example."""
    text = build_prompt(
        DEFAULT_TEMPLATE,
        title="TestTask",
        description="Do something",
        branch="orc/fix-1",
        target_branch="main",
        verify_cmd="pytest tests/",
        report_path=".orchestrator/report.json"
    )

    # The JSON example must have single braces
    assert '{"status":' in text or '{ "status":' in text or '{\"status\":' in text, \
        f"JSON not found or incorrectly escaped in the result:\n{text}"

    # No double braces ({{ or }}) should remain
    assert "{{" not in text, "Double opening braces remain"
    assert "}}" not in text, "Double closing braces remain"


def _usage(resets_at, *, available=True, stale=False):
    """The usage.read() response in the form the dispatcher sees it."""
    return {"available": available, "stale": stale, "source": "probe", "model": None,
            "five_hour": None if resets_at is None else {
                "used_percentage": 100.0, "resets_at": resets_at, "measured_at": 0.0, "source": "probe"},
            "seven_day": None, "updated_at": 0.0}


def test_reset_retry_at_uses_real_window_reset_with_buffer():
    now = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)
    resets_at = (now + timedelta(minutes=40)).timestamp()
    assert reset_retry_at(now, _usage(resets_at)) == now + timedelta(minutes=40, seconds=RESET_BUFFER_SEC)


def test_reset_retry_at_returns_none_without_trustworthy_limits():
    now = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)
    soon = (now + timedelta(minutes=40)).timestamp()
    assert reset_retry_at(now, None) is None
    assert reset_retry_at(now, _usage(soon, available=False)) is None
    assert reset_retry_at(now, _usage(soon, stale=True)) is None  # the numbers went stale, so it is no longer a fact
    assert reset_retry_at(now, _usage(None)) is None  # there is no window at all
    assert reset_retry_at(now, _usage("tomorrow")) is None  # garbage instead of an epoch
    # A reset in the past and a reset implausibly far away: in both cases a blind backoff is better
    # than a retry in the same tick (burns an attempt of QUOTA_RETRY_LIMIT) or a freeze for a day.
    assert reset_retry_at(now, _usage((now - timedelta(minutes=5)).timestamp())) is None
    assert reset_retry_at(now, _usage((now + timedelta(days=1)).timestamp())) is None


def test_reset_retry_at_matches_naive_now():
    # Tests and old callers may pass a naive time: the result must be comparable
    # with now(), otherwise the comparison in _retry_quota fails with TypeError.
    now = datetime(2026, 1, 1, 12, 0)
    moment = reset_retry_at(now, _usage((now + timedelta(minutes=40)).astimezone().timestamp()))
    assert moment is not None and moment.tzinfo is None and moment > now
