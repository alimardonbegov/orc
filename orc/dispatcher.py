"""The dispatcher loop. One tick() = one pass over all steps. External effects only through git_ops and cli."""
from __future__ import annotations

import json
import logging
import threading
import time
from collections import Counter
from contextlib import contextmanager
from dataclasses import asdict, replace
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable

from orc import (branches, forecast, git_ops, inbox, inputs, projects as project_paths, routines, schedule, trust,
                 usage, worktrees)
from orc import machine
from orc.machine import MachineLoad
from orc.attachments import AttachmentStore, expand_description
from orc.claude_cli import ClaudeCliError, JobState
from orc.config import Settings
from orc.db import ledger_cost
from orc.models import Blocker, Project, Task, TaskStatus
from orc.prompt import DEFAULT_TEMPLATE, UNTRUSTED_NOTE, UNTRUSTED_OPEN, build_prompt, quote_untrusted
from orc.quota import DEFAULT_QUOTA_PATTERNS, is_quota_error, reset_retry_at, retry_delay_minutes
from orc.report import REPORT_REL_PATH, drop_report, read_report
from orc import token_usage, transcript
from orc.claude_cli import project_slug
from orc.delivery import DELIVERY_STALL_TICKS, MessageDelivery  # noqa: F401  tests import the constant from here
from orc.merging import CONFLICT_RETRY_LIMIT, Merger  # noqa: F401  tests import the constant from here
from orc.repo import Repo
from orc.scheduler import ready_tasks
# Re-export: RESUME_AFTER_CRASH and RESUMABLE_STATES are needed by the dispatcher itself, the rest by tests
# and by code that imported them from here before the split
from orc.sessions import (  # noqa: F401
    RESUMABLE_STATES, RESUME_AFTER_CRASH, STOP_TERMINAL_STATES, STOP_WAIT_ATTEMPTS, STOP_WAIT_BASE_SEC,
    SessionRunner,
)
from orc.util import utc_now
from orc.verify_pool import VerifyOutcome, VerifyPool

log = logging.getLogger("orc.dispatcher")

# This many ticks in a row we tolerate a missing state.json for an in_progress task before
# considering the session lost. 5 ticks is 2.5 minutes at the default poll_interval_sec=30:
# enough to survive a race with the daemon writing the file, and short enough that the slot does not hang forever.
STATE_LOST_TICKS = 5
# Ceiling on the quota retries of one task. After that it is failed: otherwise a false positive of the regex
# on the detail text spins the task endlessly and it never becomes failed.
QUOTA_RETRY_LIMIT = 5
# How often to even check whether it is time to clean the feed. Retention is not urgent work,
# and a DELETE over a big table takes noticeable time.
CLEANUP_INTERVAL_SEC = 24 * 60 * 60
# How often to look for merged tasks whose working copies are due for cleanup. No need to do it more often: each
# check is git merge-base and git status over the candidates. Less often and "0 days" stops meaning
# "right after the merge".
WORKTREE_CLEANUP_INTERVAL_SEC = 5 * 60
# How many days a merged task's working copy lives for the sake of "Rework" if the owner
# did not set their own value (the worktree_retention_days setting).
WORKTREE_RETENTION_DAYS = 7
# Session reaper: once every 5 minutes it reconciles the daemon's live sessions with the database and shuts down the extra ones. The batch
# is limited so that the first pass after a rollout (dozens of hanging sessions) does not hold the tick for minutes.
SESSION_REAP_INTERVAL_SEC = 300
SESSION_REAP_BATCH = 20

# For how many seconds after an answer to an input request not to trust the wait from state.json: the daemon rewrites
# tempo/needs with a delay (over 30 s in the spike), and without this pause the "waiting for permission" badge
# would come back to the card right after the owner granted the permission.
INPUT_ANSWER_GRACE_SEC = 120

# For this many seconds a session must be silent (write nothing to the transcript) for the wait
# from state.json to be believed. The daemon judges waiting by the text at the end of a turn and by its own tempo,
# and it is wrong: a session with subagents looks idle while a subagent thinks. A live transcript
# catches this error. 90 seconds is three default ticks: shorter than a real human wait
# (minutes and hours) and longer than any pause between tool calls.
WAITING_QUIET_SEC = 90
# How many seconds of session silence at the end of a turn we tolerate with a non-zero `inFlight` before
# ceasing to believe that background work will wake it. The daemon's counters stick (an uncleared
# queue; a perpetual artifact_watch is not counted as background work
# at all, see claude_cli.PASSIVE_IN_FLIGHT_KINDS), and without a ceiling the task hangs "in progress"
# forever. Subagents break the silence with their transcripts, so the ceiling is about background
# commands and monitors: 15 minutes without a single line is longer than any reasonable pause, but short
# for a stuck card. If wrong, the badge clears itself as soon as the transcript grows again.
IN_FLIGHT_STALE_SEC = 15 * 60
# Ceiling on the wait text on a card: the agent's final message can be a couple of screens long,
# and blocker_detail goes into every API response with a task list.
WAITING_DETAIL_LIMIT = 4000

# Which statuses a card may be closed from by hand. Working statuses: the dispatcher moves the task
# in them, and if it is stuck there (the session is silent and automation could not declare it
# lost), without a manual exit the card hangs forever and holds a worker slot.
# failed is here too: a task that did not make it is also not obliged to go through retry/resume;
# it can simply be closed by hand, like any other.
FORCE_DONE_FROM = (TaskStatus.IN_PROGRESS, TaskStatus.VERIFYING, TaskStatus.MERGING, TaskStatus.FAILED)

# Working statuses: behind a task in them stand a live session and a busy worker slot. Removing
# such a card from the board (to the archive or for good) means cutting the work off halfway,
# so archiving from there is forbidden, and deletion requires explicit confirmation. failed is
# not included: the session is gone, and archive/deletion are allowed for it without force anyway.
WORKING_STATUSES = (TaskStatus.IN_PROGRESS, TaskStatus.VERIFYING, TaskStatus.MERGING)

# How long an owner command is ready to wait for a busy dispatcher. Longer and the HTTP request
# hangs; shorter and the refusal arrives on every long pass.
COMMAND_LOCK_TIMEOUT_SEC = 10


class DispatcherBusy(RuntimeError):
    """The dispatcher is busy with another pass for longer than the command is ready to wait."""


def _human_duration(seconds: float) -> str:
    # "0.0 min" for a five-second check looks like a counting error
    return f"{seconds:.0f} s" if seconds < 90 else f"{seconds / 60:.1f} min"


class Dispatcher:
    def __init__(self, repo: Repo, settings: Settings, cli, now: Callable[[], datetime] = utc_now,
                 sleep: Callable[[float], None] = time.sleep, verify_pool: VerifyPool | None = None,
                 machine_sampler: Callable[[], MachineLoad] = machine.sample):
        self.repo = repo
        self.settings = settings
        self.cli = cli
        self.attachments = AttachmentStore(repo, settings.data_dir / "attachments")
        self.now = now
        self.sleep = sleep
        self.last_tick: str | None = None
        # Metrics of the last pass. Without them the only way to understand where the
        # dispatcher got stuck is grepping a megabyte-sized log.
        self.last_tick_duration_sec: float | None = None
        self.last_tick_steps: dict[str, float] = {}
        self.tick_error_count = 0
        # The session log appeared later than tasks: old cards are brought up once per process
        self._usage_backfilled = False
        # When the limit history was last topped up (monotonic): see _record_limits
        self._limits_recorded_at: float | None = None
        # When working copies for cleanup were last looked for (by self.now): see _cleanup_worktrees
        self._worktrees_checked_at: datetime | None = None
        # Session reaper (_reap_sessions): when it last ran (monotonic), how many live sessions it saw, how many it shut down
        self._reaped_at: float | None = None
        self.sessions_alive: int | None = None
        self.reaped_total = 0
        # The start gate (_start_ready): replaced in tests, otherwise the outcome would depend on the machine's load
        self.machine_sampler = machine_sampler
        self.start_blocked_reason: str | None = None
        # The reason kind ("load"/"mem"): events are written on its change, not on a change of text with live numbers
        self._start_blocked_kind: str | None = None
        self.last_machine: MachineLoad | None = None
        # A pass triggered by the "Run now" button is in progress: the load gate does not hold it (see _start_ready)
        self._manual_tick = False
        # One lock for the whole dispatcher state. A tick must go strictly one at a time (two git merges
        # in one copy, two worktrees for one task), but owner commands must not
        # overlap with a pass either: a reply to a task exactly during the delivery step produced TWO
        # `claude --resume` in one worktree. An RLock, not a Lock: the tick calls deliver_messages,
        # which takes the lock again, and with a plain Lock the thread would block on itself.
        self._lock = threading.RLock()
        # Verification pool: verify no longer runs in the tick. The number of workers is read once
        # at creation: changing the setting requires a restart, and the UI says so.
        self.verify_pool = verify_pool or VerifyPool(
            workers=self._int_setting("verify_workers", 2, minimum=1))
        self.sessions = SessionRunner(repo, cli, settings, self._event, sleep=sleep)
        self.delivery = MessageDelivery(repo, cli, self.sessions, self._event)
        self.merger = Merger(repo, settings, self.sessions, self._event, self.now, self.with_images, self._fail)

    def with_images(self, text: str) -> str:
        """Owner text -> text for the session: image markers are expanded into paths on disk.

        Everything that goes into the session as text is run through it (the task statement, the conflict prompt,
        a queued message), and nothing that stays on the board: in a comment and in
        the task description the marker must survive, otherwise the card stops rendering the image.
        """
        return expand_description(text, self.attachments.resolve)

    # ---------- public ----------

    @contextmanager
    def _exclusive(self, timeout: float | None):
        """Exclusive access to the dispatcher state. None means wait as long as needed."""
        acquired = self._lock.acquire(timeout=-1 if timeout is None else timeout)
        if not acquired:
            raise DispatcherBusy("the dispatcher is busy with another operation, repeat the request")
        try:
            yield
        finally:
            self._lock.release()

    def tick(self) -> None:
        """A dispatcher pass. Waits if a pass is already running (the background thread)."""
        with self._exclusive(None):
            self._run_steps()

    def try_tick(self, manual: bool = False) -> bool:
        """An on-demand pass (HTTP). False if a pass is already running: the caller returns 409.

        manual is a pass triggered by the owner's button: ready tasks start even if the load gate
        holds them. Pause, quota and worker limits apply as usual."""
        if not self._lock.acquire(blocking=False):
            return False
        try:
            self._manual_tick = manual
            self._run_steps()
        finally:
            self._manual_tick = False
            self._lock.release()
        return True

    def _run_steps(self) -> None:
        # Delivery goes FIRST: for a stopped session with a message in the queue the resume must
        # go out with the owner's text, not with the routine "the session was interrupted" from _sync_running.
        started = time.monotonic()
        steps: dict[str, float] = {}
        for step in (self._backfill_usage, self._deliver_outbox, self._sync_running, self._retry_quota,
                     self._process_verifying, self._process_merging, self._expire_schedules, self._spawn_routines,
                     self._start_ready,
                     self._cleanup, self._cleanup_worktrees, self._reap_sessions, self._record_limits):
            step_started = time.monotonic()
            try:
                step()
            except Exception as e:  # a whole step must not bring the tick down
                self.tick_error_count += 1
                log.exception("step %s failed", step.__name__)
                # An event, not just a log: a silently dead step looks to the owner like
                # an immobile board with no explanation at all.
                try:
                    self.repo.add_event(f"dispatcher step {step.__name__} failed: {e}", level="error")
                except Exception:
                    log.exception("could not record the step failure event for %s", step.__name__)
            finally:
                steps[step.__name__] = round(time.monotonic() - step_started, 3)
        self.last_tick_steps = steps
        self.last_tick_duration_sec = round(time.monotonic() - started, 3)
        self.last_tick = self._now_iso()

    def status(self) -> dict:
        return {
            "paused": self.repo.get_setting("dispatcher_paused", "0") == "1",
            "quota_retry_after": self.repo.get_setting("quota_retry_after"),
            "running": len(self.repo.list_tasks(status=TaskStatus.IN_PROGRESS)),
            "last_tick": self.last_tick,
            "last_tick_duration_sec": self.last_tick_duration_sec,
            "last_tick_steps": self.last_tick_steps,
            "tick_error_count": self.tick_error_count,
            "verifying_now": self.verify_pool.running(),
            "sessions_alive": self.sessions_alive,
            "reaped_total": self.reaped_total,
            "load_avg": self.last_machine.load1 if self.last_machine else None,
            "free_mem_pct": self.last_machine.free_mem_pct if self.last_machine else None,
            "start_blocked_reason": self.start_blocked_reason,
        }

    # ---------- step: sync of running tasks ----------

    def _sync_running(self) -> None:
        for task in self.repo.list_tasks(status=TaskStatus.IN_PROGRESS):
            if task.blocker == Blocker.QUOTA:
                continue
            try:
                # read_state is inside the try too: it may raise (for example, OSError in a race
                # with the job directory being deleted), and a failure of one task must not interrupt the sync
                # of the other tasks in this tick.
                st = self.cli.read_state(task.job_id) if task.job_id else None
                if st is None:
                    # The state could not be read: either the daemon has not written the file yet, or the job
                    # is gone. One cannot be told from the other, so we count consecutive
                    # misses and after the threshold declare the session lost; otherwise the task
                    # hangs in in_progress forever and permanently occupies a worker slot.
                    self._count_state_miss(task)
                    continue
                if task.state_miss_count:
                    task = self.repo.update_task(task.id, state_miss_count=0)
                self._apply_state(task, st)
            except Exception:
                log.exception("sync of task #%s", task.id)

    def _count_state_miss(self, task: Task) -> None:
        misses = task.state_miss_count + 1
        if misses < STATE_LOST_TICKS:
            self.repo.update_task(task.id, state_miss_count=misses)
            return
        detail = (f"session state lost: state.json has been unavailable for {misses} ticks in a row. "
                  f"The session can be restarted with the 'Retry' button.")
        self.sessions.close_input_requests(task)
        self.repo.update_task(task.id, status=TaskStatus.FAILED, state_miss_count=0,
                              blocker=None, blocker_detail=detail)
        # The state is lost, but the session process may have outlived state.json, so shut it down.
        self.sessions.release(task, "session state lost")
        self._event(task, f"#{task.id}: {detail}", "warn")

    def _apply_state(self, task: Task, st: JobState) -> None:
        if st.session_id and st.session_id != task.session_id:
            # We must re-read the task: below _handle_failure will resume by
            # task.session_id, and on a stale object the resume would go by a stale (or missing)
            # id.
            task = self.repo.update_task(task.id, session_id=st.session_id)
        # Count tokens BEFORE the status transition: in done/failed/stopped the transcript is already complete,
        # while in sync the task may no longer appear after this tick.
        self._collect_usage(task, st)
        stopped = st.waiting or self._background_stale(st)
        # An alarm that the session set for itself does not count as waiting (the harness will wake it),
        # but it does not cancel the turn's report either: there is no work behind it whose result would change the report.
        if (stopped or st.only_timers) and self._session_quiet(st):
            # Fallback channel: the wait is visible from state.json (end of turn is blocked or working with
            # tempo=idle, or working with tempo=blocked or needs). The primary one is the hook, which itself
            # registers the request (request_input) and sets the badge before the daemon finishes writing
            # state.json; then we change nothing here.
            turn = transcript.read_last_turn(st.transcript_path) if st.turn_ended else None
            if self._reported_this_turn(task, turn):
                # report.json is the last action per the prompt: once it is written in this turn, the work
                # is handed in. The daemon sets `blocked` by text, and a final report with a list of "what is needed
                # from you" is a question to it. And since Claude Code 2.1.293 there is no `done`
                # at all: the end of any turn is working + idle.
                why = "the daemon marked it as waiting for reply" if st.state == "blocked" else "the daemon did not mark it as finished"
                self._event(task, f"#{task.id}: the session ended its turn with a report, treating it as finished, "
                                  f"although {why}")
                self._session_done(task)
                return
            if stopped:
                if task.blocker != Blocker.NEEDS_INPUT and not self._recently_answered(task):
                    detail = self._waiting_detail(st, turn)
                    self.repo.update_task(task.id, blocker=Blocker.NEEDS_INPUT, blocker_detail=detail)
                    self._event(task, f"#{task.id} is waiting for reply: {inputs.shorten(detail, 200)}", "warn")
                return
        if st.state in ("working", "blocked"):
            # The session is alive: either the daemon itself recognized it as working, or its `blocked` was not confirmed
            # (background work or a growing transcript). We clear the fallback channel's badge, since nobody
            # else will; an open request from a hook must not be touched: while the hook holds
            # a tool, the session is "working" for the daemon, and state.json knows nothing about the wait.
            self._drop_stale_waiting(task)
            if st.state == "working" and task.quota_retry_count:
                self.repo.update_task(task.id, quota_retry_count=0)  # the session came alive, the quota episode is closed
        elif st.state == "done":
            self._session_done(task)
        elif st.state in ("failed", "stopped"):
            self._handle_failure(task, st)

    def _session_done(self, task: Task) -> None:
        self.sessions.close_input_requests(task)
        self.repo.update_task(task.id, status=TaskStatus.VERIFYING, blocker=None,
                              blocker_detail=None, quota_retry_count=0)
        self.repo.set_setting("quota_attempt", "0")  # the quota is definitely available
        # The work is handed in: since Claude Code 2.1.293 the end of a turn is working + idle, and the session process
        # lives until it is shut down. Without this every finished task held hundreds of megabytes.
        # If verification fails, _verify_failed will wake the session via wake.
        self.sessions.release(task, "work handed in")

    def _reported_this_turn(self, task: Task, turn: transcript.LastTurn | None) -> bool:
        """Whether report.json was written in the session's last turn, i.e. after the reply that opened the turn.

        A report from a previous pass (verify failed, the owner answered a question) is older than that reply and
        does not count. While an owner message is on its way into the session, the turn is not the last one yet."""
        if turn is None or turn.started_at is None or not task.worktree_path:
            return False
        if task.outbox_state is not None or self._recently_answered(task):
            return False
        if self.repo.open_input_request(task.id) is not None:
            return False  # the hook holds a question: the report has nothing to do with it
        try:
            mtime = (Path(task.worktree_path) / REPORT_REL_PATH).stat().st_mtime
        except OSError:
            return False
        return mtime >= turn.started_at

    @staticmethod
    def _waiting_detail(st: JobState, turn: transcript.LastTurn | None) -> str:
        """The wait text for the card. For an end of turn, the agent's own words: the daemon's paraphrase
        in `needs` ("coordinate with backend on: ...") makes no sense without context."""
        if turn is not None and turn.final_text:
            return inputs.shorten(turn.final_text, WAITING_DETAIL_LIMIT, keep_lines=True)
        return inputs.describe_needs(st.needs, st.detail)

    def _session_quiet(self, st: JobState) -> bool:
        """Whether the wait is confirmed by the session's silence.

        We believe the fallback channel (state.json) only when the transcript has not grown for `WAITING_QUIET_SEC`
        seconds. Otherwise a session that is actually working would be declared waiting: the daemon
        writes `blocked` by text at the end of a turn, and a reply to a subagent fools it. If there is no
        transcript (an old session, the file is unavailable), we believe the state as before.
        """
        idle = st.idle_sec(time.time())
        return idle is None or idle >= WAITING_QUIET_SEC

    @staticmethod
    def _background_stale(st: JobState) -> bool:
        """An end of turn with background work that gives no signs of life for too long.

        Background work cancels the wait (`JobState.waiting`) while it can be believed. A session
        silent for longer than `IN_FLIGHT_STALE_SEC` is awaiting nothing from the harness: the counter is stuck.
        No transcript means nothing to judge by, so we stay with the daemon's opinion."""
        if not st.turn_ended or st.in_flight == 0:
            return False
        idle = st.idle_sec(time.time())
        return idle is not None and idle >= IN_FLIGHT_STALE_SEC

    def _drop_stale_waiting(self, task: Task) -> None:
        """Clear the wait badge from a session that is working. We do not touch a request from a hook."""
        if task.blocker != Blocker.NEEDS_INPUT or self.repo.open_input_request(task.id) is not None:
            return
        self.repo.update_task(task.id, blocker=None, blocker_detail=None)
        # An event, not a silent clearing: the owner saw the "waiting for an answer" alert and must
        # learn why it disappeared on its own.
        self._event(task, f"#{task.id}: wait cleared, the session resumed work on its own")

    def _handle_failure(self, task: Task, st: JobState) -> None:
        if is_quota_error(st.detail, self._quota_patterns()):
            self._enter_quota_wait(task, st.detail)
        elif task.auto_resume_count < 1:
            # The counter grows BEFORE the attempt: a failed resume (session unknown, daemon unavailable)
            # must count, otherwise the task is retried every tick until the end of time.
            task = self.repo.update_task(task.id, auto_resume_count=task.auto_resume_count + 1)
            try:
                self.sessions.wake(task, RESUME_AFTER_CRASH)
            except Exception as e:
                self._fail(task, f"the session was interrupted ({st.detail[:120]}), could not resume: {e}")
                return
            self._event(task, f"#{task.id} was interrupted ({st.detail[:120]}), resuming", "warn")
        else:
            self._fail(task, st.detail)

    def _enter_quota_wait(self, task: Task, detail: str) -> None:
        already_waiting = self.repo.get_setting("quota_retry_after") is not None
        if not already_waiting:
            attempt = int(self.repo.get_setting("quota_attempt", "0"))
            retry_at, by_reset = self._quota_retry_at(attempt)
            self.repo.set_setting("quota_retry_after", retry_at.replace(microsecond=0).isoformat())
            # We advance the backoff in any case: it stays a fallback for the next time when
            # a limits snapshot may be missing.
            self.repo.set_setting("quota_attempt", str(attempt + 1))
            # An event on every entry of the dispatcher into quota_wait: otherwise the owner sees a standing
            # board and does not know that the whole orchestrator is frozen (including by a false match).
            why = "limit reset" if by_reset else f"backoff, attempt {attempt + 1}"
            self._event(task, f"quota limit on task #{task.id} ({detail[:120]}), "
                              f"dispatcher paused until {retry_at:%H:%M} ({why})", "warn")
        self.repo.update_task(task.id, blocker=Blocker.QUOTA, blocker_detail=detail)

    def _quota_retry_at(self, attempt: int) -> tuple[datetime, bool]:
        """When to lift the quota pause, and whether it is computed from the real reset time.

        A blind backoff 30->60->120 minutes is guesswork in both directions: shorter than the real reset means a
        false start and a burned attempt of QUOTA_RETRY_LIMIT, longer means the board stands although
        the limit was lifted long ago. The orchestrator already has the exact reset time: it is brought by the same
        sources that draw the limits on the board (orc/usage.py): the statusline of running sessions,
        the probe and the ~/.claude.json snapshot. The backoff stays a fallback when there is no snapshot or it is stale.
        """
        now = self.now()
        try:
            status = usage.read(self.settings.usage_cache_path, self.settings.claude_json_path)
        except Exception:
            log.exception("could not read the limits for the quota pause")
            status = None
        moment = reset_retry_at(now, status)
        if moment is not None:
            return moment, True
        return now + timedelta(minutes=retry_delay_minutes(attempt)), False

    # ---------- step: delivering messages into the session ----------

    def _deliver_outbox(self) -> None:
        for task_id in self.delivery.pending_tasks():
            try:
                self.deliver_messages(task_id)
            except Exception:
                log.exception("message delivery #%s", task_id)

    def deliver_messages(self, task_id: int) -> None:
        """An attempt to deliver a task's message queue. Called both from the tick and directly from the API."""
        with self._exclusive(COMMAND_LOCK_TIMEOUT_SEC):
            self.delivery.deliver(task_id)

    # ---------- step: quota retry ----------

    def _retry_quota(self) -> None:
        retry_after = self.repo.get_setting("quota_retry_after")
        if retry_after is None or self.now() < datetime.fromisoformat(retry_after):
            return
        # Lift the pause before retries: if the limit recurs, _enter_quota_wait creates a new one with a longer delay
        self.repo.delete_setting("quota_retry_after")
        for task in self.repo.list_tasks(status=TaskStatus.IN_PROGRESS):
            if task.blocker != Blocker.QUOTA:
                continue
            if task.quota_retry_count >= QUOTA_RETRY_LIMIT:
                # The detail text is a human-readable summary of the last action, and
                # the regex may have matched it falsely. Without a ceiling such a task is retried
                # forever and never becomes failed.
                self._fail(task, f"{QUOTA_RETRY_LIMIT} attempts in a row ended with a 'quota limit' "
                                 f"({(task.blocker_detail or '')[:120]}). Check the regexes in the settings "
                                 f"(quota_patterns): this may be a false match.")
                continue
            task = self.repo.update_task(task.id, quota_retry_count=task.quota_retry_count + 1)
            try:
                self.sessions.wake(task, RESUME_AFTER_CRASH)
            except Exception as e:
                log.exception("retry #%s", task.id)
                self._enter_quota_wait(task, str(e))

    # ---------- step: missed start windows ----------

    def _expire_schedules(self) -> None:
        """The task did not start before the end of its window, so we return it to the backlog.

        Works on pause and while waiting for quota too: a window is a "no later than" promise, and a pause
        does not cancel it. Starting the task after the window would violate the one thing
        it was set for. There is no need to touch the backlog: the task does not start from there anyway.
        """
        now = self.now()
        for task in self.repo.list_tasks(status=TaskStatus.TODO):
            if not schedule.is_expired(task, now):
                continue
            window = f"{schedule.human(task.start_after)} – {schedule.human(task.start_before)}"
            # We reset position: a manual order from todo means nothing in the backlog, and the card
            # must take its natural place rather than hang on someone else's position.
            self.repo.update_task(task.id, status=TaskStatus.BACKLOG, start_after=None, start_before=None,
                                  position=None)
            # A comment, not just an event: in the feed the entry sinks, while the card keeps
            # the explanation of why it is in the backlog again.
            self.repo.add_comment(
                task.id, "orc", "comment",
                f"The start window {window} has passed, and the task never started (slots were busy, blockers were not ready "
                f"or the dispatcher was down): returned to the backlog. Set a new time and move "
                f"it to 'To do'.",
            )
            self._event(task, f"#{task.id}: start window {window} has passed, the task was returned to the backlog", "warn")

    # ---------- step: runs of recurring tasks ----------

    def _spawn_routines(self) -> None:
        """Create runs of routines whose slot has come (orc/routines.py). Before _start_ready,
        so that a fresh run starts in the same tick. Works on pause too: the card will wait
        in todo, and the rule "the previous run is still going" will not let a second one pile up."""
        routines.run_due(self.repo, self.now(), self._emit)

    def run_routine(self, routine_id: int) -> Task:
        """Run now: an out-of-turn run. The schedule does not shift."""
        with self._exclusive(COMMAND_LOCK_TIMEOUT_SEC):
            routine = self.repo.get_routine(routine_id)
            if routine is None:
                raise ValueError("routine not found")
            return routines.spawn(self.repo, routine, self.now(), self._emit, manual=True)

    def _emit(self, message: str, level: str, task_id: int | None, project_id: int | None) -> None:
        self.repo.add_event(message, level=level, task_id=task_id, project_id=project_id)

    # ---------- step: starting ready tasks ----------

    def _reset_start_gate(self) -> None:
        """The gate is waiting for nothing (pause, quota, empty queue): reset the marks so that the status does not
        show a stale "load". We do not write the "load dropped" event here: whether it dropped or
        not we do not know; a new waiting period will open with a new "task start postponed" event."""
        self.start_blocked_reason = None
        self._start_blocked_kind = None
        self.last_machine = None

    def _start_ready(self) -> None:
        if self.repo.get_setting("dispatcher_paused", "0") == "1":
            self._reset_start_gate()
            return
        if self.repo.get_setting("quota_retry_after") is not None:
            self._reset_start_gate()
            return
        all_tasks = self.repo.list_tasks()
        by_id = {p.id: p for p in self.repo.list_projects()}
        # Tasks of archived projects do not get into the queue at all: the archive means "take the project
        # out of sight without touching the data", and there is no reason to fail such a task: it will wait for the project to return.
        # Deferred start: until its time the task is not a candidate and does not hold a slot.
        now = self.now()
        todo = [t for t in all_tasks
                if t.status == TaskStatus.TODO and not getattr(by_id.get(t.project_id), "archived_at", None)
                and not schedule.is_waiting(t, now)]
        if not todo:
            self._reset_start_gate()
            return
        # An overloaded machine: a new agent with its builds and tests would only stretch everyone's
        # time and bloat memory. Running tasks, delivery and answers are not touched by the gate.
        max_load_pct = self._int_setting("start_max_load_pct", 100, minimum=0)
        min_free_mem_pct = self._int_setting("start_min_free_mem_pct", 10, minimum=0)
        if max_load_pct == 0 and min_free_mem_pct == 0:
            self._reset_start_gate()  # both checks are off: no measurement (or subprocess) is needed
            blocked = None
        else:
            self.last_machine = self.machine_sampler()
            blocked = machine.busy_check(self.last_machine, max_load_pct, min_free_mem_pct)
        kind, reason = blocked if blocked else (None, None)
        # The event is written on a change of STATE (free / load / mem), not of text: the text has live numbers
        # (load 30.0 -> 30.1), and the event would go out almost every tick. A transition load -> mem is
        # a different reason and is written as a new event; start_blocked_reason always has fresh text.
        if kind != self._start_blocked_kind:
            if reason:
                self.repo.add_event(f"task start postponed: {reason}", level="warn")
            else:
                self.repo.add_event("load dropped, task start resumed")
            self._start_blocked_kind = kind
        self.start_blocked_reason = reason
        # The "Run now" button is the owner's explicit will, the gate does not hold it. Without this the button
        # silently did nothing while load was high (right after boot macOS can show 50+
        # on an empty machine), and the reason was hidden in a tooltip.
        if reason and not self._manual_tick:
            return
        status_by_id = {t.id: t.status for t in all_tasks}
        running = Counter(t.project_id for t in all_tasks if t.status == TaskStatus.IN_PROGRESS)
        limits = {pid: p.max_workers for pid, p in by_id.items()}
        global_limit = self._int_setting("global_max_workers", 3, minimum=1)
        ready = ready_tasks(todo, status_by_id, self.repo.all_deps(), dict(running), limits, global_limit)
        if reason and ready:
            self.repo.add_event(f"start via the 'Run now' button despite the load: {reason}", level="warn")
        for task in ready:
            project = by_id.get(task.project_id)
            if project is None:  # the project was deleted between the queries
                self._fail(task, f"project #{task.project_id} was deleted, nowhere to start")
                continue
            status = project_paths.path_status(project.path)
            if not status["path_ok"]:
                # The project folder was moved or deleted behind the dashboard's back. A bare git error about a
                # nonexistent directory does not explain what to fix, so we say it directly.
                self._fail(task, f"the project folder is unavailable ({status['path_error']}): {project.path}. "
                                 f"Set a new path in the project settings or archive the project")
                continue
            try:
                self._start(task, project)
            except Exception as e:
                if isinstance(e, trust.WorkspaceUntrusted) or trust.is_untrusted_error(e):
                    log.warning("start #%s: %s", task.id, e)
                    self._start_failed(task, project, str(e), blocker=Blocker.UNTRUSTED)
                    continue
                log.exception("start #%s", task.id)
                self._start_failed(task, project, f"failed to start: {e}")

    # ---------- step: feed retention ----------

    def _cleanup(self) -> None:
        """Event feed retention. We do not touch task comments: they are a conversation, not a log."""
        days = self._int_setting("events_retention_days", 30, minimum=0)
        if days == 0:
            return
        last = self.repo.get_setting("events_cleaned_at")
        now = self.now()
        if last:
            try:
                if (now - datetime.fromisoformat(last)).total_seconds() < CLEANUP_INTERVAL_SEC:
                    return
            except ValueError:
                pass  # garbage in the setting is no reason to never clean
        # The same format as created_at (second precision): otherwise the strings would be compared
        # with different lengths and the threshold would drift by a second
        cutoff = (now - timedelta(days=days)).replace(microsecond=0).isoformat()
        removed = self.repo.delete_events_before(cutoff)
        self.repo.set_setting("events_cleaned_at", now.replace(microsecond=0).isoformat())
        if removed:
            log.info("feed retention: removed %s events older than %s days", removed, days)

    # ---------- step: cleanup of merged tasks' working copies ----------

    def _cleanup_worktrees(self) -> None:
        """Remove the working copies of tasks merged more than worktree_retention_days days ago.

        After a merge we keep the copy for the sake of "Rework" (rework continues the session in the same
        folder), but indefinitely that is gigabytes. Only what loses nothing is deleted:
        the rules are in orc/worktrees.py:autoclean; the owner removes the rest themselves in the
        "Worktrees" window, seeing what they risk.
        """
        if self.repo.get_setting("worktree_autoclean", "1") != "1":
            return
        now = self.now()
        last = self._worktrees_checked_at
        if last is not None and (now - last).total_seconds() < WORKTREE_CLEANUP_INTERVAL_SEC:
            return
        self._worktrees_checked_at = now
        days = self._int_setting("worktree_retention_days", WORKTREE_RETENTION_DAYS, minimum=0)
        for project in self.repo.list_projects(archived=None):
            if not project_paths.path_status(project.path)["path_ok"]:
                continue  # the folder moved behind the dashboard's back: nothing to clean there and nothing to clean with
            try:
                removed = worktrees.autoclean(self.repo, project, now, days, self.settings.claude_json_path)
            except Exception:
                log.exception("auto-cleanup of working copies of project %s", project.name)
                continue
            for item in removed:
                tail = f", branch {item['dropped_branch']} deleted" if item["dropped_branch"] else ""
                self.repo.add_event(
                    f"#{item['task_id']}: working copy {item['name']} removed: the task was merged "
                    f"more than {days} days ago{tail}", task_id=item["task_id"], project_id=project.id)

    # ---------- step: session cleanup ----------

    def _reap_sessions(self) -> None:
        """Shut down orc sessions that have no matching task in progress.

        Transitions (_session_done, _fail) shut a session down immediately, and this is a safety net: it catches what
        accumulated before a rollout, copies after a resume, orphans of a previous daemon and an orc crash
        between writing the status and `claude stop`. We keep alive only the task's current job in
        in_progress, including one waiting for an answer or quota: _sync_running manages it.
        """
        if self.repo.get_setting("session_reaper", "1") != "1":
            self.sessions_alive = None  # the reaper is off: the previous number is stale
            return
        now = time.monotonic()
        if self._reaped_at is not None and now - self._reaped_at < SESSION_REAP_INTERVAL_SEC:
            return
        self._reaped_at = now
        try:
            live = self.cli.list_sessions()
        except Exception:
            log.warning("session reaper: the daemon's session list is unavailable, skipping the pass", exc_info=True)
            self.sessions_alive = None  # we do not know how many there are now, so we do not show the old number
            return
        owners = self.repo.session_owners()
        keep = {t.job_id for t in self.repo.list_tasks(status=TaskStatus.IN_PROGRESS) if t.job_id}
        ours = [s for s in live if s.get("kind") == "background" and s["id"] in owners]
        self.sessions_alive = len(ours)
        reaped: list[int] = []
        # The batch counts ATTEMPTS, not successes: everything runs under the tick lock, and every hung
        # `claude stop` holds it until TIMEOUT_SEC. Whatever is left will be picked up by the next pass.
        attempted = 0
        for s in ours:
            if attempted >= SESSION_REAP_BATCH:
                break
            if s["id"] in keep or s.get("state") in ("stopped", "done", "failed"):
                continue
            task = self.repo.get_task(owners[s["id"]])
            if task is None:
                continue
            attempted += 1
            # release looks at task.job_id: we substitute the job being shut down, it may be an old copy
            if self.sessions.release(replace(task, job_id=s["id"]), "reaper"):
                reaped.append(task.id)
        if reaped:
            self.reaped_total += len(reaped)
            self.sessions_alive = len(ours) - len(reaped)
            ids = ", ".join(f"#{i}" for i in sorted(set(reaped)))
            self.repo.add_event(f"session reaper: shut down {len(reaped)} sessions of tasks not in progress ({ids})")

    def delete_worktrees(self, project: Project, names: list[str], force: bool = False) -> tuple[dict, str]:
        """Manual deletion of working copies from the "Worktrees" window.

        Under the shared lock: otherwise a dispatcher pass could in that same second resume a task
        in the folder we are tearing down, or merge through a temporary orc-merge-N copy.
        We compute the fresh summary after the lock: du over gigabytes must not hold the tick.
        """
        with self._exclusive(COMMAND_LOCK_TIMEOUT_SEC):
            note = worktrees.delete(self.repo, project, names, force=force,
                                    claude_json_path=self.settings.claude_json_path)
        self.repo.add_event(f"working copies of project {project.name}: {note}", level="warn", project_id=project.id)
        return worktrees.overview(self.repo, project), note

    def _start_failed(self, task: Task, project: Project, detail: str, blocker: Blocker | None = None) -> None:
        """A failure between creating the worktree and starting the session: clean up after ourselves.

        Otherwise the worktree and the orc/task-N branch stay hanging, and the "Retry" button forever
        runs into `git worktree add -b`: "branch already exists".
        """
        fresh = self.repo.get_task(task.id) or task
        fields: dict = {"status": TaskStatus.FAILED, "blocker_detail": detail, "blocker": blocker}
        if not fresh.job_id and fresh.worktree_path:  # the session never started
            try:
                self._drop_worktree(Path(project.path), fresh)
                fields.update(worktree_path=None, branch=None)
            except Exception:
                log.exception("worktree cleanup after a start failure #%s", task.id)
        self.repo.update_task(task.id, **fields)
        self._event(task, f"#{task.id} failed to start: {detail}", "error")

    def _drop_worktree(self, repo_path: Path, task: Task) -> None:
        """Tear down the task's worktree and its branch. Shared code for retry() and cleanup after a start failure."""
        if task.worktree_path:
            try:
                # The trust record for the torn-down worktree is garbage in ~/.claude.json (orc/trust.py)
                trust.revoke(self.settings.claude_json_path, task.worktree_path)
            except Exception:
                log.warning("did not remove trust for %s", task.worktree_path, exc_info=True)
        if task.worktree_path and Path(task.worktree_path).exists():
            git_ops.remove_worktree(repo_path, Path(task.worktree_path))
        if task.branch and task.branch in git_ops.list_branches(repo_path):
            git_ops.delete_branch(repo_path, task.branch)

    def _start(self, task: Task, project: Project) -> None:
        repo_path = Path(project.path)
        # The schedule is one-shot: we clear it together with the start, otherwise a retry of a failed task
        # or a rework would run into a long-past window and immediately go to the backlog.
        scheduled = task.start_after is not None
        if task.resume_with and task.session_id and task.worktree_path and Path(task.worktree_path).exists():
            # Rework: continue the previous session in the same worktree
            self.sessions.wake(task, task.resume_with)
            self.repo.update_task(task.id, resume_with=None, start_after=None, start_before=None)
            self._event(task, f"#{task.id} continued for rework")
            return
        target = task.target_branch or branches.base_branch(project, git_ops.current_branch(repo_path))
        if target not in git_ops.list_branches(repo_path):
            # The branch was deleted by hand behind the dashboard's back: a bare `git worktree add` error about
            # an "invalid reference" does not explain what to fix, so we say it directly.
            raise ValueError(f"target branch {target} no longer exists in the repository: pick another one in the card")
        branch = f"orc/task-{task.id}"
        worktree = repo_path / ".claude" / "worktrees" / f"orc-task-{task.id}"
        git_ops.add_worktree(repo_path, worktree, branch, target)
        # We write the worktree and branch to the DB IMMEDIATELY: everything below may fail (ensure_exclude,
        # the prompt template, starting the session), and without this write the created worktree and branch
        # become orphans that neither retry() nor a repeated start will find.
        task = self.repo.update_task(task.id, worktree_path=str(worktree), branch=branch, target_branch=target)
        git_ops.ensure_exclude(repo_path, ".orchestrator/")
        verify_cmd = task.verify_cmd or project.verify_cmd or "not set"
        prompt = build_prompt(
            self.repo.get_setting("prompt_template") or DEFAULT_TEMPLATE,
            title=task.title, description=self.with_images(task.description), branch=branch,
            target_branch=target, verify_cmd=verify_cmd, report_path=REPORT_REL_PATH,
        )
        self.sessions.start(task, project, worktree, prompt, f"orc#{task.id} {task.title}",
                            worktree_path=str(worktree), branch=branch, target_branch=target,
                            start_after=None, start_before=None)
        how = "on schedule " if scheduled else ""
        self._event(task, f"#{task.id} started {how}in {branch}")

    # ---------- step: verification ----------

    def _process_verifying(self) -> None:
        # There is nothing more to wait for here: verify runs in the pool (orc/verify_pool.py), and this step
        # only picks up what is done and hands out new work.
        for task in self.repo.list_tasks(status=TaskStatus.VERIFYING):
            try:
                self._advance_verify(task)
            except Exception:
                log.exception("verify #%s", task.id)

    def _advance_verify(self, task: Task) -> None:
        outcome = self.verify_pool.take(task.id)
        if outcome is not None:
            self._apply_verify_outcome(task, outcome)
            return
        if task.id in self.verify_pool.running():
            return  # the check is running, the tick is not obliged to wait for it
        project = self.repo.get_project(task.project_id)
        if project is None:
            self._fail(task, f"project #{task.project_id} was deleted: nowhere to verify or merge")
            return
        if not task.worktree_path or not Path(task.worktree_path).exists():
            # The working copy was torn down by hand: read_report will return None, and the resume would go to
            # a subprocess with a nonexistent cwd and the task would get stuck in verifying forever.
            self._fail(task, f"the task working copy was not found ({task.worktree_path or 'path not recorded'}): "
                             f"nothing to continue, press 'Retry' to start from scratch")
            return
        report = read_report(Path(task.worktree_path))
        if report is None:
            self._verify_failed(task, "File .orchestrator/report.json not found. Write it in the format given in the task.")
            return
        if report.status != "success":
            self._verify_failed(task, "The report has status failed. Its summary and notes:\n"
                                      + quote_untrusted(f"{report.summary} {report.notes}", limit=1000))
            return
        cmd = task.verify_cmd or project.verify_cmd
        if not cmd:
            self._queue_merge(task, report)
            return
        self.verify_pool.submit(task.id, task.job_id, cmd, Path(task.worktree_path),
                                project.verify_timeout_sec)
        self._event(task, f"#{task.id}: verification started ({cmd})")

    def _apply_verify_outcome(self, task: Task, outcome: VerifyOutcome) -> None:
        """A result from the pool. The task may have changed while the check ran, so we verify the session."""
        fresh = self.repo.get_task(task.id)
        if fresh is None or fresh.status != TaskStatus.VERIFYING or fresh.job_id != outcome.job_id:
            # The task was restarted, closed by hand or deleted in the meantime: the result is not about it.
            # We do not write to the feed: the owner just did this themselves.
            log.info("verification result #%s is stale, discarding", task.id)
            return
        if not outcome.ok:
            self._verify_failed(fresh, f"The check `{outcome.cmd}` failed. Its output:\n"
                                       + quote_untrusted(outcome.output[-4000:], limit=4000))
            return
        report = read_report(Path(fresh.worktree_path)) if fresh.worktree_path else None
        if report is None:
            self._verify_failed(fresh, "File .orchestrator/report.json disappeared while the check was running. "
                                       "Write it in the format given in the task.")
            return
        self._event(fresh, f"#{fresh.id}: verification passed in {_human_duration(outcome.duration_sec)}")
        self._queue_merge(fresh, report)

    def _queue_merge(self, task: Task, report) -> None:
        self.repo.update_task(
            task.id, status=TaskStatus.MERGING, merge_queued_at=self._now_iso(),
            report_json=json.dumps(asdict(report), ensure_ascii=False), blocker=None, blocker_detail=None,
        )
        self._event(task, f"#{task.id} verified, queued for merge")

    def _verify_failed(self, task: Task, reason: str) -> None:
        if task.auto_resume_count < 1:
            # The counter goes before the attempt, as in _handle_failure: a failed resume counts too
            task = self.repo.update_task(task.id, auto_resume_count=task.auto_resume_count + 1)
            # The note goes next to the block, and only when there is a block: "report not found" is
            # entirely our instruction, there is no data in it
            note = f"\n\n{UNTRUSTED_NOTE}" if UNTRUSTED_OPEN in reason else ""
            try:
                self.sessions.wake(task, f"{reason}{note}\n\nFix it and write report.json again.")
            except Exception as e:
                self._fail(task, f"{reason}\n\nFailed to resume the session: {e}")
                return
            self._event(task, f"#{task.id} failed verification, sent back for fixing", "warn")
        else:
            self.repo.update_task(task.id, status=TaskStatus.FAILED, blocker=None, blocker_detail=reason)
            self._event(task, f"#{task.id} failed verification again", "error")

    # ---------- step: merge, strictly one at a time ----------

    def _process_merging(self) -> None:
        self.merger.process()

    # ---------- user actions ----------

    def answer(self, task_id: int, text: str, mode: str = "soft") -> Task:
        """Put the owner's message into the queue for delivery into the task's session.

        This receives both an answer to a question under the needs_input badge and a remark into a working
        session. The message first lands in the database and only then is delivered: before, the text
        lived on the HTTP request stack, and on an unconfirmed stop we had to choose between
        "losing the answer" and "resuming a live session", i.e. creating a copy of it. Now there is nothing
        to lose, and the resume waits for confirmation as long as needed.
        """
        with self._exclusive(COMMAND_LOCK_TIMEOUT_SEC):
            task = self._require(task_id)
            if task.status != TaskStatus.IN_PROGRESS:
                raise ValueError("you can only write into the session of a task that is currently in progress")
            if task.blocker == Blocker.QUOTA:
                # The dispatcher retries such a task itself on schedule: a manual resume would bypass
                # the shared quota pause and throw off the attempt counter.
                raise ValueError("the task is waiting for the quota limit to lift, the dispatcher will resume it itself")
            if not task.session_id:
                raise ValueError("the task's session is not known yet, there is nowhere to send the message")
            if mode not in ("soft", "interrupt"):
                raise ValueError("delivery mode: soft | interrupt")
            self.repo.add_comment(task.id, "user", "answer", text)
            # The comment gets the original text with markers (the card draws images from them),
            # while the queue gets the expanded one: the session receives file paths.
            self.repo.add_message(task.id, self.with_images(text), mode=mode)
            self.delivery.set_outbox_state(task, "queued")
            # We try to deliver at once so that the answer does not wait for the next tick. If it did not work, the message
            # stays in the queue, and the tick step will finish the job.
            try:
                self.deliver_messages(task.id)
            except Exception:
                log.exception("immediate delivery of message #%s", task.id)
            return self.repo.get_task(task.id)

    # The lock is DELIBERATELY not taken in request_input and answer_input. They are called by the session hook, which
    # holds a tool of a live agent: a 409 refusal would mean the hook yields to the terminal
    # dialog of Claude Code, a dialog that nobody will ever see in a background session.
    # They write only their own tables and the badge, so the worst consequence of a race with a tick is a
    # needs_input badge that diverged for one pass; _sync_running fixes it on the next one.
    def request_input(self, task_id: int, kind: str, tool_name: str, tool_input: dict,
                      session_id: str | None = None) -> dict:
        """The session hook reports: the agent is waiting for a human (a permission, a question, a plan).

        We register the request and hang the needs_input badge at once, without waiting for a tick: the hook already
        holds the tool, and the sooner the card shows it, the sooner it gets answered. We close the old
        open request of the same task: judging by the new one, its hook is no longer waiting.
        """
        task = self._require(task_id)
        if task.status != TaskStatus.IN_PROGRESS:
            raise ValueError("the task is not in progress: input requests are accepted only from a running session")
        if kind not in inputs.KINDS:
            raise ValueError(f"kind: {' | '.join(sorted(inputs.KINDS))}")
        if session_id and task.session_id and session_id != task.session_id:
            # Not a protection but a diagnostic: a mismatch means a copy session is writing
            # (a resume spawned a new job, and state.json has not caught up with the task yet)
            log.warning("input request #%s came from session %s, but the task has %s recorded",
                        task.id, session_id, task.session_id)
        self.repo.cancel_input_requests(task.id)
        summary = inputs.summarize(kind, tool_name, tool_input)
        request = self.repo.add_input_request(
            task.id, kind, tool_name, json.dumps(tool_input, ensure_ascii=False), summary,
            session_id=session_id or task.session_id,
        )
        self.repo.update_task(task.id, blocker=Blocker.NEEDS_INPUT, blocker_detail=summary)
        self._event(task, f"#{task.id} {inputs.KIND_LABEL[kind]}: {summary[:200]}", "warn")
        return request

    def answer_input(self, task_id: int, request_id: int, decision: dict) -> Task:
        """The owner's decision on a request: the hook will pick it up on the nearest poll and hand it to the session.

        The session is not stopped in the process, unlike answer(), where the text goes through
        stop + resume. The decision stays in the card's conversation in words: who allowed what."""
        task = self._require(task_id)
        request = self.repo.get_input_request(request_id)
        if request is None or request["task_id"] != task.id:
            raise ValueError("the task has no such request")
        if request["state"] != "open":
            raise ValueError("the request is already closed: the session is no longer waiting for it")
        tool_input = self._parse_json(request["tool_input"]) or {}
        clean = inputs.validate_decision(request["kind"], tool_input, decision)
        self.repo.answer_input_request(request_id, json.dumps(clean, ensure_ascii=False))
        self.repo.add_comment(task.id, "user", "answer",
                              inputs.decision_text(request["kind"], request["tool_name"], tool_input, clean))
        if task.blocker == Blocker.NEEDS_INPUT:
            self.repo.update_task(task.id, blocker=None, blocker_detail=None)
        self._event(task, f"#{task.id}: answer sent to the session")
        return self.repo.get_task(task.id)

    @staticmethod
    def _parse_json(raw: str | None) -> dict | None:
        if not raw:
            return None
        try:
            data = json.loads(raw)
        except ValueError:
            return None
        return data if isinstance(data, dict) else None

    def rework(self, task_id: int, text: str) -> Task:
        """Rework of a finished card: back to todo with the "continue the session" flag.

        The resume itself is done by _start on the nearest tick, so a rework is subject to the shared worker
        limits and does not barge into the session bypassing the queue."""
        with self._exclusive(COMMAND_LOCK_TIMEOUT_SEC):
            task = self._require(task_id)
            if task.status != TaskStatus.DONE:
                raise ValueError("only a finished task can be sent for rework")
            if not task.session_id:
                raise ValueError("the task's session is unknown: nothing to continue, create a new task")
            if not task.worktree_path or not Path(task.worktree_path).exists():
                raise ValueError("the task's working copy has already been deleted: nothing to continue, create a new task")
            # A running verification of this task is no longer needed by anyone: its result belongs
            # to a state that is about to disappear.
            self.verify_pool.cancel(task_id)
            # The previous report is about to disappear from task.report_json (see below); without this
            # a rework would look as if the previous submission never existed.
            # We put it into the conversation before the "rework" mark so that the order reads
            # as it happened: first what was handed in, then why it was sent back.
            report = self._parse_json(task.report_json)
            if report:
                summary = str(report.get("summary") or "").strip()
                notes = str(report.get("notes") or "").strip()
                archived = "\n\n".join(part for part in (summary, notes) if part)
                if archived:
                    self.repo.add_comment(task.id, "claude", "report", archived)
            self.repo.add_comment(task.id, "user", "rework", text)
            drop_report(Path(task.worktree_path))
            # Undelivered messages from the previous pass must not surface in the new work
            inbox.clear(Path(task.worktree_path))
            task = self.repo.update_task(
                task.id, status=TaskStatus.TODO, resume_with=self.with_images(text), blocker=None, blocker_detail=None,
                auto_resume_count=0, state_miss_count=0, quota_retry_count=0, conflict_retry_count=0,
                report_json=None, done_at=None, merge_queued_at=None,
            )
            self._event(task, f"#{task.id} sent for rework")
            return task

    def retry(self, task_id: int) -> Task:
        """failed -> todo from scratch: the old worktree, branch and session are deleted."""
        with self._exclusive(COMMAND_LOCK_TIMEOUT_SEC):
            task = self._require(task_id)
            if task.status != TaskStatus.FAILED:
                raise ValueError("retry is only allowed for a failed task")
            project = self.repo.get_project(task.project_id)
            if project is None:
                raise ValueError(f"project #{task.project_id} was deleted")
            # A running verification of this task is no longer needed by anyone: its result belongs
            # to a state that is about to disappear.
            self.verify_pool.cancel(task_id)
            self._drop_worktree(Path(project.path), task)
            if task.job_id:
                # What was spent is not reset: the attempt's spending is part of the task's spending. We count before
                # `claude rm`, while state.json still points to the transcript path.
                self._collect_usage(task, self.sessions.safe_state(task.job_id))
                try:
                    self.cli.remove(task.job_id)
                except Exception:
                    log.warning("claude rm %s failed", task.job_id)
            return self.repo.update_task(
                task.id, status=TaskStatus.TODO, job_id=None, session_id=None, worktree_path=None, branch=None,
                auto_resume_count=0, state_miss_count=0, quota_retry_count=0, conflict_retry_count=0,
                blocker=None, blocker_detail=None, merge_queued_at=None, report_json=None, hook_secret=None,
            )

    def trust_and_retry(self, task_id: int) -> Task:
        """The owner confirmed trust in the project folder in the dashboard: we record it and start again.

        We write trust onto the project folder itself, after which the worktree of every task of this project
        is trusted automatically (orc/sessions.py, _launch), and the question no longer comes up.
        """
        with self._exclusive(COMMAND_LOCK_TIMEOUT_SEC):
            task = self._require(task_id)
            if task.status != TaskStatus.FAILED or task.blocker != Blocker.UNTRUSTED:
                raise ValueError("trust is confirmed only for a task that failed because of an untrusted folder")
            project = self.repo.get_project(task.project_id)
            if project is None:
                raise ValueError(f"project #{task.project_id} was deleted")
            trust.grant(self.settings.claude_json_path, project.path)
            self._event(task, f"project folder {project.path} was granted Claude Code trust")
            return self.retry(task_id)

    def resume_failed(self, task_id: int) -> Task:
        """failed -> in_progress with the same session."""
        with self._exclusive(COMMAND_LOCK_TIMEOUT_SEC):
            task = self._require(task_id)
            if task.status != TaskStatus.FAILED or not task.session_id:
                raise ValueError("resume is only allowed for a failed task that has a session")
            try:
                self.sessions.wake(task, RESUME_AFTER_CRASH)
            except ClaudeCliError as e:
                # The session did not stop (or the daemon refused): the task stays failed, we give the owner
                # a clear reason, not a 500.
                raise ValueError(f"could not resume the session: {e}") from e
            # The task is in progress again: a start window set on a failed one ("retry overnight") loses its meaning.
            # Otherwise it would invisibly live on until the next retry/rework and run into "window has passed".
            self.repo.update_task(task.id, start_after=None, start_before=None)
            self._event(task, f"#{task.id} resumed manually")
            return self.repo.get_task(task.id)

    def force_done(self, task_id: int) -> Task:
        """Emergency manual close: the card goes to done bypassing verification and merge.

        The only door out of the working statuses and out of failed: the other manual
        transitions from there are still forbidden. It is needed for stuck cards: the ordinary
        path (report -> verification -> merge queue) will no longer pull them out, and while the card is in
        in_progress it occupies a worker slot and lies that someone is working. For
        failed it is the same exit when you want neither to retry nor to resume the task: it
        simply did not make it and is closed by hand like any ordinary card.

        What we do: stop the session, otherwise the agent will keep writing into the working copy
        of the closed task and on the nearest tick may push it to verifying itself, and shut down
        the undelivered messages: there is no one left to pick them up. For failed the session is already stopped
        (otherwise the task would not have failed), so stop/cancel simply find nothing here.

        What we do NOT do: we do not touch the worktree and branch. The work is not merged, and it
        will have to be picked up by hand; besides, a live working copy and a known session_id leave
        the "Rework" button on the card: the task can be returned to work without creating a new one.
        """
        with self._exclusive(COMMAND_LOCK_TIMEOUT_SEC):
            task = self._require(task_id)
            if task.status not in FORCE_DONE_FROM:
                raise ValueError(f"only a task in progress or a failed one can be closed manually "
                                 f"({', '.join(FORCE_DONE_FROM)}), and this one is in {task.status}")
            was = task.status
            # A running verification of this task is no longer needed by anyone: its result belongs
            # to a state that is about to disappear.
            self.verify_pool.cancel(task_id)
            if task.job_id:
                try:
                    self.cli.stop(task.job_id)
                except Exception:
                    # The session may already be gone: that is exactly the ordinary case of a stuck card,
                    # and it is no reason to leave it in in_progress.
                    log.warning("claude stop %s failed while closing #%s by hand", task.job_id, task.id)
                self._collect_usage(task, self.sessions.safe_state(task.job_id))
            pending = self.repo.pending_messages(task.id)
            if pending:
                self.delivery.fail_messages(task, pending, "the task was closed manually")
            self.sessions.close_input_requests(task)
            detail = f"was closed manually from status '{was}': verification and merge were not run"
            task = self.repo.update_task(
                task.id, status=TaskStatus.DONE, done_at=self._now_iso(), blocker=None, blocker_detail=detail,
                outbox_state=None, merge_queued_at=None, resume_with=None, retry_after=None,
                auto_resume_count=0, state_miss_count=0,
            )
            # A comment, not just an event: in the feed the entry gets lost among a hundred others,
            # while on the card it stays forever, including for whoever opens it in a month
            # and wonders why it is "done" without a report and without a merge.
            self.repo.add_comment(task.id, "user", "comment", f"The task {detail}. Branch "
                                                              f"{task.branch or 'not created'} is not merged.")
            self._event(task, f"#{task.id} closed manually from '{was}': the branch is not merged", "warn")
            return task

    def archive(self, task_id: int) -> Task:
        """Take a card off the board without losing it. Reversible: unarchive returns it as it was.

        The archive is not deletion: the row, conversation, report, branch and working copy stay
        in place. Exactly one thing changes: the task is no longer there, neither on the board nor for the dispatcher
        (see Repo.list_tasks): it will not be taken into work or counted in the worker limit.
        """
        with self._exclusive(COMMAND_LOCK_TIMEOUT_SEC):
            task = self._require(task_id)
            if task.status in WORKING_STATUSES:
                raise ValueError(f"a task in status '{task.status}' is working right now: first wait for it "
                                 f"or close it manually, then archive it")
            if task.archived_at:
                return task
            task = self.repo.update_task(task.id, archived_at=self._now_iso())
            self._event(task, f"#{task.id} archived")
            return task

    def unarchive(self, task_id: int) -> Task:
        """Return a card from the archive to the board, to the same status it left in."""
        with self._exclusive(COMMAND_LOCK_TIMEOUT_SEC):
            task = self._require(task_id)
            if not task.archived_at:
                return task
            task = self.repo.update_task(task.id, archived_at=None)
            self._event(task, f"#{task.id} restored from the archive")
            return task

    def delete_task(self, task_id: int, force: bool = False, drop_worktree: bool = True) -> dict:
        """Delete a task for good: the DB row, the session and (by default) its worktree with the branch.

        This is the only irreversible action on a card, so it is gathered in one
        place and cleans up completely: a row without a session would leave a live agent hanging,
        and a row without a worktree would leave a junk copy of the repository and an orc/task-N branch that
        nobody would remember later.

        A running task is deleted only with force: its agent is alive, and cutting it off
        halfway silently is not allowed. drop_worktree=False keeps the branch and working copy: it is needed
        when the card is removed but the unfinished work in the branch is to be sorted out by hand.

        Images from the description (the attachments table) are not touched: they live in a shared storage
        deduplicated by content and do not belong to the task: the same file may stand as a marker
        in the description of another card.
        """
        with self._exclusive(COMMAND_LOCK_TIMEOUT_SEC):
            task = self._require(task_id)
            if task.status in WORKING_STATUSES and not force:
                raise ValueError(f"a task in status '{task.status}' is working right now: deletion will cut off "
                                 f"its session, repeat the request with force=true")
            # A running verification of this task is no longer needed by anyone: its result belongs
            # to a state that is about to disappear.
            self.verify_pool.cancel(task_id)
            removed = {"session": False, "worktree": False, "branch": False, "dependents": self.repo.dependents_of(task.id)}
            if task.job_id:
                for action in (self.cli.stop, self.cli.remove):
                    try:
                        action(task.job_id)
                        removed["session"] = True
                    except Exception:
                        # The session may already be gone: for deletion that is not an obstacle but the norm.
                        log.warning("%s %s failed while deleting #%s", action.__name__, task.job_id, task.id)
            project = self.repo.get_project(task.project_id)
            if drop_worktree and project is not None:
                had_worktree = bool(task.worktree_path and Path(task.worktree_path).exists())
                had_branch = bool(task.branch)
                try:
                    self._drop_worktree(Path(project.path), task)
                    removed["worktree"], removed["branch"] = had_worktree, had_branch
                except Exception as e:
                    # Git cleanup must not prevent deleting the row: otherwise a card whose worktree
                    # someone holds open could not be removed from the board at all.
                    log.exception("worktree cleanup while deleting #%s", task.id)
                    self.repo.add_event(f"#{task.id} deleted, but removing {task.worktree_path or task.branch} "
                                        f"failed: {e}", level="warn", project_id=task.project_id)
            self.repo.delete_task(task.id)
            # We write the event AFTER the deletion and without task_id: the task row no longer exists, and the foreign key
            # events.task_id can no longer be pointed at it.
            self.repo.add_event(f"#{task.id} «{task.title}» deleted for good", level="warn",
                                project_id=task.project_id)
            return removed

    def _require(self, task_id: int) -> Task:
        task = self.repo.get_task(task_id)
        if task is None:
            raise ValueError(f"task #{task_id} not found")
        return task

    # ---------- task tokens ----------

    def _collect_usage(self, task: Task, st: JobState | None = None) -> None:
        """Recount the task's tokens from the transcripts of all its sessions (orc/token_usage.py).

        A metric, not control: any error here is logged and does not bring down the calling step.
        Transcripts are re-read only when their fingerprint (number of files and bytes) changed:
        on a tick without new messages this is one check of file sizes.
        """
        try:
            sessions = self.repo.list_task_sessions(task.id)
            if st is not None and task.job_id:
                sessions = self._sync_current_session(task, st, sessions)
            refs = [token_usage.SessionRef(s["session_id"], s["job_id"], s["transcript_path"]) for s in sessions]
            if not any(r.transcript_path for r in refs):
                return
            previous = self._parse_usage(task.usage_json)
            sig = token_usage.signature(refs)
            if previous is not None and previous.get("scan") == sig:
                return
            if previous is None and sig["files"] == 0:
                return  # no transcripts yet: nothing to show
            usage = token_usage.collect(refs, now=self.now())
            self.repo.update_task(task.id, usage_json=json.dumps(usage, ensure_ascii=False))
            self._log_usage_delta(task, previous, usage)
        except Exception:
            log.exception("token collection for task #%s", task.id)

    def reprice_usage(self) -> int:
        """Recompute the money of already counted tasks if the price list changed. Returns how many tasks were touched.

        Closed tasks are no longer recounted by `_collect_usage` (the transcript fingerprint does not
        change), and without this their estimate would stay at old prices forever, or empty
        if the model was not in the price list then. Where the transcripts are in place and unchanged, we
        re-read the task entirely: this also yields the cache-write breakdown by TTL. Where they are gone,
        we recompute the estimate from the stored breakdown. We rewrite the task's spending log to match the
        new total. Once per price list version (`token_usage.PRICING_VERSION`).
        """
        if self.repo.get_setting("usage_pricing") == token_usage.PRICING_VERSION:
            return 0
        touched = 0
        for task in self.repo.list_tasks(archived=None):
            try:
                previous = self._parse_usage(task.usage_json)
                if previous is None or previous.get("pricing") == token_usage.PRICING_VERSION:
                    continue
                sessions = self.repo.list_task_sessions(task.id)
                refs = [token_usage.SessionRef(s["session_id"], s["job_id"], s["transcript_path"]) for s in sessions]
                sig = token_usage.signature(refs)
                if sig["files"] > 0 and previous.get("scan") == sig:
                    usage = token_usage.collect(refs, now=self.now())
                    # We keep the counting time as it was: the tokens are the same, only the price changed
                    usage["scanned_at"] = previous.get("scanned_at", usage["scanned_at"])
                else:
                    usage = dict(previous)
                    usage["cost_usd_estimated"] = token_usage.estimate_cost_usd(previous.get("models") or {})
                    usage["pricing"] = token_usage.PRICING_VERSION
                self.repo.update_task(task.id, usage_json=json.dumps(usage, ensure_ascii=False))
                self.repo.rescale_usage_entries(task.id, ledger_cost(usage))
                touched += 1
            except Exception:
                log.exception("recomputing the price of task #%s", task.id)
        self.repo.set_setting("usage_pricing", token_usage.PRICING_VERSION)
        if touched:
            log.info("price list %s: recomputed the cost of %s tasks", token_usage.PRICING_VERSION, touched)
        return touched

    def _log_usage_delta(self, task: Task, previous: dict | None, usage: dict) -> None:
        """The increment of tokens and money since the previous recount goes into the spending log (orc/forecast.py).

        A negative increment happens only on a format change or a manual edit of usage_json;
        it is not "tokens returned", so it is clamped to zero.
        """
        before_tokens = previous.get("total_tokens", 0) if previous else 0
        tokens = usage.get("total_tokens", 0) - (before_tokens if isinstance(before_tokens, int) else 0)
        cost = ledger_cost(usage) - (ledger_cost(previous) if previous else 0.0)
        tokens, cost = max(tokens, 0), max(cost, 0.0)
        if tokens > 0 or cost > 0:
            self.repo.add_usage_entry(task.id, task.project_id, tokens, round(cost, 6),
                                      at=self.now().replace(microsecond=0).isoformat())

    def _sync_current_session(self, task: Task, st: JobState, sessions: list[dict]) -> list[dict]:
        """Append to the log what became known about the current job: session_id and transcript."""
        current = next((s for s in sessions if s["job_id"] == task.job_id), None)
        if current is None:
            current = self.repo.add_task_session(task.id, task.job_id, st.session_id, st.transcript_path)
            return [*sessions, current]
        fields = {}
        if st.session_id and st.session_id != current["session_id"]:
            fields["session_id"] = st.session_id
        if st.transcript_path and st.transcript_path != current["transcript_path"]:
            fields["transcript_path"] = st.transcript_path
        if fields:
            self.repo.update_task_session(current["id"], **fields)
            current.update(fields)
        return sessions

    @staticmethod
    def _parse_usage(raw: str | None) -> dict | None:
        if not raw:
            return None
        try:
            data = json.loads(raw)
        except ValueError:
            return None
        return data if isinstance(data, dict) else None

    def _backfill_usage(self) -> None:
        """Once per process: tasks created before the session log get a record of their
        last job and a first count. Without this, finished cards would be left without a badge."""
        if self._usage_backfilled:
            return
        self._usage_backfilled = True
        for task in self.repo.tasks_without_sessions():
            try:
                st = self.sessions.safe_state(task.job_id)
                transcript = st.transcript_path if st else None
                if transcript is None and task.session_id and task.worktree_path:
                    # The job directory is gone (claude rm, cleanup): the transcript path is built
                    # the same way Claude Code builds it: from the working copy and session_id.
                    transcript = str(self.settings.jobs_dir.parent / "projects"
                                     / project_slug(task.worktree_path) / f"{task.session_id}.jsonl")
                self.repo.add_task_session(task.id, task.job_id,
                                           st.session_id if st and st.session_id else task.session_id, transcript)
                self._collect_usage(task)
            except Exception:
                log.exception("token backfill for task #%s", task.id)

    # ---------- limit history ----------

    def _record_limits(self) -> None:
        """Once a minute, a limits probe goes into the history: the burn rate for the forecast is computed from it.

        Claude has no separate "ask for history" endpoint, so the orchestrator accumulates the history itself
        while it runs. The Claude poll itself is not called from here: only a read of what the
        statusline and the probe have already brought (orc/usage.py).
        """
        started = time.monotonic()
        if self._limits_recorded_at is not None and started - self._limits_recorded_at < forecast.RECORD_INTERVAL_SEC:
            return
        self._limits_recorded_at = started
        status = usage.read(self.settings.usage_cache_path, self.settings.claude_json_path)
        forecast.record_limits(self.repo, status, time.time())

    # ---------- general ----------

    def _recently_answered(self, task: Task) -> bool:
        """The owner just answered through the hook, and state.json has not caught up with the session yet."""
        answered = self.repo.last_input_answer_at(task.id)
        if not answered:
            return False
        try:
            at = datetime.fromisoformat(answered)
        except ValueError:
            return False
        now = self.now()
        if at.tzinfo is None and now.tzinfo is not None:
            at = at.replace(tzinfo=now.tzinfo)
        elif at.tzinfo is not None and now.tzinfo is None:
            now = now.replace(tzinfo=at.tzinfo)
        return (now - at).total_seconds() < INPUT_ANSWER_GRACE_SEC

    def _fail(self, task: Task, detail: str) -> None:
        """The only way into failed: status, badge and event are always consistent."""
        self.sessions.close_input_requests(task)
        self.repo.update_task(task.id, status=TaskStatus.FAILED, blocker=None, blocker_detail=detail)
        # Usually the failed task's session is already dead, in which case release does nothing.
        # "Resume session" will wake it through wake.
        self.sessions.release(task, "task failed")
        self._event(task, f"#{task.id} failed: {detail[:200]}", "error")

    def _int_setting(self, key: str, default: int, minimum: int) -> int:
        """A whole-number setting with a fallback: validation lives in the API, but the database outlives a code version
        (the value could have landed there before validation existed), so silently killing a tick step is not allowed."""
        raw = self.repo.get_setting(key, str(default))
        try:
            value = int(raw)
        except (TypeError, ValueError):
            log.warning("setting %s is invalid (%r), using %s", key, raw, default)
            return default
        return max(minimum, value)

    def _quota_patterns(self) -> list[str]:
        raw = self.repo.get_setting("quota_patterns")
        if not raw:
            return DEFAULT_QUOTA_PATTERNS
        try:
            patterns = json.loads(raw)
            if isinstance(patterns, list) and all(isinstance(p, str) for p in patterns):
                return patterns
        except json.JSONDecodeError:
            pass
        log.warning("quota_patterns are invalid (%r), using the defaults", raw)
        return DEFAULT_QUOTA_PATTERNS

    def _event(self, task: Task, message: str, level: str = "info") -> None:
        self.repo.add_event(message, level=level, task_id=task.id, project_id=task.project_id)

    def _now_iso(self) -> str:
        return self.now().replace(microsecond=0).isoformat()
