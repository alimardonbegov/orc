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

from orc import inbox, inputs, trust, usage
from orc.claude_cli import ClaudeCliError, JobState
from orc.config import Settings
from orc.models import Project, Task, TaskStatus
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

RESUME_AFTER_CRASH = "The session was interrupted. Continue the task from where you left off, and write report.json at the end."


class SessionRunner:
    def __init__(self, repo: Repo, cli, settings: Settings, on_event: Callable[..., None],
                 sleep: Callable[[float], None] = time.sleep):
        self.repo = repo
        self.cli = cli
        self.settings = settings
        self.on_event = on_event  # (task, message, level="info"): writes to the event feed
        self.sleep = sleep

    def start(self, task: Task, project: Project, cwd: Path, prompt: str, name: str, **task_fields) -> None:
        """Start a session and record it in the task and the journal.

        task_fields is what else to write into the task with the same update_task: on the first start these are
        worktree_path, branch and target_branch, for a conflict resolution session nothing.
        """
        settings = self.session_settings(task)
        job_id = self._launch(project.path, cwd, lambda: self.cli.start_bg(
            cwd=cwd, prompt=prompt, name=name,
            model=task.model or project.default_model,
            effort=task.effort or project.default_effort,
            permission_mode=task.permission_mode or project.default_permission_mode,
            settings=settings,
        ))
        st = self.cli.read_state(job_id)
        self.repo.update_task(
            task.id, status=TaskStatus.IN_PROGRESS, job_id=job_id,
            session_id=st.session_id if st else None, blocker=None, blocker_detail=None, **task_fields,
        )
        self.register(task, job_id, st)

    def resume(self, task: Task, text: str, stopped: bool = False) -> None:
        """Continue the task session with text.

        stopped=True means we stopped the session ourselves (`claude stop`), and the daemon will wake it with
        the saved options, hooks included. Otherwise (done/failed) a resume creates a copy without
        options, and the input request hooks have to be passed again via --settings.
        """
        # A resume is a new turn of the session: the tool that was waiting for a decision has already been interrupted by the stop.
        self.close_input_requests(task)
        settings = None if stopped else self.session_settings(task)
        cwd = Path(task.worktree_path)
        project = self.repo.get_project(task.project_id)
        job_id = self._launch(project.path if project else None, cwd, lambda: self.cli.resume_bg(
            cwd=cwd, session_id=task.session_id, prompt=text, settings=settings,
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
        self.register(task, job_id, st)

    def wake(self, task: Task, text: str) -> None:
        """Continue the task session without creating a copy. The single entry point for everyone except delivery.

        The daemon makes a resume of a live session a copy under a new job, and the old process
        stays hanging alongside: hundreds of megabytes piled up on every rework.
        So a live session is first shut down and then woken up already stopped: the daemon raises the same
        job with the saved options, hooks included.
        """
        st = self.safe_state(task.job_id) if task.job_id else None
        if st is None or st.state in ("done", "failed"):
            # the job was deleted or finished by itself: there is no live process, a resume will create a new job with hooks
            self.resume(task, text)
            return
        if st.state != "stopped":
            self.cli.stop(task.job_id)
            if not self.wait_stopped(task):
                raise ClaudeCliError(f"session {task.job_id} did not stop within ~6 s: it cannot be continued, "
                                     f"otherwise two sessions would end up in one worktree")
            st = self.safe_state(task.job_id)
            # wait_stopped has already seen a terminal state. If the repeated read returned None
            # (the file is being written by the daemon), this is not done: we consider the session stopped by us,
            # otherwise a resume with --settings would create a copy. Only done/failed produce a copy.
            stopped = st is None or st.state == "stopped"
        else:
            stopped = True
        self.resume(task, text, stopped=stopped)

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

    def _launch(self, project_path: str | None, cwd: Path, run: Callable[[], str]) -> str:
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

    def register(self, task: Task, job_id: str, st: JobState | None) -> None:
        """Every born job goes into the task_sessions journal. The transcript and session_id may be
        still unknown (state.json not written): _collect_usage will fill them in on the very first tick."""
        self.repo.add_task_session(task.id, job_id, st.session_id if st else None,
                                   st.transcript_path if st else None)

    def safe_state(self, job_id: str) -> JobState | None:
        try:
            return self.cli.read_state(job_id)
        except Exception:
            return None

    def issue_hook_secret(self, task: Task) -> tuple[Task, Path]:
        """A new secret for every set of session settings.

        Settings go out at start and at the resume of a copy (done/failed); waking a stopped
        session goes without them and lives with the old secret. The old command line together with the
        old session stops opening anything: that is the point of reissuing.
        """
        if not task.worktree_path:
            raise ValueError(f"task #{task.id} has no working copy: nowhere for the hooks to put the secret")
        secret = secrets.token_urlsafe(32)
        path = inputs.write_hook_secret(Path(task.worktree_path), secret)
        return self.repo.update_task(task.id, hook_secret=secret), path

    def session_settings(self, task: Task) -> str:
        """`--settings` for a new session: inbox hooks, input request hooks and the statusline collector.

        The statusline here is not decoration: a background session renders it just like a terminal one, and
        brings the account limits for free: while the board works, the numbers in the UI stay fresh on their
        own, without probe requests to Claude (orc/usage.py).

        Input request hooks are bound to the task by number: session permissions and questions arrive
        in the API with it, rather than being guessed by cwd: the session may go off into its own worktree.
        The secret is issued exactly here, not by callers: settings without a fresh secret are
        a command line that would open someone else's (old) secret.
        """
        task, secret_path = self.issue_hook_secret(task)
        return inbox.hook_settings_json(
            extra=usage.statusline_settings(self.settings.usage_cache_path),
            hooks=inputs.hook_settings(self.settings.api_base, task.id, secret_path=str(secret_path)),
        )

    def close_input_requests(self, task: Task) -> None:
        """The session is gone (failed, stopped, resuming, closed by hand): there is nobody left to fulfil
        the open input request, and keeping a badge on it would lie about waiting."""
        if self.repo.cancel_input_requests(task.id):
            self.on_event(task, f"#{task.id}: input request cleared: the session is no longer waiting for it")
