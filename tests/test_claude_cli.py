import json
import os
import stat

import pytest

from orc.claude_cli import ClaudeCli, ClaudeCliError, JobState, parse_job_id


@pytest.fixture
def fake_bin(tmp_path):
    """A script instead of claude: writes the arguments to a log and prints an id."""
    log = tmp_path / "calls.log"
    script = tmp_path / "claude"
    script.write_text(
        "#!/bin/sh\n"
        f"printf '%s\\n' \"$@\" >> {log}\n"
        "echo 'Started background session ab12cd34 (attach with claude attach ab12cd34)'\n"
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return script, log


def test_parse_job_id():
    assert parse_job_id("Started ab12cd34 (claude attach ab12cd34)") == "ab12cd34"
    with pytest.raises(ClaudeCliError):
        parse_job_id("no id here")


def test_parse_job_id_real_bg_output():
    # Real output format of `claude --bg` (Claude Code 2.1.278):
    # the first line is "backgrounded · <id> · <name>", then four hint lines
    # with the same id. The regex takes the first match.
    stdout = (
        "backgrounded · 5ccbca44 · orc-spike\n"
        "  claude agents             list sessions\n"
        "  claude attach 5ccbca44    open in this terminal\n"
        "  claude logs 5ccbca44      show recent output\n"
        "  claude stop 5ccbca44      stop this session\n"
    )
    assert parse_job_id(stdout) == "5ccbca44"


def test_parse_job_id_resume_copy_scenario():
    # Real output of `claude --bg --resume <sid> "..."` when the daemon considers the original
    # session still alive: it starts a COPY under a new id and prints a note with the OLD id
    # before the "backgrounded" line. A naive "first 8-hex match" would grab
    # the old, already stopped job id, which is exactly the defect being fixed.
    stdout = (
        "note: session 5ccbca44 is already running in the background, so this "
        "started a copy as b943c993. `claude attach 5ccbca44` opens the original.\n"
        "backgrounded · b943c993\n"
        "  claude agents             list sessions\n"
        "  claude attach b943c993    open in this terminal\n"
        "  claude logs b943c993      show recent output\n"
        "  claude stop b943c993      stop this session\n"
    )
    assert parse_job_id(stdout) == "b943c993"


def test_resume_bg_returns_new_id_on_copy(tmp_path):
    # resume_bg must return the id of the live COPY (b943c993), not of the old session
    # (5ccbca44) mentioned in the note line before "backgrounded".
    script = tmp_path / "claude"
    script.write_text(
        "#!/bin/sh\n"
        "printf 'note: session 5ccbca44 is already running in the background, "
        "so this started a copy as b943c993. `claude attach 5ccbca44` opens the original.\\n'\n"
        "printf 'backgrounded \\xc2\\xb7 b943c993\\n'\n"
        "printf '  claude agents             list sessions\\n'\n"
        "printf '  claude attach b943c993    open in this terminal\\n'\n"
        "printf '  claude logs b943c993      show recent output\\n'\n"
        "printf '  claude stop b943c993      stop this session\\n'\n"
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    cli = ClaudeCli(bin=str(script), jobs_dir=tmp_path / "jobs")
    job = cli.resume_bg(cwd=tmp_path, session_id="5ccbca44-...", prompt="continue")
    assert job == "b943c993"


def test_start_bg_builds_flags(fake_bin, tmp_path):
    script, log = fake_bin
    cli = ClaudeCli(bin=str(script), jobs_dir=tmp_path / "jobs")
    job = cli.start_bg(cwd=tmp_path, prompt="do X", name="orc#1 X", model="opus", effort="high", permission_mode="auto")
    assert job == "ab12cd34"
    args = log.read_text().splitlines()
    assert args[:1] == ["--bg"]
    assert "--name" in args and args[args.index("--name") + 1] == "orc#1 X"
    assert args[args.index("--model") + 1] == "opus"
    assert args[args.index("--effort") + 1] == "high"
    assert args[args.index("--permission-mode") + 1] == "auto"
    assert "--settings" not in args  # without settings the flag does not appear
    assert args[-1] == "do X"


def test_start_bg_passes_hook_settings(fake_bin, tmp_path):
    # Delivery hooks are attached to the session at launch: no files are created in the user's
    # repository by the orchestrator, everything goes as a JSON string in an argument.
    from orc import inbox
    script, log = fake_bin
    cli = ClaudeCli(bin=str(script), jobs_dir=tmp_path / "jobs")
    cli.start_bg(cwd=tmp_path, prompt="do X", name="orc#1 X", settings=inbox.hook_settings_json())
    args = log.read_text().splitlines()
    import json as _json
    passed = _json.loads(args[args.index("--settings") + 1])
    assert set(passed["hooks"]) == {"PostToolUse", "Stop"}


def test_resume_bg_and_stop(fake_bin, tmp_path):
    script, log = fake_bin
    cli = ClaudeCli(bin=str(script), jobs_dir=tmp_path / "jobs")
    job = cli.resume_bg(cwd=tmp_path, session_id="sid-1", prompt="continue")
    assert job == "ab12cd34"
    cli.stop("ab12cd34")
    args = log.read_text().splitlines()
    assert "--resume" in args and args[args.index("--resume") + 1] == "sid-1"
    assert args[-2:] == ["stop", "ab12cd34"]


def test_read_state(tmp_path):
    jobs = tmp_path / "jobs"
    (jobs / "ab12cd34").mkdir(parents=True)
    (jobs / "ab12cd34" / "state.json").write_text(json.dumps({
        "state": "blocked", "detail": "waiting", "needs": "Which port?",
        "sessionId": "sid-1", "output": {"result": "..."},
    }))
    cli = ClaudeCli(bin="claude", jobs_dir=jobs)
    st = cli.read_state("ab12cd34")
    assert st == JobState(state="blocked", detail="waiting", needs="Which port?", session_id="sid-1", result="...")
    assert cli.read_state("missing") is None


def test_read_state_transcript_path_from_link_scan_path(tmp_path):
    jobs = tmp_path / "jobs"
    (jobs / "ab12cd34").mkdir(parents=True)
    (jobs / "ab12cd34" / "state.json").write_text(json.dumps({
        "state": "working", "sessionId": "sid-1",
        "linkScanPath": "/somewhere/projects/-x/sid-1.jsonl", "cwd": "/x",
    }))
    st = ClaudeCli(bin="claude", jobs_dir=jobs).read_state("ab12cd34")
    assert st.transcript_path == "/somewhere/projects/-x/sid-1.jsonl"


def test_read_state_transcript_path_fallback_by_cwd_slug(tmp_path):
    # Without linkScanPath the path is derived the way Claude Code builds it: the directory
    # ~/.claude/projects/<cwd with / . _ replaced by ->/<sessionId>.jsonl, where ~/.claude is the parent of jobs.
    jobs = tmp_path / "claude" / "jobs"
    (jobs / "ab12cd34").mkdir(parents=True)
    (jobs / "ab12cd34" / "state.json").write_text(json.dumps({
        "state": "working", "sessionId": "sid-1", "cwd": "/Users/me/Projects/my_project/.claude/worktrees/orc-task-2",
    }))
    st = ClaudeCli(bin="claude", jobs_dir=jobs).read_state("ab12cd34")
    assert st.transcript_path == str(
        tmp_path / "claude" / "projects" / "-Users-me-Projects-my-project--claude-worktrees-orc-task-2" / "sid-1.jsonl"
    )
    (jobs / "ab12cd34" / "state.json").write_text(json.dumps({"state": "working", "cwd": "/x"}))
    assert ClaudeCli(bin="claude", jobs_dir=jobs).read_state("ab12cd34").transcript_path is None


def test_claude_timeout_becomes_cli_error(monkeypatch, tmp_path):
    import subprocess

    def slow_run(args, **kwargs):
        raise subprocess.TimeoutExpired(args, 120)

    monkeypatch.setattr(subprocess, "run", slow_run)
    with pytest.raises(ClaudeCliError) as e:
        ClaudeCli(jobs_dir=tmp_path).stop("job1")
    assert "did not finish" in str(e.value)


def test_list_sessions_parses_agents_json(monkeypatch):
    cli = ClaudeCli()
    monkeypatch.setattr(cli, "_run", lambda args, cwd=None, timeout=None: '[{"id":"ab12cd34","kind":"background","state":"working"},'
                                                           ' {"kind":"interactive"}, 5]')
    assert cli.list_sessions() == [{"id": "ab12cd34", "kind": "background", "state": "working"}]


def test_list_sessions_uses_short_timeout(monkeypatch):
    """Listing sessions is a quick request: 30 s, not the two-minute start ceiling."""
    import subprocess
    seen = {}

    def fake_run(args, **kwargs):
        seen["timeout"] = kwargs["timeout"]
        return subprocess.CompletedProcess(args, 0, stdout="[]", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    assert ClaudeCli().list_sessions() == []
    assert seen["timeout"] == 30
