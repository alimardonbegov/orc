"""Project branches: a summary for the UI and safe operations on them.

git commands live in git_ops; the rules live here. A branch in the orchestrator is not just a ref:
a task's worktree is created from it (`target_branch`), the result is merged into it, and
a session may be working in it right now (`branch`). So "delete a branch" is
not `git branch -D` but the question "who is looking at it and what will break".

The separation is strict:
  * prohibition (BranchError): the operation would break running work, confirmation does not bypass it;
  * warning (BranchNeedsConfirm): something may be lost, but the person is entitled to decide.
"""
from __future__ import annotations

from pathlib import Path

from orc import git_ops
from orc.models import Project, Task, TaskStatus

# The task is really running: the worktree was already created from the base, and the result will go exactly there.
# Any movement of such a branch is a conflict that would then have to be sorted out by hand.
BUSY_STATUSES = {TaskStatus.IN_PROGRESS, TaskStatus.VERIFYING, TaskStatus.MERGING}
# The task is yet to run: a reference to the branch must not be broken silently.
PLANNED_STATUSES = {TaskStatus.BACKLOG, TaskStatus.TODO, TaskStatus.FAILED}


class BranchError(RuntimeError):
    """Not allowed: the operation would break running work."""


class BranchNeedsConfirm(RuntimeError):
    """Allowed, but something will be lost: an explicit force from the human is needed."""


def _ids(tasks: list[Task]) -> list[int]:
    return [t.id for t in tasks]


def _enum(tasks: list[Task]) -> str:
    return ", ".join(f"#{t.id}" for t in tasks)


def base_branch(project: Project, current: str) -> str:
    """The base for a project's new tasks: the one set in the settings or the repository's current branch."""
    return project.default_branch or current


def _describe(name: str, row: dict[str, str], *, current: str, base: str,
              worktrees: dict[str, Path], tasks: list[Task], path: Path) -> dict:
    """One branch with everything the UI needs to know about it, including prohibitions and warnings."""
    live = [t for t in tasks if t.archived_at is None]
    target_of = [t for t in live if t.target_branch == name]
    branch_of = [t for t in live if t.branch == name]
    busy_target = [t for t in target_of if t.status in BUSY_STATUSES]
    busy_branch = [t for t in branch_of if t.status in BUSY_STATUSES]
    planned_target = [t for t in target_of if t.status in PLANNED_STATUSES]
    worktree = worktrees.get(name)
    is_current = name == current

    # The order of reasons goes from the most insurmountable to the most specific: the person reads the first one.
    delete_block: str | None = None
    if is_current:
        delete_block = f"{name} is the repository's current branch, git will not delete it. Switch to another one."
    elif busy_branch:
        delete_block = f"a task is working in this branch right now: {_enum(busy_branch)}"
    elif busy_target:
        delete_block = f"a task is being merged into it: {_enum(busy_target)}"
    elif worktree is not None:
        delete_block = f"the branch is checked out in the working copy {worktree}"
    elif branch_of:
        delete_block = (f"this is the working branch of task {_enum(branch_of)}: delete it together with the task, "
                        f"otherwise the card will be left pointing at nothing")

    rename_block: str | None = None
    if busy_branch:
        rename_block = f"a task is working in this branch right now: {_enum(busy_branch)}"
    elif busy_target:
        rename_block = f"a task is being merged into it: {_enum(busy_target)}"

    merged = True
    if name != base:
        try:
            merged = git_ops.is_merged(path, name, base)
        except git_ops.GitError:
            merged = True  # there is no base or it is unknown: do not scare the person with an invented loss

    warnings: list[str] = []
    if not merged:
        warnings.append(f"it has commits that are not in {base}: they will be lost")
    if planned_target:
        warnings.append(f"tasks {_enum(planned_target)} use it as their base: they will be moved to {base}")
    if name == base and name != current:
        warnings.append("this is the project's default base branch: the setting will be reset")

    return {
        "name": name,
        "commit": row.get("commit", ""),
        "committed_at": row.get("committed_at", ""),
        "subject": row.get("subject", ""),
        "is_current": is_current,
        "is_base": name == base,
        "worktree": str(worktree) if worktree is not None else None,
        "target_of": _ids(target_of),
        "branch_of": _ids(branch_of),
        "busy": bool(busy_target or busy_branch),
        "merged": merged,
        "delete_block": delete_block,
        "delete_warnings": warnings,
        "rename_block": rename_block,
    }


def overview(store, project: Project) -> dict:
    """Everything about a project's branches in one response: the list, the current one, the base and the binding to tasks."""
    path = Path(project.path)
    current = git_ops.current_branch(path)
    base = base_branch(project, current)
    worktrees = git_ops.worktrees_by_branch(path)
    # archived=None: an archived card is not visible on the board, but its branch exists on disk,
    # and silently deleting it from under the card is exactly what the person does not expect.
    tasks = store.list_tasks(project.id, archived=None)
    rows = git_ops.list_branches_detailed(path)
    items = [_describe(r["name"], r, current=current, base=base, worktrees=worktrees,
                       tasks=tasks, path=path) for r in rows]
    return {
        "current": current,
        "default_branch": project.default_branch,
        "base": base,
        # A flat list of names, for selects that do not need the details
        "branches": [r["name"] for r in rows],
        "items": items,
    }


def _find(view: dict, name: str) -> dict:
    for item in view["items"]:
        if item["name"] == name:
            return item
    raise BranchError(f"branch {name} does not exist in the repository")


def _check_name(path: Path, name: str) -> str:
    name = name.strip()
    if not name:
        raise BranchError("the branch name is empty")
    if not git_ops.is_valid_branch_name(path, name):
        raise BranchError(f"git does not accept the name {name!r}: no spaces, ~ ^ : ? * [ \\, "
                          f"two dots in a row, or a dot or .lock at the end of a segment")
    return name


def create(store, project: Project, name: str, base: str | None) -> tuple[dict, str]:
    """Create a branch from base (by default from the project's base branch)."""
    path = Path(project.path)
    view = overview(store, project)
    name = _check_name(path, name)
    if name in view["branches"]:
        raise BranchError(f"branch {name} already exists")
    source = base or view["base"]
    if source not in view["branches"]:
        raise BranchError(f"branch {source} to create from does not exist in the repository")
    git_ops.create_branch(path, name, source)
    return overview(store, project), f"branch {name} created from {source}"


def rename(store, project: Project, name: str, new_name: str) -> tuple[dict, str]:
    """Rename a branch and rewrite all references to it in the task cards."""
    path = Path(project.path)
    view = overview(store, project)
    item = _find(view, name)
    new_name = _check_name(path, new_name)
    if new_name == name:
        raise BranchError("the new name matches the old one")
    if new_name in view["branches"]:
        raise BranchError(f"branch {new_name} already exists")
    if item["rename_block"]:
        raise BranchError(f"{name} cannot be renamed: {item['rename_block']}")
    git_ops.rename_branch(path, name, new_name)
    # References in the database are rewritten AFTER git: if the rename did not go through, the cards
    # keep pointing at a branch that really exists.
    moved = _repoint(store, project, name, new_name)
    if project.default_branch == name:
        store.update_project(project.id, default_branch=new_name)
        moved.append("the project's base branch")
    tail = f"; updated: {', '.join(moved)}" if moved else ""
    return overview(store, store.get_project(project.id)), f"{name} → {new_name}{tail}"


def _repoint(store, project: Project, name: str, new_name: str | None) -> list[str]:
    """Move cards from the old branch name to the new one. None means the branch no longer exists."""
    moved: list[str] = []
    for task in store.list_tasks(project.id, archived=None):
        fields = {}
        if task.target_branch == name and new_name is not None:
            fields["target_branch"] = new_name
        if task.branch == name:
            fields["branch"] = new_name
        if fields:
            store.update_task(task.id, **fields)
            moved.append(f"#{task.id}")
    return moved


def delete(store, project: Project, name: str, force: bool = False) -> tuple[dict, str]:
    """Delete a branch. Prohibitions are not bypassed; warnings are lifted by force=True."""
    path = Path(project.path)
    view = overview(store, project)
    item = _find(view, name)
    if item["delete_block"]:
        raise BranchError(f"{name} cannot be deleted: {item['delete_block']}")
    if item["delete_warnings"] and not force:
        raise BranchNeedsConfirm("; ".join(item["delete_warnings"]))
    base = view["base"]
    git_ops.delete_branch(path, name, force=True)
    notes = [f"branch {name} deleted"]
    if project.default_branch == name:
        store.update_project(project.id, default_branch=None)
        notes.append("the project's base branch was reset to the repository's current branch")
    # Cards that were waiting for this branch as a base are moved to the project's base: otherwise they
    # would reach the dispatcher and fail on `git worktree add` with an obscure git error.
    fallback = base if base != name else git_ops.current_branch(path)
    repointed = [t.id for t in store.list_tasks(project.id, archived=None)
                 if t.target_branch == name]
    for task_id in repointed:
        store.update_task(task_id, target_branch=fallback)
    if repointed:
        notes.append(f"tasks {', '.join(f'#{i}' for i in repointed)} moved to {fallback}")
    return overview(store, store.get_project(project.id)), "; ".join(notes)
