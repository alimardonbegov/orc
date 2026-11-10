"""Rules for cards created by an agent, without HTTP: order of a batch, base branch, who is calling.

The base branch is the heart of it. A card waits for its blockers to be `done`, which means merged into
THEIR target, and its worktree is cut from ITS target at start. So a card sees a blocker's work only if
both have the same target: a chain with mixed bases runs in the right order and still builds on nothing.

See docs/agent-tasks.md.
"""
from __future__ import annotations

from pathlib import Path
from typing import Hashable, Iterable, Mapping, TypeVar

from orc import git_ops
from orc.models import Project, Task, TaskStatus

# Fuses against an agent that keeps spawning agents. They catch accidents, not attackers: any local
# process can reach the API anyway (orc/security.py).
MAX_BATCH_TASKS = 30
MAX_TASKS_PER_CALLER = 60
# Beyond this many generations (a card created by a card created by...) a new card may only land in
# the backlog: nothing is lost, and a person decides whether the line goes on.
MAX_AUTOSTART_GENERATION = 3

K = TypeVar("K", bound=Hashable)


class CycleError(ValueError):
    """The links of a batch close into a ring."""


def topological_order(edges: Mapping[K, Iterable[K]]) -> list[K]:
    """The keys of `edges` with every key after the keys it depends on, otherwise in the given order.

    A new card cannot be anyone's blocker yet, so a ring can only live inside a batch, and this check
    is enough: nothing here needs the graph of the existing cards.
    """
    pending = {key: list(dict.fromkeys(deps)) for key, deps in edges.items()}
    placed: list[K] = []
    done: set[K] = set()
    while pending:
        ready = next((key for key, deps in pending.items() if all(d in done for d in deps)), None)
        if ready is None:
            raise CycleError(", ".join(str(key) for key in pending))
        placed.append(ready)
        done.add(ready)
        del pending[ready]
    return placed


def common_blocker_branch(blockers: Iterable[Task | None], project_id: int) -> str | None:
    """The branch a card with these blockers should inherit: None if they do not name exactly one.

    Blockers of other projects do not count: a frontend card waits for a backend card to be finished,
    but the branches of two repositories have nothing to do with each other.
    """
    found = same_project_branches(blockers, project_id)
    return found.pop() if len(found) == 1 else None


def same_project_branches(blockers: Iterable[Task | None], project_id: int) -> set[str]:
    return {b.target_branch for b in blockers if b is not None and b.project_id == project_id and b.target_branch}


def _within(path: Path, root: str) -> bool:
    try:
        return path.is_relative_to(Path(root).resolve())
    except OSError:
        return False


def project_from_path(projects: list[Project], raw: str) -> Project | None:
    """The project a folder belongs to: the deepest project containing it, otherwise the repository
    the folder is a worktree of, wherever that worktree lives."""
    path = Path(raw).expanduser().resolve()
    inside = [p for p in projects if _within(path, p.path)]
    if inside:
        return max(inside, key=lambda p: len(Path(p.path).resolve().parts))
    main = git_ops.main_repo_path(path)
    if main is None:
        return None
    main = main.resolve()
    return next((p for p in projects if Path(p.path).resolve() == main), None)


def find_caller(tasks: list[Task], cwd: str | None) -> Task | None:
    """The card whose worktree the request came from. A finished card has no session to speak of."""
    if not cwd:
        return None
    path = Path(cwd).expanduser().resolve()
    for task in tasks:
        if task.worktree_path and task.status != TaskStatus.DONE and _within(path, task.worktree_path):
            return task
    return None


def generation(repo, task: Task) -> int:
    """How many cards stand behind this one: 0 for a card a person created. The walk survives a deleted
    ancestor and, being data rather than a guarantee, a ring."""
    depth = 0
    seen = {task.id}
    current: Task | None = task
    while current is not None and current.created_by_task_id is not None:
        if current.created_by_task_id in seen:
            break
        seen.add(current.created_by_task_id)
        depth += 1
        current = repo.get_task(current.created_by_task_id)
    return depth


def too_deep_to_autostart(repo, task: Task) -> bool:
    """Whether a card is too many generations deep to be sent to work by an agent. The same fuse that keeps
    a deep card out of To do when it is created, here for a card that is promoted later."""
    return generation(repo, task) > MAX_AUTOSTART_GENERATION
