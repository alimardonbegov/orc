"""A pure function that selects tasks to launch. No DB and no subprocess, so it can be tested with tables."""
from __future__ import annotations

from orc.models import PRIORITY_ORDER, Task, TaskStatus


def ready_tasks(
    todo: list[Task],
    status_by_id: dict[int, str],
    deps: dict[int, list[int]],
    running_by_project: dict[int, int],
    limit_by_project: dict[int, int],
    global_limit: int,
) -> list[Task]:
    # A task is ready when all its dependencies are in done (AND semantics).
    # A blocker missing from status_by_id means its card is no longer on the board: it was
    # archived or deleted outright. Such a blocker does not hold: waiting for done from a task that
    # does not exist would freeze the dependent card forever without a single message.
    candidates = [
        t for t in todo
        if all(status_by_id.get(d, TaskStatus.DONE) == TaskStatus.DONE for d in deps.get(t.id, []))
    ]
    candidates.sort(key=lambda t: (PRIORITY_ORDER.get(t.priority, 1), t.created_at, t.id))

    used = dict(running_by_project)
    total = sum(used.values())
    chosen: list[Task] = []
    for t in candidates:
        if total >= global_limit:
            break
        limit = limit_by_project.get(t.project_id, 1)
        if used.get(t.project_id, 0) >= limit:
            continue
        used[t.project_id] = used.get(t.project_id, 0) + 1
        total += 1
        chosen.append(t)
    return chosen
