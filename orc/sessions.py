"""The life of the Claude Code session behind a task: start, resume, stop, the session journal.

Extracted from the dispatcher: this code is used by the sync step, message delivery,
and conflict resolution alike, so keeping it inside a single step was wrong. The resume
rules (resuming a live session creates a copy of it) live here and only here.
"""
from __future__ import annotations

import logging
import secrets
import time
from pathlib import Path
from typing import Callable

from orc import agents, inbox, inputs, task_guide, trust, usage
from orc.claude_cli import ClaudeCliError, JobState
from orc.config import Settings
from orc.models import Agent, Project, Task, TaskStatus
from orc.repo import Repo

log = logging.getLogger("orc.sessions")

# Waiting for confirmation that the session stopped before a resume (an immediate resume after
# stop is treated by the daemon as launching a COPY: two live sessions in one worktree). The wait ceiling is
# 0.2+0.4+0.8+1.6+3.2 ≈ 6 seconds: a tick must not stall because of one card.
STOP_WAIT_ATTEMPTS = 5
STOP_WAIT_BASE_SEC = 0.2
STOP_TERMINAL_STATES = ("stopped", "done", "failed")

# Session states in which a resume is safe: the daemon does not consider the session alive, which means
# `claude --bg --resume` will continue THIS session rather than launch a copy of it.
RESUMABLE_STATES = ("stopped", "done", "failed")

RESUME_AFTER_CRASH = "The session was interrupted. Continue the task from where you left off, and hand in the work at the end as your instructions say."

# Appended to the owner's words when a card goes back to its session (rework, or resuming a failed card). The card was
# already handed in once, and a bare chat message reads as a remark about finished work: a cheap model then does the
# change and ends its turn without handing it in again, and the card waits for the owner.
HANDOFF_AGAIN = "(From orc: this card is open again. When the work is finished, hand it in again as your instructions say.)"


def with_handoff_reminder(text: str) -> str:
    return f"{text}\n\n{HANDOFF_AGAIN}"

# Why a run started, as the card's execution log names it (orc/runs.py). A caller passes it; nothing guesses it from
# the prompt text. start: the first session; rework: the owner sent a finished card back; resume: the owner
# resumed a failed one; crash: orc resumed a session that died; quota: orc resumed after the usage limit lifted;
# verify_failed: the check failed, or the session ended without handing in; conflict: the merge met a conflict;
# message: the owner's message went in by restarting the session; subtasks_done: the card's subtasks were all done
# and orc woke the card that split them (orc/child_wake.py); wakeup: a wakeup the session asked for came due
# (orc/wakeups.py), and the run's trigger_detail says which.
TRIGGERS = ("start", "rework", "resume", "crash", "quota", "verify_failed", "conflict", "message", "subtasks_done",
            "wakeup")

# How a run ended. handed_in: the work went to verification; failed: the session died or gave up; stopped: the owner
# stopped it or closed the card; quota: the usage limit cut it; superseded: a newer run of the same task replaced it;
# sleeping: the session asked to be woken later and was shut down until then.
OUTCOMES = ("handed_in", "failed", "stopped", "quota", "superseded", "sleeping")


def check_trigger(trigger: str) -> None:
    """Refused before anything is launched: a run whose cause the log cannot name is a caller's bug."""
    if trigger not in TRIGGERS:
        raise ValueError(f"unknown run trigger {trigger!r}")


class SessionRunner:
    def __init__(self, repo: Repo, cli, settings: Settings, on_event: Callable[..., None],
                 sleep: Callable[[float], None] = time.sleep):
        self.repo = repo
        self.cli = cli
        self.settings = settings
        self.on_event = on_event  # (task, message, level="info"): writes to the event feed
        self.sleep = sleep

    def start(self, task: Task, project: Project, cwd: Path, prompt: str, name: str, *, trigger: str,
              **task_fields) -> None:
        """Start a session and record it in the task and the journal, as a run started by `trigger`.

        task_fields is what else to write into the task with the same update_task: on the first start these are
        worktree_path, branch and target_branch, for a conflict resolution session nothing.
        """
        check_trigger(trigger)
        settings = self.session_settings(task)
        agent = self.task_agent(task)
        params = agents.resolve_params(task, agent, project)
        job_id = self.launch(project.path, cwd, lambda: self.cli.start_bg(
            cwd=cwd, prompt=prompt, name=name,
            model=params.model, effort=params.effort, permission_mode=params.permission_mode,
            settings=settings, append_system_prompt=self.system_prompt(task, agent),
        ))
        st = self.cli.read_state(job_id)
        self.repo.update_task(
            task.id, status=TaskStatus.IN_PROGRESS, job_id=job_id,
            session_id=st.session_id if st else None, blocker=None, blocker_detail=None, **task_fields,
        )
        self.register(task, job_id, st, trigger)

    def resume(self, task: Task, text: str, *, trigger: str, detail: str | None = None) -> None:
        """Continue the task session with text, as a copy that carries the task's full set of options.

        A resume without flags keeps the options only if the daemon has already settled the stopped job;
        a second too early and it starts a copy without hooks, permission mode or prompt, on the default
        model. The stop has just been confirmed by `state.json`, which is written before that, so the flags
        are what makes the result independent of timing. The caller guarantees the session is not alive.
        """
        check_trigger(trigger)
        # A resume is a new turn of the session: the tool that was waiting for a decision has already been interrupted by the stop.
        self.close_input_requests(task)
        settings = self.session_settings(task)
        agent = self.task_agent(task)
        project = self.repo.get_project(task.project_id)
        params = agents.resolve_params(task, agent, project)
        persona = self.system_prompt(task, agent)
        cwd = Path(task.worktree_path)
        job_id = self.launch(project.path if project else None, cwd, lambda: self.cli.resume_bg(
            cwd=cwd, session_id=task.session_id, prompt=text, settings=settings, append_system_prompt=persona,
            name=f"orc#{task.id} {task.title}", model=params.model, effort=params.effort,
            permission_mode=params.permission_mode,
        ))
        # resume may spawn a copy of the session under a new job id:
        # we read the state of the new job and take session_id from it, not from the old task,
        # otherwise a repeated resume before the next tick would go with a stale session_id.
        st = self.cli.read_state(job_id)
        self.repo.update_task(
            task.id, job_id=job_id, status=TaskStatus.IN_PROGRESS,
            session_id=st.session_id if st else task.session_id,
            blocker=None, blocker_detail=None,
        )
        self.register(task, job_id, st, trigger, detail)

    def system_prompt(self, task: Task, agent: Agent | None) -> str:
        """The agent's persona, if any, and how to reach the board. In the system prompt rather than the
        prompt template: the template is the owner's text, and an edited one must not lose this."""
        note = task_guide.session_note(self.settings.data_dir, task.id)
        persona = agents.system_prompt(agent)
        return f"{persona}\n\n{note}" if persona else note

    def task_agent(self, task: Task) -> Agent | None:
        return self.repo.get_agent(task.agent_id) if task.agent_id else None

    def wake(self, task: Task, text: str, *, trigger: str, detail: str | None = None) -> None:
        """Continue the task session. The single entry point for everyone except delivery.

        A resume of a live session would leave the old process hanging next to the copy: hundreds of
        megabytes piled up on every rework. So a live session is shut down first.
        """
        check_trigger(trigger)
        st = self.safe_state(task.job_id) if task.job_id else None
        if st is not None and st.state not in RESUMABLE_STATES:
            self.cli.stop(task.job_id)
            if not self.wait_stopped(task):
                raise ClaudeCliError(f"session {task.job_id} did not stop within ~6 s: it cannot be continued, "
                                     f"otherwise two sessions would end up in one worktree")
        self.resume(task, text, trigger=trigger, detail=detail)

    def release(self, task: Task, reason: str) -> bool:
        """Shut down the session process: the agent is no longer needed for the task (delivered, failed, closed).

        The conversation stays on disk, and `wake` will raise it if the task is put back to work. We swallow
        the error: the session may already be gone, and the reaper (Dispatcher._reap_sessions) will retry.
        """
        if not task.job_id:
            return False
        st = self.safe_state(task.job_id)
        if st is not None and st.state in STOP_TERMINAL_STATES:
            return False
        try:
            self.cli.stop(task.job_id)
        except Exception:
            log.warning("claude stop %s (#%s, %s) failed", task.job_id, task.id, reason, exc_info=True)
            return False
        log.info("session %s of task #%s shut down: %s", task.job_id, task.id, reason)
        return True

    def launch(self, project_path: str | None, cwd: Path, run: Callable[[], str]) -> str:
        """Start/resume a session in the task worktree with Claude Code trust for this folder.

        `claude --bg` does not see trust above the git root, and for a worktree the root is itself
        (orc/trust.py). We trust the worktrees of a trusted project; an untrusted one is a question to
        the owner (WorkspaceUntrusted). The write to ~/.claude.json may be overwritten by a parallel
        Claude Code session that rewrites the whole file: on a CLI refusal we write again and
        repeat the launch once.
        """
        config = self.settings.claude_json_path
        if project_path is not None:
            self._ensure_trust(config, project_path, cwd)
        try:
            return run()
        except Exception as e:
            if project_path is None or not trust.is_untrusted_error(e):
                raise
            log.warning("CLI does not trust %s although trust was recorded: writing again", cwd)
            self._ensure_trust(config, project_path, cwd)
            return run()

    @staticmethod
    def _ensure_trust(config: Path, project_path: str, cwd: Path) -> None:
        if trust.is_trusted_exactly(config, cwd):
            return
        if not trust.is_trusted(config, project_path):
            raise trust.WorkspaceUntrusted(project_path)
        trust.grant(config, cwd)

    def wait_stopped(self, task: Task) -> bool:
        """Poll the job state until terminal after `claude stop`. False means we did not wait it out."""
        delay = STOP_WAIT_BASE_SEC
        for attempt in range(STOP_WAIT_ATTEMPTS):
            try:
                st = self.cli.read_state(task.job_id) if task.job_id else None
            except Exception:
                log.exception("reading state #%s after stop", task.id)
                st = None
            if st is not None and st.state in STOP_TERMINAL_STATES:
                return True
            if attempt < STOP_WAIT_ATTEMPTS - 1:
                self.sleep(delay)
                delay *= 2
        return False

    def register(self, task: Task, job_id: str, st: JobState | None, trigger: str, detail: str | None = None) -> None:
        """Every born job goes into the task_sessions journal. The transcript and session_id may be
        still unknown (state.json not written): _collect_usage will fill them in on the very first tick.

        It is also a run in the execution log. A run of the same task still open is over now: whatever ended
        it had no outcome of its own to record, so it was replaced by this one.

        A wakeup still pending belongs to an earlier run: the session is awake now, and a later fire would resume it a
        second time. It asks again if it still needs one."""
        fresh = self.repo.get_task(task.id) or task
        row = self.repo.add_task_session(task.id, job_id, st.session_id if st else None,
                                         st.transcript_path if st else None, trigger=trigger,
                                         agent_id=fresh.agent_id, trigger_detail=detail)
        self.repo.end_task_runs(task.id, "superseded", except_id=row["id"], at=row["created_at"])
        if self.repo.cancel_wakeups(task.id, f"the session was started again ({trigger})"):
            self.on_event(fresh, f"#{task.id}: pending wakeups cancelled, the session was started again ({trigger})")

    def end_run(self, task: Task, outcome: str) -> None:
        """The task's current run is over. Idempotent: a run keeps the first outcome it was given."""
        if outcome not in OUTCOMES:
            raise ValueError(f"unknown run outcome {outcome!r}")
        self.repo.end_task_runs(task.id, outcome)

    def safe_state(self, job_id: str) -> JobState | None:
        try:
            return self.cli.read_state(job_id)
        except Exception:
            return None

    def issue_hook_secret(self, task: Task) -> tuple[Task, Path]:
        """A new secret for every set of session settings.

        Settings go out at start and at every resume. The old command line together with the old session
        stops opening anything: that is the point of reissuing.
        """
        secret = secrets.token_urlsafe(32)
        path = inputs.write_hook_secret(inputs.hook_secret_path(self.settings.data_dir, task.id), secret)
        if task.worktree_path:
            # A copy issued before the secret moved out of the working copy: it is stale now, and a
            # stale secret in reach only produces a puzzling refusal.
            (Path(task.worktree_path) / inputs.LEGACY_HOOK_SECRET_REL_PATH).unlink(missing_ok=True)
        return self.repo.update_task(task.id, hook_secret=secret), path

    def session_settings(self, task: Task) -> str:
        """`--settings` for a new session: inbox hooks, input request hooks, the statusline collector and the
        permission to hand in.

        The statusline here is not decoration: a background session renders it just like a terminal one, and
        brings the account limits for free: while the board works, the numbers in the UI stay fresh on their
        own, without probe requests to Claude (orc/usage.py).

        Input request hooks are bound to the task by number: session permissions and questions arrive
        in the API with it, rather than being guessed by cwd: the session may go off into its own worktree.
        The secret is issued exactly here, not by callers: settings without a fresh secret are
        a command line that would open someone else's (old) secret.

        The permission rules let `orc task done` and `orc task fail` run in `dontAsk` and `auto`: a session
        that may not call them could never hand in. See docs/internals/handoff.md for how they were checked.
        """
        task, secret_path = self.issue_hook_secret(task)
        return inbox.hook_settings_json(
            extra={**usage.statusline_settings(self.settings.usage_cache_path),
                   **agents.memory_settings(self.settings.data_dir, self.task_agent(task)),
                   "permissions": {"allow": task_guide.handoff_permissions(self.settings.data_dir)}},
            hooks=inputs.hook_settings(self.settings.api_base, task.id, secret_path=str(secret_path)),
        )

    def close_input_requests(self, task: Task) -> None:
        """The session is gone (failed, stopped, resuming, closed by hand): there is nobody left to fulfil
        the open input request, and keeping a badge on it would lie about waiting."""
        if self.repo.cancel_input_requests(task.id):
            self.on_event(task, f"#{task.id}: input request cleared: the session is no longer waiting for it")
