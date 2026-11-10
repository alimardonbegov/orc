"""Waking a parent card when its subtasks are done.

An agent that split its work into subtasks (orc/task_plans.py, `parent_task_id`) hands in and is finished: it never
learns how the pieces ended. When the parent opts in, this module notices that every subtask is done and sends the
parent back to work through the same door as "Rework": status todo with `resume_with`, so the wake waits for a free
worker slot, is verified and merged like any other turn, and the session continues in its own worktree.

Rules, each one a fuse against a loop or a surprise:

* Off by default. A card's own `wake_on_children` (1 or 0) wins; NULL follows the project's card setting
  `wake_parent`, then orc's; none says yes.
* Only a done parent is woken. A parent that is still queued, working, verifying or merging is left alone and woken
  after it lands, because the set of finished subtasks has not changed in the meantime.
* Every non-archived subtask must be done. A failed subtask holds the wake: failed is not final here (retry, resume and
  "close manually" all change it), and waking on a failure and again on the repair would break "exactly once". The
  parent card gets one event naming the failed subtasks; once the owner retries or closes them, the wake proceeds.
* Exactly once per finished set: the parent stores a fingerprint of the subtasks it was woken for. The same set never
  wakes it twice, and a baseline is taken when the setting is turned on, so a tree that finished earlier stays quiet.
* A ceiling on wakes per card (MAX_WAKES) and the generation fuse of agent-made cards (task_plans.MAX_AUTOSTART_GENERATION):
  beyond them nothing is woken, and the card says why.
* A wake needs the parent's session and working copy. If the cleanup of merged copies has taken them, the wake is
  refused with a comment on the card instead of starting a fresh, memoryless session.

See docs/agent-tasks.md.
"""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

from orc import card_settings, task_plans
from orc.models import Project, Task, TaskStatus
from orc.prompt import quote_untrusted_list

# How many times one card may be woken by its subtasks. A woken parent that makes new subtasks and is woken again is the
# loop this stops; the owner can still send the card back by hand at any time.
MAX_WAKES = 3
MAX_INSTRUCTION = 4000
# The comment author and kind of a wake in the card's conversation
AUTHOR = "orc"
KIND = "subtasks_done"
TRIGGER = "subtasks_done"

DEFAULT_INSTRUCTION = (
    "All subtasks of this card are finished and merged into the target branch. Merge the target branch into your "
    "branch first, so that your working copy has their work. Then check the result against the plan: read what each "
    "subtask reports below, run what proves the whole thing works, and start the next step if one is left (create "
    "its cards the way you did before). If nothing is left, say what came out. Hand in with `orc task done` as "
    "usual; a hand-in with nothing new to commit is fine."
)


def effective_setting(repo, task: Task, project: Project | None) -> bool:
    """Whether this card is woken when its subtasks are done."""
    if task.wake_on_children is not None:
        return bool(task.wake_on_children)
    own = card_settings.parse(project.card_settings) if project else None
    shared = card_settings.parse(repo.get_setting("card_settings")) or {}
    for source in (own or {}, shared):
        if card_settings.WAKE_PARENT in source:
            return bool(source[card_settings.WAKE_PARENT])
    return False


def instruction(repo, project: Project | None) -> str:
    own = card_settings.parse(project.card_settings) if project else None
    shared = card_settings.parse(repo.get_setting("card_settings")) or {}
    for source in (own or {}, shared):
        text = (source.get(card_settings.WAKE_PARENT_INSTRUCTION) or "").strip()
        if text:
            return text
    return DEFAULT_INSTRUCTION


def fingerprint(children: list[Task]) -> str:
    """The identity of a finished set: which subtasks, and when each was merged. Reopening and finishing one again
    changes it, so a repaired tree is reported once more; a set that did not change never is."""
    return ",".join(f"{c.id}:{c.done_at or ''}" for c in sorted(children, key=lambda c: c.id))


def held_key(failed: list[Task]) -> str:
    return "failed:" + ",".join(str(c.id) for c in sorted(failed, key=lambda c: c.id))


def baseline_key(children: list[Task]) -> str:
    """What the parent's key should hold right after the setting is turned on: the finished set as it stands, so it
    is not reported; an empty key while the subtasks are still going, so their end is."""
    if children and all(c.status == TaskStatus.DONE for c in children):
        return fingerprint(children)
    return ""


def children_by_parent(tasks: list[Task]) -> dict[int, list[Task]]:
    out: dict[int, list[Task]] = defaultdict(list)
    for task in tasks:
        if task.parent_task_id is not None:
            out[task.parent_task_id].append(task)
    return out


def enabled_parents(repo) -> set[int]:
    """The cards that would be woken now: they have subtasks and the setting says yes."""
    tasks = repo.list_tasks()
    projects = {p.id: p for p in repo.list_projects(archived=None)}
    by_id = {t.id: t for t in tasks}
    return {pid for pid in children_by_parent(tasks)
            if pid in by_id and effective_setting(repo, by_id[pid], projects.get(by_id[pid].project_id))}


def take_baseline(repo, before: set[int]) -> None:
    """After a setting changed: cards that are now woken and were not before treat their present subtasks as known,
    so turning the setting on does not report a tree that finished earlier. `before` is enabled_parents() taken
    ahead of the change."""
    tasks = repo.list_tasks()
    kids = children_by_parent(tasks)
    for pid in enabled_parents(repo) - before:
        repo.update_task(pid, children_wake_key=baseline_key(kids.get(pid, [])))


def _summary(task: Task) -> str:
    try:
        report = json.loads(task.report_json) if task.report_json else None
    except ValueError:
        report = None
    return str(report.get("summary") or "").strip() if isinstance(report, dict) else ""


def conversation_line(children: list[Task]) -> str:
    """What the card shows in its conversation: a plain line, with no untrusted text in it."""
    ids = ", ".join(f"#{c.id}" for c in sorted(children, key=lambda c: c.id))
    return f"All {len(children)} subtasks are done ({ids}). The card was sent back to work to check the result."


def prompt_text(repo, parent: Task, project: Project | None, children: list[Task]) -> str:
    """The text the parent's session receives: the instruction and what each subtask handed in (agents wrote
    those summaries, so they go in a marked block)."""
    rows = []
    for child in sorted(children, key=lambda c: c.id):
        summary = _summary(child)
        rows.append(f"#{child.id} {child.title} [{child.status}]" + (f": {summary}" if summary else ""))
    target = parent.target_branch or "the target branch"
    listing = quote_untrusted_list(rows, empty="no summaries", limit=400, max_items=40)
    return (f"{instruction(repo, project)}\n\nSubtasks of this card (target branch: {target}):\n{listing}\n\n"
            f"This message comes from orc, not from the owner: it woke you because the subtasks above are done.")


def refusal(parent: Task) -> str | None:
    """Why a wake cannot continue the parent's session, or None when it can."""
    if not parent.session_id:
        return "the card has no session to continue"
    if not parent.branch:
        return "the card has no branch"
    if not parent.worktree_path or not Path(parent.worktree_path).is_dir():
        return "its working copy has been removed (the cleanup of merged working copies takes them after a while)"
    return None


def plan(repo, tasks: list[Task], projects: dict[int, Project], note) -> list[tuple[Task, list[Task], str | None]]:
    """The parents to wake on this pass, as (parent, subtasks, fingerprint). Bookkeeping that needs no wake (a held
    parent, a refused one) is written here; the caller does the sending.

    `note(parent, message, level, key)` writes to the feed and stores the key on the parent."""
    by_id = {t.id: t for t in tasks}
    due: list[tuple[Task, list[Task], str | None]] = []
    for parent_id, kids in children_by_parent(tasks).items():
        parent = by_id.get(parent_id)
        if parent is None:
            continue
        project = projects.get(parent.project_id)
        if project is None or getattr(project, "archived_at", None):
            continue
        if not effective_setting(repo, parent, project):
            continue
        failed = [c for c in kids if c.status == TaskStatus.FAILED]
        if any(c.status != TaskStatus.DONE for c in kids):
            # Still going, except that settled-with-failure is worth one word to whoever is waiting.
            if failed and all(c.status in (TaskStatus.DONE, TaskStatus.FAILED) for c in kids):
                key = held_key(failed)
                if parent.children_wake_key != key:
                    ids = ", ".join(f"#{c.id}" for c in failed)
                    note(parent, f"#{parent.id}: not woken, subtask {ids} failed; retry or close it and the "
                                   f"parent is woken once they are all done", "warn", key)
            continue
        if parent.status != TaskStatus.DONE:
            continue  # woken after it lands: the set stays the same
        key = fingerprint(kids)
        if parent.children_wake_key == key:
            continue
        due.append((parent, kids, key))
    return due


def too_deep(repo, parent: Task) -> bool:
    return task_plans.too_deep_to_autostart(repo, parent)
