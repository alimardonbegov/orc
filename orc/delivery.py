"""The queue of owner messages into a task's session.

The only place where the owner's text reaches a running session. Invariant: a resume
is done only when the state has been READ and the daemon does not consider the session alive; it was exactly
the violation of this that produced a second session in one worktree. The text itself travels either through the inbox
(orc/inbox.py, a hook on the nearest tool call) or by a resume after a stop.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Callable

from orc import inbox
from orc.models import Task, TaskStatus
from orc.repo import Repo
from orc.sessions import RESUMABLE_STATES, SessionRunner

log = logging.getLogger("orc.delivery")

# How many ticks we wait for the session to pick the message up from the inbox itself before declaring
# the delivery stuck. 10 ticks is 5 minutes at the default poll_interval_sec=30: that is how long the
# longest model reply lives without a single tool call.
DELIVERY_STALL_TICKS = 10


class MessageDelivery:
    def __init__(self, repo: Repo, cli, sessions: SessionRunner, on_event: Callable[..., None]):
        self.repo = repo
        self.cli = cli
        self.sessions = sessions
        self.on_event = on_event

    def pending_tasks(self) -> list[int]:
        return self.repo.tasks_with_pending_messages()

    def deliver(self, task_id: int) -> None:
        """An attempt to deliver a task's message queue. Called both from the tick and directly from the API.

        The only place in the whole dispatcher where an owner message goes into a session.
        Invariant: `resume` is called only when the state has been READ and the daemon does not
        consider the session alive in it (stopped/done/failed). We never resume a live session:
        that is exactly what produced a second session in one worktree.
        """
        task = self.repo.get_task(task_id)
        if task is None:
            return
        pending = self._confirm_delivered(task)
        if not pending:
            return
        if task.status != TaskStatus.IN_PROGRESS or not task.job_id:
            # The session is gone: it finished or crashed before the message was picked up.
            self.fail_messages(task, pending, "the task session has ended")
            return
        st = self.cli.read_state(task.job_id)
        if st is None:
            self._bump_attempts(task, pending)  # the state is not written yet, so just wait
            return
        if st.state in RESUMABLE_STATES:
            self._deliver_by_resume(task, pending, stopped=st.state == "stopped")
        elif st.state == "working" and not st.waiting and not any(m["mode"] == "interrupt" for m in pending):
            self._deliver_through_inbox(task, pending)
        else:
            # working with an interrupt request, or a session waiting for a human (end of turn: blocked
            # or working with tempo=idle, or working with tempo=blocked): there are no tool calls
            # (or they are interrupted on purpose), the hook cannot reach it, so delivery only by stopping.
            self._stop_for_delivery(task, pending)

    def _confirm_delivered(self, task: Task) -> list[dict]:
        """Mark the messages that the hook has already handed to the session, and return the remaining ones."""
        pending = self.repo.pending_messages(task.id)
        worktree = Path(task.worktree_path) if task.worktree_path else None
        if pending and worktree is not None and worktree.exists():
            done = inbox.delivered_ids(worktree)
            for message in [m for m in pending if m["state"] == "sent" and m["id"] in done]:
                self.repo.mark_delivered(message["id"])
                self.on_event(task, f"#{task.id}: message delivered to the session")
            pending = self.repo.pending_messages(task.id)
        if not pending:
            self.set_outbox_state(task, None)
        return pending

    def _deliver_through_inbox(self, task: Task, pending: list[dict]) -> None:
        """Soft delivery: a file in the worktree that the hook picks up on the nearest tool call."""
        worktree = Path(task.worktree_path) if task.worktree_path else None
        if worktree is None or not worktree.exists():
            self.fail_messages(task, pending, "the task working copy is unavailable")
            return
        stalled = False
        for message in pending:
            inbox.put(worktree, message["id"], message["body"])
            attempts = message["attempts"] + 1
            self.repo.update_message(message["id"], state="sent", attempts=attempts)
            stalled = stalled or attempts >= DELIVERY_STALL_TICKS
        if stalled:
            if task.outbox_state != "stalled":
                self.on_event(task, f"#{task.id}: the session did not pick up the message within "
                                    f"{DELIVERY_STALL_TICKS} ticks; you can interrupt the session", "warn")
            self.set_outbox_state(task, "stalled")
        else:
            self.set_outbox_state(task, "sent")

    def _stop_for_delivery(self, task: Task, pending: list[dict]) -> None:
        """Stop the session so that the message can be handed to it by a resume.

        The resume is NOT done here: it goes out only when the state confirms the stop,
        in the same tick if the daemon was in time, otherwise on the next one.
        """
        if task.outbox_state != "stopping":
            self.cli.stop(task.job_id)
            for message in pending:
                self.repo.update_message(message["id"], state="stopping", attempts=message["attempts"] + 1)
            self.set_outbox_state(task, "stopping")
        if self.sessions.wait_stopped(task):
            self._deliver_by_resume(task, self.repo.pending_messages(task.id), stopped=True)
            return
        self._bump_attempts(task, self.repo.pending_messages(task.id), touch=False)

    def _deliver_by_resume(self, task: Task, pending: list[dict], stopped: bool = False) -> None:
        if not pending:
            return
        worktree = Path(task.worktree_path) if task.worktree_path else None
        if worktree is not None and worktree.exists():
            # The text goes straight into the resume prompt, so there must be no copy in the inbox:
            # otherwise the hook would hand over the same message again.
            inbox.clear(worktree)
        text = "\n\n".join(m["body"] for m in pending)
        self.sessions.resume(task, text, stopped=stopped)
        for message in pending:
            self.repo.mark_delivered(message["id"])
        self.set_outbox_state(self.repo.get_task(task.id) or task, None)
        self.on_event(task, f"#{task.id}: message sent to the session")

    def fail_messages(self, task: Task, pending: list[dict], reason: str) -> None:
        for message in pending:
            self.repo.update_message(message["id"], state="failed")
        self.set_outbox_state(task, None)
        self.on_event(task, f"#{task.id}: message not delivered ({reason})", "warn")

    def _bump_attempts(self, task: Task, pending: list[dict], touch: bool = True) -> None:
        if touch:
            for message in pending:
                self.repo.update_message(message["id"], attempts=message["attempts"] + 1)
        if pending and max(m["attempts"] for m in pending) >= DELIVERY_STALL_TICKS:
            if task.outbox_state != "stalled":
                self.on_event(task, f"#{task.id}: the session did not pick up the message within "
                                    f"{DELIVERY_STALL_TICKS} ticks; you can interrupt the session", "warn")
            self.set_outbox_state(task, "stalled")

    def set_outbox_state(self, task: Task, value: str | None) -> None:
        if task.outbox_state != value:
            self.repo.update_task(task.id, outbox_state=value)
