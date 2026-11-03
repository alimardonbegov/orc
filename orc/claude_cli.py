"""Launching and watching background Claude Code sessions: subprocess + reading ~/.claude/jobs/<id>/state.json."""
from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

JOB_ID_RE = re.compile(r"\b[0-9a-f]{8}\b")
# The launch confirmation line (per the spike results): "backgrounded · <id> · <name>"
# or "backgrounded · <id>". In the "resume a copy" scenario it is preceded by a note line
# with the OLD id: taking the first match over the whole output would land on it.
BACKGROUNDED_LINE_RE = re.compile(r"^backgrounded\b.*$", re.MULTILINE)


class ClaudeCliError(RuntimeError):
    pass


@dataclass(frozen=True)
class JobState:
    state: str            # working | blocked | done | failed | stopped
    detail: str
    needs: str | None     # the question text when state == blocked
    session_id: str | None
    result: str | None
    # The session transcript (~/.claude/projects/<slug>/<sessionId>.jsonl) is the source of the task's tokens,
    # see orc/token_usage.py. None by default: old positional constructors do not break.
    transcript_path: str | None = None
    # The session tempo according to the daemon: active | blocked | idle. Waiting for a human (permission for a
    # tool, AskUserQuestion, plan approval) arrives EXACTLY here: `state` stays
    # "working" meanwhile (verified by spikes, see docs/internals/input-requests.md). None means the field is absent.
    tempo: str | None = None
    # How much background work the session has according to the daemon: the `inFlight` field of state.json without
    # the message queue (background tasks, subagents, monitors). >0 means the harness itself wakes the session
    # when the background work reports back, and a human is not needed for that.
    in_flight: int = 0
    # `inFlight.queued` is messages waiting for their turn. It does NOT cancel the wait: a real
    # message is picked up by the harness right after the turn, and the transcript grows at once (the dispatcher's
    # silence check catches this), while the counter sticks: a message picked up in the middle of
    # a turn (`absorbed_mid_turn`) is not subtracted from it by the daemon.
    queued: int = 0
    # How much of `in_flight` is alarms (`TIMER_IN_FLIGHT_KINDS`): the session's ScheduleWakeup/cron.
    # They will wake the session, but there is no work behind them, so they are no reason to distrust the turn's report.
    timers: int = 0

    @property
    def only_timers(self) -> bool:
        """The turn ended, and the session has only alarms in the background that it set itself.

        This does not count as waiting for a human (`waiting`): the harness will wake the session. But there is
        also no background work behind them whose result could change the report: the agent sets
        ScheduleWakeup as a spare alarm and hands in its report before it fires. The daemon
        keeps the alarm in `inFlight`, and in /loop mode also re-arms a keepalive, so
        the dispatcher's silence ceiling is never reached.
        """
        return self.turn_ended and 0 < self.in_flight <= self.timers

    @property
    def turn_ended(self) -> bool:
        """The session finished its turn and is idle: only a reply (or background work) will move it further.

        Before Claude Code 2.1.292 the daemon wrote the end of a background session's turn into `state`: `done` or
        `blocked` (by text). Since 2.1.293 neither exists: `state` stays "working",
        and `tempo` becomes "idle" (tasks that handed in a report used to hang "in progress").
        In the middle of a turn, including during a long command, `tempo` stays "active".
        """
        return self.state == "blocked" or (self.state == "working" and self.tempo == "idle")

    @property
    def waiting(self) -> bool:
        """The session is idle and waiting for a human.

        Two kinds of waiting: the end of a turn (`turn_ended`): the agent finished its turn and awaits a reply;
        `working` + `tempo == "blocked"` (or a non-empty `needs`): the agent is stuck on an
        interactive dialog: a permission, a question with options, plan approval.

        The end of a turn is not necessarily a question: it can also be the final report. The dispatcher tells them apart by
        the report.json written in that turn. The daemon also sets `blocked` BY TEXT, and
        a reply to a subagent ("please make one more fix before the re-review") looks to it
        exactly like a question to a human. So with live background work we do not count the end of a turn
        as waiting: the subagent's report will wake it.
        The message queue (`queued`) is not included here; see the comment on the field.
        """
        if self.state == "working" and (self.tempo == "blocked" or bool(self.needs)):
            return True
        if self.turn_ended:
            return self.in_flight == 0
        return False

    def idle_sec(self, now: float) -> float | None:
        """How many seconds the session has written nothing to the transcript. None means there is no transcript.

        A live transcript is the most honest sign of a working session: the daemon rewrites `state`/`tempo`
        rarely and with a delay, while the file grows on every message and tool
        call, including while subagents are running.
        """
        if not self.transcript_path:
            return None
        try:
            last = os.stat(self.transcript_path).st_mtime
        except OSError:
            return None
        # Subagents write not to the main transcript but to `<session>/subagents/agent-*.jsonl`:
        # while they work, the main file is silent even though the session is busy.
        subagents = Path(self.transcript_path).with_suffix("") / "subagents"
        try:
            for path in subagents.glob("agent-*.jsonl"):
                last = max(last, path.stat().st_mtime)
        except OSError:
            pass
        return max(0.0, now - last)


def _counter(value: object) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


# Kinds of background work (`inFlight.kinds`) that do not wake the session on their own. `artifact_watch` is
# a subscription to comments on a published artifact: it hangs in `tasks` until the end of the session's life,
# and only a human's comment wakes it, i.e. the same reply. Since Claude Code 2.1.293 the end of a
# turn is working + idle without `done`, and because of this subscription a task that handed in a report together with an
# artifact hung "in progress" until the IN_FLIGHT_STALE_SEC ceiling.
PASSIVE_IN_FLIGHT_KINDS = frozenset({"artifact_watch"})
# `inFlight` fields that do not add up to background work: the message queue is a separate
# counter (`JobState.queued`), and `drainableMonitors` are monitors AMONG `tasks`, not on top of them
# (an artifact subscription gives {tasks: 1, drainableMonitors: 1}).
_NOT_SUMMED_IN_FLIGHT = frozenset({"queued", "tasks", "drainableMonitors"})
# Kinds of background work that wake the session but do nothing themselves: the ScheduleWakeup
# alarm and the session's cron (`session_cron`). Next to them the daemon writes `inFlight.wake`,
# a dict with the firing time; it does not enter the counters (`_counter` takes only integers).
TIMER_IN_FLIGHT_KINDS = frozenset({"session_cron"})


def _in_flight(raw: object) -> int:
    """The session's background work by `inFlight` from state.json: tasks and monitors without the message
    queue and without passive subscriptions (`PASSIVE_IN_FLIGHT_KINDS`). The field format may
    change, so we count only integer values and never fail: it is a hint, not a contract.

    `kinds` may be both a per-task list and a set of kinds: passive ones are subtracted one per
    entry, so with live work next to a subscription the sum stays above zero in both cases."""
    if not isinstance(raw, dict):
        return 0
    kinds = raw.get("kinds")
    passive = sum(1 for k in kinds if k in PASSIVE_IN_FLIGHT_KINDS) if isinstance(kinds, list) else 0
    # Monitors are usually part of `tasks`, but the format is not a contract: a monitor without `tasks` is work too
    tasks = max(_counter(raw.get("tasks")), _counter(raw.get("drainableMonitors")))
    other = sum(_counter(v) for k, v in raw.items() if k not in _NOT_SUMMED_IN_FLIGHT)
    return max(0, tasks - passive) + other


def _timers(raw: object) -> int:
    """Alarms among the background work: `TIMER_IN_FLIGHT_KINDS` entries in `inFlight.kinds`.

    If `kinds` turns out to be a set of kinds rather than a per-task list, two alarms are counted as
    one; then `JobState.only_timers` is false, and the old silence ceiling applies."""
    kinds = raw.get("kinds") if isinstance(raw, dict) else None
    return sum(1 for k in kinds if k in TIMER_IN_FLIGHT_KINDS) if isinstance(kinds, list) else 0


def _queued(raw: object) -> int:
    """Messages in the session's queue: `inFlight.queued` from state.json."""
    return _counter(raw.get("queued")) if isinstance(raw, dict) else 0


def project_slug(cwd: str) -> str:
    """The name of a project's session directory as Claude Code builds it: the path with / . _ replaced by «-»."""
    return re.sub(r"[/._]", "-", cwd)


def parse_job_id(stdout: str) -> str:
    # First look for the "backgrounded" line: it confirms the launch of EXACTLY this
    # call. On a resume of a copy it is preceded by a note line with the old id, so
    # a naive search over the whole output would grab the wrong job id.
    line_match = BACKGROUNDED_LINE_RE.search(stdout)
    if line_match:
        m = JOB_ID_RE.search(line_match.group(0))
        if m:
            return m.group(0)
    # Fallback: there is no "backgrounded" line (for example, synthetic test output):
    # take the first match over the whole output, as before.
    m = JOB_ID_RE.search(stdout)
    if not m:
        raise ClaudeCliError(f"could not find the session id in claude output: {stdout!r}")
    return m.group(0)


class ClaudeCli:
    def __init__(self, bin: str = "claude", jobs_dir: Path | None = None):
        self.bin = bin
        self.jobs_dir = jobs_dir or Path.home() / ".claude" / "jobs"

    # Start and resume hand control to the daemon within seconds; two minutes is a ceiling for the case
    # when the daemon does not respond at all.
    TIMEOUT_SEC = 120

    # Listing sessions is a quick request; a hung daemon must not hold the tick for two minutes.
    LIST_TIMEOUT_SEC = 30

    def _run(self, args: list[str], cwd: Path | None = None, timeout: int | None = None) -> str:
        limit = timeout or self.TIMEOUT_SEC
        try:
            proc = subprocess.run([self.bin, *args], cwd=str(cwd) if cwd else None,
                                  capture_output=True, text=True, timeout=limit)
        except subprocess.TimeoutExpired:
            # A bare TimeoutExpired slips past ClaudeCliError, and the event feed
            # gets an empty string instead of an explanation.
            raise ClaudeCliError(f"claude {' '.join(args[:3])}...: did not finish within {limit} s")
        if proc.returncode != 0:
            raise ClaudeCliError(f"claude {' '.join(args[:3])}...: {proc.stderr.strip() or proc.stdout.strip()}")
        return proc.stdout

    def start_bg(self, cwd: Path, prompt: str, name: str, model: str | None = None,
                 effort: str | None = None, permission_mode: str = "auto",
                 settings: str | None = None) -> str:
        args = ["--bg", "--name", name, "--permission-mode", permission_mode]
        if settings:
            # Message delivery hooks (orc/inbox.py). They travel as a JSON string, not as a file in
            # the user's repository, and end up in the session's saved options; resume_bg
            # picks them up itself, so the flag is not needed there.
            args += ["--settings", settings]
        if model:
            args += ["--model", model]
        if effort:
            args += ["--effort", effort]
        args.append(prompt)
        return parse_job_id(self._run(args, cwd))

    def resume_bg(self, cwd: Path, session_id: str, prompt: str, settings: str | None = None) -> str:
        # Without a session_id there is nothing to resume: previously None went straight into subprocess.run and failed
        # with an obscure TypeError already inside the standard library.
        if not session_id:
            raise ClaudeCliError("resume without a session_id: the session is not known yet, nothing to resume")
        args = ["--bg", "--resume", session_id]
        if settings:
            # A session that reached done/failed is still "running" for the daemon, and a resume creates
            # a COPY without saved options, i.e. without hooks (spike 2026-09-21). The daemon accepts flags for a copy,
            # so we pass the hooks again. For a stopped session
            # we do NOT pass settings: the daemon wakes it with the saved options, and the flags would turn
            # the wake-up into a copy.
            args += ["--settings", settings]
        # A positional prompt together with --resume: verified by a live spike
        return parse_job_id(self._run([*args, prompt], cwd))

    def stop(self, job_id: str) -> None:
        self._run(["stop", job_id])

    def remove(self, job_id: str) -> None:
        self._run(["rm", job_id])

    def list_sessions(self) -> list[dict]:
        """Live daemon sessions (`claude agents --json`): id, kind, state. Others' too: the caller filters."""
        try:
            data = json.loads(self._run(["agents", "--json"], timeout=self.LIST_TIMEOUT_SEC))
        except json.JSONDecodeError as e:
            raise ClaudeCliError(f"claude agents --json: not JSON ({e})")
        if not isinstance(data, list):
            raise ClaudeCliError("claude agents --json: a list was expected")
        return [x for x in data if isinstance(x, dict) and isinstance(x.get("id"), str)]

    def read_state(self, job_id: str) -> JobState | None:
        path = self.jobs_dir / job_id / "state.json"
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text())
        except json.JSONDecodeError:
            # The file may be mid-write by the daemon: assume there is no state yet
            return None
        output = data.get("output") or {}
        return JobState(
            state=str(data.get("state", "")),
            detail=str(data.get("detail") or ""),
            needs=data.get("needs"),
            session_id=data.get("sessionId"),
            result=output.get("result"),
            transcript_path=self._transcript_path(data),
            tempo=str(data["tempo"]) if data.get("tempo") is not None else None,
            in_flight=_in_flight(data.get("inFlight")),
            queued=_queued(data.get("inFlight")),
            timers=_timers(data.get("inFlight")),
        )

    def _transcript_path(self, data: dict) -> str | None:
        """The path to the transcript: the daemon writes it to `linkScanPath`; if the field is absent we build it ourselves
        from cwd and sessionId. The `projects` directory sits next to `jobs` (both inside ~/.claude)."""
        link = data.get("linkScanPath")
        if isinstance(link, str) and link:
            return link
        cwd, session_id = data.get("cwd"), data.get("sessionId")
        if not isinstance(cwd, str) or not isinstance(session_id, str) or not session_id:
            return None
        return str(self.jobs_dir.parent / "projects" / project_slug(cwd) / f"{session_id}.jsonl")
