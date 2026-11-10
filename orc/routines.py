"""Recurring tasks (routines): creating runs on a schedule.

A routine is a template: the setup and the schedule. Each run is a regular task in todo with a routine_id,
and then it travels the common pipeline (worktree, session, verification, merge), so the log, report,
tokens and status are separate for each run. This module is only "when and how to create a run"; slot
times are computed by orc/recurrence.py.

A routine may also belong to no project. There is no repository to make a worktree in, so every run of such
a routine is a new chat with the routine's agent (orc/chats.py): the description is its first message, and
the chat runs in its own empty folder. It has no board status, verification or merge.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Callable

from orc import recurrence
from orc.models import Chat, Routine, Task, TaskStatus
from orc.repo import Repo

log = logging.getLogger("orc.routines")

# The run is still going: the next slot is skipped while it is. failed is not included: a failed
# run must not silently stop the routine forever; backlog is not either: only the owner moves a card
# there, and it means "this run is not needed".
ACTIVE_RUN_STATUSES = (TaskStatus.TODO, TaskStatus.IN_PROGRESS, TaskStatus.VERIFYING, TaskStatus.MERGING)
# Finished runs that go off the board under archive_runs when a new one appears.
FINISHED_RUN_STATUSES = (TaskStatus.DONE, TaskStatus.FAILED)

# A chat run is still going: the next slot is skipped while it is. A chat that waits for the owner counts.
ACTIVE_CHAT_STATUSES = ("queued", "running", "waiting")

EventSink = Callable[[str, str, int | None, int | None], None]  # (message, level, task_id, project_id)


class RunActive(ValueError):
    """The routine's previous run is still going: we do not create a second one in parallel."""


def _iso(at: datetime) -> str:
    return at.replace(microsecond=0).isoformat()


def next_slot(routine: Routine, after: datetime) -> str:
    return _iso(recurrence.next_run(routine.schedule_kind, routine.interval_minutes, routine.cron,
                                    routine.timezone, after))


def describe(routine: Routine) -> str:
    return recurrence.describe(routine.schedule_kind, routine.interval_minutes, routine.cron, routine.timezone)


def active_run(repo: Repo, routine_id: int) -> Task | Chat | None:
    """The routine's unfinished run (a card on the board, or a chat for a routine outside a project)."""
    for task in repo.routine_runs(routine_id):
        if task.archived_at is None and task.status in ACTIVE_RUN_STATUSES:
            return task
    for chat in repo.routine_chats(routine_id):
        if chat.status in ACTIVE_CHAT_STATUSES:
            return chat
    return None


def _spawn_chat(repo: Repo, routine: Routine, number: int, wake: Callable[[], None] | None) -> Chat:
    """A run outside a project: a chat with the routine's agent whose first message is the description."""
    agent = repo.get_agent(routine.agent_id) if routine.agent_id is not None else None
    if agent is None:
        raise ValueError("a routine outside a project needs an agent: pick one for it")
    if agent.project_id is not None:
        raise ValueError(f"agent '{agent.name}' belongs to a project: a routine outside a project needs a shared one")
    chat = repo.add_chat(routine.agent_id, None, f"{routine.title} · #{number}",
                         routine_id=routine.id, routine_run=number, status="queued")
    repo.add_chat_message(chat.id, "user", routine.description, state="queued")
    if wake is not None:
        wake()
    return chat


def spawn(repo: Repo, routine: Routine, now: datetime, emit: EventSink, manual: bool = False,
          wake: Callable[[], None] | None = None) -> Task | Chat:
    """Create the next run of a routine. RunActive if the previous one is not finished yet.

    wake nudges the chat loop so that a fresh chat run starts now rather than on its next poll."""
    current = active_run(repo, routine.id)
    if current is not None:
        kind = "task" if isinstance(current, Task) else "chat"
        raise RunActive(f"run #{current.routine_run} ({kind} #{current.id}) is not finished yet — "
                        f"wait for it or close it manually")
    number = routine.run_count + 1
    if routine.project_id is None:
        run: Task | Chat = _spawn_chat(repo, routine, number, wake)
        where = f"chat #{run.id}"
    else:
        if routine.archive_runs:
            # Past results leave the board before a new one appears: the routine keeps just
            # one fresh run on the board, and the whole history is in the routine window.
            for old in repo.routine_runs(routine.id):
                if old.archived_at is None and old.status in FINISHED_RUN_STATUSES:
                    repo.update_task(old.id, archived_at=_iso(now))
        run = repo.add_task(
            routine.project_id, f"{routine.title} · #{number}", routine.description,
            priority=routine.priority, target_branch=routine.target_branch, status=TaskStatus.TODO,
            verify_cmd=routine.verify_cmd, routine_id=routine.id, routine_run=number, agent_id=routine.agent_id,
        )
        where = f"task #{run.id}"
    task_id = run.id if isinstance(run, Task) else None
    fields: dict = {"run_count": number, "last_run_at": _iso(now)}
    if routine.max_runs is not None and number >= routine.max_runs:
        fields.update(enabled=0, next_run_at=None)
    repo.update_routine(routine.id, **fields)
    how = "manually" if manual else f"on schedule ({describe(routine)})"
    emit(f"routine '{routine.title}': run #{number} created {how} — {where}", "info",
         task_id, routine.project_id)
    if "enabled" in fields:
        emit(f"routine '{routine.title}': completed {number} of {routine.max_runs} runs, routine stopped",
             "info", task_id, routine.project_id)
    return run


def run_due(repo: Repo, now: datetime, emit: EventSink, wake: Callable[[], None] | None = None,
            paused: bool = False) -> None:
    """Dispatcher step: create runs of all routines whose slot has come.

    Missed slots are not caught up: after a server downtime there is one run, and the next one
    is counted from the current moment. Otherwise an hourly routine after a night of downtime
    would produce a batch of identical cards.
    """
    projects = {p.id: p for p in repo.list_projects()}
    for routine in repo.list_routines():
        if not routine.enabled:
            continue
        try:
            if routine.next_run_at is None:
                # Enabled, but the slot is not computed (hand-edited database): we compute it instead of staying silent forever
                repo.update_routine(routine.id, next_run_at=next_slot(routine, now))
                continue
            if datetime.fromisoformat(routine.next_run_at) > now:
                continue
            following = next_slot(routine, now)
            project = projects.get(routine.project_id) if routine.project_id is not None else None
            # A routine outside any project has no project to be hidden away
            if routine.project_id is not None and (project is None or project.archived_at):
                # The project was hidden away: we do not create runs in it, but we do not break the schedule either
                repo.update_routine(routine.id, next_run_at=following)
                continue
            if paused and routine.project_id is None:
                # The card of a project run just waits in todo while the dispatcher is paused, but a chat run
                # starts a session at once: so while paused the slot is passed over, like a missed one
                repo.update_routine(routine.id, next_run_at=following)
                continue
            try:
                spawn(repo, routine, now, emit, wake=wake)
            except RunActive as e:
                repo.update_routine(routine.id, skipped_count=routine.skipped_count + 1, next_run_at=following)
                current = active_run(repo, routine.id)
                emit(f"routine '{routine.title}': slot skipped — {e}", "warn",
                     current.id if isinstance(current, Task) else None, routine.project_id)
                continue
            fresh = repo.get_routine(routine.id)
            if fresh is not None and fresh.enabled:
                repo.update_routine(routine.id, next_run_at=following)
        except Exception as e:
            # One broken routine (a bad cron from the database) must not shut down the others. And we pause it
            # otherwise the same error would pour into the feed on every tick.
            log.exception("routine #%s", routine.id)
            try:
                repo.update_routine(routine.id, enabled=0, next_run_at=None)
            except Exception:
                log.exception("failed to stop routine #%s", routine.id)
            emit(f"routine '{routine.title}' failed and was paused: {e}", "error", None,
                 routine.project_id)
